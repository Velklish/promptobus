import { execFileSync } from 'node:child_process';

const STORE = ['store.test.mjs', 'v1-engine.test.mjs', 'v1-validate.test.mjs'];
const REVIEWER_FILES = ['reviewer-files.test.mjs', 'reviewer-files-race.test.mjs'];
const GROUPS = ['integration', 'model-routing', 'reviewer-files', 'store'];
const PRODUCTION = {
  'lib/fuzzy.js': ['integration', 'model-routing'],
  'lib/fuzzy.ts': ['integration', 'model-routing'],
  'lib/model-routing/calibrate.js': ['integration', 'model-routing'],
  'lib/model-routing/render.js': ['integration', 'model-routing'],
  'lib/model-routing/render.ts': ['integration', 'model-routing'],
};

function groupOf(name) {
  if (STORE.includes(name)) return 'store';
  if (REVIEWER_FILES.includes(name)) return 'reviewer-files';
  if (name.startsWith('model-routing-') || name === 'model-routing.test.mjs') return 'model-routing';
  return 'integration';
}

export function selectTests(paths, allFiles) {
  const selected = new Set();
  const reasons = paths.length ? [] : ['no changed paths; impact is uncertain'];
  for (const rel of paths) {
    if (Object.hasOwn(PRODUCTION, rel)) {
      PRODUCTION[rel].forEach((group) => selected.add(group));
    } else if (/^test\/[^/]+\.test\.mjs$/.test(rel) && allFiles.includes(rel.slice(5))) {
      selected.add(groupOf(rel.slice(5)));
    } else if ([...STORE, ...REVIEWER_FILES].some((name) => rel === `test/${name}`)) {
      selected.add(groupOf(rel.slice(5)));
    } else {
      reasons.push(`unmapped or shared input: ${rel}`);
    }
  }
  const full = reasons.length > 0;
  const selectedGroups = full ? [...GROUPS] : GROUPS.filter((group) => selected.has(group));
  const files = [...allFiles].sort().filter((name) => selectedGroups.includes(groupOf(name)));
  return {
    full, reasons, selectedGroups,
    omittedGroups: GROUPS.filter((group) => !selectedGroups.includes(group)),
    files, omittedFiles: [...allFiles].sort().filter((name) => !files.includes(name)),
  };
}

export function changedPaths(cwd, base) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  let sha;
  try { sha = git('rev-parse', '--verify', '--end-of-options', `${base}^{commit}`).trim(); }
  catch { throw new Error(`invalid explicit Git base: ${base}`); }
  const tracked = git('diff', '--name-only', '--no-renames', '-z', sha, '--');
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z');
  return {
    base: sha, head: git('rev-parse', 'HEAD').trim(), dirty: git('status', '--porcelain'),
    paths: [...new Set((tracked + untracked).split('\0').filter(Boolean))].sort(),
  };
}
