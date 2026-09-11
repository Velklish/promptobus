# PB-88.3 · Result

**Closed 2026-09-11.** Completed. Owner decision of 2026-09-11: deny. `decideApproval` refuses any command approval — the new `item/commandExecution/requestApproval` and the legacy `execCommandApproval` — that carries `networkApprovalContext` or a non-empty `proposedNetworkPolicyAmendments`, before the containment check and before the role branch (a cwd inside the roots would otherwise let it through); the answer is the measured `{"decision":"decline"}` and the holder never sends an amendment. The regression reads the required fields of `NetworkApprovalContext` and `NetworkPolicyAmendment` from `CommandExecutionRequestApprovalParams.json`, so a re-measured schema without them turns the test red; the stand issues two identical commands, with and without the network fields, and expects `decline` then `accept`. Worker of run 0911d (`codex` track), squashed with PB-161.

**Verification.** Mutation probe: the refusal removed → 166/169 (two unit checks and one live stand check red). Gates as for PB-161.

**Documentation in the same pass.** `docs/reference/03-cli.md` § The Codex holder, CHANGELOG.
