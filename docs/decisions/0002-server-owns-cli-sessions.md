---
status: accepted
date: 2026-05-18
supersedes:
superseded_by:
revisit_when: a bridge must resume conversations without a server that persists session ids
---
# The server owns CLI session ids; the bridge is stateless about them

## Context
Web applications keep a conversation as a list of messages; each CLI keeps its
own resumable session. Before PR #14 the bridge kept a `SessionStore` mapping
conversations to CLI sessions, and Claude resume did not actually work
(`--session-id` creates rather than resumes).

## Decision
The server persists `conversation_id -> cli_session_id`. Each `ai_request`
carries `cli_session_id` (null for a fresh start, then with optional `history`
folded into the prompt); `done` returns the id to store. A failed resume is
reported as `session_lost`, with no `done`, so the server can drop the id and
re-issue the turn. See PROTOCOL.md, "Conversation Continuity".

## Consequences
- A bridge restart or a different machine loses no conversation mapping.
- The bridge's only session record is local and narrower: which directory a
  session it started is rooted in (`src/workspace/sessions.ts`), so a resume in
  a different checkout is refused. That file is not the conversation mapping.
- Prompt caching works through each CLI's native resume.

## Options considered
- Bridge-side session store (the previous design): removed in PR #14. The PR
  does not record further reasons beyond the stateless goal and the resume bug.
