// Texts of bus-tool replies. The place is here, not at the consumer: these are
// texts ABOUT CORRESPONDENCE — senders, types, participants, counts — and only
// whoever knows the store can assemble them. Everything that knows about the
// workspace arrives here through one `decorate` hook: participant lines about
// the repository, worktree, and background session are assembled by the
// adapter and handed over ready.
import path from 'node:path';
import {
  addressOf, dismissedOf, FOREIGN_MARK, FOREIGN_ROUTE, nameOf, ORCHESTRATOR, ownerOf,
} from '../protocol.js';
import type { Ownership } from '../protocol.js';
import type { MessageV1, ParticipantV1, TaskV1 } from '../v1/model.js';
import type { PromptobusService } from './service.js';

/** Participant lines only the adapter knows: repository, worktree, background session. */
export type DecorateParticipant = (participant: ParticipantV1) => string[];

// Limits of the first line: it is read in the preview of a collapsed tool
// block, where it is truncated, and the tail (`PROMPTOBUS_HOME`, address,
// task) must stay whole — that is how a session learns it attached to a
// foreign task. Hence the cap on the sender list.
const SUMMARY_GROUPS = 3;
const SUMMARY_MAX = 120;

// Machine-address mark in bus replies. The consumer feed hook uses it to
// separate the readable name from the machine tail, and searches FROM THE END
// of the line: the same ` · ` mark is lawful in a name. The bus-hook template
// copies these four literals; `test/host.test.mjs` holds them together.
export const ADDR_MARK = ' · address ';
/** First word of an empty-mailbox reply. The hook compares it whole, not as a prefix. */
export const MAILBOX_EMPTY = 'empty';
/** Prefix of a successful `promptobus_send` reply. The hook matches it at the start of the line. */
export const SENT_PREFIX = 'sent ';
/** Word between message type and sender in a mailbox heading (`### status from name`). */
export const MESSAGE_FROM = ' from ';

// Who sent and what — instead of a bare number: "messages: 3" does not say
// whether the block is worth expanding. `+ N more` counts MESSAGES, not
// groups; one group is always shown.
export function summarizeMessages(msgs: MessageV1[], from: (m: MessageV1) => string = (m) => m.sender): string {
  const groups = new Map<string, number>();
  for (const m of msgs) {
    const key = `${m.type}${MESSAGE_FROM}${from(m)}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const ordered = [...groups.entries()]
    .map(([key, n], i) => ({ key, n, i }))
    .sort((a, b) => (b.n - a.n) || (a.i - b.i))
    .map((g) => ({ text: g.n > 1 ? `${g.key} ×${g.n}` : g.key, n: g.n }));

  const shown: { text: string; n: number }[] = [];
  let len = 0;
  for (const g of ordered) {
    if (shown.length >= SUMMARY_GROUPS) break;
    const next = len + g.text.length + (shown.length ? 2 : 0);
    if (shown.length && next > SUMMARY_MAX) break;
    shown.push(g);
    len = next;
  }
  const rest = msgs.length - shown.reduce((a, g) => a + g.n, 0);
  return `messages ${msgs.length}: ${shown.map((g) => g.text).join(', ')}${rest ? ` + ${rest} more` : ''}`;
}

// Trailing parenthetical mark of a readable name: `(MMDD-HHMM)` or
// `(MMDD-HHMM, slug)` (the consumer's `sessionName`). The form is checked
// whole: a title with parentheses will survive.
const NAME_STAMP = /\s*\(\d{4}-\d{4}(?:,[^()]*)?\)$/;

// Readable participant name — the journal record's `name` field, the one the
// session is shown under in the harness session list. No name — the address
// without the role prefix. `orchestrator` has no name at all: we call it by
// the word; the `of` flag used to pick a genitive in Russian and is kept so
// callers do not change.
export function readableName(meta: TaskV1 | null | undefined, addr: string, of = false): string {
  if (addr === ORCHESTRATOR) return of ? 'the orchestrator' : 'orchestrator';
  const rec = (meta?.participants ?? []).find((p) => addressOf(p) === addr);
  const name = String(nameOf(rec) ?? '').replace(NAME_STAMP, '').trim();
  return name || String(addr ?? '').replace(/^(?:worker|reviewer):/, '');
}

/**
 * Message sender address. The canon carries the participant record ID; a
 * person reads the address — the translation is taken from the task journal
 * and only from there: `addrDir` is injective, but a record that is already
 * gone from the journal has no one to ask for its role, and then the id
 * itself is printed.
 */
export function senderAddress(meta: TaskV1 | null | undefined, m: MessageV1): string {
  const rec = (meta?.participants ?? []).find((p) => p.id === m.sender);
  return addressOf(rec) ?? String(m.sender ?? '');
}

export function renderMessages(
  service: PromptobusService,
  home: string,
  task: string,
  addr: string,
  msgs: MessageV1[],
  session: string | null = null,
): string {
  const identity = service.identityLabel(home, task, addr, session);
  if (!msgs.length) return `${MAILBOX_EMPTY} · ${identity}`;
  const meta = service.readTask(home, task);
  const out = [`${summarizeMessages(msgs, (m) => senderAddress(meta, m))} · ${identity}`];
  for (const m of msgs) {
    const from = senderAddress(meta, m);
    // Sender name first, machine address after: the feed hook lifts the name.
    out.push('', `### ${m.type}${MESSAGE_FROM}${readableName(meta, from, true)}${ADDR_MARK}${from} · ${m.ts}`, m.body);
    // A person finds an artifact by FILE NAME in the task folder: the message
    // carries a metadata-record id, and printing that would name a path that
    // is not on disk.
    const named = m.artifact ? service.artifactName(home, task, m.artifact) : undefined;
    if (named) out.push(`artifact: ${path.join(service.artifactsDir(home, task), named)}`);
  }
  return out.join('\n');
}

// A foreign session gets a copy and a path: name your own task, or claim the mailbox with claim.
export function foreignNote(task: string, { owner, session }: Ownership): string {
  return `${FOREIGN_MARK}: the orchestrator address of task ${task} is bound to session ${owner}, this one is ${session}. `
    + `A copy is below; the originals stayed in the owner's mailbox.\n`
    + FOREIGN_ROUTE;
}

export function renderTask(
  service: PromptobusService,
  home: string,
  id: string,
  addr: string,
  session: string | null,
  decorate: DecorateParticipant,
): string {
  const meta = service.readTask(home, id);
  // Own mailbox — in the heading, before the participant list: the list
  // answers "who has what piling up", and here the addressee is the session
  // that is sure right now that it is waiting.
  const mine = service.unreadNote(home, id, addr, session);
  const lines = [
    `task ${meta.id} · ${meta.title}`,
    `status: ${meta.status} · created: ${meta.created}`,
    `artifacts: ${service.artifactsDir(home, id)}`,
    ...(mine ? [mine] : []),
    'participants:',
  ];
  for (const p of meta.participants ?? []) {
    // A bad participant record is a finding in the reply, not the death of
    // the tool: a broken address would crash `countInbox` and take the whole
    // `task` down for one line.
    try {
      lines.push(participantLine(service, home, id, p, decorate));
    } catch (e) {
      lines.push(`- INVALID PARTICIPANT RECORD (${(e as Error).message}): ${JSON.stringify(p)}`);
    }
  }
  return lines.join('\n');
}

function participantLine(
  service: PromptobusService,
  home: string,
  id: string,
  p: ParticipantV1,
  decorate: DecorateParticipant,
): string {
  const addr = addressOf(p);
  const parts = [`- ${addr}`];
  const owner = ownerOf(p);
  if (owner) parts.push(`owner ${owner}`);
  // Repository, worktree, and background session are adapter facts: git names
  // the branch, the harness names the session. Their place in the line is the
  // same as before, between owner and dismissal.
  parts.push(...decorate(p));
  // Dismissal from watch — the same list as in `promptobus status`.
  const dismissed = dismissedOf(p);
  if (dismissed) parts.push(`DISMISSED FROM WATCH ${dismissed}`);
  parts.push(`unread ${service.countInbox(home, id, addr as string)}`);
  return parts.join(' · ');
}
