# Questions to a Codex reporter

After `promptobus report --task <root> --harness codex`, the printed question
command reaches the existing reporter:

```sh
promptobus report --task <root> --question 'What changed, and which message records it?'
```

This starts one user turn on the reporter's existing native thread and waits up
to three minutes for that turn's answer. It prints the answer in the terminal.
It neither lifts another reporter nor resumes the thread in a different Codex
home. If the reporter is already working, the native app-server queues the new
input. Launch flags cannot be combined with `--question`. Run it from a plain
terminal: a participant bus address, inherited harness identity or resolved
MCP session record is refused before the holder receives the question.

The reporter reads the root-tree digest and names its source message ids. When
the records cannot answer, it uses `promptobus_ask` to ask the root orchestrator
as `user`. If the answer is still pending, ask the same reporter to check it
again with another `--question`; it reads later answers with `answers: true`
and the recorded question id, without consuming the user's mailbox.

Question mode preserves the reporter's private home, read-only sandbox, disabled
project hooks, canonical skills and classified external MCP write filters.
`promptobus_send` remains disabled and the bus also refuses reporter sends.
The channel only accepts a live Codex reporter bound to this active root task;
it refuses a missing, closed or mismatched session. Claude reporters keep their
existing interactive window.

See [Report](03-cli.md#report) for launch and bus permissions.
