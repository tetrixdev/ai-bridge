/**
 * The local_call frame, asserted at the Bridge that routes it.
 *
 * The gate and the runner have their own tests. This is about the wiring: that
 * a `local_call` arriving on the WebSocket reaches the one gated path, and
 * that whatever happens, a `local_result` carrying the same id goes back. A
 * correct gate that a later refactor stops consulting is the failure worth
 * guarding here, and it is invisible to every test below this level.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '../../src/bridge.js';
import type { ProviderAdapter } from '../../src/providers/base.js';
import type { BridgeToServerMessage, LocalCallMessage, LocalResultMessage } from '../../src/protocol/types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function toolDir(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-bridge-call-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'tool.js'), body);
  return dir;
}

/**
 * A bridge with its socket replaced by a list.
 *
 * `onMessage` is what the WebSocket calls, so driving it directly exercises
 * the real dispatch rather than a copy of it.
 */
function harness(localExecution?: { enabled: boolean; workdir?: string }) {
  const bridge = new Bridge({
    serverUrl: 'wss://example.test/bridge',
    token: 'irrelevant',
    providers: [],
    adapters: new Map<string, ProviderAdapter>(),
    ...(localExecution ? { localExecution } : {}),
  });

  const sent: BridgeToServerMessage[] = [];
  const inner = bridge as unknown as {
    send(m: BridgeToServerMessage): void;
    onMessage(data: Buffer): void;
  };
  inner.send = (m) => { sent.push(m); };

  return {
    sent,
    deliver: (message: LocalCallMessage) => inner.onMessage(Buffer.from(JSON.stringify(message))),
    answer: async (): Promise<LocalResultMessage> => {
      await vi.waitFor(() => expect(sent).toHaveLength(1), { timeout: 15_000 });
      return sent[0] as LocalResultMessage;
    },
  };
}

describe('a local_call arriving on a bridge that never enabled local execution', () => {
  it('is refused, and the refusal goes back rather than nothing going back', async () => {
    // The default posture: a server can send this frame all day and nothing
    // runs. A silent drop would leave the server waiting on an id forever, so
    // the refusal is a frame, not a log line.
    const dir = toolDir(`require('fs').writeFileSync(__dirname + '/ran', 'x');`);
    const h = harness();

    h.deliver({
      type: 'local_call',
      id: 'call_9',
      space_id: 'space_1',
      tool: { name: 'deploy', command: process.execPath, args: [join(dir, 'tool.js')] },
      input: {},
    });

    const result = await h.answer();
    expect(result.type).toBe('local_result');
    expect(result.id).toBe('call_9');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not started with local execution enabled/);
    expect(() => rmSync(join(dir, 'ran'))).toThrow();
  }, 20_000);
});

describe('a local_call on a bridge whose operator turned local execution on', () => {
  it('runs the tool and answers with the document it wrote', async () => {
    const dir = toolDir(`
      let raw = '';
      process.stdin.on('data', (c) => { raw += c; });
      process.stdin.on('end', () => {
        console.log(JSON.stringify({ echoed: JSON.parse(raw || '{}') }));
      });
    `);
    const h = harness({ enabled: true, workdir: dir });

    h.deliver({
      type: 'local_call',
      id: 'call_10',
      space_id: 'space_1',
      tool: { name: 'echo', command: process.execPath, args: [join(dir, 'tool.js')] },
      input: { since: '2026-08-01' },
    });

    const result = await h.answer();
    expect(result.id).toBe('call_10');
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ echoed: { since: '2026-08-01' } });
    expect(result.sandbox?.filesystem).toBe('node-permissions');
  }, 20_000);

  it('cannot resolve a secret at all with no vault configured, and says so', async () => {
    // Local execution on, Engram absent. The tool must not run with an empty
    // variable where a credential belongs.
    const dir = toolDir(`console.log(JSON.stringify({ ok: true }));`);
    const h = harness({ enabled: true, workdir: dir });

    h.deliver({
      type: 'local_call',
      id: 'call_11',
      space_id: 'space_1',
      tool: { name: 'needs-a-secret', command: process.execPath, args: [join(dir, 'tool.js')] },
      fill: [{ role: 'mailbox', secret_id: 'sec_1' }],
      input: {},
    });

    const result = await h.answer();
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be filled/);
  }, 20_000);
});
