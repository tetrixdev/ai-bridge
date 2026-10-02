/**
 * Per-request subagent definitions (`ai_request.agents`).
 *
 * The protocol field is provider-neutral; today only Claude Code has a way to
 * take it (`--agents <json-or-file>`). Other adapters ignore it with a debug
 * line — see logIgnoredAgents().
 *
 * The shape is Claude Code's own `--agents` JSON, restricted to the fields the
 * protocol promises:
 *
 *   { "<name>": { "description": string, "prompt": string,
 *                 "tools"?: string[], "model"?: string } }
 *
 * Validation drops an invalid entry rather than failing the turn: a server on
 * a newer protocol, or one bad definition among several, should cost that one
 * helper, not the user's answer. Each drop is logged at warning level with the
 * reason. An entry is dropped WHOLE when any field is wrong — in particular a
 * malformed `tools` is never reduced to "no tools field", because an absent
 * `tools` means the helper inherits EVERY tool, the opposite of what a
 * restricting list asked for.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition } from '../protocol/types.js';
import type { Logger } from '../utils/logger.js';

/** Letters, digits, `-` and `_`; must start with a letter or digit. */
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The fields an entry may carry. Anything else is stripped (and logged). */
const KNOWN_FIELDS = new Set(['description', 'prompt', 'tools', 'model']);

/** Result of validating `request.agents`. */
export interface ResolvedAgents {
  /** Valid definitions, or null when there are none to pass on. */
  agents: Record<string, AgentDefinition> | null;
  /** One `name: reason` per dropped entry (or the whole field). */
  dropped: string[];
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Why one entry is invalid, or null when it is valid. */
function entryProblem(name: string, def: unknown): string | null {
  if (!AGENT_NAME.test(name)) {
    return 'name must be 1-64 letters, digits, "-" or "_", starting with a letter or digit';
  }
  if (def === null || typeof def !== 'object' || Array.isArray(def)) {
    return 'definition must be an object';
  }
  const d = def as Record<string, unknown>;
  if (!isNonEmptyString(d['description'])) return '"description" must be a non-empty string';
  if (!isNonEmptyString(d['prompt'])) return '"prompt" must be a non-empty string';
  if (d['tools'] !== undefined) {
    if (!Array.isArray(d['tools']) || !d['tools'].every(isNonEmptyString)) {
      return '"tools" must be an array of non-empty strings';
    }
  }
  if (d['model'] !== undefined && !isNonEmptyString(d['model'])) {
    return '"model" must be a non-empty string';
  }
  return null;
}

/**
 * Validate `request.agents` and keep the entries that are well-formed.
 *
 * Absent / null → `{ agents: null, dropped: [] }`. Valid entries are copied
 * with only the known fields; unknown fields are stripped and named in the
 * log, never forwarded.
 */
export function resolveAgents(raw: unknown, log?: Logger): ResolvedAgents {
  if (raw === undefined || raw === null) return { agents: null, dropped: [] };

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    const reason = 'agents: must be an object keyed by agent name';
    log?.warn('Ignoring request agents', { reason });
    return { agents: null, dropped: [reason] };
  }

  const agents: Record<string, AgentDefinition> = {};
  const dropped: string[] = [];

  for (const [name, def] of Object.entries(raw as Record<string, unknown>)) {
    const problem = entryProblem(name, def);
    if (problem !== null) {
      dropped.push(`${name}: ${problem}`);
      log?.warn('Dropping invalid agent definition', { agent: name, reason: problem });
      continue;
    }
    const d = def as Record<string, unknown>;
    const unknown = Object.keys(d).filter((k) => !KNOWN_FIELDS.has(k));
    if (unknown.length > 0) {
      log?.warn('Stripping unsupported agent fields', { agent: name, fields: unknown });
    }
    const clean: AgentDefinition = {
      description: d['description'] as string,
      prompt: d['prompt'] as string,
    };
    if (d['tools'] !== undefined) clean.tools = [...(d['tools'] as string[])];
    if (d['model'] !== undefined) clean.model = d['model'] as string;
    agents[name] = clean;
  }

  return { agents: Object.keys(agents).length > 0 ? agents : null, dropped };
}

/** A written agents file, and the way to remove it. */
export interface AgentsFileHandle {
  path: string;
  /** Remove the file and its directory. Idempotent, never throws. */
  release(): void;
}

/**
 * Write the agents JSON for one Claude turn into a fresh temp directory.
 *
 * Same location and mode as the turn's mcp.json (os.tmpdir(), 0600): the
 * prompts are the server's product instructions and not for other local users.
 */
export function writeClaudeAgentsFile(agents: Record<string, AgentDefinition>): AgentsFileHandle {
  const dir = mkdtempSync(join(tmpdir(), 'ai-bridge-agents-claude-'));
  const path = join(dir, 'agents.json');
  writeFileSync(path, JSON.stringify(agents), { mode: 0o600 });
  let released = false;
  return {
    path,
    release(): void {
      if (released) return;
      released = true;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort: a leftover file in /tmp is untidy, not a failed turn.
      }
    },
  };
}

/** For adapters without subagent support: say the field was ignored. */
export function logIgnoredAgents(raw: unknown, provider: string, log: Logger): void {
  if (raw === undefined || raw === null) return;
  const count = typeof raw === 'object' && !Array.isArray(raw) ? Object.keys(raw).length : 0;
  log.debug('Ignoring request agents: provider has no subagent support', { provider, count });
}
