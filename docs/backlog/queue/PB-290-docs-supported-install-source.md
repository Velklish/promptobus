# PB-290 · Use an available package source throughout the installation guide

- **Order:** 400
- **Scope:** [02-host](../../reference/02-host.md), [Install](../../guides/install.md)
- **Created:** 2026-09-27
- **Dependencies:** none

- **Cost:** major

## Context

The installation guide cannot be followed as written on 2026-09-27. Its package section recommends a registry package that does not exist, while both READMEs already document GitHub installation.

## Evidence

- At b3d4a38792f4d8866b3f01a33c2da1823eb34c33, docs/guides/install.md:19-23 says `npm install promptobus`; README.md:43-46 and README.ru.md:38-41 say the package is not on the npm registry and give a GitHub release source.

- 2026-09-27: `curl --silent --show-error --location --max-time 40 --output /tmp/promptobus-registry.json --write-out '%{http_code}\n' https://registry.npmjs.org/promptobus` returned HTTP 404 and `{"error":"Not found"}`; the equivalent audit GET exited 0 because it did not use --fail. HTTP status, not curl exit 0, is the package-availability verdict.

## Work to do

- Align all install examples with the available, pinned GitHub release source; distinguish local-library and global-CLI installation.
- Keep registry publication outside this documentation repair.

## Out of scope

- Runtime feature changes, publication, and closing unrelated backlog entries.

## Verification

- A clean temporary installation using the documented release source completes and `promptobus --version` prints the expected version.
- Search README.md, README.ru.md and docs/guides/install.md for registry-only commands; no unqualified `npm install promptobus` remains while the registry endpoint is 404.
