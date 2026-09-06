import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { run } from './exec.js';
import { PROMPTOBUS_SERVER, KNOCK_TEXT_MAX } from './contract.js';
import { foreignSession, logWarden, writeWake } from './store.js';
import { previewBlock } from './notification.js';
import {
  bgSessions, findSession, liftoffParticipant, resetBgSessionsCache, sayLiftoff, sessionLiveness,
} from './liftoff.js';
import { claudeAvailability } from './model-routing/adapter-claude.js';
import { markExhausted } from './model-routing/cache.js';

// Claude Code harness driver — the first production bus driver.
// This file holds EVERYTHING that knows about
// Claude: its bg-session registry, stall parse, the messaging socket with a token, the
// translation of harness-neutral context into the binary argv, its settings file and MCP
// config, allowed option values, versions, command words, and the text that goes into
// another session.
//
// The boundary is this file: the warden state machine (rounds, thresholds, health,
// escalation, parse of "who to activate") lives in the package and knows nothing about
// Claude — it calls the operations declared here through the registry. Hence the rule:
// the name `claude`, the `claude agents --json` format, binary flags, and words about
// `claude attach` are legal here and forbidden in `src/**` — a separate gate watches this
// ([promptobus-package.test.mjs](../test/promptobus-package.test.mjs)).
//
// **The second rule mirrors the first**: the rest of the engine never imports this
// file — it reaches the driver through the registry map ([drivers.js](drivers.js)), and
// the adapter-boundary gate watches that ([promptobus-adapter.test.mjs](../test/promptobus-adapter.test.mjs)).
// A second driver goes into the registry without touching any file outside `drivers.js`
// and its own `driver-<harness>.js`.
//
// The session registry itself sits one floor down, in [liftoff.js](liftoff.js): it is
// shared with participant lift and was split out before this task.

/** Harness name in the participant record and the key in the registry map. */
export const CLAUDE = 'claude';

function versionLess(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

const CLAUDE_INSTALL = 'npm install -g @anthropic-ai/claude-code (or https://docs.claude.com/en/docs/claude-code/setup)';

function claudeUserMcp(canonServerNames) {
  const file = path.join(homedir(), '.claude.json');
  let names = [];
  if (existsSync(file)) {
    try {
      names = Object.keys(JSON.parse(readFileSync(file, 'utf8'))?.mcpServers ?? {}).sort();
    } catch {
      names = [];
    }
  }
  const canon = new Set(canonServerNames);
  const extras = [];
  const shadowed = [];
  for (const name of names) (canon.has(name) ? shadowed : extras).push(name);
  return { extras, shadowed };
}

// --- harness dictionary: allowed option values and versions ------------------------
//
// These values live here, not in `contract.js`: effort levels, permission modes, and
// denied-tool names are ONE harness's dictionary, and a second driver has its own.
// `contract.js` keeps only the harness-neutral parts. Documentation quotes of the
// contract still stand: `lint` reads the value from the new home; quote keys did not
// change.

// Allowed --effort values — same as the `claude --effort` flag
// (https://code.claude.com/docs/en/model-config#adjust-effort-level).
// The flag also accepts `ultracode`: xhigh effort with dynamic workflow orchestration.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];

// Allowed --permission-mode values — same as the `claude --permission-mode` flag (list
// from `claude --help` 2.1.251). A worker defaults to `auto`: `acceptEdits` skips
// prompts only for file edits and still asks on every ordinary Bash command — a
// background worker would stall on the first one; `auto` asks a person on commands
// outside the usual class (a Docker stand, directories outside the worktree, `rm -rf`),
// and a track with such a stand gets its permission bar from the orchestrator via a
// flag on one spawn.
export const PERMISSION_MODES = ['auto', 'acceptEdits', 'bypassPermissions', 'dontAsk', 'manual', 'plan'];
export const DEFAULT_PERMISSION_MODE = 'auto';

// Participant model without a `--model` flag. It lives here, not on the lift commands:
// the model name is harness dictionary, and a second driver does not share it. The
// value is unchanged: the user's session default may be more expensive, so the engine
// names the model itself.
export const DEFAULT_MODEL = 'opus';

// Model aliases the harness publishes under `--model`, in the order its help
// prints them (`claude --help` 2.1.251, measured 2026-09-05: "an alias for the
// latest model (e.g. 'fable', 'opus', or 'sonnet')").
//
// **An alias names whatever the vendor points it at today, and that is why the
// catalog rates none of them.** A rated row keyed on `opus` keeps its ratings, its
// `assessedAt` and its evidence when the alias moves to a new model, and starts
// describing a model nobody assessed — silently, because the staleness warning
// fires on the calendar rather than on a re-point (PB-13.1). The rows name full ids
// instead; a new model gets a new rated row, and the "latest" behaviour of an alias
// is given up on purpose.
//
// The lift is unchanged by any of it: `--model` is still passed through as the
// person named it, an alias is as lawful there as a full name, and `DEFAULT_MODEL`
// is still the alias.
export const MODEL_ALIASES = ['fable', 'opus', 'sonnet'];

// Full model names this driver accepts under `--model` verbatim, and the ones the
// routing catalog rates. Measured 2026-09-05 on `claude` 2.1.251: `--model`'s own
// help says it takes "an alias for the latest model … or a model's full name (e.g.
// 'claude-fable-5')", and the binary carries the model table those names come from
// — `{id:"claude-opus-5",family:"opus",…}` and the same for `claude-sonnet-5`,
// found by grepping the installed binary, which is the only listing this harness
// publishes at all (no `models` subcommand, no `--list-models`).
//
// The list is the RATED half of the inventory. A full name that no tuple rates is
// not put here to be shown; a name here that the catalog stops rating shows up in
// `promptobus models` as an unrated runtime row, which is exactly what that row is
// for.
export const MODEL_IDS = ['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5'];

// The display names the harness prints on a model-scoped limit row, and the ids
// each one resolves to. The availability adapter needs it and does not own it:
// this is the same dictionary `MODEL_ALIASES` and `MODEL_IDS` are, read from the
// side a display name arrives on, and a copy of it inside the adapter would go on
// naming an id nobody points at any more after a repin — silently, because a
// scope that resolves to a stale id binds no row and prints no complaint.
//
// `claude-fable-5` is the id this binary's own alias table resolves `fable` to,
// and the id lags the model the newest builds run — PB-34 has the evidence and
// the successor this driver cannot start yet.
export const MODEL_SCOPE_IDS = {
  fable: ['claude-fable-5'],
  opus: ['claude-opus-5'],
  sonnet: ['claude-sonnet-5'],
};

// What the availability adapter reports as the inventory: the full ids the catalog
// rates, the aliases the binary publishes, and the model this driver lifts
// participants on. All three, because the inventory answers "what can this account
// run" and each of them is an answer: the ids are what a routed pick names, the
// aliases are what a person may type, and `DEFAULT_MODEL` is what a spawn without a
// `--model` flag asks for — a default that vanished from the inventory would still
// be the thing every lift uses.
const PROBE_MODELS = [...new Set([...MODEL_IDS, ...MODEL_ALIASES, DEFAULT_MODEL])];

// Claude version from which `ultracode` reaches the session. Source: Claude Code
// CHANGELOG — dropping `--effort ultracode` without a word was fixed in 2.1.210; on
// 2.1.169 the binary writes a warning to stderr and lifts the session on the default
// effort (measured 2026-08-28).
export const ULTRACODE_MIN_VERSION = '2.1.210';

// Tools taken from the reviewer: it reads and writes a report on the bus, but does not
// edit and does not go outside. The same list lifts the headless run (headless.js),
// and only the canary smoke calls it: the role is different, the guarantee is the same.
// Tightening reviewer denies changes the canary conditions — see smoke.js before adding
// a name here.
export const REVIEWER_DENY = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch'];

// Claude version on which warden delivery by injection into the messaging socket was
// proven. This is NOT a minimum version and not a gate: the injection surface is
// undocumented and rides with the binary version in silence, and an injection refusal
// does not fail delivery to the others — the participant simply learns about the
// message only when it calls `mailbox` itself.
// The number is for something else: `promptobus status` and `doctor` name the version
// the channel was measured on, so a "why the participant does not wake" lookup starts
// with a version check.
// Source: spike 2026-08-29, binary 2.1.251.
export const PROVEN_CLAUDE_VERSION = '2.1.251';

// Parent variables that must not reach the participant: `CLAUDE_PID` in the child
// process points at a foreign session, `CLAUDE_EFFORT` leaks a stale value.
//
// Dropping `CLAUDE_EFFORT` does not change the session effort — proven live on
// 2026-08-28 on `claude` 2.1.237 by the `effort` field in the transcript (three
// headless runs in a clean directory): `CLAUDE_EFFORT=max` without a flag → xhigh; no
// variable, no flag → xhigh; `CLAUDE_EFFORT=max, --effort low` → low; on 2.1.237 the
// default without a flag is xhigh. The suite is not our contract: re-check when the
// Claude Code version changes.
export const SESSION_ENV_DROP = ['CLAUDE_PID', 'CLAUDE_EFFORT'];

/**
 * Harness words the adapter inserts into its own strings. Shared prose stays
 * with it, the command stays here: otherwise everyone who prints a session line
 * would know `claude attach`, and a second harness would have to be split across
 * all those places.
 */
export const PHRASES = {
  sessions: 'claude agents',
  unreadable: 'claude agents --json is unreadable',
  enter: (id) => `claude attach ${id}`,
  // Without an identifier — the bare command name: the route for a vanished record
  // names it as the REASON ("a person may have dropped the session: claude stop
  // removes the record entirely"), not as a line to copy, and there is no id to
  // take there.
  stop: (id) => (id ? `claude stop ${id}` : 'claude stop'),
  logs: (id) => `claude logs ${id}`,
  // MCP tool name as the Claude Code session calls it. The client namespaces it
  // itself (`mcp__<server>__<name>`), but the short model name is enough, and the
  // participant prompt has named it that way since the first bus release — the form
  // was proven by live correspondence. A second harness writes it differently, so
  // this is a driver word.
  tool: (_server, name) => name,
  // Claude Code does not append its own rules to the participant prompt: its
  // background-session habits are described by the prompt itself and the workspace
  // rules.
  promptRules: '',
};

// How long we wait on the socket: waiting forever on a dead socket would halt
// delivery to the others.
export const KNOCK_TIMEOUT_MS = 3000;

// Sender name in the injection `from` field: the recipient uses it to tell who
// wrote the turn.
export const KNOCK_FROM = 'promptobus-warden';

// --- session-state parse --------------------------------------------------

// Claude config directory — the same one that holds `jobs/` and `daemon/`.
function claudeHome(env = process.env) {
  return env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
}

// The reason goes into one-line output. The `state.json` format is not a contract —
// a whole brief paragraph used to land in `detail`, so we flatten to one line and
// cut by length here.
const DETAIL_MAX = 160;

function oneLine(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > DETAIL_MAX ? `${flat.slice(0, DETAIL_MAX - 1)}…` : flat;
}

// `detail` line of a background session by its short id (the same one `claude
// attach` and `claude logs` take). Throws nothing: anything missing — null.
export function sessionDetail(id, home = claudeHome()) {
  if (!id) return null;
  try {
    const raw = JSON.parse(readFileSync(path.join(home, 'jobs', String(id), 'state.json'), 'utf8'));
    return (typeof raw?.detail === 'string' ? oneLine(raw.detail) : '') || null;
  } catch {
    return null;
  }
}

// An exhausted limit is known from the harness's own line: the session writes its
// reasons in its own words, and catching them with a template would call everything
// a limit.
//
// The second alternation is CAPTURED, and only the late-start mark reads the group:
// it is the branch where the harness itself said the limit resets, which makes the
// exhaustion the subscription's rather than one nobody explained. `sessionStall`
// below asks `.test` and is unaffected by the group.
const LIMIT_DETAIL = /\bhit your\b[^\n]*\blimit\b|(\blimit\b[^\n]*\bresets\b)/i;

/**
 * Late-start classification: a lift that failed because the limit was spent marks
 * the harness exhausted in the availability cache, and returns the line the lift
 * appends to its refusal — `''` when there was nothing to mark.
 *
 * **The line exists because the mark is invisible otherwise.** A person whose
 * participant refused to start would otherwise be left with a file they never
 * open holding a state that neither time nor a later probe lifts. So the refusal
 * names the file and the way out of it.
 *
 * The pattern is the one above and not a second one. A limit refusal reads the
 * same whether the session wrote it after a turn or the binary wrote it instead
 * of starting, and two patterns for one fact would drift on the first build that
 * rewords the line. Which alternation matched chooses the code: the harness saying
 * the limit RESETS makes it the subscription's limit, `subscription_exhausted`;
 * otherwise nothing explains it and it is `manual_exhaustion`.
 *
 * `resetAt` stays `null` on both, so both are the sticky kind. The harness names
 * its reset in a person's words and a person's timezone ("resets 3pm"), and a
 * timestamp parsed out of that would be invented rather than measured — an
 * exhaustion that expires at a made-up moment is worse than one that waits for a
 * person, because it lifts itself and nobody learns the account was out.
 *
 * The entry goes through `markExhausted` with its reason stated rather than
 * derived: the helper's own derivation reads `resetAt` alone, and this branch has
 * to be able to say "the subscription named a reset this driver refuses to parse"
 * — `subscription_exhausted` with no reset. One fact, one door into the cache.
 *
 * A cache failure does not replace the lift's own refusal: the person is about to
 * be told why their participant did not start, and a write error on the way there
 * would take that diagnosis with it.
 */
export function markLimitAtStart(host, output) {
  const hit = host ? LIMIT_DETAIL.exec(String(output ?? '')) : null;
  if (!hit) return '';
  const named = Boolean(hit[1]);
  try {
    const { cacheFile } = host.routingPaths();
    markExhausted(host, CLAUDE, {
      reason: named ? 'subscription_exhausted' : 'manual_exhaustion',
      message: named
        ? 'limit hit at start; the harness said the limit resets but named no time to parse'
        : 'limit hit at start; the harness named no reset time',
    });
    return ` The account limit was spent, so harness "${CLAUDE}" is now marked exhausted in ${cacheFile}:`
      + ' neither time nor a later probe lifts that mark. Clear it with `promptobus models --clear-exhausted'
      + ` ${CLAUDE}\`` + ', or delete that harness entry from the file.';
  } catch {
    return '';
  }
}

// Session stall: `null` — no stall, otherwise `{ kind, reason }`. `kind` is
// `permission` (waiting for a person at a dialog), `limit` (clears itself), or
// `unknown` (no route is derived).
// The session list carries half the reason: `waitingFor` exists only on a session
// standing at a dialog; a limit has nothing. The other half is on the background-
// session daemon: `<claude config>/jobs/<id>/state.json`, field `detail`. The
// format is not a contract: unreadable — there is no reason, and inventing one is
// forbidden.
//
// **The parse entry is TURN END, not the `blocked` state**. Before this task the
// entry sat on `state === 'blocked'`, and on `claude` 2.1.251 no session that had
// finished a turn ever entered it: a live-run measurement on 2026-09-02 (six
// `claude agents --json` snapshots, 20 s apart) gave both sessions `status: idle`,
// `state: done`, `waitingFor: null`, and across all nine machine records the
// background sessions showed exactly two pairs — `busy/working` and `idle/done`.
// So a silent participant was invisible entirely, and the report never left —
// a live E2E run caught this, where the report verdict went red on a healthy
// stand.
//
// So `unknown` is opened on `status: idle` in ANY state, and `busy`/`working`
// WITHOUT a dialog mark is not a stall at all: a turn is running. The dialog mark
// does not ask for state and sits above the gate on purpose — a session stuck on
// a permission prompt mid-turn waits for a person regardless of what it is busy
// with. `blocked` stays an entry alongside `idle` — records from older builds
// arrive with it, and dropping it would change behaviour where it already worked.
// The only `unknown` filter is the silence gate `stallStands` in the state
// machine: it separates a normal turn end from a real stall.
export function sessionStall(session, detail = undefined) {
  if (!session) return null;
  // The dialog mark is checked first, and the file is not read for it: the warden
  // polls state on every heartbeat for every stalled session. It does not ask for
  // state: `waitingFor` is issued only to a session standing at a dialog, and the
  // field has no other meaning.
  if (session.waitingFor) return { kind: 'permission', reason: oneLine(session.waitingFor) };
  const blocked = session.state === 'blocked';
  const idle = String(session.status ?? '').toLowerCase() === 'idle';
  if (!blocked && !idle) return null;
  const said = detail === undefined ? sessionDetail(session.id) : oneLine(detail ?? '') || null;
  if (said && LIMIT_DETAIL.test(said)) return { kind: 'limit', reason: said };
  // No reason — name the mark we entered the parse on, do not invent a state.
  return { kind: 'unknown', reason: said ?? (blocked ? 'blocked' : 'idle') };
}

// What to do with this stall. One line for every consumer: `promptobus status`, the
// warden report, the `mailbox` reply. The routes are Claude-specific in full —
// `claude attach`, `claude logs`, `claude stop` — and so they live on the driver,
// not in the state machine.
// The commands themselves come from `PHRASES` (review note): a second home for the
// same line would mean the route and the adapter advise a person differently after
// the first edit.
export function stallRoute({ kind, address, repoAbs, task }, id, name) {
  // The reviewer and the worker are lifted again with different commands:
  // `promptobus spawn` opens a `worker:` address, and the reviewer has no worktree
  // at all.
  const relift = () => (address?.startsWith('reviewer:')
    ? `lift the reviewer again: promptobus review "${repoAbs ?? '<clone path>'}"${task ? ` --task ${task}` : ''}`
    : `lift the worker again with the same spawn — it will sit in its own worktree and branch`);
  if (kind === 'stale') {
    return `nobody to wake — no process behind the record. Check: ${PHRASES.logs(id)} (a «job not found» reply confirms), `
      + `and ${relift()}`;
  }
  // No record at all: nothing to check with. Softer words than `stale` — the
  // session may have vanished normally (`claude stop` drops the record entirely
  // after delivered work).
  if (kind === 'gone') {
    return `the session is not in the list — nobody to wake. A person may have removed it: ${PHRASES.stop(null)} drops `
      + `the record entirely. Work delivered — that is a normal end, nothing to do; not delivered — ${relift()}`;
  }
  // Contact point taken: the session is alive and working; it is deaf only to
  // notifications. A person has nothing to do here — the record repairs itself —
  // but they must know: until this moment the addressee has not seen the messages.
  if (kind === 'wake-taken') {
    return 'the session is alive; only the channel is deaf: the contact point returns to it on its next '
      + `turn end. Until then deliver the message yourself — ${PHRASES.enter(id)}; if another session `
      + 'keeps rewriting the channel, it has an old bus release — update the workspace';
  }
  if (kind === 'permission') return `only a person can answer: ${PHRASES.enter(id)} (or drop the session: ${PHRASES.stop(id)})`;
  if (kind === 'limit') {
    return 'no person needed: the limit resets on its own, and you can wake the session with a message '
      + `(in Claude Code — SendMessage to session «${name}»)`;
  }
  return `no route for this reason — see ${PHRASES.logs(id)}: `
    + `next either answer the session (${PHRASES.enter(id)}) or wake it with a message`;
}

// --- notification text ------------------------------------------------------

// Inter-session message frame — one for both notifications. Both of its properties
// were proven by a live measurement and so survived the shortening: it rests on the
// bus protocol, not on a person's authority (a request "from the user" was deferred)
// by the recipient "until confirmation"), and an explicit refusal to escalate
// permissions — text that stays silent about this reads as suspicious. There is no
// need to expand it back into a paragraph: Claude Code itself wraps the body in
// the "Another Claude session sent a message" frame with warnings (about 650
// characters, not ours). Dropping it entirely is also wrong — without such a wrap
// this phrase is the only one the driver has.
const NOT_A_HUMAN = 'This is a notification, not a human assignment, and it grants no permissions.';

// Tail of the mailbox order: the action line and the frame. Two paragraphs used to
// sit here on every knock — about 430 characters: the working order that already
// lives in the participant prompt and the orchestration skill, and a private copy
// of the Claude Code warnings. Measurement 2026-09-01 (promptobus task): 30
// notifications to the orchestrator for 17 mailbox reads, so the tail left thirty
// times.
const KNOCK_TAIL = 'Fetch the mailbox: only mailbox marks messages read; the working order is '
  + `in the bus rules. ${NOT_A_HUMAN}`;

// Injection body. Self-contained: it is read out of context, so it names the task,
// the address, and what to do. The excerpt block and its budget are arithmetic
// shared by all harnesses, and they live in the [notification.js](notification.js)
// leaf (review note): the driver keeps the frame and the words of its channel. The
// renderer applies the budget: another channel has its own cost per character.
export function orderBody(task, addr, unread, msgs = []) {
  return `Promptobus service notification. The mailbox for address ${addr} on task ${task} has unread: ${unread}.\n\n`
    + previewBlock(msgs, KNOCK_TEXT_MAX)
    + KNOCK_TAIL;
}

// Structural notification of the state machine — into this channel's text. The
// mailbox order.
export function renderNotification(n) {
  return orderBody(n.task, n.address, n.unread, n.messages ?? []);
}

// --- messaging socket ------------------------------------------------------------

// Knock on the participant's messaging socket: one connection, two lines of
// line-delimited JSON.
// The auth line is always sent, even though macOS does not check it (`authRequired`
// is on only on Windows): code without it is not portable.
function dial(socketPath, lines, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    let sock;
    try {
      sock = connect(socketPath);
    } catch (e) {
      finish({ ok: false, error: e.code ?? e.message });
      return;
    }
    sock.setTimeout(timeoutMs);
    sock.on('error', (e) => {
      finish({ ok: false, error: e.code ?? e.message });
      sock.destroy();
    });
    sock.on('timeout', () => {
      finish({ ok: false, error: 'socket did not reply' });
      sock.destroy();
    });
    sock.on('connect', () => {
      // `end` only HALF-closes the connection: the listener holds it for its own
      // thirty seconds, and the injection protocol has no reply — hence `destroy`
      // at once.
      sock.end(`${lines.join('\n')}\n`, () => {
        finish({ ok: true });
        sock.destroy();
      });
    });
  });
}

function authLine(token) {
  return JSON.stringify({ type: 'auth', token: token ?? '' });
}

export function knockSocket(endpoint, body, { timeoutMs = KNOCK_TIMEOUT_MS } = {}) {
  return dial(endpoint.socket, [
    authLine(endpoint.token),
    JSON.stringify({
      msgV: 1,
      msg_id: randomUUID(),
      type: 'user',
      message: { role: 'user', content: body },
      priority: 'next',
      from: KNOCK_FROM,
    }),
  ], timeoutMs);
}

// Channel smoke for `doctor`: a connection and one auth line, no message — the
// socket file is there, the listener accepts. A connection without a second line
// is harmless to the listener.
export function probeWake(socketPath, token, { timeoutMs = KNOCK_TIMEOUT_MS } = {}) {
  return dial(socketPath, [authLine(token)], timeoutMs);
}

/**
 * Wake channel of THIS session — the diagnostics entry. Only the harness knows
 * where the socket address lives and what the variable is called, so `doctor`
 * asks for the outcome, not the variables: `endpoint: null` — the session does not
 * hand off a socket at all, and the reason is named in the harness's words. The
 * smoke does not send a real message: that would cost a record in the feed of the
 * person who asked about the layout.
 */
export async function checkWake(env = process.env) {
  const socket = env.CLAUDE_CODE_MESSAGING_SOCKET?.trim();
  if (!socket) return { endpoint: null, ok: false, error: 'CLAUDE_CODE_MESSAGING_SOCKET is empty' };
  const r = await probeWake(socket, env.CLAUDE_CODE_MESSAGING_TOKEN);
  return { endpoint: socket, ok: !!r.ok, error: r.ok ? null : String(r.error ?? '') };
}

// Hand off this session's contact point into the task store. The participant's
// own bus child processes call this — Claude Code puts the socket address and the
// session token into their environment. Nothing to hand off (not Claude Code, an
// older binary) — the participant will come for the message itself.
//
// **A write for a foreign address is refused**. The address is bound to a session
// in the journal, and only that session may hand it off: a foreign one would
// overwrite the first participant's channel with its own socket, and
// notifications would go elsewhere — eleven left that way in ten minutes of the
// 2026-09-03 run.
// The gate sits here, not on the two callers: both the participant's bus server
// and its Stop hook hand off the contact point, and diverging copies of the rule
// would mean a hole in one of them.
//
// **The session arrives as an ARGUMENT, not only from the environment** (review
// note). A Stop-hook process is not promised `CLAUDE_CODE_SESSION_ID` — it
// resolves its session from the event payload
// — and if we read only the environment here, on a machine without the variable
// the record would land WITHOUT a `session` field. The owner's stamp would be
// wiped on every turn end, and the second line would stop distinguishing at all.
// The default is still the environment: the participant's bus server is a child
// of the session, and it has the variable.
export function registerWake(home, task, addr, env = process.env, session = null) {
  try {
    const who = session ?? env.CLAUDE_CODE_SESSION_ID?.trim() ?? null;
    const held = foreignSession(home, task, addr, who);
    if (held) {
      sayForeignWrite(home, task, addr, held, who, `contact-point handoff`);
      return null;
    }
    return writeWake(home, task, addr, {
      socket: env.CLAUDE_CODE_MESSAGING_SOCKET?.trim() || null,
      token: env.CLAUDE_CODE_MESSAGING_TOKEN?.trim() || null,
      session: who || null,
    });
  } catch {
    // A safety net must not drop a bus-tool call.
    return null;
  }
}

// A gate refusal must be VISIBLE (review note). A silent `null` looks like healthy
// work: the participant simply "did not hand off a socket", the warden falls back
// to self-wake as usual, and diverging session-id spellings on the next harness
// build would stop the bus without a single line. We write to the warden journal —
// the same file a person uses to look up "why the participant was silent";
// `promptobus status` shows the same trouble on the wake line.
//
// **The gate has two doors, and both speak** (second review round). Here — the
// bus-server handshake; on the loop guard the gate sits before `registerWake`,
// and if it stayed silent there, the most common entry into this trouble — a
// foreign Stop hook — would stay invisible. So the function is shared and
// exported; what exactly was not done arrives in the caller's words.
//
// Once per reason and per process: the participant's bus server lives the whole
// session and hands off the contact point on every handshake, and the hook
// process is short and will write the line at most once per turn.
const foreignWrites = new Set();

export function sayForeignWrite(home, task, addr, held, session, what) {
  const key = [home, task, addr, held, session, what].join('\u0000');
  if (foreignWrites.has(key)) return;
  foreignWrites.add(key);
  logWarden(home, task, `${what} for address ${addr} is refused: the address is bound to session ${held}, `
    + `and ${session} is writing — the owner's records were left untouched`);
}

// --- translate harness-neutral context into this harness's config and argv ------
//
// Nothing sticks out from here: config and argv assembly are halves of ONE
// `prepare` operation, and the caller does not build the command in pieces. It
// names the subject ("directories the participant may read", "the loop-guard
// command"), and this file decides how that looks to the binary.

// Participant MCP config: a harness-neutral server list into the form the binary
// reads. Which servers — lift decides (the workspace canonical suite plus the bus
// record itself); how they sit in the file — this driver.
function mcpConfig({ servers }) {
  return { mcpServers: { ...servers } };
}

// Pre-approve delivered servers: `--allowedTools mcp__<name>` for each name in
// the config. The reviewer is lifted without `--permission-mode` and would stall
// on a permission prompt from the first non-bus server. The bus first, the rest
// alphabetically — the order is stable.
function mcpAllowedTools(mcpCfg) {
  const names = Object.keys(mcpCfg.mcpServers ?? {});
  return [PROMPTOBUS_SERVER, ...names.filter((n) => n !== PROMPTOBUS_SERVER).sort()].map((n) => `mcp__${n}`);
}

// Binary argv from the lift context. `--mcp-config` and `--allowedTools` are
// variadic on claude: they eat positional arguments until the next option, and a
// prompt after them would go into their list — the session would lift empty. So
// the prompt sits only after a non-variadic option and always last.
function spawnArgv({
  ref, mcpConfigPath, mcpConfig: cfg, addDirs = [], pluginDir = null, settingsPath,
  model, effort = null, permissionMode = null, prompt,
}) {
  return [
    '--bg',
    '--name', ref,
    '--mcp-config', mcpConfigPath,
    '--allowedTools', ...mcpAllowedTools(cfg),
    ...(addDirs.length ? ['--add-dir', ...addDirs] : []),
    ...(pluginDir ? ['--plugin-dir', pluginDir] : []),
    '--settings', settingsPath,
    '--model', model,
    // --effort — only when set explicitly: without the flag the session lifts on
    // the binary default.
    ...(effort ? ['--effort', effort] : []),
    ...(permissionMode ? ['--permission-mode', permissionMode] : []),
    prompt,
  ];
}

// Hook event the loop guard stands on. The event name is a Claude Code contract,
// and it has one home for two doors: the workspace layout
// (`guardhook.js`) and the participant settings file. A READY
// command is wrapped here: the adapter builds it (it knows the workspace binary
// path), and the harness knows the form it lands in.
const GUARD_HOOK_EVENT = 'Stop';

/**
 * Participant settings file: `enableAllProjectMcpServers` — otherwise a bg-session
 * in a repository with `.mcp.json` stalls on an interactive server-choice dialog,
 * and nobody is there to answer; `viewMode: focus` — a person who looks in gets a
 * summary instead of a sheet of tool calls. `permissions.deny` is the FIRST key
 * and only where tools are denied: key order in the file is not behaviour, but
 * there is no reason to reshuffle it without cause.
 */
function settingsFile({ denyTools, guardCommand, extraSettings }) {
  return {
    ...(denyTools?.length ? { permissions: { deny: denyTools } } : {}),
    enableAllProjectMcpServers: true,
    viewMode: 'focus',
    hooks: { [GUARD_HOOK_EVENT]: [{ hooks: [{ type: 'command', command: guardCommand }] }] },
    ...extraSettings,
  };
}

/**
 * Lift plan from harness-neutral context. Writes nothing and starts nothing:
 * `--dry-run` prints exactly this object, and the real lift executes the same
 * one — a split between print and deed has nowhere to come from.
 */
function prepare({
  ref, mcp, prompt, model, effort = null, permissionMode = null,
  addDirs = [], pluginDir = null, mcpConfigPath, settingsPath,
  guardCommand, denyTools = null, extraSettings = {},
}) {
  const cfg = mcpConfig(mcp);
  const settings = settingsFile({ denyTools, guardCommand, extraSettings });
  return {
    argv: spawnArgv({
      ref, mcpConfigPath, mcpConfig: cfg, addDirs, pluginDir, settingsPath,
      model, effort, permissionMode, prompt,
    }),
    mcpConfig: cfg,
    settings,
    // File order is write order. The config carries substituted tokens of the
    // canonical servers and is therefore marked secret: placing it at `0600` is
    // the caller's job; the harness does not need to know about `chmod`.
    files: [
      { path: mcpConfigPath, text: `${JSON.stringify(cfg, null, 2)}\n`, secret: true },
      { path: settingsPath, text: `${JSON.stringify(settings, null, 2)}\n`, secret: false },
    ],
  };
}

// Environment of the lifted session: inherited values stay, then parent variables
// that leak foreign values are dropped. What the engine itself puts in (the
// memory-hook lever) arrives as an argument — that is not a harness property.
function sessionEnv(base = process.env, extra = {}) {
  const env = { ...base, ...extra };
  for (const name of SESSION_ENV_DROP) delete env[name];
  return env;
}

// Refusal is pointed, not a lift of a shared `minVersion`: only the caller who
// asked for `ultracode` pays. Version unread — we do not refuse: the engine may
// not claim "older than needed" about what it did not read (the same rule as
// `toolVersionCheck`).
function optionRefusal({ effort = null } = {}, tool) {
  if (effort !== 'ultracode') return null;
  if (!tool?.version || !versionLess(tool.version, ULTRACODE_MIN_VERSION)) return null;
  return `--effort ultracode: found claude ${tool.version}, and this keyword reaches the session `
    + `from ${ULTRACODE_MIN_VERSION}. A lower binary drops it with a stderr warning and lifts the session `
    + 'on the DEFAULT effort (measured 2026-08-28 on 2.1.169) — silent degradation instead of what was asked: '
    + 'the task log and promptobus status still name the effort that was requested. '
    + `Update the binary (${CLAUDE_INSTALL}) or lift the participant with --effort xhigh.`;
}

// Canonical-server names shadowed by the user's personal records. The personal
// config is a harness property: a second driver keeps it in another place and
// another format.
function shadowedUserServers(names) {
  return claudeUserMcp(names).shadowed;
}

// --- driver operations ----------------------------------------------------------

// State of one session for a snapshot. The list comes from the registry cache: a
// snapshot is built across all participants at once, and without it each would
// cost a `claude agents --json` run.
// List unreadable — `null`: unknown is not death, and the snapshot is dropped
// entirely.
//
// A second argument may pass the list explicitly — that is how a suite builds a
// snapshot from a stub harness reply without touching a live `claude`. The state
// machine calls with one argument: it does not know about the list at all.
function inspect(ref, sessions = undefined) {
  const list = sessions === undefined ? bgSessions() : sessions;
  if (list === null) return null;
  const hit = findSession(list, ref);
  // No record at all: `claude stop` drops it entirely, and a failed lift never
  // creates one. The words about this are our own: the state machine does not
  // know about `claude agents` and must not.
  if (!hit) {
    return {
      state: 'gone',
      busy: false,
      stall: { kind: 'gone', reason: 'no session record in claude agents' },
      id: null,
      note: null,
    };
  }
  const live = sessionLiveness(hit, list);
  return {
    state: live === 'stale' ? 'stale' : 'alive',
    // Busyness is the record's `status` field: `busy` while thinking, `idle` after
    // giving up the turn.
    busy: String(hit.status ?? '').toLowerCase() === 'busy',
    // A record that outlived its daemon also has `blocked`, but there is no stall
    // to parse: nobody to wake, and that is a separate outcome with its own words.
    stall: live === 'stale' ? { kind: 'stale', reason: 'the record outlived its daemon' } : sessionStall(hit),
    id: hit.id ?? null,
    note: hit.status ?? hit.state ?? 'running',
  };
}

// Lift a background session from its plan. Start and the "session lifted" check
// are a helper shared with the reviewer role [liftoff.js](liftoff.js): line-by-
// line copies already drifted on that check. Argv comes from the plan, not built
// again: the plan is what gets executed.
async function spawn(plan, { tool, ref, role, cwd, env, launchFailNote, deadNote, persist, awaitOptions, host }) {
  return liftoffParticipant({
    tool, argv: plan.argv, cwd, env, name: ref, role, launchFailNote, deadNote, persist, awaitOptions,
    // The late-start hook. `host` is what names the availability cache; a caller
    // that hands none — the suite's lift checks — simply gets no mark, and the
    // lift behaves exactly as it did before.
    sayLimit: (output) => markLimitAtStart(host, output),
  });
}

// Ceiling for waiting on session death, and the poll step.
//
// **The numbers were measured on a live stop**, not chosen: 2026-09-03, `claude`
// 2.1.251, three runs in a row — `claude stop <id>` returns in 677, 801, and 898
// ms, and the record leaves `claude agents --json` after 1070, 1145, and 1218 ms
// from the start of the call. So the command returns 270–390 ms BEFORE the
// session is gone from the registry. The 10 s ceiling is an eightfold margin on
// the worst measurement: it is not the cost of a normal stop, but the limit past
// which we stop waiting and say so out loud.
//
// The poll step is shorter than the poll itself: each probe is a `claude agents
// --json` run, measured there at 0.34–0.41 s, and a step shorter than that adds
// no processes and would add extra wait. At the ceiling that is about twenty
// probes, and only on a hung stop.
const STOP_GONE_TIMEOUT_MS = 10_000;
const STOP_GONE_STEP_MS = 100;

// Wait until the session record is gone from the registry. Outcome is a
// tristate: `gone` — no record, `timeout` — the ceiling ran out, the record is
// still there, `unreadable` — the registry is unreadable.
//
// Three, not two (review note): saying "session closed" on an unreadable
// registry means asserting the unchecked — that is exactly what the engine leaves
// by the "unknown is not death" rule. The caller maps both `timeout` and
// `unreadable` to one "stop not confirmed" outcome, but their reasons differ, and
// they tell a person different things.
//
// The list is taken fresh on every probe: a parsed reply is remembered until
// reset, and without `fresh` the loop would read the same snapshot until the
// ceiling.
async function awaitSessionGone(ref, { timeoutMs = STOP_GONE_TIMEOUT_MS, stepMs = STOP_GONE_STEP_MS } = {}) {
  const edge = Date.now() + timeoutMs;
  for (;;) {
    const list = bgSessions({ fresh: true });
    // No point repeating on an unreadable reply: a parse refusal is not cached,
    // and the next probe would ask the same external process with the same
    // outcome until the ceiling.
    if (list === null) return 'unreadable';
    if (!findSession(list, ref)) return 'gone';
    if (Date.now() >= edge) return 'timeout';
    await new Promise((r) => { setTimeout(r, stepMs); });
  }
}

// Stop a background session: `claude stop <id>`. The identifier is taken from the
// registry by ref — the task journal holds the name, the command takes the short
// id.
//
// **Idempotent, and that is not a relaxation**: `promptobus done` stops it across
// the whole participant list, and by then the session record may already be gone
// lawfully — a person dropped it, a lift once failed, the daemon died. "Nothing
// to stop" is an outcome with its own words, not a refusal: otherwise cleanup
// would trip on the normal order of things.
//
// **The operation returns after the record is gone, not after the command
// returns**. A live `claude stop` replies before the session leaves the
// registry, and directory cleanup follows the stop: it asks for session state
// and on a still-live record lawfully keeps the worktree ("will be removed on
// the next promptobus done"). The live run of 2026-09-03 00:14 went red on
// exactly this — four verdicts on steps 13–14 with a green stop.
async function stop(ref, waitOptions = undefined) {
  const list = bgSessions();
  if (list === null) return { ok: true, stopped: false, note: `session «${ref}» state is unreadable — nothing to stop at random` };
  const hit = findSession(list, ref);
  const id = hit?.id ?? null;
  if (!hit) return { ok: true, stopped: false, note: `session «${ref}» is not in the list` };
  // What stands behind a record without an identifier is not visible from here,
  // and there is nothing to assert about its process (review note): said is
  // exactly what is known — nothing to stop with.
  if (!id) return { ok: true, stopped: false, note: `record «${ref}» has no identifier — nothing to stop with` };
  const r = run('claude', ['stop', id], { encoding: 'utf8' });
  if (r.error) return { ok: false, stopped: false, note: `claude stop ${id}: ${r.error.message}` };
  if (r.status !== 0) {
    const said = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n')[0] ?? '';
    return { ok: false, stopped: false, note: `claude stop ${id} exited with code ${r.status}${said ? `: ${said}` : ''}` };
  }
  // The list changes after `stop` — without a reset the next reader would see a
  // closed session as alive.
  resetBgSessionsCache();
  const seen = await awaitSessionGone(ref, waitOptions);
  if (seen !== 'gone') {
    // Stop ran, but there is nothing to confirm it with: the session may still be
    // dying, or the registry after the command is unreadable. Declaring it
    // stopped is forbidden — directory cleanup follows this outcome. `ok`,
    // because the command ran: what failed is the CONFIRMATION, not the stop, and
    // `attempted` sets this outcome apart from "the session was already gone
    // before the command".
    return {
      ok: true,
      stopped: false,
      attempted: true,
      note: seen === 'unreadable'
        ? `claude stop ${id} ran, the registry after it is unreadable — stop not confirmed`
        : `claude stop ${id} ran, but the session record did not leave claude agents in `
          + `${Math.round(STOP_GONE_TIMEOUT_MS / 1000)} s — the harness has not finished stopping it`,
    };
  }
  return { ok: true, stopped: true, note: `session ${id} closed` };
}

/**
 * Claude Code driver. `attach` is not declared: the CLI has no user attach to a
 * foreign session at all (outside the first stage). The rest is declared and
 * implemented.
 *
 * Four capabilities beyond the previous five declare binary PROPERTIES, not
 * operations: `denyTools` — `permissions.deny` in the settings file (the
 * read-only reviewer stands on it), `systemPrompt` — the `--settings` file
 * itself, `sessionList` — the `claude agents --json` registry, `enter` — a
 * person entering the session (`claude attach`). Claude Code has all four.
 */
export const claudeDriver = {
  id: CLAUDE,
  capabilities: {
    spawn: true,
    attach: false,
    activation: 'push',
    inspect: true,
    stop: true,
    denyTools: true,
    systemPrompt: true,
    sessionList: true,
    enter: true,
  },
  options: {
    // Binary name: the path is resolved by it, and the `--dry-run` command is
    // printed by it.
    tool: CLAUDE,
    effortLevels: EFFORT_LEVELS,
    // Minimum binary version by effort level: the value does not reach the session
    // from every build, and help names the number, not "newer than some".
    effortMinVersion: { ultracode: ULTRACODE_MIN_VERSION },
    permissionModes: PERMISSION_MODES,
    defaultPermissionMode: DEFAULT_PERMISSION_MODE,
    defaultModel: DEFAULT_MODEL,
    denyTools: REVIEWER_DENY,
    provenVersion: PROVEN_CLAUDE_VERSION,
    // Channel — the messaging socket of a live session: a knock writes a turn
    // into it.
    knockChannel: 'socket',
    envDrop: SESSION_ENV_DROP,
    // Claude Code takes the workspace skills directory as a flag on one lift.
    skillsDir: true,
  },
  phrases: PHRASES,
  // Availability adapter — the account question, asked before any session exists
  // ([adapter-claude.js](model-routing/adapter-claude.js)). The inventory it
  // reports is handed over from here: the alias set and the default model are this
  // driver's dictionary, and the adapter must not import them back out of it.
  availability: claudeAvailability(PROBE_MODELS, MODEL_SCOPE_IDS),
  // Translating harness-neutral context into this harness's lift plan is the
  // driver's job, but there is no capability for it: without it there is no
  // `spawn`, and declaring it separately would declare half of one operation.
  prepare,
  spawn,
  saidLiftoff: sayLiftoff,
  inspect,
  forgetSessions: resetBgSessionsCache,
  stop,
  activate: (target, notification) => knockSocket(target.endpoint, renderNotification(notification)),
  renderNotification,
  stallRoute,
  registerWake,
  sayForeignWrite,
  checkWake,
  sessionEnv,
  optionRefusal,
  shadowedUserServers,
};
