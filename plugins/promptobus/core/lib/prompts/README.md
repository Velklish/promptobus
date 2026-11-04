# Role instruction sources

`promptobus/instructions` exports six pure role renderers from compiled `roles.js` and
their TypeScript input types, maintained together in `roles.ts`. Worker ownership,
mailbox protocol, independent review, acceptance and evidence forms share this source. Native planners in
`lib/spawn.js`, `lib/review.js`, `lib/approver.js`, `lib/report.js` and `lib/lead.js`
retain state reads, snapshot construction, permission and launch planning. They
supply task context and concrete tool, environment, continuation and publication
bindings. `renderReviewProcedure` preserves the common finding-cost definitions.

`bb.ts` compiles to `bb.js` and binds those contracts to BB role skills.
Each rendered role states that
evidence of a check is the command, its exit code and the gate count, and that
a bespoke verification harness sits outside the package's own evidence recipe.
`renderBbInstructionSkill` uses
descriptive context fields; they are not usable identities or paths.
`createBbInstructionDelivery` selects one skill with a short dynamic instruction
and puts complete task, tool, environment, snapshot and gate context in an initial
prompt. Its caller must obtain authoritative participant bindings first; neither
renderer authenticates or grants a right. Long inputs may instead be supplied as
declared artifacts. Dynamic configuration text stays below BB's 4096-character
limit; role or model changes use a supported fresh session setup.

The returned configuration is SDK-compatible and selects no tools (`tools: []`).
The caller replaces that list with its authenticated, registered tool selection
before `agents.configure`; tool names in prompt context alone expose no tool.
The standing approver contract follows supplied worker contacts and assignment
authorization rather than assuming a worker is present or absent.

The BB plugin ships six generated skills. Its constrained reviewer supplies the
complete reviewer contract before the first native turn, alongside runtime
instructions, and selects that same plugin skill. This avoids requiring an
unclassified skill-read tool or truncating the long contract through dynamic
configuration. Run the plugin's `npm run skills:render` after refreshing its local
package when the source changes; `npm run skills:check` detects delivered drift.

`codex.ts` compiles to `codex.js` and supplies Codex worker, reviewer and root-owner operational rules,
root preamble and the measured reviewer boundary. `promptRulesFor` distinguishes
executable roles from the execution-free reviewer; `promptRules` remains the
common Codex tail for existing consumers. Caller fallbacks preserve drivers that
only provide the existing tail. Claude, Cursor and OpenCode instructions remain
in their own `lib/driver-*.ts` sources.

Codex instructions reuse attached persistent MCP servers, check native identity,
task and mailbox routes, and retain event-driven continuation. The attached bus
reports the registered native owner and mailbox coordinates; an independent native
context comparison is performed only when that context is supplied. Reviewers
report that limitation without trying unavailable shell or session-info tools.
A fresh root can create its first participants before participant contacts exist;
it checks a required route before communicating through it. Executable roles
check effective permissions before a known listener-dependent command and use
only supported, authorized command-level permission fields. An unavailable
permission or route is reported as blocked; the text grants no permission.
The reviewer receives bounded-read instructions and no execution guidance.

`test/prompt-sources.test.mjs` compares captured non-Codex prompts in full,
preserves shared Codex contracts and tests that a worker-only Codex source edit
changes only that prompt. Native launch, lifecycle and permission behavior remains
covered by the existing driver and managed-root tests.
`test/role-instructions.test.mjs` compares every supported native role and refusal
against the pre-extraction fixture, checks BB contracts and preserves long context.
The package test installs a fresh tarball, imports this entry and compiles an
external TypeScript consumer. The BB bridge test verifies complete instruction
delivery before the first native turn; it does not establish model compliance.
