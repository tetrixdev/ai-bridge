/**
 * What a local tool is actually confined by, and what it is not.
 *
 * Two mechanisms, both verified on Linux with Node 22, neither of which
 * covers what the other does:
 *
 *   Filesystem: Node's own permission model. `node --permission
 *   --allow-fs-read=/tmp -e "require('fs').readFileSync('/etc/passwd')"` gives
 *   ERR_ACCESS_DENIED. It also denies writes and denies spawning a child
 *   process unless asked, and this file never asks: `--allow-child-process`
 *   would hand back everything the flags just took away, since the child runs
 *   with no permission model at all.
 *
 *   Network: the permission model does NOT cover it. A permissioned process
 *   still fetched https://example.com successfully. `unshare -rn <cmd>` works
 *   rootless on an ordinary Linux box and gets EAI_AGAIN instead, so a tool
 *   that declared no network runs inside a network namespace with nothing in
 *   it.
 *
 * The honesty requirement that shapes the rest of this file: `--permission`
 * only applies when the command IS node, and `unshare` only exists on Linux
 * with unprivileged user namespaces enabled. A tool running a Python script on
 * macOS gets no sandbox whatsoever. That case is detected and reported rather
 * than papered over, because a sandbox that is believed to be on and is off is
 * worse than one that was never claimed.
 */

import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { createLogger } from '../utils/logger.js';
import type { SandboxReportFrame } from '../protocol/types.js';

const log = createLogger('Sandbox');

/** What the tool declared it needs, and where its files live. */
export interface SandboxRequest {
  /**
   * `false` means no network at all. `true`, a host list, or absent all mean
   * unrestricted: per-host filtering is not implemented, and a host list is
   * recorded as unenforced rather than treated as a restriction.
   */
  network?: boolean | string[];
  /** The only directory the tool may read. Its package directory, normally. */
  readDir?: string;
  /** Directories the tool may write to. None by default. */
  writeDirs?: string[];
  /** Where the tool runs, used as a read root when nothing better is known. */
  cwd?: string;
}

/** What the sandbox did here, on this machine, for this run. */
export type SandboxReport = SandboxReportFrame;

export interface SandboxedCommand {
  command: string;
  args: string[];
  report: SandboxReport;
}

/** `node`, `node.exe`, or an absolute path ending in either. */
export function isNodeCommand(command: string): boolean {
  const base = basename(command).toLowerCase();
  return base === 'node' || base === 'node.exe';
}

/**
 * Whether `unshare -rn` works here.
 *
 * Probed once per process by running it, because the answer is not something
 * the platform string can tell you: a Linux kernel with
 * `kernel.unprivileged_userns_clone` off refuses it, and so does a container
 * that dropped CAP_SYS_ADMIN. Guessing from `process.platform` would report a
 * network namespace that never existed.
 */
/** Why the namespace is unavailable, in the same words wherever it is said. */
function whyNoNamespace(): string {
  return process.platform === 'linux'
    ? 'unprivileged user namespaces look disabled'
    : `${process.platform} has no equivalent of "unshare -rn"`;
}

let networkNamespaceProbe: Promise<boolean> | undefined;

export function canIsolateNetwork(): Promise<boolean> {
  if (process.platform !== 'linux') return Promise.resolve(false);
  networkNamespaceProbe ??= new Promise<boolean>((settle) => {
    const probe = spawn('unshare', ['-rn', '--', 'true'], { stdio: 'ignore' });
    probe.on('error', () => settle(false));
    probe.on('exit', (code) => settle(code === 0));
  });
  return networkNamespaceProbe;
}

/** Forget the probe, so a test can assert both answers. */
export function resetNetworkProbe(): void {
  networkNamespaceProbe = undefined;
}

/**
 * Wrap a command in whatever containment this machine can actually provide,
 * and say plainly what it could not.
 *
 * Order matters: the network namespace goes on the OUTSIDE, so `unshare`
 * becomes the direct child and node runs inside it. The other way round there
 * is nothing for node's flags to apply to.
 */
export async function sandboxed(
  command: string,
  args: string[],
  request: SandboxRequest = {},
): Promise<SandboxedCommand> {
  const notes: string[] = [];
  let outCommand = command;
  let outArgs = [...args];

  // --- filesystem -----------------------------------------------------------
  let filesystem: SandboxReport['filesystem'] = 'none';
  if (isNodeCommand(command)) {
    const roots = readRoots(args, request);
    const flags = ['--permission', ...roots.map((dir) => `--allow-fs-read=${dir}`)];
    for (const dir of request.writeDirs ?? []) flags.push(`--allow-fs-write=${dir}`);
    if ((request.writeDirs ?? []).length === 0) {
      notes.push('the tool may not write to the filesystem at all; it declared no writable directory');
    }
    // Deliberately absent: --allow-child-process. A child of a permissioned
    // process runs with no permission model, so allowing one hands back every
    // restriction above in a single flag.
    notes.push('the tool may not spawn child processes, load native addons, or run WASI');
    outArgs = [...flags, ...outArgs];
    filesystem = 'node-permissions';
  } else {
    notes.push(
      `the filesystem is NOT sandboxed: Node's permission model only applies when the ` +
      `command is node, and this tool runs "${basename(command)}"`,
    );
  }

  // --- network --------------------------------------------------------------
  let network: SandboxReport['network'] = 'open';
  const wantsNoNetwork = request.network === false;
  if (wantsNoNetwork) {
    if (await canIsolateNetwork()) {
      outArgs = ['-rn', '--', outCommand, ...outArgs];
      outCommand = 'unshare';
      network = 'namespace';
    } else if (process.env['AI_BRIDGE_ALLOW_UNFENCED_NETWORK'] === '1') {
      // Only reached when an operator deliberately waived it, so it is said
      // loudly rather than noted quietly.
      notes.push(
        `the tool declared network: false and the network was NOT blocked, because ` +
        `AI_BRIDGE_ALLOW_UNFENCED_NETWORK is set (${whyNoNamespace()})`,
      );
      log.warn('running a no-network tool WITH a network, because the fence was waived', {
        platform: process.platform,
      });
    } else {
      // Refused, not run.
      //
      // A tool declaring network: false is not stating a preference. It is
      // saying it has no business reaching the internet, and that declaration is
      // what somebody relied on when they let it near a credential. Running it
      // anyway and reporting so afterwards puts the finding in a field nobody
      // reads, after the request has already left the machine, and there is no
      // undo for a credential that got out.
      //
      // The cost is real: where no namespace is available, which today means
      // macOS, Windows, and Linux with unprivileged user namespaces disabled,
      // a no-network tool does not run at all. That is the right way round. A
      // fence that quietly is not there is worse than one that is missing
      // loudly.
      throw new Error(
        `this tool declared network: false and this machine cannot enforce that ` +
        `(${whyNoNamespace()}), so it was not run. Running it would hand a network to a tool ` +
        `that asked not to have one. Set AI_BRIDGE_ALLOW_UNFENCED_NETWORK=1 to run it unfenced ` +
        `anyway, accepting that a tool holding a credential can then send it anywhere.`,
      );
    }
  } else if (Array.isArray(request.network)) {
    notes.push(
      `per-host network filtering is not implemented, so the declared hosts ` +
      `(${request.network.join(', ')}) are NOT enforced and the tool has the whole network`,
    );
  } else {
    notes.push('the tool did not ask for a network restriction, so it has the whole network');
  }

  return { command: outCommand, args: outArgs, report: { filesystem, network, notes } };
}

/**
 * What node is allowed to read.
 *
 * The package directory when there is one, then the working directory, then
 * the directory holding the script it was pointed at. That last one is not
 * generosity, it is the difference between a permission model and a tool that
 * cannot load its own entry point: node reads the script through the same
 * permission check as everything else.
 */
function readRoots(args: string[], request: SandboxRequest): string[] {
  const roots = new Set<string>();
  if (request.readDir) roots.add(resolve(request.readDir));
  if (request.cwd) roots.add(resolve(request.cwd));

  const script = args.find((a) => !a.startsWith('-') && /\.[cm]?js$/.test(a));
  if (script) roots.add(dirname(isAbsolute(script) ? script : resolve(request.cwd ?? process.cwd(), script)));

  return [...roots];
}

/** One line for the log, so a run's containment is visible without a debugger. */
export function describeSandbox(report: SandboxReport): string {
  return `filesystem=${report.filesystem} network=${report.network}`;
}
