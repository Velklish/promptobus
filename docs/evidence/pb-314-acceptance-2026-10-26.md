# Read-only Codex reporter acceptance audit

This acceptance audit gives the approver a requirement-to-evidence map for the existing reporter. The initial baseline source and branch point is `f6290d118106d4c368d4cf12ac42e965122fa150` (package 0.29.0). That initial phase changed evidence only. The later selected-context correction changed runtime code and tests; its probes and subsequent gates are recorded below. The card and archive remain approver-owned.

**Verdict: the original reporter contract, later selected-context correction, current mutation proof and completed gates are supported by the evidence below; acceptance remains the approver's decision after independent review.** No new native model run was made. Historical observations below apply to Codex 0.158.0/0.159.2 on 2026-10-01. Installed Codex 0.164.0 was checked by the later no-model schema gate; this audit does not transfer the historical live observations to that binary.

## Requirement matrix

The locations refer to the source SHA above. A passing source check establishes the inspected path; a historical fixture establishes only its recorded observation.

| Requirement | Initial baseline evidence | Verdict and limit |
| --- | --- | --- |
| Route to Claude Code or Codex; refuse Cursor | `lib/report.js:62` (`planReport`): harness/model admission, Cursor excluded from routing, recorded harness retained on relift. `test/report.test.mjs`: `report refuses cursor with the install-root project-layer reason` and both default/explicit plans. | Satisfied in inspected source and current focused checks. |
| Private skills/MCP home; no install-root project layer | `lib/driver-codex.js:631` (`prepare`) gives install-root roles no launch files, a private skill destination, `trustProject: false` and `bindBeforeFirstTurn`. `installPrivateHomeLayer` at line 560 copies skills there; `makeParticipantHome` at line 421 writes private config/auth. | Satisfied in source; reporter planning regression passes. Historical reporter fixtures record unchanged install-root snapshots. |
| Force read-only; disable project hooks | `lib/report.js:100` overrides caller permissions to `read-only`. `lib/codex-session.js:914` disables hooks at thread scope; `verifyThreadProfile` at line 923 rejects an effective sandbox mismatch before model input. | Satisfied in source; `Codex reporter uses a read-only private home without an install-root project write` passes. Native enforcement was observed historically, not remeasured here. |
| Omit bus send and classified external writes | `lib/report.js:112` calls `reviewerDenyTools`; `lib/review.js:88` refuses incomplete classification. `lib/driver-codex.js:585` maps classified pairs to `disabled_tools`; line 642 disables reporter bus send. `lib/codex-session.js:793` denies reporter mutation approvals. | Satisfied in source; inventory regression passes. Unclassified external command execution is outside this feature's guarantee. |
| Bind before first model turn; retain identity gates and reservation cleanup | `lib/report.js:173` reserves under the task lock; line 208 persists only its launch token and line 229 handles a lost launch. `lib/driver-codex.js:1246` persists the full thread before releasing `bound`; `lib/codex-session.js:1492` waits before `turn/start`. `src/mcp/server.ts:201` proves the reporter binding before digest/status/ask. | Satisfied in source; current report regressions cover stale plans, live/dead launchers, lost reservation cleanup and unbound identity denial. The shared holder path needs the separately executed current lifecycle checks. |
| Public reporter/auth/driver documentation; regressions, mutation and live proof | [Report](../reference/03-cli.md#report), [reporter channel](../reference/reporter-channel.md), [drivers](../reference/05-drivers.md), `skills/orchestrate/SKILL.md:44`, and CHANGELOG 0.22.0 describe the shipped contract. `lib/report-channel.js:9` preserves same-thread follow-ups and refuses participant callers. | Documentation and focused regressions present. Historical live proof retained. Historical mutation receipt not recovered; later current probes and gates are recorded below, separately from independent acceptance review. |

Cursor admission and unproven user impersonation remain refused. The reporter's restricted MCP ask is the explicit session-bound exception; terminal ask and report-question paths reject participant identities. Native shell reads remain available inside the reporter's read-only sandbox; the execution-free reviewer profile is a separate role.

## Initial baseline verification

The worker ran these exact commands on the clean source SHA above, with separate stdout/stderr capture and the command's own exit code:

| Command | Exit | Printed counts |
| --- | --- | --- |
| `node test/report.test.mjs` | 0 | 47/47 passed |
| `node test/lead.test.mjs` | 0 | 46/46 passed; includes reporter help and role-profile checks |
| `node test/codex-canonical-skills.test.mjs` | 0 | 4/4 passed |
| `node test/codex-participant-auth.test.mjs` | 0 | 11/11 passed |
| `npx --no-install backslop lint --require-adapter codex` | 0 | gate 1; files 119, links 970, local 921, anchors 390; errors 0, warnings 2 |

`node test/lead-lifecycle.test.mjs` exited 1 in the worker sandbox: `listen EPERM: operation not permitted`. The first assertion, `managed root native holder launches after complete task binding` (`started.status === 0`), was red; output reported `0/1 passed before abort`. Later assertions were not reached. This is a retained permission refusal, not a demonstrated pre-existing or flaky test. The worker did not retry it or widen permissions. The raw evidence is the separate `codex-acceptance-socket-refusal.md` task artifact.

During this initial baseline phase, the orchestrator delegated listener verification and all five required gates to a separate root phase after the worker's socket refusal. No runtime/test change or worker mutation had occurred at that point. Later authorization added the selected-context correction, worker probes and four worker gate commands; the root then completed all five gates. Those later records carry their own actor and SHA, as described in [current correction verification](pb-315-acceptance-2026-10-26.md#current-correction-verification), and do not replace the initial worker refusal.

The first root-owned mutation on audit HEAD `b1726fc1b64065b8cc97d25fb66e3020d8cd4c08` removed only the `planReport` permission override. Both mutated and restored runs stayed 47/47, exit 0; the outer probe exited 1. This recipe did not change the effective sandbox for the test's input: the driver's separate `role === 'reporter'` guard still selected read-only. It is a non-killing mutation, not passing mutation proof or evidence of a missing invariant. The original `pb-314-probe.json` remains unchanged (SHA-256 `e9f9f3c95b3175e8a767a23fb4a095cf26ef16837ddd59865bc913064e21125f`). The replacement recipe deliberately selects `workspace-write` for reporter in `lib/driver-codex.js:639`, with expected red verdict `Codex reporter uses a read-only private home without an install-root project write` recorded before execution. Current probe outcomes and restore checks remain separate task artifacts.

## Selected-context correction after gate diagnostics

The first full gate on audit HEAD `128dc5a0f40796f4df144e46b29bc1e97c60ba43` exposed a major admission defect in selected private-home delivery: an aliased system temporary-directory base reached a destination writer that correctly requires canonical parents. The same defect affects reporter preparation. The approver authorized a scoped producer correction. `lib/driver-codex.js` now resolves only the OS temporary base before appending the private container and home leaf. The recorded home and cleanup paths remain unchanged; the writer still refuses links below that base. See the [managed-root correction evidence](pb-315-acceptance-2026-10-26.md#selected-context-correction-after-gate-diagnostics) for the original baseline/repetition receipts and current regression. This correction and its committed mutation receipts supplement the baseline source map above; final gates and review must use the new handover HEAD.

The later worker probes on correction commit `0a8bc805af8aa83e30e3e41f2954bb3c5b8f0b9b`, four worker gates on `402631cca9989ce312dcdb6669f8bb343da2af2d`, and final root 5/5 gate pass on that same SHA are recorded in [current correction verification](pb-315-acceptance-2026-10-26.md#current-correction-verification). They establish current deterministic evidence while preserving the historical failures and version limits below. Subsequent wording-only commits retain that exact-SHA history and have their own four-gate and handover records.

## Historical provenance

The card's four implementation commits exist and each is an ancestor of tag `v0.22.0` (`git merge-base --is-ancestor COMMIT v0.22.0`, exit 0 for each):

- `b58bbce024d85a9616aea97a399081996d7f29ba`: private reporter home, restricted profile, pre-turn binding and canonical skills.
- `248511b83a261a37abaf8d11edf6b3a81127a182`: same-thread question channel.
- `f451a3e3071df3df7856c494f6ad00bfe5d8f538`: runnable follow-up hint.
- `cbe433946229de08f100c2223d2ecffafa57c961`: participant-identity refusal on that channel.

[Fixture inventory](pb-314-acceptance-fixtures-2026-10-26.json) records exact SHA-256, byte length and introducing commit for three retained files. A read-only `python3 -` audit exited 0: 3/3 structures and original bytes verified against `git show INTRODUCING_COMMIT:PATH`. The stdin script is retained with the task artifacts. Both reporter fixtures record a completed first turn, five bus tools with send absent, three completed digest/status/task reads, unchanged install root and exit 0. CanonicalSkills records worker/reviewer observations, not an additional reporter run.

These JSON files are curated observations, not raw rollouts or independently reproduced executions. Reporter cleanup is stated by the card; the reporter fixtures contain no explicit stop receipt. The original card reports `node test/report.test.mjs` 46/46, exit 0; the original implementation commit message contains only its subject, not that run's raw output.

The search inspected the four named commit messages/diffs, the 27 commits in `b58bbce0^..a7c76f98`, current tracked evidence and the relevant task history, including duplicate historical commit subjects. It recovered source, test definitions and live summaries, but no task-specific historical gate record, independent code-review report or mutation receipt with applied mutation, red verdict names, restored exit and clean-tree proof. The card's requested proof was not retained in those Git objects; whether it existed outside Git is unknown. A reviewer tool smoke fixture is not an independent code-review receipt.

## Closure proposal and remaining conditions

Proposed result text after the approver obtains current records: “Audited the existing read-only Codex reporter against its requirements at source `f6290d118106d4c368d4cf12ac42e965122fa150`. Verified private-home preparation, forced read-only profile, pre-turn identity binding, reporter-only reads/ask and reservation cleanup. Retained the dated 0.158.0/0.159.2 live observations and their original hashes. Current deterministic checks, semantic probe, gates and independent review are recorded separately; they do not reconstruct missing historical receipts or establish a new live run on 0.164.0.”

Before closure, the approver verifies the recorded forced-read-only mutation, final root gate pass, subsequent wording-only handover and independent feature review. Preserve the historical proof gaps and worker permission refusal in the closure result. This audit neither accepts nor closes the task.
