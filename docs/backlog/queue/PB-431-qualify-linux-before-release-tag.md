# PB-431 · Qualify the final release commit on Linux before publishing its tag

- **Order:** 430
- **Scope:** [Package and release contract](../../reference/01-overview.md), [Releasing](../../guides/releasing.md)
- **Created:** 2026-11-13
- **Dependencies:** PB-430
- **Cost:** major

## Context

The workflow runs the same Linux suite for pushes to main and to a release tag.
The tag is already public when its first Linux qualification fails.

Evidence: `.github/workflows/ci.yml` at
`fe2d59e89e7dbe8061a14432a0d671771cf687d2` declares both triggers.
[0.32.5 tag CI](https://github.com/Velklish/promptobus/actions/runs/42638038604)
failed on a long Unix-socket fixture path; the next
[0.32.6 tag CI](https://github.com/Velklish/promptobus/actions/runs/42652903902)
failed on the Cursor fixture HTTP handshake. For 0.32.9,
[main CI](https://github.com/Velklish/promptobus/actions/runs/42846058782) and
[tag CI](https://github.com/Velklish/promptobus/actions/runs/42846058276)
checked the same SHA in separate runs (8:45 and 8:13 elapsed).
They overlapped: eliminating a duplicate run saves runner work, not the sum of
those times from the user's release wait.

## Work to do

- Qualify the final candidate commit from PB-430 on Linux before publishing an
  annotated public release tag. Use the repository's required checks, explicit
  skip accounting and the same commit that will be tagged.
- Make publication consume the successful required CI result for that exact
  SHA and required workflow/check set. Missing, running, failed, cancelled or
  mismatched evidence blocks publication; a new SHA needs new qualification.
- Arrange triggers so the normal release path has one full Linux qualification
  for that SHA. Preserve checks for ordinary main changes and pull requests;
  an arbitrary old green run must not suppress a required new check.
- After publication, retain a smoke check that installs the actual public Git
  tag/package and verifies its version and ref. It is separate from pre-tag CI
  and must report failure rather than moving or replacing an immutable tag.
- Document candidate refs, qualification, publication, interrupted-run recovery
  and the distinction between a full-suite pass and skipped integration bodies.

## Out of scope

- Changing the distribution channel, relaxing required checks, restoring Cursor
  coverage (owned by PB-428.7), or promising a fixed release duration.
- Publishing a new version as part of implementing this task without its own
  release request.

## Verification

- Controlled workflow/publication tests cover every non-success state, missing
  required checks, a foreign SHA and a source change after qualification. All
  refuse before any public tag push; a matching successful result permits it.
- Demonstrate a candidate Linux run before tag creation and retain its SHA and
  run URL. Verify from actual run records that the normal publication path does
  not start a second identical full suite.
- Test interrupted publication and the post-publish Git installation smoke in
  disposable refs/repositories; failed smoke must preserve the published ref.
- Add a release-guide regression check and run the configured gates on the final
  implementation. A previously passed macOS suite is not Linux evidence.
