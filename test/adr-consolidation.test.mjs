import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adrDir = path.join(root, 'docs/adr');
const files = readdirSync(adrDir).filter((name) => /^adr-\d{3}-[a-z0-9-]+\.md$/.test(name));
const textOf = (name) => readFileSync(path.join(adrDir, name), 'utf8');

check('adr: no record carries a Superseded status',
  files.every((name) => /^\*\*Status:\*\* Accepted\b/m.test(textOf(name))),
  files.filter((name) => !/^\*\*Status:\*\* Accepted\b/m.test(textOf(name))).join(', '));

const adr021 = textOf('adr-021-task-tree-and-governance-routes.md');
const refusal = adr021.split('## Decision')[1]?.split('## ')[0] ?? '';
const target = refusal.match(/\[ADR-(\d{3})\]\((adr-\d{3}-[a-z0-9-]+\.md)\)/);
const cited = target ? textOf(target[2]) : '';
check('adr: the teamlead refusal ADR-021 cites is a present Accepted record',
  target !== null
    && files.includes(target[2])
    && /^\*\*Status:\*\* Accepted\b/m.test(cited)
    && /Cursor stays refused/.test(cited),
  target ? target[2] : 'no ADR link in the decision');

const index = readFileSync(path.join(root, 'docs/README.md'), 'utf8');
const rows = [...index.matchAll(/^\| \[adr\/(adr-\d{3}-[a-z0-9-]+\.md)\]\(adr\/(adr-\d{3}-[a-z0-9-]+\.md)\) \|/gm)];
const listed = rows.map((row) => row[1]);
check('adr: the index lists exactly the ADR files present',
  listed.length === files.length
  && files.every((name) => listed.includes(name))
  && rows.every((row) => row[1] === row[2])
  && new Set(listed).size === listed.length,
  `files ${files.length}, rows ${listed.length}`);

const adr005 = textOf('adr-005-ten-point-scale-absolute-bands-calibrate.md');
const bands = adr005.split('### Absolute bands')[1]?.split('**4. Overlays.**')[0] ?? '';
check('adr: overlay schemaVersion is 2 and v1 survives only without rating-scale keys',
  adr005.includes('Catalog and overlay `schemaVersion` are both 2')
  && adr005.includes('A v1 overlay is read only when it carries none of `ratings`, `qualityFloor` and `reviewerQualityFloor`')
  && !/schemaVersion` of an overlay stays 1/.test(adr005),
  'the retired v1-only overlay rule came back, or the v1 exception is missing');

check('adr: absolute bands name the dated anchor pairs',
  bands.includes('Terminal-Bench 2.1 | Codex CLI | 60 % | 90 %')
  && bands.includes('40 tokens/s | 310 tokens/s')
  && bands.includes('$2.50 / 1M tokens | $30.00 / 1M tokens')
  && bands.includes('40 → 60 pair for Claude Code')
  && bands.includes('no Codex anchor pair'),
  'the anchor table or the Codex 4.0 refusal is missing');

const adr017 = textOf('adr-017-the-owner-gate-is-a-positive-proof.md');
check('adr: the ownerless exception covers done, stop and dismiss, and sweep does not',
  adr017.includes('`done`, `stop` and `dismiss` all read this answer')
  && adr017.includes('`requireSweeper` demands a recorded owner or a proven approver')
  && !/on `done` only/.test(adr017),
  'the ownerless exception was narrowed to done');
