import { spawn } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import { scrub, type Redaction } from './scrub.js';

const log = createLogger('LocalTool');

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface LocalRun {
  /** Tool name, for logs and for naming a redaction. */
  name: string;
  command: string;
  /** Arguments fixed by the tool definition, before the model's own. */
  args: string[];
  /** What the model passed, injected as ENGRAM_ARG_* rather than a command line. */
  toolArgs: Record<string, unknown>;
  /** Resolved secrets, injected as environment and redacted from the output. */
  secrets: Redaction[];
  cwd?: string;
  timeoutMs?: number;
}

export interface LocalResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run one local tool.
 *
 * The model's arguments are passed as ENVIRONMENT VARIABLES, never composed
 * into a shell string. There is no shell here at all: `spawn` with an argv
 * array means a value containing `; rm -rf /` is an ordinary string that a
 * program receives, not something the system interprets. Composing a command
 * line from model output is the one mistake in this file that would matter, and
 * the shape of the API is what prevents it rather than a rule someone follows.
 */
export async function runLocalTool(run: LocalRun): Promise<LocalResult> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const s of run.secrets) env[s.name] = s.value;
  for (const [k, v] of Object.entries(run.toolArgs)) {
    env[`ENGRAM_ARG_${k.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] =
      typeof v === 'string' ? v : JSON.stringify(v);
  }

  log.info('running local tool', {
    name: run.name,
    command: run.command,
    secrets: run.secrets.map((s) => s.name),
  });

  return new Promise<LocalResult>((resolve) => {
    const child = spawn(run.command, run.args, {
      cwd: run.cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const cap = (current: string, chunk: Buffer): string =>
      current.length >= MAX_OUTPUT_BYTES ? current : current + chunk.toString('utf8');

    child.stdout.on('data', (c: Buffer) => { stdout = cap(stdout, c); });
    child.stderr.on('data', (c: Buffer) => { stderr = cap(stderr, c); });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, run.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Scrubbing happens here, at the one place output leaves this process,
      // rather than at each caller. A caller that forgot would leak silently.
      resolve({
        exitCode,
        stdout: scrub(stdout, run.secrets),
        stderr: scrub(stderr, run.secrets),
        timedOut,
      });
    };

    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
