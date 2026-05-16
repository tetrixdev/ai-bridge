/**
 * CLI Detector
 *
 * Probes the local system for known AI CLI tools by attempting to run
 * `<cli> --version`. Returns an array of ProviderCapability descriptors
 * indicating what is available.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProviderCapability } from '../protocol/types.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Detector');
const execFileAsync = promisify(execFile);

/** CLI probing configuration for each known provider. */
interface CliProbe {
  name: string;
  binary: string;
  versionArgs: string[];
  /** Parse the version string from the CLI's stdout/stderr. */
  parseVersion: (output: string) => string | null;
  supports_streaming: boolean;
  supports_tools: boolean;
  supports_thinking: boolean;
  supports_session_resume: boolean;
}

const CLI_PROBES: CliProbe[] = [
  {
    name: 'codex',
    binary: 'codex',
    versionArgs: ['--version'],
    parseVersion: (output) => extractVersion(output),
    supports_streaming: true,
    supports_tools: true,
    supports_thinking: true,
    supports_session_resume: true,
  },
  {
    name: 'claude',
    binary: 'claude',
    versionArgs: ['--version'],
    parseVersion: (output) => extractVersion(output),
    supports_streaming: true,
    supports_tools: true,
    supports_thinking: true,
    supports_session_resume: true,
  },
  {
    name: 'gemini',
    binary: 'gemini',
    versionArgs: ['--version'],
    parseVersion: (output) => extractVersion(output),
    supports_streaming: true,
    supports_tools: true,
    supports_thinking: false,
    supports_session_resume: true,
  },
];

/**
 * Try to extract a semver-like version string from CLI output.
 * Matches patterns like "1.2.3", "v1.2.3", "0.1.0-beta".
 */
function extractVersion(output: string): string | null {
  const match = output.match(/v?(\d+\.\d+\.\d+[\w.-]*)/);
  return match ? match[1] : null;
}

/**
 * Probe a single CLI binary.
 */
async function probeOne(probe: CliProbe): Promise<ProviderCapability> {
  const capability: ProviderCapability = {
    name: probe.name,
    version: null,
    available: false,
    supports_streaming: probe.supports_streaming,
    supports_tools: probe.supports_tools,
    supports_thinking: probe.supports_thinking,
    supports_session_resume: probe.supports_session_resume,
  };

  try {
    const { stdout, stderr } = await execFileAsync(probe.binary, probe.versionArgs, {
      timeout: 5_000,
      env: { ...process.env },
    });
    const output = (stdout || '') + (stderr || '');
    capability.available = true;
    capability.version = probe.parseVersion(output.trim());
    log.info(`Detected ${probe.name}`, { version: capability.version });
  } catch (err) {
    log.debug(`${probe.name} not found or not executable`, {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return capability;
}

/**
 * Detect all known AI CLI tools installed on this system.
 * Probes run concurrently for speed.
 *
 * @returns Array of ProviderCapability for all known providers (both available and unavailable).
 */
export async function detectProviders(): Promise<ProviderCapability[]> {
  log.info('Detecting locally installed AI CLI tools...');
  const results = await Promise.all(CLI_PROBES.map(probeOne));
  const available = results.filter((r) => r.available);
  log.info(`Detection complete: ${available.length}/${results.length} providers available`);
  return results;
}

// EFF-001: detectAvailableProviders was exported but never used. Removed to
// keep the module surface minimal. cli.ts uses the equivalent inline filter
// on detectProviders() output. Re-add and export if future callers need it.
