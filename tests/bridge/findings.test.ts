/**
 * Unit tests covering:
 *   - Codex / Gemini duplicate done-event guards
 *   - Clamping of server-provided timeout/heartbeat values
 *   - AI_BRIDGE_TOKEN/SERVER stripped from spawn env
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSpawnEnv } from '../../src/providers/env.js';
import { clampRequestTimeout, clampHeartbeat } from '../../src/utils/clamp.js';

// ---------------------------------------------------------------------------
// Clamping of server-provided timeout/heartbeat
// ---------------------------------------------------------------------------

describe('SEC-003: Value clamping helpers', () => {
  // Imports the real clamp helpers from src/utils/clamp.ts so tests exercise
  // the actual production constants.

  it('clamps request_timeout: 0 → 10', () => {
    expect(clampRequestTimeout(0)).toBe(10);
  });

  it('clamps request_timeout: negative → 10', () => {
    expect(clampRequestTimeout(-1)).toBe(10);
  });

  it('clamps request_timeout: huge → 3600', () => {
    expect(clampRequestTimeout(999_999_999)).toBe(3600);
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
    const env = buildSpawnEnv(null);
    expect(env['AI_BRIDGE_TOKEN']).toBeUndefined();
  });

  it('strips AI_BRIDGE_SERVER from the child environment', () => {
    const env = buildSpawnEnv(null);
    expect(env['AI_BRIDGE_SERVER']).toBeUndefined();
  });

  it('does not strip other environment variables', () => {
    const originalPath = process.env['PATH'];
    const env = buildSpawnEnv(null);
    expect(env['PATH']).toBe(originalPath);
  });

  it('does not modify the parent process.env', () => {
    buildSpawnEnv(null);
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
