import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { nameFromServer, normaliseName } from '../src/service/naming.js';
import { deviceOf, readConfig, replaceable, writeConfig } from '../src/service/config.js';
import { configForInstall } from '../src/service/index.js';
import { ATTACHMENT_OPTIONS } from '../src/attachments/options.js';
import { readFileSync } from 'node:fs';

/**
 * What these pin is the rule the whole module exists for: a second install
 * JOINS unless it is plainly the same install again.
 *
 * Before it, every install wrote the same two fixed paths, so pointing a
 * machine at a test server overwrote its production credentials -- and reported
 * success, because nothing restarts a running service on `enable --now`. The
 * machine went on answering the old server until the next reboot, and then
 * answered the new one, with the old pairing gone.
 */

describe('what an install is called', () => {
  test('defaults to the server, so one bridge per server', () => {
    expect(nameFromServer('wss://engram.dev.tetrix.dev/bridge?device=abc')).toBe('engram-dev-tetrix-dev');
    expect(nameFromServer('wss://engram.tetrix.dev/bridge?device=abc')).toBe('engram-tetrix-dev');
  });

  test('two servers never collide, which is the whole point', () => {
    const a = nameFromServer('wss://engram.tetrix.dev/bridge?device=1');
    const b = nameFromServer('wss://engram.dev.tetrix.dev/bridge?device=2');
    expect(a).not.toBe(b);
  });

  test('a name somebody typed is held to a shape a unit file accepts', () => {
    expect(normaliseName('My Laptop')).toBe('my-laptop');
    expect(normaliseName('repo/b')).toBe('repo-b');
    // Rejected rather than mangled into something unrecognisable: the name is
    // how somebody finds this service again.
    expect(() => normaliseName('///')).toThrow(/no letters or digits/);
    expect(() => normaliseName('x'.repeat(61))).toThrow(/too long/);
  });
});

describe('when an install may replace what is already there', () => {
  const prod = { server: 'wss://engram.tetrix.dev/bridge?device=aaa', token: 't1' };
  const staging = { server: 'wss://engram.dev.tetrix.dev/bridge?device=bbb', token: 't2' };

  test('the same server as the same machine is the same install', () => {
    expect(replaceable(prod, { ...prod, token: 'rotated' })).toBe(true);
  });

  test('a different server is refused, and names both', () => {
    const verdict = replaceable(prod, staging);
    expect(verdict).not.toBe(true);
    expect(String(verdict)).toContain('engram.tetrix.dev');
    expect(String(verdict)).toContain('engram.dev.tetrix.dev');
  });

  test('the same server as a different machine is refused too', () => {
    const other = { server: 'wss://engram.tetrix.dev/bridge?device=zzz', token: 't3' };
    expect(replaceable(prod, other)).not.toBe(true);
  });

  test('the device is read from the address rather than written down twice', () => {
    expect(deviceOf(prod.server)).toBe('aaa');
    expect(deviceOf('not a url')).toBeNull();
  });
});

describe('the credentials file', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bridge-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('round trips, and keeps the folder somebody chose', () => {
    const path = join(dir, 'x.env');
    writeConfig(path, { server: 'wss://h/bridge?device=1', token: 'secret', allowDir: '/home/me/work' });
    expect(readConfig(path)).toEqual({
      server: 'wss://h/bridge?device=1', token: 'secret', allowDir: '/home/me/work',
    });
  });

  test('is readable only by its owner: a token is not for everyone on the box', () => {
    const path = join(dir, 'y.env');
    writeConfig(path, { server: 'wss://h/bridge?device=1', token: 'secret' });
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  test('an existing file is locked down too, not left as it was found', () => {
    const path = join(dir, 'loose.env');
    writeFileSync(path, 'AI_BRIDGE_SERVER=x\nAI_BRIDGE_TOKEN=y\n', { mode: 0o644 });
    writeConfig(path, { server: 'wss://h/bridge?device=1', token: 'secret' });
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  test('a file with nothing usable in it reads as absent, not as empty settings', () => {
    const path = join(dir, 'z.env');
    writeFileSync(path, '# a comment\nNOT_OURS=1\n');
    expect(readConfig(path)).toBeNull();
    expect(readConfig(join(dir, 'missing.env'))).toBeNull();
  });
});

describe('settings an install carries', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bridge-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test('every attachment setting has a flag and an environment variable, and round trips through the file', () => {
    // The size caps used to have a flag and no variable, so a setup that wrote
    // AI_BRIDGE_ATTACHMENT_MAX_MB into this file changed nothing.
    const settings: Record<string, string> = {};
    for (const [i, option] of ATTACHMENT_OPTIONS.entries()) {
      expect(option.flag).toMatch(/^--attachment-[a-z-]+ <n>$/);
      expect(option.env).toMatch(/^AI_BRIDGE_ATTACHMENT_[A-Z_]+$/);
      settings[option.env] = String(i + 1);
    }
    const path = join(dir, 'x.env');
    writeConfig(path, { server: 'wss://h/bridge', token: 't', name: 'h', settings });
    expect(readConfig(path)).toEqual({ server: 'wss://h/bridge', token: 't', allowDir: undefined, name: 'h', settings });
  });

  test('records the install name, which keys its attachment store', () => {
    const path = join(dir, 'n.env');
    writeConfig(path, { server: 'wss://h/bridge', token: 't', name: 'repo-a' });
    expect(readFileSync(path, 'utf8')).toContain('AI_BRIDGE_NAME=repo-a');
  });

  test('a reinstall keeps the settings it is not given again', () => {
    // Rotating a token is a reinstall; it must not reset the caps.
    const existing = {
      server: 'wss://h/bridge', token: 'old',
      settings: { AI_BRIDGE_ATTACHMENT_MAX_MB: '500', AI_BRIDGE_ATTACHMENT_TOTAL_MB: '2000' },
    };
    const next = configForInstall(
      { server: 'wss://h/bridge', token: 'new', settings: { AI_BRIDGE_ATTACHMENT_TOTAL_MB: '4000' } },
      'h',
      existing,
    );
    expect(next.token).toBe('new');
    expect(next.settings).toEqual({ AI_BRIDGE_ATTACHMENT_MAX_MB: '500', AI_BRIDGE_ATTACHMENT_TOTAL_MB: '4000' });
  });

  test('lines somebody else added to the file survive a rewrite', () => {
    const path = join(dir, 'f.env');
    writeFileSync(path, 'AI_BRIDGE_SERVER=wss://h/bridge\nAI_BRIDGE_TOKEN=t\nSOMETHING_ELSE=kept\n');
    writeConfig(path, { server: 'wss://h/bridge', token: 't2' });
    const body = readFileSync(path, 'utf8');
    expect(body).toContain('SOMETHING_ELSE=kept');
    expect(body).toContain('AI_BRIDGE_TOKEN=t2');
    expect(body.match(/AI_BRIDGE_TOKEN=/g)).toHaveLength(1);
  });
});
