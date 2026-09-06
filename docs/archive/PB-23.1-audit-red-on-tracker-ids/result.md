# PB-23.1 · Result

**Closed 2026-09-06.** Completed. The publicity audit was red on `main` at `906098b` because two task texts (PB-23, PB-31) cited a tracker id of the first consumer as evidence; the approver replaced the citations with "a finding in its own tracker" in `b5b110d`, and the audit is clean since. The second half — whether `docs/` belongs to the gate's surface — was decided by the approver: `docs/` is public on GitHub, so the tracker files are the surface and the gate scans them rightly; no scope change, no exception. Lesson recorded in the finding: the audit scans tracked files, so a new file is checked only after `git add`.

**Verification.** `npm run audit` on `main` after `b5b110d`: clean, 366 tracked files and the tarball; on the worker branch at `ca168dc`: clean, 368.

**Documentation in the same pass.** Not required: the gate and its surface are unchanged.
