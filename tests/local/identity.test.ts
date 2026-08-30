/**
 * The device identity file, which is the one thing here that cannot be
 * regenerated: losing it loses the enrolment and every space key granted to it,
 * and nothing about that failure announces itself.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity, saveIdentity } from '../../src/local/identity.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'engram-identity-'));
  path = join(dir, 'device.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('writing the identity', () => {
  it('creates it 0600 and leaves no half-written file beside it', async () => {
    const identity = await loadOrCreateIdentity(path);
    expect(identity.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    // The write goes through a temp file. One that survived would hold a
    // complete private key under a name nothing tightens or cleans up.
    expect(readdirSync(dir)).toEqual(['device.json']);
  });

  it('tightens a file that already existed with looser permissions', async () => {
    // writeFile's `mode` applies only when it CREATES the file, so a device.json
    // left 0644 by an older bridge, a restore or a copy stayed 0644 through
    // every save afterwards, and the private key stayed readable by every
    // account on the machine.
    const identity = await loadOrCreateIdentity(path);
    chmodSync(path, 0o644);
    identity.deviceId = 'dev_after_enrolment';
    await saveIdentity(path, identity);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((await loadOrCreateIdentity(path)).deviceId).toBe('dev_after_enrolment');
  });

  it('round-trips the key it generated, so a restart is the same device', async () => {
    const first = await loadOrCreateIdentity(path);
    first.deviceId = 'dev_1';
    await saveIdentity(path, first);
    const second = await loadOrCreateIdentity(path);
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.deviceId).toBe('dev_1');
  });
});

describe('reading an identity that is not simply absent', () => {
  it('refuses a truncated file rather than enrolling a new key over it', async () => {
    // A crash or a full disk mid-write leaves exactly this. The blanket catch
    // read it as "no identity yet" and generated a fresh keypair on top: the
    // device id and every granted space key gone, a new fingerprint to approve,
    // and a log that says first run. Refusing keeps the bytes for a human.
    await loadOrCreateIdentity(path);
    const truncated = readFileSync(path, 'utf8').slice(0, 40);
    writeFileSync(path, truncated);

    await expect(loadOrCreateIdentity(path)).rejects.toThrow(/corrupt/);
    expect(readFileSync(path, 'utf8')).toBe(truncated);
  });

  it('refuses a file that parses but holds no usable key', async () => {
    writeFileSync(path, JSON.stringify({ publicKey: 'nope', privateKey: 'nope' }));
    await expect(loadOrCreateIdentity(path)).rejects.toThrow(/corrupt/);
  });

  it('refuses a path it cannot read at all', async () => {
    // EISDIR here, EACCES for a file the user cannot open. Anything but ENOENT
    // means there may be an identity at that path, and only ENOENT is evidence
    // that generating one discards nothing.
    const asDir = join(dir, 'device-as-a-directory');
    mkdirSync(asDir);
    await expect(loadOrCreateIdentity(asDir)).rejects.toThrow(/could not read the device identity/);
  });

  it('generates one when the file is genuinely absent', async () => {
    const identity = await loadOrCreateIdentity(join(dir, 'nested', 'device.json'));
    expect(identity.deviceId).toBeUndefined();
    expect(identity.publicKey.length).toBeGreaterThan(0);
  });
});
