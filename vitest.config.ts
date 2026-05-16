import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';

// Read package.json version for build-time constant injection (same as tsup.config.ts)
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8')) as { version: string };

export default defineConfig({
  define: {
    __BRIDGE_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    // EFF-009: globals:true was set but all test files use explicit imports.
    // Removed to avoid misleading new test authors and reduce setup overhead.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'],
    },
  },
});
