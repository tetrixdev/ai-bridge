---
status: accepted
date: 2026-10-25
supersedes:
superseded_by:
revisit_when: Claude Code drops or renames --system-prompt-file, --append-system-prompt-file or --system-prompt-snapshot, or a server wants a conversation's prompt frozen (for cache stability) and asks for it with a request field
---
# Claude gets the system prompt by file, rendered fresh on every turn

## Context
The Claude adapter passed the server's `system_prompt` as `--system-prompt
<text>` and the bridge addendum as `--append-system-prompt <text>`, on every
turn, resumes included, on the belief that the CLI does not keep a prompt
across `--resume`. Two things were wrong with that, both found on 25 October
2026 while Engram measured its prompt size:

- Linux refuses a single argv string over 128 KiB (MAX_ARG_STRLEN). A prompt
  of 200 KB failed at spawn with `spawn E2BIG`, so a server had to keep its
  whole prompt under that line (Engram capped its memory overview at 32 KB for
  this reason).
- Claude Code 2.1.257 added `--system-prompt-snapshot <on|off>`, default `on`:
  the system prompt of a conversation's first request is recorded and resent
  verbatim on every later request and resume, even when a later launch passes
  different text, until the conversation is compacted. Reproduced against a
  fake Messages API: turn two of a resumed session carried turn one's prompt.
  A server that rebuilds its prompt per turn (Engram's memory overview,
  guidance and notices) was silently ignored after the first turn.

## Decision
From 0.36.0 the Claude adapter writes the system prompt and the addendum to
0600 files in a fresh directory under the temp dir and passes
`--system-prompt-file` / `--append-system-prompt-file`, removing them when the
process closes (`src/providers/claude-system-prompt.ts`). Both flags are hidden
from `--help` and gated on the detected version: verified present and working
on 2.1.200; an older or unknown version keeps the argv flags.

On Claude Code 2.1.257 and later it also passes `--system-prompt-snapshot off`
on every turn, with or without a server prompt, so each request is rendered
from that launch's flags. That is the behaviour every CLI before 2.1.257 had,
and what a per-request `system_prompt` field means. The flag is fatal on a CLI
that predates it (2.1.252 exits with "unknown option"), hence the gate.

`tests/providers/claude-system-prompt.live.test.ts` runs the installed CLI
against `tests/providers/support/fake-anthropic.ts` and holds both: a resumed
turn carries its own prompt and not the first one, and a 300 KB prompt starts
and arrives whole. It skips where no `claude` is installed (CI);
`claude-system-prompt.test.ts` holds the argv shape everywhere.

## Consequences
- A server's prompt is no longer bounded by argv; its size is the server's
  call (cost and attention), not the operating system's.
- A server whose prompt changes between turns gets a new system block each
  turn, so the prompt cache misses from the first changed byte on. That is
  the cost of the prompt being current; a server that wants stable caching
  keeps its prompt stable, as it would have had to before 2.1.257.
- On a CLI between 2.1.200 and 2.1.256 the snapshot does not exist; on one
  before 2.1.200 the prompt still goes on argv and the 128 KiB limit still
  applies there.
