# PB-15.5 · Result

**Closed 2026-09-05.** Completed, with the entry's premise corrected by measurement: against the forking `#!/bin/sh` wrapper both adapters already answered ON the deadline (~305 ms of 300); what they did not do was release the child's stdio pipe, so a grandchild holding it kept the RUN alive 5.2 s past a verdict already written (intermittent: whether the shell has forked by the deadline is a race). Both adapters now release the pipe and the child handle beside the kill; eight runs of eight release at ~305 ms. One sentence in § Availability. Track `routing`, same worker and review round.

**Verification.** A forking-stub check in each adapter file (verdict on the deadline, no `PipeWrap` left behind by `getActiveResourcesInfo()`); probes: waiting for `close` again → red at 5.18 s; the release dropped → red on the pipe count in 2 of 3 runs (the fork race, documented in the check). Gates re-run on the merged `main` tree by the approver.

**Documentation in the same pass.** `docs/reference/03-cli.md` § Availability, `CHANGELOG.md`.
