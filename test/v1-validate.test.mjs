// Runtime validation protocol v1: parity собственных валидаторов и JSON Schemas.
//
// Валидаторов у механизма два, и это не дубль ради надёжности, а цена решения §6:
// в production работают собственные TypeScript-валидаторы БЕЗ runtime-зависимости, а схемы
// лежат в `schemas/v1` и в production не читаются вовсе. Разъедься они — валидатор
// перестал бы проверять то, что объявлено схемой, и узнал бы об этом первым потребитель
// схемы, а не автор правки. Поэтому оба гоняются по ОДНОМУ набору fixtures: valid обязаны
// принять оба, invalid — отвергнуть оба.
//
// Эталонный validator — `ajv`, devDependency package
// точным пином. В tarball он не едет, и runtime-зависимостей у package по-прежнему ноль —
// это отдельный гейт набора package.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

import { ERROR_CODES, MESSAGE_TYPES, validate } from '../dist/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMAS = path.join(here, '..', 'schemas', 'v1');
const FIXTURES = path.join(here, 'fixtures', 'v1');

const MODELS = ['task', 'participant', 'message', 'artifact'];

const schemaOf = (model) => JSON.parse(readFileSync(path.join(SCHEMAS, `${model}.schema.json`), 'utf8'));

// `strict: false`: собственный словарь схем (`$defs/timestamp`, `not` рядом с `enum`)
// ajv в строгом режиме считает подозрительным, а предмет проверки — вердикт, а не вкус
// эталона. `allErrors` даёт диагноз целиком: красная parity читается по причине отказа.
const ajv = new Ajv2020({ strict: false, allErrors: true });
for (const model of MODELS) ajv.addSchema(schemaOf(model));
const reference = Object.fromEntries(MODELS.map((m) => [m, ajv.getSchema(`urn:promptobus:v1:${m}`)]));

// Fixture'ы читаются с диска, а не собираются в файле: тот же набор гоняют оба валидатора,
// и собранный в памяти он был бы набором ЭТОГО теста, а не общим.
function fixtures(verdict, model) {
  const dir = path.join(FIXTURES, verdict, model);
  return readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
    .map((name) => ({ name, value: JSON.parse(readFileSync(path.join(dir, name), 'utf8')) }));
}

test('parity: valid fixtures принимают оба валидатора', () => {
  for (const model of MODELS) {
    const set = fixtures('valid', model);
    assert.ok(set.length, `у модели ${model} нет ни одной valid fixture`);
    for (const { name, value } of set) {
      const mine = validate(model, value);
      const theirs = reference[model](value);
      assert.equal(mine.ok, true, `${model}/${name}: свой валидатор отверг — ${mine.code} ${mine.at} ${mine.note}`);
      assert.equal(theirs, true, `${model}/${name}: ajv отверг — ${ajv.errorsText(reference[model].errors)}`);
    }
  }
});

test('parity: invalid fixtures отвергают оба валидатора', () => {
  for (const model of MODELS) {
    const set = fixtures('invalid', model);
    assert.ok(set.length, `у модели ${model} нет ни одной invalid fixture`);
    for (const { name, value } of set) {
      const mine = validate(model, value);
      const theirs = reference[model](value);
      assert.equal(mine.ok, false, `${model}/${name}: свой валидатор пропустил`);
      assert.equal(theirs, false, `${model}/${name}: ajv пропустил`);
      // Код у отказа обязателен: человеческий текст — дело adapter'а, а разбирать отказ
      // потребитель обязан по коду.
      assert.ok(ERROR_CODES.includes(mine.code), `${model}/${name}: код «${mine.code}» не из перечня`);
    }
  }
});

test('parity: более новая версия схемы — отдельный код, а не общая невалидность', () => {
  // Отличать это от порчи обязан именно код: запись из будущего блокируется без изменения
  // store, а испорченная уезжает в `broken`. Один код на оба случая стёр бы границу.
  for (const [model, name] of [['task', 'version-newer.json'], ['message', 'version-newer.json'],
    ['artifact', 'version-newer.json']]) {
    const value = JSON.parse(readFileSync(path.join(FIXTURES, 'invalid', model, name), 'utf8'));
    assert.equal(validate(model, value).code, 'schema-version-unsupported', `${model}/${name}`);
  }
  // Версия СТАРЕЕ поддерживаемой — обычная невалидность: миграции внутрь v1 нет.
  const older = JSON.parse(readFileSync(path.join(FIXTURES, 'invalid', 'task', 'version-older.json'), 'utf8'));
  assert.equal(validate('task', older).code, 'schema-invalid');
});

test('отказ по незнакомым полям несёт их перечень отдельным полем вердикта', () => {
  // Перечень нужен читателю журнала: по нему «запись сделана механизмом новее меня»
  // отличается от порчи. Отдельным полем, а не разбором `note`: текст отказа — проза, и
  // матчер по ней разъехался бы с первой же правкой формулировки.
  for (const [model, extra] of [['task', 'stamp'], ['participant', 'address']]) {
    const value = JSON.parse(readFileSync(path.join(FIXTURES, 'invalid', model, 'extra-field.json'), 'utf8'));
    const verdict = validate(model, value);
    assert.equal(verdict.ok, false, model);
    assert.deepEqual([...verdict.extra], [extra], model);
  }
  // Отказ не о лишних полях перечня не несёт вовсе — иначе читатель принял бы за смесь
  // версий обычную порчу.
  const older = JSON.parse(readFileSync(path.join(FIXTURES, 'invalid', 'task', 'version-older.json'), 'utf8'));
  assert.deepEqual([...validate('task', older).extra], []);
});

test('parity схемы и константы: типы сообщений в схеме — те же, что в коде', () => {
  // Второго списка типов в коде не бывает (`VALUE_HOMES`, ключ `message-types`), но схема
  // — не код, и гейт литеральных копий её не читает. Держит их вместе эта сверка.
  assert.deepEqual(schemaOf('message').properties.type.enum, MESSAGE_TYPES);
});
