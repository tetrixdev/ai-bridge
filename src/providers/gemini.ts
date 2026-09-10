/**
 * Gemini CLI Adapter
 *
 * Wraps the Google Gemini CLI to produce normalized stream events.
 *
 * CLI invocation:
 *   New session:    gemini --prompt "user message" --output-format stream-json
 *   Resume session: gemini --prompt "user message" --resume <session-id> --output-format stream-json
 *
 * Output format (NDJSON):
 *   {"type":"init","session_id":"...","model":"...","timestamp":"..."}
 *   {"type":"message","role":"user","content":"...","timestamp":"..."}
 *   {"type":"message","role":"assistant","content":"...","delta":true,"timestamp":"..."}
 *   {"type":"tool_use","tool_name":"...","tool_id":"...","parameters":{...},"timestamp":"..."}
 *   {"type":"tool_result","tool_id":"...","status":"success|error","output":"...","timestamp":"..."}
 *   {"type":"error","severity":"warning|error","message":"...","timestamp":"..."}
 *   {"type":"result","status":"success|error","stats":{...},"timestamp":"..."}
 *
 * KNOWN LIMITATION — no `thinking` blocks for Gemini.
 *
 * This adapter emits no `thinking` block events (the Codex and Claude adapters
 * do). This is an upstream Gemini CLI limitation, not something the bridge can
 * fix: the `--output-format stream-json` event schema is a fixed enum —
 * `init | message | tool_use | tool_result | error | result` — with no thought
 * type. Internally the CLI has `GeminiEventType.Thought` and surfaces thoughts
 * over its ACP interface (`agent_thought_chunk`), but the non-interactive
 * stream-json code path only forwards `Content` events and drops `Thought`
 * ones before the formatter. `ui.inlineThinkingMode` only affects the
 * interactive TUI — it has no effect on stream-json output (verified against
 * gemini-cli 0.42.0).
 *
 * Capturing Gemini thinking would require either the upstream CLI adding a
 * thought event to stream-json, or this adapter being rewritten onto the ACP
 * interface — a much larger change. See:
 *   - docs: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
 *   - upstream issue (broad): https://github.com/google-gemini/gemini-cli/issues/8473
 *   - thinking summaries, closed not planned: https://github.com/google-gemini/gemini-cli/issues/15052
 */

import { createInterface } from 'node:readline';
import type { ModelInfo } from '../protocol/types.js';
import { ProviderAdapter, createFinalizer, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import {
  buildSpawnEnv,
  buildCombinedPrompt,
  appendStderr,
  formatStderrMessage,
  getBridgeWorkingDir,
  resolveSystemPrompt,
} from './env.js';
import { startRequestTimeout, clearRequestTimeout } from './timeout.js';
import {
  BRIDGE_MCP_SERVER_NAME,
  acquireGeminiSettings,
  type GeminiSettingsHandle,
} from '../mcp/cli-config.js';
import { RequestRefusal } from '../errors.js';
import { resumeAwareErrorCode } from './session-error.js';
import { boundArguments, boundResult, safeStringify } from './result-text.js';
import { createLogger, isDebugEnabled } from '../utils/logger.js';

/**
 * Known Gemini CLI model aliases and models.
 *
 * Gemini CLI supports aliases (auto, pro, flash, flash-lite) that resolve to
 * concrete model versions. Like Claude, there is no `--list-models` command,
 * but the aliases are the official user-facing interface.
 */
const GEMINI_MODELS: ModelInfo[] = [
  { id: 'auto', name: 'Auto', description: 'Automatically selects the best model', is_default: true },
  { id: 'pro', name: 'Pro', description: 'Complex reasoning tasks (Gemini 2.5 Pro)', is_default: false },
  { id: 'flash', name: 'Flash', description: 'Fast and balanced (Gemini 2.5 Flash)', is_default: false },
  { id: 'flash-lite', name: 'Flash Lite', description: 'Fastest for simple tasks (Gemini 2.5 Flash Lite)', is_default: false },
];

const log = createLogger('GeminiAdapter');

export class GeminiAdapter extends ProviderAdapter {
  readonly providerName = 'gemini';

  async execute(context: ExecutionContext, onEvent: (event: AdapterStreamEvent) => void): Promise<string | null> {
    const { request, signal, cliSessionId } = context;
    const requestId = request.request_id;
    const userMessage = request.message;

    log.info('Executing Gemini request', { requestId });

    // Build the prompt — prepend system prompt if provided (Gemini CLI has no
    // dedicated --system-instruction flag, so we concatenate). In isolated
    // mode resolveSystemPrompt() returns a neutral default when the server
    // didn't send one, so Gemini's own built-in default never seeps through.
    // No tool manifest is appended — Gemini discovers server-declared tools
    // through the MCP server registered in .gemini/settings.json (see below).
    let prompt = userMessage;
    if (!cliSessionId) {
      const systemPrompt = resolveSystemPrompt(request.system_prompt, context.cliIsolation);
      if (systemPrompt !== null) {
        prompt = buildCombinedPrompt(systemPrompt, userMessage);
      }
    }

    // Wire up MCP by writing .gemini/settings.json in the CLI's working
    // directory — Gemini reads it as project-scope settings. The bridge's
    // working directory is dedicated and process-local (see
    // getBridgeWorkingDir()), so this file is invisible to the operator's
    // real ~/.gemini config.
    //
    // The server entry sets `trust: true` so MCP tool calls auto-approve in
    // non-interactive --prompt mode (otherwise they would stall waiting for
    // a user confirmation the headless mode can never deliver).
    //
    // In `isolated` mode we deliberately do NOT pass `--yolo`. Gemini's
    // built-in shell / edit / web tools therefore stall on approval if the
    // model tries to use them — which is the safe outcome. `native` mode
    // adds --yolo as the legacy operator opt-in.
    //
    // Note: Gemini's user-level `~/.gemini/GEMINI.md` and skills/extensions
    // still load in `isolated` mode (cwd is pinned but $HOME is not).
    // Closing that residual leakage requires HOME/GEMINI_HOME redirection
    // with auth symlinking — tracked in tasks/open/cli-isolation-layer-b.md.
    //
    // Once the working directory can be a developer's checkout, that file is
    // no longer ours: see acquireGeminiSettings(), which refuses rather than
    // overwrites an existing one and removes the one it writes when the turn
    // ends. Gemini is the only provider with this problem — Claude and Codex
    // take their MCP configuration per invocation.
    const managedWorkingDir = context.workingDir !== getBridgeWorkingDir();
    let settingsHandle: GeminiSettingsHandle | null = null;
    if (context.mcp) {
      try {
        settingsHandle = acquireGeminiSettings(context.workingDir, context.mcp, managedWorkingDir);
      } catch (err) {
        // A refusal, not a provider failure. Raised as RequestRefusal so the
        // bridge reports it as itself and ends the turn — a bare throw on a
        // resumed turn would be read as `session_lost` and silently re-issued,
        // which would retry the same refusal forever.
        throw new RequestRefusal(
          'gemini_working_dir_unavailable',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // Build CLI arguments
    const args: string[] = [
      '--prompt', prompt,               // Non-interactive mode with prompt
      '--output-format', 'stream-json', // NDJSON streaming output
      '--skip-trust',                   // Required for headless/non-interactive mode
    ];

    // Limit the visible MCP server set to ours, regardless of what the
    // operator's user/project settings might contain elsewhere.
    //
    // Outside the `context.mcp` block deliberately. `mcp` is null exactly when
    // the bridge's own MCP server failed to start — and the turn still runs.
    // Inside the block, a `workspace` turn would then launch with `--yolo` and
    // NO server restriction, so gemini would load the operator's
    // `~/.gemini/settings.json` servers and the checkout's own
    // `.gemini/settings.json`, auto-approving every tool they expose. Same
    // shape as the Claude flags; same reason.
    if (context.cliIsolation !== 'native') {
      args.push('--allowed-mcp-server-names', BRIDGE_MCP_SERVER_NAME);
    }

    if (context.cliIsolation !== 'isolated') {
      // `--yolo` auto-approves everything, including built-in shell and edit.
      //
      // In `native` this is the legacy operator opt-in. In `workspace` it is
      // the only lever Gemini offers: there is no middle setting, no
      // equivalent of Codex's `workspace-write`, and without it every built-in
      // tool stalls on an approval prompt that headless mode can never show.
      // So `workspace` on Gemini is materially broader than `workspace` on
      // Codex, and the README says so rather than implying the three CLIs are
      // equivalent.
      args.push('--yolo');
    }

    // Resume an existing session if we have a session ID
    if (cliSessionId) {
      args.push('--resume', cliSessionId);
      log.debug('Resuming session', { cliSessionId });
    }

    // Add model if specified in request options
    if (request.options?.model) {
      args.push('--model', request.options.model);
    }

    // Gemini CLI does not support max_tokens directly — log a warning only; do
    // not emit a stream error (the server has no actionable response and it
    // would confuse users who see an error before a successful reply).
    if (request.options?.max_tokens) {
      log.warn('max_tokens option specified but Gemini CLI does not support it directly — ignoring', {
        max_tokens: request.options.max_tokens,
      });
    }

    // Only build the truncated arg array when debug logging is active
    if (isDebugEnabled()) {
      log.debug('Spawning gemini', { args: args.map((a) => a.length > 50 ? a.substring(0, 50) + '...' : a) });
    }

    // try/finally rather than releasing at each exit: the settings file must
    // come back out of the developer's checkout whatever happened — a clean
    // finish, a provider error, a timeout, or a cancel — and a release that
    // has to be remembered at four separate call sites is a release that will
    // be forgotten at one of them.
    try {
      return await new Promise<string | null>((resolve) => {
      let sessionId: string | null = null;
      let blockIndex = 0;
      let settled = false;
      let inTextBlock = false;

      const env = buildSpawnEnv(context.requestId);

      const child = this.spawnCli('gemini', args, env, undefined, context.workingDir);

      // Enforce the server-configured request_timeout (ai-bridge#2).
      const timeoutTimer = startRequestTimeout(
        context.requestTimeoutSeconds,
        () => {
          log.warn('Request timeout — killing gemini process', {
            requestId,
            timeoutSeconds: context.requestTimeoutSeconds,
          });
          child.kill('SIGTERM');
        },
      );

      // Set up abort handling
      const onAbort = () => {
        clearRequestTimeout(timeoutTimer);
        log.info('Request aborted — killing gemini process', { requestId });
        child.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort, { once: true });

      // Track stderr in a variable so the finalizer closure can access it.
      let stderrBuffer = '';

      const finalizer = createFinalizer({
        providerName: 'gemini',
        terminalEvent: 'result',
        getSettled: () => settled,
        setSettled: () => { settled = true; },
        getSessionId: () => sessionId,
        getStderr: () => stderrBuffer,
        onEvent,
        resolve,
        signal,
        onAbort,
        // Gemini-specific: close any open text block before finalizing
        onBeforeFinalize: () => {
          if (inTextBlock) {
            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });
            blockIndex++;
            inTextBlock = false;
          }
        },
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

        // ── init ─────────────────────────────────────────────
        if (type === 'init') {
          sessionId = (parsed['session_id'] as string) ?? null;
          log.debug('Session init', { sessionId, model: parsed['model'] });
          return;
        }

        // ── message ──────────────────────────────────────────
        if (type === 'message') {
          const role = parsed['role'] as string;

          // Skip the user message echo
          if (role === 'user') return;

          if (role === 'assistant') {
            const content = parsed['content'] as string;
            const isDelta = parsed['delta'] as boolean | undefined;

            if (!content) return;

            if (isDelta) {
              // Streaming delta — Gemini sends multiple delta messages
              // Open a text block if not already open
              if (!inTextBlock) {
                onEvent({
                  event: 'block_start',
                  data: {
                    block_index: blockIndex,
                    block_type: 'text',
                  },
                });
                inTextBlock = true;
              }

              onEvent({
                event: 'block_delta',
                data: {
                  block_index: blockIndex,
                  content,
                },
              });
            } else {
              // Non-delta full message (rare in stream-json mode, but handle it)
              // Close any open block first
              if (inTextBlock) {
                onEvent({
                  event: 'block_stop',
                  data: { block_index: blockIndex },
                });
                blockIndex++;
                inTextBlock = false;
              }

              onEvent({
                event: 'block_start',
                data: { block_index: blockIndex, block_type: 'text' },
              });
              onEvent({
                event: 'block_delta',
                data: { block_index: blockIndex, content },
              });
              onEvent({
                event: 'block_stop',
                data: { block_index: blockIndex },
              });
              blockIndex++;
            }
          }
          return;
        }

        // ── tool_use ─────────────────────────────────────────
        if (type === 'tool_use') {
          // Close any open text block before tool use
          if (inTextBlock) {
            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });
            blockIndex++;
            inTextBlock = false;
          }

          // Emit as a tool_call block
          onEvent({
            event: 'block_start',
            data: {
              block_index: blockIndex,
              block_type: 'tool_call',
              tool_name: parsed['tool_name'] as string,
              tool_call_id: parsed['tool_id'] as string,
            },
          });

          onEvent({
            event: 'block_delta',
            data: {
              block_index: blockIndex,
              // Guarded: an encode that throws inside the readline
              // listener would take down the daemon, not just this turn.
              content: boundArguments(parsed['parameters'] ?? {}),
            },
          });

          onEvent({
            event: 'block_stop',
            data: { block_index: blockIndex },
          });
          blockIndex++;
          return;
        }

        // ── tool_result ──────────────────────────────────────
        if (type === 'tool_result') {
          const toolId = parsed['tool_id'] as string;
          const output = (parsed['output'] as string) ?? '';
          const status = parsed['status'] as string;

          onEvent({
            event: 'tool_result',
            data: {
              tool_call_id: toolId,
              result: boundResult(status === 'error'
                ? `Error: ${(parsed['error'] as Record<string, unknown>)?.['message'] ?? output}`
                : output),
              // Structural, alongside the `Error: ` prefix rather than instead
              // of it — the prefix stays for consumers that already read it.
              //
              // Only when Gemini reported a status. Absent means "not
              // reported", never "succeeded", so a missing status must not
              // become an authoritative `false`.
              ...(typeof status === 'string' ? { is_error: status === 'error' } : {}),
            },
          });
          return;
        }

        // ── error (non-fatal or fatal) ──────────────────────
        if (type === 'error') {
          const severity = parsed['severity'] as string;
          const message = parsed['message'] as string;
          log.warn('Gemini error event', { severity, message: message?.substring(0, 200) });

          // severity='error' and severity='warning' are both forwarded to the
          // server as stream events.
          if (severity === 'error') {
            const errText = message ?? 'Unknown Gemini error';
            onEvent({
              event: 'error',
              data: {
                code: resumeAwareErrorCode(cliSessionId, errText),
                message: errText,
              },
            });
            // Fatal errors terminate the response — emit done and mark settled.
            onEvent({ event: 'done', data: {} });
            settled = true;
          }
          // severity 'warning' is non-fatal and informational — Gemini keeps
          // streaming. It must NOT be emitted as a stream 'error' event: the
          // server treats every error as terminal and would abort the request
          // (dropping subsequent content and tool calls). Log it locally only.
          return;
        }

        // ── result (final) ───────────────────────────────────
        if (type === 'result') {
          // Guard against duplicate done events — a fatal 'error' event may
          // already have settled this request before result arrives.
          if (settled) return;

          // Close any open text block
          if (inTextBlock) {
            onEvent({
              event: 'block_stop',
              data: { block_index: blockIndex },
            });
            blockIndex++;
            inTextBlock = false;
          }

          const status = parsed['status'] as string;

          if (status === 'error') {
            const error = parsed['error'] as Record<string, unknown> | undefined;
            const errorMessage = (error?.['message'] as string) ?? 'Gemini request failed';
            log.warn('Gemini result error', { type: error?.['type'], message: errorMessage.substring(0, 200) });

            onEvent({
              event: 'error',
              data: {
                code: resumeAwareErrorCode(cliSessionId, errorMessage),
                message: errorMessage,
              },
            });
          }

          // Extract usage stats
          const stats = parsed['stats'] as Record<string, unknown> | undefined;
          const inputTokens = stats ? (stats['input_tokens'] as number) ?? null : null;
          const outputTokens = stats ? (stats['output_tokens'] as number) ?? null : null;

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

        log.debug('Unhandled Gemini event type', { type });
      });

      rl.on('close', finalizer.onRlClose);

      // Capture stderr for error logging (capped at 10KB)
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer = appendStderr(stderrBuffer, chunk.toString());
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        log.error('Failed to spawn gemini', { error: err.message });
        // Provide user-friendly message for ENOENT
        const errorMessage = err.code === 'ENOENT'
          ? 'gemini CLI not found. Install it or ensure it is on your PATH.'
          : `Failed to spawn gemini: ${err.message}`;
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
        log.debug('Gemini process closed', { code, sessionId });
        clearRequestTimeout(timeoutTimer);
        finalizer.onChildClose(code);
      });
      });
    } finally {
      settingsHandle?.release();
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    // Gemini CLI has no dynamic model listing — return known aliases
    return GEMINI_MODELS;
  }
}
