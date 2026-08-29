/**
 * The DungeonMeister posture, asserted at the level that decides it.
 *
 * The gate tests prove the function is right. This proves the Bridge actually
 * defaults to it, because the failure mode worth guarding is not a wrong gate,
 * it is a correct gate that a later refactor stops consulting.
 */

import { describe, expect, it } from 'vitest';
import { Bridge } from '../../src/bridge.js';
import type { ProviderAdapter } from '../../src/providers/base.js';

const bare = () =>
  new Bridge({
    serverUrl: 'wss://example.test/bridge',
    token: 'irrelevant',
    providers: [],
    adapters: new Map<string, ProviderAdapter>(),
  });

describe('a bridge that was never told about local tools', () => {
  it('is off, so a server marking a tool local changes nothing', () => {
    const config = (bare() as unknown as { localExecution: { enabled: boolean } }).localExecution;
    expect(config.enabled).toBe(false);
  });

  it('has nowhere to fetch secrets from, so none can be resolved', () => {
    const b = bare() as unknown as { engram?: unknown; identity?: unknown };
    expect(b.engram).toBeUndefined();
    expect(b.identity).toBeUndefined();
  });
});
