#!/usr/bin/env node
// Live release canary on the packed package; see docs/guides/contributing.md#live-harness-scenarios.
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/exec.js';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { writeHostConfig } from '../test/sandbox.mjs';
import { CANARY_PREFIX, sweepPreviousRuns, sweptLine } from './canary-runs.mjs';
import { refuseImportedEntry } from './live-entry.mjs';

refuseImportedEntry(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..');
const REPO = CLI;
const LIVE_E2E = path.join(here, 'live-e2e.mjs');
// These are the home paths the canary must leave unchanged: Claude Code global
// state and personal settings. A snapshot of them is the subject of the check.
const CLAUDE_PLUGINS = path.join(os.homedir(), '.claude', 'plugins');
const KNOWN_MARKETPLACES = path.join(CLAUDE_PLUGINS, 'known_marketplaces.json');
const INSTALLED_PLUGINS = path.join(CLAUDE_PLUGINS, 'installed_plugins.json');
const PLUGIN_CACHE = path.join(CLAUDE_PLUGINS, 'cache');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// The installed binary path distinguishes this run’s processes from other runs.
const LEFTOVERS = [/promptobus\s+warden/, /test[/\\]participant\.mjs/, /promptobus\s+mcp/];

const RUN = mkdtempSync(path.join(os.tmpdir(), CANARY_PREFIX));
const startedAt = new Date();
const born = startedAt.getTime();

const STEPS = [
  'tarball installed in a clean workspace, the installed bin answers --version',
  'live orchestration loop on the tree under test — complete, by scenario steps',
  'the person home is untouched: the snapshot before the version check is compared at the end of the run',
  'cleanup: sessions, sandboxes, sockets, processes, the workspace itself',
];

const verdicts = [];
function check(name, cond, detail = '') {
  const ok = !!cond;
  verdicts.push({ name, ok, detail: ok ? '' : String(detail).trim().slice(0, 600) });
  process.stdout.write(`${ok ? '✔' : '✖'} ${name}${ok ? '' : ` — ${String(detail).trim().slice(0, 600)}`}\n`);
  return ok;
}
const notes = [];
const note = (line) => { notes.push(line); process.stdout.write(`  · ${line}\n`); };

const tail = (text, n = 700) => {
  const s = String(text ?? '').trim();
  return s.length > n ? `…${s.slice(-n)}` : s;
};
const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
const under = (child, parent) => {
  const c = real(child);
  const r = real(parent);
  return c === r || c.startsWith(r + path.sep);
};
const listOf = (dir) => { try { return readdirSync(dir); } catch { return []; } };
const bornAfter = (file) => {
  try {
    const st = statSync(file);
    return (st.birthtimeMs || st.mtimeMs) >= born;
  } catch { return false; }
};
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
/** Marketplace names in the Claude Code global registry. No file — an empty list. */
const marketplaceIds = () => Object.keys(readJson(KNOWN_MARKETPLACES)?.marketplaces
  ?? readJson(KNOWN_MARKETPLACES) ?? {});

// Keep this run’s report available after exit; sweep only earlier runs.
const refusedRuns = [];
const swept = sweepPreviousRuns(os.tmpdir(), { current: RUN, refused: refusedRuns });
note(sweptLine('previous-run directories', swept));
if (refusedRuns.length) note(`sweep refused (busy or foreign permissions): ${refusedRuns.join(', ')}`);

// ── Step 1: clean workspace, install and version check ─────────────────────────────
const branch = (spawnSync('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();
const head = (spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();

const packDir = path.join(RUN, 'pack');
mkdirSync(packDir, { recursive: true });
const packed = run('npm', ['pack', '--pack-destination', packDir], { cwd: CLI, encoding: 'utf8' });
const tgzName = listOf(packDir).find((n) => n.endsWith('.tgz'));
const tgz = tgzName ? path.join(packDir, tgzName) : null;

const ws = path.join(RUN, 'ws');
mkdirSync(ws, { recursive: true });
writeFileSync(path.join(ws, 'AGENTS.md'), '# Canary workspace\n\nTemporary: lives for one run.\n');
writeFileSync(path.join(ws, 'package.json'), `${JSON.stringify({
  name: 'promptobus-canary-workspace', private: true, version: '0.0.0',
}, null, 2)}\n`);
writeHostConfig(ws, { tools: ['claude'] });

const installed = tgz
  ? run('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--offline', tgz], { cwd: ws, encoding: 'utf8' })
  : { status: 1, stderr: 'tarball not packed' };
const PKG = path.join(ws, 'node_modules', 'promptobus');
const BIN = path.join(PKG, 'bin', 'promptobus.js');
check('canary: tarball packed and installed in a clean workspace',
  packed.status === 0 && installed.status === 0 && existsSync(BIN),
  `pack ${packed.status} · install ${installed.status} ${tail(installed.stderr, 300)} · bin ${existsSync(BIN)}`);
if (tgz) note(`tarball ${tgzName} (${(statSync(tgz).size / 1024).toFixed(0)} KB), branch ${branch}, commit ${head.slice(0, 8)}`);

// Strip session identity from each child instead of changing the parent environment.
const childEnv = () => dropSessionLeaks({ ...process.env });

const cli = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: ws, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: childEnv(), ...opts,
});

// A missing harness is not evidence of an empty session registry.

// Read sessions with the installed registry parser so the accepted reply shapes cannot drift.
let bgSessions = null;
let resetBgSessionsCache = null;
try {
  ({ bgSessions, resetBgSessionsCache } = await import(path.join(PKG, 'lib', 'liftoff.js')));
} catch { bgSessions = null; }

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const fileMark = (file) => { try { return sha(readFileSync(file)); } catch { return '(no file)'; } };
const homeSnapshot = () => ({
  'marketplace entries': marketplaceIds().sort().join(' ') || '(none)',
  'plugin installs': fileMark(INSTALLED_PLUGINS),
  'plugin cache': listOf(PLUGIN_CACHE).sort().join(' ') || '(none)',
  'Claude Code personal settings': fileMark(CLAUDE_SETTINGS),
});
/** What drifted between two snapshots — one line per field, so the verdict names the door. */
const homeDiff = (before, after) => Object.keys(before)
  .filter((k) => before[k] !== after[k])
  .map((k) => `${k}: was «${before[k]}» became «${after[k]}»`);

const homeBefore = homeSnapshot();
note(`home snapshot before the version check: ${Object.entries(homeBefore).map(([k, v]) => `${k}=${v}`).join(' · ')}`);

const versioned = existsSync(BIN) ? cli(['--version']) : { status: 1, stdout: '', stderr: `missing ${BIN}` };
check('canary: the installed tarball answers --version',
  versioned.status === 0,
  `code ${versioned.status} · ${tail(`${versioned.stdout}${versioned.stderr}`)}`);

let failure = null;
try {

  // Run the live loop entirely from the installed tree.
  const liveEnv = {
    ...childEnv(),
    PROMPTOBUS_E2E_ROOT: PKG,
    PROMPTOBUS_E2E_WORKSPACE: ws,
  };
  // Judge what was actually passed to the child, not the parent environment.
  const dirty = SESSION_LEAK_VARS.filter((name) => name in liveEnv);
  const carried = SESSION_LEAK_VARS.filter((name) => name in process.env);
  check('canary: live-run environment is clean of session identity',
    dirty.length === 0,
    `leaked to the child: ${dirty.join(', ')} · was on the canary itself: ${carried.join(', ') || 'nothing'}`);
  note(`session identity on the canary: ${carried.join(', ') || 'nothing'}; in the run environment: `
    + `${dirty.join(', ') || 'nothing'}`);
  const live = spawnSync(process.execPath, [LIVE_E2E], {
    cwd: REPO, env: liveEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const liveOut = `${live.stdout ?? ''}${live.stderr ?? ''}`;
  writeFileSync(path.join(RUN, 'live-e2e.out'), liveOut);
  const tally = /(\d+)\/(\d+) verdicts passed/.exec(liveOut);
  check('canary: the live orchestration loop passed in full',
    live.status === 0 && !!tally && tally[1] === tally[2],
    `code ${live.status} · ${tally ? `${tally[1]}/${tally[2]}` : 'count not parsed'} · ${tail(liveOut, 900)}`);
  if (tally) note(`live verdicts ${tally[1]}/${tally[2]}`);
  const total = /total ([\d.]+) s/.exec(liveOut);
  if (total) note(`the loop took ${total[1]} s`);

  // The child reports its actual mechanism root; a parent-side path resolve is not evidence.
  const reported = (/mechanism as the process said: (.+)/.exec(liveOut) ?? [])[1]?.trim() ?? null;
  check('canary: the live run used the binary from the installed tree, not the checkout',
    !!reported && reported !== 'unnamed' && under(reported, PKG) && !under(reported, REPO),
    `named ${reported} · install ${PKG}`);
} catch (e) {
  failure = e;
} finally {
  // Compare the owner home with the same snapshot even if the live loop failed.
  const homeAfterRun = homeSnapshot();
  const runDiff = homeDiff(homeBefore, homeAfterRun);
  check('the person home: the canary left no changes over the whole run',
    runDiff.length === 0,
    runDiff.join(' · '));
  note(`home snapshot after the run: ${Object.entries(homeAfterRun).map(([k, v]) => `${k}=${v}`).join(' · ')}`);

  // ── Cleanup ────────────────────────────────────────────────────────────────────────

  // An unreadable registry reply is not an empty session list.
  let sessions = null;
  try {
    resetBgSessionsCache?.();
    sessions = bgSessions ? bgSessions({ fresh: true }) : null;
  } catch { sessions = null; }
  // Session cwd belongs to the installed run tree; a shared title prefix
  // also matches other runs and cannot establish ownership.
  const ours = Array.isArray(sessions)
    ? sessions.filter((x) => x?.cwd && under(x.cwd, RUN))
    : [];
  check('cleanup: no run sessions left in the harness registry',
    Array.isArray(sessions) && ours.length === 0,
    Array.isArray(sessions)
      ? JSON.stringify(ours.map((x) => ({ name: x.name, cwd: x.cwd, status: x.status })))
      : 'session registry not parsed — bgSessions did not return a list');
  if (Array.isArray(sessions)) note(`sessions in the harness registry after the run: ${sessions.length}`);

  // Require our own PID in the listing before using it to prove absence.
  const ps = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const psLines = (ps.stdout ?? '').split('\n').filter((l) => l.trim());
  const seesSelf = psLines.some((l) => Number(l.trim().split(/\s+/)[0]) === process.pid);
  const underRun = (line) => (line.match(/\/[^\s]+/g) ?? []).some((token) => under(token, RUN));
  const stray = psLines.filter((l) => Number(l.trim().split(/\s+/)[0]) !== process.pid
    && LEFTOVERS.some((re) => re.test(l)) && underRun(l));
  const elsewhere = psLines.filter((l) => Number(l.trim().split(/\s+/)[0]) !== process.pid
    && LEFTOVERS.some((re) => re.test(l)) && !underRun(l));
  check('cleanup: no participant, warden, or bus-server processes of the run remain',
    ps.status === 0 && seesSelf && stray.length === 0,
    seesSelf ? stray.join('\n') : `ps did not even show this process (${tail(ps.stderr, 200)})`);
  // Report matching foreign processes separately without making them failures.
  if (elsewhere.length) note(`processes of the same commands outside the run directory: ${elsewhere.length} (not ours)`);

  // Ignore pre-existing sandboxes and sockets when looking for leftovers.
  const sandboxes = listOf(os.tmpdir())
    .filter((n) => n.startsWith('promptobus-live-e2e-'))
    .filter((n) => bornAfter(path.join(os.tmpdir(), n)));
  const socks = listOf('/tmp')
    .filter((n) => ['a2l-', 'a2e-', 'a2h-'].some((pref) => n.startsWith(pref)))
    .filter((n) => bornAfter(path.join('/tmp', n)));
  check('cleanup: no run sandboxes or bus sockets remain',
    sandboxes.length === 0 && socks.length === 0,
    `sandboxes ${JSON.stringify(sandboxes)} · sockets ${JSON.stringify(socks)}`);

  // The workspace itself with its store — last: cleanup commands above reach it
  // first.
  rmSync(ws, { recursive: true, force: true });
  rmSync(packDir, { recursive: true, force: true });
  check('cleanup: the canary workspace and its store are swept',
    !existsSync(ws) && !existsSync(packDir), `${ws} · ${packDir}`);

  check('canary: the run reached the end without a break', !failure, failure ? String(failure.stack ?? failure) : '');
}

report();

function report() {
  const passed = verdicts.filter((v) => v.ok).length;
  // The report is printed on an early refuse too — before the live run: empty
  // fields are more honest than silence.
  const liveLogPath = path.join(RUN, 'live-e2e.out');
  const liveText = existsSync(liveLogPath) ? readFileSync(liveLogPath, 'utf8') : '(live run was not started)';
  const green = passed === verdicts.length;
  const lines = [
    `# Live release canary — ${green ? 'GREEN' : 'RED'}`,
    '',
    `- Date: ${startedAt.toISOString()}`,
    `- Repository: ${REPO}`,
    `- Branch: ${branch} · commit: ${head}`,
    `- Run directory: ${RUN}`,
    `- Node: ${process.version} · platform ${process.platform}/${process.arch}`,
    '',
    '## Setup steps',
    '',
    ...STEPS.map((s) => `- ${s}`),
    '',
    `## Wrapper verdicts: ${passed}/${verdicts.length}`,
    '',
    ...verdicts.map((v) => `- ${v.ok ? '✔' : '✖'} ${v.name}${v.ok ? '' : ` — ${v.detail}`}`),
    '',
    '## Numbers',
    '',
    ...notes.map((n) => `- ${n}`),
    '',
    '## Live run',
    '',
    `Full output: ${liveLogPath}`,
    '',
    '```',
    tail(liveText, 4000),
    '```',
    '',
  ];
  const file = path.join(RUN, 'live-canary.md');
  writeFileSync(file, lines.join('\n'));
  process.stdout.write(`\n${passed}/${verdicts.length} wrapper verdicts passed\n`);
  process.stdout.write(`▸ report: ${file}\n`);
  process.exit(green ? 0 : 1);
}
