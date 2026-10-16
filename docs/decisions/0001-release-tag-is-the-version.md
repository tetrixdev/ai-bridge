---
status: accepted
date: 2026-05-17
supersedes:
superseded_by:
revisit_when: releases are cut by something other than publishing a GitHub release, or a second package is published from this repository
---
# The release tag is the single source of truth for the published version

## Context
The publish job ran `npm publish` with whatever version `package.json` held,
which nothing tied to the git release tag. A tag ahead of `package.json` failed
the publish after the GitHub release already existed; `package.json` ahead of
the tag published a version that did not match its release. Keeping them in
step was a manual step that had already been needed by hand for 0.1.2 (PR #12).

## Decision
Publishing a GitHub release tagged `vX.Y.Z` is the release. The `publish` job in
`.github/workflows/ci.yml` reads the version from the tag, refuses a tag that is
not semver or a version npm already has, stamps `package.json` with
`npm version --no-git-tag-version` before building (so the version tsup bakes
into `dist/cli.js` matches), then publishes with provenance.

## Consequences
- Nobody bumps `version` in `package.json`; in the repository it is cosmetic
  (it still reads 0.1.2) and must not be relied on.
- Drift between tag, npm version and the binary's `--version` cannot happen.
- Release notes live in the GitHub release body; there is no CHANGELOG.md.

## Options considered
- Hand-bump `package.json` and check it against the tag in CI: still a manual
  step, only louder. PR #12 calls the chosen flow the smallest change to the
  existing `release: published` workflow.
