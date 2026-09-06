# PB-40 · Result

**Outcome:** completed by the orchestrator.

One sentence beside the backslop block in `AGENTS.md`: a fresh clone or worktree carries no generated adapter output until `npx github:Velklish/backslop#v0.4.0 init`, which is not tracked; run it first. The second question — whether `spawn` should run `init` itself for a repository whose `backslop.json` declares an adapter — is rejected: `init` is the repository's own step and the participant reads `AGENTS.md` before anything else, so the sentence is where the instruction belongs; a spawn that ran a tracker's command for every repository would be guessing at a tool it does not own.

Observed in run 2026-09-06b: two of three workers reported the missing file; every later worker of the run ran `init` first on the orchestrator's instruction, and the lint was green in their worktrees.
