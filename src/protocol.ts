// Словарь шины: типы сообщений, адреса, идентичность задачи и вокабуляр гейта чужого
// mailbox'а. Ни диска, ни store — только грамматика и строки, которые печатают все.
//
// Дом здесь, а не в одном из двух store, потому что store'а в package два: production v1
// ([store.ts](store.ts)) и legacy, оставшийся ради чтения при миграции
// ([legacy-store.ts](legacy-store.ts)). Значение, лежащее в одном из них, второй читал бы
// импортом через границу версии — и разъехались бы они молча.
import path from 'node:path';

// Типы сообщений протокола v1. **Дом значения здесь**, и это не выбор удобства:
// список валидирует отправка, а она обязана собираться и проверяться без CLI. Дверь для
// остального механизма — adapter потребителя: оттуда типы берёт `lint`, там же он берёт
// обе шапки гейта чужого mailbox'а. В контракт потребителя их нет вовсе — тот листовой,
// его читает хук ленты, а того каждый layout рабочего места. Второго списка в коде не
// бывает: гейт литеральных копий `lint` держит один дом на ключ, и он же назван картой
// `VALUE_HOMES` в линтер потребителя.
export const MESSAGE_TYPES = ['task', 'status', 'question', 'answer', 'artifact', 'result', 'review'];

export const ORCHESTRATOR = 'orchestrator';

/**
 * Harness записи, которую не назвал ни журнал, ни adapter. Слово нейтральное намеренно:
 * имён harness'ов в package нет вовсе — их дом у driver'ов, а здесь стоит признание, что
 * поле не объявлено. У механизма его закрывает adapter значением своего driver registry.
 */
export const UNDECLARED_HARNESS = 'undeclared';

/** Роль записи, адрес которой не разбирается: правка руками, журнал после поломки. */
export const UNDECLARED_ROLE = 'undeclared';

const ADDRESS_RE = /^(orchestrator|(?:worker|reviewer):[a-z0-9][a-z0-9-]*)$/;
export const TASK_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// Отказ гейта адресован человеку, а не разбору поломки: печатать его со стеком значит
// выдавать самый частый законный исход за внутреннюю ошибку CLI. Команда, которая может
// звать `fail()`, так и делает (`promptobus done`); планировщики `planSpawn` и `planReview`
// зовутся ещё и как чистые функции — из набора и из `--dry-run`, — поэтому отказ у них
// остаётся броском, а признак ожидаемой несёт класс: верхний catch CLI опознаёт
// его по имени, как `ResolveError`, и стек не печатает. Тем же классом отвечает весь
// стор — разбор id задачи, `readTask`, обе ветки лока задачи и обе проверки
// `resolveIdentity`: их зовёт ещё и MCP-сервер участника, а `fail()` там убил бы процесс
// сервера вместе с ответом инструмента. Граница проходит по команде, а не по функции:
// `promptobus status --task net-takoy` и `--task 'плохой id'` — две опечатки в одном флаге, и
// разный вид ответа на них читается как разный исход.
export class GateError extends Error {}

export function isAddress(addr: unknown): boolean {
  return typeof addr === 'string' && ADDRESS_RE.test(addr);
}

// Адрес в имя каталога: `:` не годится для файловой системы Windows. Обратной коллизии
// нет — `worker-x` сам по себе не адрес. С cutover'а это имя ещё и **id участника
// store v1**: legacy-адреса переносятся в новый store как есть, и каталог mailbox'а
// остаётся тем же, каким его называл прежний CLI.
//
// Бросок остаётся голым, и держат его ЧИТАТЕЛИ. Новая запись участника проходит проверку
// адреса и негодного не принимает, но журнал прежнего CLI или ручная правка уже могут
// такой адрес содержать. Одна испорченная строка не имеет права стоить остальных, поэтому
// каждый обход ловит сам и идёт дальше (счётчик непрочитанного в `promptobus status`, уборка
// секретов в `promptobus done`, все три обхода надзирателя), и до верхнего catch отказ не доходит
// ни по одному маршруту команд.
export function addrDir(addr: unknown): string {
  if (!isAddress(addr)) throw new Error(`неизвестный адрес «${addr}» — orchestrator, worker:<slug> или reviewer:<slug>`);
  return (addr as string).replace(':', '-');
}

/**
 * Роль адреса отдельным значением. Store v1 держит её полем записи участника и из id не
 * выводит — здесь она считается ОДИН раз, при записи участника, а не при каждом чтении.
 */
export function roleOf(addr: unknown): string {
  const address = addr as string;
  if (!isAddress(address)) throw new Error(`неизвестный адрес «${addr}» — orchestrator, worker:<slug> или reviewer:<slug>`);
  return address === ORCHESTRATOR ? ORCHESTRATOR : address.slice(0, address.indexOf(':'));
}

export function workerAddress(slug: string): string {
  return `worker:${slug}`;
}

export function reviewerAddress(slug: string): string {
  return `reviewer:${slug}`;
}

export function requireTaskId(id: unknown): string {
  if (typeof id !== 'string' || !TASK_ID_RE.test(id)) throw new GateError(`недопустимый id задачи: «${id}»`);
  return id;
}

export function tasksDir(home: string): string {
  return path.join(home, 'tasks');
}

export function taskDir(home: string, id: string): string {
  return path.join(tasksDir(home), requireTaskId(id));
}

// Файлы участника в `workers/` — по его адресу. Склейку зовут spawn, ревью и уборка;
// разойдись копии — уборка мела бы мимо, поэтому дом имени здесь.
export function participantFileStem(address: string): string {
  const [kind, slug] = String(address).split(':');
  // Адрес без слага (`orchestrator`) имени файла не даёт вовсе, и молчать об этом нельзя:
  // прежде склейка отдавала `undefined`, шаблон давал `undefined.mcp.json` — файл, который
  // никто не искал и никто не убирал. Вход сюда сегодня недостижим: единственный
  // маршрут — уборка `promptobus done`, а она отсекает `orchestrator` строкой выше. Отказ
  // голый и той же формы, что у соседей по модулю (`addrDir`, `roleOf`): это ошибка
  // вызывающего, а не отказ человеку, и печатать его как гейт значило бы обещать маршрут,
  // которого нет.
  if (!slug) throw new Error(`адрес «${address}» не даёт имени файла участника — слага в нём нет`);
  return kind === 'reviewer' ? `reviewer-${slug}` : slug;
}

// Слаг едет в id задачи, каталог worktree и имя ветки — в файловую систему и git-ref,
// поэтому на выходе только `[a-z0-9-]`. Обрезаем по границе токена, не посреди слова.
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

export const SLUG_MAX = 24;

export function slugify(text: unknown, max: number = SLUG_MAX): string {
  const latin = String(text ?? '').toLowerCase().replace(/[\u0400-\u04ff]/g, (c) => TRANSLIT[c] ?? '');
  const slug = latin.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length <= max) return slug;
  // Заглядываем на символ дальше лимита: дефис там значит, что слово кончилось на границе.
  const cut = slug.slice(0, max + 1);
  const at = cut.lastIndexOf('-');
  return (at > 0 ? cut.slice(0, at) : slug.slice(0, max)).replace(/-+$/, '');
}

// Часы `newTaskIdentity`: настоящий `Date` подходит, а набор подставляет свои — так
// UTC-ветка проверяется независимо от TZ машины.
export interface Clock {
  getUTCFullYear: () => number;
  getUTCMonth: () => number;
  getUTCDate: () => number;
  getUTCHours: () => number;
  getUTCMinutes: () => number;
  getUTCSeconds: () => number;
}

/** Идентичность новой задачи: читаемый слаг впереди, машинный штамп в хвосте и в task.json. */
export function newTaskIdentity(slug?: string | null, now: Clock = new Date()): {
  id: string; slug: string | null; stamp: string;
} {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp = `t${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`
    + `-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
  return { id: slug ? `${slug}-${stamp}` : stamp, slug: slug || null, stamp };
}

// Хвост id — тот же штамп, что вернула newTaskIdentity; у задачи без слага он весь id.
export function stampOfId(id: unknown): string | null {
  const m = String(id ?? '').match(/t\d{8}-\d{6}$/);
  return m ? m[0] : null;
}

// Разделитель track'ов в заголовке задачи — тот же знак, которым разведены части читаемых имён.
export const TASK_TITLE_SEP = ' · ';

// Свой mailbox или чужой — единственное условие на всю шину. Сравнивать нечем (нет
// идентичности или владельца) — механизм молчит целиком: совместимость назад важнее
// защиты. Адреса worker'ов и reviewer'ов не гейтуются: адрес объявлен в их mcp-config.
export const FOREIGN_MARK = 'ЧУЖОЙ MAILBOX';
export const FOREIGN_ROUTE = 'Переписка не твоя — назови свою задачу аргументом task. '
  + 'Твоя, а сессия новая (демон прежней умер) — забери mailbox себе: mailbox {claim: true}.';

// Шапка удавшегося захвата — вторая половина того же разговора, что `FOREIGN_MARK`, и дом
// у неё здесь же: печатает её MCP-сервер, а вокабуляр гейта захвата живёт в сторе. Обе
// шапки цитируются прозой дословно, поэтому лежат константами — цитату сверяет с ними
// гейт contract quote (ключи `foreign-mark` и `mailbox-claimed-mark` в lint.js).
export const MAILBOX_CLAIMED_MARK = 'MAILBOX ЗАХВАЧЕН';

// Самый частый законный случай на этом гейте — «задача моя, а сессия новая, демон прежней
// умер». Маршрут один на все команды, разнится только то, что повторяют после захвата.
export function claimRoute(repeat: string): string {
  return 'Задача твоя, а сессия новая (демон прежней умер) — сначала забери mailbox себе: '
    + `mailbox {claim: true}, потом повтори ${repeat}.`;
}

// --- поля adapter'а в записи участника ------------------------------------------
//
// Собственные поля записи v1 — `id`, `role`, `harness`, `mode`, `sessionRef`,
// `capabilities`; всё остальное про участника пишет adapter, и лежит оно в `metadata`,
// куда core не заглядывает. Заглянуть, однако, приходится в шести местах:
// ключ sidecar'а — АДРЕС, а не id участника, доклад надзирателя называет участника словами
// человека, и разбор стопа называет его каталог и сессию.
//
// **Дверь туда одна — эти accessor'ы, и другой в core нет.** Россыпь `p.metadata.<поле>`
// по core вернула бы тот же мост под другим именем: поле, названное в четырёх файлах,
// переименовывается в трёх. Здесь у каждого поля один дом и одна строка про то, чьё оно.
// Читателя записи это не ограничивает: adapter читает свои поля как хочет — он их и пишет.

/** Запись участника глазами этих accessor'ов. Структурно — чтобы не тянуть модель v1. */
interface WithMetadata {
  metadata?: Record<string, unknown> | null;
}

function field(p: WithMetadata | null | undefined, name: string): string | null {
  const v = p?.metadata?.[name];
  return typeof v === 'string' && v ? v : null;
}

/**
 * Адрес участника — `orchestrator`, `worker:<слаг>`, `reviewer:<слаг>`. Пишет его adapter;
 * ключом по нему идут health, отметки стопа, contact point'ы и отметки конца хода, и его же
 * несёт notification, который читает человек. Из id адрес не собирается: `addrDir`
 * инъективен, но роль записи, у которой поля нет, спросить не у кого.
 */
export function addressOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'address');
}

/**
 * Имя поля, в котором механизм оставляет свою версию при подъёме участника.
 * Значение кладёт adapter, читает store, поэтому дом у имени один: разъехавшиеся половины
 * дали бы молчащую проверку вместо честного отказа.
 *
 * Дом полю — `metadata`, а не собственное поле записи: `metadata` для схемы opaque, и запись
 * с маркером читается механизмом ЛЮБОЙ версии. Собственное поле было бы «лишним» для
 * читателя старше себя — ровно той поломкой, ради которой маркер и заводится.
 */
export const MECHANISM_VERSION_FIELD = 'mechanismVersion';

/**
 * Версия механизма, сделавшего запись участника. По ней читатель журнала отличает «запись
 * новее меня» от порчи: незнакомые поля плюс версия новее — смесь версий после `sync`, а не
 * испорченный журнал ([store v1](v1/store.ts)).
 */
export function mechanismVersionOf(p: WithMetadata | null | undefined): string | null {
  return field(p, MECHANISM_VERSION_FIELD);
}

/** Когда adapter поднял сессию участника: окно регистрации свежего подъёма. */
export function startedOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'started');
}

/** Каталог рабочей копии участника — маршрут человеку в докладе о стопе. */
export function repoAbsOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'repoAbs');
}

/** Снят ли участник с наблюдения и когда: отметку ставит adapter (`promptobus dismiss`). */
export function dismissedOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'dismissed');
}

/**
 * Короткий id сессии участника по журналу: сессии уже нет, а каталог живёт. Им зовут
 * сессию у harness'а (вход, журнал, стоп), и его же разбирает подъём из вывода `--bg`.
 */
export function sessionOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'session');
}

/**
 * Полный идентификатор сессии участника — тот, которым сессия зовёт СЕБЯ
 * в своём окружении и с которым приходит писать (замечание ревью). Кладёт
 * его подъём из записи harness'а рядом с коротким; у записей прежнего релиза и у подъёмов,
 * где список сессий не разобрался, поля нет — тогда сверка откатывается на префикс.
 */
export function sessionIdOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'sessionId');
}

function norm(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * Один ли это идентификатор сессии — ЗАПАСНОЕ правило, для записей без полного id. Сверка
 * там префиксная: harness называет одну сессию двумя написаниями — полный идентификатор
 * даёт uuid, а короткий `id`, который подъём разобрал из вывода `--bg`, это первые
 * восемь hex того же uuid (замер: `id: "e8c5be23"` при
 * `sessionId: "e8c5be23-dfef-4d20-bd96-e2a40a366b97"`).
 *
 * **Предпосылка эта не наш контракт, и строить на ней гейт нельзя** (замечание ревью).
 * Разъедься написания на следующей сборке — сверка объявила бы чужой каждую сессию, и
 * молча. Поэтому основным правилом стало равенство полных id (`foreignSessionOf` ниже), а
 * префикс остался там, где полного id взять неоткуда: у записей прежнего релиза и у
 * подъёмов, где `agents --json` не разобрался и id пришёл из свободного текста вывода.
 *
 * Регистр приводится: hex у harness'а нижний, но правило это не наше. Пустое с обеих сторон
 * — не совпадение, а неизвестность: решает её вызывающий.
 */
export function sameSession(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * Пишет за адрес участника ЧУЖАЯ сессия? Отдаёт id из записи, за которой адрес закреплён, —
 * или `null`: пишет своя либо сверить нечем.
 *
 * Правило одно на все двери гейта — запись contact point'а, отметки сторожа и разбор
 * надзирателя, — и живёт оно здесь, а не копиями у каждой: разъехавшись, копии дали бы
 * механизм, который одной дверью пускает, а другой нет.
 *
 * Порядок источников: полный id записи против пишущего РАВЕНСТВОМ, и только при его
 * отсутствии — префикс короткого (`sameSession` выше). Обе стороны обязаны быть названы:
 * запись без id сессии — неизвестность, а не чужак, и отказывать по ней нельзя.
 */
export function foreignSessionOf(p: WithMetadata | null | undefined, session: string | null | undefined): string | null {
  const writer = norm(session);
  if (!writer) return null;
  const full = sessionIdOf(p);
  if (full) return norm(full) === writer ? null : full;
  const short = sessionOf(p);
  if (!short) return null;
  return sameSession(short, writer) ? null : short;
}

/** Читаемое имя участника, под которым его сессия видна человеку у harness'а. */
export function nameOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'name');
}

/** Сессия-владелец mailbox'а `orchestrator`. Владение адресом, а не задачей. */
export function ownerOf(p: WithMetadata | null | undefined): string | null {
  return field(p, 'owner');
}

/** Владение mailbox'ом: закрыт ли он за другой сессией. */
export interface Ownership {
  gated: boolean;
  owner: string | null;
  session: string | null;
}

// Шапка разговора о чужой задаче — одна на гейты spawn, done, review и status. Тип входа
// структурный: журнал у двух store'ов package'а свой, а нужны отсюда только id и заголовок.
export function foreignTaskLine(meta: { id: string; title?: string }, own: Ownership): string {
  return `задача ${meta.id} («${meta.title}») закреплена за сессией ${own.owner}, эта — ${own.session}`;
}

// Строка о битом для ответа инструмента — отдельной функцией: её печатают трое.
export function brokenNote(broken: string[]): string | null {
  return broken.length ? broken.join('\n') : null;
}
