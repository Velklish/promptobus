# PB-29.1 · Result

**Outcome:** completed — closed by PB-37 (ADR-005), item by item.

1. **A benchmark version is a different benchmark** — ADR-005 § Absolute bands: an anchor pair is keyed by benchmark, version and agent harness, and "a figure without all three is not a figure"; `catalog.schema.json` requires `version` in a citation; every base row's `evidence.sources` names it.
2. **The agent harness is part of the figure** — the same three places; the tie rule ("the harness this catalog runs the model on, else the highest published") is in the ADR and repeated in each row's `evidence.text`.
3. **No field size both discriminates and holds still** — there is no field any more: absolute bands read no field, adding or removing a model changes no other model's band; `fieldSize` left the citation shape.
4. **The field was not reproducible** — same, and the supersession row in ADR-005 names it.
5. **The cut PB-29 used** — replaced whole; the arithmetic is stated in the ADR (`clamp(1 + roundHalfUp((x − floor) / (ceiling − floor) × 9), 1, 10)`).
- **The `hypothesis` wording defect** — superseded in ADR-005's table and the stale sentence removed from `catalog.schema.json`; a hypothesis is a row marked as such, not a row omitted.
- **Flattened ladders** — every rung stays; `validate` warns `ladder-indistinguishable`.
- **`speed` banded on throughput and interpolated as latency** — `speed` is constant along the ladder; the token effect lives in `quotaCost`.
- **Interpolation carrying a row up to the reviewer floor** — the reviewer role needs the base row at or above the floor; `codex-gpt55-xhigh` is a worker row and a constructed negative test guards the rule.

No separate commit: the work is PB-37's.
