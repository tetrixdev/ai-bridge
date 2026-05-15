import { describe, it, expect } from 'vitest';
import { PROTOCOL_VERSION, BRIDGE_VERSION } from '../../src/protocol/version.js';
import { createRequire } from 'node:module';

describe('Protocol Version', () => {
  describe('PROTOCOL_VERSION', () => {
    it('is a non-empty string', () => {
      expect(typeof PROTOCOL_VERSION).toBe('string');
      expect(PROTOCOL_VERSION.length).toBeGreaterThan(0);
    });

    it('is a valid semver-like version string', () => {
      // Should match patterns like "0.1", "1.0", "1.2.3"
      expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+(\.\d+)?$/);
    });
  });

  describe('BRIDGE_VERSION', () => {
    it('is a non-empty string', () => {
      expect(typeof BRIDGE_VERSION).toBe('string');
      expect(BRIDGE_VERSION.length).toBeGreaterThan(0);
    });

    it('matches the version in package.json', () => {
      const require = createRequire(import.meta.url);
      const pkg = require('../../package.json') as { version: string };
      expect(BRIDGE_VERSION).toBe(pkg.version);
    });

    it('is a valid semver string', () => {
      // Standard semver: major.minor.patch with optional pre-release
      expect(BRIDGE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    });
  });
});
