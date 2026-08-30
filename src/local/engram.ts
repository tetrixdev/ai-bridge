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
 *
 * Both forms share one map, which only works while `/` cannot appear in a bare
 * name, so a name containing one is dropped rather than stored. See below.
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
    if (s.name.includes('/')) {
      // `/` is what separates a space from a name here, so a secret NAMED
      // `alpha/db-password` produces a bare key identical to space `alpha`'s
      // qualified key for `db-password`. The ambiguity sweep below then deletes
      // that entry, and the tool that asked for `alpha/db-password` runs with
      // no credential at all rather than the wrong one. Dropping the name keeps
      // the two forms disjoint: a bare key never contains `/`, a qualified key
      // always does.
      log.warn('ignoring a secret whose name contains "/"; rename it in the vault', {
        space: s.space_id, name: s.name,
      });
      continue;
    }
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

/**
 * The secrets a tool declared, and nothing else.
 *
 * A missing one throws rather than warning and running on. A tool that declared
 * a credential and runs without it does not fail cleanly: it connects as
 * nobody, writes an empty value into whatever it configures, or acts on the
 * wrong target, and the model reads whatever comes back as the tool having
 * worked. Missing means not granted, not yet approved, or ambiguous across
 * spaces, and every one of those is for a person to fix in the vault rather
 * than for the bridge to paper over.
 */
export function grantedTo(available: Map<string, Redaction>, wanted: string[] | undefined): Redaction[] {
  const out: Redaction[] = [];
  for (const name of wanted ?? []) {
    const found = available.get(name);
    if (!found) {
      log.warn('a tool asked for a secret this device does not hold', { name });
      throw new Error(
        `this device does not hold the secret "${name}" that the tool declared. ` +
        `Approve the device in the vault and grant it the space key, or ask for ` +
        `"space-id/${name}" if that name exists in more than one space.`,
      );
    }
    out.push(found);
  }
  return out;
}
