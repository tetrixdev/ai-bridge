import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLocalTool } from '../../src/local/executor.js';

const base = { name: 't', args: [] as string[], toolArgs: {}, secrets: [], timeoutMs: 10_000 };

describe('running a tool locally', () => {
  it('injects secrets as environment and redacts them on the way out', async () => {
    const res = await runLocalTool({
      ...base,
      command: 'sh',
      args: ['-c', 'echo "value is $DB_PASSWORD"'],
      secrets: [{ name: 'DB_PASSWORD', value: 'swordfish-9182' }],
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain('swordfish-9182');
    expect(res.stdout.trim()).toBe('value is [redacted: DB_PASSWORD]');
  });

  it('redacts stderr too, which is where a credential usually leaks by accident', async () => {
    const res = await runLocalTool({
      ...base,
      command: 'sh',
      args: ['-c', 'echo "connect failed for $PGPASS" >&2; exit 3'],
      secrets: [{ name: 'PGPASS', value: 'swordfish-9182' }],
    });
    expect(res.exitCode).toBe(3);
    expect(res.stderr).not.toContain('swordfish-9182');
    expect(res.stderr).toContain('[redacted: PGPASS]');
  });

  it('passes model arguments as environment, never as a command line', async () => {
    // If arguments were composed into a shell string this would delete
    // something. There is no shell, so it is a value a program received.
    const res = await runLocalTool({
      ...base,
      command: 'sh',
      args: ['-c', 'printf %s "$ENGRAM_ARG_TARGET"'],
      toolArgs: { target: '; rm -rf /tmp/nope; echo pwned' },
    });
    expect(res.stdout).toBe('; rm -rf /tmp/nope; echo pwned');
  });

  it('kills a tool that will not finish', async () => {
    const res = await runLocalTool({ ...base, command: 'sleep', args: ['30'], timeoutMs: 300 });
    expect(res.timedOut).toBe(true);
  });

  it('reports a command that does not exist rather than throwing', async () => {
    const res = await runLocalTool({ ...base, command: 'engram-no-such-binary', args: [] });
    expect(res.exitCode).toBeNull();
    expect(res.stderr).toContain('ENOENT');
  });
});

describe('what a tool inherits', () => {
  it('does not hand the bridge its own credentials', async () => {
    // The bridge's environment holds ENGRAM_TOKEN and AI_BRIDGE_TOKEN, and
    // scrubbing cannot protect them: it only knows the secrets the tool was
    // granted. An `env` dump would have leaked them in the clear.
    process.env['ENGRAM_TOKEN'] = 'eng_should_never_be_visible';
    process.env['AI_BRIDGE_TOKEN'] = 'aib_should_never_be_visible';
    try {
      const res = await runLocalTool({ ...base, command: 'sh', args: ['-c', 'env'] });
      expect(res.stdout).not.toContain('should_never_be_visible');
      expect(res.stdout).toContain('PATH=');
    } finally {
      delete process.env['ENGRAM_TOKEN'];
      delete process.env['AI_BRIDGE_TOKEN'];
    }
  });

  it('refuses a secret named after a variable that picks the binary', async () => {
    const res = await runLocalTool({
      ...base,
      command: 'sh',
      args: ['-c', 'printf %s "$PATH"'],
      secrets: [{ name: 'PATH', value: '/attacker/bin' }],
    });
    expect(res.stdout).not.toBe('/attacker/bin');
  });
});

describe('a tool that outlives its own kill', () => {
  it('kills what the tool started, not only the tool', async () => {
    // child.kill signals the direct child alone. The shell below backgrounds a
    // process that touches a marker a second after the timeout has already
    // fired: without a process group to signal, that process survived the
    // timeout and kept running as the user, long after the bridge reported the
    // tool killed. The marker is what it running looks like from here.
    const dir = mkdtempSync(join(tmpdir(), 'engram-exec-'));
    const marker = join(dir, 'survived-the-kill');
    try {
      const res = await runLocalTool({
        ...base,
        command: 'sh',
        args: ['-c', `sh -c "sleep 1; : > ${marker}" & sleep 30`],
        timeoutMs: 300,
      });
      expect(res.timedOut).toBe(true);
      await new Promise((r) => setTimeout(r, 2_000));
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('settles when something it left behind holds stdout open', async () => {
    // `close` fires only once every writer on the pipes is gone. This tool
    // exits at once but leaves a background process holding stdout, so waiting
    // for `close` meant waiting for that process: runLocalTool stayed pending
    // and the model's tool call hung, here for five seconds and in the real
    // case for as long as the leaked process lives.
    const started = Date.now();
    const res = await runLocalTool({
      ...base,
      command: 'sh',
      args: ['-c', 'sleep 5 & echo done'],
      timeoutMs: 30_000,
    });
    expect(res.stdout.trim()).toBe('done');
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  }, 15_000);
});
