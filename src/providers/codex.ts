/**
 * Codex CLI Adapter
 *
 * Wraps the OpenAI Codex CLI to produce normalized stream events.
 *
 * CLI invocation:
 *   New session:    codex exec --json --skip-git-repo-check --ephemeral -m <model> "<user message>"
 *   Resume session: codex exec resume <SESSION_ID> --json "<user message>"
 *
 * Output format (NDJSON):
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"..."}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":...,"output_tokens":...}}
 *   {"type":"error","message":"..."}
 *   {"type":"turn.failed","error":{"message":"..."}}
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo } from '../protocol/types.js';
import { ProviderAdapter, createFinalizer, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { buildSpawnEnv, buildCombinedPrompt, appendStderr, formatStderrMessage } from './env.js';
import { createLogger, isDebugEnabled } from '../utils/logger.js';

const log = createLogger('CodexAdapter');

/**
 * Default model to use when no model is specified in the request options.
 *
 * gpt-5.2-codex (the Codex CLI default) is NOT available on ChatGPT Team
 * plans. gpt-5.3-codex is the best coding-optimized model that works
 * with both API key and ChatGPT auth modes.
 */
const DEFAULT_MODEL = 'gpt-5.3-codex';

/**
 * Build a system-prompt note that tells Codex about the server-defined bridge
 * tools available for this request.
 *
 * The bridge exposes each server-registered tool as a bash wrapper script on
 * PATH whose filename is the tool name. Codex has no protocol-level concept of
 * these external tools, so we describe them in the prompt: it can invoke any of
 * them as ordinary shell commands. The wrapper script handles routing the call
 * back through the bridge to the server.
 *
 * @param tools  The server-defined tool definitions for this request.
 * @returns A prompt fragment to append to the combined/user prompt, or an
 *          empty string when there are no tools.
 */
function buildToolPromptNote(tools: import('../protocol/types.js').ToolDefinition[]): string {
  if (tools.length === 0) return '';
  const lines = tools.map((t) => `- \`${t.name}\`: ${t.description}`);
  return (
    '\n\n---\n' +
    'The following bridge tools are available to you as shell commands. ' +
    'Run a tool by executing its command name in the shell (passing any ' +
    'arguments it documents); the command performs the action and prints the ' +
    'result. Use them when they help answer the request:\n' +
    lines.join('\n')
  );
}

export class CodexAdapter extends ProviderAdapter {
  readonly providerName = 'codex';

  async execute(context: ExecutionContext, onEvent: (event: AdapterStreamEvent) => void): Promise<string | null> {
    const { request, signal, cliSessionId } = context;
    const requestId = request.request_id;
    const userMessage = request.message;

    log.info('Executing Codex request', { requestId });

    // Build CLI arguments
    let args: string[];

    // Use the model from request options, or fall back to the default
    const model = request.options?.model ?? DEFAULT_MODEL;

    if (cliSessionId) {
      // Resume an existing session
      args = [
        'exec', 'resume', cliSessionId,
        '--json',
      ];
      // Pass model flag on resume if specified in request options
      if (request.options?.model) {
        args.push('-m', request.options.model);
      }
      log.debug('Resuming session', { cliSessionId });
    } else {
      // New session
      args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--ephemeral',
        '-m', model,
      ];
    }

    // Server-defined bridge tools support.  Codex's `exec` sandbox defaults to
    // read-only with no network access, which would block the wrapper script's
    // loopback callback.  When tools are present we run with workspace-write,
    // network access enabled, and approval_policy=never (so non-interactive
    // exec does not stall on an approval prompt).  Tool-less requests keep
    // Codex's safer default sandbox.
    const hasTools = context.tools.length > 0;
    if (hasTools) {
      args.push(
        '-s', 'workspace-write',
        '-c', 'sandbox_workspace_write.network_access=true',
        '-c', 'approval_policy=never',
      );
    }

    // Build the prompt positional argument. The prompt is appended LAST, after
    // every option flag, so Codex's argument parser never mistakes it for a
    // flag value.
    //
    // When server tools are present we append a note listing the available
    // tool command names so Codex knows it may run them as shell commands.
    // On a fresh session the system prompt is also prepended; on a resumed
    // session the original system prompt was already consumed by the first
    // turn, so the tool note is appended to the user message directly.
    const toolNote = hasTools ? buildToolPromptNote(context.tools) : '';
    if (!cliSessionId && request.system_prompt) {
      args.push('--', buildCombinedPrompt(request.system_prompt, userMessage) + toolNote);
    } else if (toolNote) {
      args.push('--', userMessage + toolNote);
    } else {
      args.push(userMessage);
    }

    // Codex CLI does not support max_tokens directly — log a warning only; do
    // not emit a stream error (the server has no actionable response and it
    // would confuse users who see an error before a successful reply).
    if (request.options?.max_tokens) {
      log.warn('max_tokens option specified but Codex CLI does not support it directly — ignoring', {
        max_tokens: request.options.max_tokens,
      });
    }

    // Only build the truncated arg array when debug logging is active
    if (isDebugEnabled()) {
      log.debug('Spawning codex', { args: args.map((a) => a.length > 50 ? a.substring(0, 50) + '...' : a) });
    }

    return new Promise<string | null>((resolve) => {
      let sessionId: string | null = null;
      let blockIndex = 0;
      let settled = false;

      // Prepend the tool-script directory to PATH so the wrapper commands are
      // invocable by Codex's model-generated shell commands; pass null when
      // there are no tools so PATH is left untouched.
      if (hasTools) {
        log.info('Server-defined tools enabled for Codex request', {
          toolCount: context.tools.length,
        });
      }
      const env = buildSpawnEnv(hasTools ? context.toolScriptDir : null, context.requestId);

      const child = spawn('codex', args, {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Set up abort handling
      const onAbort = () => {
        log.info('Request aborted — killing codex process', { requestId });
        child.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // Track stderr in a variable so the finalizer closure can access it.
      let stderrBuffer = '';

      const finalizer = createFinalizer({
        providerName: 'codex',
        terminalEvent: 'turn.completed',
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

        // ── thread.started ─────────────────────────────────
        if (type === 'thread.started') {
          sessionId = (parsed['thread_id'] as string) ?? null;
          log.debug('Thread started', { sessionId });
          return;
        }

        // ── turn.started ───────────────────────────────────
        if (type === 'turn.started') {
          log.debug('Turn started');
          return;
        }

        // ── item.completed ─────────────────────────────────
        if (type === 'item.completed') {
          const item = parsed['item'] as Record<string, unknown> | undefined;
          if (!item) return;

          const itemType = item['type'] as string;

          if (itemType === 'agent_message') {
            // Text response from the model
            const text = item['text'] as string;
            if (!text) return;

            onEvent({
              event: 'block_start',
              data: { block_index: blockIndex, block_type: 'text' },
            });

            onEvent({
              event: 'block_delta',
              data: { block_index: blockIndex, content: text },
            });

            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });

            blockIndex++;
          } else if (itemType === 'reasoning') {
            // Thinking / reasoning from the model
            const text = (item['text'] as string) ?? '';
            if (!text) return;

            onEvent({
              event: 'block_start',
              data: { block_index: blockIndex, block_type: 'thinking' },
            });

            onEvent({
              event: 'block_delta',
              data: { block_index: blockIndex, content: text },
            });

            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });

            blockIndex++;
          } else if (itemType === 'error') {
            // Error item
            const message = (item['message'] as string) ?? 'Unknown Codex error';
            log.warn('Codex error item', { message: message.substring(0, 200) });

            onEvent({
              event: 'error',
              data: { code: 'provider_error', message },
            });
            // Emit done after error so the server always gets a terminal event.
            onEvent({ event: 'done', data: {} });
            settled = true;
          }
          // function_call and function_call_output items are produced by
          // Codex's own tool execution — we don't need to relay them as
          // stream events since Codex handles tools internally.
          return;
        }

        // ── turn.completed ─────────────────────────────────
        if (type === 'turn.completed') {
          // Guard against duplicate done events — an error item may already
          // have settled the stream before turn.completed arrives.
          if (settled) return;

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

        // ── turn.failed ────────────────────────────────────
        if (type === 'turn.failed') {
          const error = parsed['error'] as Record<string, unknown> | undefined;
          const message = (error?.['message'] as string) ?? 'Codex turn failed';
          log.warn('Codex turn failed', { message: message.substring(0, 200) });

          onEvent({
            event: 'error',
            data: { code: 'provider_error', message },
          });

          onEvent({ event: 'done', data: {} });
          settled = true;
          return;
        }

        // ── error (top-level) ──────────────────────────────
        if (type === 'error') {
          const message = (parsed['message'] as string) ?? 'Unknown Codex error';
          log.warn('Codex error event', { message: message.substring(0, 200) });

          // Emit error + done so the server is always informed, even if
          // Codex exits with code 0 after this and no turn.failed follows.
          onEvent({
            event: 'error',
            data: { code: 'provider_error', message },
          });
          onEvent({ event: 'done', data: {} });
          settled = true;
          return;
        }

        // Ignore other event types (response_item with session_meta, turn_context, etc.)
        log.debug('Unhandled Codex event type', { type });
      });

      rl.on('close', finalizer.onRlClose);

      // Capture stderr for error logging (capped at 10KB)
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer = appendStderr(stderrBuffer, chunk.toString());
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        log.error('Failed to spawn codex', { error: err.message });
        // Provide user-friendly message for ENOENT
        const errorMessage = err.code === 'ENOENT'
          ? 'codex CLI not found. Install it or ensure it is on your PATH.'
          : `Failed to spawn codex: ${err.message}`;
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
        log.debug('Codex process closed', { code, sessionId });
        finalizer.onChildClose(code);
      });
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const cachePath = join(homedir(), '.codex', 'models_cache.json');
      const raw = await readFile(cachePath, 'utf-8');
      const cache = JSON.parse(raw) as {
        models?: Array<{
          slug: string;
          display_name: string;
          description?: string;
          visibility?: string;
        }>;
      };

      if (!cache.models || !Array.isArray(cache.models)) {
        log.warn('Codex models cache is empty or invalid');
        return [];
      }

      return cache.models
        .filter((m) => m.visibility !== 'hide') // Exclude hidden models like codex-auto-review
        .map((m) => ({
          id: m.slug,
          name: m.display_name,
          description: m.description,
          is_default: m.slug === DEFAULT_MODEL,
        }));
    } catch (err) {
      log.warn('Failed to read Codex models cache. Run codex once to populate models cache. Showing default model only.', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fallback: return just the default model
      return [
        { id: DEFAULT_MODEL, name: DEFAULT_MODEL, is_default: true },
      ];
    }
  }
}
