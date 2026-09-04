// Уборка песочниц оборванных прогонов набора. Не `*.test.mjs` — раннер (run.mjs)
// берёт из каталога только их, и этот файл в прогон не попадает.
//
// Свою песочницу файл набора снимает хуком выхода ([sandbox.mjs](sandbox.mjs)), но
// до хука не доходит ровно оборванный прогон: Ctrl-C, снятие по потолку, падение процесса.
// Каталог остаётся в системном `$TMPDIR` навсегда — мести его некому. Замер 2026-09-03 на
// машине владельца: 126 каталогов `ati-*`/`promptobus-*`, из них `promptobus-sync-` 23,
// `promptobus-promptobus*` 38, `promptobus-bushook-` 9; часть префиксов старше
// переименования , то есть следы пережили не один релиз.
//
// **Зовётся из [run.mjs](run.mjs), а не из общего помощника [check.mjs](check.mjs).** Раннер —
// единственный процесс набора, который видит НАСТОЯЩИЙ `$TMPDIR`: детям он уводит
// `TMPDIR`/`TMP`/`TEMP` в каталог прогона, и `os.tmpdir()` у них отдаёт его. Уборка в
// `check.mjs` поэтому мела бы каталог прогона — с живыми песочницами соседних файлов той же
// волны, — а накопленного в системном `$TMPDIR` не тронула бы вовсе.
//
// Уборка и пороги общие с канарейкой ([canary-runs.mjs](../scripts/canary-runs.mjs),
// ): беда одна, и вторая копия порогов разошлась бы с первой. Отличие одно и оно
// параметр — `keep = 0`: у песочницы набора нет отчёта, который читают после прогона, и
// оставлять свежие «на почитать» незачем. Держит их только возрастная отсечка в час, и
// держит она то же самое, что у канарейки, — ИДУЩИЙ рядом прогон: параллельный `npm test`
// или файл, запущенный руками.
//
// **Каталоги сокетов под `/tmp` уборка не трогает, и это не недосмотр.** Тестовый сокет
// живёт в `/tmp`, а не в `$TMPDIR`, из-за лимита длины `sun_path` ([sandbox.mjs](sandbox.mjs),
// ), а `/tmp` — общий системный каталог, куда пишет вся машина: уборку по префиксу
// набор там не ведёт вовсе. Следы сокетов ловит вердикт `release-gates.mjs` — «после
// прогона не осталось сокетов и песочниц прогона»; перечень префиксов и сторож —
// [sock-prefixes.mjs](sock-prefixes.mjs).
import os from 'node:os';
import { sweepPreviousRuns, sweptLine } from '../scripts/canary-runs.mjs';

// Строка итога уборки проходит через этот модуль транзитом, а не берётся раннером у общего
// дома напрямую: копия `run.mjs` в песочнице [runner.test.mjs](runner.test.mjs) соседнего
// каталога `scripts/` не видит вовсе, и второй относительный импорт оттуда падал бы на
// старте. Дом фразы от этого не двоится — он остаётся один.
export { sweptLine };

// Префиксы, которые набор заводит САМ, — только их и метём. Собраны грепом по литералам
// `makeSandbox('…')` и `mkdtempSync(path.join(os.tmpdir(), '…'))` в `test/` и в наборе
// вложенного package; полноту
// перечня сторожит [tmpdir-sweep.test.mjs](tmpdir-sweep.test.mjs) — тем же грепом по
// каталогу, как [runner.test.mjs](runner.test.mjs) сторожит состав `SERIAL`. Без сторожа
// новый префикс утекал бы молча: перечень собран руками.
//
// Запись покрывает всё, что с неё начинается, поэтому семейства заданы общим началом:
// `promptobus-promptobus` — это и `-review-`, и `-mcp-`, и `promptobus-promptobus spawn-`
// (пробел в имени настоящий); `promptobus-runner-` — три песочницы `runner.test.mjs`;
// `promptobus-test-` — и `promptobus-test-run-`, каталог прогона раннера.
//
// Чужого здесь нет и быть не должно: `promptobus-canary-`, `promptobus-release-gates-`,
// `promptobus-live-e2e-`, `promptobus-live-cursor-` заводят живые прогоны и гейты релиза —
// у них своя уборка и свои пороги, — `agents-review-` заводит боевой код
// ([headless.js](../lib/headless.js)). **`promptobus-e2e-` — общий**: его заводит
// `promptobus-e2e.test.mjs`, а [release-gates.mjs](../scripts/release-gates.mjs) считает такие каталоги песочницами
// живого прогона. Разводит их та же возрастная отсечка: идущий прогон гейтов моложе часа.
//
// Песочницы набора вложенного package (`promptobus-store-` и соседи) в перечне ЕСТЬ, хотя
// заводит их другой набор. Довод — не адрес файла, а куда течёт: `npm test --prefix
// cli/packages/promptobus` руками льёт их в тот же системный `$TMPDIR`, а метём мы его, а не
// каталог набора. Своей точки старта package для этого не нужно: следы его ручного прогона
// уедут при следующем `npm test` репозитория.
export const SUITE_PREFIXES = [
  'promptobus-activation-', 'promptobus-ambient-', 'promptobus-archive-',
  'promptobus-base-', 'promptobus-bgsess-', 'promptobus-bootstrap-', 'promptobus-bushook-',
  'promptobus-check-', 'promptobus-cli-flags-', 'promptobus-codex-', 'promptobus-console-',
  'promptobus-copy-', 'promptobus-cursor-', 'promptobus-doctor-', 'promptobus-driver-',
  'promptobus-e2e-', 'promptobus-env-', 'promptobus-exec-', 'promptobus-external-',
  'promptobus-fresh-', 'promptobus-harness-', 'promptobus-home-', 'promptobus-homedir-',
  'promptobus-hooks-test-', 'promptobus-host-', 'promptobus-lint-', 'promptobus-manifest-',
  'promptobus-mcp-', 'promptobus-migration-', 'promptobus-modules-', 'promptobus-package-',
  'promptobus-plugin-', 'promptobus-promptobus', 'promptobus-publish-', 'promptobus-races-',
  'promptobus-refs-', 'promptobus-review-', 'promptobus-root-', 'promptobus-rules-',
  'promptobus-runner-', 'promptobus-setup-', 'promptobus-skills-', 'promptobus-smoke-',
  'promptobus-store-', 'promptobus-sweep-', 'promptobus-sync-', 'promptobus-test-',
  'promptobus-tools-', 'promptobus-util-', 'promptobus-v1-', 'promptobus-wt-',
  'promptobus-zone-',
];

/**
 * Снести песочницы прежних прогонов набора в `dir`, оставив всё моложе часа. `current` —
 * каталог текущего прогона: его завела эта же команда, и в счёт он не идёт.
 *
 * Возвращает перечень снесённого — печатает его вызывающий: молчаливая уборка в общем
 * `$TMPDIR` читается как пропажа. Отказ сноса (каталог занят, чужие права) прогон не роняет и
 * соседей по обходу не уносит — он ловится покаталожно в самой уборке, а имена отказавших
 * ложатся в `refused`: уборка тут гигиена, а не гейт, и набор из-за неё краснеть не вправе.
 */
export function sweepTestSandboxes(dir = os.tmpdir(), {
  now = Date.now(), current = null, refused = [],
} = {}) {
  const swept = [];
  for (const prefix of SUITE_PREFIXES) {
    swept.push(...sweepPreviousRuns(dir, { keep: 0, prefix, current, now, refused }));
  }
  return swept.sort();
}
