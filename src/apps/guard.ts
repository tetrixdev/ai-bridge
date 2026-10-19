/**
 * The network fence an app backend starts with, as source: written to a file
 * beside the working copies and loaded with `--require` before the app's own
 * code, under Node's permission model (supervisor.ts).
 *
 * WHY IT WORKS AT THE HANDLE LEVEL. Every TCP connection Node makes, whatever
 * started it (fetch, http, https, http2, tls, net, a redirect, a WebSocket),
 * ends in one native call: `connect`/`connect6` on the TCP handle, with the
 * address and port already resolved. So do UDP (`send`, `bind`, `connect` on
 * the UDP handle), local sockets (`connect` on the Pipe handle) and DNS
 * queries (`query*` on c-ares' channel). The fence replaces exactly those
 * methods on their prototypes, before the app runs, with non-writable,
 * non-configurable properties holding the only references to the originals:
 *
 *   - TCP: the connection is made to the bridge's egress listener for the
 *     port asked for (egress.ts), never to the address given. Which host it
 *     is for is read there, outside this process: the TLS server name, or
 *     the Host of each HTTP request. A port with no listener is refused.
 *     Listening is refused, and so is wrapping a descriptor as a socket.
 *   - UDP and local sockets (Unix sockets, Windows named pipes): refused.
 *   - DNS: `dns.lookup` answers only the hosts the app may reach, with a
 *     stand-in address (the egress listener reads the real name from the
 *     connection), and never asks a resolver, so a name cannot carry data out
 *     either. c-ares queries (`dns.resolve*`, `Resolver`) are refused.
 *
 * Patching the public functions instead (net.Socket.prototype.connect,
 * BlockList, the lookup results) would not hold: the app is arbitrary code in
 * the same realm, and async_hooks hands it the very request objects those
 * functions use, so it could swap what they see. At the handle level the
 * address that matters is an argument this fence replaces, and nothing the
 * app can reach still holds the original method.
 *
 * What the permission model already closes, so the fence need not: native
 * bindings (process.binding), addons, WASI, workers, module.register's hooks
 * thread, the inspector and child processes (unless the manifest asks for a
 * shell or programs, where the fence ends: a child runs without it).
 * `v8.setFlagsFromString` is not covered by it and is refused here, because
 * flags such as --allow-natives-syntax are a way under JavaScript's rules.
 *
 * THE CODE FENCE (0.33.0, the last section of the source). A backend runs
 * only the files of the version the person approved: code it fetches later
 * from a host it may reach is refused, however it is handed to the engine.
 * eval and new Function are refused by the engine itself
 * (--disallow-code-generation-from-strings, supervisor.ts). Closed here:
 *
 *   - the vm module: Script (and its prototype's constructor),
 *     runInThisContext, runInContext, runInNewContext, compileFunction;
 *   - Module.prototype._compile, which runs only a file of the working copy,
 *     with exactly the text that file holds on disk;
 *   - Module.wrap and Module.wrapper, which Node defines so they cannot be
 *     locked: they are checked to be Node's own before every load and compile;
 *   - every module load, ES or CommonJS, through a module.registerHooks load
 *     hook registered first (so it runs last, on whatever another hook would
 *     have produced): a node: built-in, or a file whose real path (after
 *     symlinks) is inside the working copy. data:, http(s): and any other
 *     file, including one in a folder the manifest lets it write, are refused;
 *     module.registerHooks and module.register are refused after it;
 *   - module.enableCompileCache (a code cache is bytes the engine trusts);
 *   - WebAssembly: Module (and its prototype's constructor), compile,
 *     compileStreaming, instantiateStreaming, and instantiate of bytes. Node's
 *     own fetch compiles its HTTP parser (llhttp) from WebAssembly the first
 *     time undici loads, so undici is loaded before the lock, and instantiate
 *     still takes a module that already exists (checked by the engine's own
 *     brand check, not by prototype).
 *
 * A Node without module.registerHooks (before 22.15) cannot hold the loader,
 * so the fence refuses to start rather than run a backend half-held.
 *
 * Plain JavaScript with no dependency, written to run on Node 22.15 and later.
 * It reads its settings from ENGRAM_NETWORK ({ports, hosts, app_dir}) and
 * removes that variable.
 */

/** `hello.app_code`: the revision of the code fence, raised when what it holds changes. */
export const APP_CODE_REVISION = 1;

export const GUARD_SOURCE = String.raw`'use strict';
(function engramNetworkFence() {
  const ReflectApply = Reflect.apply;
  const defineProperty = Object.defineProperty;
  const hasOwn = Object.hasOwn;
  const create = Object.create;
  const ownSymbols = Object.getOwnPropertySymbols;
  const freeze = Object.freeze;
  const ErrorCtor = Error;
  const TypeErrorCtor = TypeError;
  const PromiseCtor = Promise;
  const call = Function.prototype.call;
  const uncurry = (fn) => call.bind(fn);
  const toLower = uncurry(String.prototype.toLowerCase);
  const endsWith = uncurry(String.prototype.endsWith);
  const slice = uncurry(String.prototype.slice);
  const rawDebug = process._rawDebug;
  const nextTick = process.nextTick;

  let config = null;
  try { config = JSON.parse(process.env.ENGRAM_NETWORK || 'null'); } catch {}
  delete process.env.ENGRAM_NETWORK;
  // No settings: nothing is allowed, rather than everything.
  const ports = create(null);
  const names = create(null);
  if (config && config.ports && typeof config.ports === 'object') {
    for (const k of Object.keys(config.ports)) if (typeof config.ports[k] === 'number') ports[k] = config.ports[k];
  }
  if (config && Array.isArray(config.hosts)) {
    for (const h of config.hosts) if (typeof h === 'string') names[toLower(h)] = true;
  }
  freeze(ports);
  freeze(names);

  const say = (what) => { try { rawDebug('[engram network] ' + what); } catch {} };
  const EACCES = (() => {
    try {
      for (const [code, info] of require('util').getSystemErrorMap()) if (info[0] === 'EACCES') return code;
    } catch {}
    return -13;
  })();
  const getOwnDescriptor = Object.getOwnPropertyDescriptor;
  // Keeps the property's enumerability: Node builds a built-in module's ESM
  // named exports from its ENUMERABLE own keys, so hiding dns.promises.lookup
  // made "import { lookup } from 'node:dns/promises'" fail to link.
  const lock = (target, key, value) => {
    const before = getOwnDescriptor(target, key);
    defineProperty(target, key, { value, writable: false, configurable: false, enumerable: before ? before.enumerable === true : false });
  };
  const refuse = (what) => function refused() { say('refused: ' + what); return EACCES; };
  const isIP = require('net').isIP;

  /* ---------- DNS: only the app's own hosts, and never a real query ---------- */
  const dns = require('dns');
  const dnsPromises = dns.promises;
  const notFound = (hostname) => {
    const e = new ErrorCtor('getaddrinfo ENOTFOUND ' + hostname + ' (Engram: not a host this app declares under "network")');
    e.code = 'ENOTFOUND';
    e.syscall = 'getaddrinfo';
    e.hostname = hostname;
    return e;
  };
  const answer = (hostname, options) => {
    let family = 0;
    let all = false;
    if (typeof options === 'number') family = options;
    else if (options !== null && typeof options === 'object') {
      const f = options.family;
      family = f === 6 || f === 'IPv6' ? 6 : f === 4 || f === 'IPv4' ? 4 : 0;
      all = options.all === true;
    }
    const name = typeof hostname === 'string' ? hostname : '';
    const v = isIP(name);
    let address;
    let fam;
    if (v) { address = name; fam = v; }
    else {
      let key = toLower(name);
      if (endsWith(key, '.')) key = slice(key, 0, -1);
      if (!hasOwn(names, key)) { say('refused a DNS lookup of ' + name); return { err: notFound(name) }; }
      // A stand-in: the egress listener reads the real name from the connection.
      fam = family === 6 ? 6 : 4;
      address = fam === 6 ? '::1' : '127.0.0.1';
    }
    return { all, address, family: fam };
  };
  function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = 0; }
    if (typeof callback !== 'function') throw new TypeErrorCtor('The "callback" argument must be of type function');
    const r = answer(hostname, options);
    nextTick(() => {
      if (r.err) callback(r.err);
      else if (r.all) callback(null, [{ address: r.address, family: r.family }]);
      else callback(null, r.address, r.family);
    });
    return {};
  }
  function lookupPromise(hostname, options) {
    const r = answer(hostname, options);
    return new PromiseCtor((resolve, reject) => {
      if (r.err) reject(r.err);
      else resolve(r.all ? [{ address: r.address, family: r.family }] : { address: r.address, family: r.family });
    });
  }
  function lookupService() { throw new ErrorCtor('Engram: an app backend may not look up names for addresses'); }
  lock(dns, 'lookup', lookup);
  lock(dns, 'lookupService', lookupService);
  lock(dnsPromises, 'lookup', lookupPromise);
  lock(dnsPromises, 'lookupService', function lookupServicePromise() { return PromiseCtor.reject(new ErrorCtor('Engram: an app backend may not look up names for addresses')); });

  const ChannelWrap = new dns.Resolver()._handle.constructor;
  for (const key of Object.getOwnPropertyNames(ChannelWrap.prototype)) {
    if (key === 'getHostByAddr' || slice(key, 0, 5) === 'query') {
      lock(ChannelWrap.prototype, key, function refusedQuery() {
        say('refused a DNS query (' + key + ')');
        throw new ErrorCtor('Engram: an app backend may not send DNS queries; it reaches its declared hosts by name');
      });
    }
  }

  /* ---------- TCP: every connection goes to the egress listener ---------- */
  const net = require('net');
  const probe = new net.Socket();
  probe.on('error', () => {});
  probe.connect({ host: 'engram-network-fence.invalid', port: 9, lookup() {} });
  const TCP = probe._handle && probe._handle.constructor;
  probe.destroy();
  if (typeof TCP !== 'function' || typeof TCP.prototype.connect !== 'function') {
    throw new ErrorCtor('Engram network fence: could not find the TCP handle on this Node version; refusing to start');
  }
  const tcpConnect = TCP.prototype.connect;
  function connect(req, address, port) {
    if (typeof port !== 'number' || !hasOwn(ports, port)) {
      say('refused a connection to ' + address + ':' + port + ' (no egress on that port)');
      return EACCES;
    }
    return ReflectApply(tcpConnect, this, [req, '127.0.0.1', ports[port]]);
  }
  lock(TCP.prototype, 'connect', connect);
  lock(TCP.prototype, 'connect6', connect);
  lock(TCP.prototype, 'listen', refuse('listening on a TCP port'));
  // Wrapping a descriptor the process already holds as a socket is how a
  // socket made elsewhere would be used; stdio here is pipes, never TCP.
  lock(TCP.prototype, 'open', refuse('opening a descriptor as a TCP socket'));

  /* ---------- local sockets and UDP: none ---------- */
  let Pipe = null;
  for (const s of ['stdout', 'stderr', 'stdin']) {
    try {
      const h = process[s] && process[s]._handle;
      if (h && h.constructor && h.constructor.name === 'Pipe') { Pipe = h.constructor; break; }
    } catch {}
  }
  if (!Pipe) {
    const p = new net.Socket();
    p.on('error', () => {});
    try { p.connect({ path: process.platform === 'win32' ? '\\\\.\\pipe\\engram-network-fence-none' : '/engram-network-fence-none' }); } catch {}
    Pipe = p._handle && p._handle.constructor;
    p.destroy();
  }
  if (typeof Pipe !== 'function') throw new ErrorCtor('Engram network fence: could not find the Pipe handle; refusing to start');
  lock(Pipe.prototype, 'connect', refuse('connecting to a local socket or pipe'));
  lock(Pipe.prototype, 'listen', refuse('listening on a local socket or pipe'));
  lock(Pipe.prototype, 'bind', refuse('binding a local socket or pipe'));

  const dgram = require('dgram');
  const u = dgram.createSocket('udp4');
  let UDP = null;
  for (const sym of ownSymbols(u)) {
    const state = u[sym];
    if (state && typeof state === 'object' && state.handle && state.handle.constructor) { UDP = state.handle.constructor; break; }
  }
  u.close();
  if (typeof UDP !== 'function') throw new ErrorCtor('Engram network fence: could not find the UDP handle; refusing to start');
  for (const key of ['bind', 'bind6', 'send', 'send6', 'connect', 'connect6', 'open']) {
    if (typeof UDP.prototype[key] === 'function') lock(UDP.prototype, key, refuse('UDP (' + key + ')'));
  }

  /* ---------- engine flags ---------- */
  lock(require('v8'), 'setFlagsFromString', function setFlagsFromString() {
    throw new ErrorCtor('Engram: an app backend may not change V8 flags');
  });

  /* ---------- code: only the approved version's own files ---------- */
  // eval and new Function are refused by --disallow-code-generation-from-strings
  // (supervisor.ts); what that flag does not cover is closed here: the vm
  // module, Module.prototype._compile, the CommonJS wrapper, loader hooks, the
  // compile cache, WebAssembly, and loading a module from anywhere but the
  // working copy (data:, other files, a symlink out of it).
  const Module = require('module');
  const fs = require('fs');
  const pathSep = require('path').sep;
  const realpath = fs.realpathSync.native;
  const readFile = fs.readFileSync;
  const decode = decodeURIComponent;
  const indexOf = uncurry(String.prototype.indexOf);
  const replaceAll = uncurry(String.prototype.replaceAll);
  const startsWith = uncurry(String.prototype.startsWith);
  const charCodeAt = uncurry(String.prototype.charCodeAt);
  const isBuffer = Buffer.isBuffer;
  const bufToString = uncurry(Buffer.prototype.toString);
  const isWindows = process.platform === 'win32';
  const NOT_APPROVED = 'Engram: an app backend runs only the files of the version the person approved';
  const codeError = (what) => {
    say('refused: ' + what);
    const e = new ErrorCtor(NOT_APPROVED + '; ' + what + ' is refused');
    e.code = 'ERR_ENGRAM_CODE_FENCE';
    return e;
  };

  if (typeof Module.registerHooks !== 'function') {
    throw new ErrorCtor('Engram app fence: this Node (' + process.version + ') has no module.registerHooks, which holds an app backend to its own files; app backends need Node 22.15 or later');
  }
  let appDir = null;
  try {
    if (config && typeof config.app_dir === 'string' && config.app_dir) appDir = realpath(config.app_dir);
  } catch {}
  // A path inside the working copy, after every symlink; null when it is not.
  const inside = (p) => {
    if (appDir === null || typeof p !== 'string' || indexOf(p, '\0') >= 0) return null;
    let real;
    try { real = realpath(p); } catch { return null; }
    return real === appDir || startsWith(real, appDir + pathSep) ? real : null;
  };
  // file:///a/b?x#y -> /a/b, by hand: URL and its prototype belong to the app too.
  const fileUrlPath = (url) => {
    if (!startsWith(url, 'file:///')) return null;
    let rest = slice(url, 7);
    let cut = indexOf(rest, '?');
    if (cut >= 0) rest = slice(rest, 0, cut);
    cut = indexOf(rest, '#');
    if (cut >= 0) rest = slice(rest, 0, cut);
    try { rest = decode(rest); } catch { return null; }
    if (isWindows) {
      if (rest.length > 2 && charCodeAt(rest, 2) === 58 /* : */) rest = slice(rest, 1);
      rest = replaceAll(rest, '/', '\\');
    }
    return rest;
  };
  const stripBom = (t) => (charCodeAt(t, 0) === 0xfeff ? slice(t, 1) : t);
  // Module.wrap and Module.wrapper are code the CommonJS loader puts around
  // every file it runs. Node defines them so they cannot be locked (a setter
  // that cannot be removed), so whether they are still Node's own is checked
  // before every module is loaded and every file compiled.
  const wrap = Module.wrap;
  const wrapper = Module.wrapper;
  const wrapper0 = wrapper[0];
  const wrapper1 = wrapper[1];
  // Read as descriptors, not values: a getter put on an element could answer
  // this check with Node's text and the loader with other code.
  const dataIs = (o, k, v) => { const d = getOwnDescriptor(o, k); return d !== undefined && hasOwn(d, 'value') && d.value === v; };
  const wrapIntact = () => {
    if (Module.wrap !== wrap) throw codeError('loading code after Module.wrap was changed');
    if (Module.wrapper !== wrapper || !dataIs(wrapper, 0, wrapper0) || !dataIs(wrapper, 1, wrapper1)) {
      throw codeError('loading code after Module.wrapper was changed');
    }
  };

  // Every module, ES or CommonJS, is loaded through this hook: a built-in, or a
  // file of the working copy. Registered first, so it runs last, on what any
  // other hook would have produced; and registering another is refused below.
  Module.registerHooks({
    load(url, context, nextLoad) {
      if (typeof url !== 'string') throw codeError('loading a module with no address');
      wrapIntact();
      if (startsWith(url, 'node:')) return nextLoad(url, context);
      const p = fileUrlPath(url);
      if (p === null || inside(p) === null) {
        throw codeError('loading ' + (startsWith(url, 'data:') ? 'code from a data: address' : startsWith(url, 'file:') ? '"' + (p === null ? url : p) + '", which is not one of its files' : 'code from ' + slice(url, 0, 80)));
      }
      return nextLoad(url, context);
    },
  });
  const refuseHooks = function registerHooks() { throw codeError('registering module loader hooks'); };
  lock(Module, 'registerHooks', refuseHooks);
  lock(Module, 'register', function register() { throw codeError('registering module loader hooks'); });
  // The V8 code cache is bytes the engine trusts; one the app wrote could carry other code.
  const compileCacheStatus = Module.constants && Module.constants.compileCacheStatus;
  lock(Module, 'enableCompileCache', function enableCompileCache() {
    say('refused: the module compile cache');
    return { status: compileCacheStatus ? compileCacheStatus.DISABLED : 3, message: 'Engram: the compile cache is off for app backends' };
  });

  // _compile is how the CommonJS loader runs a file it read; called by hand it
  // runs any string. It runs here only a file of the working copy, as it is on disk.
  const compile = Module.prototype._compile;
  lock(Module.prototype, '_compile', function _compile(content, filename) {
    wrapIntact();
    const real = inside(filename);
    if (real === null) throw codeError('compiling "' + String(filename) + '", which is not one of its files');
    let text;
    if (typeof content === 'string') text = content;
    else if (isBuffer(content)) text = bufToString(content, 'utf8');
    else throw codeError('compiling something that is not the text of a file');
    let disk;
    try { disk = readFile(real, 'utf8'); } catch { throw codeError('compiling "' + filename + '", which cannot be read'); }
    if (stripBom(text) !== stripBom(disk)) throw codeError('compiling text that is not what "' + filename + '" holds');
    // arguments, not a spread: a spread runs Array.prototype[Symbol.iterator], which the app can replace.
    return ReflectApply(compile, this, arguments);
  });

  const vm = require('vm');
  function Script() { throw codeError('compiling code with vm.Script'); }
  if (vm.Script && vm.Script.prototype) {
    Script.prototype = vm.Script.prototype;
    lock(vm.Script.prototype, 'constructor', Script);
  }
  lock(vm, 'Script', Script);
  for (const key of ['runInThisContext', 'runInContext', 'runInNewContext', 'compileFunction', 'createScript']) {
    if (hasOwn(vm, key)) lock(vm, key, function refusedVm() { throw codeError('running code with vm.' + key); });
  }
  for (const key of ['SourceTextModule', 'SyntheticModule', 'Module']) {
    if (hasOwn(vm, key)) lock(vm, key, function refusedVmModule() { throw codeError('vm.' + key); });
  }

  // WebAssembly: Node's own fetch compiles its HTTP parser (llhttp) the first
  // time undici loads, so undici is loaded now, before the lock; a module that
  // already exists may be instantiated again, new bytes may not be compiled.
  const W = globalThis.WebAssembly;
  if (W) {
    try { globalThis.fetch('data:,').catch(() => {}); } catch {}
    const moduleExports = W.Module.exports;
    const isModule = (m) => { try { ReflectApply(moduleExports, W.Module, [m]); return true; } catch { return false; } };
    const instantiate = W.instantiate;
    function WasmModule() { throw codeError('compiling WebAssembly'); }
    WasmModule.prototype = W.Module.prototype;
    for (const k of ['exports', 'imports', 'customSections']) if (hasOwn(W.Module, k)) defineProperty(WasmModule, k, { value: W.Module[k], writable: false, configurable: false, enumerable: false });
    lock(W.Module.prototype, 'constructor', WasmModule);
    lock(W, 'Module', WasmModule);
    lock(W, 'compile', function compile() { return PromiseCtor.reject(codeError('compiling WebAssembly')); });
    lock(W, 'compileStreaming', function compileStreaming() { return PromiseCtor.reject(codeError('compiling WebAssembly')); });
    lock(W, 'instantiateStreaming', function instantiateStreaming() { return PromiseCtor.reject(codeError('compiling WebAssembly')); });
    lock(W, 'instantiate', function instantiate_(source, imports) {
      if (!isModule(source)) return PromiseCtor.reject(codeError('compiling WebAssembly'));
      return ReflectApply(instantiate, W, [source, imports]);
    });
  }
})();
`;
