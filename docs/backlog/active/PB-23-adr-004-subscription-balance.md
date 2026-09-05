# PB-23 · ADR-004: subscription balance — tier and remaining per window, the balance strategy, role floors, overlay merge by union

- **Scope:** [ADR-003](../../adr/adr-003-model-routing.md), [02-host](../../reference/02-host.md), [03-cli](../../reference/03-cli.md), `lib/model-routing/`
- **Created:** 2026-09-06
- **Dependencies:** none — the contract comes first; PB-24…PB-33 implement it
- **Taken:** 2026-09-06

## Context

The owner's goal, stated 2026-09-06, reframes what routing is for. Three subscriptions pay for three harnesses — Claude Code (Max, `default_claude_max_20x`), Codex (`plus`), Cursor (an included monthly amount) — and work should **spend all three evenly over their windows**, not go to the best-rated model until one account is exhausted while the others sit idle. Until now the owner switched harnesses by hand.

ADR-003 built routing as scoring by rating with availability as a filter, and it assumed no harness but Codex exposes a remaining limit. A spike on 2026-09-06 disproved the assumption: every harness answers from local credentials with no paid turn. The measured shapes are in the run's file `spike-limits.md` (the orchestrator hands the path in the brief); in short:

- **Claude Code** — the keychain item `Claude Code-credentials` (macOS; `~/.claude/.credentials.json` on Linux) carries `claudeAiOauth.{accessToken, expiresAt, subscriptionType: "max", rateLimitTier: "default_claude_max_20x"}`; `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer` and `anthropic-beta: oauth-2025-04-20` returns `limits[]` rows `{ kind: session | weekly_all | weekly_scoped, percent, resets_at, is_active, scope: { model: { display_name } } | null }` — a 5-hour session window, a 7-day window, and per-model weekly windows (Fable today); `/api/oauth/profile` returns `organization.rate_limit_tier`.
- **Codex** — `account/read` → `planType: "plus"`; `account/rateLimits/read` (already used) also carries `planType`, `credits`, `spendControlReached`, `rateLimitResetCredits.availableCount`; `model/list` marks hidden rows (`gpt-reserve`, `codex-auto-review`) and lists `ultra` among efforts and `fast` among `additionalSpeedTiers`.
- **Cursor** — the keychain item `cursor-access-token`; `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` (Connect protocol, JSON, `connect-protocol-version: 1`) returns **one monthly window with two pools**: `planUsage.autoPercentUsed` for Cursor's own models (`autoBucketModels`: composer, cursor-grok, vega) and `planUsage.apiPercentUsed` for named third-party models, plus `billingCycleStart/End`, `includedSpend`/`limit` in cents (7000 on this plan), `bonusSpend`. No method names the plan; the included amount is the tier proxy.

The current catalog (`models/catalog.json`) was an initial assessment by description, lists Cursor rows for models that Claude Code and Codex already serve, and has no `fable`. The overlay merge replaces lists by selector kind, so a consumer policy can only stand by sitting on top and erasing the person's own `deny.tuples` (a finding the first consumer filed in its own tracker).

## Work to do

Write `docs/adr/adr-004-subscription-balance.md` (`backslop adr`, a row in `docs/README.md`, a goal in `docs/ROADMAP.md`) that records the owner's decisions below as decisions, not options, and designs what they leave open. Every later task of this series cites this ADR; where the ADR and ADR-003 disagree, the ADR says so by section and supersedes only that section.

**Decisions of the owner (2026-09-06), to record as given:**

1. **Snapshot carries the tier and every window per harness.** A window is `{ id, kind: session | weekly | monthly, lengthSec, usedPercent, resetAt, scope }` where `scope` is `null` (the whole account), `{ model }` (Claude's per-model weekly limit) or `{ pool: auto | api }` (Cursor's two monthly pools, with the model families each pool covers). The tier is `{ name, source }` per harness (`default_claude_max_20x` from the keychain, `plus` from `account/read`, `included:7000` from Cursor's `planUsage.limit`). The cache keeps no token, no email, no account id — unchanged.
2. **A fifth strategy, `balance`, spends the subscriptions evenly by pace.** For each harness with known windows: the binding window is the one with the highest `usedPercent` among those that apply to the candidate tuple (account-wide, plus the model- or pool-scoped one that covers it); `elapsedShare = (now − (resetAt − lengthSec)) / lengthSec`; `usedShare = usedPercent / 100`; `underspend = elapsedShare − usedShare`. The strategy picks the harness with the largest underspend, then the best tuple on it by the role's ordering; a harness whose binding window is at or past 100 % is exhausted for that tuple; a harness with no known windows does not take part in `balance` (it is `unknown`, and pace cannot be computed) and the decision says so. Design and record: the tie-break when two harnesses are within a small band of each other; how `quotaCost` of the tuple enters (a heavier tuple should not win a small underspend); whether the four ADR-003 strategies stay unchanged (they do — `balance` is additive).
3. **Quality floors per role are policy values with new defaults: worker ≥ 3, reviewer ≥ 5** (ADR-003 had a reviewer floor of 4 and none for the worker). Both are overlay keys; the soft fallback with a warning stays.
4. **The reviewer takes part in the balance** — the ADR-003 consequence "reviewer stays in Claude Code" is a consumer rule, not a package rule, and the first consumer drops it. The diversity rule (reviewer's harness or model differs from the worker's) stays.
5. **Overlay lists merge by union.** `deny` lists accumulate across layers and no higher layer can lift a lower one's ban; the ADR-003 "Clarification, 2026-09-05" (replace by selector kind) is superseded. Design what `allow` does under union (intersection across the layers that state one, or "the most specific layer wins" — choose and say why) and how `models validate` reports a ban that no allow list can reach. Two new selectors: **by role** (a rule that applies to `worker` or `reviewer` only) and **by model flag from the snapshot** (`no-zdr` today). Keep the schema additive: an overlay written for v1 stays valid.
6. **The workspace overlay is state, not configuration.** Its content changes over time — the agent that sees a window running short proposes a more economical strategy and records it there — so standalone keeps it at `<promptobusHome>/model-routing.json`, not in the repository root; the host contract marks exactly one layer `writable`. `defaults.strategy` in an overlay is the strategy `spawn` and `review` use when `--strategy` is absent; with no default anywhere the legacy path (no routing) is unchanged. This supersedes the ADR-003 sentence "A call with no `--strategy` routes nothing" only when a default is set.
7. **A near-limit signal.** `models` prints a `near-limit` warning for a harness whose binding window is past a threshold (default 80 %, an overlay key) or whose underspend is negative beyond a band, and names the strategy it would switch to; `models strategy --set <name>` writes `defaults.strategy` into the writable layer. The skill rubric tells the orchestrating agent to propose the switch to the person, not to make it silently.
8. **Catalog ratings come from public benchmarks**, not from model descriptions: the ADR fixes one rule that maps published results (SWE-bench Verified, Terminal-bench, Aider polyglot, and per-model vendor cards) to the 1–5 scale, names how an effort level of a rated model is interpolated from its base row and marked as such, and requires `evidence` to cite the source and the date. Cursor rows exist only for models Claude Code and Codex do not serve. Codex rows may carry `ultra`; `fast` is a service tier, not an effort.
9. **The tier question the tool cannot answer is asked once and kept in the user overlay** (Cursor's plan name; nothing else today).

**What the ADR must also settle** (the orchestrator accepts or sends the questions to the owner):

- window `kind` for Cursor's billing cycle (`monthly`, length from `billingCycleStart/End`);
- how a Cursor tuple maps to a pool: `autoBucketModels` from the snapshot decides; a model in neither list counts as `api`;
- the Claude adapter's model-scoped window applies to tuples whose model is that display name's family; unmatched scoped windows are kept in the snapshot and ignored by the resolver;
- what `balance` does when every harness is `unknown` (fall back to `balanced` scoring with a warning is the proposed answer);
- reason codes: none added unless needed; `quota_unknown` stays for a harness whose adapter got no windows.

## Out of scope

- Code: this task changes `docs/` only. Schema, adapters, resolver, `models strategy` and the catalog are PB-24…PB-32.
- Anything ADR-003 lists under "Not in v1" that the owner did not reverse: several accounts per harness, mid-run migration, PAYG purchase.

## Verification

- `npx github:Velklish/backslop#v0.4.0 lint` green (ADR row in `docs/README.md`, the ROADMAP goal), `npm run audit` green (no consumer names, no personal data — the spike numbers are not copied into the ADR beyond shapes).
- Every decision above appears in the ADR with the owner and the date; every open design point has one answer and a reason.
