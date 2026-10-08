The plugin adds a Codex reviewer provider that reads source files through bounded
native BB tools. It refuses shell execution, edits and unclassified external tools.

## Requirements

BB 0.45.0, Plugin SDK 0.6.15, Codex CLI 0.162.0-alpha.2 and a signed-in Codex account
are required. Execution and file reads use one local host. Each reviewer receives a
private Codex home and an empty project sandbox. Existing native providers keep
their own behavior.

## Review permissions

The provider verifies Codex read-only sandbox and no approval escalation before a
model turn. BB's Accept Edits label does not grant writes through this provider.
Four bounded file tools read the authenticated thread's environment. Canonical
external tools are withheld until classified delivery is available.

The reviewer provider alone does not establish the complete Promptobus BB role
workflow. No remote-host or full-runtime support claim is made here.
