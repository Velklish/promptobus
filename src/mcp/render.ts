// Тексты ответов инструментов шины. Место здесь, а не у потребителя: это тексты О ПЕРЕПИСКЕ
// — отправители, типы, участники, счётчики, — и складывать их умеет только тот, кто знает
// store. Всё, что знает про рабочее место, приходит сюда одним хуком `decorate`: строки
// участника про репозиторий, worktree и фоновую сессию собирает adapter и отдаёт готовыми
//.
import path from 'node:path';
import {
  addressOf, dismissedOf, FOREIGN_MARK, FOREIGN_ROUTE, nameOf, ORCHESTRATOR, ownerOf,
} from '../protocol.js';
import type { Ownership } from '../protocol.js';
import type { MessageV1, ParticipantV1, TaskV1 } from '../v1/model.js';
import type { PromptobusService } from './service.js';

/** Строки участника, которые знает только adapter: репозиторий, worktree, фоновая сессия. */
export type DecorateParticipant = (participant: ParticipantV1) => string[];

// Пределы первой строки: её читают в превью свёрнутого tool-блока, где она обрезается, а
// хвост (`PROMPTOBUS_HOME`, адрес, задача) нужен целым — по нему сессия узнаёт, что подцепилась
// к чужой задаче. Отсюда потолок у перечня отправителей.
const SUMMARY_GROUPS = 3;
const SUMMARY_MAX = 120;

// Кто прислал и что — вместо голого числа: по «сообщений: 3» не понять, стоит ли
// раскрывать блок. `+ ещё N` считает СООБЩЕНИЯ, а не группы; одна группа — всегда.
export function summarizeMessages(msgs: MessageV1[], from: (m: MessageV1) => string = (m) => m.sender): string {
  const groups = new Map<string, number>();
  for (const m of msgs) {
    const key = `${m.type} от ${from(m)}`;
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
  return `сообщений ${msgs.length}: ${shown.map((g) => g.text).join(', ')}${rest ? ` + ещё ${rest}` : ''}`;
}

// Метка машинного адреса в ответах шины. По ней хук ленты потребителя отделяет
// читаемое имя от машинного хвоста, и ищет С КОНЦА строки: в имени законен тот же знак ` · `.
export const ADDR_MARK = ' · адрес ';

// Хвостовая скобочная метка читаемого имени: `(ММДД-ЧЧММ)` или `(ММДД-ЧЧММ, слаг)`
// (`sessionName` у потребителя). Форма проверяется целиком: заголовок со скобкой уцелеет.
const NAME_STAMP = /\s*\(\d{4}-\d{4}(?:,[^()]*)?\)$/;

// Читаемое имя участника — поле `name` записи журнала, под которым сессия видна в
// `claude agents`. Имени нет — адрес без префикса роли. `orchestrator` имени не имеет
// вовсе: зовём словом, в позиции «от кого» — родительным падежом.
export function readableName(meta: TaskV1 | null | undefined, addr: string, of = false): string {
  if (addr === ORCHESTRATOR) return of ? 'оркестратора' : 'оркестратор';
  const rec = (meta?.participants ?? []).find((p) => addressOf(p) === addr);
  const name = String(nameOf(rec) ?? '').replace(NAME_STAMP, '').trim();
  return name || String(addr ?? '').replace(/^(?:worker|reviewer):/, '');
}

/**
 * Адрес отправителя сообщения. Канон несёт ID записи участника, а человек читает адрес —
 * перевод берётся из журнала задачи и только оттуда: `addrDir` инъективен, но роль записи,
 * которой в журнале уже нет, спросить не у кого, и тогда печатается сам id.
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
  if (!msgs.length) return `пусто · ${identity}`;
  const meta = service.readTask(home, task);
  const out = [`${summarizeMessages(msgs, (m) => senderAddress(meta, m))} · ${identity}`];
  for (const m of msgs) {
    const from = senderAddress(meta, m);
    // Имя отправителя первым, машинный адрес следом: имя поднимает в ленту хук.
    out.push('', `### ${m.type} от ${readableName(meta, from, true)}${ADDR_MARK}${from} · ${m.ts}`, m.body);
    // Артефакт человек находит ИМЕНЕМ ФАЙЛА в папке задачи: сообщение несёт id
    // metadata-записи, и печатать его значило бы называть путь, которого на диске нет.
    const named = m.artifact ? service.artifactName(home, task, m.artifact) : undefined;
    if (named) out.push(`артефакт: ${path.join(service.artifactsDir(home, task), named)}`);
  }
  return out.join('\n');
}

// Чужому идёт копия и маршрут: назови свою задачу или забери mailbox аргументом claim.
export function foreignNote(task: string, { owner, session }: Ownership): string {
  return `${FOREIGN_MARK}: адрес orchestrator задачи ${task} закреплён за сессией ${owner}, эта — ${session}. `
    + `Ниже копия, оригиналы остались в mailbox'е владельца.\n`
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
  // Свой mailbox — в шапке, до перечня участников: перечень отвечает «у кого что копится»,
  // а здесь адресат — сессия, которая прямо сейчас уверена, что ждёт.
  const mine = service.unreadNote(home, id, addr, session);
  const lines = [
    `задача ${meta.id} · ${meta.title}`,
    `статус: ${meta.status} · создана: ${meta.created}`,
    `артефакты: ${service.artifactsDir(home, id)}`,
    ...(mine ? [mine] : []),
    'участники:',
  ];
  for (const p of meta.participants ?? []) {
    // Негодная запись участника — находка в ответе, а не смерть инструмента: на
    // испорченном адресе падал бы `countInbox`, унося весь `task` из-за одной строки.
    try {
      lines.push(participantLine(service, home, id, p, decorate));
    } catch (e) {
      lines.push(`- НЕГОДНАЯ ЗАПИСЬ УЧАСТНИКА (${(e as Error).message}): ${JSON.stringify(p)}`);
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
  if (owner) parts.push(`владелец ${owner}`);
  // Репозиторий, worktree и фоновая сессия — сведения adapter'а: ветку называет git, а
  // имя сессии — harness. Место их в строке прежнее, между владельцем и снятием.
  parts.push(...decorate(p));
  // Снятие с наблюдения — тем же перечнем, что в `promptobus status`.
  const dismissed = dismissedOf(p);
  if (dismissed) parts.push(`СНЯТ С НАБЛЮДЕНИЯ ${dismissed}`);
  parts.push(`непрочитано ${service.countInbox(home, id, addr as string)}`);
  return parts.join(' · ');
}
