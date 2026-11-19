# Qualifying an installed shared service

**Status: not run.** Use this worksheet at stabilization. One physical MCP/warden owner per canonical workspace/store is the candidate acceptance criterion. Two logical HTTP routes, task watches and a warden Worker are not additional processes. Native provider processes still count in the workload.

## Admission

The run owner selects the final candidate artifact (including the telemetry fence repair), a pre-sharing baseline and a supported subscription-only profile for each run. Record Git SHAs, package hashes, Node, Host, OS, provider versions, resolved executables, launcher argv, and effective workspace, store, service and native homes. Confirm the launcher/config dependency is ready **in the installed artifact**. Use dedicated owned state; verify the effective paths, including hook and credential-helper configuration, before launch. If a profile needs personal state, a different account or PAYG, mark it `notRun` with the missing prerequisite.

The owner must authorize the tasks, roles, subscriptions, resource budget, listener crash and cleanup boundaries. If the historical default namespace is blocked, the owner must decide whether to authorize **fresh isolated qualification only** or hold for the original owner and exact client proof. Neither choice retires a grant. Keep historical recovery unresolved until both the matching native terminal proof and grant-specific retirement evidence exist; namespace maintenance needs separate authorization covering every affected client. See [upgrade refusal](../reference/03-cli.md#when-an-upgrade-refuses-a-historical-client). Never reuse an ended participant to exercise a regression.

## Run order and expected evidence

Installed launcher help must include:

<!-- quote:../../bin/promptobus-root -->
```text
Usage: promptobus-root --profile <approved-profile> [--service-home <path>] [--dry-run] -- <approved-native-command> [args...]
```
<!-- /quote -->

1. **One ordinary standalone launch first.** Use the consumer's installed `promptobus-root --profile <id> -- <native-command> <args...>` and the [approved NEW argv, native HTTP descriptor and ordered start hook](../reference/02-host.md#standalone-root-profiles). Record the actual native binding, then use its public task and mailbox tools. Exchange a message and artifact with a newly lifted owned participant; match sender, recipient, journal ID and artifact digest. Repeat for each available supported harness/role; record missing profiles individually. Do not advance a failing profile to the crash matrix. Ordinary BB creation remains unsupported; retain the existing packaged BB paths and their regressions.
2. **Boundaries and work lifetime.** Start two tasks concurrently against one cold canonical workspace/store. Match discovery PID **and birth** across launches. Keep a startup reservation outstanding, then an admitted idle client: `service stop --json` must refuse in each state. Check each task sees its own journal and the reviewer reads only approved files through `/mcp/reviewer_files`; keep a denied out-of-scope read and a denied mutation with no effect. Close one task and show the other's watch and tools still work.
3. **Telemetry race on fresh managed Codex.** Correlate actual holder telemetry publications with mailbox reads and artifact dispatch on the same task/address/native launch. Save request IDs, results and durable effects. Without observed overlap, the race check is inconclusive. Pair this run with `test/shared-service-operation-authority.test.mjs`: changing authority or launch must refuse, and a repeated request must not create a second effect. Do not change live authority merely to fabricate a control.
4. **Listener crash, then owner preflight.** Record owner identity, client binding, durable journal IDs and pending work before interrupting only the approved listener. Record the interval with no listener. Use the matching consumer owner preflight before native reconnect/reinitialize; for standalone use `service preflight --standalone --profile <id> --native-id <actual-id>` in the same scope. Record the *first action that actually restarts the owner*, new PID/birth, resumed journal and one fresh operation on the same native binding. Old credentials must not regain authority; an uncertain mutation is not permission to issue it again. An explicit ensure, test helper or relaunch is not automatic native healing.
5. **Close and account.** Retain native Stop results and receipts, command/turn accounting, app close and holder/app absence. Use the [child-before-parent closure procedure](../reference/03-cli.md#shared-service) where applicable; then record physical `service stop --json` exit and a final owned descendant census. Native Stop, observed process exit and forced cleanup are separate results. Forced cleanup does not pass normal shutdown.

For each action retain timestamp, sanitized exact argv or tool request, source/runtime, stage, CLI exit **or** observed HTTP status, MCP `isError`, first safe error text, and receipt/journal pointer. Shell exits do not exist for MCP calls; unknown status is `unknown`, even for a known fence message. Stop dependent actions on a refusal. Record any separately authorized bounded retry as another result; keep the first refusal intact.

## Matched measurements

Freeze task count, roles, provider/model, prompts and payload sizes, concurrency, warm-up, sample count, sampling milestones and host conditions before either run. Use equivalent clean state for each installation. At ready, idle, after dispatch and after closure retain timestamped PID/birth evidence and RSS in KiB for every owned process (including providers and detached descendants). Attribute each physical process once: `service`, baseline `stdio` or `warden`, `provider`, or `other`. Include both total RSS and counts by role; summed RSS can count shared pages more than once. No saving follows from TypeScript erasure.

`node scripts/owned-process-sample.mjs < sample.json` summarizes one **already collected** observation. Input is an object with `roster` (one `{pid,birth,role}` per owned identity at that milestone) and `observations` (matching `{pid,birth,state:"live",rssKiB}` or `{pid,birth,state:"absent"}`). `birth` is the recorded process birth identity as a string. Supply absence only with independent evidence for that identity. Missing or mismatched observations refuse; missing evidence is not zero. The script cannot discover an omitted descendant. Reconcile the roster against launch receipts and a separate owned descendant census, including detached owners; retain both, including at cleanup.

Time the same command from invocation to exit, and the same message from send to recipient observation, using a common monotonic clock in ms. Report raw samples, count and median separately for each operation and installation. Record failures and timeouts separately. A changed workload or missing baseline leaves the comparison unmeasured.

## Acceptance and handover

At stabilization, run `npm run build`, then `node test/run.mjs --files owned-process-sample.test.mjs standalone-owner-recovery.test.mjs shared-service-operation-authority.test.mjs shared-service-stop-retirement.test.mjs bb-root-invocation.test.mjs` against the selected source. These are regression fixtures, not native workflow results. Run the full configured gates against the committed change range separately.

Keep a row per scenario/profile with `passed`, `failed`, `inconclusive` or `notRun`, evidence location and limitations. Record exact configured gate commands, exits, green/total and skipped counts, mutation probe and independent review disposition (zero critical/major; register minor findings with evidence). Deliver the checked artifact digest, package exports and installed runtime paths from its manifest, actual launcher argv, loopback `/mcp/bus` and `/mcp/reviewer_files` descriptors, and hook/preflight/reconnect sequence. Never export bearer values or private plans. Leave consumer repinning to its owner and publication to the release process.
