# PB-457 · Remove redundant Host assertions and align catch bindings

- **Order:** 800
- **Scope:** [Typed runtime](../../reference/README.md)
- **Created:** 2026-11-18
- **Dependencies:** none
- **Cost:** minor

## Work to do

- [PB-415.6 · Indent typed catch bindings with their enclosing blocks](../minor/PB-415.6-typescript-catch-binding-indent.md).
- [PB-415.8 · Use the minimal pipeline Host contract without full Host assertions](../minor/PB-415.8-remove-bb-host-full-host-assertions.md).

## Verification

Check the narrow Host interface compiles and the indentation-only changes leave emitted behavior unchanged. Record the outcome against each original finding before archiving it.
