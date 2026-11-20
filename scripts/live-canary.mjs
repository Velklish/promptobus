#!/usr/bin/env node
// Live release canary on the packed package; see docs/guides/contributing.md#live-harness-scenarios.
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync, openSync, closeSync, writeSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/exec.js';
import { dropSessionLeaks, SESSION_LEAK_VARS } from '../test/hygiene.mjs';
import { TEST_SOCKET_ROOT, writeHostConfig } from '../test/sandbox.mjs';
import { CANARY_PREFIX, RUN_OWNER_FILE, markRunOwner, markRunUnresolved, runOwnerIsDead, sweepPreviousRuns, sweptLine } from './canary-runs.mjs';
import { exitCodeOf, runCanaryChild } from './live-abort.mjs';
import { optionalBytes, optionalEntries } from './live-home.mjs';
import { parseLiveSessions } from './live-run.mjs';
import { liveRoutingEnv, refuseImportedEntry } from './live-entry.mjs';

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
markRunOwner(RUN);
markRunUnresolved(RUN);
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
const bornAfter = (file) => {
  try {
    const st = statSync(file);
    return (st.birthtimeMs || st.mtimeMs) >= born;
  } catch (error) { return error.code !== 'ENOENT'; }
};
const recentEntries = (dir, matches) => {
  try { return readdirSync(dir).filter(matches).filter(name => bornAfter(path.join(dir, name))); }
  catch { return null; }
};
const readJson = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
/** Marketplace names in the Claude Code global registry. No file — an empty list. */
function marketplaceIds() {
  const bytes = optionalBytes(KNOWN_MARKETPLACES);
  if (!bytes) return [];
  try {
    const parsed = JSON.parse(bytes);
    const entries = Object.hasOwn(parsed, 'marketplaces') ? parsed.marketplaces : parsed;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw Error('expected a marketplace map');
    return Object.keys(entries);
  } catch (error) { throw Error(`${KNOWN_MARKETPLACES}: ${error.message}`); }
}

function completedReport(dir) {
  const files = [RUN_OWNER_FILE, 'live-canary.md', 'live-e2e.out'];
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) return false;
  return readdirSync(dir).length === files.length && files.every(name => lstatSync(path.join(dir, name)).isFile())
    && readJson(path.join(dir, RUN_OWNER_FILE))?.canaryReport === 'complete' && runOwnerIsDead(dir);
}
const refusedRuns = [];
const heldRuns = [];
const swept = sweepPreviousRuns(os.tmpdir(), { current: RUN, refused: refusedRuns, held: heldRuns, isLive: dir => !completedReport(dir) });
note(sweptLine('previous-run directories', swept));
if (heldRuns.length) note(`held without a completed owned report: ${heldRuns.join(', ')}`);
if (refusedRuns.length) note(`sweep refused (busy or foreign permissions): ${refusedRuns.join(', ')}`);

// ── Step 1: clean workspace, install and version check ─────────────────────────────
const branch = (spawnSync('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();
const head = (spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();

const packDir = path.join(RUN, 'pack');
mkdirSync(packDir, { recursive: true });
const packed = run('npm', ['pack', '--pack-destination', packDir], { cwd: CLI, encoding: 'utf8' });
const tgzName = readdirSync(packDir).find((n) => n.endsWith('.tgz'));
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

// Strip session identity from each child instead of changing the parent environment;
// PATH stays inherited because the live binary check resolves through it.
const childEnv = () => dropSessionLeaks(liveRoutingEnv(RUN));

const cli = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: ws, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: childEnv(), ...opts,
});

// A missing harness is not evidence of an empty session registry.

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const fileMark = (file) => { const bytes = optionalBytes(file); return bytes ? sha(bytes) : '(no file)'; };
const homeSnapshot = () => ({
  'marketplace entries': marketplaceIds().sort().join(' ') || '(none)',
  'plugin installs': fileMark(INSTALLED_PLUGINS),
  'plugin cache': optionalEntries(PLUGIN_CACHE).sort().join(' ') || '(none)',
  'Claude Code personal settings': fileMark(CLAUDE_SETTINGS),
});
/** What drifted between two snapshots — one line per field, so the verdict names the door. */
const homeDiff = (before, after) => Object.keys(before)
  .filter((k) => before[k] !== after[k])
  .map((k) => `${k}: was «${before[k]}» became «${after[k]}»`);

let failure = null;
let homeBefore;
let childCleanupConfirmed = false, workspaceRemoved = false;
try {
  homeBefore = homeSnapshot();
  note(`home snapshot before the version check: ${Object.entries(homeBefore).map(([k, v]) => `${k}=${v}`).join(' · ')}`);

  const versioned = existsSync(BIN) ? cli(['--version']) : { status: 1, stdout: '', stderr: `missing ${BIN}` };
  check('canary: the installed tarball answers --version',
    versioned.status === 0,
    `code ${versioned.status} · ${tail(`${versioned.stdout}${versioned.stderr}`)}`);

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
  const log = path.join(RUN, 'live-e2e.out');
  const fd = openSync(log, 'w');
  let live;
  try { live = await runCanaryChild(LIVE_E2E, { cwd: REPO, env: liveEnv, fd }); }
  finally { closeSync(fd); }
  if (live.abort) {
    writeSync(2, `canary: ${live.abort}, child ${live.pid} ${live.terminated ? 'terminated' : 'termination UNKNOWN'}; stand retained: ${RUN}\n`);
    process.exit(exitCodeOf(live.abort));
  }
  const liveOut = readFileSync(log, 'utf8');
  const terminal = /^▸ cleanup: (.+)$/.exec(liveOut.trimEnd().split('\n').at(-1));
  const receipt = terminal && JSON.parse(terminal[1]);
  const scenario = receipt?.scenario;
  const recorded = typeof scenario?.completed === 'boolean' && Number.isSafeInteger(scenario.total)
    && Number.isSafeInteger(scenario.passed) && scenario.passed >= 0 && scenario.passed <= scenario.total;
  const completed = recorded && scenario.completed && scenario.total > 0 && scenario.passed === scenario.total;
  const consistentExit = recorded && typeof receipt?.safe === 'boolean' && live.status === (completed && receipt.safe ? 0 : 1);
  childCleanupConfirmed = consistentExit && receipt?.safe === true;
  check('canary: the live orchestration loop passed in full', completed && consistentExit,
    `code ${live.status} · ${scenario ? `${scenario.passed}/${scenario.total}` : 'scenario receipt missing'} · ${tail(liveOut, 500)}`);
  check('cleanup: the child confirmed its process tree and sessions are gone', childCleanupConfirmed,
    receipt?.failures?.join(' · ') || `code ${live.status} · cleanup unconfirmed`);
  if (scenario) note(`live verdicts ${scenario.passed}/${scenario.total}`);
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
  try {
    const homeAfterRun = homeSnapshot();
    const runDiff = homeBefore ? homeDiff(homeBefore, homeAfterRun) : [`baseline unavailable: ${failure?.message}`];
    check('the person home: the canary left no changes over the whole run',
      runDiff.length === 0,
      runDiff.join(' · '));
    note(`home snapshot after the run: ${Object.entries(homeAfterRun).map(([k, v]) => `${k}=${v}`).join(' · ')}`);
  } catch (error) { check('the person home: final observation unavailable', false, error.message); }

  // ── Cleanup ────────────────────────────────────────────────────────────────────────

  // Use the same raw registry command and strict cleanup parser as live-e2e.
  let sessions = null;
  let registryError;
  try {
    const { runClaude } = await import(path.join(PKG, 'lib', 'liftoff.js'));
    const { r, missing } = runClaude(['agents', '--json']);
    if (missing) throw Error(missing);
    sessions = parseLiveSessions(r);
  } catch (error) { registryError = error.message; }
  // Session cwd belongs to the installed run tree; a shared title prefix
  // also matches other runs and cannot establish ownership.
  const ours = Array.isArray(sessions)
    ? sessions.filter((x) => x?.cwd && under(x.cwd, RUN))
    : [];
  const sessionsClear = check('cleanup: no run sessions left in the harness registry',
    Array.isArray(sessions) && sessions.every(row => typeof row?.cwd === 'string' && path.isAbsolute(row.cwd)) && ours.length === 0,
    Array.isArray(sessions)
      ? JSON.stringify(ours.map((x) => ({ name: x.name, cwd: x.cwd, status: x.status })))
      : `session registry not parsed — ${registryError}`);
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
  const processesClear = check('cleanup: no participant, warden, or bus-server processes of the run remain',
    ps.status === 0 && seesSelf && stray.length === 0,
    seesSelf ? stray.join('\n') : `ps did not even show this process (${tail(ps.stderr, 200)})`);
  // Report matching foreign processes separately without making them failures.
  if (elsewhere.length) note(`processes of the same commands outside the run directory: ${elsewhere.length} (not ours)`);

  // Ignore pre-existing sandboxes and sockets when looking for leftovers.
  const sandboxes = recentEntries(os.tmpdir(), n => n.startsWith('promptobus-live-e2e-'));
  const socks = TEST_SOCKET_ROOT === null ? [] : recentEntries(TEST_SOCKET_ROOT, n => ['a2l-', 'a2e-', 'a2h-'].some(pref => n.startsWith(pref)));
  const pathsClear = check('cleanup: no run sandboxes or bus sockets remain',
    sandboxes?.length === 0 && socks?.length === 0,
    `sandboxes ${JSON.stringify(sandboxes)} · sockets ${JSON.stringify(socks)}`);

  // The workspace itself with its store — last: cleanup commands above reach it
  // first.
  if (childCleanupConfirmed && sessionsClear && processesClear && pathsClear) {
    rmSync(ws, { recursive: true, force: true });
    rmSync(packDir, { recursive: true, force: true });
    workspaceRemoved = true;
  } else note(`cleanup unconfirmed; stand retained: ${RUN}`);
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
  if (workspaceRemoved) writeFileSync(path.join(RUN, RUN_OWNER_FILE), JSON.stringify({ pid: process.pid, path: RUN, canaryReport: 'complete' }));
  process.stdout.write(`\n${passed}/${verdicts.length} wrapper verdicts passed\n`);
  process.stdout.write(`▸ report: ${file}\n`);
  process.exit(green ? 0 : 1);
}
