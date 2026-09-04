/**
 * The containment rules for a server-named working directory.
 *
 * Everything here is one of the proofs the handover asked for: a bridge with
 * no allow-list refuses, an allowed checkout is accepted, `~/.ssh` and
 * `../secrets` are refused, a symlink inside the allowed root pointing outside
 * it is refused, and a directory that does not exist is refused rather than
 * created.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkingDir } from '../../src/workspace/resolve.js';
import { RequestRefusal } from '../../src/errors.js';
import { getBridgeWorkingDir } from '../../src/providers/env.js';

let root: string;
let allowed: string;
let checkout: string;
let outside: string;

beforeAll(() => {
  // realpath because macOS /tmp is itself a symlink, and the whole point of
  // this module is that both sides of the comparison are resolved.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-test-')));
  allowed = join(root, 'allowed');
  checkout = join(allowed, 'my-repo');
  outside = join(root, 'secrets');
  mkdirSync(checkout, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'key'), 'sensitive');
  // A symlink that lives inside the allowed root but points out of it. This is
  // the case a string comparison made before resolving would wave through.
  symlinkSync(outside, join(allowed, 'escape-hatch'), 'dir');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveWorkingDir', () => {
  it('returns the empty scratch directory when the server names nothing', () => {
    expect(resolveWorkingDir(undefined, [])).toBe(getBridgeWorkingDir());
    expect(resolveWorkingDir(undefined, [allowed])).toBe(getBridgeWorkingDir());
  });

  it('refuses any named directory when the operator passed no --allow-dir', () => {
    expect(() => resolveWorkingDir(checkout, [])).toThrow(RequestRefusal);
    try {
      resolveWorkingDir(checkout, []);
    } catch (err) {
      expect((err as RequestRefusal).code).toBe('working_dir_not_allowed');
      // The message has to name what was asked for and what is allowed, or the
      // operator cannot tell a typo from a missing flag.
      expect((err as RequestRefusal).message).toContain(checkout);
      expect((err as RequestRefusal).message).toContain('--allow-dir');
    }
  });

  it('does NOT fall back to the scratch directory when it refuses', () => {
    // The failure mode this guards: a refusal that silently ran in the empty
    // scratch dir would look like a turn that worked, with every answer wrong.
    expect(() => resolveWorkingDir(checkout, [])).toThrow();
  });

  it('accepts a checkout under an allowed root', () => {
    expect(resolveWorkingDir(checkout, [allowed])).toBe(checkout);
  });

  it('accepts the allowed root itself', () => {
    expect(resolveWorkingDir(allowed, [allowed])).toBe(allowed);
  });

  it('refuses a sibling whose path merely starts with the root string', () => {
    const sibling = `${allowed}-other`;
    mkdirSync(sibling, { recursive: true });
    try {
      expect(() => resolveWorkingDir(sibling, [allowed])).toThrow(RequestRefusal);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('refuses a directory outside every allowed root', () => {
    expect(() => resolveWorkingDir(outside, [allowed])).toThrow(RequestRefusal);
  });

  it('refuses a traversal back out of an allowed root', () => {
    expect(() => resolveWorkingDir(join(allowed, '..', 'secrets'), [allowed])).toThrow(RequestRefusal);
  });

  it('refuses a symlink inside the allowed root that points outside it', () => {
    const escape = join(allowed, 'escape-hatch');
    let code: string | undefined;
    try {
      resolveWorkingDir(escape, [allowed]);
    } catch (err) {
      code = (err as RequestRefusal).code;
    }
    expect(code).toBe('working_dir_not_allowed');
  });

  it('refuses a directory that does not exist, and does not create it', () => {
    const missing = join(allowed, 'not-there');
    let code: string | undefined;
    try {
      resolveWorkingDir(missing, [allowed]);
    } catch (err) {
      code = (err as RequestRefusal).code;
    }
    expect(code).toBe('working_dir_not_found');
    expect(existsSync(missing)).toBe(false);
  });

  it('refuses a path that is a file rather than a directory', () => {
    const file = join(checkout, 'README.md');
    writeFileSync(file, '# hi');
    expect(() => resolveWorkingDir(file, [allowed])).toThrow(RequestRefusal);
  });

  it('refuses a relative path', () => {
    expect(() => resolveWorkingDir('my-repo', [allowed])).toThrow(RequestRefusal);
  });

  it('refuses a path containing a null byte', () => {
    expect(() => resolveWorkingDir(`${checkout}\0/etc`, [allowed])).toThrow(RequestRefusal);
  });

  it('does not reveal whether a path outside the allow-list exists', () => {
    // Both of these are outside the roots; one exists and one does not. The
    // refusal must be identical in kind, or the server learns the filesystem
    // layout one request at a time.
    const real = (() => { try { resolveWorkingDir(outside, [allowed]); } catch (e) { return (e as RequestRefusal).code; } })();
    const fake = (() => { try { resolveWorkingDir(join(root, 'nope'), [allowed]); } catch (e) { return (e as RequestRefusal).code; } })();
    expect(real).toBe('working_dir_not_allowed');
    expect(fake).toBe('working_dir_not_allowed');
  });

  it('accepts a path under any one of several roots', () => {
    expect(resolveWorkingDir(checkout, [outside, allowed])).toBe(checkout);
  });
});
