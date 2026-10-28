// BB evidence requires coverage now. Native send still omits it until the installed schema
// accepts the field. The two texts are different doors: 04-protocol.md § BB evidence attachments.
import './home.mjs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

function requiresCoverageNow(text) {
  const names = text.includes('coverage.establishes') && text.includes('coverage.doesNotEstablish');
  const deferred = text.includes('so omit it') || text.includes('From the release that ships');
  return names && !deferred;
}

function validatorRequiresCoverage(source) {
  const at = source.indexOf("if (probe.status === 'complete')");
  const end = source.indexOf('const state = manifest.checks.treeState', at);
  if (at < 0 || end < 0) return false;
  const match = source.slice(at, end).match(/coverage:\s*z\.object\(\{[\s\S]*?\}\)\.strict\(\)/);
  if (!match) return false;
  return match[0].includes('establishes:') && match[0].includes('doesNotEstablish:') && !match[0].includes('.optional()');
}

const workerSource = read('lib/prompts/bb.js');
const workerSkill = read('integrations/bb/skills/promptobus-worker/SKILL.md');
const validator = read('integrations/bb/review-evidence.ts');
const worker = requiresCoverageNow(workerSource) && requiresCoverageNow(workerSkill);
const required = validatorRequiresCoverage(validator);

check('BB worker text and the evidence validator agree that a complete probe requires coverage',
  worker === required && worker === true,
  `worker ${worker}, validator ${required}`);
