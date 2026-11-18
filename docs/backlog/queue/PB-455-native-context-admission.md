# PB-455 · Preserve repository diagnostics and bound native context file reads

- **Order:** 780
- **Scope:** [Native task context](../../reference/README.md)
- **Created:** 2026-11-18
- **Dependencies:** none
- **Cost:** minor

## Work to do

- [PB-392.1 · Keep actionable repository diagnostics before native context mismatch](../minor/PB-392.1-native-context-diagnostic-precedence.md).
- [PB-392.2 · Refuse a selected source changed to FIFO before blocking open](../minor/PB-392.2-native-selected-source-fifo-open.md).

## Verification

Verify both refusal contracts with unchanged participant state and bounded file handling, preserving normal files and modes. Record the outcome against each original finding before archiving it.
