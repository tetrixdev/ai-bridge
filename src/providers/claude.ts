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
 *   {"type":"stream_event","event":{"type":"content_block_delta","index":0,...}}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...}}
 *   {"type":"result","subtype":"success","session_id":"...","usage":{...},"total_cost_usd":...}
 *
 * Two paths produce blocks, and both run in the same turn:
 *
 *   - `stream_event` frames, when the CLI supports `--include-partial-messages`.
 *     Text arrives in chunks as the model writes it. Mapped by
 *     claude-partial.ts.
 *   - `assistant` frames, which carry a whole message at once. Still the only
 *     form for sub-agent (Task tool) messages, and the only form at all on a
 *     CLI without the flag.
 *
 * A message delivered by the first path ALSO arrives via the second. The
 * duplicate is suppressed by message id — see the `wasStreamed` check below.
 */

import { createInterface } from 'node:readline';
import type { ModelInfo } from '../protocol/types.js';
import { ProviderAdapter, createFinalizer, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { buildSpawnEnv, appendStderr, formatStderrMessage, resolveSystemPrompt } from './env.js';
import { startRequestTimeout, clearRequestTimeout } from './timeout.js';
import { BRIDGE_MCP_SERVER_NAME, writeClaudeMcpConfig } from '../mcp/cli-config.js';
import { resumeAwareErrorCode } from './session-error.js';
import { boundResult, safeStringify } from './result-text.js';
import { ClaudePartialStreamMapper } from './claude-partial.js';
import { supportsPartialMessages, noteCliRejectedPartialFlag } from './claude-capabilities.js';
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

    // Stream text as the model writes it, rather than one lump per content
    // block. Without this the CLI reports an assistant message only once the
    // block is complete, so a long answer lands as a paragraph at a time and a
    // slow turn is indistinguishable from a stalled one.
    //
    // Gated on a probe because the flag is fatal on a CLI that does not have
    // it (see claude-capabilities.ts). When it is absent the whole-message
    // path below runs exactly as before.
    const partialMessages = await supportsPartialMessages();
    if (partialMessages) {
      args.push('--include-partial-messages');
    }

    // The probe above is the first await in this method, so a cancellation that
    // lands during it would otherwise be missed: the abort listener is only
    // registered further down, and adding one to an ALREADY-aborted signal
    // never fires. Without this check the CLI is spawned for a request nobody
    // is reading, and runs until the request timeout.
    if (context.signal.aborted) {
      log.info('Request aborted before spawn', { requestId });
      onEvent({ event: 'done', data: {} });
      return null;
    }

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
    if (context.cliIsolation === 'isolated') {
      // `manual` is what actually enforces `isolated`, and without it the
      // posture is only as strong as the operator's own Claude settings.
      //
      // The bridge asks for a restricted tool surface with --allowedTools and
      // relies on Claude to deny the rest. That denial comes from Claude's
      // permission system, which reads ~/.claude/settings.json — so a
      // developer who set `permissions.defaultMode: "auto"` to stop being
      // prompted in their own work silently turns `isolated` into "everything
      // allowed", on every turn a server sends them. Verified against 2.1.260:
      // with that setting an isolated turn read an arbitrary file and ran an
      // arbitrary shell command; with this flag both are denied.
      //
      // `manual` rather than dropping the settings file wholesale
      // (--setting-sources) because auth lives in there too: an operator using
      // apiKeyHelper would lose their credentials, which is the trap --bare
      // already falls into and the reason this adapter cannot use it.
      args.push('--permission-mode', 'manual');
    } else {
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
      let model: string | null = null;
      let providerVersion: string | null = null;
      let settled = false;

      // Owns the turn's block indices. Both paths allocate from it: partial
      // streaming handles the main agent, while sub-agent messages arrive only
      // as whole `assistant` frames and are mapped below.
      const mapper = new ClaudePartialStreamMapper();

      // Whole-message blocks that arrived while a partial block was still open.
      //
      // Nothing in the protocol forbids overlapping blocks, but every consumer
      // tracks exactly one open block — the reference chat UI and the recorder
      // both do — so a block_start arriving inside another one silently
      // discards the outer block's text. It cannot happen with today's CLI (a
      // sub-agent runs only while the main agent is blocked on the tool call,
      // so no main block is open), but a backgrounded sub-agent would change
      // that, and holding these back costs nothing.
      const deferred: AdapterStreamEvent[] = [];
      const emitWholeMessage = (event: AdapterStreamEvent) => {
        if (mapper.hasOpenBlock()) deferred.push(event);
        else onEvent(event);
      };
      const flushDeferred = () => {
        while (deferred.length > 0) onEvent(deferred.shift()!);
      };

      /** Close anything the CLI left open, then release anything held back. */
      const settleBlocks = () => {
        mapper.closeOpenBlocks(onEvent);
        flushDeferred();
      };

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
      // appendStderr keeps the FIRST 10KB, so once a rejection appears in the
      // buffer every later chunk still matches it. Latch, or one turn invalidates
      // the probe cache once per stderr chunk.
      let noticedFlagRejection = false;

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
        // A cancelled turn, a timeout or a CLI crash abandons whatever block
        // was mid-stream. Close them, or a consumer that commits a block on
        // block_stop drops the last chunk of every cancelled answer.
        onBeforeFinalize: settleBlocks,
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
          // The model the CLI actually resolved, and the CLI's own version.
          // The server asks for an alias ("sonnet"); only this says what ran.
          model = typeof parsed['model'] === 'string' ? parsed['model'] : null;
          providerVersion = typeof parsed['claude_code_version'] === 'string'
            ? parsed['claude_code_version']
            : null;
          log.debug('Session init', { sessionId, model, providerVersion });
          return;
        }

        // Tool results. The CLI reports them on `user` frames, and the bridge
        // used to drop them on the floor — so a server could see that a tool
        // ran and never what it returned, while the Codex and Gemini adapters
        // both forwarded theirs. The tool_use_id matches the tool_call_id
        // already carried on the tool_call block, so a consumer can pair them.
        if (type === 'user') {
          const message = parsed['message'] as Record<string, unknown> | undefined;

          if (settled) {
            // The one path where a result vanishes. Correct — nothing may
            // follow `done` — but it is exactly the backgrounded-sub-agent case
            // this handling exists for, so a real occurrence must be
            // diagnosable. The assistant handler logs its equivalent.
            const ids = Array.isArray(message?.['content'])
              ? (message['content'] as Array<Record<string, unknown>>)
                .filter((e) => typeof e === 'object' && e !== null && e['type'] === 'tool_result')
                .map((e) => e['tool_use_id'])
              : [];
            log.warn('Tool result received after stream settled — dropping', {
              requestId, sessionId, toolCallIds: ids,
            });

            return;
          }

          const content = message?.['content'];
          if (!Array.isArray(content)) return;

          for (const entry of content as Array<Record<string, unknown>>) {
            // Guarded because this runs inside the readline 'line' listener: a
            // throw here is an uncaughtException, and the CLI installs no
            // handler for those, so it would take down the daemon and every
            // other turn on it — not merely fail this request.
            if (typeof entry !== 'object' || entry === null) continue;
            if (entry['type'] !== 'tool_result') continue;
            const toolUseId = entry['tool_use_id'];
            if (typeof toolUseId !== 'string') continue;

            const isError = entry['is_error'];
            // Through the deferral queue like every other whole-message event.
            // A backgrounded sub-agent reports its results while the main agent
            // is still writing, so emitting directly put tool output inside an
            // open text block and delivered results before the block_start of
            // the call they belong to — measured, 5 of 6 out of order on a real
            // turn. The comment that used to say this could not happen was
            // right only for foreground sub-agents.
            emitWholeMessage({
              event: 'tool_result',
              data: {
                tool_call_id: toolUseId,
                result: flattenToolResult(entry['content']),
                ...(typeof isError === 'boolean' ? { is_error: isError } : {}),
              },
            });
          }
          return;
        }

        // Partial message chunks, when the CLI supports them. Each frame wraps
        // one raw Anthropic SSE event; the mapper turns them into the same
        // block_start / block_delta / block_stop trio the whole-message path
        // produces, just finer grained.
        if (type === 'stream_event') {
          // Nothing may follow `done`. Today's CLI puts `result` last, but a
          // late frame would otherwise emit block events onto a finished turn.
          if (settled) return;
          mapper.handle(parsed, onEvent);
          if (!mapper.hasOpenBlock()) flushDeferred();
          return;
        }

        if (type === 'assistant') {
          // A late readline-buffered assistant event can arrive after the
          // stream is already settled; log it for diagnosis.
          if (settled) {
            log.debug('Assistant event received after stream settled — dropping', { sessionId });
            return;
          }

          // The assistant message contains the content blocks
          const message = parsed['message'] as Record<string, unknown> | undefined;
          if (!message) return;

          // In partial mode this frame is the twin of a stream we have ALREADY
          // emitted — the CLI sends both, and this one arrives mid-stream,
          // between the last delta and content_block_stop. Emitting it too
          // would duplicate every block of the answer.
          //
          // Matched on the message id rather than on "partial mode is on",
          // because sub-agent turns (the Task tool) are delivered only as whole
          // assistant frames: the CLI emits no stream_event for a sidechain. A
          // blanket rule would drop that output entirely, and the turn would
          // read as the sub-agent having done nothing.
          const messageId = typeof message['id'] === 'string' ? message['id'] : undefined;
          if (mapper.wasStreamed(messageId)) {
            return;
          }

          const content = message['content'] as Array<Record<string, unknown>> | undefined;
          if (!content || !Array.isArray(content)) return;

          for (const block of content) {
            const blockType = block['type'] as string;

            if (blockType === 'text') {
              const text = block['text'] as string;
              if (!text) continue;

              const index = mapper.nextIndex();

              // Emit block_start + block_delta + block_stop for text
              emitWholeMessage({
                event: 'block_start',
                data: {
                  block_index: index,
                  block_type: 'text',
                },
              });

              emitWholeMessage({
                event: 'block_delta',
                data: {
                  block_index: index,
                  content: text,
                },
              });

              emitWholeMessage({
                event: 'block_stop',
                data: {
                  block_index: index,
                },
              });
            } else if (blockType === 'thinking') {
              const thinking = block['thinking'] as string;
              if (!thinking) continue;

              const index = mapper.nextIndex();

              // Emit thinking block
              emitWholeMessage({
                event: 'block_start',
                data: {
                  block_index: index,
                  block_type: 'thinking',
                },
              });

              emitWholeMessage({
                event: 'block_delta',
                data: {
                  block_index: index,
                  content: thinking,
                },
              });

              emitWholeMessage({
                event: 'block_stop',
                data: {
                  block_index: index,
                },
              });
            } else if (blockType === 'tool_use') {
              // Claude emits tool_use blocks when the model wants to call a tool
              const toolName = block['name'] as string;
              const toolId = block['id'] as string;
              const toolInput = block['input'] as Record<string, unknown> | undefined;

              if (!toolName || !toolId) continue;

              const index = mapper.nextIndex();

              emitWholeMessage({
                event: 'block_start',
                data: {
                  block_index: index,
                  block_type: 'tool_call',
                  tool_name: toolName,
                  tool_call_id: toolId,
                },
              });

              emitWholeMessage({
                event: 'block_delta',
                data: {
                  block_index: index,
                  // Guarded for the same reason describePart is: this runs in
                  // the readline listener, and a sub-agent's tool_use input
                  // reaches here unstreamed, so a structure too deep to encode
                  // would take down the daemon rather than fail one request.
                  content: safeStringify(toolInput ?? {}, '{}'),
                },
              });

              emitWholeMessage({
                event: 'block_stop',
                data: {
                  block_index: index,
                },
              });
            }
          }
          return;
        }

        if (type === 'result') {
          // A second `result` would otherwise emit a second `done`, completing
          // the server's request twice.
          if (settled) return;

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

            // Blocks first: this path sets `settled` and returns, so the
            // finalizer's onBeforeFinalize never runs and anything still open
            // would never be closed.
            settleBlocks();
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

          settleBlocks();
          onEvent({
            event: 'done',
            data: {
              usage: {
                input_tokens: num(usage?.['input_tokens']),
                output_tokens: num(usage?.['output_tokens']),
                cache_creation_input_tokens: num(usage?.['cache_creation_input_tokens']),
                cache_read_input_tokens: num(usage?.['cache_read_input_tokens']),
              },
              model,
              provider_version: providerVersion,
              stop_reason: typeof parsed['stop_reason'] === 'string' ? parsed['stop_reason'] : null,
              cost_usd: num(parsed['total_cost_usd']),
              duration_ms: num(parsed['duration_ms']),
              duration_api_ms: num(parsed['duration_api_ms']),
              num_turns: num(parsed['num_turns']),
              ...(Array.isArray(parsed['permission_denials'])
                ? { permission_denials: parsed['permission_denials'] }
                : {}),
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
          const info = parsed['rate_limit_info'];
          log.debug('Claude rate limit event (informational)', {
            status: (info as Record<string, unknown> | undefined)?.['status'],
          });
          // Forwarded, not just logged: how much of the operator's window is
          // spent and when it resets is something the server can act on, and
          // a log on someone else's machine is not.
          if (!settled && typeof info === 'object' && info !== null) {
            onEvent({
              event: 'rate_limit',
              data: { provider: 'claude', info: info as Record<string, unknown> },
            });
          }
          return;
        }

        log.debug('Unhandled Claude event type', { type });
      });

      rl.on('close', finalizer.onRlClose);

      // Capture stderr for error logging (capped at 10KB)
      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer = appendStderr(stderrBuffer, chunk.toString());
        // A CLI downgraded under a running bridge rejects the flag we cached as
        // supported. Clear the cache so the next turn re-probes instead of
        // failing identically until someone restarts the bridge.
        if (partialMessages && !noticedFlagRejection) {
          noticedFlagRejection = noteCliRejectedPartialFlag(stderrBuffer);
        }
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
          // Setting `settled` here makes the finalizer skip onBeforeFinalize,
          // so this path has to close its own blocks. Reachable when 'error'
          // fires after streaming began — a failed kill(), say.
          settleBlocks();
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

/** Read a numeric field, or null when it is absent or not a number. */
function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reduce a tool result's content to the text a server can display.
 *
 * Claude sends this either as a plain string or as an array of content blocks,
 * and the array form is what a tool returning structured output produces. A
 * naive `String(content)` turns that into "[object Object]", which is worse
 * than dropping it: the server would show something that looks like output.
 */
function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return boundResult(content);
  if (!Array.isArray(content)) return boundResult(content == null ? '' : describePart(content));

  return boundResult(content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (typeof part === 'object' && part !== null) {
        const text = (part as Record<string, unknown>)['text'];
        if (typeof text === 'string') return text;
      }
      // A null element would otherwise render as the literal word "null".
      if (part === null || part === undefined) return '';
      return describePart(part);
    })
    .join(''));
}

/**
 * Describe a result part that carries no text of its own.
 *
 * Only genuinely UNREADABLE parts are replaced: an image or audio block is
 * megabytes of base64 — one screenshot measured at 617,411 characters against
 * 2.1.261 — which is not output anyone can read and which a server cannot do
 * anything with on this path. A file the assistant wants to hand back has its
 * own route in the `attachment` event.
 *
 * Everything else is forwarded whole. An earlier version capped any non-text
 * part at 4KB, which threw away exactly the readable structured output a
 * server most wants — an MCP embedded resource carrying plain text became
 * `[resource: 5 KB]` — and was a regression against forwarding it verbatim.
 * Size is bounded once, on the assembled result, where the actual constraint
 * lives.
 */
function describePart(part: unknown): string {
  const record = typeof part === 'object' && part !== null ? part as Record<string, unknown> : {};
  const type = typeof record['type'] === 'string' ? record['type'] as string : 'unknown';

  // Three shapes carry binary, and only knowing one of them means a perfectly
  // good MCP image reads as a broken one — or worse, an embedded resource's
  // base64 blob is forwarded verbatim, which is the case this exists to stop.
  //
  //   Anthropic : { type: 'image', source: { media_type, data } }
  //   MCP image : { type: 'image', mimeType, data }
  //   MCP blob  : { type: 'resource', resource: { mimeType, blob } }
  const resource = typeof record['resource'] === 'object' && record['resource'] !== null
    ? record['resource'] as Record<string, unknown>
    : undefined;
  const source = typeof record['source'] === 'object' && record['source'] !== null
    ? record['source'] as Record<string, unknown>
    : undefined;
  const holder = source ?? resource ?? record;
  const binary = holder['data'] ?? holder['blob'];
  const isBinary = type === 'image' || type === 'audio'
    || (resource !== undefined && typeof holder['blob'] === 'string');

  if (isBinary) {
    const media = ['media_type', 'mimeType', 'mime_type']
      .map((key) => holder[key])
      .find((value): value is string => typeof value === 'string') ?? type;
    // base64 is 4 characters per 3 bytes. A malformed part says so rather than
    // reporting a confident "0 KB", which is indistinguishable from a tiny one.
    const size = typeof binary === 'string'
      ? `${Math.round((binary.length * 3) / 4 / 1024)} KB`
      : 'size unknown';

    return `[${type}: ${media}, ${size}]`;
  }

  return safeStringify(part, `[${type}: could not be serialised]`);
}
