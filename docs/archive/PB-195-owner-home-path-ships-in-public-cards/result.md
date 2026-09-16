# PB-195 · Result

**Closed 2026-09-16, completed.** The card was found in the queue with its work already in `main`: the absolute owner-home rule lives in `scripts/audit-public.mjs` (`ABSOLUTE_HOME_PATH` assembled from fragments at `:39-42`, `absoluteOwnerHomePath` at `:86`, registered among the checks at `:102`), it is active over tracked text and packed-tarball text, and it exempts five named synthetic literals in four fixtures by exact literal removal rather than by excluding a file or a surface. The eight records that carried the owner's home path — six in the archive, two live cards — are workspace-relative. The card body is written as a record of what landed; its "Work to do" section is phrased as "Keep …", not as work.

**Verification.** `npm run audit` on `main` at `578cd1c` → exit 0, "publicity audit: clean · checked 921 tracked text files and 132 packed text entries". `npx github:Velklish/backslop#v0.8.0 lint` exit 0. Implementation commits on `main`: `f72516e`, `20e6700`, `42cfa07`, plus the approver's archive cleanup `53f227b` taken into the branch as `6509463`.

**What is not closed by this.** `PB-200` — the exemption's token boundary is narrower than the detector's, so a longer path on an exempt prefix escapes. It is a separate card in the queue and keeps its own number.

**Documentation in the same pass.** Not required — the card's own pass carried `docs/reference/README.md` and CHANGELOG.
