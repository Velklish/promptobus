# PB-4 · The import scanner mistakes a string constant for a specifier and drops the rest of the file

- **Scope:** [reference/03](../../reference/03-cli.md)
- **Created:** 2026-09-04
- **Dependencies:** none
- **Taken:** 2026-09-05

## Context

`test/promptobus-package.test.mjs` walks sources for imports with a pattern shaped like `\bfrom\s*['"]`. In `src/mcp/render.ts` it matches this:

```ts
const MESSAGE_FROM = ' from ';
```

That is a message fragment, not an import. The scanner reads it as a specifier, decides the file imports an external package, and — because the supposed specifier ends at a `;` rather than a quote — stops making sense of everything after it. The rest of the file goes unscanned.

Two separate tracks hit it independently on the same day while translating output, which is how it surfaced at all: nobody was looking for it.

The failure mode is the expensive one. A scanner that reads the wrong thing does not raise; it returns a confident answer about a file it never finished reading. Whatever the check is meant to guarantee — no external imports, a bounded dependency graph — is guaranteed only for the part of the file before the first sentence containing the word "from".

`test/boundary.test.mjs` already handles this: a candidate specifier containing a newline or a `;` is ignored. The same guard is simply missing here.

## Work to do

- Reject candidates that cannot be specifiers, as the boundary check already does.
- Better, if it is cheap: ask the language rather than the text. A scan over the module's own import declarations cannot be confused by prose.

## Out of scope

- Renaming `MESSAGE_FROM`. The constant is fine; the scanner is what reads it wrongly, and renaming it would only hide the next one.

## Verification

- A file containing `const X = ' from '` and a real import after it is scanned in full: the real import is seen, the constant is not reported as one.
- The check fails when an actual external import is added after such a constant. Today it would pass.
