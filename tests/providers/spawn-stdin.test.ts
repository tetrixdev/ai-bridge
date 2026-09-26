import { describe, it, expect } from 'vitest';
import { execFileSync, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { ProviderAdapter } from '../../src/providers/base.js';
import type { AdapterStreamEvent, ExecutionContext, SpawnOptions } from '../../src/providers/base.js';
import type { ModelInfo } from '../../src/protocol/types.js';

/**
 * Regression test for the stdin EPIPE crash: when Claude (or any CLI) is fed its
 * prompt via stdin but exits before reading it, the async write would emit an
 * unhandled 'error' on the stdin stream → uncaughtException → the whole bridge
 * dies. spawnCli must attach an error handler so a fast-exiting child can never
 * crash the process. We drive a real, immediately-exiting child with a large
 * payload (the size that reliably triggers EPIPE) and assert the bridge survives.
 */
class TestAdapter extends ProviderAdapter {
  readonly providerName = 'test';
  execute(_c: ExecutionContext, _e: (event: AdapterStreamEvent) => void): Promise<string | null> {
    return Promise.resolve(null);
  }
  listModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }
  // Expose the protected spawn for testing.
  public spawn(
    command: string,
    args: string[],
    stdinInput?: string,
    options?: SpawnOptions,
  ): ChildProcessByStdio<Writable | null, Readable, Readable> {
    return this.spawnCli(command, args, process.env, stdinInput, undefined, options);
  }
}

describe('spawnCli stdin handling', () => {
  it('does not crash the process when the child exits before reading a large stdin payload', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (err: Error): void => {
      uncaught.push(err);
    };
    process.on('uncaughtException', onUncaught);

    try {
      const adapter = new TestAdapter();
      // A child that exits instantly without ever reading stdin; a multi-MB
      // payload guarantees the write outlives the child → EPIPE if unguarded.
      const bigPayload = 'x'.repeat(4 * 1024 * 1024);
      const child = adapter.spawn(process.execPath, ['-e', 'process.exit(0)'], bigPayload);

      await new Promise<void>((resolve) => child.on('close', () => resolve()));
      // Give any deferred error event a tick to surface as uncaughtException.
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(uncaught).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});

/**
 * Reads stdin line by line, prints `line:<text>` for each and `eof` when stdin
 * closes, then exits.
 */
const ECHO_STDIN = `
process.stdin.setEncoding('utf8');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) { console.log('line:' + buf.slice(0, i)); buf = buf.slice(i + 1); }
});
process.stdin.on('end', () => { console.log('eof'); process.exit(0); });
`;

function collect(child: ChildProcessByStdio<Writable | null, Readable, Readable>): { out: () => string; closed: Promise<void> } {
  let out = '';
  child.stdout.on('data', (c: Buffer) => { out += c.toString(); });
  const closed = new Promise<void>((resolve) => child.on('close', () => resolve()));

  return { out: () => out, closed };
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('spawnCli stdin: closed after the prompt, or kept open', () => {
  it('closes stdin right after the prompt by default, as every CLI in its default mode needs', async () => {
    const child = new TestAdapter().spawn(process.execPath, ['-e', ECHO_STDIN], 'the prompt\n');
    const { out, closed } = collect(child);
    await closed;

    expect(out()).toBe('line:the prompt\neof\n');
  });

  it('keeps stdin open when asked, so more messages can follow, until the caller closes it', async () => {
    const child = new TestAdapter().spawn(process.execPath, ['-e', ECHO_STDIN], 'first\n', { keepStdinOpen: true });
    const { out, closed } = collect(child);

    await until(() => out().includes('line:first'));
    // Still open: nothing said eof, and the child is still running.
    await new Promise((r) => setTimeout(r, 100));
    expect(out()).toBe('line:first\n');
    expect(child.exitCode).toBeNull();

    child.stdin!.write('second\n');
    await until(() => out().includes('line:second'));
    child.stdin!.end();
    await closed;

    expect(out()).toBe('line:first\nline:second\neof\n');
  });

  it.skipIf(process.platform === 'win32')('spawns the CLI as the leader of its own process group', async () => {
    const child = new TestAdapter().spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);
    const { closed } = collect(child);
    try {
      const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(child.pid)], { encoding: 'utf8' }).trim());
      expect(pgid).toBe(child.pid);
    } finally {
      process.kill(-child.pid!, 'SIGKILL');
      await closed;
    }
  });
});
