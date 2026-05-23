/**
 * Codex CLI Adapter
 *
 * Wraps the OpenAI Codex CLI to produce normalized stream events.
 *
 * CLI invocation:
 *   New session:    codex exec --json --skip-git-repo-check -m <model> "<user message>"
 *   Resume session: codex exec resume <SESSION_ID> --json --skip-git-repo-check "<user message>"
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

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo } from '../protocol/types.js';
import { ProviderAdapter, createFinalizer, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { buildSpawnEnv, buildCombinedPrompt, appendStderr, formatStderrMessage, resolveSystemPrompt } from './env.js';
import { startRequestTimeout, clearRequestTimeout } from './timeout.js';
import { buildCodexMcpArgs, CODEX_BEARER_ENV_VAR } from '../mcp/cli-config.js';
import { resumeAwareErrorCode } from './session-error.js';
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
      // Resume an existing session.
      // --skip-git-repo-check is required here just as on a new session:
      // without it codex refuses to run outside a trusted/git directory
      // ("Not inside a trusted directory and --skip-git-repo-check was not
      // specified."). `codex exec resume` accepts the flag.
      args = [
        'exec', 'resume', cliSessionId,
        '--json',
        '--skip-git-repo-check',
      ];
      // Pass model flag on resume if specified in request options
      if (request.options?.model) {
        args.push('-m', request.options.model);
      }
      log.debug('Resuming session', { cliSessionId });
    } else {
      // New session.
      // NOTE: do NOT pass --ephemeral here. --ephemeral runs codex "without
      // persisting session files to disk", so no rollout is written and a
      // later `codex exec resume <id>` fails with "no rollout found for
      // thread id". The bridge persists cli_session_id and resumes it on the
      // next turn, so the session MUST be persisted.
      args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '-m', model,
      ];
    }

    // Surface the model's reasoning. Codex's `exec --json` stream only emits
    // `item.completed` items of type `reasoning` when `model_reasoning_summary`
    // is `detailed` (or `concise`). The CLI default is `auto`, which does NOT
    // surface reasoning summaries in exec/json mode — verified even at
    // `model_reasoning_effort=high` with hundreds of reasoning tokens, zero
    // reasoning items were emitted. Without this override the bridge captures
    // no `thinking` blocks for Codex. `-c` is accepted by both `codex exec`
    // and `codex exec resume`, so this applies to new and resumed sessions.
    args.push('-c', 'model_reasoning_summary=detailed');

    // Wire up the bridge's MCP server. Server-declared tools are reached
    // through that channel only — Codex's own built-in `shell` tool is left
    // at its default sandbox (read-only, no network) unless the operator
    // opted into `native` mode. With sandbox_mode=read-only and no
    // approval_policy override the model cannot run arbitrary shell against
    // the bridge operator's machine even with a creatively-worded prompt.
    //
    // Note: Codex's user-level `~/.codex/AGENTS.md`, skills, and plugins
    // still load in `isolated` mode (cwd is pinned but $HOME is not). Closing
    // that residual leakage requires CODEX_HOME redirection with auth file
    // symlinking — tracked in tasks/open/cli-isolation-layer-b.md.
    if (context.mcp) {
      args.push(...buildCodexMcpArgs(context.mcp));
      if (context.cliIsolation === 'native') {
        // Legacy escape hatch for developers running the bridge against their
        // own machine. Matches the pre-MCP behaviour: the model can run
        // shell, edit files, and execute the wrapper scripts that used to
        // back the tool plumbing. Not safe when end users can send chat
        // messages.
        args.push(
          '-c', 'sandbox_mode=danger-full-access',
          '-c', 'approval_policy=never',
        );
      }
    }

    // Build the prompt positional argument. The prompt is appended LAST, after
    // every option flag, so Codex's argument parser never mistakes it for a
    // flag value. No tool manifest is appended — Codex discovers
    // server-declared tools through the MCP server.
    //
    // Codex has no dedicated --system-prompt flag, so the resolved system
    // prompt is concatenated. In isolated mode resolveSystemPrompt() returns
    // a neutral default when the server didn't send one, so Codex's own
    // built-in default never seeps through.
    const systemPrompt = !cliSessionId
      ? resolveSystemPrompt(request.system_prompt, context.cliIsolation)
      : null;
    if (systemPrompt !== null) {
      args.push('--', buildCombinedPrompt(systemPrompt, userMessage));
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

      if (context.mcp) {
        log.info('Bridge MCP server registered for Codex request', {
          toolCount: context.tools.length,
        });
      }
      // Codex reads the MCP bearer token from this env var (configured by
      // buildCodexMcpArgs as bearer_token_env_var). The env var name must
      // match between the codex config and the spawn env.
      const env = buildSpawnEnv(
        context.requestId,
        context.mcp ? { [CODEX_BEARER_ENV_VAR]: context.mcp.bearerToken } : undefined,
      );

      const child = this.spawnCli('codex', args, env);

      // Enforce the server-configured request_timeout (ai-bridge#2).
      const timeoutTimer = startRequestTimeout(
        context.requestTimeoutSeconds,
        () => {
          log.warn('Request timeout — killing codex process', {
            requestId,
            timeoutSeconds: context.requestTimeoutSeconds,
          });
          child.kill('SIGTERM');
        },
      );

      // Set up abort handling
      const onAbort = () => {
        clearRequestTimeout(timeoutTimer);
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
              data: { code: resumeAwareErrorCode(cliSessionId, message), message },
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
            data: { code: resumeAwareErrorCode(cliSessionId, message), message },
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
            data: { code: resumeAwareErrorCode(cliSessionId, message), message },
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
        clearRequestTimeout(timeoutTimer);

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
        clearRequestTimeout(timeoutTimer);
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
