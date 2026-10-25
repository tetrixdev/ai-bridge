---
status: accepted
date: 2026-10-25
supersedes:
superseded_by:
revisit_when: Claude Code gives subagents the main system prompt or the append text itself, or a server needs a helper section different from the main one under append mode
---
# Claude subagents get the bridge's session section too

## Context
The bridge's "How this session runs" section (non-interactive, bounded
commands, no detaching, parallel tool calls) and a server's `bridge_prompt`
text in `append` mode were passed with `--append-system-prompt`, which reaches
the main assistant only. A Claude Code subagent has its own system prompt; the
only text a server or the bridge can add to it is
`--append-subagent-system-prompt-file`, which carried `subagent_prompt` alone.
Measured in Engram on 25 October 2026: helpers gave a description on 32% of
their shell commands against 99.9% in the main chat, the line asking for it
(Engram's `bridge_prompt` append text) being in the main prompt only.

## Decision
From 0.36.0 the bridge builds a helper version of its section
(`buildHelperAddendum` in `src/providers/env.ts`) and appends it, followed by
the `bridge_prompt` text under `append`, to the subagent prompt file after the
server's `subagent_prompt`; it writes the file for this even when the server
sent no `subagent_prompt`. Under `off` and under `replace` subagents get no
section: `replace` text was written for the main assistant, and a server that
takes over the bridge's words has `subagent_prompt` for its helpers' version.

Worded for a subagent, not copied: it reports to the assistant that started
it, gets no messages while it runs, and must end or stop what it started in
the background before it returns. Tested per Engram's "writing prompt
instructions" with fresh subagents as readers (practice set in
`tests/providers/helper-addendum.scenarios.md`; a confirm set passed after one
fix, which made the 2-minute timeout read as the tool's default when none is
set rather than as a rival to a server's own timeout rule). A shorter variant
scored no better and was not taken.

`tests/providers/claude-system-prompt.live.test.ts` starts a real subagent
through the fake Messages API and checks its system prompt holds the server
text and then the bridge's section, and not the main prompt.

## Consequences
- Every Claude turn on 2.1.261+ writes a subagent prompt file, also for a
  server that never used `subagent_prompt`; its subagents now get the section.
- A server that relied on the section reaching the main assistant only (for
  an `append` text meant for it alone) should move that text into
  `system_prompt`.
