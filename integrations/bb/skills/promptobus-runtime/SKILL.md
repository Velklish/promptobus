---
name: promptobus-runtime
description: Inspect the executing Promptobus BB plugin server and selected host build identity when diagnosing stale builds, runtime mismatches or unknown loaded versions.
---

# Inspect the executing BB runtime

Use this operator diagnostic for loaded build identity and parity. It needs no
task binding; participant duties and model routing use their existing commands.

```sh
bb promptobus runtime describe
```

Use `--host <id>` for an explicitly selected host; `--json` is optional. Otherwise
selection uses the invoking thread's environment host, or the primary host when
there is no invoking thread. An unresolved environment remains incomplete.

Report the exact command, exit code, `status`, `host.id`, `host.reason` and both
identities' `buildId` and `inputSha256`. Exit 0 with `complete` requires matching
non-null identities. Exit 1 with `incomplete` covers unbuilt, mismatched, older or
unavailable entries. Preserve an older server's unknown-command refusal.

The command makes one read-only RPC with a 5000 ms timeout. Propagate cancellation.
Do not automatically retry, reload, build, spawn or make model/engine calls to
repair an incomplete result. Continue only within the user's authorized scope.

- `sourceRevision` is the build-time HEAD, not a later squash. Revision and dirty
  state are `null` unless all measured local source files are tracked by that Git.
- The digest covers selected source, shipped skills, build inputs and recursively
  declared runtime dependency content. External transitive integration imports and
  runtime peers are not exhaustively inventoried; a unique id is no reproducibility claim.
- `npm run build` stamps identity; direct BB build/dev skips it. Concurrent builds
  in one directory are unsupported. A crash or SIGKILL can prevent source restoration;
  verify and restore the unbuilt placeholder, preserving source edits, before rebuilding.
- A mutable `dist/build-manifest.json` or artifact hash cannot establish loaded
  parity. Report live parity only from the actual diagnostic reply; builds and
  fixtures do not supply it. See [setup](../../README.md#executing-runtime-identity).
