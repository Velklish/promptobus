# Codex app-server 0.162.1

The full schema capture described here is preserved in Git history; only dated evidence and, for the minimum version, the consumed contract remain in this directory.

Captured without schema edits on 2026-10-15 from the installed `codex-cli 0.162.1`.
The binary SHA-256 is `74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0`.

```sh
codex app-server generate-json-schema --out <worktree>/test/fixtures/codex-app-server/0.162.1
```

Generation exited 0 with empty stdout and a PATH-alias permission warning on stderr.
The complete capture contains 317 generated schemas, with 105 ClientRequest and
10 ServerRequest variants. Compared with 0.160.0, 3 schemas were added, none removed,
34 changed and 280 stayed byte-identical. The [capture record](capture-provenance.json)
contains both command results, the binary hash and every generated file hash.
Earlier captures remain unchanged.

Binary schema validation measures neither native model turns nor hook behavior.
Those were not remeasured on 0.162.1. Historical live evidence retains its measured
version in [ADR-029](../../../../docs/adr/adr-029-bb-constrained-codex-reviewer.md).
