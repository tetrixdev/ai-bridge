/**
 * The secret store on this machine, managed for the server (PROTOCOL.md,
 * "Secrets on the machine").
 *
 * The machine keeps its secrets itself: one file per secret in `~/.secrets`
 * (the file name is the label, readable only by its owner) and a `secret`
 * command that lists them, adds them, describes them and removes them, and
 * deliberately has no way to print one. This module only runs that command on
 * the server's behalf, so the store, its rules and its guards stay in one
 * place (the iac-server toolkit installs them).
 *
 * What it promises:
 *   - A value only ever goes IN. It is written to a new file only the owner can
 *     read, inside the store's own `.incoming` folder, and moved into place by
 *     `secret add --move`; it is never an argument, never in the environment
 *     of the command, never logged and never in an error.
 *   - Names are checked before anything runs: one plain label, the same rule
 *     the server and the `secret` command use. Nothing can climb out.
 *   - The command is started without a shell, so nothing in a name or a
 *     description is ever interpreted.
 */

import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The revision of the `secret_*` frames this bridge answers (hello.machine_secrets). */
export const MACHINE_SECRETS_REVISION = 1;

export const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const MAX_DESCRIPTION = 1000;
export const MAX_VALUE_BYTES = 64 * 1024;

export type SecretCode = 'no_secret_tool' | 'not_found' | 'invalid_name' | 'invalid_request' | 'exists' | 'failed';

/** A refusal the server is told about, with a text that never holds a value. */
export class SecretRefusal extends Error {
  constructor(public readonly code: SecretCode, message: string) {
    super(message);
    this.name = 'SecretRefusal';
  }
}

export interface SecretRow {
  name: string;
  description: string | null;
  updated_at: string | null;
}

export interface SecretStoreOptions {
  /** The `secret` command. Default: `~/.local/bin/secret`, else `secret` on PATH. */
  bin?: string;
  /** The store's folder, for the `.incoming` files. Default: `~/.secrets`. */
  store?: string;
  /** How long one command may take (ms). */
  timeoutMs?: number;
}

type Run = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export function validName(name: unknown): name is string {
  return typeof name === 'string' && SECRET_NAME.test(name) && !name.includes('..');
}

export class MachineSecretStore {
  private readonly bin: string;
  private readonly store: string;
  private readonly timeoutMs: number;

  constructor(options: SecretStoreOptions = {}, private readonly runner?: Run) {
    const local = join(homedir(), '.local', 'bin', 'secret');
    this.bin = options.bin ?? (existsSync(local) ? local : 'secret');
    this.store = options.store ?? join(homedir(), '.secrets');
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async list(): Promise<SecretRow[]> {
    const json = await this.run(['list', '--json']);
    if (json.code === 0) {
      try {
        return rowsOf(JSON.parse(json.stdout));
      } catch {
        // An older tool printed its table instead; read that.
      }
    }

    const plain = await this.run(['list']);
    if (plain.code !== 0) throw this.refusal(plain.stderr);

    return rowsOfTable(plain.stdout);
  }

  async put(name: unknown, value: unknown, description: unknown): Promise<void> {
    if (!validName(name)) throw new SecretRefusal('invalid_name', 'That is not a valid secret name.');
    if (typeof value !== 'string' || value === '' || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES || value.includes('\0')) {
      throw new SecretRefusal('invalid_request', `A secret is 1 to ${MAX_VALUE_BYTES} bytes.`);
    }
    const desc = this.description(description, false);

    const incoming = join(this.store, '.incoming');
    mkdirSync(incoming, { recursive: true, mode: 0o700 });
    chmodSync(this.store, 0o700);
    chmodSync(incoming, 0o700);

    const tmp = join(incoming, `${name}.${randomBytes(6).toString('hex')}`);
    try {
      await writeFile(tmp, value, { mode: 0o600, flag: 'wx' });
      const args = ['add', name, tmp, '--move', '--force'];
      if (desc !== null) args.push('--desc', desc);
      const done = await this.run(args);
      if (done.code !== 0) throw this.refusal(done.stderr);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  async describe(name: unknown, description: unknown): Promise<void> {
    if (!validName(name)) throw new SecretRefusal('invalid_name', 'That is not a valid secret name.');
    const desc = this.description(description, true) as string;
    const done = await this.run(['describe', name, desc]);
    if (done.code !== 0) throw this.refusal(done.stderr);
  }

  async remove(name: unknown): Promise<void> {
    if (!validName(name)) throw new SecretRefusal('invalid_name', 'That is not a valid secret name.');
    const done = await this.run(['remove', name, '--yes']);
    if (done.code !== 0) throw this.refusal(done.stderr);
  }

  /** Whether the store's folder exists and only its owner can open it. */
  folderLocked(): boolean | null {
    try {
      return (statSync(this.store).mode & 0o077) === 0;
    } catch {
      return null;
    }
  }

  private description(value: unknown, required: boolean): string | null {
    if (value === undefined || value === null || value === '') {
      if (required) throw new SecretRefusal('invalid_request', 'A description is required.');

      return null;
    }
    if (typeof value !== 'string' || value.length > MAX_DESCRIPTION || value.includes('\0')) {
      throw new SecretRefusal('invalid_request', `A description is text of at most ${MAX_DESCRIPTION} characters.`);
    }

    return value.replace(/[\r\n]+/g, ' ').trim();
  }

  /** The tool's own message (it never prints a value) turned into a code. */
  private refusal(stderr: string): SecretRefusal {
    const text = stderr.replace(/^secret:\s*/m, '').trim().slice(0, 300) || 'The secret command failed.';
    if (/no secret named/i.test(text)) return new SecretRefusal('not_found', text);
    if (/invalid name/i.test(text)) return new SecretRefusal('invalid_name', text);
    if (/already exists/i.test(text)) return new SecretRefusal('exists', text);

    return new SecretRefusal('failed', text);
  }

  private run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    if (this.runner) return this.runner(args);

    return new Promise((resolve, reject) => {
      execFile(this.bin, args, { timeout: this.timeoutMs, maxBuffer: 1024 * 1024, shell: false }, (error, stdout, stderr) => {
        const err = error as (NodeJS.ErrnoException & { code?: number | string }) | null;
        if (err && err.code === 'ENOENT') {
          reject(new SecretRefusal('no_secret_tool', 'The secret command is not installed on this machine.'));

          return;
        }
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }
}

function rowsOf(parsed: unknown): SecretRow[] {
  const list = Array.isArray(parsed) ? parsed : (parsed as { secrets?: unknown })?.secrets;
  if (!Array.isArray(list)) return [];

  const rows: SecretRow[] = [];
  for (const row of list.slice(0, 500)) {
    const r = row as Record<string, unknown>;
    if (!validName(r?.['name'])) continue;
    rows.push({
      name: r['name'] as string,
      description: typeof r['description'] === 'string' && r['description'] !== '' ? (r['description'] as string).slice(0, MAX_DESCRIPTION) : null,
      updated_at: typeof r['updated_at'] === 'string' && r['updated_at'] !== '' ? (r['updated_at'] as string).slice(0, 40) : null,
    });
  }

  return rows;
}

/** `name  YYYY-MM-DD  description` lines, as `secret list` printed before `--json`. */
function rowsOfTable(stdout: string): SecretRow[] {
  const rows: SecretRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\s+(\d{4}-\d{2}-\d{2})\s+(.*)$/.exec(line.trimEnd());
    if (!m || !validName(m[1])) continue;
    const description = m[3]!.trim();
    rows.push({
      name: m[1]!,
      description: description === '' || description === '(no description)' ? null : description.slice(0, MAX_DESCRIPTION),
      updated_at: m[2]!,
    });
  }

  return rows.slice(0, 500);
}
