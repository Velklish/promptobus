# Model routing: the catalog and overlays

The catalog is the maintainers' rating of tuples and ships inside the package. An overlay is a JSON file a person or a consumer writes to change what the catalog says — weights, ratings, allow and deny rules, the reviewer floor, the pay-as-you-go policy — without forking anything.

The decision behind all of it is [ADR-003](../adr/adr-003-model-routing.md); the command surface is [reference/03-cli.md](../reference/03-cli.md) § Model routing. This guide is the operational half: what is in the catalog file, how the layers combine, and the file to copy.

## The layers

```text
canonical catalog → host overlays, lowest to highest → CLI constraints
```

The host names the overlays and their order — `routingPaths().overlays`, lowest precedence first ([02-host](../reference/02-host.md)). The standalone host declares two:

| Layer | Standalone path | Whose it is |
|---|---|---|
| `user` | `~/.promptobus/model-routing.json` | preferences that follow the account across workspaces |
| `workspace` | `<workspaceRoot>/model-routing.local.json` | a local exception for this repository set |

A consumer that ships its own policy inserts a layer of its own between them; that is a host-side choice and needs no change here. **A missing overlay file is normal**, not an error: the host names paths, it does not promise they exist.

## What a layer may change, and how it combines

Three combining rules, and they differ on purpose.

| Field | Rule | Why |
|---|---|---|
| `weights.<strategy>` | the named set is replaced **whole** | a half-replaced set silently stops summing to 100, and the resolver would divide a component back by a weight nobody chose |
| `allow.<kind>`, `deny.<kind>` | the named list is replaced **whole**, per selector kind | a higher layer states what the rule is, rather than adding to a list it cannot see |
| everything else | field by field | naming a field is how an overlay changes it; not naming it is how it leaves the layer below alone |

"Everything else" is `penalties`, `bonuses`, `reviewerQualityFloor`, `payg.allow`, one rating of one tuple (`ratings.<tupleId>.<rating>`) and one tuple's canonical priority (`priority.<tupleId>`).

**Allow lists of different kinds hold at once.** `allow.harnesses` and `allow.models` are not alternatives: a tuple has to be named by every allow list that exists, and it is excluded by the first one that does not name it — `allow: { harnesses: ["claude"], models: ["opus"] }` admits the Claude tuples that run `opus` and nothing else. Deny is the mirror image and needs only one hit. The resolver applies allow before deny, which is the order `validate` assumes when it reports a name that is in both as a contradiction.

**A higher layer can replace a list; it cannot clear one.** The overlay schema has no empty list and no reset — `deny: {}` and `deny: { models: [] }` are both refused — and every denied name must exist, so there is no way to write "deny nothing". A layer above can therefore swap a ban for a different ban, but a ban from the layer below survives any file that does not name that selector kind. For a consumer policy layer that is the intended behaviour: its bans are meant to hold whatever a person writes in their workspace file. For a person who wants to try a model their consumer forbids, it is a wall. Whether an explicit reset belongs in the overlay schema is PB-13.3.

An overlay cannot add or remove a tuple. Rating rows are the maintainers' work and go through the catalog; a person who wants a tuple gone denies it.

The top layer is the command line. `--harness`, `--model` and `--effort` are carried through untouched — they are constraints the resolver applies, and the CLI never silently replaces a value a person named. `--allow-payg` is different: it is a policy change and is applied at this layer. It is **opt-in only**, so its absence does not undo an overlay that opted pay-as-you-go in.

## The catalog file

`models/catalog.json`, shipped through `files` in `package.json`, valid against [catalog.schema.json](../../schemas/model-routing/catalog.schema.json). One row per thing that can actually be launched: `role + harness + model + effort`.

Two things about the rows are worth knowing before reading them.

**Cursor carries effort inside the model id.** `lib/driver-cursor.js` appends `-<level>` to `--model` when it is given an effort, and the level is a flat suffix of the id — `claude-opus-5-thinking-max`, `gpt-5.6-sol-high`. So a Cursor tuple's `model` is the full id and its `effort` is `null`; the resolver must not add an effort for it, or the run would lift `…-max-max`. Claude and Codex take the level as a separate flag, and their tuples name it.

Read the id, never the display name: `cursor-agent models` prints `claude-opus-5-thinking-high` under the name "Claude Opus 5 1M Thinking", with no level word in it, while `gpt-5.6-sol-high` is printed as "GPT-5.6 Sol 1M High". Nothing checks a Cursor id before liftoff — a wrong one dies in about two seconds with empty stdout and reads as a harness fault — so the listing is captured in [test/fixtures/model-catalog/](../../test/fixtures/model-catalog/README.md) and every Cursor row is pinned against it.

**An unrated model is not a tuple.** The catalog holds only what the maintainers rated from a source they named: each rating carries `source` and `evidence`, and a rating without one is a hypothesis that stays out. A model the account exposes and the catalog does not rate never enters automatic selection — `promptobus models` shows it as an `unrated` runtime row and nothing picks it.

### Canonical priority

`priority` is the resolver's last tie-break but one, and the catalog assigns it by a convention rather than by a schema rule:

- tuples are grouped by harness, and the groups run in the order the driver registry lists them (`REGISTRY` in `lib/drivers.js`: `claude`, `cursor`, `codex`). The groups do not interleave;
- inside a group the tuples run from the highest quality down;
- numbers go in steps of ten, so a row can be inserted without renumbering its neighbours.

`validate` enforces this as a **warning**: a catalog that breaks the convention still routes, because priority only ever breaks a tie, but a drifting file should say so out loud. The two warnings are `priority-duplicate` (two tuples share a priority, so the tie-break falls through to the tuple id) and `priority-not-canonical` (a harness block starts inside the block above it, or quality rises as priority rises inside one block).

### Staleness

A rating older than 90 days produces a `stale-rating` warning and is **never** excluded. Catalog updates are event-driven — a changed model line-up, changed prices, a substantial observation — so the number is a mechanism default rather than a schedule: it is longer than a release cycle and shorter than the time in which a harness's model list turns over. It lives in one place, `STALE_RATING_DAYS` in `lib/model-routing/catalog.js`.

## The overlay to copy

Save it as `~/.promptobus/model-routing.json` (yours everywhere) or `<workspaceRoot>/model-routing.local.json` (this repository set only). Every field below is optional; keep the ones you want.

```json
{
  "schemaVersion": 1,
  "note": "personal routing preferences",
  "deny": { "models": ["gpt-5.4-mini"] },
  "weights": { "balanced": { "quality": 50, "speed": 20, "quotaCost": 15, "remaining": 15 } },
  "reviewerQualityFloor": 5,
  "ratings": { "cursor-composer-2.5": { "speed": 5 } },
  "payg": { "allow": true }
}
```

Line by line:

- `deny.models` takes one model out of automatic selection everywhere it appears. A denied candidate is still reported, with `denied-by-policy` and the layer's name, so the pick stays explainable;
- `weights.balanced` re-weights one strategy. All four numbers are required and they must sum to 100 — `validate` refuses the file otherwise;
- `reviewerQualityFloor` raises the bar for a reviewer candidate. It is a soft floor: if nothing reaches it, the best remaining candidate is chosen with a warning rather than the run refusing;
- `ratings` corrects one rating of one tuple, by tuple id, and leaves that tuple's other ratings alone;
- `payg.allow` admits pay-as-you-go tuples without `--allow-payg` on every call. The shipped catalog has no pay-as-you-go row today — every account the drivers log into is a subscription, and no price was filled in from a source that could be named — so this only matters once one appears or an overlay's own policy needs it.

## Checking a file

`promptobus models validate` reads the shipped catalog and every overlay the host names, and reports:

| Kind | What it covers |
|---|---|
| error `catalog-invalid` | the catalog's shape, duplicate tuple ids, a harness no driver of this CLI drives, an effort outside that driver's `EFFORT_LEVELS` |
| error `overlay-invalid` | an overlay's shape, a strategy whose four weights do not sum to 100, a reference to a tuple, model, harness or effort that does not exist, and a name that is both allowed and denied |
| warning | `stale-rating`, `priority-duplicate`, `priority-not-canonical` — every one of them advisory; none of them stops a run |

Every finding carries `code`, the `layer` id it belongs to, `at` — the field it is about — and `message`. `layer` names whoever last wrote the key in question: the overlay that wrote that weight set, or the overlay that wrote the deny list, and `defaults` where no overlay ever touched it. A contradiction names the deny side, because deny is applied last, and its message names the allow side too.

Warnings carry `code` and `message` and then whatever facts the caller may want without parsing prose. Those first two fields are the whole of a warning in a decision document — `warnings` in `decision.schema.json` is closed on them — so a decision copies them and translates nothing. `priority-duplicate` and `priority-not-canonical` are `validate`'s own: they check a convention rather than a routing outcome, and they never reach a decision.

The same checks are a library call in `lib/model-routing/validate.js`, so a consumer can check a policy layer it ships without starting a subprocess:

| Call | When |
|---|---|
| `validate({ host, constraints })` | the real stack: it reads the shipped catalog and every file `host.routingPaths()` names, and reports a broken file as a finding rather than a throw |
| `validateLayers({ canonical, overlays, constraints, now })` | documents already in memory: `canonical` is `{ data }`, each overlay `{ id, path, present, data }`. Pure — no filesystem, no clock beyond `now` |

Production reads no JSON Schema — the grammar is written out in that file, and a parity check against the schemas keeps the two descriptions one grammar.
