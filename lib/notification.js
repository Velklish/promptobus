import { KNOCK_TEXT_MAX } from './contract.js';

// Выжимки сообщений для notification'а — арифметика, одна на все harness'ы (,
// замечание ревью). Рамка и слова принадлежат каналу harness'а и живут у его driver'а;
// сюда вынесено то, что у них совпадало знак в знак: форма строки выжимки, разделитель,
// бюджет знаков и три исхода — текст целиком, счётчик длины, хвост «и ещё N».
//
// Модуль листовой, как [stalls.js](stalls.js), и по той же причине: блок собирают driver'ы
// с одной стороны границы, а бюджет объявлен контрактом шины с другой. Живи он у одного из
// driver'ов, второй импортировал бы соседа — ровно то, что запрещает гейт границы.
//
// Гейт литеральных копий арифметику не видит: он ищет перечни строк, а не одинаковые
// вычисления. Держится общий дом на этом комментарии и на ревью — как и у комментария в
// коде вообще.

/** Разделитель выжимок. Своим именем: он входит в бюджет наравне со строками. */
export const PREVIEW_SEP = '\n\n';

/** Хвост «и ещё N»: не поместившееся уходит счётчиком, а не теряется молча. */
export function restLine(n) {
  return `— и ещё ${n}: забери mailbox`;
}

/**
 * Одно сообщение выжимкой. Три исхода: артефакт едет счётчиком всегда (без `mailbox` до
 * файла не дойти), короткое — текстом целиком, длинное называет свой размер. Обрезки нет
 * намеренно: половина сообщения хуже его отсутствия.
 */
function previewLine(m) {
  const head = `— ${m.type} от ${m.from} · ${m.ts}`;
  const body = typeof m.body === 'string' ? m.body : '';
  if (m.artifact) return `${head}: артефакт ${m.artifact} — забери mailbox`;
  return { head, body, counter: `${head}: текст ${body.length} знаков — забери mailbox` };
}

/**
 * Блок выжимок целиком — то, что стоит между шапкой notification'а и его хвостом. Бюджет
 * держит ВЕСЬ блок, а не сумму тел: у каждой строки есть заголовок, и пакет из пяти
 * коротких иначе давал бы notification впятеро больше самого длинного.
 *
 * Пустой блок — пустая строка: шапка и хвост тогда стыкуются сами.
 */
export function previewBlock(msgs = [], budget = KNOCK_TEXT_MAX) {
  const cost = (line) => line.length + PREVIEW_SEP.length;
  let left = budget - cost(restLine(msgs.length));
  const lines = [];
  let rest = 0;
  for (const m of msgs) {
    const p = previewLine(m);
    const full = typeof p === 'string' ? p : `${p.head}:\n${p.body}`;
    const line = typeof p === 'string' || cost(full) <= left ? full : p.counter;
    if (cost(line) > left) {
      rest += 1;
      continue;
    }
    lines.push(line);
    left -= cost(line);
  }
  if (rest) lines.push(restLine(rest));
  return lines.length ? `${lines.join(PREVIEW_SEP)}${PREVIEW_SEP}` : '';
}
