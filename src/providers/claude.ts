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
 *
 * Helpers (sub-agents) are reported alongside, and both of these are
 * forwarded:
 *
 *   - Each helper frame carries `parent_tool_use_id`, naming the tool call
 *     that spawned it. The whole-message path puts it on the blocks and tool
 *     results it emits, so a consumer can tell a helper's work from the main
 *     assistant's. Absent means the main assistant, as it always did.
 *   - `system` frames `task_started` / `task_progress` / `task_updated` /
 *     `task_notification`, and a `tool_progress` heartbeat every 30 s while a
 *     helper runs, become the `task` stream event. See taskEventFrom().
 */

import { createInterface } from 'node:readline';
import type { ModelInfo, TaskData, TaskPhase, TaskUsage } from '../protocol/types.js';
import { ProviderAdapter, createFinalizer, type ExecutionContext, type AdapterStreamEvent } from './base.js';
import { buildSpawnEnv, appendStderr, formatStderrMessage, resolveSystemPrompt } from './env.js';
import { startTurnTimeouts, clearRequestTimeout, type TurnTimeouts } from './timeout.js';
import { BRIDGE_MCP_SERVER_NAME, writeClaudeMcpConfig } from '../mcp/cli-config.js';
import { resumeAwareErrorCode } from './session-error.js';
import {
  boundArguments,
  boundTaskText,
  replaceLoneSurrogateEscapes,
  safeStringify,
  toolResultEventData,
} from './result-text.js';
import { ClaudePartialStreamMapper } from './claude-partial.js';
import { supportsPartialMessages, noteCliRejectedPartialFlag } from './claude-capabilities.js';
import { createLogger, isDebugEnabled } from '../utils/logger.js';
import { stopTurn, stoppedByUs } from './stop.js';

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

  async execute(context: ExecutionContext, emit: (event: AdapterStreamEvent) => void): Promise<string | null> {
    // Every emission resets the silence clock, so the wrapper goes HERE rather
    // than at each call site — there are a dozen, some inside a deferral queue,
    // and one missed would make a healthy turn look silent.
    let timeouts: TurnTimeouts | null = null;
    const onEvent = (event: AdapterStreamEvent): void => {
      timeouts?.notice();
      emit(event);
    };

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

    // The bridge's lifecycle addendum rides BESIDE the server's prompt, never
    // instead of it. Switching `--system-prompt` to `--append-system-prompt`
    // would look equivalent and is not: without replacement the CLI falls back
    // to its built-in coding-agent persona, which leaks command-line-tool
    // conventions into a chat whose prompt the server owns (the same argument
    // resolveSystemPrompt() and ISOLATED_FALLBACK_SYSTEM_PROMPT make). It would
    // also turn `native` isolation into replacement mode by accident, since
    // appending onto a null prompt is the CLI's own substitute for one.
    //
    // Both flags in one invocation is verified to work — the model obeys both.
    // Re-sent every turn for the same reason as --system-prompt above: neither
    // is retained across --resume.
    if (context.bridgeAddendum !== null) {
      args.push('--append-system-prompt', context.bridgeAddendum);
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
      /**
       * A `result` that belongs to the CLI's own queued work, kept in case no
       * other one arrives. See the `origin` handling below.
       */
      let heldResult: Record<string, unknown> | null = null;
      /**
       * Frames that arrived after the turn ended. Zero on a healthy turn, and
       * the one number that says how much of an answer was lost when it is not
       * — the per-frame warnings say which, never how many.
       */
      let droppedAfterSettle = 0;

      // Owns the turn's block indices. Both paths allocate from it: partial
      // streaming handles the main agent, while sub-agent messages arrive only
      // as whole `assistant` frames and are mapped below.
      const mapper = new ClaudePartialStreamMapper();

      // Every task this turn saw start, and what its `task_started` said.
      // `task_updated` does not name the spawning call, and a consumer groups a
      // helper's events by it, so the bridge fills it in from here; it is also
      // the set of calls a heartbeat may be attributed to. Keyed by task_id,
      // NOT by the call: a task that started without naming its call is still
      // a task this turn started, and its later phases must still get through.
      const startedTasks = new Map<string, StartedTask>();

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

      const env = buildSpawnEnv(context.requestId, context.bridgeEnv);
      // Claude CLI refuses to run if CLAUDECODE is set, even to empty string
      delete env['CLAUDECODE'];

      const child = this.spawnCli('claude', args, env, userMessage, context.workingDir);

      // Two clocks: silence, which kills, and a wall-clock backstop. Without
      // either a wedged CLI would run forever.
      timeouts = startTurnTimeouts({
        silenceSeconds: context.silenceTimeoutSeconds,
        requestSeconds: context.requestTimeoutSeconds,
        onFire: (reason, limitSeconds) => {
          log.warn('Turn timed out — killing claude process', {
            requestId,
            reason,
            limitSeconds,
          });
          // No flush here on purpose. The finalizer's `onBeforeFinalize` runs
          // on child close and already closes every open block, so everything
          // this side received survives the kill. Flushing again first looked
          // prudent and was measurably redundant — removing it changes no
          // output. What cannot be recovered is whatever the CLI had buffered
          // internally and not yet written, and no amount of flushing on this
          // side reaches that.
          stopTurn(child, { requestId, provider: 'claude' });
        },
      });
      const timeoutTimer = { cancel: () => timeouts?.cancel() };

      // Set up abort handling
      const onAbort = () => {
        clearRequestTimeout(timeoutTimer);
        log.info('Request aborted — killing claude process', { requestId });
        stopTurn(child, { requestId, provider: 'claude' });
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
        getTimeout: () => {
          const reason = timeouts?.reason();
          const limitSeconds = timeouts?.limit();

          return reason && limitSeconds !== null && limitSeconds !== undefined
            ? { reason, limitSeconds }
            : null;
        },
        // The CLI exited cleanly having produced only results we judged to be
        // its own queued work. That judgement was wrong, or the CLI changed:
        // report the last one rather than "the AI returned no response", which
        // would throw away a turn we have in hand.
        recoverTerminal: () => {
          if (heldResult === null) return false;

          log.warn('No result answered our prompt — settling from the last held one', {
            requestId,
            sessionId,
            origin: queuedWorkOrigin(heldResult),
          });
          // A held result that FAILED still has to read as a failure. Falling
          // through to a bare `done` would turn the CLI reporting an error into
          // a turn that merely produced nothing.
          if (heldResult['is_error'] === true) {
            const errs = Array.isArray(heldResult['errors']) ? heldResult['errors'] : [];
            const errText = errs.length > 0
              ? errs.join('; ')
              : String(heldResult['subtype'] ?? 'Claude reported an error');
            onEvent({
              event: 'error',
              data: { code: resumeAwareErrorCode(context.cliSessionId, errText), message: errText },
            });
          }
          onEvent({ event: 'done', data: doneDataFrom(heldResult, model, providerVersion) });

          return true;
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

        // A helper's life, reported by the CLI beside its work. Through the
        // deferral queue like the helper's own blocks, so a `finished` can
        // never overtake the helper's last result, and through `onEvent` — so
        // it counts as activity for the silence clock. That is what keeps a
        // helper busy in one long step from getting the turn stopped as
        // silent: its heartbeat is the only thing the CLI says meanwhile.
        if (type === 'system' || type === 'tool_progress') {
          const task = taskEventFrom(parsed, startedTasks);
          if (task !== null) {
            if (settled) {
              droppedAfterSettle++;

              return;
            }
            emitWholeMessage({ event: 'task', data: task });

            return;
          }
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
            droppedAfterSettle++;
            log.warn('Tool result received after stream settled — dropping', {
              requestId, sessionId, toolCallIds: ids,
            });

            return;
          }

          const content = message?.['content'];
          if (!Array.isArray(content)) return;

          const parent = parentOf(parsed);

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
            for (const data of toolResultEventData(
              toolUseId,
              flattenToolResult(entry['content']),
              typeof isError === 'boolean' ? isError : undefined,
            )) {
              const withParent: Record<string, unknown> = { ...data, ...parent };
              emitWholeMessage({ event: 'tool_result', data: withParent });
            }
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
          if (settled) {
            droppedAfterSettle++;

            return;
          }
          mapper.handle(parsed, onEvent);
          if (!mapper.hasOpenBlock()) flushDeferred();
          return;
        }

        if (type === 'assistant') {
          // A late readline-buffered assistant event can arrive after the
          // stream is already settled; log it for diagnosis.
          if (settled) {
            droppedAfterSettle++;
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

          // Which helper wrote this, if any. Only on this path: the streaming
          // path never sees a helper's frames (see the guard in
          // ClaudePartialStreamMapper.handle), so this is where they all land.
          const parent = parentOf(parsed);

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
                  ...parent,
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
                  ...parent,
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
                  ...parent,
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
                  // Bounded like a result is. A sub-agent's Write call carries
                  // a whole file as its arguments, and an oversized frame is
                  // answered with a CLOSE_TOO_BIG that tears down the
                  // connection — every in-flight request on the bridge with it.
                  // boundArguments, not boundResult: this holds the parsed
                  // object, so oversized VALUES can be replaced while every key
                  // survives and the result stays valid JSON.
                  content: boundArguments(toolInput ?? {}),
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
          if (settled) {
            droppedAfterSettle++;

            return;
          }

          // Extract final session ID and usage from result
          sessionId = (parsed['session_id'] as string) ?? sessionId;

          const origin = queuedWorkOrigin(parsed);
          log.info('Claude result frame', {
            requestId,
            sessionId,
            subtype: parsed['subtype'],
            numTurns: parsed['num_turns'],
            durationMs: parsed['duration_ms'],
            isError: parsed['is_error'] === true,
            origin,
            endsTurn: origin === null,
          });

          if (origin !== null) {
            // Not our prompt. One `claude -p` invocation can run more than one
            // turn: work the CLI queues for ITSELF runs first, and each of
            // those ends with a `result` of its own. The one that bites is a
            // background task left running by an earlier turn — on the next
            // --resume the CLI answers its own `<task-notification>` before it
            // dequeues the message we sent, and that notification's result
            // arrives within ~70ms, carrying zero usage and no text.
            //
            // Settling on it ended the turn before the answer had started. The
            // server received a `done` with zero tokens, the real reply was
            // dropped frame by frame ("tool result received after stream
            // settled"), and the person saw an empty message — then saw it
            // again on the retry, because the notification was still queued.
            //
            // The CLI stamps those with `origin` (`{"kind":"task-notification"}`)
            // and leaves the result that answers OUR prompt unstamped, measured
            // against 2.1.x. Hold it: if the CLI exits without ever producing an
            // unstamped result, `recoverTerminal` settles from this rather than
            // reporting an empty turn, so an origin we have not seen before
            // costs the turn nothing worse than the delay until the process
            // exits (~600ms, measured).
            //
            // The stamp is on the RESULT, so that is what this holds back. A
            // queued turn that wrote something would have its content forwarded
            // like any other frame; today they make no API call and produce
            // none, which is why they are invisible apart from ending here.
            heldResult = parsed;

            return;
          }

          // An error `result` (e.g. subtype "error_during_execution") must NOT
          // be reported as a successful `done` — that silently drops the turn.
          // When the request tried to RESUME a session and the CLI could not
          // find it, surface `session_lost` so the server recovers by
          // re-issuing the turn fresh; any other error is a plain provider_error.
          if (parsed['is_error'] === true) {
            // Unless WE stopped this turn, in which case the reason is ours and
            // not the CLI's. A claude leaving a SIGINT commonly writes an error
            // result on its way out, and both things that send it one — a
            // cancel and a bound — would otherwise be reported here as the turn
            // having failed.
            //
            // Not settled, and nothing emitted: the finalizer already knows how
            // to end both, and settling here is precisely what stopped it. It
            // says `silence_timeout_exceeded` with the limit for a bound, and a
            // bare `done` for a cancel; this path could only ever have said
            // `provider_error`, so the server never learned the bridge had
            // stopped the turn at all.
            if (stoppedByUs(signal, timeouts)) {
              log.info('Ignoring an error result written on the way out', {
                requestId,
                subtype: parsed['subtype'],
                because: signal.aborted ? 'cancelled' : timeouts?.reason(),
              });

              return;
            }

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
            // The SAME metadata as a successful turn. A turn that fails still
            // spent tokens and money — often more than one that succeeds — and
            // this reported `{}`, so the cost of exactly the turns worth
            // investigating was the cost that got thrown away. Stopping `done`'s
            // fields being written into the ERROR frame was right; leaving the
            // accompanying `done` empty was not.
            onEvent({ event: 'done', data: doneDataFrom(parsed, model, providerVersion) });
            settled = true;
            return;
          }

          settleBlocks();
          onEvent({ event: 'done', data: doneDataFrom(parsed, model, providerVersion) });
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
        // A turn that ended early loses everything that came after it, and the
        // per-frame warnings never add up to how much. One number, at the only
        // point where it is final.
        if (droppedAfterSettle > 0) {
          log.warn('Frames arrived after the turn had ended and were dropped', {
            requestId, sessionId, count: droppedAfterSettle,
          });
        }
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
/**
 * A tool result's content as one string.
 *
 * Deliberately NOT bounded here: the emit site splits it into frames, so
 * bounding at this point would truncate a result that chunking can carry whole.
 */
function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : describePart(content);

  return (content
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
  // A base64 payload is binary whatever the part calls itself. Keying on the
  // TYPE NAME let a `document` part carrying a PDF in `source.data` fall through
  // to `safeStringify`, which inlines the whole thing: measured at 1.2 million
  // characters across five frames. That used to be capped at 256 KB by
  // `boundResult`; removing that bound in favour of chunking turned a bounded
  // leak into one with a 16 MB ceiling.
  const isBinary = type === 'image' || type === 'audio'
    || ((source !== undefined || resource !== undefined) && typeof binary === 'string');

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

/**
 * Which queued work of the CLI's own a `result` frame closes, if it is not ours.
 *
 * The bridge sends exactly one prompt per invocation, so a result that names an
 * origin at all belongs to something the CLI queued for itself — today a
 * `<task-notification>` for a background shell command an earlier turn left
 * running. The result that answers our prompt carries no `origin`.
 *
 * @returns the origin's kind, or null when the frame ends our own turn
 */
function queuedWorkOrigin(result: Record<string, unknown>): string | null {
  const origin = result['origin'];
  if (typeof origin !== 'object' || origin === null) return null;
  const kind = (origin as Record<string, unknown>)['kind'];

  // An origin we cannot name is still an origin, and the frame is still not
  // ours. `recoverTerminal` is what makes that safe to act on.
  return typeof kind === 'string' && kind !== '' ? kind : 'unknown';
}

/**
 * What the CLI reported about a turn, whether it succeeded or failed.
 *
 * @param result the CLI's `result` frame
 */
function doneDataFrom(
  result: Record<string, unknown>,
  model: string | null,
  providerVersion: string | null,
): Record<string, unknown> {
  const usage = result['usage'] as Record<string, unknown> | undefined;

  return {
    usage: {
      input_tokens: num(usage?.['input_tokens']),
      output_tokens: num(usage?.['output_tokens']),
      cache_creation_input_tokens: num(usage?.['cache_creation_input_tokens']),
      cache_read_input_tokens: num(usage?.['cache_read_input_tokens']),
    },
    model,
    provider_version: providerVersion,
    stop_reason: typeof result['stop_reason'] === 'string' ? result['stop_reason'] : null,
    // Why the turn ended, in the CLI's own words: "success",
    // "error_during_execution", "error_max_turns". A turn that comes back empty
    // is the case this exists for — `stop_reason` is null on several of those
    // paths, and without this the server has nothing to show but a blank
    // message.
    subtype: typeof result['subtype'] === 'string' ? result['subtype'] : null,
    cost_usd: num(result['total_cost_usd']),
    duration_ms: num(result['duration_ms']),
    duration_api_ms: num(result['duration_api_ms']),
    num_turns: num(result['num_turns']),
    // Bounded: each denial carries the refused call's whole input, so one
    // denied large write would otherwise make the TERMINAL frame oversized —
    // and a `done` that does not arrive hangs the request rather than costing
    // one event.
    ...(Array.isArray(result['permission_denials'])
      ? { permission_denials: boundDenials(result['permission_denials']) }
      : {}),
    // What the turn spent on helpers — spawned, completed, failed, by type.
    // Passed through as the CLI reports it, and only when it fits comfortably:
    // it is a handful of counters, and anything bigger is not what this is.
    ...subagentStatsOf(result['subagent_stats']),
  };
}

/** Budget for `subagent_stats` on the terminal frame. Measured at ~350 bytes on 2.1.280. */
const MAX_SUBAGENT_STATS_BYTES = 8 * 1024;

function subagentStatsOf(value: unknown): { subagent_stats?: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  // Scrubbed and measured for the same reason the denials are: this rides on
  // the TERMINAL frame, where a lone surrogate or an oversized payload costs
  // the request its `done`.
  const encoded = replaceLoneSurrogateEscapes(safeStringify(value, ''));
  if (encoded === '' || Buffer.byteLength(encoded, 'utf8') > MAX_SUBAGENT_STATS_BYTES) return {};

  try {
    return { subagent_stats: JSON.parse(encoded) as Record<string, unknown> };
  } catch {
    return {};
  }
}

/**
 * The helper a frame belongs to, spread-ready: `{ parent_tool_use_id }`, or
 * nothing at all for the main assistant — absent, never null, so a consumer
 * that predates the field sees exactly the payload it always did.
 */
function parentOf(frame: Record<string, unknown>): { parent_tool_use_id?: string } {
  const parent = frame['parent_tool_use_id'];

  return typeof parent === 'string' && parent !== '' ? { parent_tool_use_id: parent } : {};
}

/** Read a string field, or undefined. */
function strOf(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key];

  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Read a finite number field, or undefined. */
function numOf(source: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = source?.[key];

  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A helper's running totals, keeping only the counters the protocol names. */
function usageOf(value: unknown): TaskUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const source = value as Record<string, unknown>;
  const usage: TaskUsage = {};
  const total = numOf(source, 'total_tokens');
  const tools = numOf(source, 'tool_uses');
  const duration = numOf(source, 'duration_ms');
  if (total !== undefined) usage.total_tokens = total;
  if (tools !== undefined) usage.tool_uses = tools;
  if (duration !== undefined) usage.duration_ms = duration;

  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** What a turn remembers about a task from its `task_started`. */
interface StartedTask {
  /** The spawning call, when the CLI named it (at start, or on a later phase). */
  toolUseId: string | undefined;
  /** `local_agent`, `local_bash`… — named by the CLI only at start. */
  taskType: string | undefined;
}

/** The CLI's `system` subtypes for a task's life, and the phase each becomes. */
const TASK_PHASES: ReadonlyMap<string, TaskPhase> = new Map<string, TaskPhase>([
  ['task_started', 'started'],
  ['task_progress', 'progress'],
  ['task_updated', 'updated'],
  // "Notification" is the CLI's word for the message it hands the main
  // assistant when a helper ends. For a consumer it is the end of the helper.
  ['task_notification', 'finished'],
]);

/**
 * Map one CLI frame onto a `task` event, or null when it is not one.
 *
 * Shapes captured from Claude Code 2.1.280:
 *
 *   system/task_started       task_id, tool_use_id, task_type, subagent_type,
 *                             description, spawn_depth, is_backgrounded, prompt
 *   system/task_progress      task_id, tool_use_id, description,
 *                             last_tool_name, usage{total_tokens,tool_uses,duration_ms}
 *   system/task_updated       task_id, patch{status, end_time}   (no tool_use_id)
 *   system/task_notification  task_id, tool_use_id, status, summary,
 *                             output_file, usage
 *   tool_progress             heartbeat:true, parent_tool_use_id (the spawning
 *                             call), elapsed_time_seconds — every 30 s
 *
 * Deliberately NOT forwarded: `prompt` (the helper's whole instruction — the
 * largest frame in the family, and a non-terminal frame over the cap is not
 * trimmed but replaced by a `frame_too_large` stream error, which ends the
 * turn — so carrying it would put the whole turn at risk) and
 * `output_file` (a path on this machine, which means nothing to a server).
 *
 * @param started every task seen to start in this turn, keyed by task_id —
 *                filled in here from `task_started`, and read back for the
 *                frames that omit the spawning call or the task's kind
 */
function taskEventFrom(frame: Record<string, unknown>, started: Map<string, StartedTask>): TaskData | null {
  if (frame['type'] === 'tool_progress') {
    // A heartbeat is keyed by the call it is waiting on, which for a helper is
    // the `Agent` call that spawned it. Only those of a task this process saw
    // start: a heartbeat for some other long-running call is not a helper's,
    // and a consumer grouping `task` events by `tool_use_id` would otherwise
    // invent a helper for it.
    if (frame['heartbeat'] !== true) return null;
    const parent = strOf(frame, 'parent_tool_use_id');
    if (parent === undefined) return null;
    const match = [...started.entries()].find(([, task]) => task.toolUseId === parent);
    if (match === undefined) return null;
    const [taskId, task] = match;

    const elapsed = numOf(frame, 'elapsed_time_seconds');

    return {
      phase: 'heartbeat',
      task_id: taskId,
      tool_use_id: parent,
      ...(task.taskType !== undefined ? { task_type: task.taskType } : {}),
      ...(elapsed !== undefined ? { elapsed_seconds: elapsed } : {}),
    };
  }

  const phase = TASK_PHASES.get(String(frame['subtype']));
  if (phase === undefined) return null;

  const taskId = strOf(frame, 'task_id');
  if (taskId === undefined) return null;
  let toolUseId = strOf(frame, 'tool_use_id');

  let known = started.get(taskId);
  if (phase === 'started') {
    // Recorded whether or not the CLI named the spawning call. Recording only
    // the ones that did made a task started without a `tool_use_id` look, to
    // every later phase, like one this process never saw start: `started` got
    // through and its `progress` and `finished` were dropped, so a consumer
    // drew a helper that ran forever.
    known = { toolUseId, taskType: strOf(frame, 'task_type') };
    started.set(taskId, known);
  } else if (known !== undefined) {
    // A later phase that names the call teaches it to a task that started
    // without one, so its heartbeats and `updated` can be keyed from then on.
    if (known.toolUseId === undefined && toolUseId !== undefined) known.toolUseId = toolUseId;
    toolUseId = toolUseId ?? known.toolUseId;
  } else {
    // A task this process never saw start. The real case is the CLI's own
    // queued work: on --resume it first reports that a background command an
    // EARLIER turn left running was stopped, before it reads our prompt. That
    // is not a helper of this turn, and forwarding it would have a consumer
    // draw a finished helper nobody started. So every task a consumer sees
    // was introduced by a `started`.
    return null;
  }

  const data: TaskData = { phase, task_id: taskId };
  if (toolUseId !== undefined) data.tool_use_id = toolUseId;
  // On every phase, not only `started`: the CLI names the kind only there, and
  // a consumer that joins late, or keys a row off a `progress`, should not have
  // to have kept the `started` to tell a helper from a shell command.
  if (known.taskType !== undefined) data.task_type = known.taskType;

  const subagentType = strOf(frame, 'subagent_type');
  if (subagentType !== undefined) data.subagent_type = subagentType;
  const description = strOf(frame, 'description');
  if (description !== undefined) data.description = boundTaskText(description);

  if (phase === 'started') {
    const depth = numOf(frame, 'spawn_depth');
    if (depth !== undefined) data.spawn_depth = depth;
    if (typeof frame['is_backgrounded'] === 'boolean') data.is_backgrounded = frame['is_backgrounded'];
  }

  if (phase === 'progress') {
    const lastTool = strOf(frame, 'last_tool_name');
    if (lastTool !== undefined) data.last_tool_name = lastTool;
  }

  if (phase === 'updated') {
    const patch = frame['patch'];
    const status = typeof patch === 'object' && patch !== null
      ? strOf(patch as Record<string, unknown>, 'status')
      : undefined;
    // An update that says nothing a consumer can use is not worth a frame.
    if (status === undefined) return null;
    data.status = status;
  }

  if (phase === 'finished') {
    const status = strOf(frame, 'status');
    if (status !== undefined) data.status = status;
    const summary = strOf(frame, 'summary');
    if (summary !== undefined) data.summary = boundTaskText(summary);
  }

  if (phase === 'progress' || phase === 'finished') {
    const usage = usageOf(frame['usage']);
    if (usage !== undefined) data.usage = usage;
  }

  return data;
}

/**
 * Keep the permission denials that fit, and say how many did not.
 *
 * Which tools were refused is the useful part — an empty answer with three
 * denials reads very differently from one with none — and that survives even
 * when the refused arguments do not.
 */
function boundDenials(denials: unknown[]): unknown[] {
  const BUDGET = 32 * 1024;
  const kept: unknown[] = [];
  let used = 0;

  for (const denial of denials) {
    // Scrubbed, not merely measured. A denial carries the refused call's whole
    // input — model-authored text, which is exactly where a lone surrogate
    // comes from — and this was the one field on the TERMINAL frame passed
    // through raw. `JSON.stringify` succeeds and the frame is small, so neither
    // the size guard nor the encode fallback engages; PHP's `json_decode` then
    // rejects the whole document and the turn's only terminal is lost, leaving
    // the request to hang to a timeout.
    const encoded = replaceLoneSurrogateEscapes(safeStringify(denial, '{}'));
    const size = Buffer.byteLength(encoded, 'utf8');
    if (used + size > BUDGET) {
      kept.push({ omitted: denials.length - kept.length, reason: 'too large to forward' });
      break;
    }

    let clean: unknown = denial;
    try {
      clean = JSON.parse(encoded);
    } catch {
      clean = { omitted: 1, reason: 'could not be encoded' };
    }

    kept.push(clean);
    used += size;
  }

  return kept;
}
