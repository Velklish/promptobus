// The live scripts' verdict helpers and their sandbox ownership, on neutral fixtures. Run: npm test
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { check } from './check.mjs';
import { makeSandbox } from './sandbox.mjs';
import {
  MIN_AGE_MS, RUN_OWNER_FILE, markRunOwner, runOwnerIsDead, sweepLiveRuns, sweepPreviousRuns,
} from '../scripts/canary-runs.mjs';
import { codexConfigSha } from '../scripts/codex-config.mjs';
import { messageKey, reportMentionsDiff, unseenResult } from '../scripts/review-events.mjs';
import { requiredTmuxSessions, tmuxAbsenceVerdict } from '../scripts/tmux-check.mjs';

const SB = makeSandbox('promptobus-promptobus-live-verdicts-');

// --- sandboxes of previous live runs: a dead owner's go, a live owner's stay -----------------------

const RUNS = path.join(SB, 'runs');
const PREFIX = 'pb-live-fixture-';
mkdirSync(RUNS, { recursive: true });
const deadPid = (() => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
})();
function run(name, { owner = null, ageMs = 0, foreignPath = false } = {}) {
  const dir = path.join(RUNS, `${PREFIX}${name}`);
  mkdirSync(dir, { recursive: true });
  if (owner === 'self') markRunOwner(dir);
  if (owner === 'dead') {
    writeFileSync(path.join(dir, RUN_OWNER_FILE), JSON.stringify({ pid: deadPid, path: foreignPath ? RUNS : dir }));
  }
  const at = (Date.now() - ageMs) / 1000;
  utimesSync(dir, at, at);
  return dir;
}
const current = run('current', { owner: 'self' });
const deadYoung = run('dead-young', { owner: 'dead' });
const liveOld = run('live-old', { owner: 'self', ageMs: 2 * MIN_AGE_MS });
const bareOld = run('bare-old', { ageMs: 2 * MIN_AGE_MS });
const bareYoung = run('bare-young');
const copiedMarker = run('copied-marker', { owner: 'dead', foreignPath: true });

check('ownership: a marker is written once — a second claim on the same directory refuses',
  (() => { try { markRunOwner(current); return false; } catch (e) { return e.code === 'EEXIST'; } })(), current);
check('ownership: dead only for its own readable marker with a gone pid',
  runOwnerIsDead(deadYoung) && !runOwnerIsDead(liveOld) && !runOwnerIsDead(bareOld) && !runOwnerIsDead(copiedMarker),
  `dead pid ${deadPid}`);

const lines = sweepLiveRuns(RUNS, { prefix: PREFIX, current });
check('sweep: a dead owner\'s sandbox goes at once, younger than the hour; an old unmarked one goes by age',
  !existsSync(deadYoung) && !existsSync(bareOld), lines.join(' | '));
check('sweep: the current run, a live owner\'s old sandbox, a young unmarked one and a copied marker stay',
  existsSync(current) && existsSync(liveOld) && existsSync(bareYoung) && existsSync(copiedMarker),
  lines.join(' | '));
check('sweep: the report names what went and what a live owner holds',
  lines[0].includes(`${PREFIX}dead-young`) && lines[0].includes(`${PREFIX}bare-old`)
  && lines.some((l) => l.startsWith('held, their owner is alive:') && l.includes(`${PREFIX}live-old`)),
  lines.join(' | '));
const throwing = run('throwing', { owner: 'dead' });
sweepPreviousRuns(RUNS, { prefix: PREFIX, current, keep: 0, isDead: () => { throw new Error('boom'); } });
check('sweep: a predicate that throws is not dead — the young directory stays', existsSync(throwing), throwing);

// --- persist-session verdicts refuse on an unread tmux list --------------------------------------

const unread = () => ({ sessions: null, missing: 'tmux could not be run: spawn tmux ENOENT' });
const list = (...names) => () => ({ sessions: names.map((name) => ({ name })), missing: null });
check('tmux: an unread list throws at the start instead of reading as empty',
  (() => { try { requiredTmuxSessions(unread); return false; } catch (e) { return /ENOENT/.test(e.message); } })());
const verdicts = {
  unread: tmuxAbsenceVerdict(unread, new Set()),
  clean: tmuxAbsenceVerdict(list('person'), new Set(['person'])),
  added: tmuxAbsenceVerdict(list('person', 'run'), new Set(['person'])),
  lost: tmuxAbsenceVerdict(list(), new Set(['person'])),
};
check('tmux: green only on a read list with nothing added and nothing of the person\'s gone',
  !verdicts.unread.ok && verdicts.clean.ok && !verdicts.added.ok && !verdicts.lost.ok
  && verdicts.added.detail.includes('added: run') && verdicts.lost.detail.includes('gone: person'),
  JSON.stringify(verdicts));

// --- a review round is answered by an unseen result naming its diff -------------------------------

const earlier = { id: 'm1', type: 'result', body: 'review of 20261004-a.diff' };
const box = [earlier, { id: 'm2', type: 'status', body: 'x' }, { id: 'm3', type: 'result', body: 'review of 20261004-b.diff' }];
const seen = new Set([messageKey(earlier)]);
const next = unseenResult(box, seen);
check('review: the next result is the first one not seen before the round',
  next?.id === 'm3' && unseenResult([earlier], seen) === null, JSON.stringify(next));
check('review: the report must name this round\'s diff file, not the previous one',
  reportMentionsDiff(next.body, '/x/files/20261004-b.diff') && !reportMentionsDiff(next.body, '/x/files/20261004-a.diff')
  && !reportMentionsDiff(next.body, ''), next.body);

// --- the person's Codex config: refresh timestamps are not a change, everything else is ------------

const BASE = 'model = "m"\n[projects."/w"]\ntrust_level = "trusted"\n[mcp_servers.d]\nurl = "https://d.example/mcp"\n'
  + '[hooks.state."/w/h.json:s:0:0"]\ntrusted_hash = "abc"\n'
  + '[marketplaces.vendor]\nsource = "https://p.example/i.json"\nlast_updated = "2026-09-11"\nlast_revision = "r1"\n';
const configFile = path.join(SB, 'config.toml');
const shaOf = (text) => { writeFileSync(configFile, text); return codexConfigSha(configFile); };
const base = shaOf(BASE);
check('codex config: marketplace refresh timestamps leave the hash as it was',
  base !== null && shaOf(BASE.replace('2026-09-11', '2026-10-04').replace('"r1"', '"r2"')) === base);
const edits = [
  `${BASE}[projects."/x"]\ntrust_level = "trusted"\n`, BASE.replace('d.example', 'e.example'),
  BASE.replace('"abc"', '"abd"'), BASE.replace('i.json', 'j.json'), BASE.replace('"m"', '"m"\nlast_updated = "x"'),
  BASE.replace('"m"', '"n"'),
];
check('codex config: an added trust entry, a changed server, hook hash or source, a timestamp outside a marketplace, any other edit all change it',
  edits.every((text) => shaOf(text) !== base) && codexConfigSha(path.join(SB, 'missing.toml')) === null,
  edits.map((text) => shaOf(text) !== base).join(','));
