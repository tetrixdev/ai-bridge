/**
 * What the locally installed Claude CLI can do.
 *
 * `--include-partial-messages` is not available on every version, and an
 * unknown flag is fatal: the CLI exits non-zero before producing a single
 * event, so a bridge that passed it blindly would answer nothing at all on an
 * older machine. Lumpy output is a far better failure than no output, so
 * support is PROBED rather than assumed, and anything unexpected resolves to
 * "unsupported" and the existing whole-message path.
 *
 * The probe is one `claude --help` (~0.4s locally), run at most once per
 * process and shared by every concurrent request through the cached promise.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const log = createLogger('ClaudeCapabilities');

/** Operator kill switch, for a CLI whose partial output turns out to be wrong. */
const DISABLE_ENV_VAR = 'AI_BRIDGE_DISABLE_PARTIAL_STREAMING';

const PARTIAL_FLAG = '--include-partial-messages';

let cached: Promise<boolean> | null = null;

/**
 * Does this machine's `claude` accept `--include-partial-messages`?
 *
 * Never throws: a missing binary, a timeout, or help text in an unexpected
 * shape all report `false`, which costs granularity and nothing else.
 */
export function supportsPartialMessages(): Promise<boolean> {
  if (cached === null) cached = probe();
  return cached;
}

/** Reset the cached probe. Tests only. */
export function resetPartialMessageSupportCache(): void {
  cached = null;
}

async function probe(): Promise<boolean> {
  const override = process.env[DISABLE_ENV_VAR];
  if (override !== undefined && override !== '' && override !== '0') {
    log.info(`${DISABLE_ENV_VAR} is set — streaming whole messages instead of partial chunks`);
    return false;
  }

  try {
    // The probe runs a binary off PATH, so it gets the same credential
    // stripping as the version probe in detector.ts.
    const env = { ...process.env };
    delete env['AI_BRIDGE_TOKEN'];
    delete env['AI_BRIDGE_SERVER'];
    delete env['CLAUDECODE'];

    const { stdout, stderr } = await execFileAsync('claude', ['--help'], { timeout: 10_000, env });
    const supported = ((stdout || '') + (stderr || '')).includes(PARTIAL_FLAG);
    log.info(supported
      ? 'Claude CLI supports partial message streaming'
      : `Claude CLI does not list ${PARTIAL_FLAG} — falling back to whole-message streaming`);
    return supported;
  } catch (err) {
    log.debug('Could not probe Claude CLI for partial message support', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
