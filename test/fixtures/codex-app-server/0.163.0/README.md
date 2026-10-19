# Codex app-server 0.163.0 capture

Complete no-model schema generation from the installed codex-cli 0.163.0 on macOS arm64.
The version command and `codex app-server generate-json-schema --out <worktree>/test/fixtures/codex-app-server/0.163.0` both exited 0 using the same executable. `capture-provenance.json` inventories every generated file, its bytes and SHA-256, the binary hash before/after, timestamps, raw streams, source state and the comparison with 0.162.1. Historical captures retain their original bytes.

Distribution paths use `<worktree>`, `<installed-cli>` and `<installed-cask>` placeholders. The original direct command receipts, complete exact paths and identity manifest are retained in the worker evidence; the original manifest SHA-256 binds that evidence here. Generated schema files have no edits.

This captures schemas, not native model turns or hook behavior. Those were not remeasured on 0.163.0. Finite consumed-contract witnesses do not certify arbitrary caller-forwarded RPC; `currentTime/read` remains a separately documented extension.
