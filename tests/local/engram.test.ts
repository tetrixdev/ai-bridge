/**
 * How a fetched set of secrets is keyed, and what happens when one is missing.
 *
 * Both are places where the wrong answer is silent: a tool that receives the
 * wrong credential, or none, reports whatever the tool itself does about it,
 * and the model reads that as the tool having worked.
 */

import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { grantedTo, loadSecrets } from '../../src/local/engram.js';
import { b64u, type Identity } from '../../src/local/identity.js';

const C = webcrypto.subtle;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;
const cfg = { baseUrl: 'https://engram.test/', token: 'tok' };

async function makeIdentity(): Promise<Identity> {
  const pair = (await C.generateKey(CURVE, true, ['deriveBits'])) as webcrypto.CryptoKeyPair;
  return {
    publicKey: b64u.encode(await C.exportKey('raw', pair.publicKey)),
    privateKey: pair.privateKey,
    deviceId: 'dev_1',
  };
}

/** The wrapping half of unwrapToDevice, which only Engram's browser code does. */
async function wrapToDevice(publicKeyB64u: string, payload: Uint8Array): Promise<string> {
  const pub = await C.importKey('raw', b64u.decode(publicKeyB64u), CURVE, false, []);
  const eph = (await C.generateKey(CURVE, true, ['deriveBits'])) as webcrypto.CryptoKeyPair;
  const shared = await C.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256);
  const base = await C.importKey('raw', new Uint8Array(shared), 'HKDF', false, ['deriveKey']);
  const kek = await C.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('engram-space-key') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await C.encrypt({ name: 'AES-GCM', iv }, kek, payload);
  return JSON.stringify({
    epk: b64u.encode(await C.exportKey('raw', eph.publicKey)),
    iv: b64u.encode(iv),
    ct: b64u.encode(ct),
  });
}

async function seal(spaceKey: Uint8Array, value: string): Promise<{ iv: string; ct: string }> {
  const key = await C.importKey('raw', spaceKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await C.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return { iv: b64u.encode(iv), ct: b64u.encode(ct) };
}

/** Stand in for Engram: real ciphertext, so decryption is exercised for real. */
async function serve(identity: Identity, spaces: Record<string, Record<string, string>>): Promise<void> {
  const keys: { space_id: string; wrapped_key: string }[] = [];
  const secrets: { space_id: string; name: string; envelope: { iv: string; ct: string } }[] = [];

  for (const [spaceId, entries] of Object.entries(spaces)) {
    const spaceKey = webcrypto.getRandomValues(new Uint8Array(32));
    keys.push({ space_id: spaceId, wrapped_key: await wrapToDevice(identity.publicKey, spaceKey) });
    for (const [name, value] of Object.entries(entries)) {
      secrets.push({ space_id: spaceId, name, envelope: await seal(spaceKey, value) });
    }
  }

  vi.stubGlobal('fetch', vi.fn(async (url: URL) => ({
    ok: true,
    json: async () => (String(url).endsWith('/keys') ? { keys } : { secrets }),
  })));
}

afterEach(() => vi.unstubAllGlobals());

describe('keying the secrets a device holds', () => {
  it('drops a secret whose name contains a slash instead of deleting what it collides with', async () => {
    // `space/name` is the qualified form, so a secret NAMED `alpha/db-password`
    // produces a bare key identical to space alpha's qualified key for
    // `db-password`. The ambiguity sweep then deleted that entry, and a tool
    // asking for `alpha/db-password` ran with no credential at all: not the
    // wrong client's password, but an empty variable and a puzzling error from
    // inside the tool.
    const identity = await makeIdentity();
    await serve(identity, {
      alpha: { 'db-password': 'alpha-real-password' },
      beta: { 'alpha/db-password': 'beta-smuggled-value' },
    });

    const available = await loadSecrets(cfg, identity, 'dev_1');

    expect(available.get('alpha/db-password')?.value).toBe('alpha-real-password');
    expect(grantedTo(available, ['alpha/db-password'])).toEqual([
      { name: 'DB_PASSWORD', value: 'alpha-real-password' },
    ]);
    // The slashed name is reachable under no key at all, bare or qualified.
    expect([...available.values()].some((s) => s.value === 'beta-smuggled-value')).toBe(false);
  });

  it('still hides a name two spaces both hold, so neither is served by guess', async () => {
    // The rule the slash fix must not break: picking one of two `deploy-key`s
    // would hand a tool the other client's credential and look like it worked.
    const identity = await makeIdentity();
    await serve(identity, {
      alpha: { 'deploy-key': 'alpha-key' },
      beta: { 'deploy-key': 'beta-key' },
    });

    const available = await loadSecrets(cfg, identity, 'dev_1');

    expect(available.has('deploy-key')).toBe(false);
    expect(available.get('alpha/deploy-key')?.value).toBe('alpha-key');
    expect(available.get('beta/deploy-key')?.value).toBe('beta-key');
  });

  it('exposes an unambiguous name both bare and qualified', async () => {
    const identity = await makeIdentity();
    await serve(identity, { alpha: { 'deploy-key': 'only-one' } });

    const available = await loadSecrets(cfg, identity, 'dev_1');

    expect(available.get('deploy-key')?.value).toBe('only-one');
    expect(available.get('alpha/deploy-key')?.value).toBe('only-one');
    expect(available.get('deploy-key')?.name).toBe('DEPLOY_KEY');
  });
});

describe('a tool asking for a secret this device does not hold', () => {
  it('fails the call rather than running the tool without it', async () => {
    // Warning and running on was the worst of both: the tool ran as nobody, or
    // wrote an empty value into whatever it configures, and the model read the
    // result as success. Missing means not granted, not yet approved, or
    // ambiguous across spaces, and all three are for a person to fix.
    expect(() => grantedTo(new Map(), ['deploy-key'])).toThrow(/does not hold the secret "deploy-key"/);
  });

  it('says nothing about a tool that declared none', () => {
    expect(grantedTo(new Map(), undefined)).toEqual([]);
    expect(grantedTo(new Map(), [])).toEqual([]);
  });
});
