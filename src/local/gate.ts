/**
 * The one gate for local execution.
 *
 * Local tools change what a bridge is. Until now a server could make the
 * SERVER run things; a local tool lets a server make THIS MACHINE run things,
 * as the user. That is the same trust anyone extends to an npm package, but it
 * has to be chosen rather than inherited, and a server must never be able to
 * turn it on by sending a field.
 *
 * So: one function, consulted in one place, with a test asserting that a
 * DungeonMeister-shaped config refuses a local tool outright. Not a flag read
 * in three places that can drift.
 */

import type { ToolDefinition } from '../protocol/types.js';

export interface LocalExecutionConfig {
  /** Explicitly turned on by the operator, never by the server. */
  enabled: boolean;
  /** Where local tools run. Absent means the bridge's own working directory. */
  workdir?: string;
}

/** The posture of a bridge that was never configured for local execution. */
export const LOCAL_EXECUTION_OFF: LocalExecutionConfig = { enabled: false };

/**
 * Whether this tool should run here rather than round-trip to the server.
 *
 * Both halves are required, and the order matters for what it means: a tool
 * marked `local` on a bridge that never opted in is not an error to report, it
 * is simply a tool the bridge will not run. It falls through to the server
 * path, where an unknown tool fails the way any other unknown tool does.
 */
export function runsLocally(config: LocalExecutionConfig, tool: ToolDefinition | undefined): boolean {
  if (!config.enabled) return false;
  return tool?.execute === 'local';
}

/**
 * Why a local tool was refused, for the log. Silence here reads as a bug in the
 * server's tool registration rather than as a deliberate posture.
 */
export function refusalReason(config: LocalExecutionConfig, tool: ToolDefinition | undefined): string | null {
  if (tool?.execute !== 'local') return null;
  if (!config.enabled) {
    return 'this bridge was not started with local execution enabled, so the tool was not run here';
  }
  return null;
}
