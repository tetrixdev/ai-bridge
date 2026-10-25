/**
 * The system prompt a REAL `claude` CLI sends, turn after turn.
 *
 * Runs the installed CLI against a fake Messages API (support/fake-anthropic.ts)
 * so it needs no login and spends no tokens, and reads back the `system` text
 * of every request. Skipped when `claude` is not on PATH (CI has none), or
 * when AI_BRIDGE_SKIP_CLAUDE_LIVE is set.
 *
 * What it proves, which the argv tests in claude-system-prompt.test.ts cannot:
 *
 *   - a resumed turn carries the prompt sent WITH THAT TURN. Claude Code
 *     2.1.257+ records a conversation's first system prompt and resends it
 *     verbatim until compaction unless told `--system-prompt-snapshot off`,
 *     so a server that rebuilds its prompt every turn was silently ignored
 *     from turn two on;
 *   - a prompt far past Linux's 128 KiB per-argument limit starts, and
 *     arrives whole (it goes by file, not argv).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import { noteDetectedClaudeVersion } from '../../src/providers/subagent-prompt.js';
import type { AdapterStreamEvent, ExecutionContext } from '../../src/providers/base.js';
import type { AiRequestMessage } from '../../src/protocol/types.js';
import { startFakeAnthropic, type FakeAnthropic } from './support/fake-anthropic.js';

function claudeVersion(): string | null {
  if (process.env['AI_BRIDGE_SKIP_CLAUDE_LIVE']) return null;
  try {
    const out = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 15_000 });
    return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

const version = claudeVersion();

describe.skipIf(version === null)(`real claude ${version ?? ''} against a fake API`, () => {
  let api: FakeAnthropic;
  let workingDir: string;
  let configDir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDECODE'];

  beforeAll(async () => {
    api = await startFakeAnthropic();
    workingDir = realpathSync(mkdtempSync(join(tmpdir(), 'sysprompt-live-')));
    configDir = mkdtempSync(join(tmpdir(), 'sysprompt-live-config-'));
    for (const k of ENV) saved[k] = process.env[k];
    process.env['ANTHROPIC_BASE_URL'] = api.url;
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-fake-for-tests';
    process.env['CLAUDE_CONFIG_DIR'] = configDir;
    process.env['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1';
    delete process.env['CLAUDECODE'];
    noteDetectedClaudeVersion(version);
  });

  afterAll(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    noteDetectedClaudeVersion(null);
    await api.close();
    rmSync(workingDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  async function turn(systemPrompt: string, message: string, cliSessionId: string | null): Promise<{ sessionId: string | null; errors: string[] }> {
    const request = {
      type: 'ai_request',
      request_id: `req_${message}`,
      conversation_id: 'conv_live',
      provider: 'claude',
      message,
      system_prompt: systemPrompt,
      options: {},
      cli_session_id: cliSessionId,
    } as AiRequestMessage;
    const context: ExecutionContext = {
      request,
      requestId: request.request_id,
      tools: [],
      mcp: null,
      cliIsolation: 'isolated',
      workingDir,
      signal: new AbortController().signal,
      requestTimeoutSeconds: 90,
      silenceTimeoutSeconds: 0,
      cliSessionId,
      attachmentDir: null,
      bridgeEnv: {},
      bridgeAddendum: 'BRIDGE-ADDENDUM-MARKER',
    };
    const errors: string[] = [];
    let sessionId: string | null = null;
    try {
      sessionId = await new ClaudeAdapter().execute(context, (e: AdapterStreamEvent) => {
        if (e.event === 'error') errors.push(JSON.stringify(e.data));
      });
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
    return { sessionId, errors };
  }

  /** The requests that carried this turn's user message (not side requests). */
  function requestsFor(message: string) {
    return api.requests.filter((r) => r.userText.includes(message));
  }

  it('sends each turn the system prompt of THAT turn, also on --resume', async () => {
    const one = await turn('You are helper. PROMPT-OF-TURN-ONE', 'first-message-xyz', null);
    expect(one.errors).toEqual([]);
    expect(one.sessionId).not.toBeNull();
    const two = await turn('You are helper. PROMPT-OF-TURN-TWO', 'second-message-xyz', one.sessionId);
    expect(two.errors).toEqual([]);

    const first = requestsFor('first-message-xyz');
    const second = requestsFor('second-message-xyz');
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(first[0]!.system).toContain('PROMPT-OF-TURN-ONE');
    for (const r of second) {
      expect(r.system).toContain('PROMPT-OF-TURN-TWO');
      expect(r.system).not.toContain('PROMPT-OF-TURN-ONE');
      // The bridge addendum rides along on the resumed turn too.
      expect(r.system).toContain('BRIDGE-ADDENDUM-MARKER');
    }
  }, 180_000);

  it('starts with a 300 KB system prompt, and sends all of it', async () => {
    const line = 'This line pads the system prompt so it is far past the per-argument limit.\n';
    const big = `BIG-PROMPT-START\n${line.repeat(Math.ceil(300_000 / line.length))}BIG-PROMPT-END`;
    expect(big.length).toBeGreaterThan(300_000);
    const result = await turn(big, 'big-message-xyz', null);
    expect(result.errors).toEqual([]);
    const sent = requestsFor('big-message-xyz');
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]!.system).toContain(big);
  }, 180_000);
});
