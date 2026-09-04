# Manual end-to-end checks

The automated suite (`npm test`) runs against stub adapters and a fake server.
It cannot tell you whether a real provider CLI, driven by the real bridge, in a
real checkout, actually does the work — and for a feature whose whole point is
running code on someone's machine, that is the question worth answering.

These scripts do that. They are **not** part of `npm test`: they need a provider
CLI installed and logged in, and they spend real tokens.

## Running them

```bash
node tests/manual/e2e.mjs            # everything that needs no provider turn
node tests/manual/e2e.mjs --with-cli # also the turns that spend tokens
```

`--with-cli` requires `claude` on PATH and authenticated. Expect a handful of
short turns.

## What they cover

Each check maps to a line in the "How to prove it works" list the feature was
specified against:

- a bridge with no `--allow-dir` refuses a named directory, and does **not**
  fall back to the scratch directory;
- `~/.ssh`, a `..` traversal, and a symlink inside the allowed root that points
  outside it are all refused;
- a named directory that does not exist is refused rather than created;
- an attachment URL on another host is refused;
- the posture gate: `workspace` and `native` are each refused unless the
  operator opted in, and adopted when they did;
- with `--with-cli`: a real turn in a real checkout reads a file, edits it, runs
  the test, and the working tree shows the change;
- with `--with-cli`: an attachment larger than the server's 1 MB frame cap
  arrives on disk with a matching checksum, the model reads it, and the
  directory is gone afterwards.

## A caveat worth knowing before you trust a green run

`isolated` is enforced by the provider CLI's own permission system, not by the
bridge. Claude Code reads `~/.claude/settings.json`, and the bridge does not
suppress it. If yours sets `permissions.defaultMode` to `auto`, `acceptEdits`
or `bypassPermissions`, an `isolated` turn has shell, read and write whatever
the bridge asked for — and these checks will still pass, because they assert
what the bridge sends, not what your local settings then do with it.

Check with `cat ~/.claude/settings.json` before drawing conclusions about
isolation from a green run here.
