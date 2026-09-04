/**
 * `workspace` is a capability the OPERATOR grants, not one the server picks.
 *
 * The posture arrives on the welcome, and it is what adds `bypassPermissions`
 * / `workspace-write` / `--yolo`. None of those care whether a working
 * directory was named — so a bridge with no `--allow-dir` that simply believed
 * the field would hand a shell to any server that asked, in the scratch
 * directory, from which `cd ~/.ssh` is one command. The allow-list has to gate
 * the capability, not just the cwd.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../../src/bridge.js';
import type { ProviderAdapter } from '../../src/providers/base.js';
import type { AllowedRoot } from '../../src/workspace/allowlist.js';
import type { CliIsolation, WelcomeMessage } from '../../src/protocol/types.js';

let root: string;

/** The posture the bridge actually adopted, reading its private field. */
function adopted(bridge: Bridge): CliIsolation {
  return (bridge as unknown as { cliIsolation: CliIsolation }).cliIsolation;
}

/** Whether the bridge is offering its own tools to the CLI. */
function bridgeToolNames(bridge: Bridge): string[] {
  const server = (bridge as unknown as {
    mcpServer: { bridgeTools: { name: string }[] };
  }).mcpServer;

  return server.bridgeTools.map((t) => t.name);
}

async function welcomed(
  allowedRoots: AllowedRoot[],
  isolation?: string,
  allowNative = false,
): Promise<Bridge> {
  const bridge = new Bridge({
    serverUrl: 'wss://example.test/ws',
    token: 'tok',
    providers: [],
    adapters: new Map<string, ProviderAdapter>(),
    allowedRoots,
    allowNative,
  });

  const welcome = {
    type: 'welcome',
    session_id: 'conn-1',
    tools: [],
    config: { heartbeat_interval: 30, request_timeout: 30 },
    ...(isolation !== undefined ? { cli_isolation: isolation } : {}),
  } as unknown as WelcomeMessage;

  await (bridge as unknown as {
    handleWelcome(m: WelcomeMessage): Promise<void>;
  }).handleWelcome(welcome);

  return bridge;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'gate-')));
  mkdirSync(join(root, 'repo'), { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('adopting the server posture', () => {
  it('runs isolated when the server sends nothing', async () => {
    expect(adopted(await welcomed([]))).toBe('isolated');
  });

  it('accepts workspace when the operator allowed a directory', async () => {
    const bridge = await welcomed([{ path: root, label: 'root' }], 'workspace');
    expect(adopted(bridge)).toBe('workspace');
  });

  it('REFUSES workspace when the operator allowed nothing', async () => {
    // The whole security claim: a bridge started without --allow-dir cannot be
    // given a shell by a server, only a directory it will then refuse.
    const bridge = await welcomed([], 'workspace');
    expect(adopted(bridge)).toBe('isolated');
  });

  it('REFUSES native unless the operator passed --allow-native', async () => {
    // `native` is strictly MORE permissive than `workspace` — the bypass flags
    // plus the operator's own MCP servers, hooks and plugins. Gating only
    // `workspace` would have been theatre: a server denied the shell one way
    // could ask for it the other way and get more.
    expect(adopted(await welcomed([], 'native'))).toBe('isolated');
    expect(adopted(await welcomed([{ path: root, label: 'root' }], 'native'))).toBe('isolated');
  });

  it('accepts native once the operator opted in', async () => {
    expect(adopted(await welcomed([], 'native', true))).toBe('native');
  });

  it('does not let --allow-native imply a workspace allow-list', async () => {
    // The two opt-ins are separate: permitting `native` says nothing about
    // which directories a server may name.
    expect(adopted(await welcomed([], 'workspace', true))).toBe('isolated');
  });

  it('falls back to isolated for an unrecognised posture', async () => {
    // Every adapter tests this value with `!== 'isolated'` or `!== 'native'`,
    // so an unknown string would land in the permissive branch on one provider
    // and the restrictive branch on another.
    for (const bogus of ['Isolated', 'workspac', 'isolated ', 'WORKSPACE', '']) {
      const bridge = await welcomed([{ path: root, label: 'root' }], bogus);
      expect(adopted(bridge)).toBe('isolated');
    }
  });
});

describe('the bridge-owned tool set', () => {
  it('offers nothing extra in isolated, which means server-declared tools only', async () => {
    const bridge = await welcomed([{ path: root, label: 'root' }], 'isolated');
    expect(bridgeToolNames(bridge)).toEqual([]);
  });

  it('offers bridge__attach_file in workspace', async () => {
    const bridge = await welcomed([{ path: root, label: 'root' }], 'workspace');
    expect(bridgeToolNames(bridge)).toEqual(['bridge__attach_file']);
  });

  it('offers nothing extra when workspace was refused for want of an allow-list', async () => {
    // The posture was downgraded, so the tool set must follow it.
    const bridge = await welcomed([], 'workspace');
    expect(bridgeToolNames(bridge)).toEqual([]);
  });
});
