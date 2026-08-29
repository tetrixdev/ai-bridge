import { webcrypto } from 'node:crypto';

// Node exposes WebCrypto types under webcrypto rather than globally on the
// lib target this project builds against.
type CryptoKey = webcrypto.CryptoKey;
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * The device identity: a keypair generated here whose private half never leaves
 * this machine, and never reaches Engram.
 *
 * Losing it means re-enrolling, which is the correct trade: a private key the
 * server could restore is a private key the server has.
 */

const C = webcrypto.subtle;
const CURVE = { name: 'ECDH', namedCurve: 'P-256' } as const;

// Must match public/vault.js in Engram exactly. A person reads one aloud and
// compares it to the other, so a difference of one character makes the check
// unusable rather than merely ugly. No I, L, O or U: this is spoken.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

export const b64u = {
  encode: (buf: ArrayBuffer | Uint8Array): string =>
    Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  decode: (s: string): Uint8Array =>
    new Uint8Array(Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
};

export async function fingerprint(publicKeyB64u: string): Promise<string> {
  const digest = new Uint8Array(await C.digest('SHA-256', b64u.decode(publicKeyB64u)));
  let out = '';
  for (let i = 0; i < 20; i++) {
    if (i > 0 && i % 4 === 0) out += ' ';
    out += ALPHABET[digest[i]! % ALPHABET.length];
  }
  return out;
}

export interface Identity {
  publicKey: string;
  privateKey: CryptoKey;
  /** Set once Engram has been told about this key. */
  deviceId?: string;
}

interface StoredIdentity {
  publicKey: string;
  privateKey: string;
  deviceId?: string;
}

/**
 * Load the identity from disk, or make one.
 *
 * Written 0600. On a single-user install that is not a boundary against an
 * agent running as the same user, and the docs say so rather than implying
 * otherwise: it is the file mode that stops everything else on the machine.
 */
export async function loadOrCreateIdentity(path: string): Promise<Identity> {
  try {
    const stored = JSON.parse(await readFile(path, 'utf8')) as StoredIdentity;
    return {
      publicKey: stored.publicKey,
      privateKey: await C.importKey('pkcs8', b64u.decode(stored.privateKey), CURVE, true, ['deriveBits']),
      deviceId: stored.deviceId,
    };
  } catch {
    const pair = await C.generateKey(CURVE, true, ['deriveBits']);
    const identity: Identity = {
      publicKey: b64u.encode(await C.exportKey('raw', pair.publicKey)),
      privateKey: pair.privateKey,
    };
    await saveIdentity(path, identity);
    return identity;
  }
}

export async function saveIdentity(path: string, identity: Identity): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const stored: StoredIdentity = {
    publicKey: identity.publicKey,
    privateKey: b64u.encode(await C.exportKey('pkcs8', identity.privateKey)),
    deviceId: identity.deviceId,
  };
  await writeFile(path, JSON.stringify(stored, null, 2), { mode: 0o600 });
}

/**
 * Open something wrapped to this device's public key.
 *
 * Mirrors wrapToPublic in Engram's public/vault.js: an ephemeral ECDH keypair
 * per wrap, HKDF to an AES key, AES-GCM. The salt is empty because the
 * ephemeral public key already makes every derivation unique.
 */
export async function unwrapToDevice(privateKey: CryptoKey, wrappedJson: string): Promise<Uint8Array> {
  const w = JSON.parse(wrappedJson) as { epk: string; iv: string; ct: string };
  const eph = await C.importKey('raw', b64u.decode(w.epk), CURVE, false, []);
  const shared = await C.deriveBits({ name: 'ECDH', public: eph }, privateKey, 256);
  const base = await C.importKey('raw', new Uint8Array(shared), 'HKDF', false, ['deriveKey']);
  const kek = await C.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('engram-space-key') },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  return new Uint8Array(await C.decrypt({ name: 'AES-GCM', iv: b64u.decode(w.iv) }, kek, b64u.decode(w.ct)));
}

export async function openEnvelope(spaceKey: Uint8Array, envelope: { iv: string; ct: string }): Promise<string> {
  const key = await C.importKey('raw', spaceKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await C.decrypt({ name: 'AES-GCM', iv: b64u.decode(envelope.iv) }, key, b64u.decode(envelope.ct));
  return new TextDecoder().decode(plain);
}
