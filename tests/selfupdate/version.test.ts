import { describe, it, expect } from 'vitest';
import { SELF_UPDATE_FLOOR, compareVersions, parseVersion } from '../../src/selfupdate/version.js';

describe('the version a server may name', () => {
  it('accepts strict semver, with or without a pre-release', () => {
    for (const v of ['0.24.0', '1.2.3', '10.0.1', '1.0.0-rc.1', '1.0.0-alpha.beta.1', '1.0.0-0']) {
      expect(parseVersion(v), v).toBe(v);
    }
  });

  it('refuses anything else: a v, a range, a tag, build metadata, a URL, a command, a package name', () => {
    for (const v of [
      'v0.24.0', '0.24', '0.24.0.1', '^0.24.0', '~0.24.0', '>=0.24.0', 'latest', 'next', '0.24.0+build.1',
      '01.2.3', '1.02.3', '1.0.0-01', ' 0.24.0', '0.24.0 ', '0.24.0;rm -rf ~', '0.24.0 && curl x',
      '@tetrixdev/ai-bridge@0.24.0', 'https://evil.example/ai-bridge.tgz', 'github:evil/fork', 'file:../x',
      '', '0.24.0\n', 24, null, undefined, {}, `1.0.0-${'a'.repeat(70)}`,
    ]) {
      expect(parseVersion(v), JSON.stringify(v)).toBeNull();
    }
  });
});

describe('comparing versions', () => {
  it('orders by major, minor, patch', () => {
    expect(compareVersions('0.24.0', '0.23.9')).toBe(1);
    expect(compareVersions('0.23.0', '0.24.0')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.24.10', '0.24.9')).toBe(1);
    expect(compareVersions('0.24.0', '0.24.0')).toBe(0);
  });

  it('puts a pre-release below its release, and orders pre-releases by semver', () => {
    expect(compareVersions('0.24.0-rc.1', '0.24.0')).toBe(-1);
    expect(compareVersions('0.24.0-rc.2', '0.24.0-rc.10')).toBe(-1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1);
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBe(-1);
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBe(1);
  });

  it('the floor is the first self-updating release', () => {
    expect(SELF_UPDATE_FLOOR).toBe('0.24.0');
    expect(compareVersions('0.24.0-rc.1', SELF_UPDATE_FLOOR)).toBe(-1);
  });
});
