/**
 * The version a server may ask a bridge to run, and how two versions compare.
 *
 * The server names a version and nothing else. Never a package name, a dist
 * tag, a range, a URL or a command: the package is fixed here, so the most a
 * server can do is pick one published release of it. That is the whole of the
 * trust this feature extends.
 */

/** The first release that follows a server's desired version by itself. */
export const SELF_UPDATE_FLOOR = '0.24.0';

/**
 * Strict semver: MAJOR.MINOR.PATCH with an optional pre-release, no leading
 * `v`, no build metadata, no leading zeros. A pre-release is allowed so a
 * release candidate can be rolled out to the machines that want it.
 */
const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/** The value, when it is a strict semver string; null for anything else. */
export function parseVersion(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64) return null;
  return STRICT_SEMVER.test(value) ? value : null;
}

/**
 * Semver precedence: negative when a < b, 0 when equal, positive when a > b.
 * Both must already have passed parseVersion().
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = split(a);
  const [coreB, preB] = split(b);
  for (let i = 0; i < 3; i++) {
    const d = coreA[i]! - coreB[i]!;
    if (d !== 0) return Math.sign(d);
  }
  // A version without a pre-release is HIGHER than the same one with one.
  if (preA === null || preB === null) return preA === preB ? 0 : preA === null ? 1 : -1;
  const pa = preA.split('.');
  const pb = preB.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (i >= pa.length) return -1;
    if (i >= pb.length) return 1;
    const x = pa[i]!;
    const y = pb[i]!;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return Math.sign(d);
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function split(v: string): [number[], string | null] {
  const dash = v.indexOf('-');
  const core = (dash < 0 ? v : v.slice(0, dash)).split('.').map(Number);
  return [core, dash < 0 ? null : v.slice(dash + 1)];
}
