# PB-413 · Publish promptobus to the npm registry instead of a GitHub git pin (owner decision)

- **Scope:** [Releasing](../../guides/releasing.md), [Install](../../guides/install.md)
- **Created:** 2026-10-29
- **Dependencies:** PB-335.1 (the release channel: tag a side commit or release a packed tarball)
- **Cost:** major

## Context

Consumers install the package from a GitHub tag (`npm install github:Velklish/promptobus#v0.31.0`; [Install](../../guides/install.md) says the package is not on the npm registry). npm installs a git dependency by cloning it and building it in a temporary copy, so every consumer's install fetches the development checkout and compiles TypeScript. One consumer's GitLab registry drops `bundleDependencies`, which this install route leans on. A published package would give an exact pin without a clone.

Evidence:

- Source: [Install](../../guides/install.md) lines 19-28 name the git pin and say the package is not on the registry. A consumer workspace measured on 2026-09-09 that the name `promptobus` was free (the registry answered 404); re-check the name before publishing.
- Source: PB-335.1 records the clone-and-build install route and two ways to remove its remainder (a side-commit tag, a packed tarball). Publishing to the registry is a third way and changes the install contract the same way.

A consumer workspace deferred the publication on 2026-09-04: the package was still being reworked and consumed locally. Publication is irreversible (a public release is not overwritten or unpublished) and needs the owner's rights on the registry, so no agent run does it.

## Work to do

- The owner decides whether to publish, under which name (`promptobus`, or a scoped name when the plain one is taken) and from which version.
- Then: publish, create the release and the tag; switch the install and release guides to the registry pin (exact, without `^` and `~`); run the release canary with a consumer; tell consumers to move from the git pin.

## Out of scope

- Overwriting or unpublishing a released version.

## Verification

- A fresh install from the registry at the exact version works without a clone, a build or a `bundleDependencies` step.
- The install guide names the registry pin, and `npm run audit` exits 0 on the packed tarball.

## Deferred

- **Deferred:** 2026-10-29
- **Reason:** publication is irreversible and the owner's decision; the tag channel works, and PB-335.1 still has to settle the release channel first.
- **Return condition:** the owner decides to publish to the registry (the name and the first version are part of that decision), or PB-335.1 chooses a channel that makes the registry the natural one.
