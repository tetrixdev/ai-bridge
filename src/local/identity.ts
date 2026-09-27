import { webcrypto } from 'node:crypto';

// Node exposes WebCrypto types under webcrypto rather than globally on the
// lib target this project builds against.
type CryptoKey = webcrypto.CryptoKey;
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
 *
 * Only a file that is NOT THERE means "make one". Anything else, an unreadable
 * file, a directory in its place, a half-written or corrupt one, is an error.
 * A blanket catch here would generate a fresh keypair on top of an existing
 * enrolment: the device id and every space key granted to it are gone, the
 * bridge reports a healthy first run with a new fingerprint to approve, and the
 * only evidence that anything was lost is a device in the vault nobody can
 * match to a machine any more.
 */
export async function loadOrCreateIdentity(path: string): Promise<Identity> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `could not read the device identity at ${path}: ${(err as Error).message}. ` +
        `Refusing to enrol a new key over it.`,
      );
    }
    const pair = await C.generateKey(CURVE, true, ['deriveBits']);
    const identity: Identity = {
      publicKey: b64u.encode(await C.exportKey('raw', pair.publicKey)),
      privateKey: pair.privateKey,
    };
    await saveIdentity(path, identity);
    return identity;
  }

  try {
    const stored = JSON.parse(raw) as StoredIdentity;
    return {
      publicKey: stored.publicKey,
      privateKey: await C.importKey('pkcs8', b64u.decode(stored.privateKey), CURVE, true, ['deriveBits']),
      deviceId: stored.deviceId,
    };
  } catch (err) {
    throw new Error(
      `the device identity at ${path} is corrupt: ${(err as Error).message}. ` +
      `Move it aside to enrol this machine again, which revokes nothing: the old ` +
      `device stays in the vault until someone removes it there.`,
    );
  }
}

/**
 * Write the identity atomically, and tighten the mode whatever it was.
 *
 * Both halves matter and both were missing. `writeFile`'s `mode` applies only
 * when it CREATES the file, so a device.json that already existed 0644, from an
 * older bridge, a restore, a copy, keeps handing the private key to every
 * account on the machine no matter how many times this runs. And writing in
 * place truncates first: a crash, a full disk or a kill between truncate and
 * write leaves a file that parses as nothing, which is the state
 * loadOrCreateIdentity now refuses rather than silently re-enrolling over.
 * Writing a fresh 0600 temp file and renaming it means the path only ever names
 * a complete identity, old or new.
 */
export async function saveIdentity(path: string, identity: Identity): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const stored: StoredIdentity = {
    publicKey: identity.publicKey,
    privateKey: b64u.encode(await C.exportKey('pkcs8', identity.privateKey)),
    deviceId: identity.deviceId,
  };

  // Unique per write: two bridges starting at once must not share a temp file
  // and rename each other's half-written bytes into place.
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(stored, null, 2), { mode: 0o600 });
    // Explicit, because the mode above is masked by the process umask and a
    // permissive umask would otherwise decide who can read a private key.
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/**
 * What a wrap is FOR, computed on this side from what the device already knows.
 *
 * Must match `wrapContext` in Engram's public/vault.js byte for byte: it is the
 * HKDF info AND the AES-GCM additional data, so one character of difference
 * fails to decrypt rather than decrypting into the wrong meaning. It binds the
 * wrap to this device's own public key, the ephemeral key, and the space, so a
 * server cannot answer "the key for space B" with the wrap made for space A.
 *
 * Ordered and JSON-encoded rather than concatenated, as in the browser, so a
 * value containing a separator cannot forge a different context. The four
 * trailing slots are the scope; a wrap to a device names only its space, so
 * generation and holder stay null exactly as the browser leaves them.
 */
export function wrapContext(
  purpose: string,
  recipientRawB64u: string,
  epkRawB64u: string,
  scope: { space?: string | null; generation?: number | null; holderType?: string | null; holderId?: string | null } = {},
): string {
  return JSON.stringify([
    'engram-wrap-v2', purpose, recipientRawB64u, epkRawB64u,
    scope.space ?? null, scope.generation ?? null,
    scope.holderType ?? null, scope.holderId ?? null,
  ]);
}

/** What a grant signature covers: the context and the ciphertext, length-delimited
 *  so one cannot be shifted into the other. Mirrors `signedBytes` in vault.js. */
function signedBytes(context: string, ctB64u: string): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([context, ctB64u]));
}

const SIGN = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN_ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;

/**
 * Open a space key wrapped to this device, refusing one its granter did not sign.
 *
 * Mirrors `unwrapToPrivate` in Engram's public/vault.js: an ephemeral ECDH key
 * per wrap, HKDF to an AES key with the bound context as its info, AES-GCM with
 * the same context as additional data. The salt is 32 zero bytes, as there.
 *
 * `signedBy` is the granter's signing key, which Engram serves BESIDE the wrap
 * rather than inside it: a wrap that named its own signer would authenticate
 * nothing, so the `by` inside it is only ever compared against this. A device
 * requires a signature where the browser tolerates a legacy unsigned wrap,
 * because every grant to a device is made by a browser that signs, so there is
 * no legitimate unsigned device wrap to be compatible with. Without the check
 * anyone holding this device's public key, which the server serves by design,
 * could mint a wrap of a key they chose and feed a tool values of their own.
 */
export async function unwrapToDevice(
  identity: Pick<Identity, 'privateKey' | 'publicKey'>,
  wrappedJson: string,
  scope: { space: string },
  signedBy: string | null | undefined,
): Promise<Uint8Array> {
  const w = JSON.parse(wrappedJson) as { epk: string; iv: string; ct: string; sig?: string; by?: string };
  const context = wrapContext('space-key', identity.publicKey, w.epk, scope);

  if (!signedBy) {
    throw new Error(
      'Engram sent no signing key for whoever granted this space key, so the wrap cannot be ' +
      'checked and is refused. Hand this machine the key again from the vault.',
    );
  }
  if (!w.sig) {
    throw new Error(
      'this space key is not signed, and an unsigned wrap could have come from anyone. ' +
      'Hand this machine the key again from the vault.',
    );
  }
  if (w.by && w.by !== signedBy) {
    throw new Error('this space key says it was signed by somebody other than the person who granted it');
  }
  const verifier = await C.importKey('raw', b64u.decode(signedBy), SIGN, false, ['verify']);
  const ok = await C.verify(SIGN_ALG, verifier, b64u.decode(w.sig), signedBytes(context, w.ct));
  if (!ok) {
    throw new Error(
      'this space key was not signed by the key it should have been. It is refused: something ' +
      'has substituted a key between the vault and this machine.',
    );
  }

  const aad = new TextEncoder().encode(context);
  const eph = await C.importKey('raw', b64u.decode(w.epk), CURVE, false, []);
  const shared = await C.deriveBits({ name: 'ECDH', public: eph }, identity.privateKey, 256);
  const base = await C.importKey('raw', new Uint8Array(shared), 'HKDF', false, ['deriveKey']);
  const kek = await C.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: aad },
    base, { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  return new Uint8Array(await C.decrypt(
    { name: 'AES-GCM', iv: b64u.decode(w.iv), additionalData: aad }, kek, b64u.decode(w.ct)));
}

/**
 * Undo the vault's size padding: a 4-byte big-endian length, the value, zeros.
 *
 * Mirrors `unpadded` in vault.js. The browser pads every sealed value to a
 * bucket so a stored envelope does not give away how long its secret is; a
 * device that skipped this would hand a tool the value followed by NUL bytes,
 * which reads as a credential that is almost right and fails every login.
 */
export function unpad(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4) throw new Error('this envelope is malformed');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (length > bytes.length - 4) throw new Error('this envelope is malformed');
  return bytes.subarray(4, 4 + length);
}

export async function openEnvelope(spaceKey: Uint8Array, envelope: { iv: string; ct: string }): Promise<string> {
  const key = await C.importKey('raw', spaceKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await C.decrypt({ name: 'AES-GCM', iv: b64u.decode(envelope.iv) }, key, b64u.decode(envelope.ct));
  return new TextDecoder().decode(unpad(new Uint8Array(plain)));
}
