import { ok, info, fail } from './util.js';
import { hostOf } from './host.js';
import {
  promptobusHome, addressesOf, claimRoute, dismissParticipant, foreignTaskLine, ORCHESTRATOR, ownership, readTask,
  resolveTaskId, sessionIdentity,
} from './store.js';

// Снятие сданного участника с наблюдения.
//
// Предмет свой, а не ветка `done` или `status`: закрытие задачи метёт за всем run'ом, а
// печать состояния только читает — снятие же меняет журнал одного участника и делается
// посреди run'а, на каждой приёмке куска.
//
// Что снятие делает и чего не делает:
//
// - **гасит будущие доклады надзирателя** об этом адресе — фильтр один, в
//   `blockedParticipants` ([status.js](status.js)), и через него идут все три канала:
//   postcard надзирателя и строка в ответах инструментов. Уже отправленные
//   postcard'ы не отзываются;
// - **не трогает mailbox.** Писать снятому адресу законно: адрес остаётся участником, и
//   сообщение дождётся либо `mailbox` живой сессии, либо поднятого заново участника. Отказ
//   на `result` был бы потерянным сообщением там, где механизм обещает доставку;
// - **не гасит сессию и не закрывает задачу** — обе команды остаются за человеком и
//   `promptobus done`.
export function dismiss(rootOrHost, { task, address } = {}) {
  const host = hostOf(rootOrHost);
  const home = promptobusHome(host.workspaceRoot(), host);
  const id = resolveTaskId(home, task);
  // Гейт владельца — тот же, что у `promptobus done`: снятие меняет журнал чужого run'а, а
  // доклады, которые оно гасит, идут владельцу mailbox'а. Молчание при неизвестной
  // идентичности и у задачи без владельца — общее для всего гейта.
  const own = ownership(home, id, ORCHESTRATOR, sessionIdentity());
  // Отказ печатает `fail()`, а не бросок: стек в отказе человеку — шум.
  if (own.gated) {
    fail(`${foreignTaskLine(readTask(home, id), own)}: участника снимает владелец mailbox'а задачи. `
      + 'Доклады о нём идут ему же, и чужой рукой снятие гасит их не у того, кто их получает. '
      + `${claimRoute('promptobus dismiss')}`);
  }
  const meta = readTask(home, id);
  const known = addressesOf(meta);
  const route = `${host.busCommand(['dismiss', '<адрес>', `--task ${id}`])}. Участники задачи: ${known.join(', ')}`;
  if (!address) fail(`назови адрес участника: ${route}`);
  // Оркестратор снимается только на словах: докладов о нём нет и быть не может — они ему же
  // и адресованы. Отметка означала бы сделанную работу там, где не изменилось ничего.
  if (address === ORCHESTRATOR) {
    fail(`${ORCHESTRATOR} с наблюдения не снимается: докладов о нём не бывает — они ему и адресованы. `
      + `Снимают worker'а или reviewer'а. ${route}`);
  }
  // Посторонний адрес отбивается ответом самой записи (`found`), а не предпроверкой по
  // списку: под локом ответ точнее — журнал успевает измениться между чтением и записью.
  const { found, was } = dismissParticipant(home, id, address);
  if (!found) fail(`в задаче ${id} нет участника «${address}» — снимать некого. ${route}`);
  if (was) {
    ok(`${address} уже снят с наблюдения ${was} — журнал не тронут`);
    return;
  }
  ok(`${address} снят с наблюдения в задаче ${id} — докладов о его сессии оркестратору больше не будет`);
  info('уже отправленные доклады этим не отзываются: снятие говорит только о будущих');
  info('mailbox остаётся: писать снятому адресу законно, а новое задание тому же адресу'
    + ' (promptobus spawn, promptobus review, переревью живой сессии) возвращает его под наблюдение само');
}
