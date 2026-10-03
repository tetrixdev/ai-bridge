/**
 * Making a bridge start with the machine, on each platform that can.
 *
 * One shape, three implementations: write a definition, register it, start it.
 * The differences that matter are about PATH and about what a restart means --
 * systemd will not reload a changed environment file on its own, and launchd
 * will not either, and that is precisely the bug that made a reinstall look
 * like it worked while the machine kept answering the old server.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname } from 'node:path';
import type { BridgeConfig } from './config.js';
import type { Paths } from './naming.js';

export type Supported = 'linux' | 'darwin' | 'win32';

export function supported(): Supported | null {
  const os = platform();
  return os === 'linux' || os === 'darwin' || os === 'win32' ? os : null;
}

/** Where `npx` actually is. A login shell's PATH is not a service's PATH, and
 *  node is usually somewhere only the former knows about. */
function npxPath(): string {
  try {
    return execFileSync('command', ['-v', 'npx'], { shell: true, encoding: 'utf8' }).trim()
      || 'npx';
  } catch {
    return 'npx';
  }
}

const run = (cmd: string, args: string[]): void => {
  execFileSync(cmd, args, { stdio: 'ignore' });
};

/** Switches a service may pass to the bridge. Anything else is refused, so an
 *  install cannot be talked into writing an arbitrary command line. */
export const INSTALL_FLAGS = ['--allow-native', '--local-tools', '--no-self-update'] as const;

export function install(paths: Paths, config: BridgeConfig, flags: string[] = []): void {
  for (const flag of flags) {
    if (!(INSTALL_FLAGS as readonly string[]).includes(flag)) throw new Error(`not a flag a service can be installed with: ${flag}`);
  }
  const os = supported();
  if (os === 'darwin') return installLaunchd(paths, config, flags);
  if (os === 'win32') return installScheduledTask(paths, config);
  return installSystemd(paths, config, flags);
}

/**
 * Windows, as a logon task.
 *
 * The credentials go in a file and the task is pointed at it with --env-file.
 * They used to go in the USER's environment variables, which is the reason a
 * Windows machine could hold exactly one pairing however many bridges were
 * installed: two services reading AI_BRIDGE_TOKEN both read the same one, and
 * the second install silently retargeted the first.
 */
function installScheduledTask(paths: Paths, config: BridgeConfig): void {
  mkdirSync(dirname(paths.env), { recursive: true });
  const args = ['--env-file', paths.env, '--log-file', paths.log];
  const command = `ai-bridge ${args.map((a) => `"${a}"`).join(' ')}`;
  // /F replaces a task of the same name, which is what an install of the same
  // name means. A different name is a different task and is left alone.
  run('schtasks', [
    '/Create', '/F',
    '/TN', paths.label,
    '/SC', 'ONLOGON',
    '/RL', 'LIMITED',
    '/TR', command,
  ]);
  try { run('schtasks', ['/End', '/TN', paths.label]); } catch { /* not running */ }
  run('schtasks', ['/Run', '/TN', paths.label]);
}

/**
 * The unit text, separate from installing it so it can be tested.
 *
 * Pinned: the version comes from AI_BRIDGE_VERSION in the env file, so moving
 * the bridge is one line there and a restart, done by self-update or by hand.
 * Unpinned, it ran whatever npx resolved, which is not even reliably the
 * newest: npx reuses its cache, and one machine ran a release two weeks old.
 * `Restart=always` brings it back after self-update's exit.
 */
export function systemdUnit(paths: Paths, config: BridgeConfig, flags: string[], npx: string): string {
  const allow = config.allowDir ? ` --allow-dir "${config.allowDir}"` : '';
  const extra = flags.length > 0 ? ` ${flags.join(' ')}` : '';
  return `[Unit]
Description=AI Bridge (${paths.label})
After=network-online.target

[Service]
Type=simple
EnvironmentFile=${paths.env}
# A login shell's PATH is not a service's PATH.
Environment=PATH=%h/.local/bin:%h/.nvm/versions/node/current/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=${npx} -y --ignore-scripts @tetrixdev/ai-bridge@\${AI_BRIDGE_VERSION}${allow}${extra}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

function installSystemd(paths: Paths, config: BridgeConfig, flags: string[]): void {
  mkdirSync(dirname(paths.unit), { recursive: true });
  writeFileSync(paths.unit, systemdUnit(paths, config, flags, npxPath()));
  run('systemctl', ['--user', 'daemon-reload']);
  run('systemctl', ['--user', 'enable', paths.label]);
  // `enable --now` does NOTHING to a unit that is already running, so a
  // reinstall wrote new credentials and left the old ones loaded. Restart is
  // the whole point of reinstalling.
  run('systemctl', ['--user', 'restart', paths.label]);
}

function installLaunchd(paths: Paths, config: BridgeConfig, flags: string[]): void {
  const home = homedir();
  // The credentials are read from the file rather than written into the plist.
  // A plist is readable by everyone by default, and `launchctl print` shows its
  // environment -- so a token in there is a token on somebody's screen the next
  // time they debug the agent.
  // Pinned to the installing version, written into the plist: launchd has no
  // environment substitution, so it does not follow the server's desired
  // version by itself. Reinstall with the version wanted to move it.
  const pkg = config.version ? `@tetrixdev/ai-bridge@${config.version}` : '@tetrixdev/ai-bridge';
  const args = ['-y', '--ignore-scripts', pkg, '--env-file', paths.env, ...flags];
  mkdirSync(dirname(paths.unit), { recursive: true });
  mkdirSync(dirname(paths.log), { recursive: true });
  // launchd has no EnvironmentFile, so the agent is pointed at ours with
  // --env-file. That keeps the token in one file with one owner instead of in
  // the plist, which is world readable by default and which `launchctl print`
  // will happily show to anyone debugging the agent.
  writeFileSync(paths.unit, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${paths.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${npxPath()}</string>${args.map((a) => `<string>${a}</string>`).join('')}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${home}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${paths.log}</string>
  <key>StandardErrorPath</key><string>${paths.log}</string>
</dict>
</plist>
`, { mode: 0o600 });
  // Unload first, for the same reason systemd gets a restart: a loaded agent
  // holds its old environment until it is told otherwise.
  try { run('launchctl', ['unload', paths.unit]); } catch { /* not loaded yet */ }
  run('launchctl', ['load', paths.unit]);
}

export function uninstall(paths: Paths): void {
  const os = supported();
  if (os === 'win32') {
    try { run('schtasks', ['/End', '/TN', paths.label]); } catch { /* not running */ }
    try { run('schtasks', ['/Delete', '/F', '/TN', paths.label]); } catch { /* already gone */ }
    if (existsSync(paths.env)) rmSync(paths.env);
    return;
  }
  if (os === 'darwin') {
    try { run('launchctl', ['unload', paths.unit]); } catch { /* already gone */ }
  } else {
    try { run('systemctl', ['--user', 'disable', '--now', paths.label]); } catch { /* already gone */ }
  }
  for (const file of [paths.unit, paths.env]) {
    if (existsSync(file)) rmSync(file);
  }
  if (os !== 'darwin') {
    try { run('systemctl', ['--user', 'daemon-reload']); } catch { /* best effort */ }
  }
}

/** What the operating system says this service is doing, for `list`. */
export function status(paths: Paths): string {
  try {
    if (supported() === 'win32') {
      const out = execFileSync('schtasks', ['/Query', '/TN', paths.label], { encoding: 'utf8' });
      return /Running/i.test(out) ? 'active' : 'ready';
    }
    if (supported() === 'darwin') {
      const out = execFileSync('launchctl', ['list'], { encoding: 'utf8' });
      return out.split('\n').some((l) => l.endsWith(paths.label)) ? 'loaded' : 'not loaded';
    }
    return execFileSync('systemctl', ['--user', 'is-active', paths.label], { encoding: 'utf8' }).trim();
  } catch {
    return 'stopped';
  }
}
