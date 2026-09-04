// Гейт амбиентного состояния package Promptobus. Запуск: npm test
//
// Предмет — граница «package получает контекст АРГУМЕНТАМИ, а не подстановкой».  снял
// из package швы `useHost` и `useRouting`, через которые adapter отдавал внутрь диагностику,
// идентичность сессии и routing policy; мутационная проба при приёмке дописала ту же форму
// под другим именем — `let ambientNote = null; export function useNote(fn) { ambientNote = fn; }`
// — и ни один гейт не покраснел. Объяснимо: гейт окружения
// ([promptobus-package.test.mjs](promptobus-package.test.mjs)) ищет `process.env` и потоки
// регексом, а амбиентная подстановка не требует ни того, ни другого — это чистый JS, и
// standalone-копии она не мешает. Граница держалась на дисциплине автора.
//
// **Дешёвый гейт здесь холостой.** «В `index.ts` нет экспорта на `use[A-Z]`» ловит одну снятую
// форму и промахивается мимо любой другой — внутреннего сеттера без экспорта, поля объекта,
// замыкания, — оставаясь зелёным и выглядя рабочим. Честный предикат регексом не выражается:
// у package есть законные копилки того же вида, и отличить их от моста умеет только разбор
// дерева. Отсюда `ast-grep` и явный список законных.
//
// **Предикат — два правила и соединение по имени.** `ast-grep` не соединяет два совпадения
// сам, поэтому объявления и записи снимаются порознь и сводятся здесь, ПОФАЙЛОВО: одноимённая
// локальная переменная соседнего модуля иначе слилась бы с копилкой этого.
//   • объявление — `let`/`const`/`var` на уровне модуля: не внутри тела функции и не в теле
//     класса;
//   • запись — присваивание имени, инкремент, присваивание его свойства (`x.y = …` и
//     вычисляемого `x[k] = …` наравне: реестр по имени — самая естественная форма моста) или
//     мутирующий вызов ИЗ ФУНКЦИИ. Инициализация на уровне модуля записью не считается:
//     копилку заводит сам модуль, мостом её делает запись извне.
//
// **Список законных копилок живёт здесь и с причиной у каждой.** Добавление в него — правка
// этого файла, то есть предмет ревью, а не молчаливое исключение. Причина одна и та же по
// форме: копилка держит СВОЁ состояние процесса — счётчик, кэш, реестр, — и значение в неё
// кладёт сам package. Мост держит ЧУЖОЕ: значение в него кладёт adapter снаружи.
//
// **Гейт живёт в интеграционном наборе.** Резолв `ast-grep` — PATH и известные префиксы
// ([sandbox.mjs](sandbox.mjs)); ядро не зависит от внешнего бинаря. Бинаря нет — красный
// вердикт с командой установки, а не пропуск: гейт, который молчит без инструмента, зелёный
// при любой реализации.
//
// Дерево репозитория файл только читает. Фикстуры мутационной пробы — своя песочница: ими же
// проверяется, что гейт не только ловит мост, но и НЕ красит законную копилку.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';
import { AST_GREP_INSTALL, findAstGrep, makeSandbox } from './sandbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.join(here, '..');

const DECL = 'module-binding';
const WRITE = 'fn-write';

// Правила `ast-grep`, оба на TypeScript. Совпадение отдаёт имя метапеременной `$NAME` — по
// нему объявления и записи и соединяются. Обратный слеш в регексе правила экранируется
// ДВАЖДЫ: строка шаблонная, и `\b` в ней — символ забоя, а не граница слова; ast-grep на
// таком правиле отказывает «Cannot parse rule INLINE_RULES», то есть краснеет разбором, а не
// молча, — но диагноз уводит в YAML, которого человек в файле не видит.
const RULES = `
id: ${DECL}
language: ts
rule:
  kind: variable_declarator
  has:
    field: name
    kind: identifier
    pattern: $NAME
  not:
    inside:
      any:
        - kind: statement_block
        - kind: class_body
      stopBy: end
---
id: ${WRITE}
language: ts
rule:
  any:
    - kind: assignment_expression
      has: { field: left, kind: identifier, pattern: $NAME }
    - kind: augmented_assignment_expression
      has: { field: left, kind: identifier, pattern: $NAME }
    - kind: update_expression
      has: { field: argument, kind: identifier, pattern: $NAME }
    - kind: assignment_expression
      has:
        field: left
        any:
          - kind: member_expression
          - kind: subscript_expression
        has: { field: object, kind: identifier, pattern: $NAME }
    - kind: augmented_assignment_expression
      has:
        field: left
        any:
          - kind: member_expression
          - kind: subscript_expression
        has: { field: object, kind: identifier, pattern: $NAME }
    - kind: call_expression
      has:
        field: function
        kind: member_expression
        all:
          - has: { field: object, kind: identifier, pattern: $NAME }
          - has:
              field: property
              regex: '^(set|add|delete|clear|push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)$'
  inside:
    any:
      - kind: function_declaration
      - kind: function_expression
      - kind: generator_function_declaration
      - kind: arrow_function
      - kind: method_definition
    stopBy: end
`;

// Законные копилки package: ключ и причина. Все до одной держат состояние СВОЕГО процесса и
// наполняются самим package — снаружи в них не кладёт никто. Перечень сверен по дереву, а не
// переписан из постановки: названный ею `migrated` — это `const MARK = 'migrated.json'`
// (migrate.ts), строка, а не копилка, и разбор её не находит.
const ALLOWED = [
  ['src/fs/atomic.ts::atomicSeq',
    'счётчик суффикса временного соседа атомарной записи: имена внутри процесса не должны совпасть'],
  ['src/fs/lock.ts::held',
    'учёт локов, взятых ЭТИМ процессом: без него вложенный вызов досиживал бы waitMs на самом себе'],
  ['src/legacy-store.ts::seq',
    'счётчик id записи legacy store: номер уезжает в имя файла и держит порядок отправки'],
  ['src/legacy-store.ts::tmpSeq',
    'счётчик временных имён legacy store, свой от seq: тот уезжает в имя записи'],
  ['src/legacy-store.ts::taskCache',
    'кэш журнала на один запрос: одна команда читает task.json по четыре-шесть раз; гасят его writeTask и withTaskLock'],
  ['src/sidecar.ts::suspenders',
    'реестр обёрток onTaskLock: store в package два, и второй регистратор не вправе отменить первого'],
  ['src/v1/artifacts.ts::tmpSeq',
    'счётчик временных имён blob-файлов v1'],
  ['src/v1/messages.ts::seq',
    'счётчик отправителя в id записи v1: сортировка строк равна порядку отправки'],
  ['src/v1/messages.ts::sentSeen',
    'инкрементальный разбор отправок: каждая запись читается один раз за жизнь процесса, канон неизменяем'],
];

// Разбор дерева: `<dir>/src` в имена «файл::имя» с местом объявления и местами записи.
// Каталог зовётся из `cwd`, а не абсолютным путём, — тогда `file` в ответе приходит вида
// `src/…` и у дерева package, и у фикстур, то есть ключ у обоих один по форме.
function ambientState(dir) {
  const r = spawnSync(AG, ['scan', '--inline-rules', RULES, '--json=compact', 'src'],
    { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let matches = null;
  try { matches = JSON.parse(r.stdout ?? ''); } catch { /* не разобралось — ниже */ }
  if (!Array.isArray(matches)) {
    return { failed: `ast-grep не отдал разбор (код ${r.status}): ${String(r.stderr ?? r.error?.message ?? '').slice(0, 300)}`, found: new Map() };
  }
  const decls = new Map();
  const writes = new Map();
  for (const m of matches) {
    const name = m?.metaVariables?.single?.NAME?.text;
    if (!name) continue;
    const bin = m.ruleId === DECL ? decls : writes;
    // Разделитель пути нормализуется: на win32 `ast-grep` отдаёт `src\\fs\\atomic.ts`, и
    // ключ разошёлся бы со списком, записанным через `/`, — оба вердикта краснели бы разом
    // на исправном дереве.
    const key = `${m.file.split(path.sep).join('/')}::${name}`;
    bin.set(key, [...(bin.get(key) ?? []), (m.range?.start?.line ?? 0) + 1]);
  }
  const found = new Map();
  for (const [key, at] of decls) {
    if (writes.has(key)) found.set(key, { at: at[0], writes: writes.get(key) });
  }
  return { failed: null, found };
}

const where = (found, keys) => keys.map((k) => `${k} (объявлено на ${found.get(k)?.at}, пишут на ${found.get(k)?.writes.join(', ')})`).join('; ');

const AG = findAstGrep();
check(': ast-grep на машине найден — без него гейт краснеет, а не молчит',
  AG, `бинаря нет ни в PATH, ни в известных местах установки — поставь: ${AST_GREP_INSTALL}`);

if (AG) {
  // ── дерево package ────────────────────────────────────────────────────────────────────
  const pkg = ambientState(PKG);
  check(': разбор исходников package прошёл — ast-grep ответил JSON', !pkg.failed, pkg.failed ?? '');

  const allowed = new Set(ALLOWED.map(([key]) => key));
  const unlisted = [...pkg.found.keys()].filter((key) => !allowed.has(key));
  check(': амбиентного состояния в исходниках package нет — только копилки списка',
    unlisted.length === 0,
    `не в списке законных: ${where(pkg.found, unlisted)}`);

  // Список без этой проверки протухает молча: снятая копилка оставляет в нём запись, а
  // ослепший разбор (сломанное правило, не тот каталог) делает гейт зелёным на пустом месте.
  // Она же — положительный контроль: девять записей обязаны найтись в дереве.
  const stale = [...allowed].filter((key) => !pkg.found.has(key));
  check(': список законных копилок не протух — каждая его запись нашлась в дереве',
    stale.length === 0, `в списке есть, в дереве нет: ${stale.join(', ')}`);

  // ── мутационная проба на фикстурах ────────────────────────────────────────────────────
  //
  // Три формы из постановки  разом и тем же разбором, каким судится дерево package.
  // Третья — проверка на ложное срабатывание: она и есть мишень второго хода пробы (наивная
  // редакция «любой module-level let — отказ» обязана покрасить именно её).
  const FIX = makeSandbox('promptobus-ambient-');
  mkdirSync(path.join(FIX, 'src'), { recursive: true });
  const fixture = (name, body) => writeFileSync(path.join(FIX, 'src', name), body);

  // Форма, оставшаяся зелёной при приёмке , — экспортируемый сеттер.
  fixture('bridge-exported.ts', `let ambientNote: unknown = null;
export function useNote(fn: unknown): void { ambientNote = fn; }
export function note(): unknown { return ambientNote; }
`);
  // Тот же мост без экспорта: сеттер внутренний, а подставляет в него значение соседний
  // экспортируемый вызов. Дешёвый гейт «нет экспорта на use[A-Z]» эту форму пропускает.
  fixture('bridge-quiet.ts', `let ambientHost: unknown = null;
function useHostQuietly(fn: unknown): void { ambientHost = fn; }
export function adopt(fn: unknown): void { useHostQuietly(fn); }
`);
  // Реестр подстановок — две формы, которых нет у двух фикстур выше и которые правило ловит
  // каждую своей веткой. `ambient[name] = fn` в дереве не `member_expression`, а
  // `subscript_expression`; `chain.unshift(fn)` — мутатор из хвоста перечня. Обе стоят в
  // одной фикстуре нарочно: сузь правило с любого конца, и вердикт краснеет.
  fixture('bridge-registry.ts', `const ambient: Record<string, unknown> = {};
export function use(name: string, fn: unknown): void { ambient[name] = fn; }
const chain: unknown[] = [];
export function prepend(fn: unknown): void { chain.unshift(fn); }
`);
  // Законная копилка — та же форма, что у `seq` в v1/messages.ts: счётчик процесса, который
  // наполняет сам модуль.
  fixture('counter.ts', `let seq = 0;
export function nextId(): string { seq = (seq + 1) % 10000; return String(seq); }
`);

  const fix = ambientState(FIX);
  const fixAllowed = new Set(['src/counter.ts::seq']);
  const fixUnlisted = [...fix.found.keys()].filter((key) => !fixAllowed.has(key));

  check(': проба — экспортируемый сеттер (форма useNote) гейт ловит',
    fixUnlisted.includes('src/bridge-exported.ts::ambientNote'),
    `отказы гейта на фикстурах: ${fixUnlisted.join(', ') || 'ни одного'}`);
  check(': проба — внутренний сеттер без экспорта гейт ловит наравне с экспортируемым',
    fixUnlisted.includes('src/bridge-quiet.ts::ambientHost'),
    `отказы гейта на фикстурах: ${fixUnlisted.join(', ') || 'ни одного'}`);
  check(': проба — реестр подстановок гейт ловит обеими формами: ambient[name] = fn и chain.unshift(fn)',
    fixUnlisted.includes('src/bridge-registry.ts::ambient')
      && fixUnlisted.includes('src/bridge-registry.ts::chain'),
    `отказы гейта на фикстурах: ${fixUnlisted.join(', ') || 'ни одного'}`);
  // Обе половины обязательны. Первая — разбор копилку ВИДИТ: без неё вердикт был бы зелёным
  // и у гейта, ослепшего вовсе. Вторая — зелёной её делает список, а не слепота.
  check(': проба — законная копилка из списка гейт не красит',
    fix.found.has('src/counter.ts::seq') && !fixUnlisted.includes('src/counter.ts::seq'),
    `разбор увидел копилку: ${fix.found.has('src/counter.ts::seq')} · отказы: ${fixUnlisted.join(', ') || 'ни одного'}`);
}
