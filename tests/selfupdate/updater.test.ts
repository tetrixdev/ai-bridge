/**
 * Following the server's desired version: when to act, waiting for idle, a
 * fetch that fails, the opt-out, and the loop protection. Timers are driven by
 * hand, so nothing here sleeps.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ATTEMPT_BACKOFF_MS, FETCH_RETRY_MS, IDLE_POLL_MS, SelfUpdater, type UpdaterDeps } from '../../src/selfupdate/updater.js';

const MANAGED = { managed: { kind: 'systemd' as const, scope: 'user' as const, unit: 'b.service', envFile: '/x/b.env' } };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function harness(over: Partial<UpdaterDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'selfupdate-'));
  dirs.push(dir);
  let now = 1_000_000;
  const timers: Array<{ fn: () => void; at: number; id: number }> = [];
  let nextId = 1;
  const logs: string[] = [];
  const calls = { prefetch: [] as string[], pin: [] as Array<[string, string]>, restart: [] as string[] };
  let idle = true;
  let fetchOk = true;
  const deps: UpdaterDeps = {
    currentVersion: '0.24.0',
    optedOut: false,
    detection: MANAGED,
    prefetch: async (v) => { calls.prefetch.push(v); return fetchOk ? { ok: true } : { ok: false, reason: 'E404' }; },
    isIdle: () => idle,
    pin: (v, prev) => { calls.pin.push([v, prev]); },
    restart: (v) => { calls.restart.push(v); },
    statePath: join(dir, 'state.json'),
    log: { info: (m) => logs.push(`info ${m}`), warn: (m) => logs.push(`warn ${m}`), error: (m) => logs.push(`error ${m}`) },
    now: () => now,
    setTimer: (fn, ms) => { const id = nextId++; timers.push({ fn, at: now + ms, id }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    ...over,
  };
  const updater = new SelfUpdater(deps);
  const flush = () => new Promise((r) => setImmediate(r));
  /** Move the clock on, firing every timer that falls due, in order. */
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > until) break;
      timers.shift();
      now = t.at;
      t.fn();
      await flush();
    }
    now = until;
  };
  return {
    updater, calls, logs, timers, deps, flush, advance,
    setIdle: (v: boolean) => { idle = v; },
    setFetchOk: (v: boolean) => { fetchOk = v; },
    state: () => { try { return JSON.parse(readFileSync(deps.statePath, 'utf8')); } catch { return null; } },
    writeState: (s: unknown) => writeFileSync(deps.statePath, JSON.stringify(s)),
    now: () => now,
  };
}

describe('when to act', () => {
  it('does nothing when the server wants the version already running, or says nothing', async () => {
    const h = harness();
    h.updater.onDesired('0.24.0');
    h.updater.onDesired(undefined);
    await h.flush();
    expect(h.calls.prefetch).toEqual([]);
  });

  it('acts on a newer version and on an older one: the server decides', async () => {
    for (const v of ['0.25.0', '0.24.1-rc.1']) {
      const h = harness({ currentVersion: '0.24.5' });
      h.updater.onDesired(v);
      await h.flush();
      expect(h.calls.restart, v).toEqual([v]);
    }
  });

  it('ignores a value that is not strict semver, and never passes it on', async () => {
    const h = harness();
    for (const v of ['latest', '^0.25.0', 'https://x/y.tgz', '0.25.0 && rm -rf ~', 25]) h.updater.onDesired(v);
    await h.flush();
    expect(h.calls.prefetch).toEqual([]);
    expect(h.logs.filter((l) => l.startsWith('warn'))).toHaveLength(5);
  });

  it('refuses to go below the first self-updating version, which would strand the machine', async () => {
    const h = harness();
    h.updater.onDesired('0.23.0');
    await h.flush();
    expect(h.calls.prefetch).toEqual([]);
    expect(h.logs.join('\n')).toMatch(/older than 0\.24\.0/);
  });
});

describe('opt-out and manual runs', () => {
  it('opted out: only says so, once, and the capability is false', async () => {
    const h = harness({ optedOut: true });
    expect(h.updater.enabled).toBe(false);
    h.updater.onDesired('0.25.0');
    h.updater.onDesired('0.25.0');
    await h.flush();
    expect(h.calls.prefetch).toEqual([]);
    expect(h.logs.filter((l) => /self-update is turned off/.test(l))).toHaveLength(1);
  });

  it('in a terminal: never exits, just warns with the reason', async () => {
    const h = harness({ detection: { reason: 'not running as a systemd service' } });
    expect(h.updater.enabled).toBe(false);
    h.updater.onDesired('0.25.0');
    await h.flush();
    expect(h.calls.restart).toEqual([]);
    expect(h.logs.join('\n')).toMatch(/wants ai-bridge 0\.25\.0.*not running as a systemd service/);
  });
});

describe('waiting until idle', () => {
  it('fetches at once, then waits for idle before pinning and restarting', async () => {
    const h = harness();
    h.setIdle(false);
    h.updater.onDesired('0.25.0');
    await h.flush();
    expect(h.calls.prefetch).toEqual(['0.25.0']);
    await h.advance(IDLE_POLL_MS * 10);
    expect(h.calls.pin).toEqual([]);
    expect(h.calls.restart).toEqual([]);
    h.setIdle(true);
    await h.advance(IDLE_POLL_MS);
    expect(h.calls.pin).toEqual([['0.25.0', '0.24.0']]);
    expect(h.calls.restart).toEqual(['0.25.0']);
    expect(h.state()).toMatchObject({ target: '0.25.0', from: '0.24.0', attempts: 1 });
  });

  it('stops waiting when the server no longer asks for it', async () => {
    const h = harness();
    h.setIdle(false);
    h.updater.onDesired('0.25.0');
    await h.flush();
    h.updater.onDesired(undefined);
    h.setIdle(true);
    await h.advance(IDLE_POLL_MS * 3);
    expect(h.calls.restart).toEqual([]);
  });

  it('switches target when the server changes its mind', async () => {
    const h = harness();
    h.setIdle(false);
    h.updater.onDesired('0.25.0');
    await h.flush();
    h.updater.onDesired('0.26.0');
    await h.flush();
    h.setIdle(true);
    await h.advance(IDLE_POLL_MS);
    expect(h.calls.restart).toEqual(['0.26.0']);
  });
});

describe('a fetch that fails', () => {
  it('stays running on the current version and tries again later, backing off', async () => {
    const h = harness();
    h.setFetchOk(false);
    h.updater.onDesired('0.25.0');
    await h.flush();
    expect(h.calls.pin).toEqual([]);
    expect(h.calls.restart).toEqual([]);
    await h.advance(FETCH_RETRY_MS(1) - 1);
    expect(h.calls.prefetch).toHaveLength(1);
    await h.advance(1);
    expect(h.calls.prefetch).toHaveLength(2);
    await h.advance(FETCH_RETRY_MS(2));
    expect(h.calls.prefetch).toHaveLength(3);
    h.setFetchOk(true);
    await h.advance(FETCH_RETRY_MS(3));
    expect(h.calls.restart).toEqual(['0.25.0']);
  });

  it('a pin that fails also leaves the bridge running', async () => {
    const h = harness({ pin: () => { throw new Error('EACCES'); } });
    h.updater.onDesired('0.25.0');
    await h.flush();
    expect(h.calls.restart).toEqual([]);
    expect(h.logs.join('\n')).toMatch(/could not pin 0\.25\.0 \(EACCES\)/);
  });
});

describe('loop protection', () => {
  it('coming back on the old version: says so, and waits before trying the same version again', async () => {
    const h = harness();
    h.writeState({ target: '0.25.0', from: '0.24.0', attempts: 2, at: h.now() - 60_000 });
    h.updater.start();
    expect(h.logs.join('\n')).toMatch(/came back on 0\.24\.0; the pin did not take/);
    h.updater.onDesired('0.25.0');
    await h.flush();
    expect(h.calls.prefetch).toEqual([]);
    await h.advance(ATTEMPT_BACKOFF_MS(2) - 60_000 - 1);
    expect(h.calls.prefetch).toEqual([]);
    await h.advance(1);
    expect(h.calls.restart).toEqual(['0.25.0']);
    expect(h.state()).toMatchObject({ attempts: 3 });
  });

  it('the backoff grows and is capped', () => {
    expect(ATTEMPT_BACKOFF_MS(1)).toBe(5 * 60_000);
    expect(ATTEMPT_BACKOFF_MS(2)).toBe(10 * 60_000);
    expect(ATTEMPT_BACKOFF_MS(50)).toBe(24 * 3_600_000);
    expect(FETCH_RETRY_MS(50)).toBe(6 * 3_600_000);
  });

  it('arriving on the target clears the record', () => {
    const h = harness({ currentVersion: '0.25.0' });
    h.writeState({ target: '0.25.0', from: '0.24.0', attempts: 1, at: h.now() });
    h.updater.start();
    expect(h.logs.join('\n')).toMatch(/now running 0\.25\.0 \(was 0\.24\.0\)/);
    expect(h.state()).toEqual({});
  });
});

describe('a prefetch that throws anyway', () => {
  it('is a failed fetch, retried later', async () => {
    let n = 0;
    const h = harness({ prefetch: async () => { n++; if (n === 1) throw new Error('boom'); return { ok: true }; } });
    h.updater.onDesired('0.25.0');
    await h.flush();
    expect(h.calls.restart).toEqual([]);
    expect(h.logs.join('\n')).toMatch(/could not fetch 0\.25\.0 \(boom\)/);
    await h.advance(FETCH_RETRY_MS(1));
    expect(h.calls.restart).toEqual(['0.25.0']);
  });
});
