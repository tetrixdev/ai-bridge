/**
 * MCP Apps through the whole Bridge: the handshake, a server tool's `_meta`
 * reaching the CLI, the CLI's own call id forwarded on `tool_call`, upstream
 * tools offered to the CLI, `tool_result.ui` on the call's first result, and
 * `mcp_request` / `mcp_result` for a view.
 *
 * The fake adapter plays the CLI with a real MCP client against the bridge's
 * own MCP server, the way Claude Code does (bearer token, `_meta` toolUseId).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Bridge } from '../../src/bridge.js';
import { ProviderAdapter, type AdapterStreamEvent, type ExecutionContext } from '../../src/providers/base.js';
import type { ModelInfo, WelcomeMessage } from '../../src/protocol/types.js';
import { MCP_APPS_BRIDGE_REVISION, MCP_APPS_SPEC, type UpstreamConfig } from '../../src/mcp/upstream.js';
import { VIEW_URI, VIEW_UI } from '../mcp/fixtures/upstream-server.mjs';

const FIXTURE = fileURLToPath(new URL('../mcp/fixtures/upstream-server.mjs', import.meta.url));

type Cli = (client: Client, onEvent: (e: AdapterStreamEvent) => void) => Promise<void>;

/** Plays the CLI: connects to the bridge's MCP server and runs `cli`. */
class CliAdapter extends ProviderAdapter {
  readonly providerName = 'fake';
  constructor(private readonly cli: Cli) { super(); }
  async execute(context: ExecutionContext, onEvent: (e: AdapterStreamEvent) => void): Promise<string | null> {
    if (!context.mcp) throw new Error('no MCP channel for the turn');
    const client = new Client({ name: 'fake-cli', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(context.mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${context.mcp.bearerToken}` } },
    }));
    try {
      await this.cli(client, onEvent);
    } finally {
      await client.close();
    }
    onEvent({ event: 'done', data: {} });
    return 'sess-1';
  }
  listModels(): Promise<ModelInfo[]> { return Promise.resolve([]); }
}

let wss: WebSocketServer;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;

async function waitFor(match: (f: Record<string, unknown>) => boolean, what: string, ms = 8000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(frames).slice(0, 2000)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  frames = [];
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(f);
      // Answer server-tool calls like a server would.
      if (f['type'] === 'tool_call') {
        ws.send(JSON.stringify({ type: 'tool_resolve', request_id: f['request_id'], tool_call_id: f['tool_call_id'], result: 'server says hi' }));
      }
    });
  });
});

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  await new Promise<void>((r) => wss.close(() => r()));
});

async function start(cli: Cli, upstreams?: Record<string, UpstreamConfig>): Promise<void> {
  bridge = new Bridge({
    serverUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`,
    token: 'tok-1',
    providers: [],
    adapters: new Map([['fake', new CliAdapter(cli) as unknown as ProviderAdapter]]),
    sessionStorePath: null,
    // workspace isolation is only adopted with a folder to work in.
    allowedRoots: [{ path: tmpdir(), label: 'tmp' }],
    ...(upstreams ? { mcpUpstreams: upstreams } : {}),
  });
  bridge.connect();
  await waitFor((f) => f['type'] === 'hello', 'hello');
  socket.send(JSON.stringify({
    type: 'welcome',
    session_id: 'conn-1',
    tools: [{
      name: 'approve', description: 'Ask the person', parameters: { type: 'object', properties: {} },
      _meta: { ui: { resourceUri: 'ui://engram/approval' }, 'engram/x': 1 },
    }],
    config: { heartbeat_interval: 30, request_timeout: 30 },
    // Upstream tools, like bridge__attach_file, are the machine's own and are
    // withheld from an isolated CLI.
    cli_isolation: 'workspace',
  } satisfies Partial<WelcomeMessage> as unknown as WelcomeMessage));
  await waitFor((f) => f['type'] === 'posture', 'posture');
}

async function turn(id = 'req_1'): Promise<void> {
  socket.send(JSON.stringify({
    type: 'ai_request', request_id: id, conversation_id: 'conv-1', provider: 'fake',
    message: 'go', system_prompt: null, options: {}, cli_session_id: null,
  }));
  await waitFor((f) => f['type'] === 'stream' && f['request_id'] === id && (f['event'] === 'done' || f['event'] === 'error'), 'end of turn', 15000);
}

async function upstreamUp(name = 'fx'): Promise<void> {
  const hub = (bridge as unknown as { upstream: { status(): Record<string, { connected: boolean }> } }).upstream;
  const deadline = Date.now() + 8000;
  while (!hub.status()[name]?.connected) {
    if (Date.now() > deadline) throw new Error('upstream did not connect');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const fx: Record<string, UpstreamConfig> = { fx: { command: process.execPath, args: [FIXTURE, '--stdio'] } };

describe('handshake', () => {
  it('hello carries mcp_apps with the spec and the bridge revision', async () => {
    await start(async () => {});
    const hello = frames.find((f) => f['type'] === 'hello')!;
    expect(hello['mcp_apps']).toEqual({ spec: MCP_APPS_SPEC, revision: MCP_APPS_BRIDGE_REVISION });
    expect(MCP_APPS_SPEC).toBe('2026-01-26');
  });
});

describe('server tools', () => {
  it('pass the definition _meta to the CLI and forward its toolUseId as provider_tool_call_id', async () => {
    let listed: Record<string, unknown>[] = [];
    let answer: unknown;
    await start(async (client) => {
      listed = (await client.listTools()).tools as unknown as Record<string, unknown>[];
      answer = await client.callTool({ name: 'approve', arguments: {}, _meta: { 'claudecode/toolUseId': 'toolu_abc' } });
    });
    await turn();
    expect(listed.find((t) => t['name'] === 'approve')!['_meta']).toEqual({ ui: { resourceUri: 'ui://engram/approval' }, 'engram/x': 1 });
    const call = frames.find((f) => f['type'] === 'tool_call')!;
    expect(call).toMatchObject({ tool_name: 'approve', provider_tool_call_id: 'toolu_abc' });
    expect(answer).toMatchObject({ content: [{ type: 'text', text: 'server says hi' }] });
  });

  it('leave provider_tool_call_id out when the CLI sends no id', async () => {
    await start(async (client) => { await client.callTool({ name: 'approve', arguments: {} }); });
    await turn();
    expect(frames.find((f) => f['type'] === 'tool_call')).not.toHaveProperty('provider_tool_call_id');
  });
});

describe('upstream tools', () => {
  it('are offered to the CLI (not app-only ones), run on the bridge, and their view rides the first tool_result', async () => {
    let names: string[] = [];
    let text = '';
    await start(async () => {}, fx);
    await upstreamUp();
    (bridge as unknown as { adapters: Map<string, CliAdapter> }).adapters.set('fake', new CliAdapter(async (client, onEvent) => {
      names = (await client.listTools()).tools.map((t) => t.name);
      const r = await client.callTool({ name: 'fx__show', arguments: { x: 3 }, _meta: { 'claudecode/toolUseId': 'toolu_v' } }) as { content: { text: string }[] };
      text = r.content[0]!.text;
      // The CLI's stream then reports the result, in chunks.
      onEvent({ event: 'tool_result', data: { tool_call_id: 'toolu_v', content: 'shown 3' } as never });
      onEvent({ event: 'tool_result', data: { tool_call_id: 'toolu_v', content: 'more' } as never });
    }));
    await turn();

    expect(names).toContain('fx__show');
    expect(names).toContain('approve');
    expect(names).not.toContain('fx__app_only');
    expect(text).toBe('shown 3');
    // Run on the bridge, never relayed to the server as tool_call.
    expect(frames.some((f) => f['type'] === 'tool_call')).toBe(false);

    const results = frames.filter((f) => f['type'] === 'stream' && f['event'] === 'tool_result');
    expect(results).toHaveLength(2);
    expect((results[0]!['data'] as Record<string, unknown>)['ui']).toEqual({
      server: 'fx', tool_name: 'show', resource_uri: VIEW_URI, arguments: { x: 3 },
      result: { content: [{ type: 'text', text: 'shown 3' }], structuredContent: { x: 3 }, _meta: { 'fx/secretish': 'host only' } },
    });
    expect(results[1]!['data']).not.toHaveProperty('ui');
  });
});

describe('mcp_request', () => {
  async function ask(id: string, server: string, method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    socket.send(JSON.stringify({ type: 'mcp_request', id, server, method, params }));
    return waitFor((f) => f['type'] === 'mcp_result' && f['id'] === id, `mcp_result ${id}`);
  }

  it('reads a view with its csp and permissions unchanged, and calls an app tool', async () => {
    await start(async () => {}, fx);
    await upstreamUp();
    const read = await ask('m1', 'fx', 'resources/read', { uri: VIEW_URI });
    expect(read).not.toHaveProperty('error');
    expect((read['result'] as { contents: Record<string, unknown>[] }).contents[0]!['_meta']).toEqual({ ui: VIEW_UI });
    const call = await ask('m2', 'fx', 'tools/call', { name: 'app_only', arguments: {} });
    expect(call['result']).toMatchObject({ content: [{ text: 'app ok' }] });
  });

  it('answers refusals and unknown servers with an error and a code', async () => {
    await start(async () => {}, fx);
    await upstreamUp();
    expect(await ask('r1', 'fx', 'tools/call', { name: 'model_only' })).toMatchObject({ code: 'refused', error: expect.stringMatching(/not callable from a view/) });
    expect(await ask('r2', 'fx', 'resources/read', { uri: 'https://example.com/' })).toMatchObject({ code: 'refused' });
    expect(await ask('r3', 'nope', 'resources/read', { uri: VIEW_URI })).toMatchObject({ code: 'unknown_server' });
    expect(await ask('r4', 'fx', 'sampling/createMessage', {})).toMatchObject({ code: 'unsupported' });
  });

  it('answers unknown_server on a bridge with no upstreams', async () => {
    await start(async () => {});
    expect(await ask('n1', 'fx', 'resources/read', { uri: VIEW_URI })).toMatchObject({ code: 'unknown_server' });
  });

  it('stops upstream servers when the bridge disconnects', async () => {
    await start(async () => {}, fx);
    await upstreamUp();
    const hub = (bridge as unknown as { upstream: { status(): Record<string, { connected: boolean }> } }).upstream;
    await bridge!.disconnect();
    expect(hub.status()['fx']!.connected).toBe(false);
  });
});

describe('upstream secrets', () => {
  type Resolve = (ref: unknown) => Promise<string>;
  const resolverOf = (b: Bridge): Resolve => (ref) => (b as unknown as { resolveUpstreamSecret: Resolve }).resolveUpstreamSecret(ref);

  it('resolve {"env"} from the bridge environment, with the prefix', async () => {
    process.env['AIB_UPSTREAM_T'] = 'abc';
    const b = new Bridge({ serverUrl: 'ws://127.0.0.1:1/ws', token: 't', providers: [], adapters: new Map(), sessionStorePath: null });
    await expect(resolverOf(b)({ env: 'AIB_UPSTREAM_T', prefix: 'Bearer ' })).resolves.toBe('Bearer abc');
    await expect(resolverOf(b)({ env: 'AIB_UPSTREAM_UNSET_T' })).rejects.toThrow(/is not set/);
    delete process.env['AIB_UPSTREAM_T'];
  });

  it('refuse {"vault"} on a bridge not enrolled with Engram', async () => {
    const b = new Bridge({ serverUrl: 'ws://127.0.0.1:1/ws', token: 't', providers: [], adapters: new Map(), sessionStorePath: null });
    await expect(resolverOf(b)({ vault: { space_id: 's', secret_id: 'v' } })).rejects.toThrow(/enrolled with Engram/);
  });

  it('resolve {"vault"} through the device\'s sealed values, only in the space named', async () => {
    const { SecretStore } = await import('../../src/local/engram.js');
    const store = new SecretStore();
    store.add({ id: 'v1', spaceId: 's1', itemId: 'i1', field: 'token', value: 'sealed-value' });
    const b = new Bridge({ serverUrl: 'ws://127.0.0.1:1/ws', token: 't', providers: [], adapters: new Map(), sessionStorePath: null });
    Object.assign(b as unknown as Record<string, unknown>, {
      engram: { baseUrl: 'http://x', token: 'y' },
      identity: { deviceId: 'd1' },
      secretsFor: async () => store,
    });
    await expect(resolverOf(b)({ vault: { space_id: 's1', secret_id: 'v1' }, prefix: 'Bearer ' })).resolves.toBe('Bearer sealed-value');
    await expect(resolverOf(b)({ vault: { space_id: 's2', secret_id: 'v1' } })).rejects.toThrow(/holds no sealed value/);
  });
});
