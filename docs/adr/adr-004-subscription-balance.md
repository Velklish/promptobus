# ADR-004: Subscription balance: tier and remaining per window, the balance strategy, role floors, overlay union

**Status:** Accepted
**Date:** 2026-09-06
**Deciders:** Pavel Kim (project owner)
**Partly superseded by:** [ADR-005](adr-005-ten-point-scale-absolute-bands-calibrate.md), only for the rating scale, role-floor defaults, catalog banding and interpolation rules, hypothesis wording, and the narrow `models calibrate --write` exception to the read-only user layer; ADR-005's supersession table is exhaustive.

## Context

[ADR-003](adr-003-model-routing.md) made routing a question about one run: given a role and a strategy, which tuple is the best thing to launch right now. It scores a rating and filters by availability, and `remaining` — the one input that is not a rating — carries 15 % of every weight set.

The owner restated the goal on 2026-09-06, and it is a question about a month rather than about one run. Three subscriptions pay for three harnesses, each with its own windows, and the work should **spend all three evenly over those windows**. Scoring by rating does the opposite: it sends every run to the best-rated tuple until that account is exhausted while the other two sit idle, and the person then switches harness by hand — which is what the owner had been doing.

ADR-003 could not have done otherwise, because it recorded an assumption: no harness but Codex exposes a remaining limit. That assumption is why [03-cli](../reference/03-cli.md) says of Claude Code that `available` "is a state this harness cannot reach in v1", and of Cursor that "a successful probe is `unknown`, not `available`".

**A spike on 2026-09-06 disproved it.** All three harnesses answer from local credentials with no paid turn. The measured shapes, by harness — field names only; no account's values are recorded here, and the run's own file holds the numbers:

| Harness | Tier comes from | Windows | Remaining | Model-scoped |
|---|---|---|---|---|
| Claude Code | `rateLimitTier` in the local credential record — read offline, no request | a session window and a rolling weekly window | a `percent` used and a `resets_at` per row of a `limits[]` array | a per-model weekly row, whose scope names a model by its **display name** |
| Codex | `planType`, already beside the limits the adapter reads | `primary` and `secondary`, with `windowDurationMins` | `usedPercent` and `resetsAt` (unix seconds) | none. Beside them: `credits`, `spendControlReached`, and a count of "full reset" credits the person may spend |
| Cursor | no method names the plan; the **included amount** of the cycle is the only tier proxy | **one** billing cycle, `billingCycleStart` / `billingCycleEnd` (unix ms) | **two pools in that one window** — one percentage for Cursor's own models, one for named third-party models | the pools *are* the model scope: the harness publishes the id list of the first pool, and the second is everything else |

Three further facts from the same spike bear on the catalog. Codex marks rows of its inventory `hidden` and offers an effort level above the ones the catalog rates, plus a service tier that is not an effort. Cursor's second pool bills third-party models — the very models Claude Code and Codex serve directly — against the same included amount, so a run routed there spends two subscriptions for one turn. And the v1 catalog was rated from model descriptions rather than from published results: `source` on every row says so.

One more thing the first consumer measured. The overlay merge replaces lists per selector kind ([ADR-003](adr-003-model-routing.md) § Overlays, "Clarification, 2026-09-05"), so a product policy can only make its bans stand by sitting **above** the person's own file and erasing the person's `deny.tuples` with it. Rules the consumer actually wanted — "the reviewer never runs here", "never a model outside zero-data-retention" — could not be written at all: there is no selector for a role and none for a flag the inventory carries.

This ADR is the contract for the series that closes all of it: the snapshot (PB-24), the host contract (PB-25), the three adapters (PB-26…PB-28), the catalog (PB-29), the resolver (PB-30), the merge (PB-31), the signal and the default (PB-32), the release (PB-33). It supersedes ADR-003 by section, and the sections it does not name are unchanged.

## Options

The owner's decisions below were given, not chosen here. These are the axes the ADR had to decide for itself, and the cost of the branch not taken.

**Decision A — where `balance` acts on a candidate.**

- **A1. A sixth filter.** Candidates on a harness with no pace, or past its window, are *excluded* with their own codes. Simple, and it uses machinery that exists — but a strategy that excludes every candidate and then chooses one of them in its fallback prints a document that contradicts itself, and "the pace of this harness is unknown" is not a statement that the candidate cannot be run.
- **A2. A choice layer above scoring.** Every candidate keeps its score and its place; `balance` publishes a pace block per candidate and only the *pick* moves. This is the shape the reviewer quality floor already has ("a choice rule, not a filter", [03-cli](../reference/03-cli.md) § Resolver), so there is one pattern rather than two, and the fallback needs no re-admission.

**Decision B — what `allow` does once `deny` accumulates.**

- **B1. Intersection.** A tuple must be named by every allow list of that kind that any layer states. One rule covers both lists — *a layer's rule survives every layer above it* — and it is the sentence the resolver already applies across selector kinds, one axis further. The cost is that two layers can intersect to nothing, and a file that says "allow" then admits nothing.
- **B2. The most specific layer wins.** The highest layer that states an allow list decides. Cheap to explain in isolation, and wrong beside a union `deny`: the person would have to remember that one of the two lists can be overridden from above and the other cannot, and a workspace file could widen past a product's allow list — which is the hole the union is being introduced to close.

**Decision C — how `quotaCost` reaches the harness comparison.**

- **C1. Not at all.** The harness with the largest underspend wins; `quotaCost` only orders tuples inside it. Then a harness two points ahead on pace wins with its heaviest tuple, spends more than those two points, and is behind on the next run — the strategy oscillates.
- **C2. A discount on the underspend, in the units of the underspend.** The tuple that would actually be picked gives up a share of a window proportional to its `quotaCost`, before harnesses are compared. One number to set, and it is stated in percentage points of a window, which is what an underspend is.

**Decision D — a v1 availability cache under a v2 reader.**

- **D1. Migrate in memory.** Buys at most one hour of not re-probing — the longest TTL in the file — and costs a second reader of a shape nothing writes any more, kept forever.
- **D2. Discard, and report `stale_cache`.** One reader. The one entry with real value, a reset-less exhaustion, is lost once at the upgrade, and the next refused lift writes it again.

**Decision E — where the workspace overlay lives once the tool writes it.**

- **E1. Leave it at `<workspaceRoot>/model-routing.local.json`.** It sits next to files people commit, in a directory whose `.gitignore` is a contract with the repository rather than with this package: the first `models strategy --set` writes into somebody's working tree.
- **E2. `<promptobusHome>/model-routing.json`.** The store home is already this package's own directory in a workspace, and nothing there is committed. It costs one supersession: ADR-003 says `promptobusHome()` is not used for routing.

## Decision

**A2, B1, C2, D2, E2**, over the owner's nine decisions of 2026-09-06 recorded first as given.

### The owner's decisions, 2026-09-06

Recorded as decisions, not options. Pavel Kim, project owner, 2026-09-06.

1. **The snapshot carries the tier and every window, per harness.** A window is `{ id, kind, lengthSec, usedPercent, resetAt, scope }` with `kind` one of `session`, `weekly`, `monthly`, and `scope` either `null` (the whole account), a model scope, or a pool scope. The tier is `{ name, source }` per harness. The cache keeps no token, no e-mail and no account id — unchanged.
2. **A fifth strategy, `balance`, spends the subscriptions evenly by pace.** For a candidate tuple on a harness with known windows, the **binding window** is the applicable window with the highest `usedPercent` — the account-wide ones, plus the model- or pool-scoped one that covers the tuple. Then `elapsedShare = (now − (resetAt − lengthSec)) / lengthSec`, `usedShare = usedPercent / 100`, and `underspend = elapsedShare − usedShare` — two shares of 0…1, which the pace layer below converts once into the unit it compares in. The strategy prefers the harness with the largest underspend and then the best tuple on it by the role's ordering. A binding window at or past 100 % is spent for that tuple; a harness with no known windows has no pace and does not take part, and the decision says so.
3. **Quality floors per role are policy values, and the defaults change: worker 3, reviewer 5.** ADR-003 had a reviewer floor of 4 and no worker floor. Both are overlay keys, and the soft fallback with a warning stays.
4. **The reviewer takes part in the balance.** "The reviewer stays in Claude Code" is a rule of the first consumer, not of this package, and that consumer drops it. The diversity rule — a reviewer whose harness or model differs from the worker's — stays.
5. **Overlay lists merge by union.** `deny` lists accumulate across layers, and no higher layer lifts a lower one's ban; ADR-003's "Clarification, 2026-09-05" is superseded. Two selectors are added: by role, and by a model flag the snapshot carries. The schema stays additive — an overlay written for v1 stays valid.
6. **The workspace overlay is state, not configuration.** Its content changes over time, because the tool writes it, so under standalone it lives at `<promptobusHome>/model-routing.json` rather than in the repository root, and the host contract marks exactly one layer `writable`. `defaults.strategy` in an overlay is the strategy `spawn` and `review` use when `--strategy` is absent; with no default anywhere the legacy path is unchanged.
7. **A near-limit signal.** `models` warns for a harness whose binding window is past a threshold, or whose underspend is negative beyond a band, and names the strategy it would switch to. `models strategy --set <name>` writes `defaults.strategy` into the writable layer. The rubric tells the orchestrating agent to **propose** the switch to the person, never to make it silently.
8. **Catalog ratings come from published benchmark results**, not from model descriptions. Cursor rows exist only for models Claude Code and Codex do not serve. Codex rows may carry the effort level above the rated ones; the service tier beside them is not an effort.
9. **A tier question the tool cannot answer is asked once and kept in the user overlay.** Today there is exactly one: Cursor's plan name.

### The snapshot: windows, scope and tier

`schemaVersion` moves to **2**, and a v1 document is **discarded rather than migrated** (D2): every harness of it reports `unknown` / `stale_cache`, and the next run probes. The reason is what the file is — the longest TTL in it is an hour and the windows expire in a minute, so a migration path buys one hour of not asking and keeps a second reader of a dead shape forever. The exception that costs something is a reset-less exhaustion, which never expires: it is lost once, at the upgrade, and the next lift that hits the limit writes it again through the same hook that wrote it the first time.

A window is required to carry `lengthSec`. A pace cannot be computed without it, and a window that silently never paces is worse than one that fails validation at the adapter that wrote it. An adapter that cannot state a length **reports no window**, which is the rule ADR-003 already gives for a harness that exposes none.

`kind` is a **name, not a length**. `lengthSec` is the number, and nothing derives one from the other: a billing cycle is `monthly` and is not thirty days, and Codex's windows keep the lengths their payload states. This is ADR-003's rule for Codex ("nothing is renamed into hours and days") applied to all three.

`scope` has three shapes, and two of them say what they cover **by model id**:

```text
null                                    the whole account
{ model: "<display name>", models: [id, …] }    one model family
{ pool: "auto" | "api", models?: [id, …] }      one of Cursor's two pools
```

A scope that covers models names them. The harness names a model scope in its own words — a display name — and the adapter, which holds the driver's model dictionary, resolves that name to the ids the catalog can be compared against and writes them into `models`. **The resolver matches by exact id and infers no family**, because a family inferred from a display name is a guess about which rows a limit binds, made in the module least able to check it. A display name the adapter cannot resolve arrives with no `models`: the window stays in the snapshot, is printed for a person, and binds nothing.

The `auto` pool carries `models` because the harness publishes that list. The `api` pool carries none: it is the complement, and a list of everything else is not a fact any harness stated. **A tuple whose model is in no `auto` list falls in the `api` pool** — the owner's rule, and it is also the harness's own. The shape is checked where the shape is held: `models` is **required** on an `auto` pool and **refused** on an `api` pool, and on a **model scope it is optional** — an unresolved display name is the expected case named in the paragraph above, and requiring the list there would cost the window the paragraph keeps.

A harness gains `tier: { name, source } | null`. `source` is a closed list of four: `credentials` (a local credential record), `probe` (the harness answered), `derived` (computed where no method names the plan — Cursor's `included:<cents>`), `user` (a person's answer, [below](#one-question-the-tool-cannot-answer)). **The tier is carried and displayed and is an input to nothing**: no score reads it in v1, and a later decision that wants it in scoring starts by saying so.

The tier does not break the cache's promise. A tier name is a property of a **plan**, shared by everyone on it, and the derived form carries the plan's *included* amount, never the account's *used* amount — so the file still holds no token, no e-mail and no account id. The tier follows the auth TTL (one hour); the limit windows keep theirs (sixty seconds).

A model gains `hidden: boolean`. A hidden row is **carried and never chosen**: carried because a person asking `models` should see that the harness holds a row it declines to offer, and an inventory that quietly differed from the harness's own was the previous behaviour; never chosen because the harness hides what it does not serve. The resolver's inventory is the rows with `hidden !== true`, so a catalog tuple naming a hidden model is excluded as `model-not-in-inventory` — which is true of it from the resolver's side — and no code is added.

This supersedes the sentence in [03-cli](../reference/03-cli.md) that says the Codex adapter leaves hidden rows out of the inventory; PB-28 is the task that changes both the adapter and that paragraph.

Codex's `credits`, `spendControlReached` and the count of full-reset credits are carried as **informational** fields on the harness. Nothing scores them, and nothing spends a reset credit: spending one is money-adjacent and is a person's decision, which is the same line ADR-003 drew around pay-as-you-go.

**Reason codes are unchanged** — the eight of ADR-003 and [03-cli](../reference/03-cli.md), with `quota_unknown` still meaning a harness whose adapter got no windows. What changes is which harnesses reach `available`: with windows in hand, all three can, and the two sentences in the reference that said Claude Code and Cursor could not are superseded by their adapters (PB-26, PB-27).

### The `balance` strategy

`balance` is the fifth value of `--strategy`. **The four ADR-003 strategies are untouched** — the same weights, the same defaults, the same fixtures — because they answer a different question: how to weigh the qualities of a tuple. `balance` answers which account to spend from, and it is additive.

**It has no weight set of its own.** Inside one harness it orders tuples by the merged `balanced` weights, which is what "the role's ordering" means everywhere in this ADR. Two weight sets that must be kept in step are two things to keep in step, and a person who wants a different ordering inside a harness is describing a different strategy. The cost is named rather than hidden: an overlay that re-weights `balanced` re-weights the inside of `balance` with it.

**It is a choice layer, not a filter** (A2). Filtering steps 1–6 of ADR-003 run unchanged and every surviving candidate is scored by the `balanced` weights and keeps its place in the decision. Above that, each candidate gains a **pace block**:

```text
window        the binding window: its id, kind and scope
usedShare     usedPercent / 100                            a share, 0…1
elapsedShare  (now − (resetAt − lengthSec)) / lengthSec     a share, 0…1
underspend    (elapsedShare − usedShare) × 100             PERCENTAGE POINTS of that window
spendPenalty  balance.spendUnit × (quotaCost − 1) / 4      percentage points, 0…spendUnit
effective     underspend − spendPenalty                    percentage points
eligible      true, or false with a note: no-pace | window-spent
```

**One unit, and it is stated once.** The owner's two inputs are shares of 0…1; everything the pace layer compares — `underspend`, `spendPenalty`, `effective`, `balance.band`, `balance.spendUnit`, `nearLimit.underspend` — is in **percentage points of the window**, the same unit `usedPercent` is already in. The `× 100` above is the whole conversion and it happens in one place; both shares are published beside the result, so a reader can recompute it. Mixing the two is not a rounding difference but a degenerate strategy: with the numbers below read as shares, every harness would fall inside one band and `balance` would quietly be `balanced`.

`elapsedShare` is clamped to 0…1 against clock skew. A window whose `resetAt` is absent, or is not in the future, **is not paced**: the fact has expired, and the sixty-second TTL is what repairs it — a pace computed from a window that has already reset would be a number about a period that is over.

The pick, in order:

1. Among **eligible** candidates, each harness is represented by its best tuple by the role's ordering; the harness's `effective` is that tuple's.
2. The largest `effective` leads. Every harness within `balance.band` of the leader is tied with it, and inside the tied set the **`balanced` score** of each harness's representative decides, then ADR-003's own tie-break — confirmed availability, canonical priority, tuple id. Measuring the band from the single leader makes the tied set well defined whatever order the candidates arrived in, which is the determinism ADR-003 calls load-bearing.
3. The role rules and the tie-break run as ADR-003 states them.
4. **No eligible candidate — the pick is the best `balanced` score**, with the warning `balance-fallback`: "no harness could be paced; this pick was scored, not balanced". It is a fallback rather than a refusal because a person asked for work to start, not for a lecture about their windows, and `unknown` has been a penalty and never a block since ADR-003's fourth decision row.

`spendPenalty` is C2: the discount is in the units of the underspend, and it is applied to the tuple that would actually be picked — which is also the answer to an ambiguity in decision 2, since the binding window is defined per tuple and a harness therefore has no underspend until a tuple names one.

Two overlay keys carry the numbers, and they default to the same value, `5` — five percentage points of a window:

- `balance.band`. Its job is not to model noise but to say "these two accounts are about equally spent, so take the better model". The noise floor is about a point (one harness reports `usedPercent` as an integer, and a sixty-second cache entry moves a five-hour window by a third of a point), so a band below that would do nothing at all.
- `balance.spendUnit`. Equal to the band by default, so that a `quotaCost` of 5 gives up exactly one band against a `quotaCost` of 1: the heaviest tuple has to be a whole band ahead on pace to win.

**`remaining` and pace are not the same fact counted twice.** `remaining` is a level — how much of the window is gone — and it ranks tuples inside a harness, where the scoped windows differ. Pace is a rate — how much is gone against how much of the window has elapsed. A harness at ninety per cent used with ninety-five per cent of its window elapsed is high on level and *ahead* on pace, and the two components say so independently.

**Every strategy gains from the scoped windows.** ADR-003 defines `remaining` as `100 − max(usedPercent)` over "the harness's applicable windows", and until now a harness had only account-wide ones. The applicable set is now defined per candidate tuple — account-wide plus the scope that covers it — so `remaining` is per tuple, and a Cursor tuple in a spent pool scores below one in a pool with room under `quality`, `balanced`, `speed` and `economy` as well. This is a refinement of ADR-003's sentence, not a reversal of it: it already said "applicable".

### Quality floors per role

`qualityFloor: { worker, reviewer }` in an overlay, defaults **3** and **5**. The existing `reviewerQualityFloor` key is still read, as an alias for `qualityFloor.reviewer`, so an overlay written for v1 keeps its meaning; a layer that states both is a `validate` warning naming the layer, and the explicit `qualityFloor.reviewer` wins.

Both floors keep the shape ADR-003 gave the reviewer's: a **choice rule, not a filter**. A candidate below the floor keeps its place and its score, only the pick moves past it, and when nothing reaches the floor the best remaining candidate is taken with a warning — `reviewer-floor-not-met` as before, and `worker-floor-not-met` beside it.

Five for the reviewer, because the reviewer is the last reader: a defect it misses costs the defect and a round trip, and a second reading with a weaker model is a second reading with a bigger blind spot. Three for the worker, because ADR-003's own opening argument — "a worker on a cheap model where the task needed the expensive one is paid for in review rounds" — describes a floor and never set one.

**Nothing in this package pins the reviewer to a harness**, and decision 4 does not remove a package rule, because there was none to remove: ADR-003 put "which harness its reviewer stays on" among the things a consumer adds. What the package ships is the diversity bonus, and it is unchanged. The consequence of the consumer dropping its rule is that a reviewer is routed by pace like a worker, with the floor of 5 and the diversity bonus above it.

### Overlay merge: union, intersection, two selectors

**`deny` accumulates.** A ban written in any layer stands, and no layer above it lifts it. ADR-003 § Overlays, "Clarification, 2026-09-05" — replacement per selector kind — is superseded whole.

**`allow` intersects** (B1). A tuple must be named by every allow list of that kind that any layer states. One rule then covers both lists — *a layer's rule survives every layer above it* — and it is the same sentence the resolver already applies across selector kinds ([03-cli](../reference/03-cli.md) § Resolver, filtering step 2), with the layer as one more axis. The alternative would have left the person holding two lists with opposite override rules, and would have let a workspace file widen past a product's allow list, which is the hole the union closes for `deny`.

The cost is real and is checked rather than discovered: two layers can intersect to nothing, and a file that says "allow" then admits no tuple at all. `models validate` gains two errors and a warning, and every one of them names the layer that wrote each half:

- `allow-intersection-empty` — the allow lists of one selector kind intersect to nothing across the layers that state one.
- `deny-covers-allow` — every name the intersected allow list admits is denied somewhere.
- `allow-shadowed-by-deny` (warning) — a name allowed in one layer and denied in another. Under replacement this was the contradiction ADR-003 asked `validate` to refuse; under union it is lawful and `deny` wins, so it becomes a warning that sends the person to the file that took their allow list away. A name allowed and denied **in one layer** stays an error: nobody writes that on purpose.

And the whole point of the change is stated where a person meets it rather than only here: `models validate` prints, per denied selector, the layer that wrote it and the sentence that **only that layer can lift it** — no allow list anywhere reaches a ban, because `deny` is applied after `allow`.

**Two new selectors**, both additive, in `allow` and in `deny` alike:

```json
"deny": {
  "models": ["…"],
  "flags": ["no-zdr"],
  "byRole": { "reviewer": { "harnesses": ["…"] } }
}
```

- **`byRole`** scopes a rule block to `worker` or `reviewer`. It is a nested selector object rather than a `roles` list beside the others, because a role is a *condition on when the rule applies*, not a thing that can be banned, and adding it to the flat object would change what its neighbours mean. When routing role R the effective deny of a kind is the unscoped list unioned with `byRole.R`'s; the effective allow is the intersection of the two, where both are stated. `validate` refuses a role outside the two.
- **`flags`** names a mark the **snapshot** carries on a model — today one, `no-zdr`, the mark the Cursor adapter attaches. It is applied after the inventory step, since it needs the snapshot's model row, and it is reported as the existing `denied-by-policy` with the layer and the flag in `detail`. It is the one selector whose names are **not** checked against the merged catalog — a flag is not in the catalog — so they are checked against a closed list — and that list is the snapshot schema's own `flags` enum, which PB-24 closes to the one mark that exists today, `no-zdr`. The cost of closing it is named: a new mark a harness starts printing needs a release rather than a data change, which is the trade a person's typo being caught is worth. A flag no snapshot in this run set is a warning rather than an error, because an inventory that names no flags is a normal Tuesday.

  The limit of the selector is stated rather than implied: **silence is not absence.** A harness that reports no inventory has no flags to match, so a flag deny excludes nothing there. A person who must never run outside zero-data-retention does not get that guarantee from a harness that lists no models, and this rule says so instead of appearing to.

**The decision document moves to `schemaVersion` 2, and it moves in PB-30.** Same reasoning as the snapshot: it is machine-written, read through an accessor, and pinned by golden fixtures that move with it — and by the end of this series it gains a fifth `strategy` value, a `pace` block on a candidate under a closed object, two warning codes and `strategySource`, every one of which a reader of version 1 would be wrong about. The bump belongs to the task that adds those (PB-30). PB-24's `harnesses` block is optional and additive, so it neither needs the bump nor blocks it.

**`schemaVersion` of an overlay stays 1.** The number describes the document's shape, the new keys are optional, and every file on disk stays valid — which is decision 5's own requirement. What changed is what those files *do*: a workspace overlay that used to replace a deny list below it now accumulates with it. That is the decision, and it is a release note, not a version gate — a bump would refuse every file on disk to announce a change none of them can express. The snapshot bumps and the overlay does not, and the difference is who writes them: a cache is machine-written and disposable, an overlay is a person's file.

### Host contract: exactly one writable layer

`HostRoutingPaths`'s layer gains `writable?: boolean`. **When a host declares any layer, exactly one of them is writable**; `readLayers` refuses zero and refuses two, naming the layers. The refusal is at the declaration rather than at the write for the same reason `harnessStateHome` refuses instead of guessing ([02-host](../reference/02-host.md)): a host that names layers and no writable one has an incomplete declaration, and finding that out at `models strategy --set` costs a person the edit they just made.

The standalone host answers the `workspace` layer at **`<promptobusHome>/model-routing.json`**, and it is the writable one; `user` stays under the user home and is read-only for the tool. `<workspaceRoot>/model-routing.local.json` is **no longer read** — there is no fallback, because two paths with one layer id would mean the file a person edits depends on which of them exists. The release note says so and the guide changes with it.

This supersedes one sentence of [ADR-003](adr-003-model-routing.md) § Host contract: "`promptobusHome()` is **not** used for routing." The principle underneath it is untouched — the cache and the `user` overlay are **account-scoped**, because auth, inventory and the remaining limit belong to the account, and they stay where they are. The workspace overlay was never account-scoped; it was per-workspace at the repository root, and it is per-workspace at the store home. What changed is that the tool writes it, and a file the tool rewrites cannot live where a person's edits and a repository's `.gitignore` are the contract.

A consumer host keeps its layer wherever its own state lives, under one condition: **not a committed file.** A product-policy layer that the product ships stays read-only and stays where it always was.

`models validate` prints which layer is writable, with its path.

A host that marks a layer other than the highest-precedence one writable creates a trap — the tool writes a value a layer above it overrides — so `models strategy --set` warns when what it just wrote is shadowed, naming the layer that shadows it.

### `defaults.strategy`

An overlay gains `defaults: { strategy }`, whose value is one of the five. **`auto` is not one of them**: it is a skill decision and has never been a value the CLI accepts.

Precedence: `--strategy` on the command line, then the merged `defaults.strategy`, then nothing — and nothing is the legacy path, unchanged. A flag a person typed always wins, because a named value is never replaced, which is the rule ADR-003 fixed for `--harness`, `--model` and `--effort`.

`defaults` is a scalar and merges like every other scalar: **lists accumulate, scalars are replaced by the highest layer that states one.** `models` prints the effective default and the layer it came from, and a routed lift records `strategySource` beside the decision so a run is auditable from its participant record.

This supersedes ADR-003's "A call with no `--strategy` routes nothing" **only where a default is set**. With no default anywhere the sentence still holds word for word.

### The near-limit signal

`models` prints a `near-limit` line for a harness whose binding window is at or past `nearLimit.usedPercent` (default **80**), or whose underspend is below `nearLimit.underspend` (default **−15** percentage points — the account has spent fifteen points more of the window than has elapsed of it). A harness already reported as `exhausted` is not repeated as near-limit: it is a stronger statement about the same account.

The line names the window, its reset time, and the strategy the rubric would switch to, by one rule:

- **`economy`** when every paced harness is past the threshold — the account set as a whole is short, and the answer is to spend less per run;
- **`balance`** otherwise — at least one other harness has room, and the answer is to spend it there instead.

When the strategy that would be named is the one already running, no line is printed: a warning that recommends what is already happening is noise.

`models strategy` without arguments prints the effective default and its layer; `--set <name>` writes `defaults.strategy` into the writable layer, `--clear` removes it, and both keep every other key of that file. The rubric ([skills](../../skills/orchestrate/SKILL.md), PB-32) makes the agent **propose** the switch and run `--set` only after the person agrees. Nothing switches a strategy on its own: the strategy envelope is what the person approved, and a mechanism that quietly left it would make the envelope unauditable.

### One question the tool cannot answer

Today there is one: Cursor's plan name, which no method returns. It lives in the **user** overlay under `account: { "<harness>": { "plan": "<name>" } }` — the path PB-32 proposed, generalised over harnesses so a second such question needs no new shape.

**No command writes it.** `models` prints the key, the value to add and the path of the `user` layer, and the person or the agent adds the line. Two reasons. The writable layer is per-workspace under standalone, so a tool-written answer would be given again in every workspace, which is the opposite of "asked once"; and declaring a second writable layer to carry one string would make "exactly one writable layer" false the first time it was used. The answer is display-only — nothing refuses without it, and the tier is an input to no score — so the cost of a person typing one line once is the whole cost. This decides the shape PB-32 left to this ADR, and it decides against the writer that task sketched.

The snapshot keeps what was **measured** — `{ name: "included:<cents>", source: "derived" }` — and `models` prints the person's answer beside it, marked as theirs. A typed string never enters the cache: the cache is what the harnesses said.

### Catalog ratings from published results

One rule, and it applies to `quality`:

> **The primary figure.** For each model, take the first of these that publishes a figure for **that exact model**: SWE-bench Verified, Terminal-bench, Aider polyglot, the vendor's own model card. **The band.** Sort the field — every model the catalog rates, plus every model the three harnesses expose that has a figure — by that figure, and cut it into five equal **ranks**: the top fifth is 5, the next 4, and so on down to 1. A tie takes the higher band.

Ranks rather than thresholds on the number itself, for two reasons. Absolute thresholds would be invented numbers in an ADR — nobody published them — and they go stale as the field moves, silently, which is the failure ADR-003 named for a stale rating. Equal-width bands over the range would let one outlier compress everything else into a single band, and a narrow field would be spread across all five as if the differences were large. A rank band answers the question the rating is actually used for: is this among the best things I can run.

The cost is named: **the bands are relative**, so a model's rating can move because the field moved and not because the model did. That is correct for a number whose only use is comparison, and it makes a catalog update a pass over the field rather than an edit of one row — which is what ADR-003 already means by "event-driven: a changed model line-up".

`speed` and `quotaCost` are rated by the same rank-band rule over their own public figures: `speed` over published output-throughput figures, `quotaCost` over the vendor's published list price per million tokens, blended input and output, **inverted** so the cheapest model takes 1 and the dearest 5 — which is the direction ADR-003's scoring expects, where a smaller spend contributes more. Where no figure is published for a model, the rating **is not invented**: the row says "no published number" in its evidence and the rating stays a hypothesis, which ADR-003 already keeps out of the catalog.

`evidence` cites, per rating: the benchmark or price source, the figure, the size of the field it was banded against, the source URL, and the date. `assessedAt` is that date. `validate` refuses a rated row with no source, unless the row is marked interpolated.

**Effort levels are interpolated from a base row and marked as such.** The base row is the effort the figure was measured at; where the source does not say, it is the harness's default effort. From it, per step of the effort ladder:

| Rating | Change per step away from the base row |
|---|---|
| `quality` | one band per **two** steps: `trunc(steps / 2)`, signed |
| `speed` | one band per step, **opposite** sign |
| `quotaCost` | one band per step, **same** sign |

All three clamped to 1…5, which is why a long ladder flattens at its ends. The asymmetry is the point: a step of effort changes tokens and latency close to proportionally, and both are directly observable, while its effect on the outcome saturates — where two efforts of one model both have published figures, they differ by far less than a band. An interpolated row carries `interpolatedFrom` naming the base tuple id in its evidence and shares the base row's `assessedAt`, so a ladder goes stale together. **This is the part of the rule most likely to be replaced by measurement**, and it is written as arithmetic so that replacing it is one change rather than a re-reading of every row.

**Cursor rows exist only for models Claude Code and Codex do not serve.** The reason is in the pools: Cursor's second pool bills third-party models against the same included amount, so routing a model there that another subscription already pays for spends two subscriptions for one run. The rows that remain are Cursor's own families, which is also the pool with the id list the harness publishes.

**Codex rows may carry the effort level above the rated ones.** The service tier beside it is **not** an effort and is not modelled in v1 at all: it is neither a value of `effort` nor a field of a tuple. Adding a fifth dimension to the tuple key — the catalog's unit — for one harness's speed option multiplies every Codex row, and when a person wants it, that is a decision of its own.

### Terms this decision adds

Proposed for [the glossary](../GLOSSARY.md) with the series' documentation pass, rather than invented in passing:

| Term | Definition |
|---|---|
| window | One limit period of a harness account: `kind`, `lengthSec`, `usedPercent`, `resetAt` and a `scope`. |
| binding window | The applicable window with the highest `usedPercent` for one candidate tuple — the account-wide windows plus the scope that covers it. |
| pace | The relation between how much of a window is spent and how much of it has elapsed. `underspend` is the difference, in percentage points of that window. |
| tier | The plan a harness account is on, as `{ name, source }`. Carried and displayed; an input to no score. |
| writable layer | The one overlay layer the host declares the tool may write. Exactly one, when any layer is declared. |

One row already in the glossary moves with them: **strategy** lists four values, and `balance` is the fifth.

## What this supersedes in ADR-003

Section by section. Everything not in this table is unchanged.

| ADR-003 section | What is superseded | By |
|---|---|---|
| § Overlays, "Clarification, 2026-09-05" | Lists are replaced per selector kind | Union for `deny`, intersection for `allow` |
| § Strategies | "A call with no `--strategy` routes nothing" — **only** where a default is set | `defaults.strategy` in an overlay |
| § Resolver | "a reviewer quality floor of 4 out of 5" | `qualityFloor: { worker: 3, reviewer: 5 }` |
| § Host contract | "`promptobusHome()` is **not** used for routing" | The workspace overlay moves to `<promptobusHome>/model-routing.json`; the cache and the `user` layer stay account-scoped |
| § CLI surface | The four values of `--strategy` | Five: `balance` is added |

Two things read like supersessions and are not. ADR-003's rule that **an adapter which cannot obtain a remaining limit returns `unknown`** stands exactly as written; what changed is that two more adapters now can. And ADR-003's `remaining` component is **refined, not reversed**: it already said "the harness's applicable windows", and the applicable set now has scoped members.

## Not in v1

Added to ADR-003's list, which otherwise stands:

- Codex's service tier as a dimension of the tuple key.
- Spending a reset credit. The count is displayed; spending it is money-adjacent and is a person's decision.
- The tier as an input to any score.
- A general mechanism for questions the tool cannot answer. There is one question, and it is one overlay key.
- Any automatic change of strategy. The signal proposes; the person decides.

## Consequences

- **`balance` is only as good as the windows, and two of the three sources are undocumented.** The Claude usage endpoint and the Cursor dashboard method are not published contracts; a shape change makes those harnesses `unknown`, they drop out of the pace comparison, and the strategy silently degrades toward `balanced`. The `balance-fallback` warning is what keeps "silently" from being true, and it is a gate in PB-30, not an intention.
- **Ratings become recomputable, and therefore auditable.** Every band can be checked against the field and the date in `evidence`. The price is that a new frontier model re-bands the field, so a catalog update is a pass rather than an edit.
- **A ban is now permanent from below, and that is a sharper tool than it looks.** A person who denies a model in their user overlay cannot lift it in one workspace; they change the layer that wrote it. That is the behaviour the first consumer asked for, in both directions.
- **An allow list can now be unsatisfiable.** Two layers narrowing different ways intersect to nothing, and every tuple is denied by policy from files that both say "allow". `models validate` names both layers; without that check the symptom would be `candidates-empty` with no explanation.
- **The host contract moves again, one release after it last did.** A consumer implementing `PromptobusHost` marks exactly one layer writable, or `readLayers` refuses. It lands in the same release as the rest of the series, so a consumer repins once.
- **The workspace overlay leaves the repository.** A person who put rules in `model-routing.local.json` finds them no longer read. There is no migration, deliberately, and the release note is the whole of the warning — which is a real cost, paid to avoid two files with one layer id.
- **Every strategy's `remaining` changes meaning slightly**, because the applicable window set is now per tuple. Existing golden fixtures move with the snapshot version; a decision that does not is a regression.
- **Determinism survives the new layer.** The band is measured from a single leader and the tie-break still ends at the tuple id, so two runs on one snapshot pick one tuple. Anything that makes the pace layer read a clock other than the `now` it is handed breaks this decision, exactly as it would have broken ADR-003.
