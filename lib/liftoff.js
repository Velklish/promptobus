import { info, warn, fail } from './copy/util.js';
import { run } from './copy/exec.js';

// Подъём участника шины и реестр его сессий. Реестр живёт здесь вместе с подъёмом —
// иначе spawn.js и review.js импортировали бы друг друга. Подъём один на worker'а и
// reviewer'а: построчные копии уже разъезжались на сверке «сессия появилась». Различия
// ролей — слова и маршруты — приходят параметрами.
const ROLE = {
  worker: { nom: 'worker', acc: `worker'а` },
  reviewer: { nom: 'reviewer', acc: `reviewer'а` },
};

// `persist(session, state, sessionId)` — запись участника в журнал. Зовётся в ЛЮБОМ исходе
// сверки, в том числе у мёртвого spawn'а: повторный подъём тем же адресом — штатный
// перезапуск, и без записи он упёрся бы в отказ «каталог занят, а участника в журнале нет».
// Исход сверки уезжает вторым аргументом: `applyParticipant` заменяет запись целиком, и без
// исхода отказ «сессии нет» снимал бы пометку `pending` у reviewer'а. Третьим — ПОЛНЫЙ
// идентификатор сессии (`BL-469`, замечание ревью): по нему гейт владения адресом сверяется
// равенством, тогда как короткий id разобран из свободного текста вывода и годится только на
// префикс. `launchFailNote` и `deadNote` — маршруты отказов, у ролей разные; `awaitOptions` —
// шов для теста.
export async function liftoffParticipant({
  tool, argv, cwd, env, name, role, launchFailNote = '', deadNote = '', persist, awaitOptions,
}) {
  const who = ROLE[role];
  const r = run(tool.path, argv, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Одни слова на три ветки отказа: маршрут один и держится на записи, сделанной до запуска.
  if (r.error?.code === 'ENOENT') fail(`${tool.path}: бинарь пропал между проверкой и запуском — ${who.acc} поднимать нечем.${launchFailNote}`);
  if (r.error) fail(`claude --bg: ${r.error.message}.${launchFailNote}`);
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
  if (r.status !== 0) fail(`claude --bg завершился с кодом ${r.status}${output ? `: ${output}` : ''}.${launchFailNote}`);

  // Сессия поднялась? `claude --bg` возвращает 0 и печатает «backgrounded» и тогда, когда
  // сессии не будет (молчаливый сбой демона). Сверяем тем же findSession, что у
  // `promptobus status`; регистрация отстаёт на доли секунды — с коротким повтором.
  const seen = await awaitSession(name, awaitOptions);
  const session = spawnedSessionId(seen, output);
  // Идентификатор сессии дописывается вторым run'ом: до запуска его знать неоткуда. Полный
  // берётся ТОЛЬКО из записи harness'а (`sessionId` рядом с `id`) и не угадывается из
  // вывода: `parseSessionId` законно отдаёт и токен вроде `agent-12345`, который полным
  // идентификатором не является вовсе. Не разобрали — поля нет, и гейт откатится на префикс.
  persist(session, seen.state, sessionIdFull(seen));
  if (seen.state === 'dead') {
    if (output) info(output);
    fail(`claude --bg отчитался успехом, но живой сессии «${name}» в claude agents нет — ${who.nom} НЕ поднят.`
      + (seen.ghost ? ` Под этим именем лежит запись прошлой сессии (${seen.ghost.id ?? 'без id'}), пережившая свой демон, — это не она.` : '')
      + deadNote);
  }
  return { output, session, seen };
}

// Что сказано о подъёме после успеха — одно на обоих. Неподтверждённая сверка и
// неразобранный id — не отказ: участник поднят, найти его можно по имени.
export function sayLiftoff({ name, seen, session, output }) {
  if (seen.state === 'unknown') {
    warn(`подъём сессии «${name}» не подтверждён: claude agents --json не разобран.`
      + ' Проверь сам — участник, которого нет, молчит так же, как работающий.');
  }
  if (!session) warn(`идентификатор сессии из вывода не разобран — ищи её по имени «${name}»: claude agents`);
  if (output) info(output);
}

// Идентификатор bg-сессии из вывода `claude --bg`. Формат вывода — не контракт: не
// разобрали — не отказ.
export function parseSessionId(output) {
  const text = String(output ?? '');
  const uuid = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  if (uuid) return uuid[0];
  // Наблюдённый формат v2.1.221: «backgrounded · d7b7340b · <имя>».
  const bg = text.match(/backgrounded\W+([0-9a-f]{6,})/i);
  if (bg) return bg[1];
  // Третий шаблон — запасной и нарочно узкий: значение обязано нести цифру, иначе на
  // «session started successfully» идентификатором объявлялось бы `started`. Не подошло —
  // `null`.
  const named = text.match(/\b(?:agent|session|id)\b\W{0,4}([A-Za-z0-9][\w-]{5,})/i);
  return named && /\d/.test(named[1]) ? named[1] : null;
}

// Откуда берётся id сессии после spawn'а. Порядок важен: запись из `claude agents --json` —
// прямой ответ harness'а, а `parseSessionId` угадывает id в свободном тексте и на другой
// сборке claude угадает иначе. Отдельной функцией — чтобы порядок проверялся тестом.
//
// Имя не `sessionIdOf` (замечание ревью): так зовётся accessor записи участника в
// [protocol.ts](../../packages/promptobus/src/protocol.ts), и там он значит ПОЛНЫЙ
// идентификатор — два разных предмета под одним именем в одном репозитории. И не
// «короткий»: первая ветка отдаёт короткий `id` записи harness'а, а первый шаблон
// `parseSessionId` законно отдаёт полный uuid из текста. Предмет здесь — «id сессии, каким
// его узнал подъём», и имя говорит ровно это.
export function spawnedSessionId(seen, output) {
  return seen?.session?.id ?? parseSessionId(output);
}

// Полный идентификатор сессии — тот, которым она зовёт себя (`CLAUDE_CODE_SESSION_ID`), и
// приходит он только из записи harness'а. В записи участника он ложится полем `sessionId`, и
// читает его оттуда `sessionIdOf` ядра — тот же предмет с другой стороны. Угадывания здесь
// нет намеренно: связь «короткий id — префикс полного» снята одним замером и контрактом не
// является, а гейт владения адресом (`BL-469`) на ней стоит fail-closed. Записи нет — `null`,
// и гейт откатывается на префикс.
export function sessionIdFull(seen) {
  const full = seen?.session?.sessionId;
  return typeof full === 'string' && full.trim() ? full.trim() : null;
}

// Ждём появления сессии в списке. Исходы: `alive` — нашлась, `dead` — не нашлась за все
// попытки, `unknown` — вывод `claude agents --json` не разобран (это не смерть).
export async function awaitSession(name, { tries = 6, delayMs = 500, sessions = bgSessions } = {}) {
  let ghost = null;
  for (let i = 0; i < tries; i += 1) {
    // Список после `--bg` меняется: без сброса кэш первой пустой пробы объявил бы
    // только что поднятую сессию ненайденной на всех оставшихся попытках.
    if (sessions === bgSessions) resetBgSessionsCache();
    const list = sessions();
    if (list === null) return { state: 'unknown', session: null, ghost: null };
    const hit = findSession(list, name);
    // Совпавшего имени мало: перезапуск умершего worker'а идёт тем же адресом, а запись
    // прошлой сессии из списка не исчезает — успехом её считать нельзя.
    if (hit && sessionLiveness(hit, list) === 'alive') return { state: 'alive', session: hit, ghost: null };
    if (hit) ghost = hit;
    if (i < tries - 1) await new Promise((r) => { setTimeout(r, delayMs); });
  }
  return { state: 'dead', session: null, ghost };
}

// Живые bg-сессии по именам, которые мы задавали при spawn'е. Формат `claude agents
// --json` не контракт: не разобрали — говорим об этом, а не выдумываем состояние.
//
// Удачный разбор помнится до сброса: `promptobus status` и удар сердца надзирателя читают
// список по каждому участнику, и без памяти каждый стоил бы отдельного запуска. Отказ
// разбора не кэшируется — один сбой не объявляет все последующие вызовы `unknown`.
// Сегодняшним читателям это не стоит ничего, и обе половины замерены (2026-09-02): снимок
// гаснет на ПЕРВОМ `null`, поэтому неразобранный ответ стоит одного запуска при любом
// числе участников, а надзиратель перед снимком удара сердца кэш сбрасывает сам —
// межударной памяти у него нет вовсе. Цена появилась бы у читателя, снимающего состояние
// чаще удара сердца и без сброса: 60 снимков подряд — 1 запуск на разобранном ответе
// против 60 на неразобранном. Такого читателя нет, и заводить его нельзя (`BL-420`,
// [warden.js](warden.js)). Набор после spawn/stop зовёт
// `resetBgSessionsCache` (sandbox.mjs); опрос `awaitSession` и надзиратель сбрасывают сами,
// иначе увидели бы список до изменения.
let bgSessionsCache = undefined;

export function resetBgSessionsCache() {
  bgSessionsCache = undefined;
}

export function bgSessions({ fresh = false } = {}) {
  if (!fresh && bgSessionsCache !== undefined) return bgSessionsCache;
  const r = run('claude', ['agents', '--json'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    const list = Array.isArray(parsed) ? parsed : parsed.agents ?? parsed.sessions ?? [];
    if (!Array.isArray(list)) return null;
    bgSessionsCache = list;
    return list;
  } catch {
    return null;
  }
}

// Сверка идёт по полю `name` записи, и целиком: подстрока по всей записи находила бы
// сессию, чей `cwd` содержит имя другой. По `kind` не фильтруем: признак самокалибровки не
// имеет — фильтр по исчезнувшему полю объявил бы мёртвыми всех разом.
export function findSession(sessions, name) {
  const hits = (sessions ?? []).filter((s) => s?.name === name);
  if (!hits.length) return null;
  // Больше одной записи — штатно: призрак и новая сессия. Выбираем живую.
  return hits.find((s) => sessionLiveness(s, sessions) === 'alive') ?? hits[0];
}

// Живость bg-сессии по её записи. Присутствие записи живостью не является: запись
// переживает свой демон. Отличает их `pid`: у живой он есть, у пережившей нет вовсе (после
// `claude stop` запись исчезает целиком). Признак самокалибрующийся: отсутствие `pid`
// значит «числится» только там, где этот claude вообще печатает pid.
export function sessionLiveness(session, sessions = null) {
  if (!session) return 'dead';
  const hasPid = (s) => typeof s?.pid === 'number' && s.pid > 0;
  if (hasPid(session)) return 'alive';
  return (sessions ?? []).some(hasPid) ? 'stale' : 'alive';
}
