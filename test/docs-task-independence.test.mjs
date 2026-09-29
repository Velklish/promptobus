// Consumer documentation stands without a task record or a private run file.
// This list is the set. docs/adr/ is outside it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { linksOf } from '../scripts/docs-links.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const trackedSet = new Set(tracked);

const roots = [
  'README.md',
  'README.ru.md',
  'docs/README.md',
  'docs/GLOSSARY.md',
  'docs/ROADMAP.md',
];
const agentsDir = ['.', 'agents'].join('');
const projectSkills = `${agentsDir}/skills/`;
const trees = ['docs/guides/', 'docs/reference/', 'skills/', projectSkills];
const fixtureReadme = (file) => file.startsWith('test/fixtures/') && file.endsWith('/README.md');

export const consumerDocs = tracked.filter((file) => file.endsWith('.md')
  && (roots.includes(file) || trees.some((prefix) => file.startsWith(prefix)) || fixtureReadme(file)));

const adrRow = /^\| \[adr\//;
const adrRule = /^Create a new ADR with /;

function linesOf(file) {
  return readFileSync(path.join(root, file), 'utf8').split('\n').flatMap((line, index) => {
    if (file === 'docs/README.md' && (adrRow.test(line) || adrRule.test(line))) return [];
    return [{ file, line: index + 1, text: line }];
  });
}

const body = consumerDocs.flatMap(linesOf);
const taskId = /\bPB-\d+(?:\.\d+)?\b/;
const reportSection = /REPORT §/;
const productJson = new Set([
  'promptobus.json', 'hooks.json', 'auth.json', 'state.json', 'holder.json', 'stalls.json',
  'migrating.json', 'migrated.json', 'manifest.json', 'model-routing.json', 'cache.json',
  'package.json', 'tsconfig.json', 'backslop.json',
]);

/** Destinations come from the documentation-link parser, including titles and reference links. */
function destinations(text) {
  return linksOf(text).flatMap((link) => (link.dest == null ? [] : [{ line: link.line, dest: link.dest }]));
}

function localFile(dest) {
  if (!dest || /^[a-z][a-z0-9+.-]*:/i.test(dest)) return null;
  return dest.split('#')[0].split('?')[0];
}

function sameRepoTaskDest(dest) {
  if (!/^https?:\/\//i.test(dest)) return null;
  let url;
  try { url = new URL(dest); } catch { return null; }
  if (url.hostname.toLowerCase() !== 'github.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 5) return null;
  if (parts[0].toLowerCase() !== 'velklish' || parts[1].toLowerCase() !== 'promptobus') return null;
  if (parts[2] !== 'blob' && parts[2] !== 'tree') return null;
  const rest = decodeURIComponent(parts.slice(3).join('/'));
  const at = rest.search(/(?:^|\/)docs\/(?:backlog|archive)\//i);
  if (at !== -1) return rest.slice(at === 0 ? 0 : at + 1);
  return /(?:^|\/)docs\/TRACKS\.md$/i.test(rest) ? 'docs/TRACKS.md' : null;
}

function isTracker(dest) {
  if (sameRepoTaskDest(dest)) return true;
  const file = localFile(dest);
  if (file == null) return false;
  return /(?:^|\/)(?:backlog|archive)\//i.test(file) || /(?:^|\/)TRACKS\.md$/i.test(file);
}

function candidates(fromRel, raw) {
  const clean = localFile(raw);
  if (clean == null || clean === '') return [];
  if (clean.startsWith('./') || clean.startsWith('../')) {
    return [path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), clean))];
  }
  if (clean.startsWith('/')) return [path.posix.normalize(clean.slice(1))];
  if (clean.includes('/')) {
    return [
      path.posix.normalize(clean),
      path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), clean)),
    ];
  }
  return [clean];
}

function isTrackedPath(cands) {
  return cands.some((cand) => {
    if (!cand || cand === '..' || cand.startsWith('../')) return false;
    if (trackedSet.has(cand)) return true;
    if (!cand.includes('/')) {
      for (const file of trackedSet) if (file === cand || file.endsWith(`/${cand}`)) return true;
    }
    return false;
  });
}

// Templates (`<…>`, `*`) are skipped in isPrivateEvidence; an untracked concrete name passes only
// as a product file, a listed location, or a naming example below.
const namingExamples = new Map([
  ['docs/reference/04-protocol.md', new Set(['.gates-t2.json', 'gates-t2.json', 'gates-x-2.json'])],
]);
const productLocations = new Set([
  '~/.promptobus/model-routing.json', '~/.promptobus/model-routing/cache.json',
  `~/${agentsDir}/model-routing/cache.json`, '.promptobus/manifest.json',
  '.claude/settings.json', '~/.claude/.credentials.json',
  '.cursor/mcp.json', '.cursor/cli.json', '.cursor/hooks.json', '~/.cursor/cli-config.json',
  '.codex/hooks.json', '~/.codex/hooks.json', '$CODEX_HOME/hooks.json',
  'waits/warden.exit.json', 'waits/warden.gen.json',
]);

function isPlaceholder(clean, fromRel) {
  if (clean.includes('/')) return false;
  if (/^\.(?:json|jsonl|txt)$/.test(clean)) return true;
  if (namingExamples.get(fromRel)?.has(clean)) return true;
  return productJson.has(clean) || clean === '.mcp.json';
}

function isDocumentedProductLocation(clean) {
  return productLocations.has(clean);
}

function isPrivateEvidence(raw, fromRel) {
  const clean = localFile(raw);
  if (clean == null || /[\s*<>{}]/.test(clean)) return false;
  if (!/\.(?:json|jsonl|txt)$/i.test(clean)) return false;
  if (isTrackedPath(candidates(fromRel, clean))) return false;
  if (isPlaceholder(clean, fromRel) || isDocumentedProductLocation(clean)) return false;
  return true;
}

function evidenceIn(text, fromRel) {
  const hits = [];
  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    if (isPrivateEvidence(match[1].trim(), fromRel)) hits.push(match[1].trim());
  }
  for (const link of destinations(text)) {
    if (isPrivateEvidence(link.dest, fromRel)) hits.push(link.dest);
  }
  for (const match of text.matchAll(/\blive\.[A-Za-z0-9]+\b/g)) hits.push(match[0]);
  return hits;
}

const texts = new Map(consumerDocs.map((file) => [file, readFileSync(path.join(root, file), 'utf8')]));
const taskIds = body.filter((row) => taskId.test(row.text));
const reports = body.filter((row) => reportSection.test(row.text));
const trackerLinks = [...texts.entries()].flatMap(([file, text]) => destinations(text)
  .filter((link) => isTracker(link.dest))
  .map((link) => ({ file, line: link.line, target: link.dest })));
const artifacts = [...texts.entries()].flatMap(([file, text]) => {
  const hits = evidenceIn(text, file);
  if (hits.length === 0) return [];
  return hits.map((name) => ({ file, line: 0, name }));
});

const show = (rows, extra = (row) => '') => rows
  .map((row) => `${row.file}:${row.line}${extra(row)}`)
  .join('; ');

const titled = destinations('[history](../archive/LOG.md "history")');
const referenced = destinations('[history][record]\n\n[record]: ../archive/LOG.md');
const archiveUrl = destinations(
  '[measurement](https://github.com/Velklish/promptobus/blob/main/docs/archive/LOG.md#pb-243)\n'
  + '[queue](https://github.com/Velklish/promptobus/tree/release/1.0/docs/backlog/README.md)',
);
const foreignUrl = destinations('[codex](https://github.com/openai/codex/blob/main/codex-rs/README.md)');
const fromGuide = 'docs/guides/example.md';

check('docs: the consumer set is non-empty', consumerDocs.length >= 8, String(consumerDocs.length));
check('docs: the consumer set includes fixture READMEs and project skills',
  consumerDocs.includes('test/fixtures/codex-app-server/0.146.0/README.md')
  && consumerDocs.includes('docs/guides/model-routing.md')
  && consumerDocs.includes('docs/guides/releasing.md')
  && consumerDocs.includes(`${projectSkills}tech-writer/SKILL.md`)
  && !consumerDocs.some((file) => file.startsWith('docs/adr/')),
  String(consumerDocs.length));
check('docs: consumer set has no task identifier', taskIds.length === 0, show(taskIds));
check('docs: consumer set does not link into the tracker', trackerLinks.length === 0,
  show(trackerLinks, (row) => ` -> ${row.target}`));
check('docs: a titled inline link into the archive is refused',
  titled.some((link) => isTracker(link.dest)), titled.map((link) => link.dest).join(','));
check('docs: a reference link into the archive is refused',
  referenced.some((link) => isTracker(link.dest)), referenced.map((link) => link.dest).join(','));
check('docs: a same-repository archive URL is refused',
  archiveUrl.length === 2 && archiveUrl.every((link) => isTracker(link.dest)),
  archiveUrl.map((link) => link.dest).join(','));
check('docs: an unrelated external link is not a task link',
  foreignUrl.length > 0 && foreignUrl.every((link) => !isTracker(link.dest)),
  foreignUrl.map((link) => link.dest).join(','));
check('docs: consumer set cites no missing run artifact', artifacts.length === 0,
  show(artifacts, (row) => ` ${row.name}`));
check('docs: a relative evidence path is refused',
  evidenceIn('`runs/codex-stop-live-evidence.json`', fromGuide).includes('runs/codex-stop-live-evidence.json'));
check('docs: an evidence link is refused',
  evidenceIn('[log](../runs/session.txt)', fromGuide).includes('../runs/session.txt'));
check('docs: a jsonl transcript is refused',
  evidenceIn('`session.jsonl`', fromGuide).includes('session.jsonl'));
check('docs: a text transcript is refused',
  evidenceIn('`turn.txt`', fromGuide).includes('turn.txt'));
check('docs: a stand locator is refused',
  evidenceIn('shown in `live.ej1Piv`', fromGuide).includes('live.ej1Piv'));
check('docs: a tracked fixture file is not a missing artifact',
  evidenceIn('`TokenUsage-0.146.0-2026-09-12.json`', fromGuide).length === 0);
check('docs: a product placeholder is not a missing artifact',
  evidenceIn('`promptobus.json`', fromGuide).length === 0
  && evidenceIn('`~/.promptobus/model-routing.json`', fromGuide).length === 0
  && evidenceIn('`.cursor/hooks.json`', fromGuide).length === 0
  && evidenceIn('`waits/warden.exit.json`', fromGuide).length === 0);
check('docs: a relative product-named capture is refused',
  evidenceIn('`../runs/proof/state.json`', fromGuide).includes('../runs/proof/state.json')
  && evidenceIn('`../runs/.mcp.json`', fromGuide).includes('../runs/.mcp.json'));
check('docs: a concrete gates or handover path is refused',
  evidenceIn('`../runs/gates-review.json`', fromGuide).includes('../runs/gates-review.json')
  && evidenceIn('`../runs/handover-note.json`', fromGuide).includes('../runs/handover-note.json'));
check('docs: a bare gates or handover capture is refused',
  evidenceIn('`gates-review.json`', fromGuide).includes('gates-review.json')
  && evidenceIn('[record](handover-review.json)', fromGuide).includes('handover-review.json'));
check('docs: a concrete capture under a product root is refused',
  evidenceIn('`.promptobus/tasks/run-20260927/files/evidence.json`', fromGuide)
    .includes('.promptobus/tasks/run-20260927/files/evidence.json')
  && evidenceIn('`~/.promptobus/tasks/run-20260927/files/gates-w.json`', fromGuide)
    .includes('~/.promptobus/tasks/run-20260927/files/gates-w.json'));
check('docs: a record template and a documented product location are not captures',
  evidenceIn('`gates-<slug>.json` `handover-*.json` `.promptobus/manifest.json`', fromGuide).length === 0
  && evidenceIn('`~/.claude/jobs/<id>/state.json` `$CODEX_HOME/hooks.json` `.mcp.json`', fromGuide).length === 0);
check('docs: the gate-record naming examples are legal in 04-protocol only',
  evidenceIn('`.gates-t2.json` `gates-t2.json` `gates-x-2.json`', 'docs/reference/04-protocol.md').length === 0
  && ['.gates-t2.json', 'gates-t2.json', 'gates-x-2.json']
    .every((name) => evidenceIn(`\`${name}\``, fromGuide).includes(name)));
check('docs: consumer set cites no unidentified report section', reports.length === 0, show(reports));
check('docs: the planning snapshot is not a tracked file',
  !trackedSet.has('docs/TRACKS.md') && !existsSync(path.join(root, 'docs/TRACKS.md')),
  'docs/TRACKS.md');
