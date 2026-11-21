/**
 * Machine secrets through the operator's command (src/secrets/command.ts,
 * decision 0020), against a real executable stand-in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MAX_DESCRIPTION,
  MachineSecrets,
  SecretRefusal,
  checkName,
  scrub,
  secretCommandProblem,
} from '../../src/secrets/command.js';
import { makeFakeCommand, type FakeCommand } from './fake-command.js';

const VALUE = 'sk-test-0123456789-very-secret';

let fake: FakeCommand;
let secrets: MachineSecrets;

beforeEach(() => {
  fake = makeFakeCommand();
  secrets = new MachineSecrets({
    command: fake.path,
    env: { ...process.env, AI_BRIDGE_TOKEN: 'bridge-tok', ENGRAM_TOKEN: 'engram-tok', CLAUDE_CODE_OAUTH_TOKEN: 'claude-tok', KEEP_ME: 'yes' },
  });
});

afterEach(() => fake.cleanup());

async function refusal(promise: Promise<unknown>): Promise<SecretRefusal> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SecretRefusal);
    return err as SecretRefusal;
  }
  throw new Error('expected a refusal');
}

describe('the command', () => {
  it('must be an absolute path to an executable file', () => {
    expect(secretCommandProblem('secret')).toMatch(/absolute/);
    expect(secretCommandProblem('/nonexistent/secret')).toMatch(/does not exist/);
    expect(secretCommandProblem(fake.dir)).toMatch(/not a file/);
    expect(secretCommandProblem(fake.path)).toBeNull();
  });

  it('runs without the bridge credentials in its environment', async () => {
    await secrets.list();
    const env = fake.runs()[0]!.env;
    expect(env['AI_BRIDGE_TOKEN']).toBeUndefined();
    expect(env['ENGRAM_TOKEN']).toBeUndefined();
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();
    expect(env['KEEP_ME']).toBe('yes');
  });
});

describe('put', () => {
  it('hands the value only on stdin: never in argv, the environment or a file', async () => {
    const result = await secrets.put('openai_key', VALUE, { description: 'OpenAI key for the app' });
    expect(result).toEqual({ replaced: false });
    const put = fake.runs().find((r) => r.argv[0] === 'put')!;
    expect(put.argv).toEqual(['put', 'openai_key', '--description', 'OpenAI key for the app']);
    expect(put.stdin).toBe(VALUE);
    expect(JSON.stringify(put.argv)).not.toContain(VALUE);
    expect(JSON.stringify(put.env)).not.toContain(VALUE);
    // and the module has no way to write a file at all
    const source = readFileSync(new URL('../../src/secrets/command.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/writeFile|appendFile|createWriteStream|mkdtemp|openSync/);
    expect(fake.store()['openai_key']).toEqual({ value: VALUE, description: 'OpenAI key for the app' });
  });

  it('refuses an existing name with exists, before the value goes anywhere', async () => {
    await secrets.put('db_password', VALUE);
    const runsBefore = fake.runs().length;
    const err = await refusal(secrets.put('db_password', 'another'));
    expect(err.code).toBe('exists');
    const after = fake.runs().slice(runsBefore);
    expect(after.map((r) => r.argv[0])).toEqual(['list']);
    expect(fake.store()['db_password']!.value).toBe(VALUE);
  });

  it('replaces deliberately with replace: true, and says so', async () => {
    await secrets.put('db_password', VALUE);
    const result = await secrets.put('db_password', 'new-value', { replace: true });
    expect(result).toEqual({ replaced: true });
    const put = fake.runs().filter((r) => r.argv[0] === 'put').at(-1)!;
    expect(put.argv).toEqual(['put', 'db_password', '--replace']);
    expect(fake.store()['db_password']!.value).toBe('new-value');
  });

  it('answers exists when the command itself says so (exit 3)', async () => {
    fake.set('exit', '3');
    const err = await refusal(secrets.put('x', VALUE, { replace: true }));
    // list answered 3 too, which the bridge reads as the command's exists
    expect(err.code).toBe('exists');
  });

  it('never forwards stderr, and scrubs the value out of any error', async () => {
    await secrets.list();
    fake.set('stderr', 'oops, got: ');
    fake.set('exit', '1');
    const err = await refusal(secrets.put('k', VALUE));
    expect(err.code).toBe('failed');
    expect(err.message).not.toContain(VALUE);
    expect(err.message).not.toContain('oops');
  });

  it('refuses a value that is empty or over 64 KiB', async () => {
    expect((await refusal(secrets.put('k', ''))).code).toBe('invalid_request');
    expect((await refusal(secrets.put('k', 'x'.repeat(64 * 1024 + 1)))).code).toBe('invalid_request');
    expect(fake.runs()).toEqual([]);
  });
});

describe('names and descriptions', () => {
  it.each(['', '.hidden', '-x', 'a/b', 'a\\b', '../x', 'a..b', 'x\n', 'a b', 'x'.repeat(65)])('refuses the name %j before anything runs', async (name) => {
    expect((await refusal(secrets.put(name, VALUE))).code).toBe('invalid_name');
    expect((await refusal(secrets.describe(name, 'd'))).code).toBe('invalid_name');
    expect((await refusal(secrets.remove(name))).code).toBe('invalid_name');
    expect(fake.runs()).toEqual([]);
  });

  it('accepts plain names', () => {
    for (const name of ['a', 'A1', 'openai_key', 'db.password-2', 'x'.repeat(64)]) expect(checkName(name)).toBe(name);
  });

  it('refuses a description starting with "-"', async () => {
    expect((await refusal(secrets.put('k', VALUE, { description: '--force' }))).code).toBe('invalid_request');
    expect((await refusal(secrets.describe('k', '-x'))).code).toBe('invalid_request');
    expect(fake.runs()).toEqual([]);
  });

  it('counts a description in code points, not UTF-16 units', async () => {
    await secrets.put('k', VALUE);
    await secrets.describe('k', '🔑'.repeat(MAX_DESCRIPTION));
    expect(fake.store()['k']!.description).toBe('🔑'.repeat(MAX_DESCRIPTION));
    expect((await refusal(secrets.describe('k', '🔑'.repeat(MAX_DESCRIPTION + 1)))).code).toBe('invalid_request');
  });

  it('passes the description after "--"', async () => {
    await secrets.put('k', VALUE);
    await secrets.describe('k', 'what it is for');
    expect(fake.runs().at(-1)!.argv).toEqual(['describe', 'k', '--', 'what it is for']);
  });
});

describe('list, describe and remove', () => {
  it('lists name, description and updated_at, never a value', async () => {
    await secrets.put('a', VALUE, { description: 'first' });
    const rows = await secrets.list();
    expect(rows).toEqual([{ name: 'a', description: 'first', updated_at: '2026-11-21T10:00:00Z' }]);
    expect(JSON.stringify(rows)).not.toContain(VALUE);
  });

  it('refuses a list that is not a JSON array', async () => {
    fake.set('stdout', 'NAME  DESCRIPTION\n');
    expect((await refusal(secrets.list())).code).toBe('failed');
    fake.set('stdout', '{"name":"a"}');
    expect((await refusal(secrets.list())).code).toBe('failed');
  });

  it('maps exit codes: 2 not_found, 4 invalid_name, other failed', async () => {
    expect((await refusal(secrets.remove('missing'))).code).toBe('not_found');
    expect((await refusal(secrets.describe('missing', 'd'))).code).toBe('not_found');
    fake.set('exit', '4');
    expect((await refusal(secrets.remove('k'))).code).toBe('invalid_name');
    fake.set('exit', '7');
    expect((await refusal(secrets.remove('k'))).code).toBe('failed');
  });

  it('removes', async () => {
    await secrets.put('k', VALUE);
    await secrets.remove('k');
    expect(fake.store()).toEqual({});
    expect(fake.runs().at(-1)!.argv).toEqual(['remove', 'k']);
  });
});

describe('timeout and a missing command', () => {
  it('stops a run that takes too long and answers timeout: result unknown', async () => {
    const slow = new MachineSecrets({ command: fake.path, timeoutMs: 300 });
    fake.set('sleep', '5');
    const started = Date.now();
    const err = await refusal(slow.remove('k'));
    expect(err.code).toBe('timeout');
    expect(err.message).toMatch(/list again before retrying/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('answers no_secret_tool when the command has gone', async () => {
    fake.cleanup();
    expect((await refusal(secrets.list())).code).toBe('no_secret_tool');
  });
});

describe('scrub', () => {
  it('replaces every occurrence', () => {
    expect(scrub('a SECRET b SECRET', 'SECRET')).toBe('a [redacted] b [redacted]');
    expect(scrub('text', undefined)).toBe('text');
  });
});
