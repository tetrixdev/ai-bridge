/**
 * Probing the local Claude CLI for partial-message support.
 *
 * An unknown flag is FATAL — the CLI exits before emitting anything — so the
 * bridge must never pass `--include-partial-messages` on a version that lacks
 * it, and every uncertain answer has to come back `false`.
 *
 * These tests put a FAKE `claude` on PATH rather than running the real one.
 * Reading the host's binary made the whole file vacuous on a machine without
 * Claude installed (every case returns false, every assertion holds) and
 * untestable in the direction that matters — that the probe reads the help text
 * at all, rather than returning a constant.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import {
  supportsPartialMessages,
  resetPartialMessageSupportCache,
  noteCliRejectedPartialFlag,
  setProbeTimeoutForTests,
} from '../../src/providers/claude-capabilities.js';
import { ClaudeAdapter } from '../../src/providers/claude.js';
import type { AiRequestMessage } from '../../src/protocol/types.js';

const CAPABILITIES_MODULE = fileURLToPath(new URL('../../src/providers/claude-capabilities.ts', import.meta.url));
const VITE_NODE = fileURLToPath(new URL('../../node_modules/.bin/vite-node', import.meta.url));

let binDir: string;

/** Put a fake `claude` on PATH whose `--help` behaves as described. */
function fakeClaude(script: string): void {
  const path = join(binDir, 'claude');
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  vi.stubEnv('PATH', `${binDir}:/usr/bin:/bin`);
}

const HELP_WITH_FLAG = 'echo "  --include-partial-messages   Include partial message chunks"';
const HELP_WITHOUT_FLAG = 'echo "  --output-format <format>   Output format"';

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'fakecli-'));
  resetPartialMessageSupportCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetPartialMessageSupportCache();
  setProbeTimeoutForTests(10_000);
  rmSync(binDir, { recursive: true, force: true });
});

describe('supportsPartialMessages', () => {
  it('reports true when the help text lists the flag', async () => {
    fakeClaude(HELP_WITH_FLAG);
    await expect(supportsPartialMessages()).resolves.toBe(true);
  });

  it('reports false when it does not', async () => {
    fakeClaude(HELP_WITHOUT_FLAG);
    await expect(supportsPartialMessages()).resolves.toBe(false);
  });

  it('reads stderr too, since some CLIs print help there', async () => {
    fakeClaude('echo "  --include-partial-messages   chunks" >&2');
    await expect(supportsPartialMessages()).resolves.toBe(true);
  });

  it('reports false when the CLI exits non-zero', async () => {
    fakeClaude('exit 1');
    await expect(supportsPartialMessages()).resolves.toBe(false);
  });

  it('reports false when the CLI is not on PATH, rather than throwing', async () => {
    // A probe that threw would fail the turn outright, which is worse than the
    // lumpy output the probe exists to avoid.
    vi.stubEnv('PATH', binDir);
    await expect(supportsPartialMessages()).resolves.toBe(false);
  });

  it('does not hang on a CLI that ignores the kill signal', async () => {
    // A child that traps SIGTERM must not be able to stall the probe. Because
    // the answer is cached and awaited before the request timeout is armed,
    // that would stop every Claude turn for the life of the process.
    setProbeTimeoutForTests(1_000);
    fakeClaude('trap "" TERM\nsleep 30');
    await expect(supportsPartialMessages()).resolves.toBe(false);
  }, 15_000);

  it('kills what the CLI started, not just the CLI', async () => {
    // A `claude` that is a shell wrapper leaves descendants that SIGKILL on the
    // child alone never reaches, and they outlive the probe AND the bridge.
    //
    // This is the test the first attempt at this did not have: that version
    // passed `detached: true` to execFile, which silently drops it — the option
    // whitelist is cwd/env/gid/shell/signal/uid/windowsHide/
    // windowsVerbatimArguments — so the child stayed in the bridge's own group,
    // the group kill threw ESRCH, and it quietly did nothing.
    setProbeTimeoutForTests(1_000);
    const marker = join(binDir, 'grandchild-survived.txt');

    // Backgrounds a grandchild that will write the marker, holds stdout open so
    // the probe cannot finish on its own, and ignores SIGTERM.
    fakeClaude(`trap "" TERM
( sleep 2; touch ${marker} ) &
${HELP_WITH_FLAG}
sleep 30`);

    // true, not false: the flag WAS printed. Having to kill a CLI that will not
    // exit is not a reason to discard what it already told us.
    await expect(supportsPartialMessages()).resolves.toBe(true);

    // Past when the grandchild would have written it, had it survived.
    await delay(3_000);
    expect(existsSync(marker), 'a process the probe started outlived it').toBe(false);
  }, 20_000);

  it('uses what the CLI printed when a background child holds stdout open', async () => {
    // The shape that breaks the obvious implementation, and the one an earlier
    // version of this file missed: the wrapper EXITS and is reaped, but a child
    // it backgrounded inherited stdout, so the pipe never closes and the probe
    // runs to its timeout with the complete help text already read. Answering
    // `false` there caches "unsupported" for the life of the process on a CLI
    // that plainly supports the flag.
    setProbeTimeoutForTests(1_000);
    fakeClaude(`( sleep 20 ) &\n${HELP_WITH_FLAG}\nexit 0`);
    await expect(supportsPartialMessages()).resolves.toBe(true);
  }, 15_000);

  it('strips credentials from the environment it hands the binary', async () => {
    // The probe runs a binary off PATH. ENGRAM_TOKEN is the vault credential
    // and belongs on that list as much as the bridge's own token.
    const dump = join(binDir, 'env.txt');
    fakeClaude(`env > ${dump}\n${HELP_WITH_FLAG}`);
    vi.stubEnv('AI_BRIDGE_TOKEN', 'tok-secret');
    vi.stubEnv('AI_BRIDGE_SERVER', 'wss://example.test');
    vi.stubEnv('ENGRAM_TOKEN', 'vault-secret');
    vi.stubEnv('ENGRAM_URL', 'https://vault.test');
    vi.stubEnv('ENGRAM_IDENTITY', 'someone');
    vi.stubEnv('CLAUDECODE', '1');

    await supportsPartialMessages();

    expect(existsSync(dump)).toBe(true);
    const env = readFileSync(dump, 'utf8');
    for (const name of ['AI_BRIDGE_TOKEN', 'AI_BRIDGE_SERVER', 'ENGRAM_TOKEN', 'ENGRAM_URL', 'ENGRAM_IDENTITY']) {
      expect(env).not.toContain(name);
    }
    // CLAUDECODE additionally has to go: the CLI refuses to run when it is set,
    // so a bridge running inside Claude Code would probe as unsupported and
    // silently disable streaming everywhere.
    expect(env).not.toContain('CLAUDECODE');
  });

  it('probes once and reuses the answer', async () => {
    fakeClaude(`echo probed >> ${join(binDir, 'runs.txt')}\n${HELP_WITH_FLAG}`);
    await Promise.all([supportsPartialMessages(), supportsPartialMessages()]);
    await supportsPartialMessages();
    expect(readFileSync(join(binDir, 'runs.txt'), 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('the operator kill switch', () => {
  it('disables partial streaming when set', async () => {
    fakeClaude(HELP_WITH_FLAG);
    vi.stubEnv('AI_BRIDGE_DISABLE_PARTIAL_STREAMING', '1');
    await expect(supportsPartialMessages()).resolves.toBe(false);
  });

  it('leaves it on when unset, empty, or explicitly off', async () => {
    // Asserted against the concrete expected value, not against each other: an
    // earlier version of this test compared the two results, which held just as
    // well when the kill switch wrongly swallowed both.
    fakeClaude(HELP_WITH_FLAG);

    vi.stubEnv('AI_BRIDGE_DISABLE_PARTIAL_STREAMING', '0');
    await expect(supportsPartialMessages()).resolves.toBe(true);

    resetPartialMessageSupportCache();
    vi.stubEnv('AI_BRIDGE_DISABLE_PARTIAL_STREAMING', '');
    await expect(supportsPartialMessages()).resolves.toBe(true);

    resetPartialMessageSupportCache();
    vi.stubEnv('AI_BRIDGE_DISABLE_PARTIAL_STREAMING', undefined);
    await expect(supportsPartialMessages()).resolves.toBe(true);
  });
});

describe('a probe that was simply wrong about the CLI', () => {
  it('stops passing the flag instead of failing every turn forever', async () => {
    // The case no other test here covers, because they all swap the fake binary
    // first: `--help` LISTS the flag but the argv parser rejects it. Clearing
    // the cache would re-ask the same unchanged CLI the same question, get the
    // same answer, and fail the turn again — for the life of the process.
    fakeClaude(HELP_WITH_FLAG);
    await expect(supportsPartialMessages()).resolves.toBe(true);

    const argvs: string[][] = [];
    class Rejecting extends ClaudeAdapter {
      protected override spawnCli(
        _command: string,
        args: string[],
      ): ChildProcessByStdio<Writable | null, Readable, Readable> {
        argvs.push(args);
        return spawn(process.execPath, ['-e',
          'process.stderr.write("error: unknown option \'--include-partial-messages\'\\n"); process.exit(1);',
        ], { stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
      }
    }

    const turn = (id: string) => new Rejecting().execute({
      request: {
        type: 'ai_request', request_id: id, conversation_id: 'c', provider: 'claude',
        message: 'go', system_prompt: null, options: {}, cli_session_id: null,
      },
      requestId: id,
      tools: [],
      mcp: null,
      cliIsolation: 'native',
      workingDir: process.cwd(),
      signal: new AbortController().signal,
      requestTimeoutSeconds: 30,
      cliSessionId: null,
      attachmentDir: null,
    }, () => {});

    await turn('t1');
    await turn('t2');
    await turn('t3');

    expect(argvs[0]).toContain('--include-partial-messages');
    expect(argvs[1], 'the second turn repeated a flag the CLI had already rejected')
      .not.toContain('--include-partial-messages');
    expect(argvs[2]).not.toContain('--include-partial-messages');
  }, 20_000);
});

describe('output split across stdout and stderr', () => {
  it('finds a flag split across two stdout writes despite stderr in between', async () => {
    // A single carry-over buffer shared by both streams is clobbered by the
    // other stream, and a flag that IS present reads as absent — the operator
    // silently loses streaming.
    fakeClaude([
      'printf "  --include-partial-"',
      'sleep 0.3',
      'echo "a warning from some shim" >&2',
      'sleep 0.3',
      'printf "messages   Include partial message chunks\n"',
    ].join('\n'));

    await expect(supportsPartialMessages()).resolves.toBe(true);
  }, 15_000);

  it('does not assemble a flag out of two different streams', async () => {
    // The other direction, and the dangerous one: the flag appears in NEITHER
    // stream, but a shared tail ending mid-flag completes against the start of
    // the other. The bridge would then pass a flag the CLI does not have.
    fakeClaude([
      'printf "note: try --include-partial-" >&2',
      'sleep 0.3',
      'printf "messages is not a thing here\n"',
    ].join('\n'));

    await expect(supportsPartialMessages()).resolves.toBe(false);
  }, 15_000);
});

describe('recovering from a CLI downgraded under a running bridge', () => {
  it('re-probes after the CLI rejects the flag', async () => {
    fakeClaude(HELP_WITH_FLAG);
    await expect(supportsPartialMessages()).resolves.toBe(true);

    // The operator installs an older CLI without restarting the bridge. Cached
    // as supported, every turn would otherwise die before emitting anything.
    fakeClaude(HELP_WITHOUT_FLAG);
    noteCliRejectedPartialFlag('error: unknown option --include-partial-messages');

    await expect(supportsPartialMessages()).resolves.toBe(false);
  });

  it('reports whether it fired, so the caller can latch it', async () => {
    // appendStderr keeps the FIRST 10KB, so once a rejection is in the buffer
    // every later chunk still matches. Without a latch driven by this return
    // value, one turn re-probes once per stderr chunk.
    fakeClaude(HELP_WITH_FLAG);
    await supportsPartialMessages();

    expect(noteCliRejectedPartialFlag('error: unknown option --include-partial-messages')).toBe(true);
    expect(noteCliRejectedPartialFlag('Error: rate limit exceeded')).toBe(false);
  });

  it('does not treat a CLI printing its own option list as a rejection', async () => {
    // A CLI that SUPPORTS the flag still names it when it dumps usage on an
    // unrelated failure. Taking that as a rejection re-probes after every such
    // turn, for nothing.
    fakeClaude(HELP_WITH_FLAG);
    await expect(supportsPartialMessages()).resolves.toBe(true);

    const usageDump = 'Error: request failed\n\nOptions:\n  --include-partial-messages   Include partial message chunks\n';
    expect(noteCliRejectedPartialFlag(usageDump)).toBe(false);

    fakeClaude(HELP_WITHOUT_FLAG);  // would report false if the cache had been dropped
    await expect(supportsPartialMessages()).resolves.toBe(true);
  });

  it('ignores unrelated stderr, so one bad turn does not disable streaming', async () => {
    fakeClaude(HELP_WITH_FLAG);
    await expect(supportsPartialMessages()).resolves.toBe(true);

    noteCliRejectedPartialFlag('Error: rate limit exceeded');

    fakeClaude(HELP_WITHOUT_FLAG);  // would report false if it re-probed
    await expect(supportsPartialMessages()).resolves.toBe(true);
  });
});

describe('the adapter when partial messages are unsupported', () => {
  it('omits the flag entirely', async () => {
    // The fallback the handover asked for: an older CLI must still answer.
    fakeClaude(HELP_WITHOUT_FLAG);

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

describe('the adapter noticing a rejected flag', () => {
  it('clears the cache when the CLI complains about the flag on stderr', async () => {
    // Covers the CALL SITE, not just the helper: without the adapter wiring
    // this up, a CLI downgraded under a running bridge fails identically on
    // every turn until someone restarts it.
    fakeClaude(HELP_WITH_FLAG);
    await expect(supportsPartialMessages()).resolves.toBe(true);

    class Rejecting extends ClaudeAdapter {
      protected override spawnCli(): ChildProcessByStdio<Writable | null, Readable, Readable> {
        return spawn(process.execPath, ['-e',
          'process.stderr.write("error: unknown option \'--include-partial-messages\'\\n"); process.exit(1);',
        ], { stdio: ['ignore', 'pipe', 'pipe'] }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
      }
    }

    await new Rejecting().execute({
      request: {
        type: 'ai_request', request_id: 'req_rej', conversation_id: 'c', provider: 'claude',
        message: 'go', system_prompt: null, options: {}, cli_session_id: null,
      },
      requestId: 'req_rej',
      tools: [],
      mcp: null,
      cliIsolation: 'native',
      workingDir: process.cwd(),
      signal: new AbortController().signal,
      requestTimeoutSeconds: 30,
      cliSessionId: null,
      attachmentDir: null,
    }, () => {});

    // The cache must have been dropped: a re-probe now sees the older CLI.
    fakeClaude(HELP_WITHOUT_FLAG);
    await expect(supportsPartialMessages()).resolves.toBe(false);
  });
});

/** setsid is not present on macOS; the tests that need it skip there. */
const HAS_SETSID = existsSync('/usr/bin/setsid') || existsSync('/bin/setsid');

describe('a bridge that exits while a probe is in flight', () => {
  /** Run a probe in a child process and report how long that process took to exit. */
  async function probeInChildProcess(cliScript: string, dir: string): Promise<number> {
    writeFileSync(join(dir, 'claude'), `#!/bin/sh\n${cliScript}\n`);
    chmodSync(join(dir, 'claude'), 0o755);

    const script = join(dir, 'run.ts');
    writeFileSync(script, `
      import { supportsPartialMessages, setProbeTimeoutForTests } from ${JSON.stringify(CAPABILITIES_MODULE)};
      setProbeTimeoutForTests(1_000);
      await supportsPartialMessages();
    `);

    const started = Date.now();
    await new Promise<void>((resolve) => {
      const child = spawn(VITE_NODE, [script], {
        env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}` },
        stdio: 'ignore',
      });
      child.on('close', () => resolve());
      child.on('error', () => resolve());
    });
    return Date.now() - started;
  }

  it.skipIf(!HAS_SETSID)('exits rather than hanging on a pipe a background child still holds', async () => {
    // A wrapper that exits leaves its backgrounded child holding the inherited
    // stdout. The pipe stays open, libuv keeps the handle referenced, and the
    // event loop never drains — so the process hangs forever with its work
    // already done.
    //
    // `setsid` puts that child in its OWN process group, where the group kill
    // cannot reach it. That is what makes this test specific to destroying the
    // pipes: with a plain `( … ) &` the group kill closes them as a side effect
    // and the test passes whether the teardown is there or not.
    const dir = mkdtempSync(join(tmpdir(), 'pipehold-'));
    try {
      const elapsed = await probeInChildProcess(`setsid sleep 25 &\n${HELP_WITH_FLAG}\nexit 0`, dir);
      expect(elapsed, 'the process did not exit once the probe was done').toBeLessThan(15_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);


  it('takes the probe and its children down with it', async () => {
    // Detaching the probe means it no longer shares the bridge's process group,
    // so the operator's Ctrl-C reaches the bridge and not the probe. Without an
    // exit hook the probe — and for a wrapper CLI everything it started —
    // outlives the bridge, with nothing left running to time it out.
    //
    // Survival is detected by a file the fake CLI writes AFTER the bridge is
    // gone. Deliberately not by inspecting process lists: `pgrep -f` matches
    // the invoking shell's own command line, which reports a survivor that
    // isn't there.
    const dir = mkdtempSync(join(tmpdir(), 'orphan-'));
    try {
      const survived = join(dir, 'SURVIVED');
      writeFileSync(join(dir, 'claude'), `#!/bin/sh\ntrap "" TERM\nsleep 2\ntouch ${survived}\n`);
      chmodSync(join(dir, 'claude'), 0o755);

      const script = join(dir, 'run.ts');
      writeFileSync(script, `
        import { supportsPartialMessages, setProbeTimeoutForTests } from ${JSON.stringify(CAPABILITIES_MODULE)};
        setProbeTimeoutForTests(60_000);   // must not settle on its own
        supportsPartialMessages().then(() => {});
        setTimeout(() => process.exit(0), 400);
      `);

      await new Promise<void>((resolve) => {
        const child = spawn(VITE_NODE, [script], {
          env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}` },
          stdio: 'ignore',
        });
        child.on('close', () => resolve());
        child.on('error', () => resolve());
      });

      // Past when the fake CLI would have written the marker, had it lived.
      await delay(3_000);
      expect(existsSync(survived), 'the probe outlived the bridge that started it').toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
