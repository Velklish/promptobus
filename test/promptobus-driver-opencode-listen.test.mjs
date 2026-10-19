import { check } from './check.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const subject = new URL('./promptobus-driver-opencode.test.mjs', import.meta.url);
const fixture = new URL('./fixtures/opencode-listen-error.mjs', import.meta.url);
const holderNames = [
  ': readiness is an answered session list',
  ': session create returns the server id',
  ': the first turn posts the prompt text',
  ': the message tail carries the idle outcome',
  ': session delete answers 204',
  ': every holder call went to the measured paths with basic auth',
];
const activationNames = [
  ': an idle session takes the follow-up turn',
  ': the warden-shaped target wakes through its socket',
  ': a running turn refuses honestly instead of queueing blind',
];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function run(code = null, site = 0, syscall = 'listen') {
  const injection = new URL(fixture);
  injection.search = new URLSearchParams({ code, site, syscall }).toString();
  const result = spawnSync(process.execPath,
    [...(code ? ['--import', injection.href] : []), fileURLToPath(subject)],
    { encoding: 'utf8', timeout: 20000 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const passed = [...output.matchAll(/^✔ (.+)$/gm)].map((match) => match[1]);
  const skipped = [...output.matchAll(/^↷ SKIP (.+) — .+$/gm)].map((match) => match[1]);
  const names = output.split('\n').filter((line) => /^(✔ |↷ SKIP )/.test(line))
    .map((line) => line.startsWith('✔ ') ? line.slice(2) : line.slice(7).split(' — ')[0]);
  return { ...result, output, passed, skipped, names };
}

const normal = run();
const names = normal.names;
check(': OpenCode normal listener run completes all 69 checks',
  normal.status === 0 && names.length === 69 && !normal.output.includes('before abort'),
  JSON.stringify(normal));

for (const code of ['EACCES', 'EPERM']) {
  for (const site of [1, 2, 0]) {
    const label = `${code} at ${site === 0 ? 'both listeners' : `listener ${site}`}`;
    const dependent = site === 1 ? holderNames : site === 2 ? activationNames : [...holderNames, ...activationNames];
    const expected = names.filter((name) => dependent.includes(name) || normal.skipped.includes(name));
    const result = run(code, site);
    check(`: ${label} names only the dependent socket checks as skipped`,
      result.status === 0 && same(result.skipped, expected)
      && result.output.includes(`injected listen ${code}`), JSON.stringify(result));
    check(`: ${label} reaches every original check`,
      same(result.names, names)
      && !result.output.includes('before abort'), JSON.stringify(result));
    check(`: ${label} keeps the other checks passing`,
      same(result.passed, normal.passed.filter((name) => !expected.includes(name))), JSON.stringify(result));
  }
}

for (const [code, syscall] of [['EADDRINUSE', 'listen'], ['EACCES', 'connect'], ['ERR_SOCKET_BAD_PORT', 'listen']]) {
  for (const site of [1, 2]) {
    const result = run(code, site, syscall);
    const priorSkips = site === 1 ? [] : normal.skipped.filter((name) => holderNames.includes(name));
    check(`: ${code} from ${syscall} at listener ${site} remains a real failure`,
      result.status === 1 && same(result.skipped, priorSkips) && result.output.includes(code)
      && result.output.includes('before abort'), JSON.stringify(result));
  }
}
