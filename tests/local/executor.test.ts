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
