# PB-22 · The publicity audit reads a link example inside a code span as a link

- **Scope:** [README](../../reference/README.md)
- **Created:** 2026-09-05
- **Dependencies:** none

## Context

Found while writing PB-2.3, whose subject is a citation the same gate does not
check. Writing about markdown link syntax in a markdown file reddens `npm run
audit`.

The link half of `scripts/audit-public.mjs` says which lines it treats as prose:

```js
const LINK = /\]\(([^)#\s]+?)\)/g;
const proseOf = (rel, text) => (rel.endsWith('.md')
  ? text
  : text.split('\n').filter((l) => /^\s*(\/\/|\*)/.test(l)).join('\n'));
```

In a `.md` file every line is prose, deliberately — the comment above it explains
that in code only comment lines are examined, because the pattern also occurs
inside regular expressions and string literals. What it does not exclude in
markdown is a **code span or a fenced block**, so a sentence that quotes the link
pattern is parsed as a link to whatever the example names.

Reproduced on this tree: a triage entry containing the pattern in backticks made
the gate report

```text
✖ link resolves to nothing: docs/backlog/triage/PB-2.3-…md → …
✖ publicity audit: 1 finding(s)
```

— the target being the ellipsis from the example. The entry was reworded and the
gate went clean (323 tracked files, a 112-entry tarball). So the cost today is one
person's round trip, and the workaround is to describe link syntax without writing
it. That is a poor rule for a repository whose documentation explains its own
tooling.

The neighbouring danger is the opposite one and is worth stating so a fix does not
create it: a fenced block that quotes a REAL relative path stops being checked
once code is excluded. That is correct — a quoted path is an example, not a link
the reader can follow — but it means a fix trades one class of miss for the false
positive it removes.

## Work to do

- Strip fenced blocks and inline code spans from a markdown file before applying
  `LINK`, in `proseOf`. Fences first, then spans, so a backtick inside a fence
  does not unbalance the span pass.
- Keep the two `.md` and non-`.md` branches one function: the forbidden-string
  scan reads the whole file and must keep doing so — a leaked host name inside a
  code block is still a leak. Only the link pass gets the narrower text.

## Out of scope

- The forbidden-string scan, which is a different question about the same file and
  must stay whole-file.
- Bare filenames in prose that name a file that does not exist — that is PB-2.3,
  and widening the checker to catch them would report far more than one line.

## Verification

- A markdown file containing a link-syntax example inside backticks and inside a
  fenced block passes the audit; the same example written as a real link to a
  missing file still fails it.
- Mutation probe: break one real link in `docs/` and the audit still names it.
