# PB-220 · Result

**Closed 2026-09-16, merged into `PB-217`.** The three defects found in one handover round on 2026-09-13 — a dotfile name hidden from listing, an ack silent about identical bytes, and a gate record nobody validates — sit on one path and are fixed in one place: `placeFile` / `linkBlob` in `lib/store.js` and the text of the delivery acknowledgement. Fixed apart, they are three passes over the same file and three edits of the same sentence. The measurement, the decision it asks for and its checks are preserved verbatim as part 2 of `PB-217`; nothing of this card was dropped.

**Verification.** `npx github:Velklish/backslop#v0.8.0 lint` exit 0 after the merge. No code was changed by this pass.

**Documentation in the same pass.** Not required — the card never landed a change.
