/**
 * Claude CLI Adapter
 *
 * Wraps the Anthropic Claude CLI to produce normalized stream events.
 *
 * CLI invocation:
 *   New session:    claude -p --output-format stream-json --verbose "user message"
 *   Resume session: claude -p --session-id <UUID> --output-format stream-json --verbose "user message"
 *   System prompt:  Passed via --system-prompt flag on first message
 *
 * Output format (NDJSON):
 *   {"type":"system","subtype":"init","session_id":"...","model":"..."}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...}}
 *   {"type":"result","subtype":"success","session_id":"...","usage":{...},"total_cost_usd":...}
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { ModelInfo } from '../protocol/types.js';
import { ProviderAdapter, createFinalizer, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { buildSpawnEnv, appendStderr, formatStderrMessage } from './env.js';
import { createLogger, isDebugEnabled } from '../utils/logger.js';

/**
 * Known Claude CLI model aliases.
 *
 * Claude Code uses stable aliases (sonnet, opus, haiku) that resolve to the
 * latest version within each model family. The CLI has no dynamic model listing
 * command, so these aliases are the official user-facing interface.
 */
const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'sonnet', name: 'Sonnet', description: 'Best balance of speed and intelligence', is_default: true },
  { id: 'opus', name: 'Opus', description: 'Highest intelligence, slower', is_default: false },
  { id: 'haiku', name: 'Haiku', description: 'Fastest and most cost-efficient', is_default: false },
];

const log = createLogger('ClaudeAdapter');

export class ClaudeAdapter extends ProviderAdapter {
  readonly providerName = 'claude';

  async execute(context: ExecutionContext, onEvent: (event: AdapterStreamEvent) => void): Promise<string | null> {
    const { request, signal, cliSessionId } = context;
    const requestId = request.request_id;
    const userMessage = request.message;

    log.info('Executing Claude request', { requestId });

    // Build CLI arguments
    const args: string[] = [
      '-p',                            // Print mode (non-interactive)
      '--output-format', 'stream-json', // NDJSON streaming output
      '--verbose',                       // Required for stream-json in print mode
    ];

    // Resume an existing session if we have a session ID
    if (cliSessionId) {
      args.push('--session-id', cliSessionId);
      log.debug('Resuming session', { cliSessionId });
    }

    // Add system prompt if provided (only on new sessions)
    if (request.system_prompt && !cliSessionId) {
      args.push('--system-prompt', request.system_prompt);
    }

    // Add model if specified in request options
    if (request.options?.model) {
      args.push('--model', request.options.model);
    }

    // Add max tokens if specified
    if (request.options?.max_tokens) {
      args.push('--max-tokens', String(request.options.max_tokens));
    }

    // UX-003: Enable Bash tool access when server-defined tools are available.
    // The wrapper scripts are invoked via bash, so Claude needs --allowedTools bash.
    // IMPORTANT: Use --allowedTools=bash (equals sign syntax) because --allowedTools
    // is a variadic CLI option (<tools...>) that would otherwise consume ALL remaining
    // positional arguments — including the user's prompt message.
    if (context.tools.length > 0 && context.toolScriptDir) {
      args.push('--allowedTools=bash');
    }

    // The user message is the final argument
    args.push(userMessage);

    // EFF-003: Only build the truncated arg array when debug logging is active
    if (isDebugEnabled()) {
      log.debug('Spawning claude', { args: args.map((a) => a.length > 50 ? a.substring(0, 50) + '...' : a) });
    }

    return new Promise<string | null>((resolve, reject) => {
      let sessionId: string | null = null;
      let blockIndex = 0;
      let settled = false;

      // Build env with tool scripts on PATH and request ID for correlation
      const env = buildSpawnEnv(context.toolScriptDir, context.requestId);
      // Claude CLI refuses to run if CLAUDECODE is set, even to empty string
      delete env['CLAUDECODE'];

      const child = spawn('claude', args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'], // stdin must be 'ignore' — Claude CLI hangs if stdin is a pipe
      });

      // Set up abort handling
      const onAbort = () => {
        log.info('Request aborted — killing claude process', { requestId });
        child.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // ARCH-001: Use shared finalizer from base.ts to avoid duplication.
      // Track stderr in a variable so the finalizer closure can access it.
      let stderrBuffer = '';

      const finalizer = createFinalizer({
        providerName: 'claude',
        terminalEvent: 'result',
        getSettled: () => settled,
        setSettled: () => { settled = true; },
        getSessionId: () => sessionId,
        getStderr: () => stderrBuffer,
        onEvent,
        resolve,
        signal,
        onAbort,
      });

      // Parse NDJSON from stdout line by line
      const rl = createInterface({ input: child.stdout });

      rl.on('line', (line) => {
        if (!line.trim()) return;

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line) as Record<string, unknown>;
        } catch {
          log.debug('Skipping non-JSON line', { line: line.substring(0, 100) });
          return;
        }

        const type = parsed['type'] as string;

        if (type === 'system' && (parsed as Record<string, unknown>)['subtype'] === 'init') {
          // Extract session ID from init event
          sessionId = (parsed['session_id'] as string) ?? null;
          log.debug('Session init', { sessionId, model: parsed['model'] });
          return;
        }

        if (type === 'assistant') {
          // BL-008: A late readline-buffered assistant event can arrive after the
          // stream is already settled (result + done emitted). Emitting further
          // block events here would violate the protocol. The full settled guard
          // is intentionally not applied (low-priority edge case per review); log
          // only so the situation can be diagnosed if it ever occurs in practice.
          if (settled) {
            log.debug('Assistant event received after stream settled — block events would be emitted post-done', {
              sessionId,
            });
          }

          // The assistant message contains the content blocks
          const message = parsed['message'] as Record<string, unknown> | undefined;
          if (!message) return;

          const content = message['content'] as Array<Record<string, unknown>> | undefined;
          if (!content || !Array.isArray(content)) return;

          for (const block of content) {
            const blockType = block['type'] as string;

            if (blockType === 'text') {
              const text = block['text'] as string;
              if (!text) continue;

              // Emit block_start + block_delta + block_stop for text
              onEvent({
                event: 'block_start',
                data: {
                  block_index: blockIndex,
                  block_type: 'text',
                },
              });

              onEvent({
                event: 'block_delta',
                data: {
                  block_index: blockIndex,
                  content: text,
                },
              });

              onEvent({
                event: 'block_stop',
                data: {
                  block_index: blockIndex,
                },
              });

              blockIndex++;
            } else if (blockType === 'thinking') {
              const thinking = block['thinking'] as string;
              if (!thinking) continue;

              // Emit thinking block
              onEvent({
                event: 'block_start',
                data: {
                  block_index: blockIndex,
                  block_type: 'thinking',
                },
              });

              onEvent({
                event: 'block_delta',
                data: {
                  block_index: blockIndex,
                  content: thinking,
                },
              });

              onEvent({
                event: 'block_stop',
                data: {
                  block_index: blockIndex,
                },
              });

              blockIndex++;
            } else if (blockType === 'tool_use') {
              // Claude emits tool_use blocks when the model wants to call a tool
              const toolName = block['name'] as string;
              const toolId = block['id'] as string;
              const toolInput = block['input'] as Record<string, unknown> | undefined;

              if (!toolName || !toolId) continue;

              onEvent({
                event: 'block_start',
                data: {
                  block_index: blockIndex,
                  block_type: 'tool_call',
                  tool_name: toolName,
                  tool_call_id: toolId,
                },
              });

              onEvent({
                event: 'block_delta',
                data: {
                  block_index: blockIndex,
                  content: JSON.stringify(toolInput ?? {}),
                },
              });

              onEvent({
                event: 'block_stop',
                data: {
                  block_index: blockIndex,
                },
              });

              blockIndex++;
            }
          }
          return;
        }

        if (type === 'result') {
          // Extract final session ID and usage from result
          sessionId = (parsed['session_id'] as string) ?? sessionId;

          const usage = parsed['usage'] as Record<string, unknown> | undefined;
          const inputTokens = usage ? (usage['input_tokens'] as number) ?? null : null;
          const outputTokens = usage ? (usage['output_tokens'] as number) ?? null : null;

          onEvent({
            event: 'done',
            data: {
              usage: {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
              },
            },
          });
          settled = true;
          return;
        }

        // UX-029: Surface rate_limit_event to the server so it can notify the user.
        if (type === 'rate_limit_event') {
          log.warn('Claude rate limit event', { type });
          onEvent({
            event: 'error',
            data: {
              code: 'rate_limited',
              message: 'Claude is currently rate-limited. The request may retry automatically, or you may need to try again in a moment.',
            },
          });
          return;
        }

        log.debug('Unhandled Claude event type', { type });
      });

      // ARCH-001: Use shared finalizer callbacks
      rl.on('close', finalizer.onRlClose);

      // Capture stderr for error logging (SEC-005: capped at 10KB)
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer = appendStderr(stderrBuffer, chunk.toString());
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        log.error('Failed to spawn claude', { error: err.message });
        // UX-002: Provide user-friendly message for ENOENT
        const errorMessage = err.code === 'ENOENT'
          ? 'claude CLI not found. Install it or ensure it is on your PATH.'
          : `Failed to spawn claude: ${err.message}`;
        signal.removeEventListener('abort', onAbort);

        if (!settled) {
          settled = true;
          onEvent({
            event: 'error',
            data: {
              code: 'provider_spawn_error',
              message: errorMessage,
            },
          });
          onEvent({ event: 'done', data: {} });
          resolve(null);
        }
      });

      child.on('close', (code) => {
        log.debug('Claude process closed', { code, sessionId });
        finalizer.onChildClose(code);
      });
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    // Claude CLI has no dynamic model listing — return known aliases
    return CLAUDE_MODELS;
  }
}
