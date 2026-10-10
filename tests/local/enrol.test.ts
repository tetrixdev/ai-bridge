/**
 * Enrolling with Engram: what the bridge sends, and what it believes back.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrol } from '../../src/local/engram.js';
import { fingerprint, loadOrCreateIdentity } from '../../src/local/identity.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

afterEach(() => vi.unstubAllGlobals());

describe('enrol', () => {
  it('sends the hostname and reports the name Engram shows the device under', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'engram-enrol-'));
    try {
      const identity = await loadOrCreateIdentity(join(dir, 'device.json'));
      let sent: Record<string, unknown> = {};
      vi.stubGlobal('fetch', vi.fn(async (_url: URL, init: RequestInit) => {
        sent = JSON.parse(String(init.body));
        // A machine paired for chat keeps its own name: Engram answers with it.
        return new Response(JSON.stringify({
          device: { id: 'paired-id', fingerprint: await fingerprint(identity.publicKey), label: 'TETRIXDEV-DEV01' },
        }), { status: 200 });
      }));
      const result = await enrol({ baseUrl: 'https://engram.test', token: 't' }, identity, 'devbox', 'transcript', 'devbox');
      expect(sent).toMatchObject({ label: 'devbox', hostname: 'devbox', mode: 'transcript', publicKey: identity.publicKey });
      expect(result).toMatchObject({ deviceId: 'paired-id', label: 'TETRIXDEV-DEV01' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
