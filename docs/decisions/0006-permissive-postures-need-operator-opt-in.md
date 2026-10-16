---
status: accepted
date: 2026-09-04
supersedes:
superseded_by:
revisit_when: the server and the bridge operator are always the same party, or a CLI gains a posture the bridge cannot enforce
---
# Permissive isolation postures need the bridge operator's opt-in

## Context
The server picks a posture (`cli_isolation`). PR #23 added `workspace` between
`isolated` and `native`. Gating only `workspace` would have been theatre: a
server denied the shell one way would ask for `native` and get more. The PR also
found `isolated` was only requested: the CLI's own permission system read the
operator's config, so a developer with `defaultMode: "auto"` silently turned
every isolated turn into "everything allowed".

## Decision
- `workspace` needs `--allow-dir`; `native` needs `--allow-native`. A server
  asking for either without the flag, or sending an unknown value, gets
  `isolated` and a log line. The bridge reports the adopted posture (`posture`).
- `isolated` is enforced by stating it to the CLI (`--permission-mode manual`
  for Claude, `sandbox_mode=read-only` for Codex), not inherited from the
  operator's settings.
- A `working_dir` is checked after `realpath` against the allow-list and refused
  rather than corrected; nothing is created and there is no scratch fallback.

## Consequences
- Breaking for anyone who relied on `native` being granted on request.
- Gemini has no equivalent lever; an isolated Gemini turn is bounded by its own
  defaults (README, docs/isolation.md).
- User-level instruction files, hooks and plugins still load in every posture.

## Options considered
- Leave `native` ungated and narrow the README claim: offered in PR #23 as the
  reversible alternative, not taken.
