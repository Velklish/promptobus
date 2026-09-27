// Gate: tracked Markdown links resolve, and the task-link baseline only shrinks.
// What it covers: guides/contributing.md § Documentation links.
import './home.mjs';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { CLAUDE_SKILLS_REL, CODEX_SKILLS_REL, CURSOR_SKILLS_REL } from '../lib/drivers.js';
import { packageSkills } from '../lib/install.js';
import {
  INSTALL_LAYOUT, anchorsOf, audit, classifyHttpStatus, classifyTransportFailure,
  collect, multisetDiff, packedPaths, skillFiles, uniqueSlugs,
} from '../scripts/docs-links.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = JSON.parse(readFileSync(path.join(ROOT, 'test', 'fixtures', 'docs-links-baseline.json'), 'utf8'));

function ctxFor(docs, over = {}) {
  return {
    root: ROOT,
    tracked: new Set(over.tracked ?? docs.map((doc) => doc.rel)),
    packed: new Set(over.packed ?? []),
    skills: over.skills ?? [],
    installed: new Set(over.installed ?? []),
  };
}

const live = audit(ROOT);
process.stdout.write(`docs-links: ${live.files} files, ${live.links} links, ${live.external} external\n`);

check('the inventory names files and links', live.files > 0 && live.links > 0,
  `${live.files} files, ${live.links} links`);

const none = collect([], ctxFor([]));
const quiet = collect([{ rel: 'README.md', text: 'No links here.\n' }], ctxFor([{ rel: 'README.md' }]));
check('an empty inventory is a failure', none.empty && none.files === 0 && quiet.empty && quiet.links === 0,
  `files ${none.files}, links ${quiet.links}`);

check('local links resolve in the source tree', live.sourceFailures.length === 0,
  live.sourceFailures.slice(0, 8).join(' | '));

const taskDiff = multisetDiff(BASELINE.taskDependencies, live.taskDependencies);
check('task dependencies match the baseline', taskDiff.stale.length === 0 && taskDiff.added.length === 0,
  `added ${taskDiff.added.join(' | ')} stale ${taskDiff.stale.join(' | ')}`);

const deliveryDiff = multisetDiff(BASELINE.delivery, live.deliveryMisses);
check('delivery links match the baseline', deliveryDiff.stale.length === 0 && deliveryDiff.added.length === 0,
  `added ${deliveryDiff.added.join(' | ')} stale ${deliveryDiff.stale.join(' | ')}`);

const missing = collect(
  [{ rel: 'README.md', text: '[gone](no-such.md)\n' }],
  ctxFor([{ rel: 'README.md' }]),
);
check('a missing file is reported', missing.sourceFailures.length === 1, missing.sourceFailures.join(' | '));

const renamed = collect(
  [{ rel: 'docs/guide.md', text: '# Old title\n\n[here](#old-title)\n[there](#new-title)\n' }],
  ctxFor([{ rel: 'docs/guide.md' }]),
);
check('a renamed heading is reported',
  renamed.sourceFailures.length === 1 && renamed.sourceFailures[0].includes('missing anchor'),
  renamed.sourceFailures.join(' | '));

const reference = collect(
  [{ rel: 'docs/guide.md', text: 'See [the note][note].\n\n[note]: missing.md\n' }],
  ctxFor([{ rel: 'docs/guide.md' }]),
);
check('a broken reference-style link is reported',
  reference.sourceFailures.some((line) => line.includes('missing.md')),
  reference.sourceFailures.join(' | '));

const html = collect(
  [{ rel: 'docs/guide.md', text: '<a href="missing.html">x</a>\n' }],
  ctxFor([{ rel: 'docs/guide.md' }]),
);
check('a broken HTML link is reported', html.sourceFailures.length === 1, html.sourceFailures.join(' | '));

const longerFence = collect(
  [{
    rel: 'docs/guide.md',
    text: '````markdown\n```bash\nnpm i\n```\n\n[gone](missing.md)\n````\n\n[real](also-missing.md)\n',
  }],
  ctxFor([{ rel: 'docs/guide.md' }]),
);
check('a longer fence stays closed across a shorter one',
  longerFence.sourceFailures.length === 1
  && longerFence.sourceFailures[0].includes('-> also-missing.md')
  && !longerFence.sourceFailures.some((line) => line.includes('-> missing.md')),
  longerFence.sourceFailures.join(' | '));

const badge = collect(
  [{ rel: 'README.md', text: '[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](missing-license)\n' }],
  ctxFor([{ rel: 'README.md' }]),
);
check('a badge keeps its outer destination',
  badge.links === 2 && badge.external === 1
  && badge.sourceFailures.some((line) => line.includes('missing-license')),
  `links ${badge.links}, external ${badge.external}, ${badge.sourceFailures.join(' | ')}`);

const firstDef = collect(
  [{ rel: 'docs/guide.md', text: 'See [read][r].\n\n[r]: missing.md\n\n[r]: README.md\n' }],
  ctxFor([{ rel: 'docs/guide.md' }, { rel: 'README.md', text: '# Readme\n' }]),
);
check('the first reference definition is the one that is used',
  firstDef.sourceFailures.some((line) => line.startsWith('docs/guide.md:1 ') && line.includes('missing.md')),
  firstDef.sourceFailures.join(' | '));

const commented = collect(
  [{ rel: 'docs/guides/contributing.md', text: '<!--\n## Documentation links\n-->\n\nSee [the section](#documentation-links).\n' }],
  ctxFor([{ rel: 'docs/guides/contributing.md' }]),
);
check('a commented-out heading does not keep its anchor',
  commented.sourceFailures.some((line) => line.includes('missing anchor')),
  commented.sourceFailures.join(' | '));

const hidden = collect(
  [{ rel: 'docs/guide.md', text: '# Foo\n\n<!--\n# Foo\n-->\n\n# Foo\n\n[second](#foo-1)\n[third](#foo-2)\n' }],
  ctxFor([{ rel: 'docs/guide.md' }]),
);
check('a heading inside a comment is not an anchor',
  hidden.sourceFailures.some((line) => line.includes('#foo-2'))
  && !hidden.sourceFailures.some((line) => line.includes('#foo-1')),
  hidden.sourceFailures.join(' | '));

const dupes = anchorsOf('# Foo\n\n# Foo\n\n[second](#foo-1)\n');
check('duplicate headings take GitHub suffixes',
  uniqueSlugs(['foo', 'foo', 'foo']).join(',') === 'foo,foo-1,foo-2' && dupes.has('foo') && dupes.has('foo-1'),
  [...dupes].join(','));

const named = anchorsOf('<a id="kept"></a>\n\n[id](#kept)\n');
check('an explicit id is an anchor', named.has('kept'));

const retired = collect([
  { rel: 'CHANGELOG.md', text: 'See [a](docs/guides/model-routing.md#participant-telemetry).\n' },
  { rel: 'docs/guides/model-routing.md', text: '### Participant telemetry: the collecting half\n' },
], ctxFor([
  { rel: 'CHANGELOG.md' },
  { rel: 'docs/guides/model-routing.md' },
]));
check('the retired changelog anchors are rejected',
  retired.sourceFailures.length === 1 && retired.sourceFailures[0].includes('missing anchor'),
  retired.sourceFailures.join(' | '));

check('external failures stay unverified or dead',
  classifyHttpStatus(200) === 'ok'
  && classifyHttpStatus(302) === 'ok'
  && classifyHttpStatus(404) === 'dead'
  && classifyHttpStatus(410) === 'dead'
  && classifyHttpStatus(401) === 'unverified'
  && classifyHttpStatus(403) === 'unverified'
  && classifyHttpStatus(429) === 'unverified'
  && classifyHttpStatus(503) === 'unverified'
  && classifyTransportFailure() === 'unverified'
  && classifyHttpStatus(429) !== 'dead'
  && classifyHttpStatus(503) !== 'ok');

const packRoot = mkdtempSync(path.join(tmpdir(), 'docs-links-pack-'));
mkdirSync(path.join(packRoot, 'docs'));
writeFileSync(path.join(packRoot, 'package.json'), JSON.stringify({
  name: 'docs-links-pack', version: '1.0.0', files: ['docs'],
}));
writeFileSync(path.join(packRoot, 'docs', 'guide.md'), '[pkg](../package.json)\n[secret](secret.md)\n');
writeFileSync(path.join(packRoot, 'docs', 'secret.md'), 'hidden\n');
writeFileSync(path.join(packRoot, 'docs', '.npmignore'), 'secret.md\n');
const packSet = new Set(packedPaths(packRoot));
const packedDoc = collect(
  [{ rel: 'docs/guide.md', text: '[pkg](../package.json)\n[secret](secret.md)\n' }],
  {
    root: packRoot,
    tracked: new Set(['docs/guide.md', 'docs/secret.md', 'package.json']),
    packed: packSet,
    skills: [],
    installed: new Set(),
  },
);
rmSync(packRoot, { recursive: true, force: true });
check('a link to package.json is delivered',
  packSet.has('package.json')
  && !packedDoc.deliveryMisses.some((line) => line.includes('package.json')),
  packedDoc.deliveryMisses.join(' | '));
check('an ignored file under a packed directory is not delivered',
  !packSet.has('docs/secret.md')
  && packedDoc.deliveryMisses.some((line) => line.includes('secret.md')),
  `packed ${[...packSet].join(', ')} misses ${packedDoc.deliveryMisses.join(' | ')}`);

check('install layout matches the drivers',
  INSTALL_LAYOUT.map((place) => place.skillsRel).join('\n')
    === [CLAUDE_SKILLS_REL, CURSOR_SKILLS_REL, CODEX_SKILLS_REL].join('\n'));

const packedSkills = packageSkills().map((skill) => `${skill.name}:${skill.files.map((file) => file.rel).join(',')}`);
const walkedSkills = skillFiles(ROOT).map((skill) => `${skill.name}:${skill.files.join(',')}`);
check('skill files match the installer', packedSkills.join('\n') === walkedSkills.join('\n'),
  walkedSkills.join(' | '));
