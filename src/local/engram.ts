import { createLogger } from '../utils/logger.js';
import { fingerprint, openEnvelope, unwrapToDevice, type Identity } from './identity.js';
import type { Redaction } from './scrub.js';

const log = createLogger('Engram');

/**
 * The bridge's client for Engram's device API.
 *
 * Everything Engram returns here is ciphertext. The decryption happens on this
 * machine with a key Engram has never held, which is the only reason any of
 * this is worth doing.
 */

export interface EngramConfig {
  /** https://engram.example.com */
  baseUrl: string;
  /** The same bearer credential the bridge uses for /mcp. */
  token: string;
}

async function call<T>(cfg: EngramConfig, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(new URL(path, cfg.baseUrl), {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.token}`,
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (!res.ok) throw new Error(body.error ?? `${path} failed: ${res.status}`);
  return body;
}

export interface Enrolled {
  deviceId: string;
  fingerprint: string;
}

/**
 * Register this device's public key. It comes back approved by nobody and
 * holding nothing: the fingerprint is what a person compares in the browser
 * before granting it anything.
 */
export async function enrol(
  cfg: EngramConfig,
  identity: Identity,
  label: string,
  mode: 'transcript' | 'isolated',
): Promise<Enrolled> {
  const { device } = await call<{ device: { id: string; fingerprint: string } }>(cfg, '/devices/enrol', {
    method: 'POST',
    body: JSON.stringify({ label, publicKey: identity.publicKey, mode }),
  });

  // Engram derives the fingerprint from the key it stored. Deriving it again
  // here and comparing is what catches a server that stored a different key
  // than the one sent, which is exactly the substitution the comparison in the
  // browser exists to catch. Trusting the value it returned would check nothing.
  const local = await fingerprint(identity.publicKey);
  if (local !== device.fingerprint) {
    throw new Error(
      `Engram returned a fingerprint for a different key than the one enrolled.\n` +
      `  this device: ${local}\n  Engram says: ${device.fingerprint}\n` +
      `Do not approve it. Something between here and the server changed the key.`,
    );
  }
  return { deviceId: device.id, fingerprint: local };
}

const envName = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/**
 * Fetch and open every secret this device is allowed to use.
 *
 * A name is exposed bare only when it is unambiguous. If two spaces both hold
 * `db-password`, neither is reachable as `db-password` and a tool must ask for
 * `space-id/db-password`, because silently picking one would hand a tool the
 * wrong client's credential and look like it worked.
 */
export async function loadSecrets(
  cfg: EngramConfig,
  identity: Identity,
  deviceId: string,
): Promise<Map<string, Redaction>> {
  const { keys } = await call<{ keys: { space_id: string; wrapped_key: string }[] }>(
    cfg, `/devices/${deviceId}/keys`,
  );
  if (keys.length === 0) {
    log.info('device holds no space keys yet; approve it in the browser and give it one');
    return new Map();
  }

  const spaceKeys = new Map<string, Uint8Array>();
  for (const k of keys) {
    try {
      spaceKeys.set(k.space_id, await unwrapToDevice(identity.privateKey, k.wrapped_key));
    } catch {
      // A key wrapped for a different device, or for a key we no longer hold.
      log.warn('could not open a space key; ignoring it', { space: k.space_id });
    }
  }

  const { secrets } = await call<{
    secrets: { space_id: string; name: string; envelope: { iv: string; ct: string } }[];
  }>(cfg, `/devices/${deviceId}/secrets`);

  const out = new Map<string, Redaction>();
  const ambiguous = new Set<string>();

  for (const s of secrets) {
    const key = spaceKeys.get(s.space_id);
    if (!key) continue;
    let value: string;
    try {
      value = await openEnvelope(key, s.envelope);
    } catch {
      log.warn('could not open a secret; ignoring it', { name: s.name });
      continue;
    }
    const qualified = `${s.space_id}/${s.name}`;
    out.set(qualified, { name: envName(s.name), value });

    if (out.has(s.name)) ambiguous.add(s.name);
    else out.set(s.name, { name: envName(s.name), value });
  }

  for (const name of ambiguous) {
    out.delete(name);
    log.warn('secret name exists in more than one space; qualify it with the space id', { name });
  }

  log.info('secrets available to local tools', { count: [...out.keys()].filter((k) => !k.includes('/')).length });
  return out;
}

/** The secrets a tool declared, and nothing else. */
export function grantedTo(available: Map<string, Redaction>, wanted: string[] | undefined): Redaction[] {
  const out: Redaction[] = [];
  for (const name of wanted ?? []) {
    const found = available.get(name);
    if (!found) {
      log.warn('a tool asked for a secret this device does not hold', { name });
      continue;
    }
    out.push(found);
  }
  return out;
}
