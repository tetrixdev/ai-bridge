/**
 * Per-turn isolation (`ai_request.cli_isolation: "isolated"`), driven over a
 * real WebSocket against the real Claude adapter, with only its spawn
 * intercepted: what matters is the argv the CLI would have been launched
 * with. A server that adopted `workspace` (shell and file tools) narrows one
 * turn to its own tools: that turn must launch with only the bridge MCP
 * namespace allowed and the permission mode that denies everything else, so
 * Bash, Read, Write and WebFetch are refused by the CLI itself.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Bridge, turnPosture } from '../../src/bridge.js';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import { ProviderAdapter, type AdapterStreamEvent, type ExecutionContext } from '../../src/providers/base.js';
import type { ModelInfo } from '../../src/protocol/types.js';

/** The real Claude adapter, launching a no-op process instead of claude. */
class ClaudeProbe extends ClaudeAdapter {
  readonly launches: string[][] = [];
  protected override spawnCli(
    _command: string, args: string[], env: NodeJS.ProcessEnv, stdinInput?: string, cwd?: string,
  ): ChildProcessByStdio<Writable | null, Readable, Readable> {
    this.launches.push(args);
    return spawn(process.execPath, ['-e', ''], {
      env, cwd, stdio: [stdinInput !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
  }
}

/** A provider that cannot be held to server tools (as Codex and Gemini cannot). */
class OtherAdapter extends ProviderAdapter {
  readonly providerName = 'codex';
  readonly seen: ExecutionContext[] = [];
  execute(context: ExecutionContext, onEvent: (e: AdapterStreamEvent) => void): Promise<string | null> {
    this.seen.push(context);
    onEvent({ event: 'done', data: {} });
    return Promise.resolve(null);
  }
  listModels(): Promise<ModelInfo[]> { return Promise.resolve([]); }
}

let wss: WebSocketServer;
let url: string;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;
let root: string;
let claude: ClaudeProbe;
let other: OtherAdapter;

async function waitFor(match: (f: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; saw: ${JSON.stringify(frames).slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const events = (id: string) => frames
  .filter((f) => f['type'] === 'stream' && f['request_id'] === id)
  .map((f) => ({ event: f['event'] as string, data: f['data'] as Record<string, unknown> }));

async function finished(id: string): Promise<{ event: string; data: Record<string, unknown> }[]> {
  await waitFor((f) => f['type'] === 'stream' && f['request_id'] === id && f['event'] === 'done', `done for ${id}`);
  return events(id);
}

function sendRequest(overrides: Record<string, unknown>): string {
  const requestId = `req_${Math.random().toString(36).slice(2, 8)}`;
  socket.send(JSON.stringify({
    type: 'ai_request', request_id: requestId, conversation_id: 'conv-1', provider: 'claude',
    message: 'hello', system_prompt: 'be useful', options: {}, cli_session_id: null, ...overrides,
  }));
  return requestId;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'turn-iso-')));
  mkdirSync(join(root, 'repo'), { recursive: true });
  frames = [];
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`;
  wss.once('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => { frames.push(JSON.parse(raw.toString()) as Record<string, unknown>); });
  });
  claude = new ClaudeProbe();
  other = new OtherAdapter();
  bridge = new Bridge({
    serverUrl: url, token: 'tok', sessionStorePath: null,
    providers: [
      { name: 'claude', version: '1', available: true, supports_streaming: true, supports_tools: true, supports_thinking: true, supports_session_resume: true },
      { name: 'codex', version: '1', available: true, supports_streaming: true, supports_tools: true, supports_thinking: false, supports_session_resume: true },
    ],
    adapters: new Map<string, ProviderAdapter>([['claude', claude], ['codex', other]]),
    allowedRoots: [{ path: root, label: 'root' }],
  });
  bridge.connect();
  await waitFor((f) => f['type'] === 'hello', 'hello');
  // The posture Engram asks for: shell and file tools in a checkout.
  socket.send(JSON.stringify({
    type: 'welcome', session_id: 'conn-1',
    tools: [{ name: 'memory_query', description: 'Ask memory', parameters: { type: 'object', properties: {} } }],
    config: { heartbeat_interval: 30, request_timeout: 30 },
    cli_isolation: 'workspace',
  }));
  await waitFor((f) => f['type'] === 'posture', 'posture');
});

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

const flag = (args: string[], name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

describe('per-turn isolation', () => {
  it('says it can in hello', () => {
    const hello = frames.find((f) => f['type'] === 'hello')!;
    expect(hello['turn_isolation']).toBe(1);
  });

  it('launches an ordinary turn of a workspace connection with every tool', async () => {
    const id = sendRequest({ working_dir: join(root, 'repo') });
    await finished(id);
    const args = claude.launches.at(-1)!;
    expect(flag(args, '--permission-mode')).toBe('bypassPermissions');
    expect(args).not.toContain('--allowedTools');
  });

  it('holds a narrowed turn to the server tools: Bash and every other built-in are denied', async () => {
    const id = sendRequest({ cli_isolation: 'isolated' });
    const out = await finished(id);
    // The stand-in CLI says nothing, so the turn ends empty; it was launched, not refused.
    expect(String(out.find((e) => e.event === 'error')?.data['code'] ?? '')).not.toMatch(/^isolation_/);
    const args = claude.launches.at(-1)!;
    expect(flag(args, '--allowedTools')).toBe('mcp__bridge__*');
    expect(flag(args, '--permission-mode')).toBe('manual');
    expect(args).not.toContain('bypassPermissions');
    expect(args.filter((a) => a === '--allowedTools')).toHaveLength(1);
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).toContain('--strict-mcp-config');
  });

  it('refuses to widen: a request can only ask for isolated', async () => {
    const id = sendRequest({ cli_isolation: 'native' });
    const out = await finished(id);
    expect(out.find((e) => e.event === 'error')?.data['code']).toBe('isolation_not_narrowing');
    expect(claude.launches).toHaveLength(0);
  });

  it('refuses a narrowed turn on a provider that cannot be held to it, rather than running it', async () => {
    const id = sendRequest({ cli_isolation: 'isolated', provider: 'codex' });
    const out = await finished(id);
    expect(out.find((e) => e.event === 'error')?.data['code']).toBe('isolation_unsupported');
    expect(other.seen).toHaveLength(0);
  });

  it('refuses a narrowed turn that names a working folder', async () => {
    const id = sendRequest({ cli_isolation: 'isolated', working_dir: join(root, 'repo') });
    const out = await finished(id);
    expect(out.find((e) => e.event === 'error')?.data['code']).toBe('isolation_conflict');
    expect(claude.launches).toHaveLength(0);
  });
});

describe('turnPosture', () => {
  const claudeLike = { enforcesServerToolsOnly: true, providerName: 'claude' }
  it('keeps the connection posture when the request says nothing', () => {
    expect(turnPosture('native', { provider: 'claude' }, claudeLike)).toEqual({ isolation: 'native', refusal: null });
  });
  it('narrows native and workspace alike', () => {
    expect(turnPosture('native', { provider: 'claude', cli_isolation: 'isolated' }, claudeLike).isolation).toBe('isolated');
    expect(turnPosture('workspace', { provider: 'claude', cli_isolation: 'isolated' }, claudeLike).isolation).toBe('isolated');
  });
});
