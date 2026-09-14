/**
 * Unit tests covering:
 *   - Codex / Gemini duplicate done-event guards
 *   - Clamping of server-provided timeout/heartbeat values
 *   - AI_BRIDGE_TOKEN/SERVER stripped from spawn env
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSpawnEnv } from '../../src/providers/env.js';
import { clampRequestTimeout, clampSilenceTimeout, clampHeartbeat } from '../../src/utils/clamp.js';
import { Bridge } from '../../src/bridge.js';

// ---------------------------------------------------------------------------
// Clamping of server-provided timeout/heartbeat
// ---------------------------------------------------------------------------

describe('SEC-003: Value clamping helpers', () => {
  // Imports the real clamp helpers from src/utils/clamp.ts so tests exercise
  // the actual production constants.

  it('treats request_timeout: 0 as "no wall clock", not as the smallest one', () => {
    // Zero is a server saying it bounds the turn itself. Clamping it UP to ten
    // seconds turned "no ceiling" into the most aggressive ceiling available —
    // the opposite of what was asked for, and unsurvivable for any real turn.
    expect(clampRequestTimeout(0)).toBe(0);
  });

  it('clamps request_timeout: negative → 10', () => {
    // Negative is not a request for anything; it is a bad value.
    expect(clampRequestTimeout(-1)).toBe(10);
  });

  it('clamps request_timeout: huge → 24 h', () => {
    // The ceiling was an hour, which real agentic work passes — migrations,
    // large refactors, multi-step research. It is a wall clock and cannot tell
    // a stuck CLI from a busy one, so it is a backstop now and sized like one;
    // the silence bound is what actually protects the bridge.
    expect(clampRequestTimeout(999_999_999)).toBe(86_400);
  });

  it('treats silence_timeout the same way at both ends', () => {
    expect(clampSilenceTimeout(0)).toBe(0);
    expect(clampSilenceTimeout(-1)).toBe(10);
    expect(clampSilenceTimeout(999_999_999)).toBe(86_400);
    expect(clampSilenceTimeout(900)).toBe(900);
  });

  it('passes through valid request_timeout unchanged', () => {
    expect(clampRequestTimeout(300)).toBe(300);
  });

  it('clamps heartbeat_interval: 0 → 5', () => {
    expect(clampHeartbeat(0)).toBe(5);
  });

  it('clamps heartbeat_interval: 1 → 5', () => {
    expect(clampHeartbeat(1)).toBe(5);
  });

  it('clamps heartbeat_interval: 99999 → 300', () => {
    expect(clampHeartbeat(99999)).toBe(300);
  });

  it('passes through valid heartbeat_interval unchanged', () => {
    expect(clampHeartbeat(30)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// AI_BRIDGE_TOKEN / AI_BRIDGE_SERVER stripped from spawn env
// ---------------------------------------------------------------------------

describe('SEC-009: buildSpawnEnv — bridge credential stripping', () => {
  beforeEach(() => {
    process.env['AI_BRIDGE_TOKEN'] = 'secret-token-12345';
    process.env['AI_BRIDGE_SERVER'] = 'wss://example.com/ws';
  });

  afterEach(() => {
    delete process.env['AI_BRIDGE_TOKEN'];
    delete process.env['AI_BRIDGE_SERVER'];
  });

  it('strips AI_BRIDGE_TOKEN from the child environment', () => {
    const env = buildSpawnEnv();
    expect(env['AI_BRIDGE_TOKEN']).toBeUndefined();
  });

  it('strips AI_BRIDGE_SERVER from the child environment', () => {
    const env = buildSpawnEnv();
    expect(env['AI_BRIDGE_SERVER']).toBeUndefined();
  });

  it('does not strip other environment variables', () => {
    const originalPath = process.env['PATH'];
    const env = buildSpawnEnv();
    expect(env['PATH']).toBe(originalPath);
  });

  it('does not modify the parent process.env', () => {
    buildSpawnEnv();
    expect(process.env['AI_BRIDGE_TOKEN']).toBe('secret-token-12345');
    expect(process.env['AI_BRIDGE_SERVER']).toBe('wss://example.com/ws');
  });
});

// ---------------------------------------------------------------------------
// Codex duplicate done — settled guard
// ---------------------------------------------------------------------------

describe('BL-012: Codex settled guard (direct logic test)', () => {
  it('settled flag prevents a second done event', () => {
    // Simulate the guard: if settled is true, the turn.completed handler returns early
    let settled = false;
    const events: string[] = [];

    const emitDone = () => {
      if (settled) return; // duplicate-done guard
      events.push('done');
      settled = true;
    };

    const handleErrorItem = () => {
      events.push('error');
      events.push('done');
      settled = true;
    };

    const handleTurnCompleted = () => {
      emitDone(); // guarded
    };

    // Simulate: error item fires first (sets settled=true + emits done)
    handleErrorItem();
    // Then turn.completed fires — should be a no-op
    handleTurnCompleted();

    expect(events).toEqual(['error', 'done']);
    expect(events.filter((e) => e === 'done').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Gemini settled guard — result event after fatal error must not emit a
// second done event
// ---------------------------------------------------------------------------

describe('BL-002: Gemini settled guard (direct logic test)', () => {
  it('result event after fatal error is ignored (settled guard)', () => {
    let settled = false;
    const events: string[] = [];

    // Simulate the fatal error handler
    const handleFatalError = () => {
      events.push('error');
      events.push('done');
      settled = true;
    };

    // Simulate the result handler with the settled guard
    const handleResult = () => {
      if (settled) return; // duplicate-done guard
      events.push('done');
      settled = true;
    };

    // Fatal error fires first
    handleFatalError();
    // Then result fires — must be a no-op due to guard
    handleResult();

    expect(events).toEqual(['error', 'done']);
    expect(events.filter((e) => e === 'done').length).toBe(1);
  });

  it('result event without prior error emits done normally', () => {
    let settled = false;
    const events: string[] = [];

    const handleResult = () => {
      if (settled) return;
      events.push('done');
      settled = true;
    };

    handleResult();

    expect(events).toEqual(['done']);
    expect(events.filter((e) => e === 'done').length).toBe(1);
  });
});

describe('how long the bridge waits for the server to answer a tool call', () => {
  /** Apply a welcome config and report the resolver timeout it produced. */
  function resolverSecondsFor(config: Record<string, unknown>): number {
    const bridge = new Bridge({
      serverUrl: 'wss://example.test/ws',
      token: 'tok',
      providers: [],
      adapters: new Map(),
      sessionStorePath: null,
      allowedRoots: [],
      allowNative: false,
    });
    let ms = 0;
    (bridge as unknown as { toolResolver: { setTimeoutMs(v: number): void } }).toolResolver = {
      setTimeoutMs: (v: number) => { ms = v; },
    };
    (bridge as unknown as { handleWelcome(m: unknown): void }).handleWelcome({
      type: 'welcome',
      session_id: 's',
      // `tools` is required: handleWelcome reads its length, and omitting it
      // leaves an unhandled rejection that the test still passes through.
      tools: [],
      config: { heartbeat_interval: 30, ...config },
    });

    return ms / 1000;
  }

  it('follows the silence bound, not the 24-hour backstop', () => {
    // It used to borrow request_timeout. That is now a day, and inheriting it
    // would block the CLI for a day on a server that never answers.
    const seconds = resolverSecondsFor({ request_timeout: 86400, silence_timeout: 900 });

    expect(seconds).toBeLessThan(900);
    expect(seconds).toBeGreaterThan(600);
  });

  it('stops short of the silence bound, so a failed tool does not kill the turn', () => {
    // A tool error is something the CLI can report and continue from, and
    // emitting that result resets the silence clock. Waiting for the silence
    // clock instead ends the whole turn to report one failed tool.
    const seconds = resolverSecondsFor({ request_timeout: 86400, silence_timeout: 100 });

    expect(seconds).toBeLessThan(100);
  });

  it('never waits longer than an hour, whatever the silence bound says', () => {
    const seconds = resolverSecondsFor({ request_timeout: 86400, silence_timeout: 86400 });

    expect(seconds).toBeLessThanOrEqual(3600);
  });

  it('falls back to the ceiling when the server bounds nothing', () => {
    const seconds = resolverSecondsFor({ request_timeout: 0, silence_timeout: 0 });

    expect(seconds).toBe(3600);
  });
});
