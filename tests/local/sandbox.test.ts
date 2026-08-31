/**
 * What the sandbox actually does, asserted by trying to escape it.
 *
 * Every claim here is a claim about THIS machine, which is why the tests run
 * real processes rather than checking that the right flags were assembled. A
 * sandbox test that only inspects an argv passes forever after the mechanism
 * stops working, and a sandbox believed to be on and silently off is worse
 * than one nobody claimed.
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runLocalTool } from '../../src/local/executor.js';
import { canIsolateNetwork, isNodeCommand, resetNetworkProbe, sandboxed } from '../../src/local/sandbox.js';

const onLinux = process.platform === 'linux';
const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'engram-sandbox-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetNetworkProbe();
});

describe("the filesystem, under Node's permission model", () => {
  it('lets a tool read its own package and nothing else on the machine', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'mine.txt'), 'the tool may read this');
    writeFileSync(join(dir, 'tool.js'), `
      const fs = require('fs');
      const out = {};
      try { out.own = fs.readFileSync(__dirname + '/mine.txt', 'utf8').length; }
      catch (e) { out.own = e.code; }
      try { fs.readFileSync('/etc/hostname'); out.elsewhere = 'READ'; }
      catch (e) { out.elsewhere = e.code; }
      console.log(JSON.stringify(out));
    `);

    const res = await runLocalTool({
      name: 'reader',
      command: process.execPath,
      args: [join(dir, 'tool.js')],
      secrets: [],
      cwd: dir,
      sandbox: { readDir: dir },
      timeoutMs: 20_000,
    });

    expect(res.sandbox.filesystem).toBe('node-permissions');
    expect(JSON.parse(res.stdout)).toEqual({ own: 22, elsewhere: 'ERR_ACCESS_DENIED' });
  }, 30_000);

  it('lets a tool write nowhere at all when it declared no writable directory', async () => {
    const dir = scratch();
    const marker = join(dir, 'written.txt');
    writeFileSync(join(dir, 'tool.js'), `
      const fs = require('fs');
      try { fs.writeFileSync(__dirname + '/written.txt', 'x'); console.log('WROTE'); }
      catch (e) { console.log(e.code); }
    `);

    const res = await runLocalTool({
      name: 'writer',
      command: process.execPath,
      args: [join(dir, 'tool.js')],
      secrets: [],
      cwd: dir,
      sandbox: { readDir: dir },
      timeoutMs: 20_000,
    });

    expect(res.stdout.trim()).toBe('ERR_ACCESS_DENIED');
    expect(existsSync(marker)).toBe(false);
  }, 30_000);

  it('does not let a tool spawn its way out', async () => {
    // --allow-child-process would hand back every restriction above in one
    // flag, because the child runs with no permission model at all. It is the
    // single most important flag this bridge does NOT pass.
    const dir = scratch();
    writeFileSync(join(dir, 'tool.js'), `
      try { require('child_process').execSync('cat /etc/hostname'); console.log('ESCAPED'); }
      catch (e) { console.log(e.code || 'BLOCKED'); }
    `);

    const res = await runLocalTool({
      name: 'escaper',
      command: process.execPath,
      args: [join(dir, 'tool.js')],
      secrets: [],
      cwd: dir,
      sandbox: { readDir: dir },
      timeoutMs: 20_000,
    });

    expect(res.stdout).not.toContain('ESCAPED');
    expect(res.stdout.trim()).toBe('ERR_ACCESS_DENIED');
  }, 30_000);

  it('says plainly that it covers nothing when the command is not node', async () => {
    // A python tool, a shell script, a compiled binary: the permission model
    // has no opinion about any of them, and the report must not imply it does.
    const { report } = await sandboxed('sh', ['-c', 'true'], {});
    expect(report.filesystem).toBe('none');
    expect(report.notes.join(' ')).toMatch(/filesystem is NOT sandboxed/);
  });

  it('recognises node however it was spelled', () => {
    expect(isNodeCommand('node')).toBe(true);
    expect(isNodeCommand('/usr/local/bin/node')).toBe(true);
    expect(isNodeCommand(process.execPath)).toBe(true);
    expect(isNodeCommand('nodemon')).toBe(false);
    expect(isNodeCommand('python3')).toBe(false);
  });
});

describe('the network, which the permission model does not cover at all', () => {
  it.skipIf(!onLinux)('is reachable from a permissioned tool, which is why the namespace exists', async () => {
    // Not a wish: a permissioned process fetched https://example.com on this
    // machine. Asserted with a DNS lookup rather than a real request so the
    // test needs no internet, only a resolver.
    const dir = scratch();
    writeFileSync(join(dir, 'tool.js'), `
      require('dns').lookup('localhost', (err) => console.log(err ? err.code : 'RESOLVED'));
    `);

    const res = await runLocalTool({
      name: 'net',
      command: process.execPath,
      args: [join(dir, 'tool.js')],
      secrets: [],
      cwd: dir,
      sandbox: { readDir: dir },
      timeoutMs: 20_000,
    });

    expect(res.stdout.trim()).toBe('RESOLVED');
    expect(res.sandbox.network).toBe('open');
  }, 30_000);

  it.skipIf(!onLinux)('is gone once the tool declares it needs none', async () => {
    expect(await canIsolateNetwork()).toBe(true);
    const dir = scratch();
    writeFileSync(join(dir, 'tool.js'), `
      require('dns').lookup('example.com', (err) => console.log(err ? err.code : 'RESOLVED'));
    `);

    const res = await runLocalTool({
      name: 'net',
      command: process.execPath,
      args: [join(dir, 'tool.js')],
      secrets: [],
      cwd: dir,
      sandbox: { readDir: dir, network: false },
      timeoutMs: 20_000,
    });

    expect(res.sandbox.network).toBe('namespace');
    expect(res.stdout.trim()).not.toBe('RESOLVED');
  }, 30_000);

  it.skipIf(!onLinux)('wraps the namespace around the command, not inside it', async () => {
    const { command, args } = await sandboxed('node', ['tool.js'], { network: false, readDir: '/pkg' });
    // unshare has to be the process that spawns node, or node's flags apply to
    // a process that is already outside the namespace.
    expect(command).toBe('unshare');
    expect(args.slice(0, 2)).toEqual(['-rn', '--']);
    expect(args[2]).toBe('node');
    expect(args).toContain('--permission');
    expect(args).toContain('--allow-fs-read=/pkg');
    expect(args).not.toContain('--allow-child-process');
  });

  it('refuses to run rather than hand a network to a tool that asked not to have one', async () => {
    // unshare is Linux only. Reporting afterwards that the fence was missing
    // puts the finding in a field nobody reads, after the request has already
    // left the machine, and there is no undo for a credential that got out.
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    resetNetworkProbe();
    try {
      await expect(sandboxed('node', ['tool.js'], { network: false }))
        .rejects.toThrow(/declared network: false and this machine cannot enforce that/);
    } finally {
      Object.defineProperty(process, 'platform', { value: real, configurable: true });
    }
  });

  it('runs it anyway only when an operator explicitly waived the fence', async () => {
    // The waiver exists because otherwise no-network tools cannot run at all
    // off Linux. Off by default: somebody who never set it has accepted
    // nothing, and when it is on the result says so rather than going quiet.
    const real = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    process.env['AI_BRIDGE_ALLOW_UNFENCED_NETWORK'] = '1';
    resetNetworkProbe();
    try {
      const { command, report } = await sandboxed('node', ['tool.js'], { network: false });
      expect(command).toBe('node');
      expect(report.network).toBe('open');
      expect(report.notes.join(' ')).toMatch(/network was NOT blocked/);
      expect(report.notes.join(' ')).toMatch(/darwin/);
    } finally {
      delete process.env['AI_BRIDGE_ALLOW_UNFENCED_NETWORK'];
      Object.defineProperty(process, 'platform', { value: real, configurable: true });
    }
  });

  it('does not pretend a host list is a restriction', async () => {
    // Per-host filtering is not implemented. A tool that declared two hosts
    // gets the whole network, and the report says which hosts were ignored.
    const { report } = await sandboxed('node', ['tool.js'], { network: ['graph.microsoft.com'] });
    expect(report.network).toBe('open');
    expect(report.notes.join(' ')).toMatch(/per-host network filtering is not implemented/);
    expect(report.notes.join(' ')).toMatch(/graph\.microsoft\.com/);
  });
});
