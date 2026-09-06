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

The host names a third routing file beside the two overlays, and it is not a layer: the availability cache, `~/.promptobus/model-routing/cache.json` under standalone, mode `0600`. Nothing in it is edited by hand — it holds what the harnesses last answered, and the one command that changes it deliberately is `promptobus models --clear-exhausted <harness>`. Both overlays and the cache sit under the home directory rather than the workspace because they follow the **account** the harness binaries are logged into, not one checkout ([reference/02-host.md](../reference/02-host.md) § Model-routing paths).

## What a layer may change, and how it combines

Three combining rules, and they differ on purpose.

| Field | Rule | Why |
|---|---|---|
| `weights.<strategy>` | the named set is replaced **whole** | a half-replaced set silently stops summing to 100, and the resolver would divide a component back by a weight nobody chose. Only the four ADR-003 strategies have one: `balance` orders tuples inside a harness by `balanced`, so re-weighting `balanced` re-weights the inside of `balance` with it |
| `deny.<kind>` | the lists of every layer are **unioned** | a ban written in any layer stands, and no layer above it lifts one |
| `allow.<kind>` | the lists of every layer are **intersected** | one rule then covers both lists — a layer's rule survives every layer above it |
| everything else | field by field | naming a field is how an overlay changes it; not naming it is how it leaves the layer below alone |

"Everything else" is `penalties`, `bonuses`, `qualityFloor.<role>`, `balance.band`, `balance.spendUnit`, `payg.allow`, one rating of one tuple (`ratings.<tupleId>.<rating>`) and one tuple's canonical priority (`priority.<tupleId>`). `reviewerQualityFloor` is still read as an alias for `qualityFloor.reviewer`; a layer that states both is a `quality-floor-alias` warning and the explicit key wins.

**Allow lists of different kinds hold at once.** `allow.harnesses` and `allow.models` are not alternatives: a tuple has to be named by every allow list that exists, and it is excluded by the first one that does not name it — `allow: { harnesses: ["claude"], models: ["claude-opus-5"] }` admits the Claude tuples that run `claude-opus-5` and nothing else. Deny is the mirror image and needs only one hit. The resolver applies allow before deny.

**A ban is final from below.** [ADR-004](../adr/adr-004-subscription-balance.md) decision 5 made the deny lists accumulate: your file and a consumer's policy file both hold, whichever sits higher.

```text
// ~/.promptobus/model-routing.json    // a consumer's policy layer above it
{ "deny": { "models": ["a"] } }        { "deny": { "models": ["b"] } }
// merged: deny.models = ["a", "b"]
```

For a consumer policy layer that is the intended behaviour: its bans hold whatever a person writes. For a person who wants to try a model their consumer forbids, it is a wall, and the way through it is to change the layer that wrote the ban — `promptobus models validate` prints every deny rule in force with the layer that wrote it, which is the file to open. No allow list anywhere reaches a ban, because deny is applied after allow. Neither list can be cleared either: the overlay schema has no empty list and no reset — `deny: {}` and `deny: { models: [] }` are both refused — and every denied name must exist.

**An allow list can now be unsatisfiable.** Because allow lists intersect, two layers narrowing different ways admit nothing at all, and every tuple is denied by policy from files that both say "allow". `validate` names both layers as `allow-intersection-empty`; without that check the symptom would be an empty candidate list with no explanation.

**Two more selectors**, and they work in `allow` and `deny` alike:

- `flags` names a mark the availability snapshot carries on a model — today one, `no-zdr`. `deny: { flags: ["no-zdr"] }` takes every model the harness marks that way out of automatic selection. It is checked against a closed list, so a typo is refused rather than silently matching nothing. **A harness that lists no models has no flag to match**, so this rule gives no guarantee on such a harness — a run reports that as the `flag-not-in-inventory` warning;
- `byRole` scopes a rule to one role: `deny: { byRole: { reviewer: { harnesses: ["cursor"] } } }` is "the reviewer never runs there", and leaves the worker alone. Routing a role, its block is unioned into the deny and intersected into the allow.

An overlay cannot add or remove a tuple. Rating rows are the maintainers' work and go through the catalog; a person who wants a tuple gone denies it.

The top layer is the command line. `--harness`, `--model` and `--effort` are carried through untouched — they are constraints the resolver applies, and the CLI never silently replaces a value a person named. `--allow-payg` is different: it is a policy change and is applied at this layer. It is **opt-in only**, so its absence does not undo an overlay that opted pay-as-you-go in.

## The catalog file

`models/catalog.json`, shipped through `files` in `package.json`, valid against [catalog.schema.json](../../schemas/model-routing/catalog.schema.json). One row per thing that can actually be launched: `role + harness + model + effort`.

Two things about the rows are worth knowing before reading them.

**Cursor carries effort inside the model id.** `lib/driver-cursor.js` appends `-<level>` to `--model` when it is given an effort, and the level is a flat suffix of the id — `claude-opus-5-thinking-max`, `gpt-5.6-sol-high`. So a Cursor tuple's `model` is the full id and its `effort` is `null`; the resolver must not add an effort for it, or the run would lift `…-max-max`. Claude and Codex take the level as a separate flag, and their tuples name it.

Read the id, never the display name: `cursor-agent models` prints `claude-opus-5-thinking-high` under the name "Claude Opus 5 1M Thinking", with no level word in it, while `gpt-5.6-sol-high` is printed as "GPT-5.6 Sol 1M High". Nothing checks a Cursor id before liftoff — a wrong one dies in about two seconds with empty stdout and reads as a harness fault — so the listing is captured in [test/fixtures/model-catalog/](../../test/fixtures/model-catalog/README.md) and every Cursor row is pinned against it.

**Claude rows name a full model id, never an alias.** `claude --model` takes both — its own help says "an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')" — and the alias is the trap. A row keyed on `opus` is a rating of whatever the vendor points that alias at today: when it moves to a new model, the row keeps its `quality`, its `speed`, its `quotaCost`, its `assessedAt` and its evidence, and starts describing a model nobody assessed. Nothing goes red — the staleness warning fires on the calendar rather than on a re-point, and this harness publishes no inventory for `models validate` to compare against (no `models` subcommand, no `--list-models` on 2.1.251). So the rows name `claude-fable-5`, `claude-opus-5` and `claude-sonnet-5`, the "latest" behaviour of an alias is given up on purpose, and a new model gets a new rated row. `claude-fable-5` is the id the binary's own baked model catalog resolves `fable` to — `fable:{default:"claude-fable-5"}` beside `best:"fable"` and an empty `alias_migration`, read out of 2.1.251 offline — and its successor, Claude Fable 5.1, is deliberately unrated: the binary this driver proves cannot start it.

A pinned id is only worth pinning if the binary takes it, and there is no listing to check that against. Two of the three were **run** once, on 2.1.251 on 2026-09-05:

```text
claude -p --model claude-opus-5   --max-turns 1 'reply with the single word ok'   → ok
claude -p --model claude-sonnet-5 --max-turns 1 'reply with the single word ok'   → ok
```

**`claude-fable-5` was not run.** It was read out of the binary instead, in PB-29, and that was judged sufficient because the read answers a strictly stronger question than the turn does. A successful turn proves the binary accepted the string; the binary's own baked model catalog is where that acceptance comes FROM, and it says `fable:{default:"claude-fable-5"}` and `latest_per_family:{fable:"claude-fable-5",…}` beside an empty `alias_migration`, with an id-shape regex that admits `claude-fable-5` with an optional date or `-vN` suffix and nothing else. A turn could not have distinguished the id from a near neighbour the binary also takes; the catalog read names the exact string the alias resolves to. It also costs nothing against the plan, which matters more for the top-tier model than for the other two.

That is the check to repeat when a row is added — the offline read first, and a minimal turn only where the binary's own table cannot answer — with the method recorded in the row's `evidence`. A name the binary does not take fails at liftoff instead, where it reads as a harness fault. The set of ids the driver accepts and reports as its inventory is `MODEL_IDS` in `lib/driver-claude.js`, and the suite pins every Claude row against it.

The lift is untouched: `--model opus` is as lawful as it ever was, and the driver's own default model is still the alias. What changed is what a *rating* may be keyed on. Cursor's hazard is the opposite shape — its ids carry the level, so a row must not also name an effort — and Codex's ids come from a listing the binary answers.

**No Cursor row is offered as a reviewer today.** The reviewer floor of ADR-004 is a quality of 5, and nothing Cursor serves reaches it in the shipped catalog — the reviewer rows are Claude Code's Fable and Opus ladders and Codex's `gpt-5.6-sol` and `gpt-5.5` at `xhigh`. So ADR-003's reviewer diversity bonus has two harnesses to move between rather than three, and a review of work done on Claude Code goes to Codex or stays put. This follows from the ratings rather than from a rule about Cursor, and it changes the day a Cursor row bands 5.

**Money is not `quotaCost`.** A row carries both and they are different facts. `ratings.quotaCost` is a 1–5 judgement of how much of the *subscription* a run on that tuple spends, and it is scored on every routed pick. Money lives in `prices` (per million tokens) and `billing`, it is never scored at all, and it reaches a decision as one gate: a `billing: "payg"` row is excluded as `payg-not-allowed` unless `--allow-payg` or an overlay's `payg.allow` admits it. Every row shipped today is `billing: "subscription"` with all three prices `null`, because money per token is meaningless for a run billed against a plan. That is not the same as "no price is known": since PB-29 the vendors' published list prices ARE the basis of every `quotaCost` band, blended as `(input + output) / 2` and cited in the row's `evidence` — they are evidence for a subscription rating, not a price this package would ever charge against. Reading a low `quotaCost` as "cheap in money" is the mistake this split exists to prevent.

**An unrated model is not a tuple.** The catalog holds only models the maintainers assessed against a source they named: every row carries `source` and `evidence`, and a model nobody could assess at all gets no row.

**A hypothesis is a row that says so, not a row that is missing.** This is the part the v1 wording got wrong and PB-29 had to settle. Where no figure is published for *that exact model*, ADR-004 refuses to invent one — but it does not refuse the row: the rating is named in `evidence.hypothesis`, the reasoning behind the band is written in `evidence.text`, and the row ships. That is deliberate, because the alternative is worse: dropping the row would silently remove a model the person can actually launch, on the grounds that a leaderboard has not got round to it. Nine of the fifteen base models shipped today carry a hypothesis for `quality`, `composer-2.5` carries one for all three, and the catalog is more honest for saying so than it would be for hiding them. What `validate` refuses is narrower and sharper: a rating with **neither** a source, **nor** an interpolation from a base row that has one, **nor** a stated hypothesis.

**Since PB-29 `evidence` says which of its numbers are published and which are not.** The field takes the v1 string still, but the shipped rows use the object form ADR-004 asks for — `{ text, sources, interpolatedFrom, hypothesis }` — and `validate` reads it: for each of `quality`, `speed` and `quotaCost` the row must either cite a figure in `sources` (the benchmark or price source, its version, the agent harness where the page names one, the figure, the size of the field the band was cut from, the URL and the date it was seen), or be marked `interpolatedFrom` a base row that cites it, or name that rating in `hypothesis` — "no figure is published for this exact model, and here is the reasoning instead". A rating in none of the three is a `catalog-invalid` error. So "rated from a source" is now a machine-checkable claim rather than a promise in prose, and a reader can tell at a glance which half of a row rests on a published number. A model the account exposes and the catalog does not rate never enters automatic selection — `promptobus models` shows it as an `unrated` runtime row and nothing picks it.

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
  "deny": {
    "models": ["gpt-5.4-mini"],
    "flags": ["no-zdr"],
    "byRole": { "reviewer": { "harnesses": ["cursor"] } }
  },
  "weights": { "balanced": { "quality": 50, "speed": 20, "quotaCost": 15, "remaining": 15 } },
  "qualityFloor": { "worker": 3, "reviewer": 5 },
  "balance": { "band": 5, "spendUnit": 5 },
  "ratings": { "cursor-composer-2.5": { "speed": 5 } },
  "payg": { "allow": true }
}
```

Line by line:

- `deny.models` takes one model out of automatic selection everywhere it appears. A denied candidate is still reported, with `denied-by-policy` and the rule and every layer that wrote it, so the pick stays explainable;
- `deny.flags` takes out every model the snapshot marks that way, and `deny.byRole.reviewer` applies its block only when the reviewer is being routed;
- `weights.balanced` re-weights one strategy. All four numbers are required and they must sum to 100 — `validate` refuses the file otherwise;
- `qualityFloor` raises or lowers the bar per role — the defaults are worker 3 and reviewer 5. Both are soft floors and both are choice rules: a candidate below one keeps its place and its score, only the pick moves past it, and if nothing reaches it the best remaining candidate is chosen with a warning rather than the run refusing;
- `balance` moves the two numbers of the `balance` strategy, both in percentage points of a window: `band` is how close two accounts have to be on pace before the better-rated model wins, and `spendUnit` is how much of a window a heavy tuple gives up before harnesses are compared;
- `ratings` corrects one rating of one tuple, by tuple id, and leaves that tuple's other ratings alone;
- `payg.allow` admits pay-as-you-go tuples without `--allow-payg` on every call. The shipped catalog has no pay-as-you-go row today — every account the drivers log into is a subscription, and no price was filled in from a source that could be named — so this only matters once one appears or an overlay's own policy needs it.

## Checking a file

`promptobus models validate` reads the shipped catalog and every overlay the host names, and reports:

| Kind | What it covers |
|---|---|
| error `catalog-invalid` | the catalog's shape, duplicate tuple ids, a harness no driver of this CLI drives, an effort outside that driver's `EFFORT_LEVELS`, and a rating with nothing behind it — no source, no interpolation, no stated hypothesis — including an `interpolatedFrom` that names no tuple or names one that is itself interpolated |
| error `overlay-invalid` | an overlay's shape, a strategy whose four weights do not sum to 100, a reference to a tuple, model, harness, effort, flag or role that does not exist, a name both allowed and denied **in one layer**, allow lists that intersect to nothing (`allow-intersection-empty`) and an allow list every name of which is denied (`deny-covers-allow`) |
| warning | `stale-rating`, `priority-duplicate`, `priority-not-canonical`, `allow-shadowed-by-deny`, `quality-floor-alias` — every one of them advisory; none of them stops a run |

Every finding carries `code`, the `layer` id it belongs to, `at` — the field it is about — `message`, and `rule` where the check has a name of its own. `layer` names whoever wrote the key in question: the overlay that wrote that weight set, or the one that wrote the deny half of a pair, and `defaults` where no overlay ever touched it. A finding about allow and deny together names the deny side, because deny is applied last, and its message names the allow side too. `allow-shadowed-by-deny` is a name allowed in one layer and denied in another — lawful since ADR-004, and a warning rather than the error it was, because deny simply wins.

Warnings carry `code` and `message` and then whatever facts the caller may want without parsing prose. Those first two fields are the whole of a warning in a decision document — `warnings` in `decision.schema.json` is closed on them — so a decision copies them and translates nothing. `priority-duplicate` and `priority-not-canonical` are `validate`'s own: they check a convention rather than a routing outcome, and they never reach a decision.

The same checks are a library call in `lib/model-routing/validate.js`, so a consumer can check a policy layer it ships without starting a subprocess:

| Call | When |
|---|---|
| `validate({ host, constraints })` | the real stack: it reads the shipped catalog and every file `host.routingPaths()` names, and reports a broken file as a finding rather than a throw |
| `validateLayers({ canonical, overlays, constraints, now })` | documents already in memory: `canonical` is `{ data }`, each overlay `{ id, path, present, data }`. Pure — no filesystem, no clock beyond `now` |

Production reads no JSON Schema — the grammar is written out in that file, and a parity check against the schemas keeps the two descriptions one grammar.
