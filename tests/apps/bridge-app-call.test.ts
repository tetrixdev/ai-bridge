/**
 * The app_call frame, asserted at the Bridge that routes it: it reaches the
 * supervisor behind the --local-tools gate, and an app_result with the same id
 * always goes back. The supervisor itself is tests/apps/supervisor.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { Bridge } from '../../src/bridge.js';
import type { ProviderAdapter } from '../../src/providers/base.js';
import type { AppCallMessage, AppResultMessage, BridgeToServerMessage } from '../../src/protocol/types.js';

describe('an app_call arriving on a bridge that never enabled local execution', () => {
  it('is refused with a frame, not dropped', async () => {
    const bridge = new Bridge({
      serverUrl: 'wss://example.test/bridge', token: 'irrelevant', providers: [],
      adapters: new Map<string, ProviderAdapter>(), sessionStorePath: null,
    });
    const sent: BridgeToServerMessage[] = [];
    const inner = bridge as unknown as { send(m: BridgeToServerMessage): void; onMessage(d: Buffer): void };
    inner.send = (m) => { sent.push(m); };
    const call: AppCallMessage = {
      type: 'app_call', id: 'app_1',
      app: { space_id: 's', name: 'todo', version: 1, hash: 'a'.repeat(64) },
      files: { base: 'https://example.test/app-blobs/t/', tree: { 'server.js': 'b'.repeat(64) } },
      backend: { main: 'server.js' },
      request: { method: 'GET', path: '/items' },
      engram: { api: 'https://example.test/app-api', token: 't' },
    };
    inner.onMessage(Buffer.from(JSON.stringify(call)));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const result = sent[0] as AppResultMessage;
    expect(result).toMatchObject({ type: 'app_result', id: 'app_1', ok: false });
    expect(result.error).toMatch(/not started with local execution enabled/);
  });
});
