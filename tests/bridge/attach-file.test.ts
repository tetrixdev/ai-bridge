/**
 * `bridge__attach_file` driven through the Bridge, during a real turn.
 *
 * The unit tests in tests/attachments/upload.test.ts cover the path check and
 * the HTTP call. What they cannot cover is the part that only exists here: the
 * per-request upload context, its lifetime, and whether the `attachment` event
 * actually reaches the server.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { Bridge } from '../../src/bridge.js';
import { ProviderAdapter, type AdapterStreamEvent, type ExecutionContext } from '../../src/providers/base.js';
import type { ModelInfo, WelcomeMessage } from '../../src/protocol/types.js';

/** Calls back into the test while the turn is still open. */
class DuringTurnAdapter extends ProviderAdapter {
  readonly providerName = 'fake';
  constructor(private readonly duringTurn: (requestId: string) => Promise<void>) {
    super();
  }

  async execute(context: ExecutionContext, onEvent: (e: AdapterStreamEvent) => void): Promise<string | null> {
    await this.duringTurn(context.requestId);
    onEvent({ event: 'done', data: {} });
    return 'sess-1';
  }
  listModels(): Promise<ModelInfo[]> { return Promise.resolve([]); }
}

let wss: WebSocketServer;
let api: Server;
let apiOrigin: string;
let socket: WsSocket;
let frames: Record<string, unknown>[];
let bridge: Bridge | null = null;
let root: string;
let checkout: string;
let uploads: { auth?: string }[];
let apiStatus = 200;
let apiBody: unknown = { id: 'att_new', url: '/a/att_new' };

async function waitFor(match: (f: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 4000;
  for (;;) {
    const found = frames.find(match);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(frames)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(async () => {
  frames = [];
  uploads = [];
  apiStatus = 200;
  apiBody = { id: 'att_new', url: '/a/att_new' };

  root = realpathSync(mkdtempSync(join(tmpdir(), 'attach-bridge-')));
  checkout = join(root, 'repo');
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, 'report.md'), '# the report');

  api = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      uploads.push({ auth: req.headers['authorization'] });
      res.writeHead(apiStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(apiBody));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
  apiOrigin = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.once('connection', (ws) => {
    socket = ws;
    ws.on('message', (raw) => frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
  });
});

afterEach(async () => {
  await bridge?.disconnect();
  bridge = null;
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => api.close(() => r()));
  rmSync(root, { recursive: true, force: true });
});

/** Start a bridge whose turns call `duringTurn` before finishing. */
async function runTurn(
  duringTurn: (requestId: string) => Promise<void>,
  isolation: 'workspace' | 'isolated' = 'workspace',
): Promise<string> {
  const adapter = new DuringTurnAdapter(duringTurn);
  bridge = new Bridge({
    serverUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws`,
    token: 'tok-1',
    providers: [],
    adapters: new Map([['fake', adapter as unknown as ProviderAdapter]]),
    // Never the operator's real store — the suite must not overwrite it.
    sessionStorePath: null,
    allowedRoots: [{ path: root, label: 'root' }],
    apiOrigin,
  });
  bridge.connect();
  await waitFor((f) => f['type'] === 'hello', 'hello');

  socket.send(JSON.stringify({
    type: 'welcome',
    session_id: 'conn-1',
    tools: [],
    config: { heartbeat_interval: 30, request_timeout: 30 },
    cli_isolation: isolation,
  } satisfies Partial<WelcomeMessage> as unknown as WelcomeMessage));
  await new Promise((r) => setTimeout(r, 50));

  const requestId = 'req_attach_1';
  socket.send(JSON.stringify({
    type: 'ai_request',
    request_id: requestId,
    conversation_id: 'conv-1',
    provider: 'fake',
    message: 'make me a report',
    system_prompt: null,
    options: {},
    cli_session_id: null,
    working_dir: checkout,
  }));
  await waitFor((f) => f['type'] === 'stream' && f['request_id'] === requestId && f['event'] === 'done', 'done');

  return requestId;
}

/** Invoke the bridge-owned tool the way the MCP server would. */
function attachFile(requestId: string, args: Record<string, unknown>): Promise<string> {
  return (bridge as unknown as {
    handleAttachFile(id: string, a: Record<string, unknown>): Promise<string>;
  }).handleAttachFile(requestId, args);
}

/** Invoke the tool the way a spawned CLI does — through the MCP call handler. */
function callThroughMcp(requestId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const handler = (bridge as unknown as {
    mcpServer: { handleCall: (id: string, n: string, a: Record<string, unknown>) => Promise<unknown> };
  }).mcpServer.handleCall;

  return handler(requestId, name, args);
}

describe('the dispatch gate', () => {
  it('does not answer bridge__attach_file in isolated, where it is not offered', async () => {
    // Withholding it from tools/list is not enough on its own: anything holding
    // the per-spawn bearer token could still invoke it by name. Dispatch has to
    // check the tool is actually registered.
    //
    // Not awaited: the correct outcome is that the call falls through to the
    // ordinary server-tool path and emits a `tool_call` frame, which this fake
    // server never answers — so the promise stays pending, which is itself the
    // evidence that the bridge did not handle it locally.
    await runTurn(async (id) => {
      void callThroughMcp(id, 'bridge__attach_file', { path: join(checkout, 'report.md') })
        .catch(() => undefined);
      await new Promise((r) => setTimeout(r, 100));
    }, 'isolated');

    const toolCall = frames.find(
      (f) => f['type'] === 'tool_call' && f['tool_name'] === 'bridge__attach_file',
    );
    expect(toolCall).toBeDefined();
    expect(uploads).toEqual([]);
  });

  it('answers it in workspace, where it is offered', async () => {
    let outcome = '';
    await runTurn(async (id) => {
      outcome = String(await callThroughMcp(id, 'bridge__attach_file', {
        path: join(checkout, 'report.md'),
      }));
    });

    expect(outcome).toContain('report.md');
    expect(uploads).toHaveLength(1);
  });
});

describe('the model sending a file back', () => {
  it('uploads it and announces it on the turn stream', async () => {
    let toolResult = '';
    const requestId = await runTurn(async (id) => {
      toolResult = await attachFile(id, {
        path: join(checkout, 'report.md'),
        description: 'the migration report',
      });
    });

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.auth).toBe('Bearer tok-1');
    // A sentence the model can act on, not a JSON blob about an upload.
    expect(toolResult).toContain('report.md');

    const event = await waitFor(
      (f) => f['type'] === 'stream' && f['request_id'] === requestId && f['event'] === 'attachment',
      'attachment event',
    );
    expect(event['data']).toMatchObject({ id: 'att_new', name: 'report.md' });
    expect((event['data'] as Record<string, unknown>)['description']).toBe('the migration report');
  });

  it('refuses a path outside the directories the turn may send from', async () => {
    const outside = join(root, 'private.key');
    writeFileSync(outside, 'PRIVATE');
    let error = '';

    await runTurn(async (id) => {
      await attachFile(id, { path: outside }).catch((e: Error) => { error = e.message; });
    });

    expect(error).toContain('outside the directories');
    expect(uploads).toEqual([]);
  });

  it('surfaces the server explanation rather than a bare status code', async () => {
    // A 501 means the app never registered a store. "HTTP 501" tells the model
    // nothing and invites a retry; the server's own sentence names the hook.
    apiStatus = 501;
    apiBody = { error: 'not_supported', message: 'This application does not accept files from the assistant.' };
    let error = '';

    await runTurn(async (id) => {
      await attachFile(id, { path: join(checkout, 'report.md') }).catch((e: Error) => { error = e.message; });
    });

    expect(error).toContain('501');
    expect(error).toContain('does not accept files');
  });

  it('refuses once the turn is over, so a stray CLI cannot keep uploading', async () => {
    const requestId = await runTurn(async () => undefined);

    await expect(attachFile(requestId, { path: join(checkout, 'report.md') }))
      .rejects.toThrow(/no longer active/);
    expect(uploads).toEqual([]);
  });

  it('requires a path', async () => {
    let error = '';
    await runTurn(async (id) => {
      await attachFile(id, {}).catch((e: Error) => { error = e.message; });
    });
    expect(error).toContain('path is required');
  });
});
