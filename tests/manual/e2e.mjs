#!/usr/bin/env node
/**
 * End-to-end checks against the built bridge and a real provider CLI.
 *
 * Not part of `npm test` — see README.md in this directory. Run from the repo
 * root after `npm run build`.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');

const WITH_CLI = process.argv.includes('--with-cli');
const BRIDGE = new URL('../../dist/cli.js', import.meta.url).pathname;

if (!existsSync(BRIDGE)) {
  console.error('dist/cli.js is missing — run `npm run build` first.');
  process.exit(1);
}

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

/**
 * Run one turn against a real bridge process and collect what the server saw.
 *
 * `isolation` of 'omit' leaves `cli_isolation` off the welcome entirely, which
 * is how a server predating this feature behaves.
 */
async function turn({ isolation = 'workspace', request, args = [], assets = {}, timeoutMs = 120_000 }) {
  const frames = [];
  let advertised = null;

  const http = createServer((req, res) => {
    const body = assets[(req.url ?? '').split('?')[0]];
    if (!body) return void res.writeHead(404).end('no');
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.end(body);
  });
  const wss = new WebSocketServer({ server: http });

  await new Promise((r) => http.listen(0, '127.0.0.1', r));
  const port = http.address().port;
  const origin = `http://127.0.0.1:${port}`;

  const bridgeLog = [];
  const child = spawn(process.execPath, [
    BRIDGE, '--server', `ws://127.0.0.1:${port}`, '--token', 'manual-e2e',
    '--api', origin, ...args,
  ]);
  child.stdout.on('data', (c) => bridgeLog.push(c.toString()));
  child.stderr.on('data', (c) => bridgeLog.push(c.toString()));

  const done = new Promise((resolve) => {
    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        frames.push(msg);

        if (msg.type === 'hello') {
          advertised = msg.workspaces ?? [];
          ws.send(JSON.stringify({
            type: 'welcome',
            session_id: 'manual-e2e',
            tools: [],
            config: { heartbeat_interval: 30, request_timeout: 300 },
            ...(isolation === 'omit' ? {} : { cli_isolation: isolation }),
          }));
          if (request) {
            // The port is only known now, so callers write __ORIGIN__.
            ws.send(JSON.stringify(request).replaceAll('__ORIGIN__', origin));
          } else {
            setTimeout(resolve, 400);
          }
        }
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
        if (msg.type === 'stream' && msg.event === 'done') setTimeout(resolve, 200);
      });
    });
  });

  const timer = setTimeout(() => undefined, timeoutMs);
  await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))]);
  clearTimeout(timer);

  child.kill();
  wss.close();
  await new Promise((r) => http.close(r));

  const stream = frames.filter((f) => f.type === 'stream');
  return {
    advertised,
    log: bridgeLog.join(''),
    errorCode: stream.find((f) => f.event === 'error')?.data?.code ?? null,
    errorMessage: stream.find((f) => f.event === 'error')?.data?.message ?? null,
    sawDone: stream.some((f) => f.event === 'done'),
    spawned: bridgeLog.join('').includes('Executing Claude request'),
    text: stream.filter((f) => f.event === 'block_delta').map((f) => f.data.content).join(''),
  };
}

function aiRequest(extra = {}) {
  return {
    type: 'ai_request',
    request_id: `manual_${Math.random().toString(36).slice(2, 8)}`,
    conversation_id: 'manual-conv',
    provider: 'claude',
    message: 'hello',
    system_prompt: null,
    options: {},
    cli_session_id: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------

const root = mkdtempSync(join(tmpdir(), 'ai-bridge-e2e-'));
const repo = join(root, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });
symlinkSync(homedir(), join(root, 'escape-hatch'), 'dir');
symlinkSync(homedir(), join(repo, 'inside-escape'), 'dir');

try {
  console.log('\nContainment — a server must not be able to name a directory the operator did not allow\n');

  let r = await turn({ request: aiRequest({ working_dir: repo }) });
  check('no --allow-dir refuses a named directory', r.errorCode === 'working_dir_not_allowed', `got ${r.errorCode}`);
  check('...and does not spawn the CLI anyway', !r.spawned);
  check('...and terminates the turn', r.sawDone);

  const allow = ['--allow-dir', repo];
  for (const [name, dir, expected] of [
    ['~/.ssh is refused', join(homedir(), '.ssh'), 'working_dir_not_allowed'],
    ['a traversal out of the root is refused', join(repo, '..', '..', 'etc'), 'working_dir_not_allowed'],
    ['a symlink inside the root pointing out is refused', join(repo, 'inside-escape'), 'working_dir_not_allowed'],
    ['a directory that does not exist is refused', join(repo, 'nope'), 'working_dir_not_found'],
  ]) {
    r = await turn({ request: aiRequest({ working_dir: dir }), args: allow });
    check(name, r.errorCode === expected, `got ${r.errorCode}: ${r.errorMessage}`);
  }
  check('...and the missing directory was not created', !existsSync(join(repo, 'nope')));

  r = await turn({
    request: aiRequest({
      attachments: [{
        id: 'a1', name: 'x.pdf', mime_type: 'application/pdf',
        size: 3, sha256: 'abc', url: 'https://evil.example.com/x.pdf',
      }],
    }),
    args: allow,
  });
  check('an attachment on another host is refused', r.errorCode === 'attachment_refused', `got ${r.errorCode}`);

  console.log('\nThe posture gate — the operator decides what a server may do\n');

  for (const [name, isolation, args, expected] of [
    ['workspace without --allow-dir falls back to isolated', 'workspace', [], 'isolated'],
    ['native without --allow-native falls back to isolated', 'native', [], 'isolated'],
    ['native with --allow-native is adopted', 'native', ['--allow-native'], 'native'],
    ['workspace with --allow-dir is adopted', 'workspace', allow, 'workspace'],
  ]) {
    r = await turn({ isolation, args, request: null });
    const adopted = /cliIsolation":"([a-z]+)"/.exec(r.log)?.[1];
    check(name, adopted === expected, `adopted ${adopted}`);
  }

  r = await turn({ request: null, args: allow });
  check('the allow-list is advertised on hello', r.advertised?.[0]?.path === repo, JSON.stringify(r.advertised));

  if (!WITH_CLI) {
    console.log('\nSkipping the provider turns. Pass --with-cli to run them.\n');
  } else {
    console.log('\nReal turns — these spend tokens\n');

    writeFileSync(join(repo, 'package.json'), '{ "name": "e2e", "type": "module", "private": true }');
    writeFileSync(join(repo, 'src', 'answer.js'), 'export const answer = 41;\n');
    writeFileSync(join(repo, 'test.js'),
      "import { answer } from './src/answer.js';\n"
      + "if (answer !== 42) { console.error('FAIL'); process.exit(1); }\nconsole.log('PASS');\n");

    r = await turn({
      request: aiRequest({
        working_dir: repo,
        message: "Run 'node test.js' here. It fails. Fix the source so it passes, then run it again.",
      }),
      args: allow,
      timeoutMs: 300_000,
    });
    let testPasses = false;
    try {
      execFileSync(process.execPath, ['test.js'], { cwd: repo });
      testPasses = true;
    } catch { /* still failing */ }
    check('a workspace turn reads, edits and runs the test', testPasses,
      'test.js still fails — the turn did not fix the source');
    check('...and the edit is really in the working tree',
      readFileSync(join(repo, 'src', 'answer.js'), 'utf-8').includes('42'));

    // Larger than the server's 1 MB frame cap: the case that could never have
    // travelled on the wire.
    const body = Buffer.concat([
      Buffer.from('PADDING\n'.repeat(150_000)),
      Buffer.from('\nThe reference code is MAGIC-E2E-4417.\n'),
    ]);
    r = await turn({
      request: aiRequest({
        message: 'What is the reference code in the attached file? Answer in one line.',
        attachments: [{
          id: 'a1', name: 'invoice.txt', mime_type: 'text/plain',
          size: body.byteLength,
          sha256: createHash('sha256').update(body).digest('hex'),
          url: '__ORIGIN__/att',
        }],
      }),
      isolation: 'isolated',
      assets: { '/att': body },
      timeoutMs: 300_000,
    });
    check('an attachment over 1 MB reaches the model', r.text.includes('MAGIC-E2E-4417'),
      `assistant said: ${r.text.slice(0, 200)}`);
    const dirs = existsSync(join(homedir(), '.cache', 'ai-bridge', 'attachments'))
      ? require('node:fs').readdirSync(join(homedir(), '.cache', 'ai-bridge', 'attachments'))
      : [];
    check('...and its directory is gone afterwards', dirs.length === 0, `left behind: ${dirs.join(', ')}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
