---
name: promptobus-runtime
description: Inspect the executing Promptobus BB plugin server and selected host build identity when diagnosing stale builds, runtime mismatches or unknown loaded versions.
---

# Inspect the executing BB runtime

Use this operator diagnostic for loaded input-snapshot identity. It needs no
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
Do not automatically retry, install, reload, build, spawn or make model/engine calls to
repair an incomplete result. Continue only within the user's authorized scope.

- `sourceRevision` is the build-time HEAD, not a later squash. Revision and dirty
  state are `null` unless all measured local source files are tracked by that Git.
- Each `npm run build` creates `.runtime/<buildId>`. Activate only the exact
  `installationDirectory` from its successful receipt. Building B preserves loaded
  A; reload stays on registered A. Explicit install B switches. The source root
  is not a supported install target; builds never install, reload or delete old generations.
- The id names captured inputs, not BB loader cache bytes or current SDK/Node APIs.
  Dynamic import/require/eval, consumer file-relative assets and external runtime
  code are not claimed frozen. Existing host flat-bundle origins remain unchanged.
- A manifest or artifact hash cannot establish loaded identity. The actual reply
  measures reported snapshot parity only; a unique id is no reproducibility claim.
  See [setup](../../README.md#executing-runtime-identity) for activation limits.
