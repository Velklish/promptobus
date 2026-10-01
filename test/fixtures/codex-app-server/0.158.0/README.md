# Codex app-server 0.158.0

The 314 generated JSON schema files were captured without edits on 2026-10-01:

```sh
codex app-server generate-json-schema --out <capture-directory>
```

The binary reported `codex-cli 0.158.0`. For 0.158.0 it was the Homebrew binary;
for 0.159.2 it was the binary bundled with the desktop application. The two aggregate
files, top-level requests and responses, and `v1/` and `v2/` modules are the complete
capture. Live evidence JSON files beside them are curated observations, not schemas.
`node test/codex-fixtures.test.mjs` validates the holder's request parameters against
both versions. Historical 0.156.1 evidence remains under its original directory.
