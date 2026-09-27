/**
 * The browser half of the vault, for unit tests: wrapping a space key to a
 * device and sealing a value, the way Engram's public/vault.js does it.
 *
 * A copy, and a copy is exactly how the wrap format drifted before: this file
 * used to wrap with a fixed HKDF label and no signature long after the browser
 * had moved on, and every test here stayed green while no real device could
 * open a real key. So these helpers are for the unit tests' convenience only.
 * What keeps the two sides honest is the test in Engram
 * (tests/bridgecrypto.test.ts) that runs the real vault.js against this
 * bridge's real code; if the two ever disagree, that one fails.
 */

import { webcrypto } from 'node:crypto';
import { b64u, wrapContext } from '../../src/local/identity.js';

const C = webcrypto.subtle;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export interface Granter {
  signingPublicKey: string;
  privateKey: webcrypto.CryptoKey;
}

export async function makeGranter(): Promise<Granter> {
  const pair = (await C.generateKey(SIGN, true, ['sign', 'verify'])) as webcrypto.CryptoKeyPair;
  return {
    signingPublicKey: b64u.encode(await C.exportKey('raw', pair.publicKey)),
    privateKey: pair.privateKey,
  };
}

/** wrapToPublic(devicePublicKey, spaceKey, { space }) as vault.js does it. */
export async function wrapToDevice(
  publicKeyB64u: string, payload: Uint8Array, spaceId: string, granter: Granter,
  options: { unsigned?: boolean } = {},
): Promise<string> {
  const pub = await C.importKey('raw', b64u.decode(publicKeyB64u), CURVE, false, []);
  const eph = (await C.generateKey(CURVE, true, ['deriveBits'])) as webcrypto.CryptoKeyPair;
  const epk = b64u.encode(await C.exportKey('raw', eph.publicKey));
  const context = wrapContext('space-key', publicKeyB64u, epk, { space: spaceId });
  const aad = new TextEncoder().encode(context);
  const shared = await C.deriveBits({ name: 'ECDH', public: pub }, eph.privateKey, 256);
  const base = await C.importKey('raw', new Uint8Array(shared), 'HKDF', false, ['deriveKey']);
  const kek = await C.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: aad },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = b64u.encode(await C.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, kek, payload));
  if (options.unsigned) return JSON.stringify({ epk, iv: b64u.encode(iv), ct });
  const sig = b64u.encode(await C.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, granter.privateKey,
    new TextEncoder().encode(JSON.stringify([context, ct]))));
  return JSON.stringify({ epk, iv: b64u.encode(iv), ct, sig, by: granter.signingPublicKey });
}

/** sealSecret as vault.js does it: padded to a bucket, then AES-GCM. */
export async function seal(spaceKey: Uint8Array, value: string): Promise<{ iv: string; ct: string }> {
  const bytes = new TextEncoder().encode(value);
  const bucket = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384].find((b) => bytes.length + 4 <= b)!;
  const padded = new Uint8Array(bucket);
  new DataView(padded.buffer).setUint32(0, bytes.length);
  padded.set(bytes, 4);
  const key = await C.importKey('raw', spaceKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await C.encrypt({ name: 'AES-GCM', iv }, key, padded);
  return { iv: b64u.encode(iv), ct: b64u.encode(ct) };
}
