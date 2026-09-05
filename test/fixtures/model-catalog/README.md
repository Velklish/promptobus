# Model-catalog fixtures

One file, and it is an input the shipped catalog is checked against — not a golden output. The golden pair of the routing contract lives next door in [model-routing/](../model-routing/README.md) and is a different subject: those are placeholder harnesses that pin the decision shape, these are the real ids one harness published.

| File | What it is |
|---|---|
| `cursor-models.txt` | `cursor-agent models`, ANSI stripped, exactly as the binary printed it |

## Why it is here

Cursor carries the effort level inside the model id, and **nothing validates a Cursor model id before liftoff**: `lib/driver-cursor.js` records that a bad id is refused in about two seconds with empty stdout, without opening a chat. A routed spawn on a mistyped id therefore fails silently and looks like a harness problem rather than a catalog problem.

So `model-routing-catalog.test.mjs` pins every Cursor row of `models/catalog.json` against this listing: the `model` value must appear in it verbatim as an id. A row whose id drifts — a re-point, a typo, a level suffix invented from a display name — goes red here instead of at liftoff.

The check runs in one direction only. It asserts that every id the catalog names is in this listing; it does not assert that the listing is current, because a fixture cannot know that.

## Capture

```text
cursor-agent models | sed 's/\x1b\[[0-9;]*m//g' > test/fixtures/model-catalog/cursor-models.txt
```

Captured 2026-09-05 from `cursor-agent` 2026.09.02-c22c1a3: 215 lines, `<id> - <Display Name>` after the "Available models" heading, about 210 concrete ids.

**Read the id, not the display name.** They differ, and that difference is what the check exists to survive: `claude-opus-5-thinking-high` is displayed as "Claude Opus 5 1M Thinking" with no level word in it at all, while `gpt-5.6-sol-high` is displayed as "GPT-5.6 Sol 1M High". A catalog row copied from a display name would be wrong in the first case and right in the second, and only the binary would ever say so.

The file holds model ids and display names. It carries no account name, no token and no path — `cursor-agent status`, which does print the account, is not captured here and must not be.

## Refreshing it

Recapture with the command above when the account's model line-up changes, and re-read the Cursor rows of the catalog in the same pass: an id that vanished from the listing is a rating of a model nobody can launch. Updating this file alone hides exactly the drift it is here to catch.
