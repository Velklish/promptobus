#!/usr/bin/env node
// Live release canary. Run from the mechanism repository root:
//
//   node scripts/live-canary.mjs
//
// Release gates ([release-gates.mjs](release-gates.mjs)) prove that a tarball is
// packed and contains what was promised. The canary proves the next thing: the
// packed package WORKS — in a separate clean workspace, on real Claude, through a
// full orchestration loop.
//
// What is done here and what is NOT. The whole bus loop lives in the scenario
// ([scenario.mjs](../test/scenario.mjs)) — one for the stub and live harnesses, and
// a check edit goes into both runs at once. This script prepares and tears down the
// world around the scenario: a temporary workspace, package install, `sync` and
// `doctor` from it, a live run on the tree under test, and proof of cleanup. It
// does not check the bus at all.
//
// **The workspace gets its base as a clone of THIS branch by a local path.** Not
// from GitLab: base and CLI must be one version (the equality gate in
// [base.js](../lib/base.js)), and the commit under test is not in the registry
// yet. The clone is local — the canary goes without the network.
//
// **The canary does not touch the person's home at all, and that is its subject,
// not its politeness.** `sync` is called with `--no-global`: Claude Code plugin
// registration, memory hooks in the home, and a global `ast-grep` install are
// skipped. The opposite used to stand here — the run wrote and then cleaned up
// after itself — and the price was double: a precondition that could stop the
// canary on drifted hooks, and a cleanup that might not finish (an exception or
// Ctrl-C between `sync` and the end of the loop left a record in the person's
// home forever). Now what is proved is not cleanup but untouchedness: a home
// snapshot before `sync` and a compare against it twice — right after `sync` and
// at the very end, over the whole run. Drifted — a red verdict with a list and
// the remove command: cleaning up after the mode by hand would hide its break.
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
import { writeHostConfig, resolveToolBin } from '../test/sandbox.mjs';
import { CANARY_PREFIX, sweepPreviousRuns, sweptLine } from './canary-runs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..');
const REPO = CLI;
const LIVE_E2E = path.join(here, 'live-e2e.mjs');
// Everything `sync` writes outside the workspace directory through its three
// doors: Claude Code global state, the memory-hooks home, and Claude Code
// personal settings. `--no-global` touches none of these paths, and a snapshot
// of them is the subject of the check.
const CLAUDE_PLUGINS = path.join(os.homedir(), '.claude', 'plugins');
const KNOWN_MARKETPLACES = path.join(CLAUDE_PLUGINS, 'known_marketplaces.json');
const INSTALLED_PLUGINS = path.join(CLAUDE_PLUGINS, 'installed_plugins.json');
const PLUGIN_CACHE = path.join(CLAUDE_PLUGINS, 'cache');
const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

// Id of the task the scenario creates: its sessions are recognised in the shared
// harness registry by this. The substring «e2e» would catch foreign sessions of
// a person running a release.
const E2E_TASK = 'e2ebus';
// What has no right to outlive the run. The list is the same as the release
// gates ([release-gates.mjs](release-gates.mjs)): the live loop raises
// participants, the warden, and bus stdio servers, and stops the last without
// waiting.
//
// **It is judged against ITS own tree, not the whole machine.** These commands
// are not started by the canary alone: on a machine with a going run the same
// three templates match foreign processes from `workspace/node_modules`, and the
// verdict went red on them — measured 2026-09-03 (a `sync` worker run): four
// processes of a foreign run, none of its own. The cut-off is `under()` by the
// run directory: the canary installs its own tree itself and wholly into it, so
// the binary path in the process command line is the mark of belonging.
const LEFTOVERS = [/promptobus\s+warden/, /test[/\\]participant\.mjs/, /promptobus\s+mcp/];

const RUN = mkdtempSync(path.join(os.tmpdir(), CANARY_PREFIX));
const startedAt = new Date();
const born = startedAt.getTime();

// What the canary does — in prose, without numbering: the loop step count lives
// in the scenario and changes there, and a caption with a number goes stale in
// silence.
const STEPS = [
  'tarball installed in a clean workspace, the installed bin answers --version',
  'live orchestration loop on the tree under test — complete, by scenario steps',
  'the person home is untouched: the snapshot before install is compared after --version and at the end of the run',
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

// The canary itself sweeps previous-run directories, keeping the three newest.
// It leaves its own directory on purpose — the path is printed, the report is
// read after the run — but nobody swept what piled up: a 2026-09-03 measurement
// on the owner's machine found nine directories at 20 KB each. What was swept is
// printed as a list: a silent sweep in a shared `$TMPDIR` reads as a
// disappearance. A neighbouring foreign run is held by the age cut-off, not by
// mtime rank: its directory stops growing seconds after start and the "three
// newest" threshold does not protect it.
const refusedRuns = [];
const swept = sweepPreviousRuns(os.tmpdir(), { current: RUN, refused: refusedRuns });
note(sweptLine('previous-run directories', swept));
if (refusedRuns.length) note(`sweep refused (busy or foreign permissions): ${refusedRuns.join(', ')}`);

// ── Step 1: clean workspace, install, sync and doctor ─────────────────────────────
const branch = (spawnSync('git', ['-C', REPO, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();
const head = (spawnSync('git', ['-C', REPO, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim();

const packDir = path.join(RUN, 'pack');
mkdirSync(packDir, { recursive: true });
const packed = run('npm', ['pack', '--pack-destination', packDir], { cwd: CLI, encoding: 'utf8' });
const tgzName = listOf(packDir).find((n) => n.endsWith('.tgz'));
const tgz = tgzName ? path.join(packDir, tgzName) : null;

// Base source is a bare clone of THIS branch: `sync` will `git clone` it for
// real, but will not touch the network, and the version-equality gate will
// match on its own — base and CLI are one commit.
const baseOrigin = path.join(RUN, 'base-origin.git');
const mirrored = spawnSync('git', ['clone', '--bare', '--quiet', '--single-branch', '--branch', branch, REPO, baseOrigin], { encoding: 'utf8' });

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

// **Child environments have no session identity.** The canary is driven from
// sessions that have all five variables set: the release checklist says to run
// it before the tag, and in runs the workers drive it. A leaked
// `PROMPTOBUS_HOME` is stronger than a home search from cwd and would send the
// run into the LIVE bus journal of the workspace, `PROMPTOBUS_TASK` — onto a
// live-run task (measured 2026-09-03: a live loop of a `sync` worker raised
// spawn, review and the warden with the live-task environment). The list is
// imported from the same home as the suite ([hygiene.mjs](../test/hygiene.mjs));
// there is no second copy here.
//
// It is stripped from CHILDREN, not from this process: the verdict below judges
// what actually left for the child, and on a scrubbed `process.env` it would be
// green by construction.
//
// It is computed on EVERY call, not once at file load (review note): below,
// `process.env.PATH` is prepended with the directory of the found `claude`, and
// a copy taken before that would send `sync` and `doctor` without it — exactly
// the refusal the prepend exists for. An environment copy per call costs
// microseconds, and the canary has a handful of calls.
const childEnv = () => dropSessionLeaks({ ...process.env });

const cli = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], {
  cwd: ws, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: childEnv(), ...opts,
});

// The harness binary is found with the SAME resolve spawn uses — including
// `~/.local/bin`. It cannot be called through PATH: the Claude Code install does
// not put itself there, and `run('claude', …)` returns ENOENT with empty stdout.
// A cleanup verdict on that answer would pass as success — "the session list is
// empty" and "no list was given" are indistinguishable. The live case of the
// 2026-09-02 run: that is exactly what happened.
let claudeBin = null;
try {
  const { resolveToolBin } = await import(new URL('../test/sandbox.mjs', import.meta.url));
  const found = resolveToolBin('claude');
  claudeBin = found.ok ? found.path : null;
} catch { claudeBin = null; }

// The session registry is read with the SAME parse the mechanism uses
// (`bgSessions` from the installed tree), not our own. `claude agents --json`
// has three reply shapes — a bare array, `{agents:[…]}` and `{sessions:[…]}` —
// and a second copy of the parse would drift from the first in silence. `bgSessions`
// itself calls `claude` through PATH, so a directory found outside PATH is
// prepended into it — the same trick as in live-e2e.mjs.
if (claudeBin) {
  const binDir = path.dirname(claudeBin);
  if (!(process.env.PATH ?? '').split(path.delimiter).includes(binDir)) {
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
  }
}
let bgSessions = null;
let resetBgSessionsCache = null;
try {
  ({ bgSessions, resetBgSessionsCache } = await import(path.join(PKG, 'lib', 'liftoff.js')));
} catch { bgSessions = null; }

// **The home snapshot is BEFORE `sync`, and it is the measure of the whole
// check.** A precondition used to stand here: `sync` wrote memory hooks into
// the user HOME, and on drifted hooks the canary refused without starting the
// run — otherwise it would overwrite live-session settings for the person,
// including the session the release is driven from. With `--no-global`, `sync`
// has no right to write outside the workspace directory at all, so there is
// nothing to ask permission for: we snapshot all three doors and compare
// against them twice.
//
// Hook state is asked of the MECHANISM itself (`hooksState` of the installed
// tree), not of our own file compare: a copy of the rule would drift from it
// in silence and would not tell "they diverged" from "the home has none at
// all". Next to its verdict sit hashes of the files themselves — the verdict
// answers "are they fresh", and the snapshot needs another: "are they the
// same bytes".
let hooksState = null;
try {
  ({ hooksState } = await import(path.join(PKG, 'dist', 'hooks.js')));
} catch { hooksState = null; }

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 12);
const fileMark = (file) => { try { return sha(readFileSync(file)); } catch { return '(no file)'; } };
const dirMark = (dir) => listOf(dir).sort().map((n) => `${n}:${fileMark(path.join(dir, n))}`).join(' ');
/**
 * State of the three `sync` doors outward as one object. Compare is over the
 * whole object, not one field: there are three doors, and each being closed is
 * half the answer. The diff is printed by field, so the fields are named as a
 * person calls them.
 */
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
note(`home snapshot before sync: ${Object.entries(homeBefore).map(([k, v]) => `${k}=${v}`).join(' · ')}`);

const versioned = existsSync(BIN) ? cli(['--version']) : { status: 1, stdout: '', stderr: `missing ${BIN}` };
check('canary: the installed tarball answers --version',
  versioned.status === 0,
  `code ${versioned.status} · ${tail(`${versioned.stdout}${versioned.stderr}`)}`);

// **The mode verdict is a compare against the snapshot, not a recount of
// names.** The opposite used to stand here: the run looked for ITS new
// marketplace entry by a registry diff and removed it. By a diff because the
// name cannot be recounted from outside — the rule (`marketplaceName` in
// the host adapter) hashes the root path, and the command resolves the root
// with its own `requireRoot()`: under a temporary macOS directory it arrives
// as `/private/var/…`, while here the same directory is called `/var/…`, and
// the hashes of the two spellings differ (live case of the 2026-09-02 run:
// `sync` registered `ati-workspace-005c0315`, a recount of the rule gave
// `ati-workspace-d6c0cbf8`). The snapshot need not know that even more: it
// compares the WHOLE registry, not one name, and with it both other doors.
//
// There is no self-cleanup here on purpose: a mode that still wrote into the
// home is a red verdict, not a reason to remove traces by hand. So the detail
// names both what is left and the remove command — the person decides.
const homeAfterSync = homeSnapshot();
const syncDiff = homeDiff(homeBefore, homeAfterSync);
check('canary: sync --no-global wrote nothing outside the workspace directory',
  syncDiff.length === 0,
  `${syncDiff.join(' · ')}. Remove the marketplace entry: claude plugin marketplace remove <id>;`
  + ` the same command does not remove the cache directory ${PLUGIN_CACHE}/<id> — remove it by hand`);

let failure = null;
try {

  // ── Live loop ──────────────────────────────────────────────────────────────────────
  // The mechanism under test is the installed tree whole, one root. The workspace
  // is the one `sync` laid out: the scenario must go in the world the canary
  // exists for.
  const liveEnv = {
    ...childEnv(),
    PROMPTOBUS_E2E_ROOT: PKG,
    PROMPTOBUS_E2E_WORKSPACE: ws,
  };
  // Verdict on the ACTUAL child environment, not on `process.env` at check time:
  // the canary does not touch its own environment, and judging by it would mean
  // judging the wrong thing. Mutation-probe target: put `{ ...process.env }`
  // back here — the verdict goes red exactly when the canary is driven from a
  // participant session, i.e. in the most common case.
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

  // Which mechanism the run used — by the word of the raised process itself, not
  // by a path resolve in the script. Mutation-probe target: `PROMPTOBUS_E2E_ROOT`
  // onto the checkout — the verdict goes red.
  const reported = (/mechanism as the process said: (.+)/.exec(liveOut) ?? [])[1]?.trim() ?? null;
  check('canary: the live run used the binary from the installed tree, not the checkout',
    !!reported && reported !== 'unnamed' && under(reported, PKG) && !under(reported, REPO),
    `named ${reported} · install ${PKG}`);
} catch (e) {
  failure = e;
} finally {
  // ── The person home ──────────────────────────────────────────────────────────────────
  // The second verdict on the same snapshot and the first in `finally`: the
  // compare is over the WHOLE run, not one `sync`. The live loop raises real
  // Claude Code sessions, and they have no right to touch the person home
  // either — a participant gets the canonical plugin by `--plugin-dir`, not by
  // an install. It sits in `finally` because a broken run must still speak of
  // its trace in a foreign home, even if there is nothing left to report about
  // the loop verdicts.
  const homeAfterRun = homeSnapshot();
  const runDiff = homeDiff(homeBefore, homeAfterRun);
  check('the person home: nothing sync writes changed over the whole run',
    runDiff.length === 0,
    `${runDiff.join(' · ')}. Remove the marketplace entry: claude plugin marketplace remove <id>;`
    + ` the same command does not remove the cache directory ${PLUGIN_CACHE}/<id> — remove it by hand`);
  note(`home snapshot after the run: ${Object.entries(homeAfterRun).map(([k, v]) => `${k}=${v}`).join(' · ')}`);

  // ── Cleanup ────────────────────────────────────────────────────────────────────────

  // Run sessions: ask the harness with the same parse the mechanism uses. The
  // parse is half the verdict: an unreadable reply would give an empty list and
  // green on nothing.
  let sessions = null;
  try {
    resetBgSessionsCache?.();
    sessions = bgSessions ? bgSessions({ fresh: true }) : null;
  } catch { sessions = null; }
  // Judged by the session working directory under the run directory and by the
  // scenario task id: the substring «e2e» would catch foreign sessions of a
  // person running a release.
  const ours = Array.isArray(sessions)
    ? sessions.filter((x) => (x?.cwd && under(x.cwd, RUN)) || (x?.name && String(x.name).includes(E2E_TASK)))
    : [];
  check('cleanup: no run sessions left in the harness registry',
    Array.isArray(sessions) && ours.length === 0,
    Array.isArray(sessions)
      ? JSON.stringify(ours.map((x) => ({ name: x.name, cwd: x.cwd, status: x.status })))
      : 'session registry not parsed — bgSessions did not return a list');
  if (Array.isArray(sessions)) note(`sessions in the harness registry after the run: ${sessions.length}`);

  // Processes: first prove that we CAN look — our own pid must be in the
  // output. Without that a `ps` refusal would read as "nothing is left". The
  // list is the same as the gates: the live loop also raises bus stop-servers,
  // and their absence is checked on a par.
  const ps = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const psLines = (ps.stdout ?? '').split('\n').filter((l) => l.trim());
  const seesSelf = psLines.some((l) => Number(l.trim().split(/\s+/)[0]) === process.pid);
  // Cut-off by our own tree (`LEFTOVERS` above): every absolute path is taken
  // from the command line and asked of the same `under()` that judges the run
  // binary. Without it the verdict goes red on a foreign run on the same
  // machine, and is no more honest for being green.
  const underRun = (line) => (line.match(/\/[^\s]+/g) ?? []).some((token) => under(token, RUN));
  const stray = psLines.filter((l) => Number(l.trim().split(/\s+/)[0]) !== process.pid
    && LEFTOVERS.some((re) => re.test(l)) && underRun(l));
  const elsewhere = psLines.filter((l) => Number(l.trim().split(/\s+/)[0]) !== process.pid
    && LEFTOVERS.some((re) => re.test(l)) && !underRun(l));
  check('cleanup: no participant, warden, or bus-server processes of the run remain',
    ps.status === 0 && seesSelf && stray.length === 0,
    seesSelf ? stray.join('\n') : `ps did not even show this process (${tail(ps.stderr, 200)})`);
  // Foreign processes of the same commands do not paint the verdict, but they
  // cannot be silent either: a person reading the report must know that another
  // run is going on the machine.
  if (elsewhere.length) note(`processes of the same commands outside the run directory: ${elsewhere.length} (not ours)`);

  // Sandboxes and sockets — only younger than the start of the run: a name
  // literal without a time cut-off would paint the verdict with a foreign tail,
  // and would go green in silence on a prefix change.
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
  rmSync(baseOrigin, { recursive: true, force: true });
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
