# PB-221 · Result

**Closed 2026-09-16, merged into `PB-222`.** `PB-222` covers the same defect across all three harnesses and already names this one as its "first harness": a role that works in the clone root has nowhere safe to put its project layer. This card was the Cursor-only half of it, and keeping it apart meant two cards asking the same question of one driver. Its measurement task and its checks — a live session with the configuration outside the working directory, the negative control with it inside, and hooks measured separately from the MCP configuration — are preserved verbatim in `PB-222` as the section "Замер по Cursor".

**Verification.** `npx github:Velklish/backslop#v0.8.0 lint` exit 0 after the merge. No code was changed by this pass.

**Documentation in the same pass.** Not required — the card never landed a change.
