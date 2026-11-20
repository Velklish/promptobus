import './home.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSandbox, stubCommand } from './sandbox.mjs';
import * as cursorStub from './harness-cursor.mjs';
import * as codexStub from './harness-codex.mjs';
import { STUB_BIN } from '../scripts/live-entry.mjs';
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

// Cover each reader failure independently of the slower provider scenarios below.
{
  function run(before, after) {
    const verdicts = [], errors = [];
    let baseline;
    try { baseline = readCodexHygiene(config, stubIO(before)); }
    catch (error) { errors.push(error.message); return { began: false, code: 1, verdicts, errors }; }
    checkCodexHygiene(config, baseline, (name, ok, detail) => verdicts.push({ name, ok, detail }), stubIO(after));
    return { began: true, code: verdicts.every(item => item.ok) ? 0 : 1, verdicts, errors };
  }

  const absent = { configError: 'ENOENT' };
  const clean = run(absent, absent);
  check(`hygiene: pgrep exit 1 and two missing configs pass`,
    clean.code === 0 && clean.began && clean.verdicts.length === 3 && clean.verdicts.every(v => v.ok), JSON.stringify(clean));

  for (const pattern of patterns) {
    const foreign = { pgrep: { [pattern]: match(101) } };
    const existing = run(foreign, foreign);
    const gone = run(foreign, {});
    const added = run(foreign, { pgrep: { [pattern]: match(101, 202) } });
    const replaced = run(foreign, { pgrep: { [pattern]: match(202) } });
    const failsOn202 = (result) => result.code === 1
      && result.verdicts.filter(v => !v.ok).some(v => v.name.includes(pattern) && v.detail === '202');
    check(`hygiene: ${pattern} subtracts foreign PIDs, but fails for a new PID`,
      existing.code === 0 && gone.code === 0 && failsOn202(added), JSON.stringify(added));
    check(`hygiene: ${pattern} fails when a new PID replaces a foreign one at the same count`,
      failsOn202(replaced), JSON.stringify(replaced));
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
    check(`hygiene: ${label} before the run refuses before launch`,
      before.code === 1 && !before.began && before.verdicts.length === 0
      && fragments.every(part => before.errors[0]?.includes(part)), JSON.stringify(before));
    check(`hygiene: ${label} after cleanup cannot produce a passing hygiene verdict`,
      after.code === 1 && after.began && after.verdicts.length === 1 && after.verdicts[0].ok === false
      && fragments.every(part => after.verdicts[0].detail.includes(part)), JSON.stringify(after));
  }

  for (const [before, after] of [[absent, {}], [{}, absent]]) {
    const changed = run(before, after);
    check(`hygiene: a config ${before === absent ? 'appearing' : 'disappearing'} is a change`,
      changed.code === 1 && changed.verdicts.some(v => v.name.includes('config.toml') && !v.ok), JSON.stringify(changed));
  }
}

const reference = readFileSync(new URL('../docs/reference/03-cli.md', import.meta.url), 'utf8');
check('CLI reference distinguishes no matches and missing config from unavailable observations',
  reference.includes('Only a normal `pgrep` exit 1 means no matches.')
  && reference.includes('Only `ENOENT` counts as a missing config file.'));

const root = makeSandbox('promptobus-promptobus-live-mixed-stand-');
const fault = path.join(root, 'inject.mjs');
writeFileSync(fault, `
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const { fixturePath, fixtureStage } = process.env;
for (const name of ['readFileSync', 'readdirSync']) {
  let reads = 0;
  const read = fs[name];
  fs[name] = function(file, ...args) {
    if (file === fixturePath && ++reads === 2 && fixtureStage === '3') return 'model = "fixture-change"';
    if (file === fixturePath && reads === Number(fixtureStage) && fixtureStage !== '3') {
      throw Object.assign(Error('EACCES fixture ' + file), { code: 'EACCES' });
    }
    return read.call(this, file, ...args);
  };
}
const fault = process.env.fixtureCleanup;
let finalPs = false;
const spawn = cp.spawnSync;
const endedPid = fault === 'ps-ended' ? spawn(process.execPath, ['-e', '']).pid : 0;
cp.spawnSync = function(file, args, ...rest) {
  if (process.env.fixtureEarlyClose && args?.[1] === 'spawn') throw Error('fixture ends the scenario before the worker is raised');
  if (file === 'ps' && args[0] === '-Ao' && args[1] === 'pid=,command=') {
    finalPs = true;
    if (fault === 'ps-unread') return { status: 2, stderr: 'fixture ps unreadable' };
    const lines = [process.pid + ' qualification'];
    if (fault === 'ps-owned') lines.push('12345 cursor-agent');
    if (fault === 'ps-detail') lines.push(process.pid + ' cursor-agent');
    if (endedPid) lines.push(endedPid + ' cursor-agent');
    return { status: 0, stdout: lines.join('\\n') };
  }
  if (endedPid && file === 'ps' && args[0] === 'eww' && args.at(-1) === String(endedPid)) {
    return { status: 1, stdout: '', stderr: '' };
  }
  if (file === 'ps' && args[0] === 'eww' && fault === 'ps-detail' && args.at(-1) === String(process.pid)) {
    return { status: 2, stderr: 'fixture details unavailable' };
  }
  if (file === 'ps' && args[0] === 'eww' && args.at(-1) === '12345') {
    const run = fs.readdirSync(process.env.TMPDIR).find(n => n.startsWith('promptobus-live-') && !n.includes('logs-'));
    return { status: 0, stdout: 'cursor-agent ' + path.join(process.env.TMPDIR, run) };
  }
  if (finalPs && args?.includes('list-sessions')) {
    if (fault === 'tmux-unread') return { status: 2, stderr: 'fixture tmux unavailable' };
    if (fault === 'tmux-owned') return { status: 0, stdout: 'fixture-pane|0|1|1234|1|fake|chat|task|address' };
  }
  return spawn.call(this, file, args, ...rest);
};
if (['stop-refused', 'registry-left'].includes(fault)) {
  const { codexDriver } = await import(${JSON.stringify(new URL('../lib/driver-codex.js', import.meta.url).href)});
  const stop = codexDriver.stop.bind(codexDriver);
  let calls = 0;
  codexDriver.stop = async (...args) => {
    if (++calls === 1) return stop(...args);
    if (fault === 'stop-refused') return { ok: false, attempted: true, stopped: false, note: 'fixture Stop refused' };
    const result = await stop(...args);
    const dir = path.join(process.env.PROMPTOBUS_CODEX_HOME, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'fixture-unaccounted.json'), '{');
    return result;
  };
}
syncBuiltinESMExports();
`);
const send = (type, body) => ({ tool: 'promptobus_send', args: { to: 'orchestrator', type, body } });
const mailbox = { tool: 'promptobus_mailbox' };
async function entrypoint(kind, stage, registry = false, cleanup = '') {
  const dir = path.join(root, `${kind}-${stage}-${registry}-${cleanup}`), bin = path.join(dir, 'bin');
  const temp = path.join(dir, 'tmp');
  mkdirSync(temp, { recursive: true });
  const env = { ...process.env, [STUB_BIN]: bin };
  const codex = kind !== 'cursor' && await codexStub.installHarness({ binDir: bin, env });
  const cursor = kind !== 'codex' && await cursorStub.installHarness({ binDir: bin, env, bundledRuntime: true });
  // No unrelated app-server on the machine contributes to these filesystem cases.
  stubCommand(bin, 'pgrep', 'process.exitCode = 1;');
  if (kind === 'mixed') {
    cursorStub.planParticipant(cursor.home, 'worker:live', { turns: [
      { do: [send('result', 'LIVE-MIXED-HELLO')] }, { do: [mailbox, send('result', 'LIVE-MIXED-FIX')] },
    ] });
    codexStub.planParticipant(codex.home, 'reviewer:live', { turns: [
      { do: [mailbox, send('result', 'Checked review-live.diff')] },
      { do: [mailbox, send('result', 'Checked review-live-2.diff')] },
    ] });
  } else if (kind === 'codex') {
    codexStub.planParticipant(codex.home, 'worker:live', { turns: [{ do: [send('status', 'LIVE-CODEX-HELLO')] }] });
  }
  const script = fileURLToPath(new URL(`../scripts/live-${kind}.mjs`, import.meta.url));
  const observed = registry ? path.join(realpathSync(registry === 'personal-codex' ? codex.stateHome : cursor.stateHome), 'sessions') : path.join(dir, '.codex', 'config.toml');
  try {
    const child = spawn(process.execPath, ['--import', fault, script], { env: {
      ...env, HOME: dir, USERPROFILE: dir, TMPDIR: temp, fixtureCleanup: cleanup || (kind === 'mixed' && stage === 0 ? 'ps-ended' : ''),
      fixtureEarlyClose: kind === 'cursor' || (kind === 'mixed' && cleanup) ? '1' : '', fixturePath: observed, fixtureStage: String(stage),
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { out += chunk; });
    const timeout = setTimeout(() => child.kill('SIGTERM'), 90000);
    const [code, signal] = await new Promise(resolve => child.once('close', (...args) => resolve(args)));
    clearTimeout(timeout);
    const sandbox = /^▸ sandbox: (.+?) ·/m.exec(out)?.[1];
    if (cleanup) {
      const detail = { 'stop-refused': 'fixture Stop refused', 'registry-left': 'fixture-unaccounted.json',
        'ps-unread': 'fixture ps unreadable', 'ps-detail': 'fixture details unavailable', 'ps-owned': '12345 cursor-agent',
        'tmux-unread': 'fixture tmux unavailable', 'tmux-owned': 'added: fixture-pane' }[cleanup];
      const owner = sandbox && existsSync(sandbox) && JSON.parse(readFileSync(path.join(sandbox, '.promptobus-run-owner.json')));
      check(`live-${kind}: ${cleanup} keeps the owned stand at the terminal cleanup verdict`,
        code === 1 && !signal && out.includes(detail) && owner?.cleanup?.state === 'unresolved'
        && (kind !== 'codex' || out.includes('✔ no new app-server --stdio processes')), out);
      return;
    }
    if (stage === 3) {
      check(`live-${kind}: a changed personal config fails final hygiene and retains the stand`,
        !signal && code === 1 && out.includes('✖ personal ~/.codex/config.toml') && sandbox && existsSync(sandbox), out);
      return;
    }
    if (kind === 'mixed' && stage === 0) {
      check('live-mixed: a process that exits between listings is confirmed absent before deletion',
        code === 0 && sandbox && !existsSync(sandbox) && out.includes('✔ no Cursor processes of the run'), out);
    }
    const registryName = registry === 'personal-codex' ? 'personal Codex registry' : 'Cursor registry';
    const expected = stage === 0 ? code === 0 && out.includes('✔ personal ~/.codex/config.toml') && sandbox && !existsSync(sandbox)
      : code === 1 && out.includes('EACCES') && out.includes(observed) && Boolean(sandbox) === (stage === 2);
    check(`live-${kind}: ${registry ? registryName : 'Codex home'} ${['clean pair', 'unavailable baseline', 'unavailable final observation'][stage]} reaches the exit verdict`,
      !signal && expected && (stage !== 2 || existsSync(sandbox)), out);

  } finally { cursor?.restore?.(); codex?.restore?.(); }
}
for (const kind of ['codex', 'mixed']) {
  for (const stage of [0, 1, 2, 3]) await entrypoint(kind, stage);
}
await entrypoint('cursor', 1, true);
await entrypoint('cursor', 2, true);
await entrypoint('mixed', 1, true);
await entrypoint('mixed', 2, true);
await entrypoint('mixed', 2, 'personal-codex');
for (const fault of ['stop-refused', 'registry-left']) await entrypoint('codex', 0, false, fault);
for (const [kind, faults] of [['mixed', ['ps-unread', 'ps-owned', 'tmux-owned']], ['cursor', ['ps-detail', 'tmux-unread']]]) {
  for (const fault of faults) await entrypoint(kind, 0, false, fault);
}
