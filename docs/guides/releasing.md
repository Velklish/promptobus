# Releasing

Cut a release the way 0.18.0 and 0.19.0 were cut.

`git show --stat 62a4546b` is commit `62a4546b9d3dd044afbba9086857e60cb3666e99`, message `promptobus 0.18.0`, annotated tag `v0.18.0`. `git show --stat b3d4a387` is commit `b3d4a38792f4d8866b3f01a33c2da1823eb34c33`, message `promptobus 0.19.0`, annotated tag `v0.19.0`. Each release commit changes three lines: the `[Unreleased]` heading in `CHANGELOG.md`, the hand-written version in `docs/reference/01-overview.md`, and `version` in `package.json`. Each tag message is the same `promptobus X.Y.Z` line. The tag points at the release commit.

## Technical-writer pass

Run this pass before the release commit.

Run `backslop-writer` in release mode over `git diff <previous tag>..HEAD`. Its default scope covers root `README*.md`, the unreleased section of `CHANGELOG.md`, and `docs/**` except the backlog and archive. This includes `docs/adr/` and `docs/ROADMAP.md`. Check `README.ru.md` as a faithful translation of `README.md`.

The `writer.style` glob in `backslop.json` selects all of `lib/cli.js`, but the [local writer rule](contributing.md#local-writer-rules) narrows style review to the human-facing `helpText` block. Refusal strings and comments outside that block are not style targets. The `writer.currency` glob adds every shipped skill under `skills/` to currency review only; skills are written for agents and get no style pass.

Record a currency ledger row for each behaviour-changing commit, plus one row for the CLI help and one for every shipped skill. A surface row names the change it was checked against or says `no change touches it`. Record a style ledger row for each `backslop-humanizer` pattern. A release has no writer task, so put both ledgers in the message body of the commit carrying the writer fixes. Commit fixes by document group as the writer skill directs, then review those commits before the release commit.

## Version and pins

Make these edits, then commit them as the release commit:

- Retitle `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD`.
- Set `version` in `package.json`.
- Set the hand-written version in the first paragraph of [Overview](../reference/01-overview.md). That sentence moves only in this commit.
- Update pinned documentation links and install examples by the command [Overview](../reference/01-overview.md) names. This guide does not copy that command.

0.18.0 and 0.19.0 changed only the three version lines. The install examples on those commits used a version placeholder, so no link line moved.

## Build and gates

Run `npm run build`, then `npx --no-install backslop gates`. Both exit 0 before the release commit.

## Release commit

Commit the version edits as `promptobus X.Y.Z`.

## Tag

Create an annotated tag `vX.Y.Z` on that commit. The tag message is `promptobus X.Y.Z`.

## Push

Push the release commit and the tag.
