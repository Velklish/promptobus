# PB-321 · An explicitly named model and effort lift in any role

- **Scope:** [03. CLI § An explicit model the catalog does not rate](../../reference/03-cli.md#an-explicit-model-the-catalog-does-not-rate)
- **Created:** 2026-10-03
- **Dependencies:** none
- **Cost:** major
- **Previous order:** 250
- **Taken:** 2026-10-06

## Context

On 2026-10-03 the owner of a run decided to cap Codex participants at effort `xhigh` to save the weekly window: workers on `gpt-6-sol xhigh`, reviewers on `gpt-6-astra xhigh`. The reviewer lift was refused before anything was written:

```
promptobus review <worktree> --task <id> --harness codex --model gpt-6-astra --effort xhigh
→ exit 1, "chosen: none · nothing survived filtering"
  codex-gpt6-astra-xhigh … role-not-allowed: rated for worker, approver only
```

`models --role reviewer` at v0.22.0 admits only two Codex tuples for the role: `gpt-6-astra` `ultra` and `max`. Every other Codex tuple is `role-not-allowed`. The row is `models/catalog.json:2736`, `roles: ["worker", "approver"]`. The owner had to take `max`, above the cap they chose.

The person has no way to override this:

- An explicit `--model` and `--effort` do not override it. The resolver drops the tuple at step 3 (`lib/model-routing/resolver.js:301-302`), after the constraints.
- An overlay does not override it either: "no overlay may patch roles" (`lib/model-routing/validate.js:865`).

The package already lets the person's choice win in two neighbouring cases:

- A `--model` the catalog does not rate lifts unrouted, as typed ([An explicit model the catalog does not rate](../../reference/03-cli.md#an-explicit-model-the-catalog-does-not-rate)).
- A tuple whose window is nearly spent is not refused when `--harness` or `--model` names it: "the person named it, the person spends it" ([Model routing](../../reference/03-cli.md#model-routing)).

A rated model named for a role it is not rated for is the one case where the catalog overrules the person.

## Work to do

- When `--model` names a tuple, and `--effort` names its effort if the tuple's model has more than one, a `role-not-allowed` exclusion does not refuse the lift. The tuple is scored and the decision carries a warning: the role it is not rated for and the roles it is rated for. The policy (`allow`/`deny` of every layer) still refuses as today.
- Decide whether an overlay may widen a tuple's `roles`, so a person can make the choice durable without flags. Record the answer in the reference and in the validation rule.
- Routing without a named model keeps the role filter: the catalog still decides for a person who did not choose.
- Update `skills/orchestrate/SKILL.md` and the reference where they describe the role filter.

## Out of scope

- Changing which roles the catalog rates a tuple for.

## Verification

- `review --harness codex --model gpt-6-astra --effort xhigh --dry-run` exits 0 and names the role warning; the same without `--model` still routes only to tuples rated for `reviewer`.
- A `deny.models` rule for the named model still refuses the lift.
- `npm test` and the repository gates exit 0.
