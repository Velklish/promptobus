# Codex app-server 0.162.0-alpha.2

Captured without edits on 2026-10-08 from the installed Desktop application binary.
`codex --version` exited 0 with `codex-cli 0.162.0-alpha.2`; binary SHA-256:
`cb4e4994627e770800a940b42969c77855a3fc09a6e60b02aa6319f670d6b6ab`.
The directory uses the three-component version that the native driver's version
parser and local schema gate compare. This capture measures the alpha build,
not the later stable release.

```sh
codex app-server generate-json-schema --out <worktree>/test/fixtures/codex-app-server/0.162.0
```

Generation exited 0 with empty stdout and stderr. The complete capture contains
317 generated schemas, including ClientRequest (105 variants), ServerRequest
(10 variants), top-level responses, and the v1/v2 modules. Compared with 0.160.0,
3 schemas were added, none removed, 25 changed and 289 stayed byte-identical.
[Provenance and file hashes](capture-provenance.json) retain the complete inventory,
exact build, binary hash and comparison. The provenance JSON is a capture record,
not a generated schema. Earlier captures remain unchanged.

Binary schema validation measures neither native model turns nor hook behavior.
Those were not remeasured on 0.162.0. The constrained BB reviewer has separate
[live permission evidence](../../../../docs/adr/adr-029-bb-constrained-codex-reviewer.md);
that is not evidence for the complete native worker/orchestrator workflow.
