# PB-398 · Validate the canonical root dependency mirror in npm self-link metadata

- **Scope:** [Contributor checks](../../guides/contributing.md), npm self-link mirrors
- **Created:** 2026-10-23
- **Dependencies:** none
- **Cost:** major

## Context

On the unchanged native-observer source candidate, `npm run pins` exits 1 on the nested plugin lockfile's root package mirror. npm records the canonical repository devDependency under `packages['../..']` and a linked `node_modules/promptobus` entry. The gate allows only root dependency files and therefore reports this mirrored declaration as a live command. Two isolated baseline runs produced the same finding before production source changes.

## Work to do

- Validate that nested npm metadata links the actual declared root package back to this repository, and that the mirror matches the canonical dependency property.
- Allow only the source location of that exact mirrored property. Continue scanning the entire file and reject independent references, stale pins, foreign links, duplicate keys and malformed metadata.
- Add regression cases and mutation detection; document the exact allowance.

## Out of scope

- Dependency upgrades, broad directory/file exemptions, generated lockfile edits, publication and changes to the retained observer source/artifacts.

## Verification

- A legitimate self-link mirror passes and fails on the unchanged gate.
- Wrong/stale pins, foreign/non-self links, extra references before/after the mirror, escaped mirror laundering, duplicate keys and malformed metadata all fail.
- Commit before mutation probing. Run focused pin tests, `npm run pins` and the required source gates with exact receipt evidence.

## Transfer to main

Recovered on 2026-11-13 from `acceptance-ru46-rest-reserved-ids` at `0dcf219ef5ad7c7ef73e079a26a4bf686f8c5090`. This transfers the recorded finding only. Historical verification and approval apply to the named source and run; no implementation, current reproduction or acceptance is implied. Next step: compare the finding with current source and accepted work, then prioritize or merge an established duplicate. Previous active status is not carried into this metadata transfer.
