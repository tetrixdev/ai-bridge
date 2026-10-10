import type { ItemFill } from '../protocol/types.js';
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
  /** The name Engram shows this device under, beside the fingerprint. */
  label: string;
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
  hostname?: string,
): Promise<Enrolled> {
  const { device } = await call<{ device: { id: string; fingerprint: string; label?: string } }>(cfg, '/devices/enrol', {
    method: 'POST',
    body: JSON.stringify({ label, publicKey: identity.publicKey, mode, ...(hostname ? { hostname } : {}) }),
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
  // The name the device is shown under, which is the paired machine's own name
  // when the token was issued for one (Engram puts the key on that machine).
  return { deviceId: device.id, fingerprint: local, label: device.label ?? label };
}

/** One decrypted sealed value, and where it belongs. */
export interface HeldSecret {
  /** Engram's id for the sealed value, which is what a call names. */
  id: string;
  /** The space it is sealed in, which is the key that opened it. */
  spaceId: string;
  /** The vault item it is one sealed field of, and which field. */
  itemId: string;
  field: string;
  value: string;
}

/**
 * Every sealed value this device can open, kept space by space.
 *
 * Every lookup names a space as well as an id, and a value found under
 * another space reads exactly as one that does not exist. A call carries, for
 * each sealed field, the space the value is sealed in, which may differ from
 * the tool's own: a tool in a shared space may run with an item from the
 * person's private space when that person chose it. Deciding THAT is Engram's
 * (a person's consent, recorded against the tool's definition); what the
 * bridge holds to is that a value is only ever read through the space that
 * sealed it, and only when it is the field of the item the call says it is.
 */
export class SecretStore {
  private readonly spaces = new Map<string, Map<string, HeldSecret>>();

  add(secret: HeldSecret): void {
    let bucket = this.spaces.get(secret.spaceId);
    if (!bucket) {
      bucket = new Map();
      this.spaces.set(secret.spaceId, bucket);
    }
    bucket.set(secret.id, secret);
  }

  /** The value with this id, IF it is sealed in this space. Otherwise nothing. */
  byId(spaceId: string, id: string): HeldSecret | undefined {
    return this.spaces.get(spaceId)?.get(id);
  }

  hasId(spaceId: string, id: string): boolean {
    return this.byId(spaceId, id) !== undefined;
  }

  /** How many values are held, across every space. For logging only. */
  get size(): number {
    let n = 0;
    for (const bucket of this.spaces.values()) n += bucket.size;
    return n;
  }

  /** The spaces this device holds anything for. For logging only. */
  spaceIds(): string[] {
    return [...this.spaces.keys()];
  }
}

/**
 * Fetch and open every sealed value this device is allowed to use.
 *
 * The space a value came from is kept with it and is not decoration: it is
 * what every later lookup is checked against.
 */
export async function loadSecrets(
  cfg: EngramConfig,
  identity: Identity,
  deviceId: string,
): Promise<SecretStore> {
  const { keys } = await call<{
    keys: { space_id: string; wrapped_key: string; granted_by_signing_key?: string | null }[];
  }>(cfg, `/devices/${deviceId}/keys`);
  const store = new SecretStore();
  if (keys.length === 0) {
    log.info('device holds no space keys yet; approve it in the browser and give it one');
    return store;
  }

  const spaceKeys = new Map<string, Uint8Array>();
  for (const k of keys) {
    try {
      spaceKeys.set(k.space_id, await unwrapToDevice(
        identity, k.wrapped_key, { space: k.space_id }, k.granted_by_signing_key));
    } catch (err) {
      // A key wrapped for a different device, for a key we no longer hold, in
      // the format before wraps were bound to their space, or not signed by
      // whoever granted it. Said, because "no secrets" with nothing in the log
      // is the failure this used to be.
      log.warn('could not open a space key; ignoring it', {
        space: k.space_id, reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const { secrets } = await call<{
    secrets: { id: string; space_id: string; item_id: string; field: string; envelope: { iv: string; ct: string } }[];
  }>(cfg, `/devices/${deviceId}/secrets`);

  for (const s of secrets) {
    const key = spaceKeys.get(s.space_id);
    if (!key) continue;
    let value: string;
    try {
      value = await openEnvelope(key, s.envelope);
    } catch {
      log.warn('could not open a sealed value; ignoring it', { space: s.space_id, field: s.field });
      continue;
    }
    store.add({ id: s.id, spaceId: s.space_id, itemId: s.item_id, field: s.field, value });
  }

  log.info('sealed values available to local tools', {
    count: store.size,
    spaces: store.spaceIds().length,
  });
  return store;
}

/** A role or a field may only become part of an environment variable if it says so plainly. */
const ROLE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const FIELD = /^[a-z][a-z0-9_]*$/;

/**
 * ENGRAM_MAILBOX_CLIENT_SECRET, from the role `mailbox` and the field
 * `client_secret`. Upper case, `-` to `_`. The same scheme for plain and
 * sealed fields, so a tool reads every field of its item the same way and
 * never learns which were secret.
 */
export function fieldEnvName(role: string, field: string): string {
  return `ENGRAM_${role}_${field}`.toUpperCase().replace(/-/g, '_');
}

/** What filling a call's roles produces: plain values, and sealed ones to inject AND scrub. */
export interface Filled {
  /** Plain fields. Not secret, so injected and not scrubbed. */
  env: Record<string, string>;
  /** Sealed fields, opened here. Injected, and scrubbed from everything the tool says. */
  sealed: Redaction[];
}

/**
 * Turn each role's item into environment variables, one per field the need
 * named: plain fields as the values the call carries, sealed fields opened
 * from the space they are sealed in.
 *
 * The tool reads the ROLE and the FIELD it declared, so one `fetch_mail` serves
 * three Azure app registrations instead of being written three times, and a
 * tool never learns what an item is called.
 *
 * Each sealed field is checked three ways before it is opened: the value is
 * held under the space the call names for it, it is a field of the item the
 * call names, and it is the field the call says it is. A server naming a value
 * from one item under another's role reads exactly as one naming a value that
 * does not exist.
 */
export function fillRoles(store: SecretStore, fill: ItemFill[] | undefined): Filled {
  const out: Filled = { env: {}, sealed: [] };
  const seen = new Map<string, string>();
  const claim = (variable: string, by: string): void => {
    const collides = seen.get(variable);
    if (collides !== undefined) {
      // `mail-box` and `mail_box` are two roles and one variable. Picking one
      // would hand the tool a value under a name it did not ask for.
      throw new Error(
        `${collides} and ${by} both become ${variable}, so one would silently overwrite ` +
        `the other. Rename one of them in the tool definition.`,
      );
    }
    seen.set(variable, by);
  };

  for (const entry of fill ?? []) {
    if (!ROLE.test(entry.role)) {
      throw new Error(
        `"${entry.role}" is not a usable role name. A role becomes part of an environment ` +
        `variable, so it must start with a letter and hold only letters, digits, "-" and "_".`,
      );
    }
    for (const [field, value] of Object.entries(entry.fields ?? {})) {
      if (!FIELD.test(field) || typeof value !== 'string') {
        throw new Error(`the plain field "${field}" of role "${entry.role}" is not a lowercase name with a string value`);
      }
      const variable = fieldEnvName(entry.role, field);
      claim(variable, `role "${entry.role}" field "${field}"`);
      out.env[variable] = value;
    }
    for (const ref of entry.sealed ?? []) {
      if (!FIELD.test(ref.field)) {
        throw new Error(`the sealed field "${ref.field}" of role "${entry.role}" is not a lowercase name`);
      }
      const variable = fieldEnvName(entry.role, ref.field);
      claim(variable, `role "${entry.role}" field "${ref.field}"`);
      const found = store.byId(ref.space_id, ref.secret_id);
      if (!found || found.itemId !== entry.item_id || found.field !== ref.field) {
        log.warn('a local call named a sealed value this device cannot match', {
          space: ref.space_id, role: entry.role, field: ref.field,
        });
        throw new Error(
          `the sealed field "${ref.field}" for the role "${entry.role}" cannot be filled: this ` +
          `device holds no such value, sealed in the space the call names, as that field of that ` +
          `item. Either this device has not been handed that space's key (the Vault page lists ` +
          `it under your devices), or the field was filled after the device last looked.`,
        );
      }
      out.sealed.push({ name: variable, value: found.value });
    }
  }
  return out;
}

/** A sealed value a call needs: its id and the space it is sealed in. */
export interface SealedRef {
  space_id: string;
  secret_id: string;
}

/** Every sealed value a fill names, for the cache to check before a call runs. */
export function sealedRefs(fill: ItemFill[] | undefined): SealedRef[] {
  return (fill ?? []).flatMap((f) => (f.sealed ?? []).map((r) => ({ space_id: r.space_id, secret_id: r.secret_id })));
}
