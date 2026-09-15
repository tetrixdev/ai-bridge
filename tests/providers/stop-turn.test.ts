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
import type { ChildProcess } from 'node:child_process';
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
