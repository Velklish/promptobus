// Общий приём набора: перехват консоли на время вызова. Не `*.test.mjs` — раннер
// (run.mjs) берёт из каталога только их, и этот файл в прогон не попадает.
//
// Приём был скопирован в пятнадцать файлов и разъехался. Копии отличались не
// только формой возврата, но и наличием страховки , а её несли ровно две из них:
// `process.exit()` из `fail()` внутри проверяемого кода уносит процесс мимо `finally` —
// консоль остаётся подменённой навсегда, и накопленный вывод не доезжает никуда. Файл
// умирает с пустым stdout ровно в том случае, ради которого перехват и заведён: человек
// видит упавший тест и ни строчки диагностики. Здесь страховка одна на всех потребителей.
//
// Перехватываются три метода `console`, а не дескрипторы: CLI пишет через них
// (`info`/`warn`/`fail` в util.js), а вердикты набора идут мимо консоли, прямо в
// дескриптор 1 ([check.mjs](check.mjs)) — поэтому перехват их не глотает.
import { writeSync } from 'node:fs';
import process from 'node:process';

// Страховка печатает из обработчика `exit`, и печатать ей приходится мимо `console`: на
// macOS `process.stderr.write` в трубу асинхронен, и вывод из этого обработчика теряется
// целиком — та же причина, по которой мимо консоли пишет [check.mjs](check.mjs). EAGAIN
// на переполненной неблокирующей трубе — не конец записи, а повод дописать остаток.
// Пауза между попытками записи — та же, что у [check.mjs](check.mjs), и по той же причине:
// без неё EAGAIN крутится горячим циклом, процесс жжёт ядро и мешает как раз тому, кто
// должен разобрать трубу. Здесь это дороже — страховка выливает разом весь накопленный
// вывод. Событийного цикла тут нет вовсе (обработчик `exit`), уступить такт нечем — спим
// по-настоящему.
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

function writeErr(text) {
  const buf = Buffer.from(`${text}\n`);
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(2, buf, off);
    } catch (e) {
      if (e.code !== 'EAGAIN') return;
      Atomics.wait(PAUSE, 0, 0, 2);
    }
  }
}

// Возврат следует за `fn`: синхронный вызов остаётся синхронным, асинхронный отдаёт
// обещание. Иначе перевод пятнадцати файлов на общий модуль означал бы расставить `await`
// в сотне с лишним мест, включая выражения внутри самих `check(...)`, — правка втрое
// больше починки и с тем же риском. Обе ветки кончаются одним и тем же возвратом консоли.
const isThenable = (v) => !!v && typeof v.then === 'function';
const after = (v, cb) => (isThenable(v) ? v.then(cb) : cb(v));

// Ядро. `onLog` — куда уходит `console.log`, `onErr` — `console.warn` и `console.error`
// (оба stderr: предупреждение — такая же диагностика, как отказ). `onErr === null` значит
// «эти два не трогать вовсе»: предупреждения бывают предметом проверки, и глушить их
// вместе с ходом работы незачем (`quietLog`).
function withConsole(fn, onLog, onErr) {
  const log = console.log, warn = console.warn, error = console.error;
  const seen = [];
  const restore = onErr
    ? () => { console.log = log; console.warn = warn; console.error = error; }
    : () => { console.log = log; };
  // Страховка : диагностика дороже чистоты вывода. Хук снимается вместе с
  // перехватом — иначе вывод давнего вызова допечатался бы на выходе процесса, когда бы
  // тот ни случился, уже как посторонняя строка.
  const bail = () => { restore(); if (seen.length) writeErr(seen.join('\n')); };
  const done = () => { restore(); process.off('exit', bail); };
  process.once('exit', bail);
  console.log = (m) => { seen.push(String(m)); onLog(String(m)); };
  if (onErr) {
    console.warn = (m) => { seen.push(String(m)); onErr(String(m)); };
    console.error = (m) => { seen.push(String(m)); onErr(String(m)); };
  }
  let value;
  try {
    value = fn();
  } catch (e) {
    done();
    throw e;
  }
  if (!isThenable(value)) { done(); return value; }
  return value.then((v) => { done(); return v; }, (e) => { done(); throw e; });
}

// `process.exit()` внутри проверяемого кода — это `fail()`. Тест обязан его пережить и
// проверить сам факт отказа, поэтому на время вызова выход бросает. Подмена возвращается
// ровно та, что застали: файлы набора подменяют `process.exit` бросателем на весь файл, и
// восстановленный «настоящий» выход снял бы эту подмену у всего, что ниже.
function withExit(fn) {
  const before = process.exit;
  process.exit = (code) => { const e = new Error(`EXIT:${code ?? ''}`); e.exitCode = code; throw e; };
  const back = () => { process.exit = before; };
  let value;
  try {
    value = fn();
  } catch {
    back();
    return { failed: true, value: undefined };
  }
  if (!isThenable(value)) { back(); return { failed: false, value }; }
  return value.then(
    (v) => { back(); return { failed: false, value: v }; },
    => { back(); return { failed: true, value: undefined }; },
  );
}

// Весь вывод одной строкой — самая частая форма: печать команды и есть предмет проверки.
export function capture(fn) {
  let out = '';
  const sink = (m) => { out += `${m}\n`; };
  return after(withConsole(fn, sink, sink), () => out);
}

// stdout отдельно от stderr. Нужно там, где предмет — само разделение: в подставляемое
// значение (`a2a path`) диагностике нельзя, и слить их значило бы не проверить вовсе.
export function captureSplit(fn) {
  let out = '', err = '';
  const ran = withConsole(fn, (m) => { out += `${m}\n`; }, (m) => { err += `${m}\n`; });
  return after(ran, (value) => ({ out, err, value }));
}

// Вывод не нужен вовсе — нужен возврат. Накопленное всё равно копится: страховка печатает
// его, если проверяемый код унёс процесс.
export function quiet(fn) {
  return withConsole(fn, () => {}, () => {});
}

// Как `quiet`, но `console.warn` и `console.error` остаются вызывающему: предупреждения
// бывают предметом проверки, и глушить их вместе с ходом работы незачем.
export function quietLog(fn) {
  return withConsole(fn, () => {}, null);
}

// Отказ проверяемого кода: `{ failed, out, value }`, где `out` — весь вывод вместе со
// stderr, потому что отказ печатается именно туда.
export function expectFail(fn) {
  let out = '';
  const sink = (m) => { out += `${m}\n`; };
  return after(withConsole(() => withExit(fn), sink, sink),
    (r) => ({ failed: r.failed, out, value: r.value }));
}

// Он же с разделёнными потоками — для команд, чей stdout идёт в подстановку.
export function expectFailSplit(fn) {
  let out = '', err = '';
  const ran = withConsole(() => withExit(fn), (m) => { out += `${m}\n`; }, (m) => { err += `${m}\n`; });
  return after(ran, (r) => ({ failed: r.failed, out, err, value: r.value }));
}

// Бросок без всякой консоли: отказы `planSpawn`/`planReview` приходят исключением, а не
// через `fail()`. Копий было две, обе слово в слово.
//
// Класс отдаётся `constructor.name`, а не `e.name`, и подменить одно другим нельзя: `class
// GateError extends Error {}` поля `name` себе не ставит, и `e.name` у него — «Error».
// Проверка на классе читала бы тогда одно и то же имя у любого броска и молчала бы всегда.
// Тем же выражением опознаёт ожидаемую ошибку верхний catch `bin/agents.js` — предмет
// проверки именно он, поэтому и здесь стоит оно.
export function expectThrow(fn) {
  try { fn(); return { threw: false, name: '', msg: '' }; } catch (e) { return { threw: true, name: e?.constructor?.name, msg: e.message }; }
}
