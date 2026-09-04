// Standalone-проверка package: собранный dist импортируется сам по себе, без CLI,
// без рабочего места и без чужих зависимостей. Запуск — своя команда package:
// `npm test --prefix cli/packages/promptobus` из корня репозитория; её же зовёт
// набор репозитория ([promptobus-package.test.mjs](../../../test/promptobus-package.test.mjs)).
//
// Файл лежит в package, а не в cli/test, намеренно: package обязан проверяться
// отдельно от механизма — иначе «собирается standalone» держалось бы на слове.
// Помощник вердиктов набора (check.mjs) сюда не тянется по той же причине.
//
// dist собирается скриптом pretest, поэтому чистый checkout проверяется без
// подготовки: заранее созданного dist файл не ждёт.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Импорт собранного модуля живёт ВНУТРИ теста, а не на верхнем уровне файла: не
// собрался один entry point — краснеет его собственная проверка, а остальные
// вердикты остаются. Импортом наверху такой файл обрывался бы целиком, и
// вердиктов не было бы ни по одной проверке — оборванный файл от лживого не
// отличить.
test('entry point "." отдаёт версию протокола и имя package', async () => {
  const index = await import('../dist/index.js');
  assert.equal(index.PROTOCOL_VERSION, 1);
  assert.equal(index.PACKAGE_NAME, '@ati-agents/promptobus');
});

test('entry point "./driver" собран отдельным модулем', async () => {
  // Типы стираются компиляцией, поэтому у заглушки driver проверяется факт
  // сборки отдельного модуля, а не его экспорты: их содержание приезжает в BL-408.
  const driver = await import('../dist/driver.js');
  assert.equal(typeof driver, 'object');
});

test('entry point "./host" отдаёт контракт и standalone-реализацию', async () => {
  const host = await import('../dist/host-index.js');
  assert.equal(typeof host.createStandaloneHost, 'function');
  assert.equal(typeof host.isPromptobusHost, 'function');
  assert.equal(typeof host.HOST_KIND, 'string');
});

test('entry point "./hooks" отдаёт план хуков', async () => {
  const hooks = await import('../dist/hooks.js');
  assert.equal(typeof hooks.planPromptobusHooks, 'function');
  assert.equal(typeof hooks.renderBusHook, 'function');
});

test('declarations собраны рядом с кодом', async () => {
  const dts = await readFile(new URL('../dist/driver.d.ts', import.meta.url), 'utf8');
  assert.match(dts, /interface Driver\b/);
});
