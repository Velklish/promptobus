# Root thread lifetime

`wc -w skills/orchestrate/SKILL.md` counted 8,671 words on the reviewed base (`92cb85ee0721de8abc284efef0aa712855a721a0`) and 8,530 with the handoff procedure: 141 fewer words of standing instructions. The reduction comes from shortening model-routing guidance. Word count measures the skill text, not billed tokens or the size of a harness turn.

The skill now ends an assignment at the agreed batch or context boundary. Its handoff records the facts a new conversation needs and the checks required before it can act. A mailbox transfer requires a named successor and an ended ordinary owner. Managed recovery keeps the native thread; starting another managed task does not move the first task's state.

Focused verification: `npm run build` passed; `node test/documentation-contract.test.mjs` passed 67/67; `node test/model-routing-docs.test.mjs` passed 13/13. Synthetic fixtures `node test/promptobus-harness-identity.test.mjs` (34/34) and `node test/lead-empty-recovery.test.mjs` (10/10) exercised owner-bound mail and same-thread recovery. No live handoff or subscription saving was measured.
