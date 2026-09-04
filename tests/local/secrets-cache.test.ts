/**
 * How long the bridge trusts the secrets it fetched.
 *
 * Asserted at the Bridge, because the failure is not in loadSecrets: it is in
 * WHEN the Bridge decides not to call it. A cache that is never refreshed makes
 * the first local tool call, which may happen before anyone approved the
 * device, decide what this bridge can do for the rest of its life.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/local/engram.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/local/engram.js')>();
  return { ...actual, loadSecrets: vi.fn() };
});

import { Bridge } from '../../src/bridge.js';
import { loadSecrets } from '../../src/local/engram.js';
import type { ProviderAdapter } from '../../src/providers/base.js';
import { SecretStore } from '../../src/local/engram.js';
import type { ToolDefinition } from '../../src/protocol/types.js';

const fetched = vi.mocked(loadSecrets);

/** Prints the LENGTH of the secret, so a rotation is visible without printing it. */
const tool: ToolDefinition = {
  name: 'deploy', description: '', parameters: {}, execute: 'local',
  space_id: 'space_1',
  secrets: ['api-key'],
  run: { command: 'sh', args: ['-c', 'printf %s "${#API_KEY}"'] },
};

const held = (value: string): SecretStore => {
  const store = new SecretStore();
  store.add({ id: 'sec_1', spaceId: 'space_1', name: 'api-key', value });
  return store;
};

const enrolled = () =>
  new Bridge({
    serverUrl: 'wss://example.test/bridge',
    token: 'irrelevant',
    providers: [],
    adapters: new Map<string, ProviderAdapter>(),
    // Never the operator's real store — the suite must not overwrite it.
    sessionStorePath: null,
    localExecution: { enabled: true },
    engram: { baseUrl: 'https://engram.test', token: 'irrelevant' },
    identity: { publicKey: 'pk', privateKey: {} as never, deviceId: 'dev_1' },
  });

const run = (bridge: Bridge, definition: ToolDefinition = tool) =>
  (bridge as unknown as {
    runToolHere(t: ToolDefinition, a: Record<string, unknown>): Promise<{ stdout: string }>;
  }).runToolHere(definition, {});

beforeEach(() => fetched.mockReset());
afterEach(() => vi.useRealTimers());

describe('secrets the bridge fetched once', () => {
  it('picks up an approval that happened after the first tool call', async () => {
    // The case the old comment promised and the code could not do. A local tool
    // called before the device was approved cached an empty map, and no
    // approval afterwards was ever seen: the operator approves in the browser,
    // watches the same tool keep failing, and only a restart fixes it.
    const bridge = enrolled();
    fetched.mockResolvedValueOnce(new SecretStore());
    await expect(run(bridge)).rejects.toThrow(/does not hold a secret named/);

    fetched.mockResolvedValueOnce(held('granted-value'));
    expect((await run(bridge)).stdout).toBe('13');
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it('stops serving a rotated or revoked value once the TTL is past', async () => {
    // Without a TTL a bridge that has been running for a week is still handing
    // tools the credential it fetched a week ago, after a rotation and after
    // the device was revoked in the vault.
    vi.useFakeTimers({ toFake: ['Date'] });
    const bridge = enrolled();

    fetched.mockResolvedValueOnce(held('old-value-1'));
    expect((await run(bridge)).stdout).toBe('11');

    vi.setSystemTime(Date.now() + 61_000);
    fetched.mockResolvedValueOnce(held('rotated-value-22'));
    expect((await run(bridge)).stdout).toBe('16');
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it('does not ask Engram again for every call inside the TTL', async () => {
    // The reason there is a TTL rather than a fetch per call: a tool with a
    // perfectly good credential in hand must not start failing because Engram
    // is briefly unreachable.
    const bridge = enrolled();
    fetched.mockResolvedValue(held('granted-value'));

    await run(bridge);
    await run(bridge);
    expect(fetched).toHaveBeenCalledTimes(1);
  });

  it('never asks at all for a tool that declared no secrets', async () => {
    // A bridge whose local tools need no credential should never make Engram
    // hand one out, and should not fail a tool call when Engram is down.
    const bridge = enrolled();
    const noSecrets: ToolDefinition = {
      name: 'ping', description: '', parameters: {}, execute: 'local', space_id: 'space_1',
      run: { command: 'sh', args: ['-c', 'printf ok'] },
    };

    expect((await run(bridge, noSecrets)).stdout).toBe('ok');
    expect(fetched).not.toHaveBeenCalled();
  });
});
