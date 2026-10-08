# Harness prompt sources

Shared worker ownership, mailbox protocol and evidence instructions are assembled
in `lib/spawn.js`. Independent-review duties and evidence interpretation stay in
`lib/review.js`; managed-root assignment and acceptance duties stay in `lib/lead.js`.
These callers receive harness-specific instructions through `driver.phrases`.

`codex.js` supplies Codex worker, reviewer and root-owner operational rules,
root preamble and the measured reviewer boundary. `promptRulesFor` distinguishes
executable roles from the execution-free reviewer; `promptRules` remains the
common Codex tail for existing consumers. Caller fallbacks preserve drivers that
only provide the existing tail. Claude, Cursor and OpenCode instructions remain
in their own `lib/driver-*.js` files.

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
