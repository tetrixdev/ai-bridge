/**
 * Stopping a turn has to leave a session somebody can resume.
 *
 * SIGTERM does not. Anthropic's headless documentation says so in as many
 * words — it "leaves the turn that was in progress unfinished", and "when you
 * resume the session, Claude Code continues the turn that SIGTERM left
 * unfinished" — and a production instance then said it louder: a turn stopped
 * by a bound mid-way through a run of tools, the next message resuming that
 * session, and this bridge logging "tool result received after stream settled —
 * dropping" once per result for five minutes while the server heard nothing.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { stopTurn } from '../../src/providers/stop.js';

/** A child that records what it was sent and exits only when told to. */
function fakeChild(): ChildProcess & { signals: string[]; finish: () => void } {
  const child = new EventEmitter() as ChildProcess & { signals: string[]; finish: () => void };
  child.signals = [];
  Object.defineProperty(child, 'exitCode', { value: null, writable: true });
  Object.defineProperty(child, 'signalCode', { value: null, writable: true });
  child.kill = ((signal?: NodeJS.Signals) => {
    child.signals.push(String(signal));

    return true;
  }) as ChildProcess['kill'];
  child.finish = () => {
    (child as { exitCode: number | null }).exitCode = 0;
    child.emit('exit', 0, null);
  };

  return child;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('ending a turn', () => {
  it('asks with SIGINT, which is what ends the turn rather than abandoning it', () => {
    vi.useFakeTimers();
    const child = fakeChild();

    stopTurn(child, { requestId: 'req_1', provider: 'claude' });

    expect(child.signals).toEqual(['SIGINT']);
  });

  it('sends nothing else once the CLI has gone', () => {
    vi.useFakeTimers();
    const child = fakeChild();

    stopTurn(child, { requestId: 'req_2', provider: 'claude' });
    child.finish();
    vi.advanceTimersByTime(60_000);

    // A timer that fires against a process that has exited is a signal sent to
    // whatever holds that pid next, which is the kind of bug nobody reproduces.
    expect(child.signals).toEqual(['SIGINT']);
  });

  it('escalates when the CLI ignores it, because a turn cannot hold a process forever', () => {
    vi.useFakeTimers();
    const child = fakeChild();

    stopTurn(child, { requestId: 'req_3', provider: 'claude' });
    vi.advanceTimersByTime(5_100);
    expect(child.signals).toEqual(['SIGINT', 'SIGTERM']);

    vi.advanceTimersByTime(5_100);
    expect(child.signals).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
  });

  it('says nothing to a process that has already exited', () => {
    const child = fakeChild();
    (child as { exitCode: number | null }).exitCode = 0;

    stopTurn(child, { requestId: 'req_4', provider: 'claude' });

    expect(child.signals).toEqual([]);
  });
});

/**
 * The whole turn goes, not just the CLI. With background tasks on, a turn owns
 * more than one process: spawnCli() starts the CLI as the leader of its own
 * group, and stopTurn() signals the group. Claude Code puts each shell command
 * in a session of its own, where a group signal cannot reach it; the CLI stops
 * those itself on SIGINT, and for a CLI that ignores everything the last step
 * finds its descendants and kills their groups too.
 */
describe.skipIf(process.platform === 'win32')('ending a turn that started other processes', () => {
  /** Alive and not a zombie waiting for a parent that will never reap it. */
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      const stat = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).trim();

      return stat !== '' && !stat.startsWith('Z');
    } catch {
      return false;
    }
  }

  async function eventually(check: () => boolean, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((r) => setTimeout(r, 25));
    }

    return check();
  }

  /** Spawn like spawnCli() does, and wait for the child to report its child's pid. */
  async function spawnTurn(script: string): Promise<{ child: ChildProcess; grandchild: number }> {
    const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = await new Promise<number>((resolve, reject) => {
      child.stdout!.once('data', (c: Buffer) => resolve(Number(c.toString().trim())));
      child.once('error', reject);
    });

    return { child, grandchild };
  }

  const strays: number[] = [];
  afterEach(() => {
    for (const pid of strays.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('signals the group, so what the CLI started in it stops with the turn', async () => {
    const { child, grandchild } = await spawnTurn(`
      const g = require('child_process').spawn(process.execPath, ['-e', "console.log('up'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
      g.stdout.once('data', () => console.log(String(g.pid)));
      setInterval(() => {}, 1000);
    `);
    strays.push(grandchild, child.pid!);
    expect(alive(grandchild)).toBe(true);

    stopTurn(child, { requestId: 'req_group', provider: 'claude' });

    expect(await eventually(() => !alive(grandchild))).toBe(true);
    expect(await eventually(() => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  });

  it('kills a command in a session of its own when the CLI ignores every signal', async () => {
    const { child, grandchild } = await spawnTurn(`
      process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
      const g = require('child_process').spawn(process.execPath, ['-e',
        "process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); console.log('up'); setInterval(() => {}, 1000)"],
        { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
      g.stdout.once('data', () => console.log(String(g.pid)));
      setInterval(() => {}, 1000);
    `);
    strays.push(grandchild, child.pid!);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    stopTurn(child, { requestId: 'req_session', provider: 'claude' });
    // SIGINT and SIGTERM are both ignored; the SIGKILL step is what ends it.
    vi.advanceTimersByTime(10_100);
    vi.useRealTimers();

    expect(await eventually(() => child.exitCode !== null || child.signalCode !== null)).toBe(true);
    // Re-parented by now, and out of the CLI's group — yet gone.
    expect(await eventually(() => !alive(grandchild))).toBe(true);
  });
});
