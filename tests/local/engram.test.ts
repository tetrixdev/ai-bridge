/**
 * Which secrets a tool can reach, and which it must not.
 *
 * The bug these tests exist for was live: `loadSecrets` decrypted every secret
 * from every space the device held a key for into ONE flat map, keyed both
 * `space/name` and bare `name`, and a tool's declared names resolved against
 * that flat map. A `ToolDefinition` carried no space at all. So a tool defined
 * in a shared space could name a credential that only exists in the user's
 * private space and be handed it. The only thing in the way was a name
 * collision, and colliding names were deleted, which means the reachable ones
 * were exactly the uniquely named ones.
 *
 * Every assertion below is about the same rule from a different direction:
 * a lookup names a space, or it does not resolve.
 */

import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fillRoles, grantedTo, loadSecrets, roleEnvName } from '../../src/local/engram.js';
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

/**
 * Stand in for Engram: real ciphertext, so decryption is exercised for real.
 * A secret's id is `<space>-<name>`, which makes an id in a test readable and
 * makes a cross-space id easy to write down.
 */
async function serve(identity: Identity, spaces: Record<string, Record<string, string>>): Promise<void> {
  const keys: { space_id: string; wrapped_key: string }[] = [];
  const secrets: { id: string; space_id: string; name: string; envelope: { iv: string; ct: string } }[] = [];

  for (const [spaceId, entries] of Object.entries(spaces)) {
    const spaceKey = webcrypto.getRandomValues(new Uint8Array(32));
    keys.push({ space_id: spaceId, wrapped_key: await wrapToDevice(identity.publicKey, spaceKey) });
    for (const [name, value] of Object.entries(entries)) {
      secrets.push({ id: `${spaceId}-${name}`, space_id: spaceId, name, envelope: await seal(spaceKey, value) });
    }
  }

  vi.stubGlobal('fetch', vi.fn(async (url: URL) => ({
    ok: true,
    json: async () => (String(url).endsWith('/keys') ? { keys } : { secrets }),
  })));
}

afterEach(() => vi.unstubAllGlobals());

/** One device holding a key for a shared space and for the user's private one. */
const twoSpaces = async (): Promise<Identity> => {
  const identity = await makeIdentity();
  await serve(identity, {
    shared: { 'shared-key': 'shared-value-0000' },
    private: { 'personal-token': 'private-value-9999' },
  });
  return identity;
};

describe('a tool reaching for a secret in another space', () => {
  it('cannot have it by name, however uniquely that name is spelled', async () => {
    // The exact leak. `personal-token` exists in exactly one space, so under
    // the old flat map it was reachable bare from anywhere, and a tool living
    // in `shared` naming it was handed the user's private credential.
    const store = await loadSecrets(cfg, await twoSpaces(), 'dev_1');

    expect(() => grantedTo(store, 'shared', ['personal-token']))
      .toThrow(/does not hold a secret named "personal-token"/);
    // And from its own space it is perfectly ordinary, so the refusal above is
    // about the boundary rather than about the secret being unavailable.
    expect(grantedTo(store, 'private', ['personal-token']))
      .toEqual([{ name: 'PERSONAL_TOKEN', value: 'private-value-9999' }]);
  });

  it('cannot have it by id either, which is the same leak with a different key', async () => {
    const store = await loadSecrets(cfg, await twoSpaces(), 'dev_1');
    const fill = [{ role: 'mailbox', secret_id: 'private-personal-token' }];

    expect(() => fillRoles(store, 'shared', fill)).toThrow(/cannot reach across spaces/);
    expect(fillRoles(store, 'private', fill))
      .toEqual([{ name: 'ENGRAM_SECRET_MAILBOX', value: 'private-value-9999' }]);
  });

  it('cannot fall back to a bare lookup, because a tool with no space resolves nothing', async () => {
    // There is no bare form left to fall back TO, and a tool that cannot name
    // a space is refused rather than resolved against everything the device
    // holds. A refusal is a thing an operator can read and fix; a fallback is
    // a credential handed over quietly.
    const store = await loadSecrets(cfg, await twoSpaces(), 'dev_1');
    expect(() => grantedTo(store, undefined, ['personal-token'])).toThrow(/no space_id/);
  });
});

describe('keying the secrets a device holds', () => {
  it('serves a name two spaces both hold, to each space, without ambiguity', async () => {
    // The old map deleted BOTH when two spaces used one name, so a perfectly
    // well-scoped tool stopped working because someone in another space
    // happened to pick the same word. Scoping the lookup removes the clash
    // rather than the secrets.
    const identity = await makeIdentity();
    await serve(identity, { alpha: { 'deploy-key': 'alpha-key' }, beta: { 'deploy-key': 'beta-key' } });

    const store = await loadSecrets(cfg, identity, 'dev_1');

    expect(store.byName('alpha', 'deploy-key')?.value).toBe('alpha-key');
    expect(store.byName('beta', 'deploy-key')?.value).toBe('beta-key');
    expect(store.byName('gamma', 'deploy-key')).toBeUndefined();
  });

  it('keeps a name containing a slash, which is now just a name', async () => {
    // It used to need dropping, because `space/name` and a bare name shared
    // one keyspace and a secret NAMED `alpha/db-password` collided with space
    // alpha's qualified key. With no shared keyspace there is nothing to
    // collide with, and a secret stops being unusable over its punctuation.
    const identity = await makeIdentity();
    await serve(identity, { beta: { 'alpha/db-password': 'beta-value' } });

    const store = await loadSecrets(cfg, identity, 'dev_1');

    expect(store.byName('beta', 'alpha/db-password')?.value).toBe('beta-value');
    expect(store.byName('alpha', 'db-password')).toBeUndefined();
  });

  it('refuses to guess between two secrets one space named the same', async () => {
    const identity = await makeIdentity();
    const spaceKey = webcrypto.getRandomValues(new Uint8Array(32));
    const keys = [{ space_id: 'alpha', wrapped_key: await wrapToDevice(identity.publicKey, spaceKey) }];
    const secrets = [
      { id: 'first', space_id: 'alpha', name: 'db', envelope: await seal(spaceKey, 'first-value') },
      { id: 'second', space_id: 'alpha', name: 'db', envelope: await seal(spaceKey, 'second-value') },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: URL) => ({
      ok: true,
      json: async () => (String(url).endsWith('/keys') ? { keys } : { secrets }),
    })));

    const store = await loadSecrets(cfg, identity, 'dev_1');

    // Neither by name, because picking one would be a coin flip with a
    // credential. Both by id, because an id says which one.
    expect(store.byName('alpha', 'db')).toBeUndefined();
    expect(store.byId('alpha', 'first')?.value).toBe('first-value');
    expect(store.byId('alpha', 'second')?.value).toBe('second-value');
  });
});

describe('filling a role rather than naming a credential', () => {
  it('gives the tool the role it declared, never the credential is called', async () => {
    // The reason roles exist: one fetch_mail serving three app registrations
    // instead of three tools. The tool reads ENGRAM_SECRET_MAILBOX and never
    // learns which credential filled it.
    const identity = await makeIdentity();
    await serve(identity, { shared: { 'azure-app-a': 'value-for-a', 'azure-app-b': 'value-for-b' } });
    const store = await loadSecrets(cfg, identity, 'dev_1');

    const first = fillRoles(store, 'shared', [{ role: 'mailbox', secret_id: 'shared-azure-app-a' }]);
    const second = fillRoles(store, 'shared', [{ role: 'mailbox', secret_id: 'shared-azure-app-b' }]);

    expect(first).toEqual([{ name: 'ENGRAM_SECRET_MAILBOX', value: 'value-for-a' }]);
    expect(second).toEqual([{ name: 'ENGRAM_SECRET_MAILBOX', value: 'value-for-b' }]);
  });

  it('names the variable after the role, hyphens and all', () => {
    expect(roleEnvName('mailbox')).toBe('ENGRAM_SECRET_MAILBOX');
    expect(roleEnvName('sending-account')).toBe('ENGRAM_SECRET_SENDING_ACCOUNT');
  });

  it('refuses two roles that become one variable', async () => {
    // `mail-box` and `mail_box` are two roles and one environment variable.
    // Filling both would hand the tool a credential under a role it did not
    // ask for, decided by iteration order.
    const identity = await makeIdentity();
    await serve(identity, { shared: { one: 'value-one-xx', two: 'value-two-xx' } });
    const store = await loadSecrets(cfg, identity, 'dev_1');

    expect(() => fillRoles(store, 'shared', [
      { role: 'mail-box', secret_id: 'shared-one' },
      { role: 'mail_box', secret_id: 'shared-two' },
    ])).toThrow(/both become ENGRAM_SECRET_MAIL_BOX/);
  });

  it('refuses a role that is not a usable variable name', async () => {
    const identity = await makeIdentity();
    await serve(identity, { shared: { one: 'value-one-xx' } });
    const store = await loadSecrets(cfg, identity, 'dev_1');

    expect(() => fillRoles(store, 'shared', [{ role: 'mail box; echo', secret_id: 'shared-one' }]))
      .toThrow(/not a usable role name/);
  });

  it('says nothing about a call that fills nothing', async () => {
    const store = await loadSecrets(cfg, await twoSpaces(), 'dev_1');
    expect(fillRoles(store, 'shared', undefined)).toEqual([]);
    expect(fillRoles(store, 'shared', [])).toEqual([]);
  });
});

describe('a tool asking for a secret its space does not hold', () => {
  it('fails the call rather than running the tool without it', async () => {
    // Warning and running on was the worst of both: the tool ran as nobody, or
    // wrote an empty value into whatever it configures, and the model read the
    // result as success.
    const store = await loadSecrets(cfg, await twoSpaces(), 'dev_1');
    expect(() => grantedTo(store, 'shared', ['nothing-like-this']))
      .toThrow(/does not hold a secret named "nothing-like-this"/);
  });

  it('says nothing about a tool that declared none', async () => {
    const store = await loadSecrets(cfg, await twoSpaces(), 'dev_1');
    expect(grantedTo(store, 'shared', undefined)).toEqual([]);
    expect(grantedTo(store, 'shared', [])).toEqual([]);
    // Not even the missing space is an error when nothing was asked for.
    expect(grantedTo(store, undefined, [])).toEqual([]);
  });
});
