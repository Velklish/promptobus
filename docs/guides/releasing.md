# Releasing

Cut a release the way 0.18.0 and 0.19.0 were cut.

`git show --stat 62a4546b` is commit `62a4546b9d3dd044afbba9086857e60cb3666e99`, message `promptobus 0.18.0`, annotated tag `v0.18.0`. `git show --stat b3d4a387` is commit `b3d4a38792f4d8866b3f01a33c2da1823eb34c33`, message `promptobus 0.19.0`, annotated tag `v0.19.0`. Each release commit changes three lines: the `[Unreleased]` heading in `CHANGELOG.md`, the hand-written version in `docs/reference/01-overview.md`, and `version` in `package.json`. Each tag message is the same `promptobus X.Y.Z` line. The tag points at the release commit.

## Technical-writer pass

Run this pass before the release commit.

Input: the diff since the previous release tag, the human-facing documentation including `docs/adr/` and `docs/ROADMAP.md`, the terminal help text in `lib/cli.js`, and the shipped skills under `skills/`. The currency part checks the documentation, the CLI help and the skills against that diff. The style part covers the documentation and the CLI help; skills are written for agents and get no style pass. Load [`.agents/skills/tech-writer/SKILL.md`](../../.agents/skills/tech-writer/SKILL.md) first. Output: a commit of fixes to the documentation, the CLI help and the skills, and the currency ledger in that commit's message body. The currency ledger is a table with one row per document group of the overlay's Style list, one row each for `docs/adr/` and `docs/ROADMAP.md`, one row for the CLI help and one row per shipped skill; each row names the change it was checked against, or states that no change touches it. Review that commit the way any other piece is reviewed.

## Version and pins

Make these edits, then commit them as the release commit:

- Retitle `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD`.
- Set `version` in `package.json`.
- Set the hand-written version in the first paragraph of [Overview](../reference/01-overview.md). That sentence moves only in this commit.
- Update pinned documentation links and install examples by the command [Overview](../reference/01-overview.md) names. This guide does not copy that command.

0.18.0 and 0.19.0 changed only the three version lines. The install examples on those commits used a version placeholder, so no link line moved.

## Build and gates

Run `npm run build`, then `npx github:Velklish/backslop#v0.10.1 gates`. Both exit 0 before the release commit.

## Release commit

Commit the version edits as `promptobus X.Y.Z`.

## Tag

Create an annotated tag `vX.Y.Z` on that commit. The tag message is `promptobus X.Y.Z`.

## Push

Push the release commit and the tag.
