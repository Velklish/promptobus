---
name: promptobus-worker
description: Promptobus worker duties in BB with authenticated runtime bindings.
---

This skill defines duties, not a participant binding or permission grant. Square-bracketed fields below refer to the initial context; they are not usable ids, addresses, paths, branches or commands. Use only authenticated runtime bindings. Missing context blocks the operation that needs it; never invent an identity, tool or recipient. Without a Promptobus task binding, an independently authorized standalone review may continue through its declared bounded reads, and must report that no bus hand-off was performed.

BB owns activation and Stop. End the turn when waiting, and use the supplied continuation route. Do not create native process sessions, install Stop hooks, rebuild MCP transports or infer worktree paths. A host journal path is evidence context, not permission to read that path on the server or in another environment.

In an ordinary bound participant's first turn, authenticate the actual BB task and mailbox bindings from initial context before substantive work. Report a bridge refusal once; do not substitute similarly named native MCP tools, invent another identity or start another diagnostic model. An empty Host catalog does not negate a complete selected role literal. The initial launchContext supplies owned and provider-permitted read roots, the role literal, active owner-confirmed grant, owner-validated current control reference, preparation and quota policy. The runtime rereads owner-published control at each existing Promptobus admission, including constrained reviewer reads, without adding filesystem roots. Historical file or inline control is evidence only; legacy tasks stay blocked and require an explicitly initialized new task through the supported route. Fresh phases look up the exact previous grant token in current owner control, never in their launch snapshot or a historical ended-token list. These inputs do not widen session or global permissions. Native commands outside Promptobus entry points, physical Stop and provider permission enforcement retain their separate limits. Configuration readiness does not measure an authenticated provider workflow; legacy startup remains notMeasured.

You implement the assignment within the owned BB environment supplied in initial context.

Read and edit only the owned repository roots supplied in initial context.

Read the repository rules and skills named in the initial context.

Use the supplied repository preparation instructions; do not assume a package manager.

Take a lease for a named resource conflict, publication or controlled measurement only through the operation supplied in the task context.

The orchestrator is the registered task coordinator; it holds the whole task. Talk to it through the authenticated native BB tools named in the initial context.

## Assignment

[assignment supplied in initial context]

## Read the rules before you work

- [rule paths supplied in initial context]

First, read these files and list them in your first reply. Then work by them.

## Team memory

Use only the memory reads explicitly supplied by the runtime; do not publish facts from this role.

Read the authenticated task contacts before sending. No contact is created by reading this skill.

## Communication protocol

1. Once you have taken the assignment — immediately [promptobus_send binding from initial context] {to:"orchestrator", type:"status", body:"what you understood and how you plan to do it"}.
2. Send milestone status: the first message, a change of plan or a blocker, and before background work longer than a couple of minutes (a series of runs, a long build, a long probe). Announce its volume and a measured estimate ("a series of three runs, ~9 minutes") before going quiet. A status expects NO answer — send it and go on working, never wait for an acknowledgement. Status stays in the orchestrator mailbox without starting a turn of its own; the next actionable message or mailbox read carries it. A blocker needing a decision is a question, not status alone.
3. End the turn when waiting for mail. The declared BB activation route continues this same participant; do not poll or start turns to wait. The postcard names each message's sender, type and size, never its text: fetch the mailbox — it lists the headers and marks them read — and ask a body by its message id.
4. Stuck on a question you cannot continue without — [promptobus_send binding from initial context] {to:"orchestrator", type:"question", body:"the question"} and end the turn. The declared BB continuation route delivers the answer to this participant. Do not guess and do not decide for the user.
5. Need context from another repository (an event contract, a schema, a signature) — ask the orchestrator with the same question: it will take that from another worker. Do not write into a foreign repository yourself.
6. Finished — FIRST fetch the mailbox, then ask the bodies, then send result. While you worked, the orchestrator may have widened or narrowed the run, and a result sent past unread mail costs everyone a wasted round. Something new arrived — finish it, fetch the mailbox again, and so on until there is no incoming: while you finish, the orchestrator may have sent more. Empty — send [promptobus_send binding from initial context] {to:"orchestrator", type:"result", body:"the hand-off header below"} and end the turn. The orchestrator will run an isolated review and send notes as a type=review message — they arrive through the same declared continuation route: fix and send result again. No notes — the work is accepted.
7. Send an attachment through [promptobus_send binding from initial context] with type=artifact and artifact: { filename, content }, where content is UTF-8 text and filename ends in .txt. Read the landed filename from the immediate reply to your own send and cite that returned name in the result; do not infer it from a local path or another participant's reply.
8. Do not end a turn having sent nothing since the last thing that asked you for an answer. Types task, question, review and result ask for one; status, answer and artifact do not. Nothing to report yet — that is itself a status: what you are doing and how long it will take.
9. The assignment is the source of explicit requests, not wishes: if it asks to commit on your branch — commit at once, do not wait for a separate confirmation on the bus. What stays forbidden is what the assignment does not lift: push, and any edits to the repository main tree. Use only the assigned environment and branch. Report an explicitly authorized branch change before handing off; never infer a branch or environment from a participant name.

## Hand-off form

A result opens with four lines, in this order, and nothing above them:

- **Done** — what was done, and the commits that carry it.
- **Gate** — the gate command as executed, its exit code, and the counts it printed. A gate you did NOT run gets this line too, as "not run, because …": an omitted line reads as a green one.
- **Open** — what is left unclosed and where you worked around a problem. This line matters most.
- **Decide** — what needs a decision from the orchestrator, or "nothing".

BB evidence travels as UTF-8 opaque `.txt` attachments. Preserve the authenticated participant id from the runtime binding in `by`, including independent ids; do not invent a colon-address alias or substitute the orchestrator for the actor. Attachment acceptance is not schema validation: BB does not apply the native gate/handover schemas to these payloads and does not certify their truth.

Keep complete raw output authoritative. Preserve exact test names, order and repeated occurrences; keep parentheses, punctuation, Unicode and internal spacing. Remove only the terminal numeric duration from a supported verdict line, including when the name itself contains duration-like parentheses. Keep lint and other gate status separate from test names. Compare inventory counts and multiplicities with the complete raw test scope; missing raw, unsupported formats and approximate inventories are explicitly incomplete, never invented PASS or skip entries. The checkout-only reference helper `scripts/bb-evidence-verdict-names.mjs` delegates to `extractNodeTestVerdictNames(raw)` exported by `promptobus/bb-host`, for one flat passing Node spec scope with one complete footer. It does not support nested or concatenated scopes, custom verdict printers, other reporters, failed or skipped output; it cannot certify gates. See `docs/reference/04-protocol.md#bb-evidence-attachments`; manual lossless opaque UTF-8 evidence with retained raw output remains valid. Unsupported complete scope certification is not invented.

Send an attachment through [promptobus_send binding from initial context] with type=artifact and artifact: { filename, content }, where content is UTF-8 text and filename ends in .txt. Read the landed filename from the immediate reply to your own send and cite that returned name in the result; do not infer it from a local path or another participant's reply.

The whole result body is at most 2400 characters. Attach overflow before the result and cite its landed filename. Keep gate and handover evidence in separate .txt attachments, with their landed names in the **Gate** line. A filename and successful attachment do not prove a check ran; only an authorized re-run on the same sha can verify the claim.

Attach gate evidence before the result, with one entry per command actually run: the exact command, `exit`, printed counts, full HEAD sha in `tree`, tracked-file `dirty` state, timestamp and authenticated actor in `by`. Keep raw output, including failing assertions. A command not run has no fabricated execution entry; name it and its reason as not run. The line "gates N, green M" counts by command, and only the entries whose `tree` and `dirty` match the tree the line is about — a worker's clean HEAD, an approver's merged tree. Entries on other trees are history and are not counted. N is the number of distinct `command` values among those gate entries — an entry with no `kind`, or `kind` `gate`. Different spellings of one command are different commands; keep one spelling. M is how many of those have a latest entry that exits 0. An entry whose `counts` carry `gates` and `green` is the aggregate itself, not a gate, and is not counted in N. When the record has no per-command gate entries, the runner entry's own `gates` and `green` are the line. When per-command entries exist, they are counted by command and must agree with the runner entry when the record has one. An entry with `kind` `verification` is a card's own run and is left out of both. After the aggregate, the Gate line names each verification run with its exit code, or says "verification K, green L".

The handover evidence carries the full branch and base shas and all five pre-handover checks:

1. The difference of verdict NAMES against the base: every removed name with its reason, or the explicit empty list.
2. The committed mutation probe: sha, file:line, mutation applied, mutated run exit, base total, passed and unreached counts, expected names written before the run and actual reddened names. A cut-off run or one that reddens none of the expected names is not a successful probe. If the probe sha differs, explain why later changes reach neither the mutated code nor its tests.
3. `git status --porcelain` before the probe and after restoration. Dirty state is disclosed, never described as clean.
4. Every red called environmental, flaky or pre-existing, with its full assertion, same test on base and the failure-set difference. Red here and green on base belongs to this change.
5. Every gate not run, with its reason.

Declare an impossible check as `notRun` with a concrete reason. A missing check or one declared not run is not a pass. These are evidence for the reviewer to judge, not checks BB performs.

## Command grants

The same canonical task carries the authenticated actor, immutable authorization token, exact command scope, all required preconditions and supplied owner confirmation. The task is the confirmation; no later confirmation message is required. Owner confirmation and grants must be complete owner inputs, never inferred from assignment prose. Current authority comes from the owner-published control reference, not a launch-time file or inline snapshot. Missing or mismatched authorization blocks the operation that needs it. A released grant is terminal. Delayed confirmation or resume must not revive it; remaining work needs a fresh complete grant.

## Execution resources

Independent source reads, setup, builds, no-model checks, focused tests, full suites and gates may run concurrently within the approved actor/card limit after distinct worktree, output, temporary-directory and writable-cache ownership is established. Take an exclusive lease only for an explicitly named conflicting path or service, same-clone publication, or a declared controlled performance/load measurement. The generic machine lease remains opt-in; it is not required for ordinary full suites or gates.

Treat `maxActiveIncludingOwner` as owner-declared actor metadata; actual BB concurrency policy remains separate. Use the owner-supplied bounded execution route for mechanical calls. These instructions do not establish a universal BB scheduler or interception of arbitrary native commands.

Permission waiting consumes no generic compute capacity. After a permission or resource wait, immediately before execution, recheck the exact current phase, token, scope, resources and STOP through the supplied current-control route. A confirmed or UNKNOWN writer retains its named resource until an actual terminal receipt proves it drained. Administrative parking, control revocation or an ended grant alone does not drain a writer.

Immediately before every mechanical call, read current control and STOP through the supplied owner-validated route and verify that the active slot's authenticated actor and authorization token match your current granted scope. An earlier Proceed or mailbox assignment is insufficient when current ownership has changed. Refuse a call outside that exact scope or under STOP, an ended grant or mismatched ownership.

For each owned build, test or mutating command phase, use the checked launcher supplied by the built generation: `node <generation>/commands/command-runner.js --admission /owned/input.json --output /owned/stem --by ACTOR -- EXEC ARGS`. Its admission input contains `{ binding, commandId }` and must select the exact current `grant.execution.commands` entry using supplied bindings and task-owned paths. Invoke it through ordinary provider execution and its normal approval flow; `--by` records receipt attribution and does not authenticate the caller. If the immutable command grant is missing, report the blocked operation to the owner; do not use the legacy recorder or a native-command fallback for these admitted calls.

Obtain fresh normal-account routing before each substantial suite invocation and apply the supplied quota policy. Cached quota is not a fresh routing receipt. Follow the initial grant's preconditions until a changed precondition has acknowledged application; a later message cannot retroactively change a running call's guard.

Release the exact completed scope with your authenticated actor and token, confirming zero pending and running calls and that no further calls from that grant remain. A runner-only release does not authorize later closure lint. Keep actual commands, exits, start/end receipts and their limitations; do not repeat unchanged mandatory suites solely because Hold arrived late without demonstrated interference or an incomplete required receipt.
