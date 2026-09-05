// Bus vocabulary: message types, addresses, task identity, and the foreign-mailbox
// gate wording. No disk, no store — only the grammar and the strings everyone prints.
//
// The home is here, not in either store, because the package has two: production v1
// (`store.ts`) and legacy, kept so migration can still read
// ([legacy-store.ts](legacy-store.ts)). A value that lived in one of them would be
// imported by the other across a version boundary — and they would drift in silence.
import path from 'node:path';

// Protocol v1 message types. **The value lives here**, and that is not a convenience:
// send validates the list, and send must compile and be tested without the CLI. The
// door for the rest of the mechanism is the consumer adapter: `lint` takes the types
// from there, and the two foreign-mailbox gate headings too. They are not in the
// consumer contract at all — that one is a leaf, the feed hook reads it, and every
// workspace layout has its own. There is never a second list in the code: the
// literal-copy gate in `lint` keeps one home per key, and that home is named by the
// `VALUE_HOMES` map in the consumer linter.
export const MESSAGE_TYPES = ['task', 'status', 'question', 'answer', 'artifact', 'result', 'review'];

export const ORCHESTRATOR = 'orchestrator';

/**
 * Harness of a record that neither the journal nor the adapter named. The word is
 * deliberately neutral: harness names do not live in this package at all — they live
 * with the drivers, and this is the admission that the field was never declared. The
 * mechanism fills it from the adapter with the driver-registry fallback.
 */
export const UNDECLARED_HARNESS = 'undeclared';

/** Role of a record whose address does not parse: a hand edit, a journal after a crash. */
export const UNDECLARED_ROLE = 'undeclared';

const ADDRESS_RE = /^(orchestrator|(?:worker|reviewer):[a-z0-9][a-z0-9-]*)$/;
export const TASK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// A gate refusal is addressed to a person, not to a crash dump: printing it with a
// stack would dress the most common lawful outcome as an internal CLI error. A
// command that may call `fail()` does so (`promptobus done`); the planners
// `planSpawn` and `planReview` are also called as pure functions — from the test
// suite and from `--dry-run` — so their refusal stays a throw, and the class carries
// the "expected" mark: the CLI top-level catch recognises it by name, like
// `ResolveError`, and does not print a stack. The same class is what the whole
// store answers with — task-id parse, `readTask`, both task-lock branches, and both
// `resolveIdentity` checks: the participant MCP server calls those too, and
// `fail()` there would kill the server process together with the tool reply. The
// boundary is the command, not the function: `promptobus status --task no-such` and
// `--task 'bad id'` are two typos in the same flag, and a different shape of reply
// would read as a different outcome.
export class GateError extends Error {}

export function isAddress(addr: unknown): boolean {
  return typeof addr === 'string' && ADDRESS_RE.test(addr);
}

// Address to directory name: `:` is not legal on a Windows filesystem. There is no
// reverse collision — `worker-x` is not an address by itself. Since cutover this
// name is also the **store v1 participant id**: legacy addresses move into the new
// store as-is, and the mailbox directory stays the name the former CLI used.
//
// The throw stays bare, and READERS hold it. A new participant record is address-
// checked and will not accept a bad one, but a former-CLI journal or a hand edit
// may already contain one. One broken line must not cost the rest, so every walk
// catches locally and continues (the unread counter in `promptobus status`, secret
// cleanup in `promptobus done`, all three warden walks), and the refusal never
// reaches the top-level catch on any command path.
export function addrDir(addr: unknown): string {
  if (!isAddress(addr)) throw new Error(`unknown address «${addr}» — orchestrator, worker:<slug> or reviewer:<slug>`);
  return (addr as string).replace(':', '-');
}

/**
 * Address role as its own value. Store v1 keeps it as a field on the participant
 * record and does not derive it from the id — it is computed ONCE, when the
 * participant is written, not on every read.
 */
export function roleOf(addr: unknown): string {
  const address = addr as string;
  if (!isAddress(address)) throw new Error(`unknown address «${addr}» — orchestrator, worker:<slug> or reviewer:<slug>`);
  return address === ORCHESTRATOR ? ORCHESTRATOR : address.slice(0, address.indexOf(':'));
}

export function workerAddress(slug: string): string {
  return `worker:${slug}`;
}

export function reviewerAddress(slug: string): string {
  return `reviewer:${slug}`;
}

export function requireTaskId(id: unknown): string {
  if (typeof id !== 'string' || !TASK_ID_RE.test(id)) throw new GateError(`invalid task id: «${id}»`);
  return id;
}

export function tasksDir(home: string): string {
  return path.join(home, 'tasks');
}

export function taskDir(home: string, id: string): string {
  return path.join(tasksDir(home), requireTaskId(id));
}

// Participant files in `workers/` — keyed by address. Spawn, review, and cleanup
// all glue this name; if the copies drifted, cleanup would sweep past them, so the
// name lives here.
export function participantFileStem(address: string): string {
  const [kind, slug] = String(address).split(':');
  // An address with no slug (`orchestrator`) yields no file name at all, and that
  // must not be silent: the glue used to return `undefined`, the template wrote
  // `undefined.mcp.json` — a file nobody looked for and nobody cleaned up. Entry
  // here is unreachable today: the only path is `promptobus done` cleanup, and it
  // cuts off `orchestrator` a line above. The refusal is bare and the same shape
  // as the neighbours in this module (`addrDir`, `roleOf`): it is a caller error,
  // not a refusal to a person, and printing it as a gate would promise a path
  // that does not exist.
  if (!slug) throw new Error(`address «${address}» does not yield a participant file name — it has no slug`);
  return kind === 'reviewer' ? `reviewer-${slug}` : slug;
}

// The slug goes into the task id, the worktree directory, and the branch name —
// into the filesystem and a git-ref — so the output is only `[a-z0-9-]`. We cut
// on a token boundary, not mid-word.
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

export const SLUG_MAX = 24;

export function slugify(text: unknown, max: number = SLUG_MAX): string {
  const latin = String(text ?? '').toLowerCase().replace(/[\u0400-\u04ff]/g, (c) => TRANSLIT[c] ?? '');
  const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug;
  // Look one character past the limit: a hyphen there means the word ended on the boundary.
  const cut = slug.slice(0, max + 1);
  const at = cut.lastIndexOf('-');
  return (at > 0 ? cut.slice(0, at) : slug.slice(0, max)).replace(/-+$/, '');
}

// Clock for `newTaskIdentity`: a real `Date` is fine, and the suite substitutes
// its own — so the UTC branch is checked independently of the machine TZ.
export interface Clock {
  getUTCFullYear: () => number;
  getUTCMonth: () => number;
  getUTCDate: () => number;
  getUTCHours: () => number;
  getUTCMinutes: () => number;
  getUTCSeconds: () => number;
}

/** Identity of a new task: a readable slug in front, a machine stamp in the tail and in task.json. */
export function newTaskIdentity(slug?: string | null, now: Clock = new Date()): {
  id: string; slug: string | null; stamp: string;
} {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp = `t${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
    + `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return { id: slug ? `${slug}-${stamp}` : stamp, slug: slug || null, stamp };
}

// The id tail is the same stamp `newTaskIdentity` returned; for a task with no slug it is the whole id.
export function stampOfId(id: unknown): string | null {
  const m = String(id ?? '').match(/t\d{8}-\d{6}$/);
  return m ? m[0] : null;
}

// Track separator in a task title — the same mark that splits parts of readable names.
export const TASK_TITLE_SEP = ' · ';

// Own mailbox or someone else's — the only condition on the whole bus. Nothing to
// compare (no identity, no owner) — the mechanism stays silent entirely:
// backward compatibility outranks the guard. Worker and reviewer addresses are
// not gated: the address is declared in their mcp-config.
export const FOREIGN_MARK = 'FOREIGN MAILBOX';
export const FOREIGN_ROUTE = 'This correspondence is not yours — name your own task with the task argument. '
  + 'If it is yours and this is a new session (the previous daemon died) — claim the mailbox: mailbox {claim: true}.';

// Heading of a successful claim — the other half of the same conversation as
// `FOREIGN_MARK`, and it lives here too: the MCP server prints it, and the claim
// gate vocabulary lives in the store. Both headings are quoted in prose verbatim,
// so they are constants — the contract-quote gate checks the quote against them
// (keys `foreign-mark` and `mailbox-claimed-mark` in lint.js).
export const MAILBOX_CLAIMED_MARK = 'MAILBOX CLAIMED';

// The most common lawful case on this gate is "the task is mine, this is a new
// session, the previous daemon died". The path is the same for every command;
// only what they repeat after the claim differs.
export function claimRoute(repeat: string): string {
  return 'The task is yours, but this is a new session (the previous daemon died) — claim the mailbox first: '
    + `mailbox {claim: true}, then repeat ${repeat}.`;
}

// --- adapter fields on the participant record --------------------------------
//
// The v1 record's own fields are `id`, `role`, `harness`, `mode`, `sessionRef`,
// `capabilities`; everything else about the participant is written by the
// adapter and lives in `metadata`, which core does not look into. Looking in is
// still required in six places: the sidecar key is the ADDRESS, not the
// participant id; the warden report names the participant in human words; and
// stall diagnosis names their directory and session.
//
// **The door in is these accessors, and core has no other.** A scatter of
// `p.metadata.<field>` across core would be the same bridge under another name:
// a field named in four files is renamed in three. Here each field has one home
// and one line about whose it is. That does not constrain a record reader: the
// adapter reads its own fields however it likes — it wrote them.

/** Participant record as these accessors see it. Structural — so the v1 model is not pulled in. */
interface WithMetadata {
  metadata?: Record<string, unknown> | null;
}

function field(p: WithMetadata | null | undefined, name: string): string | null {
  const v = p?.metadata?.[name];
  return typeof v === 'string' && v ? v : null;
}

/**
 * Participant address — `orchestrator`, `worker:<slug>`, `reviewer:<slug>`. The
 * adapter writes it; health, stall marks, contact points, and end-of-turn marks
 * are keyed by it, and the notification a person reads carries it too. The
 * address is not assembled from the id: `addrDir` is injective, but a record
 * that has no field has no one to ask for its role.
 */
export function addressOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'address');
}

/**
 * Name of the field where the mechanism leaves its version when it lifts a
 * participant. The adapter writes the value, the store reads it, so the name
 * has one home: drifted halves would give a silent check instead of an honest
 * refusal.
 *
 * The field lives in `metadata`, not as an own field of the record: `metadata`
 * is opaque to the schema, and a record with the marker is readable by a
 * mechanism of ANY version. An own field would be "extra" to a reader older
 * than itself — exactly the breakage the marker exists to prevent.
 */
export const MECHANISM_VERSION_FIELD = 'mechanismVersion';

/**
 * Version of the mechanism that wrote the participant record. The journal
 * reader uses it to tell "a record newer than me" from corruption: unfamiliar
 * fields plus a newer version are a mix of versions after `sync`, not a broken
 * journal ([store v1](v1/store.ts)).
 */
export function mechanismVersionOf(p: WithMetadata | null | undefined): string | null {
  return field(p, MECHANISM_VERSION_FIELD);
}

/**
 * Name of the field a routed lift leaves its decision in. The adapter writes the
 * value and `promptobus status` reads it, so the name has one home — the same
 * rule, and the same reason, as `MECHANISM_VERSION_FIELD` above.
 */
export const ROUTING_FIELD = 'routing';

/**
 * Routing decision of a participant lifted with `--strategy`: the strategy, the
 * tuple, the score, the age of the availability snapshot the pick was made on,
 * the warnings, and whether the explicit constraints narrowed anything.
 *
 * An object rather than a string, which is why it does not go through `field`
 * above. Core does not look inside it — it is written by the adapter and read
 * back by the adapter — and it lives in `metadata` for the reason `metadata`
 * exists: the field is declared open, so a record carrying a decision is
 * readable by a mechanism of any version and the protocol version is not raised
 * for it (ADR-003).
 */
export function routingOf(p: WithMetadata | null | undefined): Record<string, unknown> | null {
  const v = p?.metadata?.[ROUTING_FIELD];
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** When the adapter lifted the participant session: the fresh-lift registration window. */
export function startedOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'started');
}

/** Participant working-copy directory — the path a person is given in a stall report. */
export function repoAbsOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'repoAbs');
}

/** Whether the participant was dismissed from watch, and when: the adapter sets the mark (`promptobus dismiss`). */
export function dismissedOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'dismissed');
}

/**
 * Short participant session id from the journal: the session is gone, the
 * directory lives. It is how the session is named at the harness (enter, log,
 * stop), and lift parses it from `--bg` output.
 */
export function sessionOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'session');
}

/**
 * Full participant session identifier — the one the session calls ITSELF in
 * its environment and arrives with when it writes (a review remark). Lift
 * writes it from the harness record next to the short one; records from the
 * previous release and lifts where the session list did not parse have no
 * field — then the check falls back to the prefix.
 */
export function sessionIdOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'sessionId');
}

function norm(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * Whether these are the same session identifier — a FALLBACK rule, for records
 * without a full id. The check there is prefix-based: the harness names one
 * session two ways — the full identifier is a uuid, and the short `id` that
 * lift parsed from `--bg` output is the first eight hex of the same uuid
 * (measured: `id: "e8c5be23"` against
 * `sessionId: "e8c5be23-dfef-4d20-bd96-e2a40a366b97"`).
 *
 * **That premise is not our contract, and a gate must not be built on it**
 * (review remark). If the spellings drifted on the next build, the check would
 * call every session foreign, in silence. So the primary rule became equality
 * of full ids (`foreignSessionOf` below), and the prefix stayed where there is
 * no full id to take: previous-release records and lifts where `agents --json`
 * did not parse and the id came from free-text output.
 *
 * Case is folded: harness hex is lower, but that rule is not ours. Empty on
 * both sides is not a match, it is unknown: the caller decides.
 */
export function sameSession(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Is a FOREIGN session writing for this participant address? Returns the id
 * from the record the address is bound to — or `null`: the writer is our own,
 * or there is nothing to compare.
 *
 * The rule is one for every door of the gate — the contact-point record, the
 * loop-guard marks, and the warden diagnosis — and it lives here, not as a
 * copy at each: drifted copies would give a mechanism that lets one door
 * through and not the other.
 *
 * Source order: the record's full id against the writer by EQUALITY, and only
 * when it is absent — the short prefix (`sameSession` above). Both sides must
 * be named: a record with no session id is unknown, not a stranger, and must
 * not be refused on that.
 */
export function foreignSessionOf(p: WithMetadata | null | undefined, session: string | null | undefined): string | null {
  const writer = norm(session);
  if (!writer) return null;
  const full = sessionIdOf(p);
  if (full) return norm(full) === writer ? null : full;
  const short = sessionOf(p);
  if (!short) return null;
  return sameSession(short, writer) ? null : short;
}

/** Readable participant name, the one their session is shown under at the harness. */
export function nameOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'name');
}

/** Session that owns the `orchestrator` mailbox. Ownership of the address, not the task. */
export function ownerOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'owner');
}

/** Mailbox ownership: whether it is closed for another session. */
export interface Ownership {
  gated: boolean;
  owner: string | null;
  session: string | null;
}

// Heading of the foreign-task conversation — one for the spawn, done, review,
// and status gates. The input type is structural: each of the package's two
// stores has its own journal, and all that is needed from here is id and title.
export function foreignTaskLine(meta: { id: string; title?: string }, own: Ownership): string {
  return `task ${meta.id} («${meta.title}») is bound to session ${own.owner}, this one is ${own.session}`;
}

// Line about broken records for a tool reply — its own function: three callers print it.
export function brokenNote(broken: string[]): string | null {
  return broken.length ? broken.join('\n') : null;
}
