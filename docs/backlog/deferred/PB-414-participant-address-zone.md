# PB-414 · The participant address form does not tell clone zones apart, so same-named clones collide on one address

- **Scope:** [reference/04-protocol § Addresses](../../reference/04-protocol.md#addresses), `lib/spawn.js`, `lib/review.js`
- **Created:** 2026-10-29
- **Dependencies:** none
- **Cost:** major (hypothesis)

## Context

A consumer workspace keeps clones in more than one zone, for example `repos/<group>/<name>` and `external/<name>`, and a clone's namespace path carries the zone as its first segment. A participant address does not: `<slug>` is built from the last segment of the path. Two clones with the same last segment in different zones would stand at one address, in the task journal, in `status` and in the name of the background session.

Evidence:

- Source: 2026-10-29, `lib/spawn.js:495`: `slugify(path.basename(nsPath), …)`. The worker auto-slug already takes a numeric suffix when another repository holds the address in the same task (`lib/spawn.js:497-503`); that check has not been run against two zones.
- Source: 2026-10-29, `lib/review.js:116`: with no worktree owner, the reviewer slug is `normalize(path.basename(clone.abs))`, with no suffix.
- Source: a consumer workspace's measure of 2026-09-11 and 2026-09-23: the last segments of its 99 repository clones and 3 external ones did not intersect (`comm -12` over two sorted lists printed nothing). A collision has not happened.

## Work to do

- Decide the form: flat (`reviewer:external-backslop`, safe for directory and session names) or path-like (`reviewer:external/backslop`, equal to the namespace path, but a slash would have to be checked in every directory, journal and session name).
- Decide what happens to tasks and worktrees already lifted at the old address: migrate, accept both addresses for a time, or refuse with a clear text.
- Change the address grammar and the spawn and review slug builders, and rewrite the reference to the new form.

## Out of scope

- The zone name and the shape of the namespace path, which belong to the consumer.

## Verification

- Two clones with the same last segment in different zones, in one task, get different participant addresses.
- A task lifted at the old address either migrates or is refused with a clear text; a participant is never lost silently.

## Deferred

- **Deferred:** 2026-10-29
- **Reason:** changing the slug form is a change of the participant contract with a migration of lifted tasks and worktrees, and no collision has occurred.
- **Return condition:** a clone appears whose last path segment equals another clone's in a different zone, or the address form is changed for another reason (then this is decided together with it).
