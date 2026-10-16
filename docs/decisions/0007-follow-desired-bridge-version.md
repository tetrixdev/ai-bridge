---
status: accepted
date: 2026-10-03
supersedes:
superseded_by:
revisit_when: bridges must self-update on macOS or Windows, or outside a systemd unit
---
# A bridge follows the server's desired_bridge_version through a pinned systemd unit

## Context
Servers depend on bridge features (decision 0005), but bridges run unattended on
machines nobody updates by hand. When a server deploys with a new pinned bridge
version, every connected machine should move to it on its own (PR #48).

## Decision
- `welcome.desired_bridge_version` names an exact version, upgrade or downgrade.
  Only strict semver; anything else, or below 0.24.0 (which would strand the
  machine on a release that never follows again), is ignored with a warning.
- A bridge acts only when it is a managed systemd unit that restarts it and
  starts `@tetrixdev/ai-bridge@${AI_BRIDGE_VERSION}` from one writable env file;
  it says so in `hello.self_update`. Otherwise it only logs.
- It fetches and smoke-runs the version (`--version`), waits until no work is in
  progress, pins the env file, closes normally and exits 75 for systemd to
  restart it. Failed fetches and versions that do not take back off.
- `ai-bridge install` writes the pinned form; `--no-self-update` opts out.

## Consequences
- A deploy plus restart of the server reaches every reconnecting bridge.
- A release that crashes before reaching the update code cannot be recovered
  automatically; the smoke run makes that rare.
- macOS, Windows and terminal runs report `self_update: false` and need manual
  updates.

## Options considered
- Not recorded beyond the managed-unit conditions; the PR does not discuss
  alternatives such as npm-global updates.
