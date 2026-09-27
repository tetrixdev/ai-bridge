/**
 * Which sealed values a tool can reach, and which it must not.
 *
 * A live bug shaped these: `loadSecrets` once decrypted every secret from
 * every space into ONE flat map keyed by name, so a tool from a shared space
 * could name a credential from the user's private space and be handed it.
 * The store is now keyed by space and id and nothing else, and every sealed
 * value a call names carries the space that sealed it and the item and field
 * it belongs to. Every assertion below is the same rule from a different
 * direction: a value is read through the space that sealed it, as the field of
 * the item it belongs to, or not at all.
 */

import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fieldEnvName, fillRoles, loadSecrets, sealedRefs } from '../../src/local/engram.js';
import { b64u, type Identity } from '../../src/local/identity.js';
import type { ItemFill } from '../../src/protocol/types.js';
import { makeGranter, seal, wrapToDevice } from './vault-half.js';

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

/**
 * Stand in for Engram: real ciphertext, so decryption is exercised for real.
 * Each space holds items, each item sealed fields. A sealed value's id is
 * `<space>-<item>-<field>` and an item's id `<space>-<item>`, which makes an id
 * in a test readable and a cross-space id easy to write down.
 */
async function serve(identity: Identity, spaces: Record<string, Record<string, Record<string, string>>>): Promise<void> {
  const keys: { space_id: string; wrapped_key: string; granted_by_signing_key: string }[] = [];
  const granter = await makeGranter();
  const secrets: { id: string; space_id: string; item_id: string; field: string; envelope: { iv: string; ct: string } }[] = [];

  for (const [spaceId, items] of Object.entries(spaces)) {
    const spaceKey = webcrypto.getRandomValues(new Uint8Array(32));
    keys.push({
      space_id: spaceId,
      wrapped_key: await wrapToDevice(identity.publicKey, spaceKey, spaceId, granter),
      granted_by_signing_key: granter.signingPublicKey,
    });
    for (const [item, fields] of Object.entries(items)) {
      for (const [field, value] of Object.entries(fields)) {
        secrets.push({
          id: `${spaceId}-${item}-${field}`, space_id: spaceId, item_id: `${spaceId}-${item}`, field,
          envelope: await seal(spaceKey, value),
        });
      }
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
    shared: { app: { client_secret: 'shared-value-0000' } },
    private: { app: { client_secret: 'private-value-9999' } },
  });
  return identity;
};

/** The fill Engram sends for one role. */
const fill = (role: string, space: string, item: string, sealedIn = space, plain: Record<string, string> = {}): ItemFill => ({
  role, item_id: `${space}-${item}`, space_id: space, kind: 'azure_app', fields: plain,
  sealed: [{ field: 'client_secret', secret_id: `${space}-${item}-client_secret`, space_id: sealedIn }],
});

describe('a sealed value, read through the space that sealed it', () => {
  it('is opened from the space the call names, which may differ from the tool\'s', async () => {
    const store = await loadSecrets(cfg, await twoSpaces(), 'dev_1');
    expect(fillRoles(store, [fill('mailbox', 'private', 'app')]).sealed)
      .toEqual([{ name: 'ENGRAM_MAILBOX_CLIENT_SECRET', value: 'private-value-9999' }]);
  });

  it('is refused when named under a space that did not seal it', async () => {
    // The exact leak, by id: private's value, claimed through shared.
    const store = await loadSecrets(cfg, await twoSpaces(), 'dev_1');
    const crossed: ItemFill = {
      ...fill('mailbox', 'private', 'app'),
      sealed: [{ field: 'client_secret', secret_id: 'private-app-client_secret', space_id: 'shared' }],
    };
    expect(() => fillRoles(store, [crossed])).toThrow(/cannot be filled/);
  });

  it('is refused when named as a field of an item it does not belong to', async () => {
    const store = await loadSecrets(cfg, await twoSpaces(), 'dev_1');
    const swapped: ItemFill = { ...fill('mailbox', 'private', 'app'), item_id: 'shared-app' };
    expect(() => fillRoles(store, [swapped])).toThrow(/cannot be filled/);
    const renamed: ItemFill = {
      ...fill('mailbox', 'private', 'app'),
      sealed: [{ field: 'refresh_token', secret_id: 'private-app-client_secret', space_id: 'private' }],
    };
    expect(() => fillRoles(store, [renamed])).toThrow(/cannot be filled/);
  });
});

describe('filling a role rather than naming an item', () => {
  it('gives the tool each field under its role and name, plain ones as themselves', async () => {
    // The reason roles exist: one fetch_mail serving three app registrations
    // instead of three tools. The tool reads ENGRAM_MAILBOX_* and never learns
    // which item filled it.
    const identity = await makeIdentity();
    await serve(identity, { shared: { a: { client_secret: 'value-for-a' }, b: { client_secret: 'value-for-b' } } });
    const store = await loadSecrets(cfg, identity, 'dev_1');

    const first = fillRoles(store, [fill('mailbox', 'shared', 'a', 'shared', { client_id: 'id-a' })]);
    const second = fillRoles(store, [fill('mailbox', 'shared', 'b', 'shared', { client_id: 'id-b' })]);
    expect(first).toEqual({
      env: { ENGRAM_MAILBOX_CLIENT_ID: 'id-a' },
      sealed: [{ name: 'ENGRAM_MAILBOX_CLIENT_SECRET', value: 'value-for-a' }],
    });
    expect(second.sealed).toEqual([{ name: 'ENGRAM_MAILBOX_CLIENT_SECRET', value: 'value-for-b' }]);
  });

  it('names the variable after the role and the field, hyphens and all', () => {
    expect(fieldEnvName('mailbox', 'client_secret')).toBe('ENGRAM_MAILBOX_CLIENT_SECRET');
    expect(fieldEnvName('source-db', 'password')).toBe('ENGRAM_SOURCE_DB_PASSWORD');
  });

  it('refuses two roles or fields that become one variable', async () => {
    const store = await loadSecrets(cfg, await twoSpaces(), 'dev_1');
    expect(() => fillRoles(store, [
      { role: 'mail-box', item_id: 'x', space_id: 'shared', fields: { user: 'a' } },
      { role: 'mail_box', item_id: 'y', space_id: 'shared', fields: { user: 'b' } },
    ])).toThrow(/both become ENGRAM_MAIL_BOX_USER/);
  });

  it('refuses a role or a field that is not a usable variable name', async () => {
    const store = await loadSecrets(cfg, await twoSpaces(), 'dev_1');
    expect(() => fillRoles(store, [{ ...fill('mail box; echo', 'shared', 'app') }]))
      .toThrow(/not a usable role name/);
    expect(() => fillRoles(store, [{ role: 'mailbox', item_id: 'x', space_id: 'shared', fields: { 'A B': 'x' } }]))
      .toThrow(/not a lowercase name/);
  });

  it('says nothing about a call that fills nothing, and asks for nothing', async () => {
    const store = await loadSecrets(cfg, await twoSpaces(), 'dev_1');
    expect(fillRoles(store, undefined)).toEqual({ env: {}, sealed: [] });
    expect(fillRoles(store, [])).toEqual({ env: {}, sealed: [] });
    expect(sealedRefs(undefined)).toEqual([]);
    expect(sealedRefs([fill('mailbox', 'private', 'app')]))
      .toEqual([{ space_id: 'private', secret_id: 'private-app-client_secret' }]);
  });
});
