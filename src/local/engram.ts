import type { SecretFill } from '../protocol/types.js';
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

/** One decrypted secret, and the space it came from. */
export interface HeldSecret {
  /** Engram's id for it. Absent on an older Engram that does not send one. */
  id?: string;
  spaceId: string;
  /** The name in the vault. For logs and for the legacy name lookup. */
  name: string;
  value: string;
}

/**
 * Every secret this device can open, kept space by space.
 *
 * This used to be one flat map keyed by `space/name` AND by bare `name`, and
 * that flat map was a live cross-space leak. A tool defined in a shared space
 * could name a credential that exists only in the user's private space and be
 * handed it, because a bare name resolved against everything the device held.
 * The only thing in the way was a name collision, and colliding names were
 * deleted, so the reachable ones were exactly the uniquely named ones: the
 * opposite of a boundary.
 *
 * So there is no flat map and no bare form. Every lookup names a space, and a
 * lookup that cannot name one has nowhere to go.
 */
export class SecretStore {
  private readonly spaces = new Map<string, {
    byId: Map<string, HeldSecret>;
    /** null marks a name two secrets in this space share: reachable by id only. */
    byName: Map<string, HeldSecret | null>;
  }>();

  private space(spaceId: string): { byId: Map<string, HeldSecret>; byName: Map<string, HeldSecret | null> } {
    let bucket = this.spaces.get(spaceId);
    if (!bucket) {
      bucket = { byId: new Map(), byName: new Map() };
      this.spaces.set(spaceId, bucket);
    }
    return bucket;
  }

  add(secret: HeldSecret): void {
    const bucket = this.space(secret.spaceId);
    if (secret.id !== undefined) bucket.byId.set(secret.id, secret);
    // Two secrets in one space sharing a name: neither is served by guess,
    // for the same reason two spaces sharing one never were. An id still
    // reaches both, because an id is unambiguous.
    bucket.byName.set(secret.name, bucket.byName.has(secret.name) ? null : secret);
  }

  /** The secret with this id, IF it lives in this space. Otherwise nothing. */
  byId(spaceId: string, id: string): HeldSecret | undefined {
    return this.spaces.get(spaceId)?.byId.get(id);
  }

  /** The secret with this name in this space, unless the name is ambiguous there. */
  byName(spaceId: string, name: string): HeldSecret | undefined {
    return this.spaces.get(spaceId)?.byName.get(name) ?? undefined;
  }

  hasId(spaceId: string, id: string): boolean {
    return this.byId(spaceId, id) !== undefined;
  }

  hasName(spaceId: string, name: string): boolean {
    return this.byName(spaceId, name) !== undefined;
  }

  /** How many secrets are held, across every space. For logging only. */
  get size(): number {
    let n = 0;
    for (const bucket of this.spaces.values()) n += bucket.byName.size;
    return n;
  }

  /** The spaces this device holds anything for. For logging only. */
  spaceIds(): string[] {
    return [...this.spaces.keys()];
  }
}

/**
 * Fetch and open every secret this device is allowed to use.
 *
 * The space a secret came from is kept with it and is not decoration: it is
 * what every later lookup is checked against. A secret is never reachable
 * except through the space that holds it.
 */
export async function loadSecrets(
  cfg: EngramConfig,
  identity: Identity,
  deviceId: string,
): Promise<SecretStore> {
  const { keys } = await call<{ keys: { space_id: string; wrapped_key: string }[] }>(
    cfg, `/devices/${deviceId}/keys`,
  );
  const store = new SecretStore();
  if (keys.length === 0) {
    log.info('device holds no space keys yet; approve it in the browser and give it one');
    return store;
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
    secrets: { id?: string; space_id: string; name: string; envelope: { iv: string; ct: string } }[];
  }>(cfg, `/devices/${deviceId}/secrets`);

  for (const s of secrets) {
    const key = spaceKeys.get(s.space_id);
    if (!key) continue;
    let value: string;
    try {
      value = await openEnvelope(key, s.envelope);
    } catch {
      log.warn('could not open a secret; ignoring it', { space: s.space_id, name: s.name });
      continue;
    }
    store.add({ id: s.id, spaceId: s.space_id, name: s.name, value });
  }

  log.info('secrets available to local tools', {
    count: store.size,
    spaces: store.spaceIds().length,
  });
  return store;
}

/**
 * The secrets a tool declared BY NAME, from its own space and nowhere else.
 *
 * Two refusals here, and both used to be silent successes:
 *
 * 1. A tool that cannot name a space is refused outright. There is no bare
 *    lookup to fall back to any more, and falling back was the leak.
 * 2. A name that does not exist IN THAT SPACE fails the call rather than
 *    warning and running on. A tool that declared a credential and runs
 *    without it does not fail cleanly: it connects as nobody, writes an empty
 *    value into whatever it configures, or acts on the wrong target, and the
 *    model reads whatever comes back as the tool having worked.
 *
 * Missing means not granted, not yet approved, ambiguous within the space, or
 * held by a DIFFERENT space, and every one of those is for a person to fix in
 * the vault rather than for the bridge to paper over.
 */
export function grantedTo(
  store: SecretStore,
  spaceId: string | undefined,
  wanted: string[] | undefined,
): Redaction[] {
  if (!wanted || wanted.length === 0) return [];
  if (!spaceId) {
    log.warn('a local tool declared secrets without saying which space it belongs to');
    throw new Error(
      `this tool declared secrets but no space_id, so there is no space to resolve them in. ` +
      `A secret is only ever reachable through the space that holds it.`,
    );
  }

  const out: Redaction[] = [];
  for (const name of wanted) {
    const found = store.byName(spaceId, name);
    if (!found) {
      log.warn('a tool asked for a secret its space does not hold', { space: spaceId, name });
      throw new Error(
        `the space this tool belongs to does not hold a secret named "${name}". ` +
        `Approve the device in the vault and grant it that space's key, or check ` +
        `the secret lives in this space: one space cannot borrow another's credentials.`,
      );
    }
    out.push({ name: envName(found.name), value: found.value });
  }
  return out;
}

/**
 * A role a tool declared may only become an environment variable if it says
 * so plainly. Anything else is a tool definition to fix, not a name to mangle.
 */
const ROLE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** ENGRAM_SECRET_MAILBOX, from the role `mailbox`. */
export function roleEnvName(role: string): string {
  return `ENGRAM_SECRET_${role.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * Bind each role to the credential the caller chose for it.
 *
 * The tool reads the ROLE it declared, so one `fetch_mail` serves three Azure
 * app registrations instead of being written three times, and a tool never
 * learns what a credential is called.
 *
 * The space check is the whole security property: an id is a bearer-ish token
 * that a caller might hold for any number of reasons, and resolving it outside
 * the call's space would let a shared space's tool reach a private space's
 * credential by id rather than by name. Same leak, different key. So a secret
 * found in another space reads here exactly like one that does not exist.
 */
export function fillRoles(
  store: SecretStore,
  spaceId: string,
  fill: SecretFill[] | undefined,
): Redaction[] {
  const out: Redaction[] = [];
  const seen = new Map<string, string>();

  for (const entry of fill ?? []) {
    if (!ROLE.test(entry.role)) {
      throw new Error(
        `"${entry.role}" is not a usable role name. A role becomes an environment ` +
        `variable, so it must start with a letter and hold only letters, digits, ` +
        `"-" and "_".`,
      );
    }
    const variable = roleEnvName(entry.role);
    const collides = seen.get(variable);
    if (collides !== undefined) {
      // `mail-box` and `mail_box` are two roles and one variable. Picking one
      // would hand the tool a credential under a role it did not ask for.
      throw new Error(
        `the roles "${collides}" and "${entry.role}" both become ${variable}, ` +
        `so one would silently overwrite the other. Rename one of them.`,
      );
    }
    seen.set(variable, entry.role);

    const found = store.byId(spaceId, entry.secret_id);
    if (!found) {
      log.warn('a local call named a secret this space does not hold', {
        space: spaceId, role: entry.role,
      });
      throw new Error(
        `no secret with that id exists in the space this call names, so the role ` +
        `"${entry.role}" cannot be filled. Either this device has not been granted ` +
        `that space's key, or the secret belongs to a different space: a call ` +
        `cannot reach across spaces, by name or by id.`,
      );
    }
    out.push({ name: variable, value: found.value });
  }
  return out;
}
