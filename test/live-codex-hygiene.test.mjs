import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { check } from './check.mjs';
import { checkCodexHygiene, readCodexHygiene } from '../scripts/codex-hygiene.mjs';

const config = '/fixture-home/.codex/config.toml';
const patterns = ['Caskroom/codex', 'app-server --stdio'];
const match = (...pids) => ({ status: 0, stdout: `${pids.join('\n')}\n` });
const noMatch = { status: 1, stdout: '' };
const ioError = (code) => Object.assign(new Error(`stub ${code}`), { code });

function stubIO({ pgrep = {}, configError, text = 'model = "fake"\n' } = {}) {
  return {
    run(command, [flag, pattern], options) {
      assert.equal(command, 'pgrep');
      assert.equal(flag, '-f');
      assert.ok(patterns.includes(pattern));
      assert.equal(options.encoding, 'utf8');
      return pgrep[pattern] ?? noMatch;
    },
    read(file, encoding) {
      assert.equal(file, config);
      assert.equal(encoding, 'utf8');
      if (configError) throw ioError(configError);
      return text;
    },
  };
}

// Run the entry points' observation and exit code, without running their scenarios or touching the owner home.
for (const [script, fileVar] of [['live-codex.mjs', 'CONFIG'], ['live-mixed.mjs', 'CODEX_CONFIG']]) {
  const source = readFileSync(new URL(`../scripts/${script}`, import.meta.url), 'utf8');
  const baseline = source.match(/^let codexBefore;\ntry \{[\s\S]*?^\}$/m)?.[0];
  const final = source.match(/^  const codexHygiene = checkCodexHygiene\([^\n]+\);$/m)?.[0];
  const count = source.match(/^  const passed = verdicts\.filter\([^\n]+;$/m)?.[0];
  const exit = source.match(/^  process\.exitCode = passed[^\n]+;$/m)?.[0];
  assert.ok(baseline && final && count && exit, `${script}: missing hygiene or verdict code`);
  assert.ok(source.indexOf(baseline) < source.indexOf('const SB = makeSandbox('), `${script}: baseline must precede sandbox creation`);
  const execute = new Function(fileVar, 'readCodexHygiene', 'checkCodexHygiene', 'check', 'process', 'console',
    'verdicts', 'begin', `${baseline}\nbegin();\n${final}\n${count}\n${exit}`);

  function run(before, after) {
    const stopped = Symbol('process.exit');
    const process = { exit(code) { this.exitCode = code; throw stopped; } };
    const verdicts = [], errors = [];
    let began = false;
    try {
      execute(config, (file) => readCodexHygiene(file, stubIO(before)),
        (file, snapshot, check) => checkCodexHygiene(file, snapshot, check, stubIO(after)),
        (name, ok, detail) => verdicts.push({ name, ok, detail }), process,
        { error: (error) => errors.push(error) }, verdicts, () => { began = true; });
    } catch (error) {
      if (error !== stopped) throw error;
    }
    return { code: process.exitCode, began, verdicts, errors };
  }

  const absent = { configError: 'ENOENT' };
  const clean = run(absent, absent);
  check(`${script}: pgrep exit 1 and two missing configs pass`,
    clean.code === 0 && clean.began && clean.verdicts.length === 3 && clean.verdicts.every(v => v.ok), JSON.stringify(clean));

  for (const pattern of patterns) {
    const foreign = { pgrep: { [pattern]: match(101) } };
    const existing = run(foreign, foreign);
    const gone = run(foreign, {});
    const added = run(foreign, { pgrep: { [pattern]: match(101, 202) } });
    check(`${script}: ${pattern} subtracts foreign PIDs, but fails for a new PID`,
      existing.code === 0 && gone.code === 0 && added.code === 1
      && added.verdicts.filter(v => !v.ok).some(v => v.name.includes(pattern) && v.detail === '202'), JSON.stringify(added));
  }

  const failures = [
    ...patterns.flatMap(pattern => [
      [{ status: null, error: ioError('ENOENT') }, 'ENOENT'],
      [{ status: null, signal: 'SIGTERM' }, 'SIGTERM'],
      [{ status: 2, stdout: '202\n', stderr: 'stub pgrep failure' }, 'status=2', 'stub pgrep failure'],
    ].map(([result, reason, ...detail]) => [`${pattern} ${reason}`, { pgrep: { [pattern]: result } }, [pattern, reason, ...detail]])),
    ['config EACCES', { configError: 'EACCES' }, [config, 'EACCES']],
  ];
  for (const [label, failure, fragments] of failures) {
    const before = run(failure, absent);
    const after = run(absent, failure);
    check(`${script}: ${label} before the run refuses before launch`,
      before.code === 1 && !before.began && before.verdicts.length === 0
      && fragments.every(part => before.errors[0]?.includes(part)), JSON.stringify(before));
    check(`${script}: ${label} after cleanup cannot produce a passing hygiene verdict`,
      after.code === 1 && after.began && after.verdicts.length === 1 && after.verdicts[0].ok === false
      && fragments.every(part => after.verdicts[0].detail.includes(part)), JSON.stringify(after));
  }

  for (const [before, after] of [[absent, {}], [{}, absent]]) {
    const changed = run(before, after);
    check(`${script}: a config ${before === absent ? 'appearing' : 'disappearing'} is a change`,
      changed.code === 1 && changed.verdicts.some(v => v.name.includes('config.toml') && !v.ok), JSON.stringify(changed));
  }
}

const reference = readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8');
check('CLI reference distinguishes no matches and missing config from unavailable observations',
  reference.includes('Only a normal `pgrep` exit 1 means no matches.')
  && reference.includes('Only `ENOENT` counts as a missing config file.'));
