// Addresses: the spelling, the transliteration and the refusals.
// [reference/04-protocol.md#addresses-the-spelling-the-transliteration-and-the-refusals](../docs/reference/04-protocol.md#addresses-the-spelling-the-transliteration-and-the-refusals)
import path from 'node:path';

// Protocol v1 message types. **The value lives here**: send validates the list and must compile and
// be tested without the CLI. There is never a second list — the literal-copy gate keeps one home.
export const MESSAGE_TYPES = Object.freeze([
  'task', 'status', 'question', 'answer', 'artifact', 'result', 'review',
]);

export const ORCHESTRATOR = 'orchestrator';

/** Harness of a record that neither the journal nor the adapter named. Deliberately neutral: harness
 * names live with the drivers, and this is the admission that the field was never declared. */
export const UNDECLARED_HARNESS = 'undeclared';

/** Role of a record whose address does not parse: a hand edit, a journal after a crash. */
export const UNDECLARED_ROLE = 'undeclared';

const ADDRESS_RE = /^(orchestrator|(?:worker|reviewer|approver):[a-z0-9][a-z0-9-]*)$/;
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// A gate refusal is addressed to a person, not to a crash dump: a stack would dress the most common
// lawful outcome as an internal error. The boundary is the COMMAND, not the function.
export class GateError extends Error {}

export function isAddress(addr: unknown): boolean {
  return typeof addr === 'string' && ADDRESS_RE.test(addr);
}

// Address to directory name: `:` is not legal on a Windows filesystem, and this is also the store v1
// participant id. The throw stays bare and READERS hold it — one broken line must not cost the rest.
export function addrDir(addr: unknown): string {
  if (!isAddress(addr)) throw new Error(`unknown address «${addr}» — orchestrator, worker:<slug>, reviewer:<slug> or approver:<slug>`);
  return (addr as string).replace(':', '-');
}

/** Address role as its own value. Store v1 keeps it as a field on the participant record and does
 * not derive it from the id: it is computed ONCE, when the participant is written. */
export function roleOf(addr: unknown): string {
  const address = addr as string;
  if (!isAddress(address)) throw new Error(`unknown address «${addr}» — orchestrator, worker:<slug>, reviewer:<slug> or approver:<slug>`);
  return address === ORCHESTRATOR ? ORCHESTRATOR : address.slice(0, address.indexOf(':'));
}

export function workerAddress(slug: string): string {
  return `worker:${slug}`;
}

export function reviewerAddress(slug: string): string {
  return `reviewer:${slug}`;
}
export function approverAddress(slug: string): string {
  return `approver:${slug}`;
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

// Participant files in `workers/`, keyed by address. Spawn, review and cleanup all glue this name;
// drifted copies would have cleanup sweep past them, so the name lives here.
export function participantFileStem(address: string): string {
  const [kind, slug] = String(address).split(':');
  // An address with no slug yields no file name, and that must not be silent: the glue used to
  // return `undefined` and write `undefined.mcp.json`. Bare, like its neighbours: a caller error.
  if (!slug) throw new Error(`address «${address}» does not yield a participant file name — it has no slug`);
  return kind === 'worker' ? slug : `${kind}-${slug}`;
}

// The slug goes into the task id, the worktree directory and the branch name — into a filesystem and
// a git-ref — so the output is only `[a-z0-9-]`, cut on a token boundary rather than mid-word.
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

// Own mailbox or someone else's — the only condition on the whole bus. With nothing to compare the
// mechanism stays silent: backward compatibility outranks the guard.
export const FOREIGN_MARK = 'FOREIGN MAILBOX';
export const MAILBOX_COPY = 'A copy is below; the originals stayed in the mailbox.';
export const FOREIGN_ROUTE = 'This correspondence is not yours — name your own task with the task argument. '
  + 'If it is yours and this is a new session (the previous daemon died) — claim the mailbox: mailbox {claim: true}.';

// Heading of a successful claim — the other half of the same conversation as `FOREIGN_MARK`. Both
// are quoted in prose verbatim, so they are constants the contract-quote gate checks against.
export const MAILBOX_CLAIMED_MARK = 'MAILBOX CLAIMED';

// The most common lawful case on this gate is "the task is mine, this is a new session, the previous
// daemon died". The path is the same for every command; only what they repeat after differs.
export function claimRoute(repeat: string): string {
  return 'The task is yours, but this is a new session (the previous daemon died) — claim the mailbox first: '
    + `mailbox {claim: true}, then repeat ${repeat}.`;
}

// --- adapter fields on the participant record: everything but the v1 record's own fields lives in
// `metadata`, and THESE ACCESSORS are core's only door in — a field named in four files is renamed in three.

/** Participant record as these accessors see it. Structural — so the v1 model is not pulled in. */
interface WithMetadata {
  metadata?: Record<string, unknown> | null;
}

function field(p: WithMetadata | null | undefined, name: string): string | null {
  const v = p?.metadata?.[name];
  return typeof v === 'string' && v ? v : null;
}

/** Participant address — `orchestrator`, `worker:<slug>`, `reviewer:<slug>`, `approver:<slug>`. It is
 * not assembled from the id: `addrDir` is injective, but a record with no field has no role to ask. */
export function addressOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'address');
}

/** Name of the field where the mechanism leaves its version. It lives in `metadata` because that is
 * opaque to the schema: an own field would be "extra" to an older reader — the very breakage it prevents. */
export const MECHANISM_VERSION_FIELD = 'mechanismVersion';

/** Version of the mechanism that wrote the participant record: the journal reader tells "newer than
 * me" from corruption by it — unfamiliar fields plus a newer version are a mix after `sync`. */
export function mechanismVersionOf(p: WithMetadata | null | undefined): string | null {
  return field(p, MECHANISM_VERSION_FIELD);
}

/** Name of the field a routed lift leaves its decision in. The adapter writes and `status` reads, so
 * the name has one home — the same rule and reason as `MECHANISM_VERSION_FIELD` above. */
export const ROUTING_FIELD = 'routing';

/** Routing decision of a participant lifted with `--strategy`. An object, so it does not go through
 * `field`; it lives in `metadata` so any version can read the record and no protocol bump is needed. */
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

/** Short participant session id from the journal: the session is gone, the directory lives. It is how
 * the session is named at the harness, and lift parses it from the launch output. */
export function sessionOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'session');
}

/** Full participant session identifier — the one the session calls ITSELF and arrives with when it
 * writes. Records with no field fall back to the prefix. */
export function sessionIdOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'sessionId');
}

function norm(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/** Whether these are the same session identifier — a FALLBACK for records with no full id.
 * [reference/04-protocol.md#samesession--whether-these-are-the-same-session-identifier--a-fallback-rule-for-records](../docs/reference/04-protocol.md#samesession--whether-these-are-the-same-session-identifier--a-fallback-rule-for-records) */
export function sameSession(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/** Is a FOREIGN session writing for this address? One rule for every door of the gate, so no copy can
 * drift. Full id by EQUALITY first, the short prefix only when absent; both sides must be named. */
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

/** How the owner gate answered: what it proved, not what it failed to find. */
export type OwnershipRight = 'owner' | 'ownerless' | 'no-identity' | 'foreign' | 'other-address';

/** Mailbox ownership. `allowed` is the right, proven positively; `gated` is the narrower "proved
 * foreign" the advisory lines read, and the two are not each other's negation. */
export interface Ownership {
  gated: boolean;
  allowed: boolean;
  right: OwnershipRight;
  owner: string | null;
  session: string | null;
}

// Heading of the foreign-task conversation — one for the spawn, done, review and status gates. The
// input type is structural: each of the package's two stores has its own journal.
export function foreignTaskLine(meta: { id: string; title?: string }, own: Ownership): string {
  return `task ${meta.id} («${meta.title}») is bound to session ${own.owner}, this one is ${own.session}`;
}

// Line about broken records for a tool reply — its own function: three callers print it.
export function brokenNote(broken: string[]): string | null {
  return broken.length ? broken.join('\n') : null;
}
