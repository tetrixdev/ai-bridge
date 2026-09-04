/**
 * Claude CLI Adapter
 *
 * Wraps the Anthropic Claude CLI to produce normalized stream events.
 *
 * CLI invocation:
 *   New session:    claude -p --output-format stream-json --verbose "user message"
 *   Resume session: claude -p --resume <UUID> --output-format stream-json --verbose "user message"
 *   System prompt:  Passed via --system-prompt flag on first message
 *
 * Output format (NDJSON):
 *   {"type":"system","subtype":"init","session_id":"...","model":"..."}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...}}
 *   {"type":"result","subtype":"success","session_id":"...","usage":{...},"total_cost_usd":...}
 */

import { createInterface } from 'node:readline';
import type { ModelInfo } from '../protocol/types.js';
import { ProviderAdapter, createFinalizer, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { buildSpawnEnv, appendStderr, formatStderrMessage, resolveSystemPrompt } from './env.js';
import { startRequestTimeout, clearRequestTimeout } from './timeout.js';
import { BRIDGE_MCP_SERVER_NAME, writeClaudeMcpConfig } from '../mcp/cli-config.js';
import { resumeAwareErrorCode } from './session-error.js';
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

    // Resume an existing session if we have a session ID. `--resume <id>`
    // continues the conversation under the SAME session id (unlike
    // `--session-id`, which creates a new session with a chosen id and errors
    // with "Session ID is already in use" when that id already exists).
    if (cliSessionId) {
      args.push('--resume', cliSessionId);
      log.debug('Resuming session', { cliSessionId });
    }

    // `--bare` would be the natural fit for `isolated` mode (skips hooks,
    // LSP, plugin sync, auto-memory, background prefetches, keychain reads,
    // and CLAUDE.md auto-discovery) — BUT its keychain-read suppression
    // breaks OAuth: per Claude's own docs, "Anthropic auth is strictly
    // ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain
    // are never read)". For an operator logged in via subscription/OAuth
    // (the common case for the bridge), `--bare` produces a hard
    // "Not logged in — please run /login" error on every turn.
    //
    // Until Layer B routes auth via apiKeyHelper or ANTHROPIC_API_KEY
    // passthrough, we DON'T pass `--bare`. The remaining isolation
    // (--strict-mcp-config, --allowedTools, default permission mode in -p)
    // still blocks built-in tools and other MCP servers; what leaks is
    // hooks, auto-memory, plugin sync, and CLAUDE.md auto-discovery. The
    // bridge's cwd-pinning (see env.ts:getBridgeWorkingDir) keeps cwd-walk
    // CLAUDE.md out — only user-level ~/.claude/CLAUDE.md still applies.
    // Tracked in tasks/open/cli-isolation-layer-b.md.

    // Add the system prompt on EVERY invocation, including resumes. Claude's
    // `--system-prompt` is per-invocation and is NOT retained across `--resume`
    // (Anthropic CLI docs) — a resumed turn that omits it runs with no system
    // prompt, so the model loses its instructions after the first turn. We
    // therefore re-send it each turn (matching the working pocket-dev pattern).
    // resolveSystemPrompt() returns the server-supplied prompt when present, the
    // neutral isolated fallback when missing-and-isolated, or null when
    // missing-and-native (let Claude use its own default).
    const systemPrompt = resolveSystemPrompt(request.system_prompt, context.cliIsolation);
    if (systemPrompt !== null) {
      args.push('--system-prompt', systemPrompt);
    }

    // Add model if specified in request options
    if (request.options?.model) {
      args.push('--model', request.options.model);
    }

    // Add max tokens if specified
    if (request.options?.max_tokens) {
      args.push('--max-tokens', String(request.options.max_tokens));
    }

    // Wire up the bridge's MCP server so the model can call server-declared
    // tools. `--strict-mcp-config` is critical in isolated mode: without it
    // Claude would load MCP servers from the user's global ~/.claude config
    // too, widening the tool surface beyond what the bridge intends.
    //
    // In `isolated` mode we ALSO explicitly allow only our MCP tools via
    // `--allowedTools mcp__bridge__*`. Claude's built-in Bash / Edit / Write
    // / Read / Glob / Grep / WebFetch tools then deny by default in headless
    // `-p` mode (no interactive approver), so the model can only reach our
    // tools — not shell.
    //
    // In `native` mode the operator's other MCP servers stay loadable. The
    // permission mode is decided separately, below, because it must not depend
    // on whether an MCP channel exists.
    // `isolated` AND `workspace` both keep the operator's own MCP servers out.
    // That is the half of isolation `workspace` does NOT relax: it widens what
    // the model may do with the repository in front of it, not what else on
    // this machine it can reach.
    //
    // Pushed OUTSIDE the `context.mcp` block on purpose. `mcp` is null whenever
    // the bridge's own MCP server failed to start — and the turn still runs.
    // Inside the block, that failure would silently drop the flag and let
    // Claude load the operator's `~/.claude.json` and project `.mcp.json`
    // servers, at the exact moment it is also running with bypassPermissions.
    // The one path where isolation matters most must not be the one where it
    // is skipped.
    if (context.cliIsolation !== 'native') {
      args.push('--strict-mcp-config');
    }

    // Also outside the `context.mcp` block, and for the same reason as
    // `--strict-mcp-config`: without it, an `isolated` turn whose MCP channel
    // failed to start would run with NO tool restriction at all — the flag
    // dropped exactly where it matters most.
    //
    // Glob is supported in --allowedTools matchers (per Claude CLI docs, e.g.
    // "Bash(git *)"). `mcp__<server>__*` is the standard MCP tool namespace
    // prefix Claude uses. Omitted in `workspace`, where the built-in Read /
    // Edit / Write / Bash tools are exactly what we want.
    if (context.cliIsolation === 'isolated') {
      // A turn carrying attachments needs to be able to read them: the
      // preamble names absolute paths outside cwd, and without a rule covering
      // them the turn ends with the model saying it cannot see a file the user
      // just attached, with nothing in the logs pointing at this flag.
      //
      // SCOPED TO THE ATTACHMENT DIRECTORY, and nothing else. A bare `Read`
      // here would be a whole-filesystem read grant — verified against Claude
      // 2.1.260: `--allowedTools "…,Read"` reads `/etc`, `~/.ssh` and anything
      // else, because the entry pre-approves the tool rather than bounding it.
      // A server controls both the attachments and the message, so that would
      // hand any server arbitrary file read in the DEFAULT posture, switched
      // on by sending a field — the exact thing --allow-dir and --local-tools
      // exist to prevent.
      //
      // The `Read(/<abs path>/**)` form is a gitignore-style absolute matcher
      // (the doubled slash is load-bearing). Verified to allow the attachment
      // and to deny a path outside it. Glob and Grep are deliberately NOT
      // granted: the preamble gives absolute paths, so nothing needs to search.
      //
      // Comma-separated in ONE argv value rather than several: this flag is
      // variadic, and a bare list would let it swallow the flag that follows.
      const allowed = [`mcp__${BRIDGE_MCP_SERVER_NAME}__*`];
      if (context.attachmentDir) {
        allowed.push(`Read(/${context.attachmentDir}/**)`);
      }
      args.push('--allowedTools', allowed.join(','));
    }

    if (context.mcp) {
      const configPath = writeClaudeMcpConfig(context.mcp);
      args.push('--mcp-config', configPath);
    }

    // Permission mode, decided independently of whether any tools were
    // registered — a `workspace` turn with no server tools still needs to be
    // able to edit and run things, and a `native` turn was always meant to.
    //
    // `bypassPermissions` is what actually runs a real task, and saying
    // otherwise would be misleading: in headless `-p` mode there is no
    // interactive approver, so `acceptEdits` gets through file edits and then
    // stalls the first time the model reaches for the shell. Running the tests
    // is a shell command, so "edit the file and run the tests" stops halfway
    // with no error anyone can see. See the security note in the README —
    // this is not a sandbox and is not described as one.
    if (context.cliIsolation !== 'isolated') {
      args.push('--permission-mode', 'bypassPermissions');
    }

    // The user message is delivered via STDIN, not as a positional argument.
    // On a fresh session it carries the full prior conversation, and a large
    // prompt as an argv entry exceeds the OS per-argument size limit — the
    // spawn then dies with `spawn E2BIG`. In `--print` mode Claude reads its
    // prompt from stdin when no positional prompt is given; spawnCli writes it
    // and closes stdin so the child never blocks. (This also sidesteps the
    // variadic `--allowedTools` / `--mcp-config` arg-eating that previously
    // required a `--` terminator.)

    // Only build the truncated arg array when debug logging is active
    if (isDebugEnabled()) {
      log.debug('Spawning claude', { args: args.map((a) => a.length > 50 ? a.substring(0, 50) + '...' : a) });
    }

    return new Promise<string | null>((resolve, reject) => {
      let sessionId: string | null = null;
      let blockIndex = 0;
      let settled = false;

      const env = buildSpawnEnv(context.requestId);
      // Claude CLI refuses to run if CLAUDECODE is set, even to empty string
      delete env['CLAUDECODE'];

      const child = this.spawnCli('claude', args, env, userMessage, context.workingDir);

      // Enforce the server-configured request_timeout. Without this a stuck
      // CLI would run forever; with it the bridge bounds every turn.
      const timeoutTimer = startRequestTimeout(
        context.requestTimeoutSeconds,
        () => {
          log.warn('Request timeout — killing claude process', {
            requestId,
            timeoutSeconds: context.requestTimeoutSeconds,
          });
          child.kill('SIGTERM');
        },
      );

      // Set up abort handling
      const onAbort = () => {
        clearRequestTimeout(timeoutTimer);
        log.info('Request aborted — killing claude process', { requestId });
        child.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort, { once: true });

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
          // A late readline-buffered assistant event can arrive after the
          // stream is already settled; log it for diagnosis.
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

          // An error `result` (e.g. subtype "error_during_execution") must NOT
          // be reported as a successful `done` — that silently drops the turn.
          // When the request tried to RESUME a session and the CLI could not
          // find it, surface `session_lost` so the server recovers by
          // re-issuing the turn fresh; any other error is a plain provider_error.
          if (parsed['is_error'] === true) {
            const errs = Array.isArray(parsed['errors']) ? parsed['errors'] : [];
            const errText = errs.length > 0
              ? errs.join('; ')
              : String(parsed['subtype'] ?? 'Claude reported an error');

            onEvent({
              event: 'error',
              data: {
                code: resumeAwareErrorCode(context.cliSessionId, errText),
                message: errText,
              },
            });
            onEvent({ event: 'done', data: {} });
            settled = true;
            return;
          }

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

        // rate_limit_event is informational — Claude Code emits it to report
        // rate-limit status (often status "allowed") and continues streaming.
        // It must NOT be turned into a terminal error: doing so aborts the
        // request mid-stream. A genuine hard rate-limit surfaces through the
        // result event / non-zero exit, which the normal error path handles.
        if (type === 'rate_limit_event') {
          log.debug('Claude rate limit event (informational)', {
            status: (parsed['rate_limit_info'] as Record<string, unknown> | undefined)?.['status'],
          });
          return;
        }

        log.debug('Unhandled Claude event type', { type });
      });

      rl.on('close', finalizer.onRlClose);

      // Capture stderr for error logging (capped at 10KB)
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer = appendStderr(stderrBuffer, chunk.toString());
      });

      child.on('error', (err: NodeJS.ErrnoException) => {
        log.error('Failed to spawn claude', { error: err.message });
        // Provide user-friendly message for ENOENT
        const errorMessage = err.code === 'ENOENT'
          ? 'claude CLI not found. Install it or ensure it is on your PATH.'
          : `Failed to spawn claude: ${err.message}`;
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
        log.debug('Claude process closed', { code, sessionId });
        clearRequestTimeout(timeoutTimer);
        finalizer.onChildClose(code);
      });
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    // Claude CLI has no dynamic model listing — return known aliases
    return CLAUDE_MODELS;
  }
}
