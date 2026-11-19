# Root thread lifetime

`wc -w skills/orchestrate/SKILL.md` counted 8,671 words on the reviewed base (`92cb85ee0721de8abc284efef0aa712855a721a0`) and 8,633 after clarifying peer reads and non-consuming reconciliation: 38 fewer words of standing instructions. Word count measures the skill text, not billed tokens or the size of a harness turn.

At the batch or context boundary the root checkpoints and stops dispatching. It stays responsible until the owner agrees on a route and responsibility for the original participants. An ordinary claim requires one authorized successor and confirmed predecessor exit; an uncertain result requires reconciliation. Managed recovery keeps the native thread; starting another managed task does not move the first task's state.

Final clarification: `node test/documentation-contract.test.mjs` passed 70/70, including ordinary reads following current bindings and recovery without consuming new root mail. On the previous revision, `node test/model-routing-docs.test.mjs` passed 14/14; `npx --no-install backslop lint` and `npm run audit` exited 0. Earlier, `npm run build` passed; synthetic fixtures `node test/promptobus-harness-identity.test.mjs` (34/34) and `node test/lead-empty-recovery.test.mjs` (10/10) exercised owner-bound mail and same-thread recovery. Runtime code did not change. No live handoff or subscription saving was measured.
