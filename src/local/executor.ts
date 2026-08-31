import { spawn } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import { describeSandbox, sandboxed, type SandboxReport, type SandboxRequest } from './sandbox.js';
import { scrub, type Redaction } from './scrub.js';

const log = createLogger('LocalTool');

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

/**
 * How long to keep reading after the child has exited.
 *
 * `close` fires only once every writer on the stdio pipes is gone, and a tool
 * that leaves a background process holding stdout never gets there: settling on
 * `close` alone means this promise never resolves and the model's tool call
 * hangs for the rest of the session, with nothing in the log saying so.
 * Settling on `exit` alone would drop output still sitting in the pipe. So the
 * exit starts a deadline, and whichever comes first ends the run.
 */
const STDIO_FLUSH_MS = 500;

/**
 * What a tool inherits from the bridge's own environment.
 *
 * An allowlist rather than `{...process.env}`, because the bridge's environment
 * holds ENGRAM_TOKEN and AI_BRIDGE_TOKEN and those are NOT in the redaction
 * set: a tool that dumps its environment, or an error message that includes it,
 * would hand the model the bridge's own credentials in the clear. That is
 * exactly the accident scrubbing exists to catch, and scrubbing cannot catch it
 * because it only knows the secrets the tool was granted.
 *
 * A tool that needs something else gets it as a declared secret, which is
 * visible in the manifest a person approved.
 */
const INHERITED = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TERM', 'SHELL', 'USER'];

/** Names a secret may not take, because the child resolves its binary with them. */
const PROTECTED = new Set([
  'PATH', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES',
  'IFS', 'BASH_ENV', 'ENV', 'PYTHONPATH', 'PYTHONSTARTUP', 'PERL5OPT',
]);

export interface LocalRun {
  /** Tool name, for logs and for naming a redaction. */
  name: string;
  command: string;
  /** Arguments fixed by the tool definition, before the model's own. */
  args: string[];
  /** What the model passed, injected as ENGRAM_ARG_* rather than a command line. */
  toolArgs?: Record<string, unknown>;
  /**
   * One JSON document written to the tool's stdin, for the local_call path.
   *
   * Absent means the tool gets no stdin at all rather than an empty pipe it
   * might block on. `undefined` and `null` are different here: `null` is a
   * document that says null, and absent is no document.
   */
  input?: unknown;
  /** Resolved secrets, injected as environment and redacted from the output. */
  secrets: Redaction[];
  cwd?: string;
  timeoutMs?: number;
  /** What the tool declared it needs, so the sandbox can confine the rest. */
  sandbox?: SandboxRequest;
  /** Extra environment the bridge itself sets, e.g. ENGRAM_PACKAGE_DIR. */
  extraEnv?: Record<string, string>;
}

export interface LocalResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** What the sandbox actually did, which is not always what was asked for. */
  sandbox: SandboxReport;
}

/**
 * The environment variable an argument key becomes.
 *
 * This used to be `k.toUpperCase().replace(/[^A-Z0-9]/g, '_')`, which maps
 * `a-b`, `a_b` and `a.b` onto the single name `A_B`. Three distinct arguments,
 * one variable, last one wins, and nothing anywhere says so. The mapping is
 * unchanged, because renaming it would break every tool that reads these; what
 * changed is that a collision is now detected and refused rather than resolved
 * by iteration order. See composeEnv().
 */
export const argEnvName = (key: string): string =>
  `ENGRAM_ARG_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/**
 * Build the child's environment, and refuse any name two things claim.
 *
 * Arguments go in first and secrets second, so a secret can never be lost to
 * an argument. That ordering used to be the other way round, which meant a
 * secret named `engram-arg-foo` was silently overwritten by an argument named
 * `foo`: the tool then ran with the model's value where a credential belonged.
 * The ordering alone is not the fix though, because the reverse (an argument
 * quietly overwritten by a secret) is just as wrong, so anything claimed twice
 * fails the call instead.
 */
function composeEnv(run: LocalRun): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of INHERITED) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(run.extraEnv ?? {})) env[key] = value;

  /** What claimed each variable, so a collision can name both sides. */
  const claimed = new Map<string, string>();
  const claim = (variable: string, by: string): void => {
    const already = claimed.get(variable);
    if (already !== undefined) {
      throw new Error(
        `"${already}" and "${by}" both become the environment variable ${variable}, ` +
        `so one would silently replace the other. Rename one of them in the tool ` +
        `definition rather than letting iteration order decide which value the tool sees.`,
      );
    }
    claimed.set(variable, by);
  };

  for (const [key, value] of Object.entries(run.toolArgs ?? {})) {
    const variable = argEnvName(key);
    claim(variable, `argument ${key}`);
    env[variable] = typeof value === 'string' ? value : JSON.stringify(value);
  }

  for (const s of run.secrets) {
    if (PROTECTED.has(s.name)) {
      // A space member choosing a secret's name must not get to decide which
      // binary the child actually runs.
      log.warn('refusing to inject a secret over a protected variable', { name: s.name });
      continue;
    }
    claim(s.name, `secret ${s.name}`);
    env[s.name] = s.value;
  }

  return env;
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
 *
 * Throws only for a tool definition that cannot be run at all, such as two
 * names claiming one environment variable. Everything the TOOL does, including
 * failing to start, comes back as a result: a non-zero exit is an answer, not
 * an exception.
 */
export async function runLocalTool(run: LocalRun): Promise<LocalResult> {
  const env = composeEnv(run);
  const confined = await sandboxed(run.command, run.args, {
    ...run.sandbox,
    cwd: run.sandbox?.cwd ?? run.cwd,
  });

  log.info('running local tool', {
    name: run.name,
    command: run.command,
    secrets: run.secrets.map((s) => s.name),
    sandbox: describeSandbox(confined.report),
  });
  for (const note of confined.report.notes) log.debug('sandbox', { note });

  return new Promise<LocalResult>((resolve) => {
    const child = spawn(confined.command, confined.args, {
      cwd: run.cwd,
      env,
      shell: false,
      // stdin is always a pipe, and is closed immediately when there is no
      // input. A tool that reads stdin then sees end-of-file, exactly as it
      // would from /dev/null, rather than blocking on a pipe nobody writes to.
      stdio: 'pipe',
      // Its own process group, so the timeout can reach what the tool started
      // as well as the tool itself. Without it a tool that backgrounds a worker
      // survives its own kill: the worker keeps running as the user, still
      // holding stdout, after the bridge has reported the tool killed.
      detached: true,
    });

    // A tool that never reads stdin makes this write fail with EPIPE. That is
    // the tool ignoring its input, not the bridge failing, so it must not
    // become an unhandled error that takes the whole process down.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      log.debug('the tool did not read its stdin', { name: run.name, code: err.code });
    });
    child.stdin.end(run.input === undefined ? undefined : JSON.stringify(run.input));

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const cap = (current: string, chunk: Buffer): string =>
      current.length >= MAX_OUTPUT_BYTES ? current : current + chunk.toString('utf8');

    child.stdout.on('data', (c: Buffer) => { stdout = cap(stdout, c); });
    child.stderr.on('data', (c: Buffer) => { stderr = cap(stderr, c); });

    /**
     * Kill the tool and everything it started.
     *
     * A negative pid signals the whole process group, which is the group
     * `detached` gave this child. `child.kill` reaches the direct child only,
     * so a shell that backgrounded a long-running process left it alive.
     * Windows has no process group to signal, so there the direct child is all
     * that can be reached. A throw here means it is already gone.
     */
    const killTree = () => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-pid, 'SIGKILL');
      } catch {
        // Already exited, or never started. Nothing left to signal.
      }
    };

    let flushTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, run.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (flushTimer) clearTimeout(flushTimer);
      // Scrubbing happens here, at the one place output leaves this process,
      // rather than at each caller. A caller that forgot would leak silently,
      // and it happens BEFORE anything parses stdout, so a credential cannot
      // survive inside a JSON string the parser hands on.
      resolve({
        exitCode,
        stdout: scrub(stdout, run.secrets),
        stderr: scrub(stderr, run.secrets),
        timedOut,
        sandbox: confined.report,
      });
    };

    child.on('error', (err) => {
      stderr += `\n${err.message}`;
      finish(null);
    });
    // The tool is over once it exits; the pipes may not be, because anything it
    // left behind still holds them. Give the pipes STDIO_FLUSH_MS to drain and
    // settle regardless, so a leaked grandchild costs half a second of output
    // rather than a tool call that never returns.
    child.on('exit', (code) => { flushTimer = setTimeout(() => finish(code), STDIO_FLUSH_MS); });
    child.on('close', (code) => finish(code));
  });
}
