/**
 * Machine secrets: the server manages a secret store on this machine through
 * a command the operator named (`--secret-command`, PROTOCOL.md "Secrets on
 * the machine", decision 0020).
 *
 * The bridge keeps no store of its own and knows nothing about where or how
 * secrets are kept. It runs the operator's command, without a shell, with the
 * bridge's own credentials taken out of its environment, and bounded by a
 * timeout:
 *
 *   <command> list                                  -> JSON array on stdout
 *   <command> put <name> [--replace] [--description <text>]   value on stdin
 *   <command> describe <name> -- <text>
 *   <command> remove <name>
 *
 * Exit codes: 0 ok, 2 not_found, 3 exists, 4 invalid_name, anything else
 * failed. A run that is stopped for taking too long is `timeout`: the command
 * may or may not have done its work, so the server lists again before
 * retrying.
 *
 * What this module promises about a value:
 *   - it only ever goes IN, on the command's stdin; never an argument, never
 *     in the environment, never in a file the bridge writes;
 *   - it is never logged and never in an answer or an error: the command's
 *     stdout and stderr are not forwarded, and any text that does go out is
 *     scrubbed of it.
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { stripCredentials } from '../providers/env.js';

/**
 * The revision of the `secret_*` frames this bridge answers
 * (`hello.machine_secrets.revision`). 2: `secret_put` refuses an existing name
 * with `exists` unless it carries `replace: true`, and its answer says whether
 * a secret was `replaced`.
 */
export const MACHINE_SECRETS_REVISION = 2;

/** How long one run of the command may take. */
export const SECRET_COMMAND_TIMEOUT_MS = 15_000;

/** 1 to 64 characters, letter or digit first (JavaScript's `$` does not match before a trailing newline). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
export const MAX_DESCRIPTION = 1000;
export const MAX_VALUE_BYTES = 64 * 1024;
/** More than any list needs; a command printing without end is stopped. */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

export type SecretCode =
  | 'machine_secrets_unsupported'
  | 'no_secret_tool'
  | 'not_found'
  | 'invalid_name'
  | 'invalid_request'
  | 'exists'
  | 'timeout'
  | 'failed';

/** A refusal the server is told about. Its message never holds a value. */
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

/**
 * Whether `path` can be the secret command: an absolute path to an
 * executable regular file. Returns the reason it cannot, or null.
 */
export function secretCommandProblem(path: string): string | null {
  if (!isAbsolute(path)) return `--secret-command must be an absolute path, not "${path}"`;
  try {
    if (!statSync(path).isFile()) return `--secret-command ${path} is not a file`;
    accessSync(path, constants.X_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? `--secret-command ${path} does not exist` : `--secret-command ${path} is not executable`;
  }
  return null;
}

/** A name the command may be given, or the refusal. */
export function checkName(name: unknown): string {
  if (typeof name !== 'string' || !NAME.test(name) || name.includes('..') || name.endsWith('\n')) {
    throw new SecretRefusal(
      'invalid_name',
      'A secret name is 1 to 64 characters: letters, digits, ".", "_" and "-", starting with a letter or digit, without "..".',
    );
  }
  return name;
}

/** A description the command may be given, or the refusal. */
export function checkDescription(description: unknown): string {
  if (typeof description !== 'string') throw new SecretRefusal('invalid_request', 'The description must be text.');
  if ([...description].length > MAX_DESCRIPTION) {
    throw new SecretRefusal('invalid_request', `A description is at most ${MAX_DESCRIPTION} characters.`);
  }
  if (description.startsWith('-')) {
    throw new SecretRefusal('invalid_request', 'A description may not start with "-".');
  }
  if (description.includes('\0')) throw new SecretRefusal('invalid_request', 'A description may not contain a NUL character.');
  return description;
}

function checkValue(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new SecretRefusal('invalid_request', 'A secret needs a value.');
  if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
    throw new SecretRefusal('invalid_request', `A secret value is at most ${MAX_VALUE_BYTES / 1024} KiB.`);
  }
  return value;
}

/** Replace every occurrence of `secret` in `text`. */
export function scrub(text: string, secret: string | undefined): string {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

interface RunResult {
  code: number | null;
  stdout: string;
}

export interface MachineSecretsOptions {
  /** Absolute path of the operator's command. */
  command: string;
  /** Per run; default SECRET_COMMAND_TIMEOUT_MS. */
  timeoutMs?: number;
  /** The environment to start from; default process.env. Credentials are taken out. */
  env?: NodeJS.ProcessEnv;
}

export class MachineSecrets {
  readonly command: string;
  private readonly timeoutMs: number;
  private readonly baseEnv: NodeJS.ProcessEnv;

  constructor(options: MachineSecretsOptions) {
    this.command = options.command;
    this.timeoutMs = options.timeoutMs ?? SECRET_COMMAND_TIMEOUT_MS;
    this.baseEnv = options.env ?? process.env;
  }

  async list(): Promise<SecretRow[]> {
    const run = await this.run(['list']);
    this.throwForExit(run.code, 'list');
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.stdout);
    } catch {
      throw new SecretRefusal('failed', 'The secret command did not print a JSON list.');
    }
    if (!Array.isArray(parsed)) throw new SecretRefusal('failed', 'The secret command did not print a JSON list.');
    const rows: SecretRow[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null || typeof (entry as { name?: unknown }).name !== 'string') {
        throw new SecretRefusal('failed', 'The secret command printed a list entry without a name.');
      }
      const e = entry as Record<string, unknown>;
      rows.push({
        name: e['name'] as string,
        description: typeof e['description'] === 'string' ? e['description'] : null,
        updated_at: typeof e['updated_at'] === 'string' ? e['updated_at'] : null,
      });
    }
    return rows;
  }

  /**
   * Add a secret, or replace one when `replace` is true. An existing name is
   * refused with `exists` before the value goes anywhere, and again if the
   * command itself says so (exit 3).
   */
  async put(name: unknown, value: unknown, options: { replace?: unknown; description?: unknown } = {}): Promise<{ replaced: boolean }> {
    const checkedName = checkName(name);
    const checkedValue = checkValue(value);
    const description = options.description === undefined || options.description === null || options.description === ''
      ? undefined
      : checkDescription(options.description);
    const replace = options.replace === true;

    const existed = (await this.list()).some((row) => row.name === checkedName);
    if (existed && !replace) {
      throw new SecretRefusal('exists', `A secret called "${checkedName}" already exists; replace it deliberately.`);
    }

    const args = ['put', checkedName, ...(replace ? ['--replace'] : []), ...(description !== undefined ? ['--description', description] : [])];
    const run = await this.run(args, checkedValue);
    this.throwForExit(run.code, 'put', checkedValue);
    let replaced = existed;
    const out = run.stdout.trim();
    if (out !== '') {
      try {
        const parsed = JSON.parse(out) as { replaced?: unknown };
        if (typeof parsed?.replaced === 'boolean') replaced = parsed.replaced;
      } catch {
        // Anything else on stdout is the command's own business; not forwarded.
      }
    }
    return { replaced };
  }

  async describe(name: unknown, description: unknown): Promise<void> {
    const checkedName = checkName(name);
    const text = checkDescription(description);
    const run = await this.run(['describe', checkedName, '--', text]);
    this.throwForExit(run.code, 'describe');
  }

  async remove(name: unknown): Promise<void> {
    const checkedName = checkName(name);
    const run = await this.run(['remove', checkedName]);
    this.throwForExit(run.code, 'remove');
  }

  private throwForExit(code: number | null, op: string, value?: string): void {
    if (code === 0) return;
    if (code === 2) throw new SecretRefusal('not_found', 'No secret by that name.');
    if (code === 3) throw new SecretRefusal('exists', 'A secret by that name already exists; replace it deliberately.');
    if (code === 4) throw new SecretRefusal('invalid_name', 'The secret command refused the name.');
    throw new SecretRefusal('failed', scrub(`The secret command failed on ${op} (exit ${code ?? 'signal'}).`, value));
  }

  /**
   * One run of the command. stdin carries `input` (the value) or nothing.
   * stderr is drained and dropped: it is the command's to log, and it might
   * echo what it was given.
   */
  private run(args: string[], input?: string): Promise<RunResult> {
    const env = stripCredentials({ ...this.baseEnv });
    for (const key of Object.keys(env)) {
      if (key.startsWith('CLAUDE_CODE_OAUTH_TOKEN') || key === 'AI_BRIDGE_SECRET_COMMAND') delete env[key];
    }
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.command, args, { shell: false, env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        reject(new SecretRefusal('no_secret_tool', 'The secret command could not be started.'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      let timedOut = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);

      child.stdout!.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_STDOUT_BYTES) {
          child.kill('SIGKILL');
          return;
        }
        chunks.push(chunk);
      });
      child.stderr!.on('data', () => { /* dropped on purpose */ });
      child.on('error', (err: NodeJS.ErrnoException) => {
        finish(() => reject(err.code === 'ENOENT' || err.code === 'EACCES'
          ? new SecretRefusal('no_secret_tool', 'The secret command is not there or not executable.')
          : new SecretRefusal('failed', 'The secret command could not be run.')));
      });
      child.on('close', (code) => {
        finish(() => {
          if (timedOut) {
            reject(new SecretRefusal(
              'timeout',
              `The secret command did not finish within ${Math.round(this.timeoutMs / 1000)} s and was stopped; the result is unknown, list again before retrying.`,
            ));
          } else if (size > MAX_STDOUT_BYTES) {
            reject(new SecretRefusal('failed', 'The secret command printed too much.'));
          } else {
            resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
          }
        });
      });
      // A command that never reads stdin closes it; that is not our error.
      child.stdin!.on('error', () => { /* EPIPE: the exit code says what happened */ });
      if (input !== undefined) child.stdin!.end(input);
      else child.stdin!.end();
    });
  }
}
