# PB-180 · Result

**Closed 2026-09-12 by merging into `PB-185`.** Not completed as separate work: the two cards had one
cause and one unclosed fact between them.

**Why merged.** PB-180 asked where a participant's hooks belong. Its own measurement answered it —
the participant's working directory is the place, the binary names that directory in its refusal
(`Project-local config, hooks, and exec policies are disabled in the following folders until the
project is trusted … <cwd>/.codex`), and the mechanism already writes
`[projects."<realpath>"] trust_level = "trusted"` into the participant's `CODEX_HOME`. What remained
was a single number both cards stood on — `hook/started` = 0 with no `hook/*` event of any kind —
and the open question about it is enablement, which is PB-185's subject. The two cards carried the
same "Measured 2026-09-12" section word for word.

**What carried over.** PB-185 now holds PB-180's four surviving items: the write into the working
directory stays; the answer must hold for a reviewer as well as a worker; the verification is the
holder's journal and not the absence of a warning; hook trust (`PB-170`) and the `/hooks` boundary
for a person's own sessions are out of scope.

**Verification.** None claimed — no code changed. The merge is editorial; `backslop lint` on the
tree after it.
