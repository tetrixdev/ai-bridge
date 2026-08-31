/**
 * One `local_call` frame, from arriving to answered.
 *
 * This is the machine side of the tools system: the server sends a tool, the
 * roles it wants filled and one JSON document of input, and gets back either
 * one JSON document of result or a sentence saying what went wrong. There is
 * no third shape, and in particular there is no "here is the raw text the tool
 * printed" shape, because raw text arriving where a result belongs is
 * indistinguishable to a model from a tool that worked.
 *
 * It lives in its own file rather than in the Bridge because everything worth
 * asserting about it is here: the gate, the space check, the rate limit, the
 * sandbox and the parse. A test drives this function with a plain object and
 * needs no WebSocket.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LocalCallMessage, LocalResultMessage } from '../protocol/types.js';
import { createLogger } from '../utils/logger.js';
import { fillRoles, type SecretStore } from './engram.js';
import { runLocalTool } from './executor.js';
import { localCallRefusal, type LocalExecutionConfig } from './gate.js';
import { SpaceLimiter } from './limits.js';
import { ensurePackage } from './packages.js';
import { scrub, type Redaction } from './scrub.js';

/**
 * Every string in a parsed result, keys included: a tool can hide a credential
 * in a key as easily as in a value, and both are read by whatever consumes this.
 */
function deepScrub(value: unknown, granted: Redaction[]): unknown {
  if (typeof value === 'string') return scrub(value, granted);
  if (Array.isArray(value)) return value.map((v) => deepScrub(v, granted));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([k, v]) => [scrub(k, granted), deepScrub(v, granted)]),
    );
  }
  return value;
}
import type { SandboxRequest } from './sandbox.js';

const log = createLogger('LocalCall');

/** How much of a failing tool's stderr comes back with the error. */
const STDERR_EXCERPT = 400;

export interface LocalCallContext {
  config: LocalExecutionConfig;
  /** Per-space concurrency and pacing. One limiter for the whole bridge. */
  limiter: SpaceLimiter;
  /**
   * The secrets this device holds, fetched or served from the bridge's cache.
   * Given the ids the call needs so a cache miss can re-fetch before failing.
   */
  secrets: (spaceId: string, secretIds: string[]) => Promise<SecretStore>;
  /** Overrides the default install root. Tests point this at a temp dir. */
  dataDir?: string;
}

/** Where installed tool packages live when the operator named no directory. */
export function defaultDataDir(): string {
  return join(homedir(), '.ai-bridge');
}

/**
 * Run a local_call and produce the frame that answers it.
 *
 * Never throws: every failure is a `local_result` with `ok: false`, because a
 * server waiting on an id it will never hear about again is the one outcome
 * that has no diagnosis at all. The error text is scrubbed of every credential
 * the call resolved before it leaves here.
 */
export async function handleLocalCall(
  ctx: LocalCallContext,
  message: LocalCallMessage,
): Promise<LocalResultMessage> {
  const id = typeof message.id === 'string' ? message.id : '';
  let granted: Redaction[] = [];

  try {
    // The gate first, before a package is installed, a secret is decrypted or
    // a process is spawned. A bridge that never opted in does none of those.
    const refused = localCallRefusal(ctx.config);
    if (refused) {
      log.warn('refusing a local_call', { id, tool: message.tool?.name, reason: refused });
      return { type: 'local_result', id, ok: false, error: refused };
    }

    const call = validate(message);
    const release = await ctx.limiter.acquire(call.space_id);
    try {
      const { result, sandbox } = await execute(ctx, call, (r) => { granted = r; });
      return { type: 'local_result', id, ok: true, result, sandbox };
    } finally {
      release();
    }
  } catch (err) {
    const error = scrub(err instanceof Error ? err.message : String(err), granted);
    log.warn('a local_call failed', { id, tool: message.tool?.name, error });
    return { type: 'local_result', id, ok: false, error };
  }
}

/**
 * Everything after the gate: install, resolve, run, parse.
 *
 * `remember` hands the resolved credentials back to the caller even when this
 * throws later, so the error text can be scrubbed with them. A failure path is
 * exactly where a credential ends up in a message by accident.
 */
async function execute(
  ctx: LocalCallContext,
  call: LocalCallMessage,
  remember: (granted: Redaction[]) => void,
): Promise<{ result: unknown; sandbox: LocalResultMessage['sandbox'] }> {
  const tool = call.tool;

  // The package, if any. Pinned, installed with scripts off, per space.
  const staged = await stagePackage(tool.package, {
    dataDir: ctx.dataDir ?? ctx.config.dataDir,
    spaceId: call.space_id,
    fallbackCwd: ctx.config.workdir,
  });
  const { cwd, readDir, extraEnv } = staged;

  // The space check. Every id must name a secret in THIS space; one that names
  // a secret in another space reads exactly like one that does not exist.
  const store = await ctx.secrets(call.space_id, (call.fill ?? []).map((f) => f.secret_id));
  const granted = fillRoles(store, call.space_id, call.fill);
  remember(granted);

  const sandbox: SandboxRequest = {
    ...(tool.network !== undefined ? { network: tool.network } : {}),
    ...(readDir ? { readDir } : {}),
    ...(cwd ? { cwd } : {}),
  };

  const run = await runLocalTool({
    name: tool.name,
    command: tool.command,
    args: tool.args ?? [],
    // One JSON document on stdin. Not ENGRAM_ARG_*: a local_call's input is a
    // document with a shape the tool declared, and flattening it into
    // environment variables would lose that shape and cap its size.
    input: call.input ?? {},
    secrets: granted,
    ...(cwd ? { cwd } : {}),
    sandbox,
    extraEnv,
  });

  if (run.timedOut) {
    throw new Error(`the tool did not finish in time and was killed. ${tail(run.stderr)}`);
  }
  if (run.exitCode !== 0) {
    throw new Error(`the tool exited ${run.exitCode ?? 'without a status'}. ${tail(run.stderr)}`);
  }

  const text = run.stdout.trim();
  if (text.length === 0) {
    throw new Error(
      `the tool exited cleanly but wrote nothing to stdout. A local tool answers with ` +
      `exactly one JSON document there. ${tail(run.stderr)}`,
    );
  }

  let result: unknown;
  try {
    result = JSON.parse(text);
  } catch (err) {
    // Loudly, and without passing the text on. A tool whose stdout is a log
    // line, a stack trace or two JSON documents has a bug, and handing that
    // back as a result would let it read as an answer.
    log.warn('a local tool wrote something that is not one JSON document', {
      tool: tool.name, bytes: text.length,
    });
    log.debug('what the tool actually wrote', { stdout: text.slice(0, 2_000) });
    throw new Error(
      `the tool's stdout is not one JSON document (${(err as Error).message}). ` +
      `It wrote ${text.length} bytes. Anything a tool prints for a human belongs on ` +
      `stderr; stdout carries the result and nothing else. ${tail(run.stderr)}`,
    );
  }

  log.info('local tool finished', { tool: tool.name, space: call.space_id, sandbox: run.sandbox });
  // Scrubbed AGAIN, after parsing, and this is not belt and braces.
  //
  // The executor scrubs raw stdout, and raw scrubbing is defeated by a single
  // JSON escape: a tool printing {"leak":"\u0073k-..."} matches nothing, and
  // JSON.parse then reassembles the literal into the object handed back. Found
  // by attacking this, not by reading it.
  return { result: deepScrub(result, granted), sandbox: run.sandbox };
}

/**
 * Put a tool's package on disk and say where it runs from.
 *
 * Shared by both ways in, so a `welcome`-registered local tool and a
 * `local_call` install the same way into the same per-space directory rather
 * than growing two conventions.
 */
export async function stagePackage(
  spec: string | undefined,
  options: { dataDir?: string; spaceId: string | undefined; fallbackCwd?: string },
): Promise<{ cwd?: string; readDir?: string; extraEnv: Record<string, string> }> {
  if (!spec) {
    return { ...(options.fallbackCwd ? { cwd: options.fallbackCwd } : {}), extraEnv: {} };
  }
  if (!options.spaceId) {
    throw new Error(
      `"${spec}" cannot be installed for a tool that names no space: packages are ` +
      `installed one directory per space, so that a tool from a shared space and a ` +
      `tool from a private one never share a node_modules tree.`,
    );
  }

  const installed = await ensurePackage(spec, {
    dataDir: options.dataDir ?? defaultDataDir(),
    spaceId: options.spaceId,
  });
  return {
    cwd: installed.dir,
    // The install ROOT rather than the package directory: the package's own
    // dependencies live in the root's node_modules, and a tool that cannot
    // read them cannot start.
    readDir: installed.root,
    extraEnv: { ENGRAM_PACKAGE_DIR: installed.dir },
  };
}

/** The tail of a tool's stderr, already scrubbed by the executor. */
function tail(stderr: string): string {
  const text = stderr.trim();
  if (!text) return 'It wrote nothing to stderr.';
  const excerpt = text.length > STDERR_EXCERPT ? `...${text.slice(-STDERR_EXCERPT)}` : text;
  return `Its stderr ended: ${excerpt}`;
}

/**
 * Check the frame says what it must before anything acts on it.
 *
 * A server is trusted to send well-formed frames and this still checks, for
 * the same reason the space check exists: the interesting failures are the
 * ones where a field is missing rather than wrong. An absent `space_id` with
 * no check here would become an undefined space id, and an undefined space id
 * compared against a secret's space would refuse everything with a confusing
 * message, or, on a lazier implementation, match nothing and fall back.
 */
function validate(message: LocalCallMessage): LocalCallMessage {
  if (typeof message.id !== 'string' || message.id.length === 0) {
    throw new Error('this local_call has no id, so nothing could be answered');
  }
  if (typeof message.space_id !== 'string' || message.space_id.length === 0) {
    throw new Error(
      'this local_call names no space. Every credential a tool can reach is scoped ' +
      'to one space, so a call without one has nothing it is allowed to resolve.',
    );
  }
  const tool = message.tool;
  if (!tool || typeof tool.name !== 'string' || typeof tool.command !== 'string' || !tool.command) {
    throw new Error('this local_call has no tool to run: it needs a name and a command');
  }
  if (tool.args !== undefined && !Array.isArray(tool.args)) {
    throw new Error(`the args for "${tool.name}" must be an array of strings`);
  }
  for (const arg of tool.args ?? []) {
    if (typeof arg !== 'string') {
      throw new Error(`the args for "${tool.name}" must all be strings`);
    }
  }
  for (const entry of message.fill ?? []) {
    if (!entry || typeof entry.role !== 'string' || typeof entry.secret_id !== 'string') {
      throw new Error(`each fill entry needs a role and a secret_id (tool "${tool.name}")`);
    }
  }
  return message;
}
