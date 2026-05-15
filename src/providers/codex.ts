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
import { ProviderAdapter, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { buildSpawnEnv, buildCombinedPrompt, appendStderr } from './env.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CodexAdapter');

/**
 * Default model to use when no model is specified in the request options.
 *
 * gpt-5.2-codex (the Codex CLI default) is NOT available on ChatGPT Team
 * plans. gpt-5.3-codex is the best coding-optimized model that works
 * with both API key and ChatGPT auth modes.
 */
const DEFAULT_MODEL = 'gpt-5.3-codex';

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
      // BL-012: Pass model flag on resume if specified in request options
      if (request.options?.model) {
        args.push('-m', request.options.model);
      }
      args.push(userMessage);
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

      // Add system prompt if provided (passed as first positional arg to exec)
      // codex exec --json "system prompt" reads user message from the prompt arg
      // When system_prompt is set, we prepend it as instructions
      if (request.system_prompt) {
        args.push('--', buildCombinedPrompt(request.system_prompt, userMessage));
      } else {
        args.push(userMessage);
      }
    }

    // ARCH-009: Codex CLI does not support max_tokens directly
    if (request.options?.max_tokens) {
      log.warn('max_tokens option specified but Codex CLI does not support it directly — ignoring', {
        max_tokens: request.options.max_tokens,
      });
    }

    log.debug('Spawning codex', { args: args.map((a) => a.length > 60 ? a.substring(0, 60) + '...' : a) });

    return new Promise<string | null>((resolve) => {
      let threadId: string | null = null;
      let blockIndex = 0;
      let settled = false;

      // Codex handles tools internally via its own function-calling mechanism,
      // so we pass null for toolScriptDir to skip PATH injection.
      const env = buildSpawnEnv(null, context.requestId);

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

      // Track when both readline and the child process have finished to avoid
      // a race condition where child.on('close') fires before readline has
      // processed all buffered NDJSON lines (including the final 'turn.completed'
      // line that carries the 'done' event).
      let rlClosed = false;
      let childExitCode: number | null = null;
      let childExited = false;

      const tryFinalize = () => {
        if (!rlClosed || !childExited) return;  // Wait for both
        signal.removeEventListener('abort', onAbort);

        if (settled) {
          log.debug('Codex process closed', { code: childExitCode, threadId });
          resolve(threadId);
          return;
        }
        settled = true;

        // If readline finished without a 'turn.completed' event and the process
        // exited with an error code, report the error.
        if (childExitCode !== 0 && childExitCode !== null) {
          log.warn('Codex exited with non-zero code', { code: childExitCode, stderr: stderrBuffer.substring(0, 500) });

          onEvent({
            event: 'error',
            data: {
              code: 'provider_error',
              message: stderrBuffer.trim().substring(0, 500) || `Codex exited with code ${childExitCode}`,
            },
          });
          onEvent({ event: 'done', data: {} });
        } else {
          // Process exited cleanly but no 'turn.completed' event was seen — still send done
          log.warn('Codex exited without turn.completed event', { code: childExitCode });
          onEvent({ event: 'done', data: {} });
        }

        log.debug('Codex process closed', { code: childExitCode, threadId });
        resolve(threadId);
      };

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
          threadId = (parsed['thread_id'] as string) ?? null;
          log.debug('Thread started', { threadId });
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
            // CONS-003: Emit done event after error so the server always gets a terminal event.
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

      // When readline finishes processing all buffered lines
      rl.on('close', () => {
        rlClosed = true;
        tryFinalize();
      });

      // Capture stderr for error logging (SEC-005: capped at 10KB)
      let stderrBuffer = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer = appendStderr(stderrBuffer, chunk.toString());
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        log.error('Failed to spawn codex', { error: err.message });
        // UX-002: Provide user-friendly message for ENOENT
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
        childExitCode = code;
        childExited = true;
        tryFinalize();
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
      // UX-009: Include guidance about populating the models cache
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
