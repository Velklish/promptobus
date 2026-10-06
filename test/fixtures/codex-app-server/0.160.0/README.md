# Codex app-server 0.160.0

Captured without edits on 2026-10-06 from the installed Desktop application binary.
`codex --version` exited 0 with `codex-cli 0.160.0`; binary SHA-256:
`6b582e8813ce7e8ed4c52814ee5cf230dba647bf2292df747a4003f2657ef201`.

```sh
codex app-server generate-json-schema --out <worktree>/test/fixtures/codex-app-server/0.160.0
```

Generation exited 0 with empty stdout and stderr. The complete capture contains
314 generated schemas, including both aggregate files, ClientRequest (104 variants),
ServerRequest (10 variants), top-level responses, and the v1/v2 modules.
All 314 schema files are byte-identical to 0.159.2: added 0, removed 0, changed 0.
[Provenance and file hashes](capture-provenance.json) record the complete inventory.
The provenance JSON is a capture record, not a generated schema.

The schema checks validate holder request, response and approval shapes. Generic
caller-supplied holder RPC forwarding is untyped; `currentTime/read` is an extension
absent from both generated ServerRequest captures. Binary schema validation measures
neither native model turns nor hook behavior. Those were not remeasured on 0.160.0.
[Historical 0.159.2 live evidence](../0.159.2/README.md) keeps its original version;
the minimum-version 0.158.0 capture and older records remain unchanged.
