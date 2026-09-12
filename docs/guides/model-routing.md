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
| `workspace` | `<promptobusHome>/model-routing.json` | a local exception for this repository set — and the **writable** layer |

A consumer that ships its own policy inserts a layer of its own between them; that is a host-side choice and needs no change here. **A missing overlay file is normal**, not an error: the host names paths, it does not promise they exist.

**Exactly one layer is the writable one**, whenever any layer is declared, and it is the layer `promptobus models strategy --set <name>` writes `defaults.strategy` into ([reference/02-host.md](../reference/02-host.md) § The writable layer). Under standalone that is `workspace`, and it sits inside the task store rather than in the repository root because the tool rewrites it: state, not configuration, and not a file anybody commits. **`<workspaceRoot>/model-routing.local.json` is no longer read and there is no fallback** — two paths under one layer id would make the file a person edits depend on which of them exists — so rules kept in the old file have to be moved by hand.

The host names a third routing file beside the two overlays, and it is not a layer: the availability cache, `~/.promptobus/model-routing/cache.json` under standalone, mode `0600`. Nothing in it is edited by hand — it holds what the harnesses last answered, and the one command that changes it deliberately is `promptobus models --clear-exhausted <harness>`. The `user` overlay and the cache sit under the home directory rather than the workspace because they follow the **account** the harness binaries are logged into, not one checkout; the `workspace` layer is per-workspace, which is the whole of what its id says ([reference/02-host.md](../reference/02-host.md) § Model-routing paths).

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

**Claude rows name a full model id, never an alias.** `claude --model` takes both — its own help says "an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')" — and the alias is the trap. A row keyed on `opus` is a rating of whatever the vendor points that alias at today: when it moves to a new model, the row keeps its `quality`, its `speed`, its `quotaCost`, its `assessedAt` and its evidence, and starts describing a model nobody assessed. Nothing goes red — the staleness warning fires on the calendar rather than on a re-point, and this harness publishes no inventory for `models validate` to compare against (no `models` subcommand, no `--list-models`, on 2.1.251 and still on 2.1.263). So the rows name `claude-fable-5-1`, `claude-fable-5`, `claude-opus-5`, `claude-sonnet-5` and `claude-haiku-4-5`, the "latest" behaviour of an alias is given up on purpose, and a new model gets a new rated row. The 2.1.263 baked `aliases.haiku` entry points to `claude-haiku-4-5`, and its one-turn liftoff succeeded on 2026-09-09, so `haiku` is the one proven alias carried in the driver even though help omits it; `claude-mythos-5-1` was refused and remains out.

**The `fable` alias moved, and that is the rule being demonstrated rather than a problem for it.** When the Fable rows were written, the binary's baked catalog said `fable:{default:"claude-fable-5"}` beside `best:"fable"` and an empty `alias_migration` (2.1.251, read offline). On 2.1.263 it says `fable:{default:"claude-fable-5-1",per_provider:{gateway:"claude-fable-5"}}` and `latest_per_family.fable:"claude-fable-5-1"`, with `alias_migration` still empty. Under a row keyed on `fable`, that one edit in someone else's binary would silently have re-pointed a rating assessed against Fable 5's 95.0 % at a model nobody had assessed, keeping the `assessedAt` date that says otherwise. Under id-keyed rows, **nothing happened**: the `claude-fable-5` rows go on meaning Fable 5, and Fable 5.1 got rows of its own (PB-34) with its own evidence, its own hypothesis and its own date.

**Both Fable ladders ship, because the binary still starts both.** The decision was a read rather than a courtesy: 2.1.263's baked table holds `claude-fable-5` and `claude-fable-5-1` as separate first-party rows of `family:"fable"` — `display_name` "Fable 5" and "Fable 5.1", knowledge cutoffs January 2026 and June 2026 — both are in the binary's own array of accepted ids, `alias_migration` is empty so nothing is rewritten, and Fable 5.1's row names `fallback_3p:"claude-fable-5"`, the vendor's own statement that the predecessor is still served. A rated row is dropped when the vendor stops serving the model, which is a fact to be read out of that table; an alias moving off an id is not that fact. What the two ladders differ on is only what is published about them — Fable 5's `quality` cites a SWE-bench Verified figure, Fable 5.1's states a hypothesis, and the row says which.

A pinned id is only worth pinning if the binary takes it, and there is no listing to check that against. Two of the original three families were **run** once, on 2.1.251 on 2026-09-05; Haiku and Mythos were checked on 2.1.263 on 2026-09-09:

```text
claude -p --model claude-opus-5   --max-turns 1 'reply with the single word ok'   → ok
claude -p --model claude-sonnet-5 --max-turns 1 'reply with the single word ok'   → ok
claude -p --model claude-haiku-4-5 --max-turns 1 'reply with the single word ok'   → ok
claude -p --model claude-mythos-5-1 --max-turns 1 'reply with the single word ok'   → refused: "There's an issue with the selected model (claude-mythos-5-1). It may not exist or you may not have access to it."
```

The Mythos refusal is account-dependent: that message is the only evidence separating no access on this account from no such id.

**Neither Fable id was run.** Both were read out of the binary instead — `claude-fable-5` in PB-29 off 2.1.251, `claude-fable-5-1` in PB-34 off 2.1.263 — and that was judged sufficient because the read answers a strictly stronger question than the turn does. A successful turn proves the binary accepted the string; the binary's own baked model catalog is where that acceptance comes FROM. On 2.1.263 it names both ids as first-party rows of `family:"fable"` and lists both in its array of accepted ids, and `alias_migration` is empty. A turn could not have distinguished either id from a near neighbour the binary also takes; the catalog read names the exact strings. It also costs nothing against the plan, which matters more for the top-tier family than for the other two.

That is the check to repeat when a row is added — the offline read first, and a minimal turn only where the binary's own table cannot answer — with the method recorded in the row's `evidence`. A name the binary does not take fails at liftoff instead, where it reads as a harness fault. The set of ids the driver accepts and reports as its inventory is `MODEL_IDS` in `lib/driver-claude.js`, and the suite pins every Claude row against it.

The lift is untouched: `--model opus` is as lawful as it ever was, and the driver's own default model is still the alias. What changed is what a *rating* may be keyed on. Cursor's hazard is the opposite shape — its ids carry the level, so a row must not also name an effort — and Codex's ids come from a listing the binary answers.

**All three harnesses now offer a reviewer.** The reviewer floor is a quality of 9 on the ten-point scale ([ADR-005](../adr/adr-005-ten-point-scale-absolute-bands-calibrate.md)), and thirteen rows reach it: Claude Code's Fable and Opus ladders at `high`, `xhigh` and `max`, Codex's `gpt-5.6-sol` at `xhigh`, `max` and `ultra`, and Cursor's `kimi-k3` at `max`, whose SWE-bench Verified 93.4 bands 9. Under the old 1–5 relative ranks no Cursor row cleared the floor at all; that was a property of a five-step scale over a narrow field rather than a rule about Cursor, and it is exactly what absolute bands were meant to fix. So ADR-003's reviewer diversity bonus now has three harnesses to move between, and a review of work done on Claude Code has somewhere to go under every strategy.

**Upward interpolation never makes a rung a reviewer.** An effort step raises the interpolated `quality` by one band, so a rung above its base row can cross the reviewer floor on arithmetic alone — an unmeasured rung claiming a role its measured base never earned. So a tuple is offered as `reviewer` only when its own rating AND its **base row's** assessed rating are at the floor. `codex-gpt55-xhigh` is the live case: it interpolates to quality 10 from a base row assessed at 8, and it is a worker row. `models validate` refuses a catalog that says otherwise.

**Money is not `quotaCost`.** A row carries both and they are different facts. `ratings.quotaCost` is a 1–10 band of how much of the *subscription* a run on that tuple spends, and it is scored on every routed pick. Money lives in `prices` (per million tokens) and `billing`, it is never scored at all, and it reaches a decision as one gate: a `billing: "payg"` row is excluded as `payg-not-allowed` unless `--allow-payg` or an overlay's `payg.allow` admits it. Every row shipped today is `billing: "subscription"` with all three prices `null`, because money per token is meaningless for a run billed against a plan. That is not the same as "no price is known": since PB-29 the vendors' published **list** prices ARE the basis of every `quotaCost` band, blended as `(input + output) / 2`, banded against the dated $2.50 → 1 / $30 → 10 anchor pair and cited in the row's `evidence`. A promotional price never moves the anchor — it applies to the model's own figure while the cited promotion is in force, and the row's `evidence` names the list price, the promotion and the band the list price would give, so the row is re-banded the day the promotion ends — they are evidence for a subscription rating, not a price this package would ever charge against. Reading a low `quotaCost` as "cheap in money" is the mistake this split exists to prevent.

**An unrated model is not a tuple.** The catalog holds only models the maintainers assessed against a source they named: every row carries `source` and `evidence`, and a model nobody could assess at all gets no row.

**A hypothesis is a row that says so, not a row that is missing.** This is the part the v1 wording got wrong and PB-29 had to settle. Where no figure is published for *that exact model*, ADR-004 refuses to invent one — but it does not refuse the row: the rating is named in `evidence.hypothesis`, the reasoning behind the band is written in `evidence.text`, and the row ships. That is deliberate, because the alternative is worse: dropping the row would silently remove a model the person can actually launch, on the grounds that a leaderboard has not got round to it. Ten of the seventeen base models shipped today carry a hypothesis for `quality`, `composer-2.5` carries one for all three, and the catalog is more honest for saying so than it would be for hiding them. What `validate` refuses is narrower and sharper: a rating with **neither** a source, **nor** an interpolation from a base row that has one, **nor** a stated hypothesis.

**Since PB-29 `evidence` says which of its numbers are published and which are not.** The field takes the v1 string still, but the shipped rows use the object form ADR-004 asks for — `{ text, sources, interpolatedFrom, hypothesis }` — and `validate` reads it: for each of `quality`, `speed` and `quotaCost` the row must either cite a figure in `sources` (the benchmark or price source, its version, the agent harness where the page names one, the figure, the size of the field the band was cut from, the URL and the date it was seen), or be marked `interpolatedFrom` a base row that cites it, or name that rating in `hypothesis` — "no figure is published for this exact model, and here is the reasoning instead". A rating in none of the three is a `catalog-invalid` error. So "rated from a source" is now a machine-checkable claim rather than a promise in prose, and a reader can tell at a glance which half of a row rests on a published number. A model the account exposes and the catalog does not rate never enters automatic selection — `promptobus models` shows it as an `unrated` runtime row and nothing picks it.

### Canonical priority

`priority` is the resolver's last tie-break but one, and the catalog assigns it by a convention rather than by a schema rule:

- tuples are grouped by harness, and the groups run in the order the driver registry lists them (`REGISTRY` in `lib/drivers.js`: `claude`, `cursor`, `codex`). The groups do not interleave;
- inside a group the tuples run from the highest quality down;
- numbers go in steps of ten, so a row can be inserted without renumbering its neighbours.

`validate` enforces this as a **warning**: a catalog that breaks the convention still routes, because priority only ever breaks a tie, but a drifting file should say so out loud. The two warnings are `priority-duplicate` (two tuples share a priority, so the tie-break falls through to the tuple id) and `priority-not-canonical` (a harness block starts inside the block above it, or quality rises as priority rises inside one block).

### Re-rating a row

A rating is a **band**: an integer from 1 through 10, produced from one published figure and the dated anchor pair of its benchmark, version and agent harness. It reads no field, so adding or removing a model moves no other model's band. Four steps, and the fourth is what makes the third checkable:

1. **Find the figure, with its version and its harness.** A number without both is not a figure ([ADR-005](../adr/adr-005-ten-point-scale-absolute-bands-calibrate.md)): the same Grok 4.6 was reported at 88.4 on Terminal-Bench 2.1 and 26 on 3.0, and Claude Fable 5 scores 83.8 under Claude Code and 80.4 under Terminus 2 on one version. Where several figures exist, take the harness this catalog runs the model on; where none does, take the highest published one and say in `evidence.text` that this fallback was used. The source order is ADR-004's and is unchanged: SWE-bench Verified, then Terminal-Bench, then Aider polyglot, then the vendor model card.
2. **Pick the anchor pair** for exactly that source, version and harness from the table in ADR-005 § Absolute bands. If that source, version or harness has no pair, do not compute a band from it or reuse another version's pair: keep the rating as a hypothesis against measured neighbours, name the reasoning in `evidence.hypothesis` and `evidence.text`, and add the anchor through a dated ADR/catalog-wide decision first. Adding one re-bands the whole catalog.
   **Even when the pair exists:** under the successor rule, a successor is the next vendor version in the same model family and its predecessor is the previous version. If the successor's figure differs in benchmark, version or agent harness from the source triple on which the predecessor's band rests, the computed band cannot demote the successor below the predecessor when the vendor's published head-to-heads put the successor ahead on every comparison. The predecessor's band means the corresponding effort rung. Record the figure and its computed band in `evidence.text`, not in `evidence.sources`: a rating named in `evidence.hypothesis` cannot also carry a citation, and `validate` rejects that row. Keep the successor rating as a hypothesis at the corresponding predecessor-rung band until a figure for the successor is published from the source triple on which the predecessor's band rests; then apply steps 1–2 normally.
3. **Compute the band**: `clamp(1 + roundHalfUp((figure − floor) / (ceiling − floor) × 9), 1, 10)`, rounding half up. SWE-bench Verified under 60 → 1 and 96 → 10: 96.0 → 10, 95.0 → 10, 93.4 → 9, 85.2 → 7, 80.6 → 6, 78.7 → 6.
4. **Cite it in the row.** `evidence.sources` gets the figure with its `basis`, `version`, `agentHarness`, `provenance`, `url` and `date`; a promotional figure also carries `validUntil`, `listFigure` and `listBand`. When the vendor publishes an end date, `validUntil` is that date. When no end date is published, it is the last date the promotion was observed in force; `promotion-expired` then reminds maintainers to re-verify or re-band. Without either date, the promotional figure is not cited. `evidence.text` names the anchor pair the band came from, in the row's own words — `quotaCost uses blended list price $2.50→1 / $30→10: $15→5`. `validate` refuses a rating with neither a citation, an interpolation from a base row that has one, nor a stated hypothesis, so step 4 is not paperwork: skip it and the catalog stops loading.

**No published figure is still a rating, not a gap.** Name it in `evidence.hypothesis`, place it against the neighbours that DO have figures, and write the placement reasoning in `evidence.text`. What is never done is a mechanical translation: a band on the old 1–5 scale does not become a band on this one by `× 2 − 1`, because the two scales were cut from different things.

**Effort rungs are arithmetic from the base row**, and only two of the three ratings move: `quality = clamp(base + steps, 1, 10)` and `quotaCost = clamp(base + steps, 1, 10)`, while `speed` is the base row's unchanged. Throughput belongs to the model and its serving stack, not to how hard it is thinking; the extra output tokens of a deeper effort are the `quotaCost` step. One band per step and not two: a two-band step spans eight bands over a five-rung ladder, so both ends run into the clamp and a top-tier model's low rung ends up in the same band as the cheapest model in the catalog. Rungs that clamp to the same three ratings all stay — the effort is still a launchable choice — and `models validate` says so with `ladder-indistinguishable`.

**A local run can argue with a band.** `promptobus models calibrate` reads the telemetry of this machine and proposes `speed` and `quotaCost` lines for the user overlay, with the medians behind each and the catalog band beside it; `--write` merges them after you agree. Speed evidence is pooled by `(harness, model)` across the effort ladder, so one speed proposal applies to every rung; it comes from usable output throughput, never completion duration. A model with no usable throughput gets no speed proposal. The command proposes and never applies, and it never proposes `quality` — see [reference/03-cli.md](../reference/03-cli.md) § Commands.

### Staleness

A rating older than 90 days produces a `stale-rating` warning and is **never** excluded. Catalog updates are event-driven — a changed model line-up, changed prices, a substantial observation — so the number is a mechanism default rather than a schedule: it is longer than a release cycle and shorter than the time in which a harness's model list turns over. It lives in one place, `STALE_RATING_DAYS` in `lib/model-routing/catalog.js`.

## The overlay to copy

Save it as `~/.promptobus/model-routing.json` (yours everywhere) or `<promptobusHome>/model-routing.json` (this repository set only — the writable layer, so `models strategy --set` edits that file in place around whatever you put in it). Every field below is optional; keep the ones you want.

```json
{
  "schemaVersion": 2,
  "note": "personal routing preferences",
  "deny": {
    "models": ["gpt-5.4-mini"],
    "flags": ["no-zdr"],
    "byRole": { "reviewer": { "harnesses": ["cursor"] } }
  },
  "weights": { "balanced": { "quality": 50, "speed": 20, "quotaCost": 15, "remaining": 15 } },
  "qualityFloor": { "worker": 5, "reviewer": 9 },
  "balance": { "band": 5, "spendUnit": 5 },
  "nearLimit": { "usedPercent": 80, "underspend": -15 },
  "caps": { "liveParticipants": { "codex": 2 } },
  "defaults": { "strategy": "balance" },
  "account": { "cursor": { "plan": "example-ultra" } },
  "ratings": { "cursor-composer-2.5": { "speed": 9 } },
  "payg": { "allow": true }
}
```

Line by line:

- `deny.models` takes one model out of automatic selection everywhere it appears. A denied candidate is still reported, with `denied-by-policy` and the rule and every layer that wrote it, so the pick stays explainable;
- `deny.flags` takes out every model the snapshot marks that way, and `deny.byRole.reviewer` applies its block only when the reviewer is being routed;
- `weights.balanced` re-weights one strategy. All four numbers are required and they must sum to 100 — `validate` refuses the file otherwise;
- `qualityFloor` raises or lowers the bar per role — the defaults are worker 5 and reviewer 9 on the 1–10 scale. Both are soft floors and both are choice rules: a candidate below one keeps its place and its score, only the pick moves past it, and if nothing reaches it the best remaining candidate is chosen with a warning rather than the run refusing;
- `balance` moves the two numbers of the `balance` strategy, both in percentage points of a window: `band` is how close two accounts have to be on pace before the better-rated model wins, and `spendUnit` is how much of a window a heavy tuple gives up before harnesses are compared;
- `nearLimit` moves when `models` says an account is running short — `usedPercent` (80) is a level, how much of the binding window is gone; `underspend` (−15 points) is a rate, how far ahead of its own pace the account is spending. Either one raises the line;
- `caps.liveParticipants.<harness>` is how many participants of **one task** may be live on a harness at once, and under `balance` a harness that has reached its ceiling leaves the pace comparison — the next worker goes to another subscription. Per harness, because your three subscriptions have different capacities. It bounds **one run and not the account**: the count is that task's own participant list, so two tasks going side by side each count their own. Counted in **participants** — the similarly named `penalties.liveParticipantCap` is a ceiling on the live-participant *penalty*, in score points, and the two do different jobs. It is a **ceiling and not a steeper penalty**: `penalties.liveParticipantPerHarness` only orders candidates inside a harness, so an account whose window is ahead of the others would otherwise attract the third and the fourth worker too. `0` means never this harness; a harness you do not name is unbounded, which is how every run behaved before the key existed. When the ceiling moves the pick, the decision and the `spawn` line carry a `live-participant-cap` warning naming it;
- `defaults.strategy` is what `spawn` and `review` route with when `--strategy` is absent. It is the one key a command writes: `promptobus models strategy --set <name>` puts it in the writable layer, `--clear` takes it away, and a flag on the command line always wins over it;
- `account.<harness>.plan` is a person's answer to a question no harness method returns — today one, Cursor's plan name, and it belongs in the **user** file. **Nothing writes it**: `models` prints the key and the path, and you add the line. It is displayed and scored by nothing;
- `ratings` corrects one rating of one tuple, by tuple id, and leaves that tuple's other ratings alone. Every value is an integer from 1 through 10, and an overlay that carries a `ratings` block **must** declare `schemaVersion: 2`: a block written on the old 1–5 scale is refused by the load and by `models validate` with the route *rewrite `ratings` on the 1–10 scale and set `schemaVersion: 2`*, because a 3 was a middle of five and is a low third of ten and nothing may translate it silently. The two quality-floor keys are on the same scale and are refused the same way: `reviewerQualityFloor: 5` was the top band of five and is half way up ten, so a v1 file holding one would quietly lower your reviewer floor from 9 to 5. An overlay carrying none of the three — a deny list, a strategy default, an account answer, weights — is still read on `schemaVersion: 1`, unchanged. `models calibrate --write` is the one command that writes this block, and only after you agree to the exact lines it printed;
- `payg.allow` admits pay-as-you-go tuples without `--allow-payg` on every call. The shipped catalog has no pay-as-you-go row today — every account the drivers log into is a subscription, and no price was filled in from a source that could be named — so this only matters once one appears or an overlay's own policy needs it.

## Checking a file

`promptobus models validate` reads the shipped catalog and every overlay the host names, and reports:

| Kind | What it covers |
|---|---|
| error `catalog-invalid` | the catalog's shape, duplicate tuple ids, a harness no driver of this CLI drives, an effort outside that driver's `EFFORT_LEVELS`, and a rating with nothing behind it — no source, no interpolation, no stated hypothesis — including an `interpolatedFrom` that names no tuple or names one that is itself interpolated |
| error `overlay-invalid` | an overlay's shape, a strategy whose four weights do not sum to 100, a reference to a tuple, model, harness, effort, flag or role that does not exist, a name both allowed and denied **in one layer**, allow lists that intersect to nothing (`allow-intersection-empty`) and an allow list every name of which is denied (`deny-covers-allow`) |
| warning | `stale-rating`, `priority-duplicate`, `priority-not-canonical`, `promotion-expired`, `allow-shadowed-by-deny`, `quality-floor-alias` — every one of them advisory; `promotion-expired` is validate-only, and none of them stops a run |

Every finding carries `code`, the `layer` id it belongs to, `at` — the field it is about — `message`, and `rule` where the check has a name of its own. `layer` names whoever wrote the key in question: the overlay that wrote that weight set, or the one that wrote the deny half of a pair, and `defaults` where no overlay ever touched it. A finding about allow and deny together names the deny side, because deny is applied last, and its message names the allow side too. `allow-shadowed-by-deny` is a name allowed in one layer and denied in another — lawful since ADR-004, and a warning rather than the error it was, because deny simply wins.

Warnings carry `code` and `message` and then whatever facts the caller may want without parsing prose. Those first two fields are the whole of a warning in a decision document — `warnings` in `decision.schema.json` is closed on them — so a decision copies them and translates nothing. `priority-duplicate` and `priority-not-canonical` are `validate`'s own: they check a convention rather than a routing outcome, and they never reach a decision. `promotion-expired` is also validate-only: it names a quota-cost promotion whose last observed date passed, and never reaches a decision.

The same checks are a library call in `lib/model-routing/validate.js`, so a consumer can check a policy layer it ships without starting a subprocess:

| Call | When |
|---|---|
| `validate({ host, constraints })` | the real stack: it reads the shipped catalog and every file `host.routingPaths()` names, and reports a broken file as a finding rather than a throw |
| `validateLayers({ canonical, overlays, constraints, now })` | documents already in memory: `canonical` is `{ data }`, each overlay `{ id, path, present, data }`. Pure — no filesystem, no clock beyond `now` |

Production reads no JSON Schema — the grammar is written out in that file, and a parity check against the schemas keeps the two descriptions one grammar.

## Adapters, telemetry and calibrate: what each file does and what was measured

Moved here from the file headers in `lib/model-routing/`. Each subsection is the whole of what stood above the code; the files now carry a two-line pointer to it.

### Claude Code adapter: what the probe reads

Source: `lib/model-routing/adapter-claude.js`.

Claude Code availability adapter: what the account can do with the `claude`
binary on this machine, right now. The verdict shape and the rules it answers
under are the contract ([model-routing.ts](../../src/model-routing.ts)); this
file is only the harness half of it.

The whole probe is TWO reads and no turn. Binary and version come from the host
(`resolveToolBin`) — ADR-003 says an adapter reports `binary_missing` from its
verdict rather than searching `PATH` itself — and auth comes from `claude auth
status --json`, the one non-interactive check the binary offers today.
Measured 2026-09-05 on `claude` 2.1.251: three runs, 0.86 / 1.17 / 1.36 s wall,
exit 0, a JSON object whose `loggedIn` boolean is what is read below.

**The auth check is spawned asynchronously, and that is not a style choice.**
The preflight runs the adapters together and holds ONE budget beside them, as a
timer racing their promises. A `spawnSync` here would block the event loop for
its whole run, so that timer could not fire while this adapter worked and each
blocking adapter would get the full budget again after its neighbours — the
ceiling of the run would become their sum, which is the opposite of what
`timeoutMs` promises. So: `spawn`, a deadline taken as the first line of the
probe, and a kill of our own when it passes. The suite watches this with a
check that a timer scheduled beside the probe still fires while it runs.

**Nothing here runs `claude` with a bare word.** An unrecognised word after the
binary name is not an unknown subcommand — it is taken as a PROMPT, and a probe
that guessed at one would start a paid turn on the person's plan. So the argv is
a subcommand `claude --help` lists with flags `claude auth status --help` lists,
and a probe that wants a new fact reads those helps first.

**The inventory is not a listing.** The binary publishes no model list at all:
no `models` subcommand and no `--list-models` (measured 2026-09-05 by the
catalog track on the same build). The only names it publishes are the `--model`
aliases in its help text, so the inventory reported here is the driver's own
alias set, handed in by the driver — which owns it next to the default model it
lifts participants on. That is why the models arrive as an argument instead of
being imported: the driver is private to the registry, and a module of the
mechanism reaching into it is exactly the crossing the boundary gate refuses
([promptobus-adapter.test.mjs](../../test/promptobus-adapter.test.mjs)).

**Where the tier and the windows come from, measured 2026-09-06 on 2.1.251.**
ADR-003 recorded an assumption — this harness exposes no remaining limit — and
[ADR-004](../adr/adr-004-subscription-balance.md) supersedes it: the
source Claude Code's own `/usage` command reads is reachable with the
credentials the CLI already holds, and costs no turn.

  • **the tier is offline.** The credential record — a keychain generic
    password on macOS, `~/.claude/.credentials.json` elsewhere — carries
    `rateLimitTier` beside the token, so `{ name, source: 'credentials' }` needs
    no request at all. `/api/oauth/profile` is asked for it ONLY when the record
    names none, and then the source is `probe`;
  • **the windows are one GET.** `/api/oauth/usage` answers `limits[]`, whose
    rows are `session`, `weekly_all` and `weekly_scoped` — the last one a
    per-model weekly row that names its model by DISPLAY name. The lengths are
    the kinds' own (five hours, seven days) and `percent` is the used share.

So `available` is reachable now, and the word keeps its meaning: auth, model AND
limit confirmed. A logged-in account whose limit could not be read is still
`unknown` / `quota_unknown`, which the resolver penalises by ten points instead
of dropping the harness.

**The token is read, used once as a header, and never written or refreshed.**
`refreshToken` is not even parsed out of the record — `credentialRecord` below
picks three fields and no more — and a token past its `expiresAt` answers
`quota_unknown` with the tier still
reported — never a refresh, because refreshing rotates the person's credentials
under Claude Code's feet. Nothing token-shaped reaches a verdict, a message or
the cache.

**The keychain read and the HTTP call arrive as parameters**, the way the Codex
adapter takes its launch context: `claudeAvailability` defaults them to the live
implementations, and the suite hands in its own — so no test touches the network
or the person's keychain, and the seam is the same one the binaries already use.

What of the auth answer reaches the verdict is ONE boolean. The same JSON also
carries an email address, an organisation id and its name, and none of them may
travel: `message` is the only free-text field that reaches disk, and the cache
promises to hold no email and no open account id.

### Cursor adapter: what the probe reads

Source: `lib/model-routing/adapter-cursor.js`.

Cursor availability adapter: what the locally logged-in Cursor account can do
right now. The driver ([driver-cursor.js](../../lib/driver-cursor.js)) declares it as
`availability`, the preflight ([preflight.js](../../lib/model-routing/preflight.js)) runs it, and the
verdict it answers is one harness entry of the availability snapshot.

Two binary calls and nothing else: `status` for auth, `models` for the
inventory. Neither starts a session, neither writes, and neither touches the
availability cache — the cache is read and written around this module.
Everything about a RUNNING Cursor participant — the tmux pane, `persist`, the
transcript — lives one floor below in [cursor-persist.js](../../lib/cursor-persist.js)
and is none of this file's business: an adapter answers about the ACCOUNT,
before any session exists.

**The quota source is not the binary — it is the dashboard's own call.** The
binary names no limit, and ADR-003 recorded that as "Cursor exposes none".
[ADR-004](../adr/adr-004-subscription-balance.md) supersedes the
assumption on a spike of 2026-09-06: `POST <backendUrl>/aiserver.v1.DashboardService/GetCurrentPeriodUsage`
answers the account's billing cycle with the CLI's own token, and costs no turn.
So a successful probe is `available` now — auth, model AND limit confirmed — and
every path where the limit could not be read is still `unknown` /
`quota_unknown`, which the resolver penalises rather than blocks.

**One cycle, two pools, and that is the shape the harness has.** The answer
carries ONE window — `billingCycleStart` to `billingCycleEnd` — and two
percentages inside it: `autoPercentUsed` for Cursor's own models, which the
answer lists in `autoBucketModels`, and `apiPercentUsed` for named third-party
models. ADR-004 writes that as two windows of the same length with a pool
scope each: the `auto` pool names the ids it covers, and the `api` pool names
none because it is the complement and a list of everything else is not a fact
any harness stated.

**`autoBucketModels` is not the only place Cursor says which pool a model is
billed to, and it is not the current one.** Measured on the owner's account on
2026-09-06: one turn on `cursor-grok-4.6-medium` moved `autoPercentUsed` and
not `apiPercentUsed`, while the bucket list named `grok-4.5` and no `grok-4.6`
before or after. `POST <backendUrl>/aiserver.v1.DashboardService/GetAggregatedUsageEvents`
states the same thing per model — `tier: 2` is the Auto bucket, `tier: 1` the
api pool — for every model with an event this cycle, so the `auto` scope is the
UNION of the two, and a model with neither a row nor a bucket entry stays in
`api`. That third call is optional in the way the policy call is: without it
the bucket list is the whole answer, which is what this adapter did before —
though a live hang on it drains the shared budget and costs the policy call's
note as well.

**The token is read and never written.** `cursor-access-token` in the keychain
FIRST — that is the credential the spike measured this call answering — and
`CURSOR_API_KEY` in the environment only as a fallback, because nothing
measured says DashboardService accepts an API key at all. Which of the two was
used travels with the token, and it decides what a refusal means.
`cursor-refresh-token` is never asked for. `~/.cursor/cli-config.json` is read for ONE field, the backend URL — the
same file carries the account's address and ids, and nothing here parses them.
The token reaches one `Authorization` header and no verdict, message or cache
file.

**The keychain read and the POSTs arrive as parameters**, the way the Codex
adapter takes its launch context: `cursorAvailability` defaults them to the live
implementations, and the suite hands in its own, so no test touches the network
or the person's keychain.

Both commands print ANSI colour even when stdout is not a terminal (measured
2026-09-05 on `cursor-agent` 2026.09.02-c22c1a3), so everything is stripped
before it is looked at.

**Nothing read here reaches `message`.** `status` prints the account address
on success; the adapter counts and classifies, and writes its own diagnosis.
The verdict `message` is the only free-text field that reaches the cache file.

### Codex adapter: what the probe reads

Source: `lib/model-routing/adapter-codex.js`.

Codex availability adapter: what the account can do with `codex` right now,
answered from a fresh `codex app-server --stdio` that is closed again without a
thread and without a turn.

**Why a second gate at all.** The start path in [codex-session.js](../../lib/codex-session.js)
already refuses a lift on a spent limit, but it refuses INSIDE the lift, after
the holder process, the socket and the thread are being set up. The resolver
needs the same fact BEFORE it picks a harness, and it must be able to ask about
three harnesses at once for less than the price of one lift. So the two gates
stay two, and what they share is the reading of the protocol
(`rateLimitReached`, `listedModels`), not a copy of it.

**Where the limit comes from, measured on codex-cli 0.146.0.** The
`account/rateLimits/updated` notification the start path waits for does NOT
arrive after `initialize` alone — waits of 10 s and 30 s on a live account saw
only `remoteControl/status/changed`. It is a request that answers:
`account/rateLimits/read` is in the binary's own method list and replies at once
with the same snapshot. So the request is the source, and the bounded wait for
the notification stays as the path for a binary that does not have the method —
the shape the brief for this task described, kept where it still applies.

**Two neighbouring methods this file must never call.** `getAuthStatus` answers
`{ authMethod, authToken, requiresOpenaiAuth }` — it would be a crisper auth
signal and it hands back a TOKEN, and this module's `message` is the one free
text that reaches disk. `account/read` answers the account E-MAIL beside the
plan. The verdict is built from limits and model names, and neither of those
two is asked.

**That rule survived PB-28, and it is why the tier is read where it is.** The
task's text names `account/read` as the source of `planType` — but the same
field is already inside the answer to `account/rateLimits/read`, which this
probe makes anyway (measured on codex-cli 0.146.0, and the spike document has
the shape). So the tier is taken from the call already being made, and the call
that would hand over an address is still not made at all: one fewer request,
one fewer thing that could put an identity in front of a module whose whole job
is to keep one off the disk. A snapshot that names no `planType` reports no
tier, which is what "the harness names no plan" means.

**Stderr is not a channel here.** app-server writes
`ERROR codex_models_manager::cache: failed to load models cache: missing field
'base_instructions'` on a perfectly good run, so a probe that read stderr as a
verdict would call a working account broken. The child gets no stderr pipe at
all: what is not connected cannot be misread.

### Participant telemetry: the collecting half

Source: `lib/model-routing/telemetry.js`.

Participant telemetry: one JSON Lines record per routed participant, appended
when `promptobus done` closes the task.

**What it is for.** The catalog's ratings come from published benchmarks, and
two frontier models a point apart on one leaderboard share a band; nothing in
the tool learns from what actually happens on this machine. This file is the
collecting half — a record that ties together what the bus already knows about
one participant when its run is over: the tuple it was routed to, the strategy
that chose it, how long it lived, any harness-reported output throughput, how
many review rounds it took, and how much of the account's own limit windows
moved while it worked. The READING half — a finer scale, absolute bands,
`models calibrate` — is not here: nothing in this file scores, compares or
proposes anything.

**This file is the second disk boundary of routing, and it obeys the first
one's rules** ([cache.js](../../lib/model-routing/cache.js)). It writes into the same account-scoped
directory, mode `0600`, and it PROJECTS field by field onto a closed shape
(`schemas/model-routing/telemetry.schema.json`) rather than spreading anything
it was handed. That matters more here than in the cache: the source is not an
adapter's verdict but a participant record and a task journal, and those hold
a repository path, a worktree, a session ref, a branch name and every message
body of the run. None of them is a field below, and a record carrying one
stops validating.

The only identifier is `task`: an opaque local key, not the id. It exists so
PB-37 can tell records of one run from records of another, and the slug a
person typed does not travel. It is a truncated SHA-256 with no salt — stable
across installs of one account, which is what makes the grouping work, and
therefore NOT a claim that the id cannot be guessed back: a task id is short
and low-entropy, and anyone holding both the file and the workspace could
match one against the other. The claim is the narrow one — the id is not IN
the file — and the file is the account's, mode 0600, exactly as the cache is.

**Written at `done`, and not at `dismiss`.** A dismissal is not the end of a
participant: `dismiss` says out loud that a new assignment to the same address
puts it back under watch, so a record per dismissal would put several rows on
one participant's run with nothing to merge them by — and the file is
append-only, read by PB-37 as one row per participant run. `done` is the one
moment a run is over for good, and `dismissedBeforeDone` carries the dismissal
into that single row.

**No lock, unlike the cache.** The cache write is a read-merge-write and loses
a neighbour's entries without one; this is an append of whole lines, which is
what JSON Lines is for. Two `done` calls at once interleave records and lose
nothing.

### Calibrate: reading the telemetry back

Source: `lib/model-routing/calibrate.js`.

Reading the telemetry back: local runs against the shipped catalog, as a
PROPOSAL for the user overlay and never as a write of its own.

[telemetry.js](../../lib/model-routing/telemetry.js) is the collecting half and says so in its own
header — "the READING half … is PB-37 and is not here". This is that half, and
it is the same shape of file: pure, no disk, no clock, no host. Records in, a
report out. `lib/models.js` reads the file, hands the rows over, prints what
comes back and — only after a person agrees — merges the `ratings` block.

Three rules shape it, all of them ADR-005's.

**The key is `(harness, model, effort)`, never `tuple`.** A lift with an
explicit `--model` carries no routing decision, so its record has
`tuple: null` — 18 of the 21 records the owner's own file held. Grouping by
tuple would silently drop the majority of a person's evidence and then report
a confident median over the rest. The catalog row is found FROM the key
afterwards, which is also where a Claude alias is resolved: `opus` and
`claude-opus-5` are one key, because the driver's dictionary says they are.

**The catalog is the anchor, not the local extremes.** ADR-005 decision 6
rejected mapping the local minimum and maximum onto 1 and 10 (option 6A): with
two eligible models they become opposite extremes however close their
measurements, which is the relative-field defect the catalog itself just shed.
Instead the most-observed model is the speed PIVOT and keeps its catalog band;
every other model moves from the catalog band by a step, and the same proposal
is applied to every effort rung. Quota cost keeps its per-rung pivot.

**"Catalog" here means the SHIPPED catalog, never the merged stack**, and the
difference is the whole reason `tuples` and `overlayTuples` are two arguments.
Comparing against the merged bands would make a person's own override the
base of the next comparison: run `--write`, run `calibrate` again on the same
records, and the rating walks another step — up to two bands a run, drifting
until it reaches whatever the measured ratio implies, with nothing new
measured in between. It would also make the printed "catalog N" and the
"only what moved" filter both read the override rather than the catalog,
which is not what the ADR, the reference or the glossary say the command
does. So the proposal is always a step away from the shipped band, running it
twice on one file proposes the same thing twice, and an existing override is
PRINTED beside the catalog band rather than standing in for it.

**A measurement that is not there omits its rating and says why.** Never a
zero, never a guess: a proposed band is a line a person is about to paste into
their own overlay, and one derived from a missing denominator would be
indistinguishable from one derived from five runs.

### The resolver: one decision, and the three rules that shape it

The resolver: one decision from the merged catalog, the availability snapshot
and a strategy. A pure function — no clock of its own, no disk, no harness —
because determinism is the contract ADR-003 fixed: the same inputs give the
same tuple whatever order they arrive in, and every number that moved the
pick is published.

The shape it produces is `schemas/model-routing/decision.schema.json`, and the
shape it consumes is what the two modules next door already answer:
`loadCatalog` ([catalog.js](../../lib/model-routing/catalog.js)) for the tuples, the merged policy and
its layers, `preflight` ([preflight.js](../../lib/model-routing/preflight.js)) for the snapshot. It
wires nothing: PB-21 gives it a command line.

Three rules shape the file.

**Every number comes from the merged policy.** A weight, a penalty, a bonus,
both quality floors and the two numbers of the pace layer are read from
`policy.policy`, never from a literal —
that is what makes an overlay able to change them at all. The two constants
below are formula constants of ADR-005, not policy: the 1–10 normalisation and
the neutral 50 % an unknown remaining limit counts as. The overlay schema has
no key for either, so an overlay cannot move them and neither can this file.

**The filter steps are in the ADR's order, and the first one that matches is
the exclusion reported.** ADR-003 gave nine and ADR-004 added the `flags`
selector after the inventory step, because that is where the snapshot row it
reads arrives. Order is what makes an explanation stable: a tuple the account
cannot run AND that is rated for the other role must always give the same
answer, or two runs would disagree about why.

**A harness the snapshot does not carry is filtered, not excluded.** The
snapshot covers the harnesses the workspace declared (`host.declaredTools()`,
the preflight's `harnesses`), and ADR-003 says the catalog is filtered by that
declaration. A tuple for a harness this workspace never declared was not
considered and does not belong in `candidates`; the exclusion enum has no code
for it either.

### `limit-hit-at-start`: when a lift fails on a limit spent since the preflight

Source: `lib/liftoff.js`, the `persist` / `sayLimit` contract.

`persist(session, state, sessionId)` — write the participant into the journal. Called
on ANY check outcome, including a dead spawn: a repeat lift at the same address is a
normal restart, and without a write it would hit "directory taken, and the participant
is not in the journal". The check outcome goes as the second argument:
`applyParticipant` replaces the record whole, and without the outcome a "no session"
refusal would clear the reviewer's `pending` mark. Third — the FULL session identifier
(review note): the address-ownership gate checks equality against it, while the short
id is parsed from free-text output and is only good as a prefix. `launchFailNote` and
`deadNote` are refusal routes, different per role; `awaitOptions` is a test seam.
`sayLimit(output)` — the late-start hook. A lift can fail because the account's
limit was spent between the availability preflight and this launch, and the only
evidence of that is the harness's own words in `output`. The hook is called on
the two branches that HAVE those words — a non-zero exit and a session that never
came up — and on no other: a lift that worked said nothing about a limit.

It RETURNS the line to append to the refusal, or `''` when it marked nothing. The
mark it writes lands in a file nothing reads yet and no flag clears yet, so a
refusal that did not name it would leave a person with a state they never saw;
the words are the driver's, because the file and the command are its own.

It has to be called from HERE rather than by a caller catching a refusal, because
`fail` ends the process: past that line there is no caller left to classify
anything. The classification itself is not here — this file knows the lift, and
what counts as a limit refusal is the driver's own pattern.

**A refusal the hook classified leaves as a typed error, not through `fail`.**
`limit-hit-at-start` is a published routing code ([03-cli](../reference/03-cli.md)),
and a code nothing raises is a vocabulary a consumer cannot branch on (PB-21.1).
So the two branches that HAVE the harness's words throw a `PromptobusError` with
that code — and they throw it on exactly the condition the hook reports: a
non-empty line, which the hook returns only after the cache mark was WRITTEN.

That is what the code means, both halves at once: the limit was hit AND the
harness is now marked exhausted. A limit refusal whose mark could not be written
— an unreadable routing path, a directory that refuses — returns `''` from the
hook and leaves through `fail` with no code, which is the honest reading: there
is no mark for a consumer to act on, and the person gets the same diagnosis
either way. The CLI catch prints a `PromptobusError` as one line and exits 1,
exactly as `fail` does; what the code adds is on the way past a consumer.

### The merge: four rules, and why provenance is a list

Source: `lib/model-routing/catalog.js`.

--- the merge itself --------------------------------------------------------

Four different rules live here, and they differ on purpose:

  * a weight SET is replaced whole. Half-replacing one would silently stop it
    summing to 100, and the resolver would divide a component back by a weight
    nobody chose;
  * a DENY list ACCUMULATES across layers, per selector kind. A ban written in
    any layer stands, and no layer above it lifts one: lifting a ban means
    changing the layer that wrote it. ADR-003's "Clarification, 2026-09-05" —
    replacement per selector kind — is superseded whole by ADR-004 decision 5,
    which measured the cost of the old rule: a product policy could only make
    its bans hold by sitting above a person's file and erasing that person's
    own `deny.tuples` with it;
  * an ALLOW list INTERSECTS across layers, per selector kind. A tuple must be
    named by every allow list of that kind that any layer states, so one
    sentence covers both lists — a layer's rule survives every layer above it
    (ADR-004, option B1). The cost is real and is checked rather than
    discovered: two layers can intersect to nothing, and `validate` reports
    `allow-intersection-empty` when they do. An intersection that came out
    empty is `[]` and NOT an absent key, because the two mean opposite things
    to the resolver — absent is "no allow list of this kind", empty is "an
    allow list that admits nothing";
  * everything else merges field by field: a penalty, a bonus, one rating of
    one tuple. Naming a field is how an overlay changes it, and not naming it
    is how it leaves the layer below alone.

Provenance is a LIST OF RULES rather than one layer id per key, and it has to
be: under union and intersection a merged list is written by several layers at
once, and "denied by overlay \"workspace\"" is only half an answer when the
user layer denied it too. `sources.rules` records every allow and deny list
any layer wrote, in layer order, with the role it was scoped to — and every
diagnostic in the resolver and in `validate` is a filter over that list.

### Preflight: running the adapters together under one budget

Source: `lib/model-routing/preflight.js`.

Availability preflight: ask every declared harness what the account can do
right now, all at once, under one budget, and hand back the availability
snapshot the resolver reads.

Four decisions shape this file.

**The binaries are resolved here, before the race, not inside each probe.**
`resolveToolBin` is synchronous by contract and a host may start a process in it,
so a probe that called it would hold the event loop and stop the very timer that
bounds the run. One resolve per declared binary, up front, under the same
deadline, and each adapter is handed its answer ([model-routing.ts](../../src/model-routing.ts)
`ProbeRequest.toolBin`).

**One budget for the whole run, not one per harness.** Adapters run in
parallel, so each is given the whole budget as its own ceiling and the run ends
when the budget does. A harness that has not answered by then is `unknown` /
`probe_timeout` and does not hold the command: a person waiting on `spawn` pays
once for the slowest harness, never three times in a row.

**The cache is consulted before the adapters, not after.** A live entry means no
probe at all; `--refresh` drops the live entries and probes again. What
`--refresh` cannot drop is a sticky exhaustion ([cache.js](../../lib/model-routing/cache.js)).

**`--dry-run` without `--refresh` never probes.** A dry run is how a person asks
a question, and a question that starts three harness binaries and waits fifteen
seconds is not one. A harness with no live entry then reports `unknown` /
`stale_cache` — reported, never silently taken as available.

Flags are the CLI's words; this module takes `refresh` and `dryRun` as options
and knows nothing about argv.

### The availability cache: the first disk boundary of routing

Source: `lib/model-routing/cache.js`.

Availability cache: the last availability snapshot, kept between commands so
that a routed `spawn` does not start three harness binaries every time.

**This file is the disk boundary of routing, and it is the one new file that can
leak.** Two rules hold it, and both are gates rather than intentions:

  • mode `0600` and a temp-file-plus-rename write — a parallel reader never sees
    a truncated file, and a process that dies mid-write leaves the previous one;
  • a verdict is PROJECTED onto the closed snapshot shape before it reaches
    disk. `snapshotEntry` copies the declared fields and nothing else, so a
    token, an email or an open account id an adapter put beside them does not
    travel. The shape is not this file's invention — it is
    `schemas/model-routing/snapshot.schema.json`, whose every object is closed
    precisely so that a document carrying such a field stops validating.

The file is named by the host (`routingPaths().cacheFile`) and is account-scoped:
auth, model inventory and the remaining limit belong to the account the harness
binary is logged into, and the same account is reached from every checkout on
the machine. `promptobusHome()` — the per-workspace task store — is not used
here at all.

It carries no account key. v1 assumes ONE locally authenticated account per
harness (ADR-003), so there is nothing to tell apart; the snapshot schema keeps
a `fingerprint` slot for the day that changes, and the rule that comes with it
is that the key must be opaque and one-way.

### Validate: what a catalog or an overlay is refused for

Source: `lib/model-routing/validate.js`.

`models validate` as a library function: what is wrong with the catalog and
the overlays, before anything tries to route on them.

It is a library function and not a command on purpose. PB-21 wires the
`promptobus models validate` subcommand to it; the resolver calls the same
function on the same layers; and a consumer that ships a policy layer of its
own can check that layer without a subprocess.

**Production reads no JSON Schema.** The grammar below is the same grammar as
`schemas/model-routing/*.schema.json`, written by hand for the same reason
[src/v1/validate.ts](../../src/v1/validate.ts) gives: the package must run
with no runtime dependency, and ajv is a devDependency. Two descriptions of
one contract drift, so a parity check on shared documents lives in
[test/model-routing-catalog.test.mjs](../../test/model-routing-catalog.test.mjs)
— edit one, edit the other, or the red comes from there.

Verdict shape: `{ ok, errors, warnings }`. An error carries the code the
reference table names (`catalog-invalid`, `overlay-invalid` —
[03-cli](../reference/03-cli.md)), the layer id it belongs to, and
the field it is about. A warning never makes `ok` false: a stale rating is a
warning by ADR-003, and the canonical-priority checks are warnings because
the priority scheme is documented convention rather than schema.

### Loading the catalog and the layer stack

Source: `lib/model-routing/catalog.js`.

Model catalog and the overlay merge.

The catalog is the maintainers' rating of tuples and ships with the package
(`models/catalog.json`, `files` in package.json). Above it sit overlays: the
host names them and their order, lowest precedence first
(`routingPaths().overlays` — [02-host](../reference/02-host.md)), and
above those the constraints the caller took from the command line. The stack
is exactly the one ADR-003 fixed:

    canonical catalog → host overlays, lowest to highest → CLI constraints

Nothing here resolves or scores anything. This module answers one question —
"what is the policy and the tuple list, after everyone has had their say" —
and PB-18 turns that answer into a pick. `validate.js` next door reads the
same layers and reports what is wrong with them.

A missing overlay file is normal and not an error: the host names paths, it
does not promise they exist.

### Rendering a decision for a person

Source: `lib/model-routing/render.js`.

The text half of a decision: what `promptobus models` prints when it is not
asked for `--json`.

It renders a decision document and nothing else — no catalog, no snapshot, no
policy — so the two outputs of the command cannot drift: whatever the JSON
says, this is that same document with column widths. The order is the
document's own, scored candidates first by descending total and excluded ones
after, because `candidates` in `decision.schema.json` declares that order as
part of the contract and the renderer prints the array as it stands.

Byte-for-byte pinned by `test/fixtures/model-routing/models.txt`. The columns
below are what that fixture fixes; the rules around them exist so a longer
name widens the grid for every row instead of pushing one row out of it.

### The `models` command: what each subcommand reads and writes

Source: `lib/models.js`.

`promptobus models`, and the routing gate `spawn` and `review` stand on.

Everything below the command exists already as a library: the catalog and its
overlays ([model-routing/catalog.js](../../lib/model-routing/catalog.js)), the checks
behind `models validate` ([validate.js](../../lib/model-routing/validate.js)), the
budgeted preflight and the availability cache
([preflight.js](../../lib/model-routing/preflight.js),
[cache.js](../../lib/model-routing/cache.js)), and the pure resolver and renderer
([resolver.js](../../lib/model-routing/resolver.js), [render.js](../../lib/model-routing/render.js)).
This file is the only place they meet, and it is deliberately the ONE place:
`spawn` and `review` route through the same gate as `models` prints, so the
decision a person is shown is the decision a lift is made on.

**The order inside the gate is not free.** Explicit constraints are validated
against the merged catalog and `host.declaredTools()` BEFORE `resolve` is
called, because `resolve` cannot tell them apart: a harness the workspace
never declared is absent from the snapshot, and the resolver filters its
tuples out rather than excluding them ([03-cli](../reference/03-cli.md)
§ Resolver). Both cases would reach the person as `chosen: null` with an empty
candidate list, and "you named a harness this workspace does not have" would
be indistinguishable from "nothing survived filtering".

### The routing contract types

Source: `src/model-routing.ts`.

Availability adapter contract: how ONE harness answers "can this account run
right now". The preflight ([preflight.js](../../lib/model-routing/preflight.js)) runs every adapter
in parallel under one budget and turns their verdicts into the availability
snapshot the resolver reads; the cache keeps that snapshot between commands.

The contract is declared here rather than inside the driver contract because it
is a different question with a different lifetime: `Driver` is about a session —
start it, look at it, wake it, stop it — while an adapter answers about the
ACCOUNT, before any session exists. A driver carries its adapter (`availability`
in [driver.ts](../../src/driver.ts)) and both go out of the same entry point, so an author
implementing a harness still reads one import.

What is not here, on purpose: the shape on disk. The snapshot is pinned by
`schemas/model-routing/snapshot.schema.json`, and that schema — not this file —
is what a written cache is validated against. Every object it declares is
CLOSED, which is the mechanism that keeps a token off disk: the writer projects
a verdict onto the declared fields, and anything an adapter added beside them
never reaches the file.
