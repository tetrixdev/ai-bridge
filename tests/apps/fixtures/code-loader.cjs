// An app backend that downloads code from a host it declares and tries every
// way Node has to run it, used by code-fence.test.ts. Each request's body is
// one attempt, {op, ...}; the answer is {result}: "ran: <what the code
// returned>" when the downloaded code ran, "refused: <why>" when something
// stopped it, "ok: ..." for things an app may legitimately do.
'use strict';
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const vm = require('vm');
const Module = require('module');

const ca = fs.readFileSync(path.join(__dirname, 'ca.pem'), 'utf8');
if (typeof tls.setDefaultCACertificates === 'function') {
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), ca]);
}
const DIR = process.env.ENGRAM_APP_DIR;
// CODE_BASE: the controls in code-fence.test.ts, which run this without the bridge.
const BASE = process.env.CODE_BASE || 'https://api.declared.test';

const ran = (v) => `ran: ${String(v)}`;
const refused = (e) => `refused: ${(e && e.code) || (e && e.name) || ''} ${String((e && e.message) || e).slice(0, 400)}`.trim();
async function text(p) { const r = await fetch(BASE + p); return r.text(); }
async function bytes(p) { const r = await fetch(BASE + p); return new Uint8Array(await r.arrayBuffer()); }
const wasmRan = (instance) => ran(`wasm returned ${instance.exports.f()}`);

async function attempt(b) {
  const code = b.op.startsWith('ok_') || b.op.startsWith('wasm') ? '' : await text('/code.js');
  try {
    switch (b.op) {
      case 'fetched': return `ok: ${code}`;
      case 'eval': return ran(eval(code));
      case 'indirect_eval': return ran((0, eval)(code));
      case 'function': return ran(new Function(`return ${code}`)());
      case 'function_ctor': return ran(await (async () => {}).constructor(`return ${code}`)());
      case 'vm_this': return ran(vm.runInThisContext(code));
      case 'vm_script': return ran(new vm.Script(code).runInThisContext());
      case 'vm_script_ctor': return ran(new vm.Script.prototype.constructor(code).runInThisContext());
      case 'vm_new': return ran(vm.runInNewContext(code));
      case 'vm_context': return ran(vm.runInContext(code, vm.createContext({})));
      case 'vm_compile': return ran(vm.compileFunction(`return ${code}`)());
      case 'vm_codegen_context': return ran(vm.runInNewContext(`eval(${JSON.stringify(code)})`, {}, { contextCodeGeneration: { strings: true } }));
      case 'compile': {
        const m = new Module(path.join(DIR, 'payload.js'));
        m._compile(`module.exports = ${code}`, path.join(DIR, 'payload.js'));
        return ran(m.exports);
      }
      case 'compile_own_name': {
        // An approved file's name, other text.
        const m = new Module(path.join(DIR, 'helper.cjs'));
        m._compile(`module.exports = ${code}`, path.join(DIR, 'helper.cjs'));
        return ran(m.exports);
      }
      case 'extension': {
        // A loader for a new extension that compiles the downloaded text.
        Module._extensions['.evil'] = (m, filename) => m._compile(`module.exports = ${code}`, filename);
        return ran(require(path.join(DIR, 'helper.evil')));
      }
      case 'wrap': {
        const before = Module.wrap;
        try {
          Module.wrap = (s) => `(function (exports, require, module) { module.exports = ${code}; });`;
          return ran(require('./fresh-a.cjs'));
        } finally { Module.wrap = before; }
      }
      case 'wrapper': {
        const before = Module.wrapper[0];
        try {
          Module.wrapper[0] = `(function (exports, require, module, __filename, __dirname) { module.exports = ${code}; return; `;
          return ran(require('./fresh-b.cjs'));
        } finally { Module.wrapper[0] = before; }
      }
      case 'wrapper_getter': {
        // A check that reads the value sees code too; one that compares it to
        // Node's text could be answered by a getter that counts its reads.
        const real = Module.wrapper[0];
        Object.defineProperty(Module.wrapper, 0, { get() { return `(function (exports, require, module) { module.exports = ${code}; return; `; }, configurable: true });
        try { return ran(require('./fresh-c.cjs')); } finally {
          Object.defineProperty(Module.wrapper, 0, { value: real, writable: true, enumerable: true, configurable: true });
        }
      }
      case 'data_import': return ran((await import(`data:text/javascript,export default ${encodeURIComponent(code)}`)).default);
      case 'data_import_base64': return ran((await import(`data:text/javascript;base64,${Buffer.from(`export default ${code}`).toString('base64')}`)).default);
      case 'data_require': return ran(require(`data:text/javascript,module.exports = ${code}`));
      case 'http_import': return ran((await import(`${BASE}/code.mjs`)).default);
      case 'written_require': {
        const p = path.join(b.folder, 'dropped.cjs');
        fs.writeFileSync(p, `module.exports = ${code}`);
        return ran(require(p));
      }
      case 'written_import': {
        const p = path.join(b.folder, 'dropped.mjs');
        fs.writeFileSync(p, `export default ${code}`);
        return ran((await import(`file://${p}`)).default);
      }
      case 'symlink': {
        const target = path.join(b.folder, 'target.cjs');
        fs.writeFileSync(target, `module.exports = ${code}`);
        const link = path.join(b.folder, 'link.cjs');
        try { fs.rmSync(link, { force: true }); fs.symlinkSync(target, link); } catch (e) { return refused(e); }
        return ran(require(link));
      }
      case 'read_folder_require': return ran(require(path.join(b.folder, 'planted.cjs')));
      case 'other_file': return ran(require('/etc/hostname'));
      case 'hooks': {
        Module.registerHooks({
          resolve: (s, c, next) => (s === 'engram:evil' ? { url: 'file:///engram-evil.mjs', shortCircuit: true } : next(s, c)),
          load: (u, c, next) => (u === 'file:///engram-evil.mjs' ? { format: 'module', source: `export default ${code}`, shortCircuit: true } : next(u, c)),
        });
        return ran((await import('engram:evil')).default);
      }
      case 'register': Module.register(`data:text/javascript,export async function load(u, c, n) { return n(u, c); }`); return ran('registered');
      case 'compile_cache': return `ok: ${JSON.stringify(Module.enableCompileCache(b.folder))}`;
      case 'v8flags': require('v8').setFlagsFromString('--no-disallow-code-generation-from-strings'); return ran(eval(code));
      case 'undo': {
        // Every lock refuses to be put back, and the refusals still hold after.
        const out = [];
        for (const [o, k] of [[vm, 'runInThisContext'], [vm, 'Script'], [Module.prototype, '_compile'], [Module, 'registerHooks'], [WebAssembly, 'compile'], [WebAssembly, 'Module']]) {
          try { Object.defineProperty(o, k, { value: () => 'replaced' }); out.push(`${k}: replaced`); } catch (e) { out.push(`${k}: ${e.name}`); }
          try { o[k] = () => 'replaced'; } catch {}
        }
        try { out.push(ran(vm.runInThisContext(code))); } catch (e) { out.push(refused(e)); }
        return out.join(' | ');
      }
      case 'wasm_module': return wasmRan(new WebAssembly.Instance(new WebAssembly.Module(await bytes('/code.wasm'))));
      case 'wasm_module_ctor': return wasmRan(new WebAssembly.Instance(new WebAssembly.Module.prototype.constructor(await bytes('/code.wasm'))));
      case 'wasm_compile': return wasmRan(new WebAssembly.Instance(await WebAssembly.compile(await bytes('/code.wasm'))));
      case 'wasm_instantiate': return wasmRan((await WebAssembly.instantiate(await bytes('/code.wasm'))).instance);
      case 'wasm_instantiate_disguised': {
        // Bytes dressed as a compiled module, to pass a check by prototype.
        const u = await bytes('/code.wasm');
        Object.setPrototypeOf(u, WebAssembly.Module.prototype);
        const r = await WebAssembly.instantiate(u);
        return wasmRan(r.instance || r);
      }
      case 'wasm_compile_streaming': return wasmRan(new WebAssembly.Instance(await WebAssembly.compileStreaming(fetch(`${BASE}/code.wasm`))));
      case 'wasm_instantiate_streaming': return wasmRan((await WebAssembly.instantiateStreaming(fetch(`${BASE}/code.wasm`))).instance);

      // What an app may do, and must still be able to.
      case 'ok_esm': return `ok: ${(await import('./lib/esm.mjs')).default}`;
      case 'ok_esm_query': return `ok: ${(await import('./lib/esm.mjs?v=2')).default}`;
      case 'ok_cjs_from_esm': return `ok: ${(await import('./lib/umd.cjs')).default.name}`;
      case 'ok_json': return `ok: ${require('./lib/data.json').answer}`;
      case 'ok_create_require': return `ok: ${Module.createRequire(path.join(DIR, 'lib', 'x.js'))('./data.json').answer}`;
      case 'ok_builtins': return `ok: ${[require('node:crypto').createHash('sha256').update('x').digest('hex').slice(0, 8), typeof require('node:zlib').gzipSync].join(',')}`;
      case 'ok_fetch': return `ok: ${await text('/hello')}`;
      // Node runs vm itself for these (internal/util), lazily: fetch's json() releases a stream reader.
      case 'ok_fetch_json': { const r = await fetch(`${BASE}/json`); return `ok: ${(await r.json()).answer}`; }
      case 'ok_stream_release': { const s = new ReadableStream({ start(c) { c.close(); } }); const rd = s.getReader(); await rd.read(); rd.releaseLock(); return 'ok: released'; }
      case 'ok_buffer_ctor': return `ok: ${new Buffer(3).length}`;
      case 'ok_read_folder': return `ok: ${fs.readFileSync(path.join(b.folder, 'planted.cjs'), 'utf8').length} bytes read as data`;
      case 'ok_wasm_validate': return `ok: ${WebAssembly.validate(await bytes('/code.wasm'))}`;
      default: return `unknown op ${b.op}`;
    }
  } catch (e) { return refused(e); }
}

const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const req = JSON.parse(line);
  const b = JSON.parse(req.body || '{}');
  Promise.race([attempt(b), new Promise((r) => setTimeout(() => r('refused: timeout'), 8000))]).then((result) => {
    process.stdout.write(JSON.stringify({ id: req.id, status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ result }) }) + '\n');
  });
});
