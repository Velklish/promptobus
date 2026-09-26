// Rendering a reply for a participant.
// [reference/01-overview.md#rendering-a-reply-for-a-participant](../../docs/reference/01-overview.md#rendering-a-reply-for-a-participant)
import path from 'node:path';
import {
  addressOf, dismissedOf, FOREIGN_MARK, FOREIGN_ROUTE, MAILBOX_COPY, nameOf, ORCHESTRATOR, ownerOf,
} from '../protocol.js';
import type { Ownership } from '../protocol.js';
import { pipelineText } from '../pipeline.js';
import { SHIPPED_REGISTRY, withoutStep } from '../registry.js';
import type { DeclaredStep } from '../registry.js';
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

// Readable participant name: the record's `name`; no name — the address without its step prefix, a
// governance address whole. `orchestrator` is called by the word; `of` is kept so callers do not change.
export function readableName(meta: TaskV1 | null | undefined, addr: string, of = false): string {
  if (addr === ORCHESTRATOR) return of ? 'the orchestrator' : 'orchestrator';
  const rec = (meta?.participants ?? []).find((p) => addressOf(p) === addr);
  const name = String(nameOf(rec) ?? '').replace(NAME_STAMP, '').trim();
  // Keyed on the shipped step names, not on step kinds: 04-protocol § The role registry.
  return name || withoutStep(SHIPPED_REGISTRY, String(addr ?? ''));
}

/** Sender address, translated from the journal only: `addrDir` is injective over admitted addresses alone,
 * and a record already gone from the journal has no role to ask, so the id itself is printed. */
export function senderAddress(meta: TaskV1 | null | undefined, m: MessageV1): string {
  const rec = (meta?.participants ?? []).find((p) => p.id === m.sender);
  return addressOf(rec) ?? String(m.sender ?? '');
}

const FIRST_LINE_MAX = 120;

/** Last line of a header list: bodies are asked one at a time, by the id the header names. */
const BODY_ROUTE = 'a body: the promptobus_mailbox tool with message set to its id';

// First non-empty line of a body, cut at a word boundary: a status is often one long paragraph.
function firstLine(body: string): string {
  const line = String(body ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  if (line.length <= FIRST_LINE_MAX) return line;
  const cut = line.slice(0, FIRST_LINE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > FIRST_LINE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

// Sender name first, machine address after: the feed hook lifts the name.
function heading(meta: TaskV1, m: MessageV1): string {
  const from = senderAddress(meta, m);
  return `### ${m.type}${MESSAGE_FROM}${readableName(meta, from, true)}${ADDR_MARK}${from} · ${m.ts}`;
}

// A person finds an artifact by FILE NAME in the task folder: the message carries a
// metadata-record id, and printing that would name a path that is not on disk.
function artifactLine(service: PromptobusService, home: string, task: string, m: MessageV1): string[] {
  const named = m.artifact ? service.artifactName(home, task, m.artifact) : undefined;
  return named ? [`artifact: ${path.join(service.artifactsDir(home, task), named)}`] : [];
}

/** Header list of a mailbox read: sender, type, time, id, size and first line — never a body. */
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
    const first = firstLine(m.body);
    out.push('', heading(meta, m), `message ${m.id} · ${m.body.length} characters${first ? `: ${first}` : ''}`,
      ...artifactLine(service, home, task, m));
  }
  out.push('', BODY_ROUTE);
  return out.join('\n');
}

/** One message in full, as `promptobus_mailbox` returns it by id. */
export function renderMessage(
  service: PromptobusService,
  home: string,
  task: string,
  addr: string,
  m: MessageV1,
  session: string | null = null,
): string {
  const meta = service.readTask(home, task);
  return [
    `message ${m.id} · ${service.identityLabel(home, task, addr, session)}`,
    '',
    heading(meta, m),
    m.body,
    ...artifactLine(service, home, task, m),
  ].join('\n');
}

// A foreign session gets a copy and a path: name your own task, or claim the mailbox with claim.
export function foreignNote(task: string, { owner, session }: Ownership): string {
  return `${FOREIGN_MARK}: the orchestrator address of task ${task} is bound to session ${owner}, this one is ${session}. `
    + `${MAILBOX_COPY}\n`
    + FOREIGN_ROUTE;
}

export function renderTask(
  service: PromptobusService,
  home: string,
  id: string,
  addr: string,
  session: string | null,
  decorate: DecorateParticipant,
  steps: readonly DeclaredStep[],
): string {
  const meta = service.readTask(home, id);
  const children = service.listTasks(home).filter((child) => child.parent === id);
  // Own mailbox — in the heading, before the participant list: the list
  // answers "who has what piling up", and here the addressee is the session
  // that is sure right now that it is waiting.
  const mine = service.unreadNote(home, id, addr, session);
  const lines = [
    `task ${meta.id} · ${meta.title}`,
    `status: ${meta.status} · created: ${meta.created}`,
    `parent: ${meta.parent ?? 'none'}`,
    `children: ${children.length ? children.map((child) => `${child.id} (${child.status})`).join(', ') : 'none'}`,
    `pipeline: ${pipelineText(steps)}`,
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
