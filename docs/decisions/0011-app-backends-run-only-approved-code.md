---
status: accepted
date: 2026-10-19
supersedes:
superseded_by:
revisit_when: Node's permission model gains a code-loading or code-generation permission of its own, module.registerHooks changes shape, or app backends get a runtime other than Node
---
# An app backend runs only the files of the version the person approved

## Context
Engram asks the person once per app version before its backend runs (Engram
decision 0107), and the network fence (0.29.0) holds the backend to the hosts
its manifest declares. A re-audit on 2026-10-19 (Engram security finding S4)
showed that the approval did not cover what ran: a backend fetched code from a
host it declares and evaluated it (`evaluated: REACHED:evil-code-ran`). Node's
`--disallow-code-generation-from-strings` stops eval and `new Function` but not
`vm`, `Module.prototype._compile`, `data:` imports or WebAssembly (checked on
Node 22.23). Jasper chose on 2026-10-19 to fence the code in the bridge
(option B), rather than only saying so on the approval card.

## Decision
From 0.33.0 (`hello.app_code: 1`) a backend starts with
`--disallow-code-generation-from-strings`, and the fence it already loads
first (`src/apps/guard.ts`) also locks every other way to run code that is not
one of the version's files: the `vm` module, `Module.prototype._compile` (only
a working-copy file, with its text on disk), `Module.wrap`/`wrapper` (checked,
since Node defines them so they cannot be locked), a `module.registerHooks`
load hook that admits only `node:` built-ins and files whose real path is in
the working copy, `module.registerHooks`/`register` after it,
`module.enableCompileCache`, and compiling WebAssembly (Node's own `fetch`
parser is compiled before the lock). A folder the manifest may write that
overlaps the bridge's app data is refused. A Node without
`module.registerHooks` (before 22.15) does not start a backend.

## Consequences
- Tested both ways (`tests/apps/code-fence.test.ts`): every attempt runs the
  downloaded code on 0.32.0 and in plain Node, and is refused here.
- A library that generates code (template engines, some validators, `depd`)
  does not run in a backend; no shipped Engram app and none of the owner's
  apps uses one (checked 2026-10-19). `node:repl` does not load.
- Not held: an approved file that interprets downloaded data, and any child
  process (`shell`, `programs`), which runs outside both fences.
- Machines on Node 22.0 to 22.14 run no backends until Node is updated; the
  error says so.

## Options considered
- **Card wording only** (option A): honest, but leaves the hole.
- **Node's `--experimental-policy` integrity manifest**: removed from Node.
- **Lock functions only, no loader hook**: `data:` imports and files written
  to a writable folder go through the ES loader, which has no public function
  to lock.
- **A WebAssembly allowlist by hash of Node's own modules**: the bytes are not
  reachable under the permission model; compiling before the lock is simpler.
