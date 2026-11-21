/**
 * A stand-in secret command for the tests: an executable script in a temp
 * folder that keeps its store in a JSON file and records every run (argv,
 * stdin, environment) so a test can see exactly what the bridge handed it.
 *
 * Behaviour is steered by files beside it: `sleep` (seconds to wait first),
 * `exit` (an exit code to answer with instead), `stdout` (what `list` prints
 * instead), `stderr` (printed to stderr on every run, with the stdin appended).
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeRun {
  argv: string[];
  stdin: string;
  env: Record<string, string>;
}

export interface FakeCommand {
  dir: string;
  path: string;
  runs(): FakeRun[];
  store(): Record<string, { value: string; description: string | null }>;
  set(file: 'sleep' | 'exit' | 'stdout' | 'stderr', content: string): void;
  cleanup(): void;
}

const SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
const file = (n) => path.join(dir, n);
const read = (n) => fs.existsSync(file(n)) ? fs.readFileSync(file(n), 'utf8') : null;
let stdin = '';
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  fs.appendFileSync(file('runs.ndjson'), JSON.stringify({ argv, stdin, env: process.env }) + '\n');
  const go = () => {
    const err = read('stderr');
    if (err !== null) process.stderr.write(err + stdin);
    const exit = read('exit');
    if (exit !== null) process.exit(Number(exit));
    const store = JSON.parse(read('store.json') || '{}');
    const save = () => fs.writeFileSync(file('store.json'), JSON.stringify(store));
    const [op, name] = argv;
    if (op === 'list') {
      const out = read('stdout');
      if (out !== null) { process.stdout.write(out); return; }
      process.stdout.write(JSON.stringify(Object.entries(store).map(([n, s]) => ({ name: n, description: s.description, updated_at: '2026-11-21T10:00:00Z' }))));
      return;
    }
    if (op === 'put') {
      const replace = argv.includes('--replace');
      const di = argv.indexOf('--description');
      const existed = name in store;
      if (existed && !replace) process.exit(3);
      store[name] = { value: stdin, description: di >= 0 ? argv[di + 1] : (existed ? store[name].description : null) };
      save();
      process.stdout.write(JSON.stringify({ replaced: existed }));
      return;
    }
    if (op === 'describe') {
      if (!(name in store)) process.exit(2);
      store[name].description = argv[3];
      save();
      return;
    }
    if (op === 'remove') {
      if (!(name in store)) process.exit(2);
      delete store[name];
      save();
      return;
    }
    process.exit(1);
  };
  const sleep = Number(read('sleep') || '0');
  if (sleep > 0) setTimeout(go, sleep * 1000); else go();
});
`;

export function makeFakeCommand(): FakeCommand {
  const dir = mkdtempSync(join(tmpdir(), 'secret-cmd-'));
  const path = join(dir, 'secret.cjs');
  writeFileSync(path, `#!${process.execPath}\n${SCRIPT}`);
  chmodSync(path, 0o755);
  return {
    dir,
    path,
    runs: () => existsSync(join(dir, 'runs.ndjson'))
      ? readFileSync(join(dir, 'runs.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as FakeRun)
      : [],
    store: () => existsSync(join(dir, 'store.json')) ? JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')) : {},
    set: (name, content) => writeFileSync(join(dir, name), content),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
