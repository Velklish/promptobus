import { fail, info, ok } from './util.js';
import { hostOf } from './host.js';
import {
  addrDir, addressOf, history as historyPage, isAddress, listTasks, nameOfArtifact, promptobusHome, readTask,
  taskExists,
} from './store.js';

// Журнал прочитанной переписки: страница записей от старых к новым (ADR-032, §6). Читает
// только историю — непрочитанное лежит в mailbox'е, и туда команда не заглядывает вовсе.
// Отсюда и главное её свойство: `history` не делает прочитанным ничего.
//
// Единица — ЗАПИСЬ, а не сообщение: одно сообщение, лежащее у двоих, даёт две записи, и
// лимит считает именно записи. Граница страницы поэтому законно режет группу записей одного
// сообщения — курсор истории непрозрачен и несёт полный ключ порядка ([14](../../../docs/reference/14-promptobus-v1.md)).

// Умолчание лимита живёт в самом store (`history({ limit = 50 })`), а не здесь: цитируют
// прозой одно число, и второе объявление разъехалось бы с ним молча.
const BODY_MAX = 120;

// Выжимка тела — первая непустая строка, обрезанная по границе слова. Тело `result` бывает
// в тысячи знаков, а строка журнала обязана оставаться одной строкой.
function say(body) {
  const line = String(body ?? '').split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  if (line.length <= BODY_MAX) return line;
  const cut = line.slice(0, BODY_MAX);
  const space = cut.lastIndexOf(' ');
  return (space > BODY_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

// Обратный перевод id участника v1 в адрес шины. Прямой перевод (`worker:api` →
// `worker-api`) однозначен, обратный — нет: слаг сам бывает с дефисом. Поэтому карта
// строится по журналу задачи, а не разбором строки; записи в журнале нет — печатаем id как
// есть, потому что запись истории старше участника это законный случай.
function addressMap(home, task) {
  const map = new Map();
  let meta = null;
  try {
    meta = readTask(home, task);
  } catch {
    // Повреждённая задача не имеет права уносить историю остальных.
    return map;
  }
  for (const p of meta?.participants ?? []) {
    try {
      map.set(addrDir(addressOf(p)), addressOf(p));
    } catch {
      // Негодный адрес в журнале прежнего CLI: пропускаем запись, а не всю задачу.
    }
  }
  return map;
}

export function history(rootOrHost, { task, participant, limit, all } = {}) {
  const host = hostOf(rootOrHost);
  const cmd = host.commandName;
  if (all && limit !== undefined) {
    fail(`${cmd} history: --all и --limit вместе не принимаются — --all снимает лимит целиком`);
  }
  let take;
  if (limit !== undefined) {
    take = Number(limit);
    if (!Number.isInteger(take) || take <= 0) {
      fail(`${cmd} history: --limit «${limit}» — ожидается целое число больше нуля`);
    }
  }
  const home = promptobusHome(host.workspaceRoot(), host);
  if (task && !taskExists(home, task)) {
    const known = listTasks(home).map((t) => t.id);
    fail(`${cmd} history: задачи «${task}» в журнале нет`
      + `${known.length ? `. Известные: ${known.join(', ')}` : ''}`);
  }
  let box;
  if (participant !== undefined) {
    if (!isAddress(participant)) {
      fail(`${cmd} history: --participant «${participant}» — ожидается orchestrator, `
        + 'worker:<slug> или reviewer:<slug>');
    }
    box = addrDir(participant);
  }
  const page = historyPage(home, {
    ...(task ? { task } : {}),
    ...(box ? { participant: box } : {}),
    ...(take !== undefined ? { limit: take } : {}),
    ...(all ? { all: true } : {}),
  });
  if (page.broken.length) {
    info(`нечитаемых записей пропущено: ${page.broken.length}`);
  }
  if (!page.entries.length) {
    ok('в истории пусто — прочитанной переписки под эти условия нет');
    return;
  }
  const names = new Map();
  ok(`записей ${page.entries.length}${page.cursor ? ' (старше есть — сними лимит --all)' : ''}`);
  for (const e of page.entries) {
    if (!names.has(e.task)) names.set(e.task, addressMap(home, e.task));
    const addr = names.get(e.task);
    const from = addr.get(e.message.sender) ?? e.message.sender;
    const to = addr.get(e.participant) ?? e.participant;
    const said = say(e.message.body);
    // Артефакт называется ИМЕНЕМ ФАЙЛА, как во всех остальных поверхностях: сообщение
    // несёт id metadata-записи, и по нему человек файл в папке задачи не найдёт. Имя
    // читает общий с ответами инструментов хелпер; не прочиталось — хвоста нет вовсе.
    const named = e.message.artifact ? nameOfArtifact(home, e.task, e.message.artifact) : undefined;
    info(`${e.message.ts} · ${e.task} · ${e.message.type} ${from} → ${to}`
      + `${named ? ` · артефакт ${named}` : ''}`
      + `${said ? ` — ${said}` : ''}`);
  }
}
