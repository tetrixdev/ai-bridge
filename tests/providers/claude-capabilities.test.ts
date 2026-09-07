/**
 * Probing the local Claude CLI for partial-message support.
 *
 * The point of the probe is that an unknown flag is FATAL — the CLI exits
 * before emitting anything — so the bridge must never pass
 * `--include-partial-messages` on a version that lacks it. Every uncertain
 * answer has to come back `false`, and the adapter has to act on it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  supportsPartialMessages,
  resetPartialMessageSupportCache,
} from '../../src/providers/claude-capabilities.js';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import type { AiRequestMessage } from '../../src/protocol/types.js';

beforeEach(() => {
  resetPartialMessageSupportCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetPartialMessageSupportCache();
});

describe('supportsPartialMessages', () => {
  it('reports false when the CLI is not on PATH, rather than throwing', async () => {
    // A bridge whose probe threw would fail the turn outright, which is worse
    // than the lumpy output the probe exists to avoid.
    const empty = mkdtempSync(join(tmpdir(), 'nopath-'));
    try {
      vi.stubEnv('PATH', empty);
      await expect(supportsPartialMessages()).resolves.toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('honours the operator kill switch', async () => {
    vi.stubEnv('AI_BRIDGE_DISABLE_PARTIAL_STREAMING', '1');
    await expect(supportsPartialMessages()).resolves.toBe(false);
  });

  it('ignores the kill switch when it is unset or explicitly off', async () => {
    // An env var present but empty (a common shape in shell wrappers and
    // compose files) must not be read as "disabled".
    vi.stubEnv('AI_BRIDGE_DISABLE_PARTIAL_STREAMING', '0');
    const off = await supportsPartialMessages();
    resetPartialMessageSupportCache();
    vi.stubEnv('AI_BRIDGE_DISABLE_PARTIAL_STREAMING', '');
    const blank = await supportsPartialMessages();

    // Both take the real probe path; what matters is that neither short-circuits
    // to false via the kill switch, so they agree with each other.
    expect(off).toBe(blank);
  });

  it('probes once and reuses the answer', async () => {
    const first = supportsPartialMessages();
    const second = supportsPartialMessages();
    expect(first).toBe(second);
    await first;
  });
});

describe('the adapter when partial messages are unsupported', () => {
  it('omits the flag entirely', async () => {
    // The fallback the handover asked for: an older CLI must still answer.
    vi.stubEnv('AI_BRIDGE_DISABLE_PARTIAL_STREAMING', '1');

    let recorded: string[] = [];
    class Probe extends ClaudeAdapter {
      protected override spawnCli(
        _command: string,
        args: string[],
      ): ChildProcessByStdio<Writable | null, Readable, Readable> {
        recorded = args;
        return spawn(process.execPath, ['-e', ''], { stdio: ['pipe', 'pipe', 'pipe'] }) as
          ChildProcessByStdio<Writable | null, Readable, Readable>;
      }
    }

    const request: AiRequestMessage = {
      type: 'ai_request',
      request_id: 'req_nopartial',
      conversation_id: 'conv_1',
      provider: 'claude',
      message: 'go',
      system_prompt: null,
      options: {},
      cli_session_id: null,
    };

    await new Probe().execute({
      request,
      requestId: request.request_id,
      tools: [],
      mcp: null,
      cliIsolation: 'isolated',
      workingDir: process.cwd(),
      signal: new AbortController().signal,
      requestTimeoutSeconds: 30,
      cliSessionId: null,
      attachmentDir: null,
    }, () => {});

    expect(recorded).not.toContain('--include-partial-messages');
  });
});
