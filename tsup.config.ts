import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  // EFF-011: This is a CLI-only package (invoked via npx/bin, not imported as
  // a library).  Type declarations serve no purpose for end users and add build
  // time and package size unnecessarily.
  dts: false,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  define: {
    __BRIDGE_VERSION__: JSON.stringify(pkg.version),
  },
});
