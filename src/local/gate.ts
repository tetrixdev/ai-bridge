/**
 * The one gate for local execution.
 *
 * Local tools change what a bridge is. Until now a server could make the
 * SERVER run things; a local tool lets a server make THIS MACHINE run things,
 * as the user. That is the same trust anyone extends to an npm package, but it
 * has to be chosen rather than inherited, and a server must never be able to
 * turn it on by sending a field.
 *
 * So: one predicate, consulted by every way in, with tests asserting that a
 * DungeonMeister-shaped config refuses both a `welcome`-registered local tool
 * and a `local_call` frame outright. Not a flag read in three places that can
 * drift, and not a new message type that quietly brings its own door.
 */

import type { ToolDefinition } from '../protocol/types.js';

export interface LocalExecutionConfig {
  /** Explicitly turned on by the operator, never by the server. */
  enabled: boolean;
  /** Where local tools run. Absent means the bridge's own working directory. */
  workdir?: string;
  /**
   * Where the bridge keeps what it installs for local tools, one directory per
   * space. Absent means `~/.ai-bridge`.
   */
  dataDir?: string;
}

/**
 * The posture of a bridge that was never configured for local execution.
 *
 * Frozen: every default-constructed Bridge aliases this one object, and
 * `readonly` is a compile-time promise only. Without the freeze any code in the
 * process, a dependency or an embedding application, could set
 * `LOCAL_EXECUTION_OFF.enabled = true` and turn local execution on for every
 * default bridge at once. Not reachable from a server, but this file's whole
 * argument is that the guarantee should be structural.
 */
export const LOCAL_EXECUTION_OFF: LocalExecutionConfig = Object.freeze({ enabled: false });

/**
 * Whether this tool should run here rather than round-trip to the server.
 *
 * Both halves are required, and the order matters for what it means: a tool
 * marked `local` on a bridge that never opted in is not an error to report, it
 * is simply a tool the bridge will not run. It falls through to the server
 * path, where an unknown tool fails the way any other unknown tool does.
 */
export function runsLocally(config: LocalExecutionConfig, tool: ToolDefinition | undefined): boolean {
  return enabled(config) && tool?.execute === 'local';
}

/**
 * Whether this bridge runs anything at all on this machine.
 *
 * The one predicate underneath both entry points. A `local_call` frame is a
 * second way into the same capability, and a second way in that consults a
 * second flag is how a gate stops being a gate: this file's whole argument is
 * that there is one answer to "may this server run code here", not one per
 * message type.
 */
function enabled(config: LocalExecutionConfig): boolean {
  // === true, not truthy: a consumer passing a non-boolean should not enable
  // execution by accident.
  return config.enabled === true;
}

/**
 * Why a `local_call` was refused, or null when it may proceed.
 *
 * Unlike a `welcome`-registered tool, a local_call is a direct instruction and
 * deserves a direct answer: it is refused outright and the refusal is sent
 * back as `ok: false`, rather than falling through to some other path. There
 * is no other path.
 */
export function localCallRefusal(config: LocalExecutionConfig): string | null {
  if (!enabled(config)) {
    return 'this bridge was not started with local execution enabled (--local-tools), ' +
      'so it will not run anything on this machine';
  }
  return null;
}

/**
 * Why a local tool was refused, for the log. Silence here reads as a bug in the
 * server's tool registration rather than as a deliberate posture.
 */
export function refusalReason(config: LocalExecutionConfig, tool: ToolDefinition | undefined): string | null {
  if (tool?.execute !== 'local') return null;
  if (!enabled(config)) {
    return 'this bridge was not started with local execution enabled, so the tool was not run here';
  }
  return null;
}
