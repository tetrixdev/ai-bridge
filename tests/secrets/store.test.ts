/**
 * The machine's secret store, run for the server (secrets/store.ts): a value
 * only goes in, through a file and never an argument; names are checked before
 * anything runs; the tool's own refusals become codes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MachineSecretStore, SecretRefusal } from '../../src/secrets/store.js';

const VALUE = 'Zq8-not-a-real-secret-4471';

let base: string;
let store: string;
let bin: string;
let calls: string;

/** A stand-in for the `secret` command: records its arguments, keeps files like the real one. */
function fakeTool(extra = ''): void {
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const store = ${JSON.stringify(store)};
${extra}
if (args[0] === 'list' && args[1] === '--json') {
  const names = fs.readdirSync(store).filter((n) => !n.startsWith('.'));
  process.stdout.write(JSON.stringify(names.map((n) => ({ name: n, description: 'd-' + n, updated_at: '2026-11-21' }))));
} else if (args[0] === 'add') {
  const [, name, src] = args;
  fs.renameSync(src, path.join(store, name));
} else if (args[0] === 'remove') {
  if (!fs.existsSync(path.join(store, args[1]))) { process.stderr.write("secret: no secret named '" + args[1] + "' — see: secret list\\n"); process.exit(1); }
  fs.unlinkSync(path.join(store, args[1]));
}
`);
  chmodSync(bin, 0o755);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'secrets-'));
  store = join(base, '.secrets');
  bin = join(base, 'secret');
  calls = join(base, 'calls.log');
  mkdirSync(store, { mode: 0o700 });
  writeFileSync(calls, '');
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

const callsMade = (): string[][] => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);

describe('put', () => {
  it('stores the value through a file, never as an argument, and leaves no copy behind', async () => {
    fakeTool();
    const secrets = new MachineSecretStore({ bin, store });

    await secrets.put('mailtrap', VALUE, 'SMTP\npassword');

    expect(readFileSync(join(store, 'mailtrap'), 'utf8')).toBe(VALUE);
    const [args] = callsMade();
    expect(args!.slice(0, 2)).toEqual(['add', 'mailtrap']);
    expect(args).toContain('--move');
    expect(args).toContain('--force');
    expect(args!.slice(-2)).toEqual(['--desc', 'SMTP password']);
    expect(JSON.stringify(callsMade())).not.toContain(VALUE);
    expect(readdirSync(join(store, '.incoming'))).toEqual([]);
    expect(statSync(join(store, '.incoming')).mode & 0o077).toBe(0);
  });

  it('removes the incoming file when the tool refuses, and says why without the value', async () => {
    fakeTool(`if (args[0] === 'add') { process.stderr.write("secret: '" + args[1] + "' already exists (use --force to replace)\\n"); process.exit(1); }`);
    const secrets = new MachineSecretStore({ bin, store });

    const error = await secrets.put('mailtrap', VALUE, null).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SecretRefusal);
    expect((error as SecretRefusal).code).toBe('exists');
    expect((error as Error).message).not.toContain(VALUE);
    expect(readdirSync(join(store, '.incoming'))).toEqual([]);
  });

  it('refuses a name that could leave the store, and an empty value, before running anything', async () => {
    fakeTool();
    const secrets = new MachineSecretStore({ bin, store });

    for (const name of ['../x', '.hidden', 'a/b', '', 'x'.repeat(65), 'a..b']) {
      await expect(secrets.put(name, VALUE, null)).rejects.toMatchObject({ code: 'invalid_name' });
    }
    await expect(secrets.put('ok', '', null)).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(secrets.put('ok', 'a\0b', null)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(callsMade()).toEqual([]);
  });
});

describe('list, describe and remove', () => {
  it('lists names, descriptions and dates', async () => {
    fakeTool();
    writeFileSync(join(store, 'github-token'), 'x');
    const secrets = new MachineSecretStore({ bin, store });

    expect(await secrets.list()).toEqual([{ name: 'github-token', description: 'd-github-token', updated_at: '2026-11-21' }]);
  });

  it('reads the table an older tool prints when it does not know --json', async () => {
    fakeTool(`if (args[1] === '--json') { process.stderr.write('unknown option\\n'); process.exit(2); }
if (args[0] === 'list') { process.stdout.write('github-token  2026-11-14  For: the token\\nsentry        2026-11-16  (no description)\\n'); process.exit(0); }`);
    const secrets = new MachineSecretStore({ bin, store });

    expect(await secrets.list()).toEqual([
      { name: 'github-token', description: 'For: the token', updated_at: '2026-11-14' },
      { name: 'sentry', description: null, updated_at: '2026-11-16' },
    ]);
  });

  it('turns a missing secret into not_found', async () => {
    fakeTool();
    const secrets = new MachineSecretStore({ bin, store });

    await expect(secrets.remove('nothing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('requires a description to describe', async () => {
    fakeTool();
    const secrets = new MachineSecretStore({ bin, store });

    await expect(secrets.describe('mailtrap', '')).rejects.toMatchObject({ code: 'invalid_request' });
    await secrets.describe('mailtrap', 'For: Iris');
    expect(callsMade()).toEqual([['describe', 'mailtrap', 'For: Iris']]);
  });

  it('says the tool is missing when it is not installed', async () => {
    const secrets = new MachineSecretStore({ bin: join(base, 'nope'), store });

    await expect(secrets.list()).rejects.toMatchObject({ code: 'no_secret_tool' });
    expect(existsSync(join(store, '.incoming'))).toBe(false);
  });
});
