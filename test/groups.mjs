import { execFileSync } from 'node:child_process';

const STORE = ['store.test.mjs', 'v1-engine.test.mjs', 'v1-validate.test.mjs'];
const REVIEWER_FILES = ['reviewer-files.test.mjs', 'reviewer-files-race.test.mjs'];
const LIFECYCLE = [
  'codex-declined-stop.test.mjs', 'codex-self-stop-finalizer.test.mjs',
  'codex-stop-accounting.test.mjs', 'codex-stop-deadline.test.mjs', 'codex-stop-recovery.test.mjs',
  'cursor-stop-bounded.test.mjs', 'cursor-stop-deadline.test.mjs', 'cursor-stop-preflight.test.mjs',
  'harness-stop-all.test.mjs', 'lead-concurrency.test.mjs', 'lead-empty-recovery.test.mjs',
  'lead-lifecycle.test.mjs', 'lead-rollback.test.mjs', 'lead-startup-cleanup-race.test.mjs',
  'lead-startup-ownership.test.mjs', 'lead-unbound-launcher.test.mjs', 'lead.test.mjs',
  'managed-lead-generation.test.mjs', 'managed-native-retirement.test.mjs',
  'native-teamlead-stop.test.mjs', 'promptobus-adapter.test.mjs', 'promptobus-stop.test.mjs',
  'promptobus-codex-teamlead.test.mjs', 'promptobus-teamlead.test.mjs',
  'scenario-delivery.test.mjs', 'scenario-identity.test.mjs',
  'shared-service-stop-retirement.test.mjs', 'documentation-contract.test.mjs',
];
const GROUPS = ['integration', 'lifecycle', 'model-routing', 'reviewer-files', 'store'];
const PRODUCTION = {
  'lib/stop.ts': ['lifecycle'],
  'lib/stop.js': ['lifecycle'],
  'lib/codex-retire.ts': ['lifecycle'],
  'lib/codex-retire.js': ['lifecycle'],
  'lib/lead.ts': ['lifecycle'],
  'lib/lead.js': ['lifecycle'],
  'lib/fuzzy.js': ['integration', 'model-routing'],
  'lib/fuzzy.ts': ['integration', 'model-routing'],
  'lib/model-routing/calibrate.js': ['integration', 'model-routing'],
  'lib/model-routing/calibrate.ts': ['integration', 'model-routing'],
  'lib/model-routing/render.js': ['integration', 'model-routing'],
  'lib/model-routing/render.ts': ['integration', 'model-routing'],
};

function groupOf(name) {
  if (LIFECYCLE.includes(name)) return 'lifecycle';
  if (STORE.includes(name)) return 'store';
  if (REVIEWER_FILES.includes(name)) return 'reviewer-files';
  if (name.startsWith('model-routing-') || name === 'model-routing.test.mjs') return 'model-routing';
  return 'integration';
}

export function selectTests(paths, allFiles, lifecycle = false) {
  const selected = new Set(lifecycle ? ['lifecycle'] : []);
  const reasons = paths.length || lifecycle ? [] : ['no changed paths; impact is uncertain'];
  for (const rel of lifecycle ? [] : paths) {
    if (Object.hasOwn(PRODUCTION, rel)) {
      PRODUCTION[rel].forEach((group) => selected.add(group));
      if (PRODUCTION[rel].includes('integration')) selected.add('lifecycle');
    } else if (/^test\/[^/]+\.test\.mjs$/.test(rel) && allFiles.includes(rel.slice(5))) {
      selected.add(groupOf(rel.slice(5)));
      if (groupOf(rel.slice(5)) === 'integration') selected.add('lifecycle');
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
    full, reasons: lifecycle ? ['explicit lifecycle contract set'] : reasons.length ? reasons : paths.map((rel) => `mapped input: ${rel}`), selectedGroups,
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
