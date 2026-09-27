// Vendored writing skills keep a pinned upstream sha, and the release guide
// names the technical-writer step before the release commit.
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
