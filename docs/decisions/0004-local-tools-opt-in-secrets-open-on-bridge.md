---
status: accepted
date: 2026-08-29
supersedes:
superseded_by:
revisit_when: Engram stops encrypting sealed values in the browser, or a server must run local tools on machines whose operator never opted in
---
# Local tool execution is opt-in per machine, and sealed values open only on the bridge

## Context
Engram wanted tools that use a person's secrets (mail, cloud accounts) without
the server ever being able to read them. Running such a tool on the bridge turns
the server from something that runs code on its own machine into something that
runs code on the operator's machine, as them.

## Decision
- A tool marked `execute: "local"`, and every `local_call`, is refused unless the
  bridge was started with `--local-tools`; a server cannot turn it on. An absent
  `execute` means `server`, so existing servers are unchanged (merge 34a3579).
- The bridge holds a keypair whose private half never leaves the machine;
  Engram returns space keys wrapped to it, and sealed values are decrypted here.
  They are kept space by space and opened only through the space the call names,
  as a field of the item it names (commit d427c4b, 2026-08-31, after a
  cross-space leak through one flat map of bare names).
- Tools run behind `node --permission` and `unshare -rn`; a tool declaring
  `network: false` on a machine that cannot enforce it is refused. Output is
  scrubbed of sealed values before and after JSON parsing.

## Consequences
- The fingerprint check at enrolment is what stops a server substituting its own
  key; the README says not to skip it.
- Redaction is hygiene, not containment (README, "What redaction does and does
  not do").
- App backends (0.21.0) reuse the same gate, vault roles and scrubbing.

## Options considered
- Server-side execution with the server holding secrets: what this exists to
  avoid. No other alternatives are recorded.
