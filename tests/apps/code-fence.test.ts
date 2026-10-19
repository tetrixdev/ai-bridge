/**
 * The code fence of app backends (src/apps/guard.ts, "code", and the
 * --disallow-code-generation-from-strings flag in supervisor.ts): a backend
 * runs only the files of the version the person approved. Code it downloads
 * later from a host it may reach is refused, by every way Node has to run it.
 *
 * The backend (fixtures/code-loader.cjs) fetches its payload from a host it
 * declares, through the real network fence and relay, so the download itself
 * works: what is under test is only whether the downloaded text runs. The
 * payload evaluates to "downloaded-code-ran", so a hole shows up as that
 * marker in the answer. The controls at the end run the same fixture without
 * the fence, with and without the flag, to show each attempt does run code
 * when nothing stops it.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppSupervisor } from '../../src/apps/supervisor.js';
import type { EgressTesting } from '../../src/apps/egress.js';
import { SecretStore } from '../../src/local/engram.js';
import type { AppCallMessage } from '../../src/protocol/types.js';

const FIX = join(__dirname, 'fixtures');
const CERT = readFileSync(join(FIX, 'tls', 'cert.pem'), 'utf8');
const KEY = readFileSync(join(FIX, 'tls', 'key.pem'), 'utf8');
const LOADER = readFileSync(join(FIX, 'code-loader.cjs'), 'utf8');
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

const MARK = 'downloaded-code-ran';
/** (module (func (export "f") (result i32) i32.const 42)) */
const WASM = Buffer.from('0061736d010000000105016000017f03020100070501016600000a06010400412a0b', 'hex');
const DECLARED = '93.184.216.34';

/** The app's own files, beside its main. */
const OWN: Record<string, string> = {
  'ca.pem': CERT,
  'helper.cjs': "module.exports = 'helper';\n",
  'helper.evil': 'not code\n',
  'fresh-a.cjs': "module.exports = 'fresh-a';\n",
  'fresh-b.cjs': "module.exports = 'fresh-b';\n",
  'fresh-c.cjs': "module.exports = 'fresh-c';\n",
  'lib/esm.mjs': "import { answer } from './data.mjs';\nexport default `esm ${answer}`;\n",
  'lib/data.mjs': 'export const answer = 42;\n',
  'lib/umd.cjs': "(function (root) { const api = { name: 'umd' }; if (typeof module === 'object') module.exports = api; else root.Api = api; })(this);\n",
  'lib/data.json': '{"answer": 42}\n',
};

const closers: (() => Promise<void>)[] = [];
const dirs: string[] = [];
const files = new Map<string, string>();
const route = new Map<string, number>();
let origin = '';
let plainBase = '';

function payloads(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === '/code.js') { res.end(`'${MARK}'`); return; }
  if (req.url === '/code.mjs') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(`export default '${MARK}'`); return; }
  if (req.url === '/code.wasm') { res.writeHead(200, { 'content-type': 'application/wasm' }); res.end(WASM); return; }
  if (req.url === '/hello') { res.end('hello from a declared host'); return; }
  res.writeHead(404); res.end();
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  closers.push(() => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }));
  return (server.address() as { port: number }).port;
}

let readFolder = '';
let writeFolder = '';

beforeAll(async () => {
  route.set(`${DECLARED}:443`, await listen(createHttpsServer({ cert: CERT, key: KEY }, payloads)));
  plainBase = `http://127.0.0.1:${await listen(createHttpServer(payloads))}`;
  const engram = createHttpServer((req, res) => {
    const body = files.get((req.url ?? '').split('/').pop()!);
    if (body === undefined) { res.statusCode = 404; res.end(); return; }
    res.end(body);
  });
  origin = `http://127.0.0.1:${await listen(engram)}`;
  const base = mkdtempSync(join(tmpdir(), 'code-fence-folders-'));
  dirs.push(base);
  readFolder = join(base, 'read');
  writeFolder = join(base, 'write');
  mkdirSync(readFolder);
  mkdirSync(writeFolder);
  writeFileSync(join(readFolder, 'planted.cjs'), `module.exports = '${MARK}'`);
});

afterAll(async () => {
  for (const s of supervisors) await s.stopAll();
  for (const c of closers) await c();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const testing: EgressTesting = {
  resolve: async (host) => (host === 'api.declared.test' ? [DECLARED] : []),
  route: (address, port) => {
    const local = route.get(`${address}:${port}`);
    return local ? { host: '127.0.0.1', port: local } : undefined;
  },
  ca: CERT,
};

const supervisors: AppSupervisor[] = [];
function supervisor(): AppSupervisor {
  const dir = mkdtempSync(join(tmpdir(), 'code-fence-apps-'));
  dirs.push(dir);
  const s = new AppSupervisor({
    config: { enabled: true }, apiOrigin: origin, secrets: async () => new SecretStore(), dataDir: dir,
    requestMs: 15_000, egressTesting: testing,
  });
  supervisors.push(s);
  return s;
}

function call(body: Record<string, unknown>): AppCallMessage {
  const tree: Record<string, string> = {};
  for (const [path, content] of [['server.cjs', LOADER], ...Object.entries(OWN)] as const) {
    files.set(sha(content), content);
    tree[path] = sha(content);
  }
  return {
    type: 'app_call', id: `c${Math.random()}`,
    app: { space_id: 'space-1', name: 'loader', version: 1, hash: sha('code-loader-v1') },
    files: { base: `${origin}/app-blobs/tok/`, tree },
    backend: {
      main: 'server.cjs', shell: false, programs: [], network: ['api.declared.test'],
      folders: [{ path: readFolder, write: false }, { path: writeFolder, write: true }],
    },
    fill: [],
    request: { method: 'POST', path: '/try', headers: {}, body: JSON.stringify({ folder: body.op === 'read_folder_require' || body.op === 'ok_read_folder' ? readFolder : writeFolder, ...body }) },
    engram: { api: `${origin}/app-api`, token: 'tok-1' },
  };
}

let fenced: AppSupervisor;
const report: [string, string][] = [];
async function attempt(op: string): Promise<string> {
  const r = await fenced.handle(call({ op }));
  expect(r.error).toBeUndefined();
  const result = (JSON.parse(r.response!.body) as { result: string }).result;
  report.push([op, result]);
  return result;
}
/** Refused by the fence or the engine, with a reason, and the downloaded code never ran. */
const refusedFence = (r: string) => {
  expect(r).not.toContain(MARK);
  expect(r).not.toMatch(/wasm returned/);
  expect(r).toMatch(/^refused: /);
};
const FENCE = 'refused: ERR_ENGRAM_CODE_FENCE Engram: an app backend runs only the files of the version the person approved; ';
/** Refused by the fence, for this reason (and so not for an earlier attempt's). */
const byFence = (why: RegExp) => (r: string) => {
  refusedFence(r);
  expect(r.startsWith(FENCE), r).toBe(true);
  expect(r.slice(FENCE.length)).toMatch(why);
};
const byEngine = (r: string) => { refusedFence(r); expect(r).toMatch(/Code generation from strings disallowed/); };

/** Every way to run downloaded code, and who refuses it. */
const ATTEMPTS: [string, string, (r: string) => void][] = [
  ['eval', 'eval of the downloaded text', byEngine],
  ['indirect_eval', 'indirect eval', byEngine],
  ['function', 'new Function', byEngine],
  ['function_ctor', 'the AsyncFunction constructor', byEngine],
  ['vm_this', 'vm.runInThisContext', byFence(/^running code with vm\.runInThisContext/)],
  ['vm_script', 'new vm.Script', byFence(/^compiling code with vm\.Script/)],
  ['vm_script_ctor', 'vm.Script.prototype.constructor', byFence(/^compiling code with vm\.Script/)],
  ['vm_new', 'vm.runInNewContext', byFence(/^running code with vm\.runInNewContext/)],
  ['vm_context', 'vm.runInContext', byFence(/^running code with vm\.runInContext/)],
  ['vm_compile', 'vm.compileFunction', byFence(/^running code with vm\.compileFunction/)],
  ['vm_codegen_context', 'a vm context that allows eval', byFence(/^running code with vm\.runInNewContext/)],
  ['compile', 'Module.prototype._compile under a new name in its folder', byFence(/^compiling ".*payload\.js", which is not one of its files/)],
  ['compile_own_name', "Module.prototype._compile under one of its files' names", byFence(/^compiling text that is not what ".*helper\.cjs" holds/)],
  ['extension', 'a Module._extensions handler compiling other text', byFence(/^compiling text that is not what ".*helper\.evil" holds/)],
  ['wrap', 'a replaced Module.wrap', byFence(/^loading code after Module\.wrap was changed/)],
  ['wrapper', 'a changed Module.wrapper', byFence(/^loading code after Module\.wrapper was changed/)],
  ['wrapper_getter', 'a getter on Module.wrapper[0]', byFence(/^loading code after Module\.wrapper was changed/)],
  ['data_import', 'import() of a data: URL', byFence(/^loading code from a data: address/)],
  ['data_import_base64', 'import() of a base64 data: URL', byFence(/^loading code from a data: address/)],
  ['http_import', 'import() of an https: URL on a declared host', refusedFence],
  ['written_require', 'require of a file it wrote to a folder it may write', byFence(/^loading ".*dropped\.cjs", which is not one of its files/)],
  ['written_import', 'import() of a file it wrote to a folder it may write', byFence(/^loading ".*dropped\.mjs", which is not one of its files/)],
  ['symlink', 'a symlink in a folder it may write', refusedFence],
  ['read_folder_require', 'require of a file in a folder it may read', byFence(/^loading ".*planted\.cjs", which is not one of its files/)],
  ['other_file', 'require of a file outside every folder', refusedFence],
  ['hooks', 'module.registerHooks with a load hook of its own', byFence(/^registering module loader hooks/)],
  ['register', 'module.register', refusedFence],
  ['v8flags', 'turning the engine flag off', refusedFence],
  ['wasm_module', 'new WebAssembly.Module', byFence(/^compiling WebAssembly/)],
  ['wasm_module_ctor', 'WebAssembly.Module.prototype.constructor', byFence(/^compiling WebAssembly/)],
  ['wasm_compile', 'WebAssembly.compile', byFence(/^compiling WebAssembly/)],
  ['wasm_instantiate', 'WebAssembly.instantiate of bytes', byFence(/^compiling WebAssembly/)],
  ['wasm_instantiate_disguised', 'WebAssembly.instantiate of bytes dressed as a module', byFence(/^compiling WebAssembly/)],
  ['wasm_compile_streaming', 'WebAssembly.compileStreaming', byFence(/^compiling WebAssembly/)],
  ['wasm_instantiate_streaming', 'WebAssembly.instantiateStreaming', byFence(/^compiling WebAssembly/)],
];

describe('the code fence of an app backend', () => {
  beforeAll(() => { fenced = supervisor(); });
  afterAll(() => {
    process.stdout.write(`\ncode fence results:\n${report.map(([n, r]) => `  ${n}: ${r}`).join('\n')}\n`);
  });

  it('downloads its payload from a declared host (the download is not what is fenced)', async () => {
    expect(await attempt('fetched')).toBe(`ok: '${MARK}'`);
  });

  describe('refuses to run downloaded code', () => {
    for (const [op, name, expectation] of ATTEMPTS) it(name, async () => expectation(await attempt(op)));
    it('turns the compile cache off rather than trusting bytes it wrote', async () => {
      expect(await attempt('compile_cache')).toMatch(/^ok: .*"status":3.*compile cache is off/);
    });
    it('cannot take the fence apart: every lock stays, and vm is still refused after', async () => {
      const r = await attempt('undo');
      expect(r).toBe('runInThisContext: TypeError | Script: TypeError | _compile: TypeError | registerHooks: TypeError | compile: TypeError | Module: TypeError | '
        + 'refused: ERR_ENGRAM_CODE_FENCE Engram: an app backend runs only the files of the version the person approved; running code with vm.runInThisContext is refused');
    });
  });

  describe('runs its own files as before', () => {
    const ok = (op: string, expected: string) => it(op, async () => expect(await attempt(op)).toBe(expected));
    ok('ok_esm', 'ok: esm 42');
    ok('ok_esm_query', 'ok: esm 42');
    ok('ok_cjs_from_esm', 'ok: umd');
    ok('ok_json', 'ok: 42');
    ok('ok_create_require', 'ok: 42');
    it('ok_builtins', async () => expect(await attempt('ok_builtins')).toMatch(/^ok: [0-9a-f]{8},function$/));
    ok('ok_fetch', 'ok: hello from a declared host');
    ok('ok_fetch_post', 'ok: hello from a declared host');
    ok('ok_read_folder', `ok: ${`module.exports = '${MARK}'`.length} bytes read as data`);
    ok('ok_wasm_validate', 'ok: true');
  });

  it('refuses a folder it may write that holds the bridge\'s copies of app versions', async () => {
    const s = supervisor();
    const m = call({ op: 'fetched' });
    const data = (s as unknown as { dataDir: string }).dataDir;
    m.backend.folders = [{ path: join(data, '..'), write: true }];
    const r = await s.handle(m);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/holds the bridge's copies of app versions/);
  });
});

/**
 * The controls: the same fixture in a plain Node, fetching its payload from a
 * local listener. Without the fence every attempt runs the downloaded code;
 * with only the engine flag, eval and Function are stopped and the rest still
 * run, which is why the fence exists.
 */
describe('without the fence (control)', () => {
  async function plain(flags: string[], ops: string[]): Promise<Record<string, string>> {
    const dir = mkdtempSync(join(tmpdir(), 'code-fence-plain-'));
    dirs.push(dir);
    for (const [path, content] of [['server.cjs', LOADER], ...Object.entries(OWN)] as const) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    const child = spawn(process.execPath, [...flags, join(dir, 'server.cjs')], {
      cwd: dir, env: { PATH: process.env.PATH, ENGRAM_APP_DIR: dir, CODE_BASE: plainBase }, stdio: ['pipe', 'pipe', 'inherit'],
    });
    const lines = createInterface({ input: child.stdout! });
    const out: Record<string, string> = {};
    const done = new Promise<void>((resolve) => {
      lines.on('line', (line) => {
        const r = JSON.parse(line) as { id: string; body: string };
        out[r.id] = (JSON.parse(r.body) as { result: string }).result;
        if (Object.keys(out).length === ops.length) resolve();
      });
    });
    for (const op of ops) child.stdin!.write(JSON.stringify({ id: op, body: JSON.stringify({ op, folder: op === 'read_folder_require' ? readFolder : writeFolder }) }) + '\n');
    await done;
    child.kill();
    return out;
  }
  // Those whose hole is Node's own: what the fence adds. (The data: and
  // hook attempts do not need a host; http imports Node refuses by itself.)
  const RUNS = ATTEMPTS.map(([op]) => op).filter((op) => !['http_import', 'other_file', 'register', 'symlink', 'v8flags'].includes(op));

  it('every attempt runs the downloaded code when nothing stops it', async () => {
    const out = await plain([], RUNS);
    for (const op of RUNS) expect(out[op], op).toMatch(op.startsWith('wasm') ? /^ran: wasm returned 42$/ : new RegExp(`^ran: ${MARK}$`));
  });

  it('the engine flag alone stops eval and Function, and nothing else', async () => {
    const out = await plain(['--disallow-code-generation-from-strings'], RUNS);
    for (const op of RUNS) {
      if (['eval', 'indirect_eval', 'function', 'function_ctor'].includes(op)) expect(out[op], op).toMatch(/Code generation from strings disallowed/);
      else expect(out[op], op).toMatch(/^ran: /);
    }
  });
});
