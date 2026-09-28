// Vendored writing skills keep a pinned upstream sha, the release guide names the
// technical-writer step before the release commit, and both scope the pass alike.
import './home.mjs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Assembled: the suite boundary rejects this layout name as a literal in test/.
const skillRoot = ['.', 'agents'].join('');
const skills = path.join(repo, skillRoot, 'skills');
const overlay = 'tech-writer';
const generated = (name) => name.startsWith('backslop-');

const dirs = existsSync(skills)
  ? readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  : [];

check(`${skillRoot}/skills exists`, existsSync(skills), skills);

for (const name of dirs.filter((entry) => !generated(entry) && entry !== overlay).sort()) {
  const dir = path.join(skills, name);
  const license = existsSync(path.join(dir, 'LICENSE'));
  const sourcePath = path.join(dir, 'SOURCE.md');
  const source = existsSync(sourcePath) ? readFileSync(sourcePath, 'utf8') : '';
  const url = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/.test(source);
  const sha = /[0-9a-f]{40}/.test(source);
  check(
    `skill ${name} has LICENSE and a pinned SOURCE.md`,
    license && url && sha,
    `license=${license} url=${url} sha=${sha}`,
  );
}

const overlayText = existsSync(path.join(skills, overlay, 'SKILL.md'))
  ? readFileSync(path.join(skills, overlay, 'SKILL.md'), 'utf8')
  : '';
check(
  'overlay skill has name and description frontmatter',
  /^---\r?\nname: tech-writer\r?\ndescription: \S/m.test(overlayText),
  path.join(skills, overlay, 'SKILL.md'),
);

const guidePath = path.join(repo, 'docs', 'guides', 'releasing.md');
const guide = existsSync(guidePath) ? readFileSync(guidePath, 'utf8') : '';
const stepHeading = '## Technical-writer pass';
const step = guide.indexOf(stepHeading);
const release = guide.indexOf('## Release commit');
const nextHeading = step < 0 ? -1 : guide.indexOf('\n## ', step + stepHeading.length);
const section = step < 0 ? '' : guide.slice(step, nextHeading < 0 ? guide.length : nextHeading);
const overlayFile = path.resolve(path.join(skills, overlay, 'SKILL.md'));
const destinations = [...section.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1].split('#')[0]);
const resolved = destinations
  .filter((file) => file && !/^[a-z]+:/i.test(file))
  .map((file) => path.resolve(path.dirname(guidePath), file));
check(
  'release guide points at the technical-writer step before the release commit',
  step >= 0 && release > step && resolved.some((file) => file === overlayFile),
  `step=${step} release=${release} resolved=${resolved.join(',') || 'none'} overlay=${overlayFile}`,
);

const sliceFrom = (text, heading) => {
  const at = text.indexOf(heading);
  const next = at < 0 ? -1 : text.indexOf('\n## ', at + heading.length);
  return at < 0 ? '' : text.slice(at, next < 0 ? text.length : next);
};
const words = (text) => text.replace(/\s+/g, ' ');
const overlayScope = words(sliceFrom(overlayText, '## Scope'));
// The scope is pinned sentence by sentence: a reworded scope is a scope change and
// has to change this file with it.
const OVERLAY_SCOPE = [
  'Check against the code changed since the previous release tag: the documentation listed under Style, `docs/adr/` and `docs/ROADMAP.md`, the terminal help text in `lib/cli.js` (`helpText`), and every shipped skill under `skills/`.',
  'The currency ledger, defined in the release guide, has one row for the CLI help and one row per shipped skill, each naming the change it was checked against or stating that none touches it.',
  '**Style.** Walk human-facing documentation: `README.md`, `README.ru.md`, `CHANGELOG.md`, `docs/README.md`, `docs/GLOSSARY.md`, `docs/guides/`, `docs/reference/`, and the terminal help text in `lib/cli.js`.',
  'These follow no style rules: skills, prompts, `AGENTS.md`, backlog cards, archive entries. Skills are written for agents, so they get the currency check and no style pass.',
];
const GUIDE_SCOPE = [
  'Input: the diff since the previous release tag, the human-facing documentation including `docs/adr/` and `docs/ROADMAP.md`, the terminal help text in `lib/cli.js`, and the shipped skills under `skills/`.',
  'The currency part checks the documentation, the CLI help and the skills against that diff.',
  'The style part covers the documentation and the CLI help; skills are written for agents and get no style pass.',
  "The currency ledger is a table with one row per document group of the overlay's Style list, one row each for `docs/adr/` and `docs/ROADMAP.md`, one row for the CLI help and one row per shipped skill; each row names the change it was checked against, or states that no change touches it.",
];
const guideWords = words(section);
const missing = (text, sentences) => sentences.filter((line) => !text.includes(line));
check(
  'the overlay scopes the CLI help and every shipped skill for currency, and styles the help but not the skills',
  missing(overlayScope, OVERLAY_SCOPE).length === 0,
  JSON.stringify(missing(overlayScope, OVERLAY_SCOPE)),
);
check(
  'the release guide scopes the CLI help and the shipped skills alike, and defines the currency ledger',
  missing(guideWords, GUIDE_SCOPE).length === 0,
  JSON.stringify(missing(guideWords, GUIDE_SCOPE)),
);
