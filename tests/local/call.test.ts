/**
 * A local_call from arriving to answered.
 *
 * This is the whole machine side in one path: the gate, the space check, the
 * rate limit, the sandbox, the stdin document and the stdout parse. Each has
 * its own tests elsewhere; these are about them being wired together in the
 * right order, because every one of them is bypassable by wiring alone.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { handleLocalCall, type LocalCallContext } from '../../src/local/call.js';
import { SecretStore } from '../../src/local/engram.js';
import { SpaceLimiter } from '../../src/local/limits.js';
import type { LocalCallMessage } from '../../src/protocol/types.js';

const SPACE = 'space_shared';
const OTHER = 'space_private';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A device holding one sealed value in the shared space and one in a private space. */
function store(): SecretStore {
  const s = new SecretStore();
  s.add({ id: 'sec_shared', spaceId: SPACE, itemId: 'item_shared', field: 'client_secret', value: 'shared-value-4321' });
  s.add({ id: 'sec_private', spaceId: OTHER, itemId: 'item_private', field: 'client_secret', value: 'private-value-8765' });
  return s;
}

/** The fill Engram sends for the role `mailbox`: plain values, and a sealed id with its space. */
const fillWith = (itemId: string, secretId: string, space: string): LocalCallMessage['fill'] => [{
  role: 'mailbox', item_id: itemId, space_id: space, kind: 'azure_app',
  fields: { client_id: 'c-123' },
  sealed: [{ field: 'client_secret', secret_id: secretId, space_id: space }],
}]

/** Write a tool that runs under node, and return the args that run it. */
function tool(body: string): { dir: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'engram-call-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'tool.js'), body);
  return { dir, args: [join(dir, 'tool.js')] };
}

function context(overrides: Partial<LocalCallContext> = {}): LocalCallContext {
  return {
    config: { enabled: true },
    limiter: new SpaceLimiter({ maxConcurrent: 2, minIntervalMs: 0 }),
    secrets: async () => store(),
    ...overrides,
  };
}

function call(overrides: Partial<LocalCallMessage> = {}): LocalCallMessage {
  return {
    type: 'local_call',
    id: 'call_1',
    space_id: SPACE,
    tool: { name: 'fetch_mail', command: process.execPath, args: [] },
    input: {},
    ...overrides,
  };
}

/** Reads stdin, answers with what it saw. The shape a local tool is meant to have. */
const ECHO = `
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    console.log(JSON.stringify({
      input: JSON.parse(raw || '{}'),
      mailbox: process.env.ENGRAM_MAILBOX_CLIENT_SECRET ?? null,
      client: process.env.ENGRAM_MAILBOX_CLIENT_ID ?? null,
      leaked: process.env.ENGRAM_PERSONAL_CLIENT_SECRET ?? null,
    }));
  });
`;

describe('the gate, on the local_call path', () => {
  it('refuses outright on a bridge that never enabled local execution', async () => {
    // The DungeonMeister posture. A new message type is a new way in, and a
    // new way in that forgets the gate is how the gate stops being one. The
    // tool below would create a file if it ran; the assertion is that the
    // refusal happens before anything runs at all.
    const { dir, args } = tool(`require('fs').writeFileSync(__dirname + '/ran', 'x');`);
    const ctx = context({ config: { enabled: false, workdir: dir } });

    const result = await handleLocalCall(ctx, call({ tool: { name: 't', command: process.execPath, args } }));

    expect(result).toEqual({
      type: 'local_result',
      id: 'call_1',
      ok: false,
      error: expect.stringMatching(/not started with local execution enabled/),
    });
    expect(() => rmSync(join(dir, 'ran'))).toThrow();
  });

  it('refuses a merely truthy enabled, exactly as the tool path does', async () => {
    const ctx = context({ config: { enabled: 'yes' as unknown as boolean } });
    const result = await handleLocalCall(ctx, call());
    expect(result.ok).toBe(false);
  });
});

describe('a sealed value, read only through the space and item it belongs to', () => {
  it('is refused when the call names it under a space that does not hold it, and the tool never runs', async () => {
    // The same leak the flat secret map allowed, arriving by id. A caller that
    // knows an id must not be able to spend it through a space that did not
    // seal it.
    const { dir, args } = tool(ECHO);
    const ctx = context({ config: { enabled: true, workdir: dir } });

    const result = await handleLocalCall(ctx, call({
      tool: { name: 'fetch_mail', command: process.execPath, args },
      fill: fillWith('item_private', 'sec_private', SPACE),
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be filled/);
    expect(result.result).toBeUndefined();
  }, 20_000);

  it('is refused when the call names it as a field of another item', async () => {
    const { dir, args } = tool(ECHO);
    const ctx = context({ config: { enabled: true, workdir: dir } });
    const result = await handleLocalCall(ctx, call({
      tool: { name: 'fetch_mail', command: process.execPath, args },
      fill: fillWith('item_shared', 'sec_private', OTHER),
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cannot be filled/);
  }, 20_000);

  it('is served from the space that sealed it, even when the tool lives in another', async () => {
    // A tool in a shared space, run with an item from the person's private
    // space: Engram decided the person chose it; the bridge opens it where it
    // is sealed.
    const { dir, args } = tool(ECHO);
    const ctx = context({ config: { enabled: true, workdir: dir } });

    const result = await handleLocalCall(ctx, call({
      space_id: SPACE,
      tool: { name: 'fetch_mail', command: process.execPath, args },
      fill: fillWith('item_private', 'sec_private', OTHER),
    }));

    expect(result.ok).toBe(true);
    // Redacted on the way out, which is the point: the tool had the value and
    // what comes back does not.
    expect((result.result as { mailbox: string }).mailbox).toBe('[redacted: ENGRAM_MAILBOX_CLIENT_SECRET]');
  }, 20_000);
});

describe('what the tool receives', () => {
  it('gets its input as one JSON document on stdin, and each field by role and name', async () => {
    const { dir, args } = tool(ECHO);
    const ctx = context({ config: { enabled: true, workdir: dir } });

    const result = await handleLocalCall(ctx, call({
      tool: { name: 'fetch_mail', command: process.execPath, args },
      fill: fillWith('item_shared', 'sec_shared', SPACE),
      input: { since: '2026-08-01' },
    }));

    expect(result.ok).toBe(true);
    const body = result.result as { input: { since: string }; mailbox: string; client: string; leaked: string | null };
    expect(body.input).toEqual({ since: '2026-08-01' });
    // The tool read the ROLE and FIELD it declared. It was never told what the
    // item is called, which is what lets one tool serve three of them.
    expect(body.mailbox).toBe('[redacted: ENGRAM_MAILBOX_CLIENT_SECRET]');
    // A plain field arrives as itself: plain means not secret.
    expect(body.client).toBe('c-123');
    // And it holds nothing it did not ask for.
    expect(body.leaked).toBeNull();
  }, 20_000);

  it('gets an empty document when the call carried no input', async () => {
    const { dir, args } = tool(ECHO);
    const ctx = context({ config: { enabled: true, workdir: dir } });

    const result = await handleLocalCall(ctx, call({
      tool: { name: 'fetch_mail', command: process.execPath, args },
      input: undefined,
    }));

    expect(result.ok).toBe(true);
    expect((result.result as { input: unknown }).input).toEqual({});
  }, 20_000);
});

describe('what comes back', () => {
  it('scrubs the credential BEFORE parsing, so it cannot survive inside the result', async () => {
    // Order matters and is easy to get backwards. Parsing first and scrubbing
    // the object afterwards means walking arbitrary JSON, and anything missed
    // is a credential in a transcript. Scrubbing the bytes first cannot miss.
    const { dir, args } = tool(`
      let raw = '';
      process.stdin.on('data', (c) => { raw += c; });
      process.stdin.on('end', () => {
        console.log(JSON.stringify({ deep: { nested: ['token ' + process.env.ENGRAM_MAILBOX_CLIENT_SECRET] } }));
      });
    `);
    const ctx = context({ config: { enabled: true, workdir: dir } });

    const result = await handleLocalCall(ctx, call({
      tool: { name: 'fetch_mail', command: process.execPath, args },
      fill: fillWith('item_shared', 'sec_shared', SPACE),
    }));

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.result)).not.toContain('shared-value-4321');
    expect((result.result as { deep: { nested: string[] } }).deep.nested[0])
      .toBe('token [redacted: ENGRAM_MAILBOX_CLIENT_SECRET]');
  }, 20_000);

  it('fails loudly when stdout is not one JSON document, and passes no text through', async () => {
    // A tool that logs to stdout has a bug. Handing its text back as a result
    // would let the model read a log line as an answer.
    const { dir, args } = tool(`
      console.log('starting up');
      console.log(JSON.stringify({ ok: true }));
    `);
    const ctx = context({ config: { enabled: true, workdir: dir } });

    const result = await handleLocalCall(ctx, call({
      tool: { name: 'noisy', command: process.execPath, args },
    }));

    expect(result.ok).toBe(false);
    expect(result.result).toBeUndefined();
    expect(result.error).toMatch(/not one JSON document/);
    expect(result.error).not.toContain('starting up');
  }, 20_000);

  it('fails when the tool wrote nothing at all', async () => {
    const { dir, args } = tool(`process.stdout.write('');`);
    const ctx = context({ config: { enabled: true, workdir: dir } });

    const result = await handleLocalCall(ctx, call({
      tool: { name: 'silent', command: process.execPath, args },
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/wrote nothing to stdout/);
  }, 20_000);

  it('reports a non-zero exit with the tail of what the tool complained about', async () => {
    const { dir, args } = tool(`
      console.error('could not reach the mailbox');
      process.exit(4);
    `);
    const ctx = context({ config: { enabled: true, workdir: dir } });

    const result = await handleLocalCall(ctx, call({
      tool: { name: 'failing', command: process.execPath, args },
    }));

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited 4/);
    expect(result.error).toContain('could not reach the mailbox');
  }, 20_000);

  it('keeps a credential out of the error text as well as out of the result', async () => {
    // A failure path is exactly where a credential ends up in a message by
    // accident: the tool prints the connection string it could not use.
    const { dir, args } = tool(`
      console.error('auth failed for ' + process.env.ENGRAM_MAILBOX_CLIENT_SECRET);
      process.exit(1);
    `);
    const ctx = context({ config: { enabled: true, workdir: dir } });

    const result = await handleLocalCall(ctx, call({
      tool: { name: 'failing', command: process.execPath, args },
      fill: fillWith('item_shared', 'sec_shared', SPACE),
    }));

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('shared-value-4321');
    expect(result.error).toContain('[redacted: ENGRAM_MAILBOX_CLIENT_SECRET]');
  }, 20_000);

  it('says what the sandbox actually did, rather than what was asked for', async () => {
    const { dir, args } = tool(`console.log(JSON.stringify({ ok: true }));`);
    const ctx = context({ config: { enabled: true, workdir: dir } });

    const result = await handleLocalCall(ctx, call({
      tool: { name: 'plain', command: process.execPath, args, network: ['example.com'] },
    }));

    expect(result.ok).toBe(true);
    expect(result.sandbox?.filesystem).toBe('node-permissions');
    // A host list is not a restriction here, and the frame says so instead of
    // implying the tool was confined to those hosts.
    expect(result.sandbox?.network).toBe('open');
    expect(result.sandbox?.notes.join(' ')).toMatch(/per-host network filtering is not implemented/);
  }, 20_000);
});

describe('a call that cannot be run at all', () => {
  it('answers rather than going quiet, whatever is wrong with the frame', async () => {
    // A server waiting forever on an id it will never hear about again is the
    // one outcome with no diagnosis, so every path here produces a frame.
    const ctx = context();
    const broken = [
      call({ space_id: undefined as unknown as string }),
      call({ tool: undefined as unknown as LocalCallMessage['tool'] }),
      call({ tool: { name: 't', command: '' } }),
      call({ tool: { name: 't', command: 'x', args: [42 as unknown as string] } }),
      call({ fill: [{ role: 'mailbox' } as unknown as NonNullable<LocalCallMessage['fill']>[number]] }),
      call({ fill: [{ role: 'mailbox', item_id: 'i', space_id: SPACE, sealed: [{ field: 'x' }] } as never] }),
    ];

    for (const frame of broken) {
      const result = await handleLocalCall(ctx, frame);
      expect(result.type).toBe('local_result');
      expect(result.id).toBe('call_1');
      expect(result.ok).toBe(false);
      expect(result.error).toBeTruthy();
    }
  });

  it('refuses a space that is already running as much as it may', async () => {
    // The render-loop case, at the level that answers the server.
    const { dir, args } = tool(`setTimeout(() => console.log(JSON.stringify({ ok: true })), 400);`);
    const ctx = context({
      config: { enabled: true, workdir: dir },
      limiter: new SpaceLimiter({ maxConcurrent: 2, minIntervalMs: 0 }),
    });
    const frame = call({ tool: { name: 'slow', command: process.execPath, args } });

    const inFlight = [
      handleLocalCall(ctx, frame),
      handleLocalCall(ctx, frame),
    ];
    const third = await handleLocalCall(ctx, frame);

    expect(third.ok).toBe(false);
    expect(third.error).toMatch(/already running 2 local tools/);
    // The two that were allowed still finish normally.
    for (const result of await Promise.all(inFlight)) expect(result.ok).toBe(true);
  }, 20_000);
});
