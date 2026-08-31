/**
 * How fast one space may make this machine fork.
 *
 * The case being defended against is not an attacker, it is a panel with a
 * render-loop bug calling a tool at UI speed. Before this, `runLocalTool` had
 * neither limit: every frame the browser painted became a process holding a
 * decrypted credential.
 */

import { describe, expect, it } from 'vitest';
import { SpaceLimiter, TooManyLocalCalls } from '../../src/local/limits.js';

describe('how many local calls one space may have in flight', () => {
  it('refuses the third rather than queueing it', async () => {
    // Queueing would be the same fork bomb with a delay, and a caller cannot
    // see a queue. A refusal arrives at the panel that is misbehaving.
    const limiter = new SpaceLimiter({ maxConcurrent: 2, minIntervalMs: 0 });
    await limiter.acquire('space_a');
    await limiter.acquire('space_a');

    await expect(limiter.acquire('space_a')).rejects.toThrow(TooManyLocalCalls);
    await expect(limiter.acquire('space_a')).rejects.toThrow(/already running 2 local tools/);
  });

  it('counts each space on its own, so one space cannot starve another', async () => {
    const limiter = new SpaceLimiter({ maxConcurrent: 1, minIntervalMs: 0 });
    await limiter.acquire('space_a');

    await expect(limiter.acquire('space_a')).rejects.toThrow(TooManyLocalCalls);
    await expect(limiter.acquire('space_b')).resolves.toBeTypeOf('function');
  });

  it('takes the slot back when the call is over', async () => {
    const limiter = new SpaceLimiter({ maxConcurrent: 1, minIntervalMs: 0 });
    const release = await limiter.acquire('space_a');
    expect(limiter.running('space_a')).toBe(1);

    release();
    expect(limiter.running('space_a')).toBe(0);
    await expect(limiter.acquire('space_a')).resolves.toBeTypeOf('function');
  });

  it('ignores a release called twice, which would free a slot nobody holds', async () => {
    const limiter = new SpaceLimiter({ maxConcurrent: 2, minIntervalMs: 0 });
    const release = await limiter.acquire('space_a');
    await limiter.acquire('space_a');

    release();
    release();
    expect(limiter.running('space_a')).toBe(1);
  });
});

describe('how fast one space may start local calls', () => {
  it('spaces out calls that a fast tool would otherwise let through unbounded', async () => {
    // The concurrency cap alone does not catch this: a tool that finishes in
    // 20ms never reaches two in flight however fast it is called.
    const limiter = new SpaceLimiter({ maxConcurrent: 2, minIntervalMs: 120 });
    const started = Date.now();

    (await limiter.acquire('space_a'))();
    (await limiter.acquire('space_a'))();

    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
  });

  it('waits rather than refusing, because two honest calls should both run', async () => {
    const limiter = new SpaceLimiter({ maxConcurrent: 2, minIntervalMs: 60 });
    await expect(limiter.acquire('space_a')).resolves.toBeTypeOf('function');
    await expect(limiter.acquire('space_a')).resolves.toBeTypeOf('function');
  });

  it('paces each space separately', async () => {
    const limiter = new SpaceLimiter({ maxConcurrent: 2, minIntervalMs: 200 });
    const started = Date.now();

    (await limiter.acquire('space_a'))();
    (await limiter.acquire('space_b'))();

    expect(Date.now() - started).toBeLessThan(150);
  });
});
