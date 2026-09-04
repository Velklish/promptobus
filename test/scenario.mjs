// Сценарий E2E шины — один на все составы. Не `*.test.mjs` — раннер (run.mjs)
// берёт из каталога только их, и этот файл в прогон не попадает.
//
// **Состав объявляет вызывающий, а не сверка.** Harness у участников бывает разный —
// «оркестратор Claude Code, worker Cursor, reviewer Codex» — и раньше состав был зашит прямо
// в вердикты литералом `'claude'`. Теперь его отдаёт `harness.at(адрес)`, а чего тот не
// назвал, берётся у самого `harness` и у умолчаний `participantHarness` ниже; умолчания
// повторяют прежние литералы буква в букву, поэтому прогоны с одним harness'ом на состав
// (подставной Claude и живая канарейка) правки не требуют и идут прежним числом вердиктов.
//
// **Шаг, которого harness участника не играет, гасится ЕГО объявленной способностью**, а не
// именем состава: сверять «если worker Cursor» значило бы завести второй список составов
// рядом с первым. Способностей четыре — `guard` (участник зовёт сторож цикла сам), `blocks`
// (ход умеет вставать на диалоге разрешения и на лимите), `stalls` (стоп участника разбирается
// его driver'ом на месте, а не по тишине с потолком в минуты) и `files` (harness пишет
// участнику mcp-config файлом).
//
// Предмет — ПОЛНЫЙ круг оркестрации, тот самый, который до этой задачи не собирался нигде:
// spawn worker'а → его первый `status` → `answer` оркестратора → стук надзирателя в сокет
// участника → его `result` → `promptobus review` со scripted-reviewer'ом → замечания → второй
// `result` → доклад о МОЛЧАЛИВОМ конце хода → `promptobus done` с гашением сессий и уборкой
// worktree → `promptobus prune`. Механизм в круге настоящий целиком: CLI, driver `claude`,
// надзиратель процессом, MCP-сервер шины, store задачи, git. Подменён ровно бинарь
// harness'а, и подмена стоит на его границе — driver остаётся предметом проверки.
//
// **Оркестратор в сценарии — сам вызывающий**: он держит свой messaging-сокет (в него
// приезжают postcard'ы надзирателя), ходит на шину настоящим `promptobus mcp` по stdio и зовёт
// `promptobus guard` на конце своих ходов. Второго механизма для этого нет — так же работает
// живая сессия оркестратора.
//
// **Число вердиктов фиксировано.** Шаг, не дождавшийся своего, даёт КРАСНЫЙ вердикт и не
// бросает: брошенное исключение унесло бы проверки ниже, и число вердиктов у прогонов
// разошлось бы — а требование постановки прямо обратное (три прогона подряд с одним
// числом). Отсюда же `waitFor`, возвращающий последнюю пробу вместо отказа по таймауту.
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitFor } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// Корень проверяемого механизма. Не задан — чекаут, и тогда прогон идёт ровно тем, чем шёл
// раньше: `npm test` этой переменной не ставит вовсе. Задан — весь механизм берётся оттуда
// целиком, одним корнем: бинарь, adapter store, разбор стопа, driver и собранный package.
// Половинчатый резолв (бинарь оттуда, store отсюда) сверял бы установленное дерево
// чекаутом, и расхождение между ними осталось бы невидимым — а канарейка заведена ровно
// ради него.
export const MECHANISM_ROOT = process.env.PROMPTOBUS_E2E_ROOT ?? path.join(here, '..');
export const PROMPTOBUS_BIN = path.join(MECHANISM_ROOT, 'bin', 'promptobus.js');

// Store берётся у adapter'а механизма — тем же модулем, которым его читают команды шины.
// Одна дверь мимо него: отметку доложенных стопов (`stalls.json`) adapter наружу не
// реэкспортирует, и сценарий берёт её у package напрямую. Своего чтения файла он не
// заводит: формат отметки — дело store, а не теста.
export const store = await import(path.join(MECHANISM_ROOT, 'lib', 'store.js'));
const { readStalls, TICK_MS } = await import(path.join(MECHANISM_ROOT, 'dist', 'index.js'));
// Разбор стопа и причина из `state.json` — у механизма, а не своим чтением файла: сверять
// доклад надо тем же, чем его считает надзиратель.
const { stallStands } = await import(path.join(MECHANISM_ROOT, 'lib', 'status.js'));
const { claudeDriver, sessionDetail } = await import(path.join(MECHANISM_ROOT, 'lib', 'driver-claude.js'));

// Маркеры тел сообщений. Сверяем ВХОЖДЕНИЕМ, а не равенством: у подставного harness'а тело
// приходит буква в букву, у живого его пишет модель по брифу — и требование дословности
// проверяло бы послушность модели, а не круг шины.
export const MARK = {
  status: 'E2E-STATUS-1',
  answer: 'E2E-ANSWER-1',
  result1: 'E2E-RESULT-1',
  review: 'E2E-REVIEW-1',
  review2: 'E2E-REVIEW-2',
  order: 'E2E-ORDER-1',
  result2: 'E2E-RESULT-2',
  quiet: 'E2E-QUIET-1',
  perm: 'E2E-PERM-1',
  limit: 'E2E-LIMIT-1',
  fan: 'E2E-FAN-1',
};

const NOTE_FILE = 'e2e/note.md';

/**
 * Адреса участников круга. Экспортируются ради вызывающего: он сверяет по ним СВОЙ стенд —
 * след подставного бинаря, реестр сессий, — а собственная копия строки разъехалась бы с этой
 * на первой же правке имени.
 */
export const WORKER = 'worker:e2e';
export const REVIEWER = 'reviewer:e2e';

// Пауза внутри хода участника — не украшение и не круглое число. Отметку «mailbox забран»
// (`deliveredAt`) кладёт не участник, а КРУГ надзирателя, и наблюдатель `fs.watch` события,
// пришедшие во время круга, теряет — следующий круг приходит опросом, через `TICK_MS`. Ход
// живой сессии идёт секундами и минутами, и там эта отметка ложится задолго до отправки;
// схлопнутый ход ломает порядок: замер 2026-09-02 на паузе в 400 мс дал `deliveredAt` на 8 мс
// ПОЗЖЕ отправки, и штатный конец хода прочитался бы как молчаливый (`stallStands`). Поэтому
// пауза берётся от такта самого надзирателя, а не литералом: подняли такт — выросла и она.
const TURN_PAUSE_MS = TICK_MS + 500;

/**
 * Скрипты ролей — единственный источник и для подставного harness'а (он играет их
 * буквально), и для живого (его брифы рендерятся из поля `say`). Разъехаться им негде:
 * сценарий один, и сверки у обоих harness'ей одни.
 */
export const WORKER_SCRIPT = {
  turns: [
    {
      say: `Первым ходом отправь оркестратору сообщение типа status с телом, начинающимся строкой «${MARK.status}». Больше ничего не делай и закончи ход.`,
      detail: 'status sent; awaiting next cycle',
      do: [{ tool: 'promptobus_send', args: { to: 'orchestrator', type: 'status', body: `${MARK.status}: взял задание, приступаю` } }],
    },
    {
      say: `Получив notification, забери mailbox, создай в своём worktree файл ${NOTE_FILE} со строкой «${MARK.result1}», закоммить его и отправь оркестратору сообщение типа result с телом, начинающимся строкой «${MARK.result1}». Закончи ход.`,
      detail: 'result sent; awaiting next cycle',
      do: [
        { tool: 'promptobus_mailbox' },
        { wait: TURN_PAUSE_MS },
        { write: { path: NOTE_FILE, text: `# ${MARK.result1}\n\nПравка worker'а сценария E2E.\n` } },
        { commit: { message: `: правка worker'а сценария E2E` } },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${MARK.result1}: правка внесена и закоммичена` } },
      ],
    },
    {
      say: `Получив notification с замечаниями ревью, забери mailbox и отправь оркестратору сообщение типа result с телом, начинающимся строкой «${MARK.result2}». Закончи ход.`,
      detail: 'second result sent; awaiting next cycle',
      do: [
        { tool: 'promptobus_mailbox' },
        { wait: TURN_PAUSE_MS },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${MARK.result2}: замечание ревью закрыто` } },
      ],
    },
    {
      say: 'Получив следующий notification, забери mailbox и НЕ отправляй на шину ничего — просто закончи ход.',
      detail: 'nothing to report; awaiting next cycle',
      do: [{ tool: 'promptobus_mailbox' }],
    },
  ],
};

/**
 * Ходы, которыми участник ВСТАЁТ, — стоп на диалоге разрешения и на исчерпанном лимите
 *. В `WORKER_SCRIPT` они не входят намеренно: тот общий с живым прогоном, его
 * `say` уезжают в бриф участника, а встать по команде живая сессия не может ни на permission,
 * ни на лимите. Поэтому `say` у них нет вовсе, а приклеивает их сценарий только подставному
 * harness'у.
 *
 * Обе ветки разбора (`sessionStall`) до этого жили только на юнитах с фикстурами: в E2E их
 * не играл никто. Mailbox ход забирает — иначе непрочитанное осталось бы висеть и надзиратель
 * стучал бы в вставшего по кругу.
 */
export const BLOCK_TURNS = [
  {
    detail: 'waiting for permission',
    // Метка — короткая, из наблюдённого набора живого харнеса (`permission prompt`,
    // `sandbox request`, `input needed`), а не текст самого запроса: `waitingFor` несёт
    // именно её ([15]).
    block: { waitingFor: 'permission prompt' },
    do: [{ tool: 'promptobus_mailbox' }],
  },
  {
    // Строка лимита — та, по которой его узнаёт разбор: свои причины сессия пишет своими
    // словами, и шаблон ловит именно эту форму («hit your … limit»).
    block: { limit: "You've hit your usage limit — limit resets at 21:00" },
    do: [{ tool: 'promptobus_mailbox' }],
  },
];

export const REVIEWER_SCRIPT = {
  turns: [
    {
      say: `Первым ходом отправь оркестратору сообщение типа result с телом, начинающимся строкой «${MARK.review}». Больше ничего не делай и закончи ход.`,
      detail: 'review sent; awaiting next cycle',
      do: [
        { tool: 'promptobus_mailbox' },
        { wait: TURN_PAUSE_MS },
        { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${MARK.review}: замечание — в заголовке правки нет номера задачи` } },
      ],
    },
  ],
};

/**
 * Второй round ревью: новый дифф уходит УЖЕ ПОДНЯТОМУ reviewer'у сообщением `type=task`, и
 * разбирает его тот же адрес — второй сессии команда не поднимает ([08]).
 *
 * Ход приклеивается к скрипту reviewer'а только там, где вызывающий этот round заказал
 * (`reviewRounds: 2`), — тем же приёмом, что `BLOCK_TURNS`: у прогонов с одним round'ом
 * ходов reviewer'а по-прежнему один, и число их вердиктов не двигается.
 */
export const REVIEW_ROUND_TURN = {
  say: `Получив notification с новым диффом, забери mailbox и отправь оркестратору сообщение типа result с телом, начинающимся строкой «${MARK.review2}». Закончи ход.`,
  detail: 'second review sent; awaiting next cycle',
  do: [
    { tool: 'promptobus_mailbox' },
    { wait: TURN_PAUSE_MS },
    { tool: 'promptobus_send', args: { to: 'orchestrator', type: 'result', body: `${MARK.review2}: новый дифф проверен, прошлое замечание закрыто` } },
  ],
};

/** Бриф роли: заголовок и ходы прозой. Подставной harness его игнорирует, живой им и живёт. */
export function briefText(title, script) {
  return `# ${title}\n\n`
    + 'Ты участник шины Promptobus в сценарии E2E. Делай ровно то, что сказано ниже, и ничего сверх этого.\n\n'
    + script.turns.map((t, i) => `${i + 1}. ${t.say}`).join('\n')
    + '\n';
}

// --- мелкие помощники ------------------------------------------------------------

export function git(cwd, ...args) {
  return spawnSync('git', ['-C', cwd, '-c', 'user.name=e2e', '-c', 'user.email=e2e@example.invalid', ...args], { encoding: 'utf8' });
}

/** Одна команда CLI ПРОВЕРЯЕМОГО механизма — тем бинарём, который назвал `MECHANISM_ROOT`. */
export function cli(args, { cwd, env }) {
  const r = spawnSync(process.execPath, [PROMPTOBUS_BIN, ...args], { cwd, env, encoding: 'utf8' });
  return {
    status: r.status,
    out: `${r.stdout ?? ''}${r.stderr ?? ''}`,
  };
}

// --- клиент MCP оркестратора --------------------------------------------------------

// Тот же транспорт, каким с сервером шины разговаривает Claude Code: построчный JSON-RPC по
// stdio, один долгоживущий процесс на сессию.
function startMcp(env, cwd) {
  const child = spawn(process.execPath, [PROMPTOBUS_BIN, 'mcp'], {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  const strays = [];
  let seq = 0;
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    for (;;) {
      const nl = buf.indexOf('\n');
      if (nl < 0) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        strays.push(line);
        continue;
      }
      const resolve = pending.get(msg.id);
      if (resolve) { pending.delete(msg.id); resolve(msg); }
    }
  });
  child.stderr.resume();
  const call = (method, params) => {
    const id = (seq += 1);
    const answer = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`нет ответа на ${method}`)), 30000);
      pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return answer;
  };
  const tool = async (name, args = {}) => {
    const res = await call('tools/call', { name, arguments: args });
    return {
      text: res?.result?.content?.map((c) => c.text).join('\n') ?? '',
      isError: res?.result?.isError === true,
    };
  };
  return { call, tool, strays, stop: () => { child.stdin.end(); child.kill(); } };
}

// --- сокет оркестратора --------------------------------------------------------------

// Настоящий слушатель на настоящем сокете: postcard'ы надзирателя приезжают сюда тем же
// проводом, каким они приезжают в живую сессию, — auth-строка и следом JSON инъекции.
function startInbox(socketPath, token) {
  const seen = [];
  const server = createServer((conn) => {
    let data = '';
    conn.setEncoding('utf8');
    conn.on('error', () => {});
    conn.on('data', (c) => { data += c; });
    conn.on('end', () => {
      const parsed = data.split('\n').filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l); } catch { return null; } });
      seen.push({
        auth: parsed[0]?.type === 'auth',
        tokenOk: parsed[0]?.token === token,
        from: parsed[1]?.from ?? null,
        msgV: parsed[1]?.msgV ?? null,
        body: parsed[1]?.message?.content ?? null,
      });
      conn.destroy();
    });
  });
  return {
    seen,
    listen: () => new Promise((res) => server.listen(socketPath, res)),
    close: () => new Promise((res) => server.close(res)),
  };
}

// --- стенд ---------------------------------------------------------------------------

/**
 * Рабочее место со своим клоном: origin — bare-репозиторий на диске, поэтому `freshenRepo`
 * делает настоящий `fetch origin`, но сети не касается, а `createWorktree` заводит
 * настоящую ветку. Мока git в сценарии нет вовсе — уборка `promptobus done` судит по тому, что git
 * действительно говорит.
 */
export function buildWorkspace(sandbox, { ns = 'loads_search', repo = 'cargos-api', root = null, tools = ['claude', 'cursor', 'codex'] } = {}) {
  // Standalone host: promptobus.json at the workspace root, clone on disk under that root.
  // Origin is a local bare repo so freshenRepo can fetch without the network.
  const ws = root ?? path.join(sandbox, 'ws');
  mkdirSync(ws, { recursive: true });
  if (!existsSync(path.join(ws, 'promptobus.json'))) {
    writeFileSync(path.join(ws, 'promptobus.json'), `${JSON.stringify({
      commandName: 'promptobus',
      tools,
    })}\n`);
  }
  if (!existsSync(path.join(ws, 'AGENTS.md'))) writeFileSync(path.join(ws, 'AGENTS.md'), 'workspace\n');

  const origin = path.join(sandbox, 'origin', `${repo}.git`);
  const seed = path.join(sandbox, 'seed');
  mkdirSync(origin, { recursive: true });
  mkdirSync(seed, { recursive: true });
  spawnSync('git', ['init', '--bare', '-b', 'main', origin], { encoding: 'utf8' });
  git(seed, 'init', '-b', 'main');
  writeFileSync(path.join(seed, 'AGENTS.md'), `Правила репозитория ${repo}.\n`);
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'init', '-q');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');

  const repoAbs = path.join(ws, repo);
  mkdirSync(path.dirname(repoAbs), { recursive: true });
  spawnSync('git', ['clone', '-q', origin, repoAbs], { encoding: 'utf8' });
  return { ws, repoAbs, repo, ns };
}

// --- сам сценарий ---------------------------------------------------------------------

/** Названия шагов — их же печатает отчёт живого прогона. */
export const STEPS = [
  'стенд и надзиратель',
  'spawn worker\'а',
  'первый status и postcard оркестратору',
  'answer оркестратора',
  'стук надзирателя и первый result',
  'ревью и замечания',
  'замечания worker\'у и второй result',
  'доклад о молчаливом конце хода',
  'стоп участника: permission (подставной harness)',
  'стоп участника: limit (подставной harness)',
  'раздача двум участникам и дедупликация артефакта',
  'history, status и захват mailbox\'а',
  'promptobus done: гашение сессий и уборка',
  'promptobus prune и выход надзирателя',
];

/**
 * Имя шага второго round'а ревью. Лежит отдельно от `STEPS`, а не в списке: тот перечисляет
 * шаги, которые идут в КАЖДОМ прогоне, и живой прогон печатает его длину заголовком
 * ([live-e2e.mjs](../scripts/live-e2e.mjs)) — обещать там шаг, которого прогон не идёт, значит
 * врать в первой же строке отчёта.
 */
export const REVIEW_ROUND_STEP = 'второй дифф тому же reviewer\'у';

/**
 * Harness ОДНОГО участника: чем его поднимать, чем о нём спрашивать и что он умеет играть.
 *
 * Три источника по убыванию силы: поле, названное составом для этого адреса (`harness.at`),
 * поле самого `harness` (состав из одного harness'а — прежняя форма вызова) и умолчание
 * здесь. Умолчания — прежние литералы сценария: harness `claude`, канал стука сокетом, снимок
 * сессий у общего `sessions()` и разбор состояния driver'ом Claude.
 *
 * `flags` — имя поля с флагами подъёма: у worker'а `spawnFlags`, у reviewer'а `reviewFlags`.
 * Одно поле на роль, потому что и команда у ролей разная.
 */
function participantHarness(harness, address, flags) {
  const own = (typeof harness.at === 'function' ? harness.at(address) : null) ?? {};
  const pick = (name, fallback) => {
    if (own[name] !== undefined) return own[name];
    if (harness[name] !== undefined) return harness[name];
    return fallback;
  };
  const scripted = pick('scripted', false);
  const sessions = pick('sessions', () => []);
  return {
    id: pick('id', 'claude'),
    scripted,
    // Сторож цикла зовёт сам участник: у подставного Claude это [participant.mjs](participant.mjs),
    // у Cursor — хук `stop` из проектного `.cursor/hooks.json`. У Codex хуков нет вовсе —
    // ни события конца хода, ни файла, куда его положить, — и отметки конца хода у него не
    // будет ни на одном ходе.
    guard: pick('guard', scripted),
    // Ход, встающий по команде, — только у подставного `claude`: поле `block` в ходе понимает
    // он один ([participant.mjs](participant.mjs)), а живой сессии ни permission-запроса, ни
    // исчерпанного лимита не устроить вовсе.
    blocks: pick('blocks', scripted),
    // Молчаливый конец хода сверяется ПРИЧИНОЙ, которую сессия написала о себе сама, —
    // строкой `detail` из `jobs/<id>/state.json` демона Claude: отметка доложенного в
    // `stalls.json` обязана ей принадлежать, иначе доклад засчитан не тому ходу. У Cursor
    // конец хода приносят `turn_ended` и хук `stop`, у Codex — ответ `turn/start`, и строки
    // причины нет ни у того, ни у другого: сверять доклад там нечем.
    stalls: pick('stalls', true),
    // Mcp-config участника ФАЙЛОМ по пути store (`participantMcpPath`): так его получает
    // Claude Code. Cursor читает проектный `.cursor/mcp.json` своего рабочего каталога,
    // Codex получает серверы полем запроса подъёма — у обоих файла store нет вовсе.
    files: pick('files', true),
    flags: pick(flags, []),
    plan: (script) => pick('plan', () => {})(address, script),
    liveSessions: (refs) => pick('liveSessions', () => [])(refs),
    pidsOf: (refs) => pick('pidsOf', () => [])(refs),
    pidAlive: pick('pidAlive', () => false),
    diagnose: () => pick('diagnose', () => '')(address),
    // Отданный ход. Спрашивается у harness'а, а не выводится из снимка здесь: «свободна» у
    // реестра Claude — это `status: idle`, у persist-сессии Cursor — панель без подписи
    // идущего хода, и одна строка сценария иначе значила бы у составов разное.
    idle: (ref) => (own.idle ? own.idle(ref) : sessions().find((x) => x.name === ref)?.status === 'idle'),
    // Снимок сессий подаётся driver'у ЯВНО: умолчание разбора собрало бы его через кэш
    // реестра, и один и тот же вызов проверял бы у разных harness'ей разное.
    inspect: (ref) => (own.inspect ? own.inspect(ref) : claudeDriver.inspect(ref, sessions())),
  };
}

/**
 * Прогнать сценарий. `harness` даёт две вещи, которых у сценария быть не может: подмену
 * бинаря (или её отсутствие) и способ спросить, живы ли сессии участников.
 *
 * `check(name, cond, detail)` — вердикт вызывающего: под набором это помощник
 * [check.mjs](check.mjs), в живом прогоне — свой сборщик отчёта.
 */
export async function runScenario({
  check, harness, sandbox, workspace = null, timeouts = {}, trace = () => {}, reviewRounds = 1,
}) {
  const step = timeouts.step ?? 30000;
  const stall = timeouts.stall ?? 75000;
  const ORCH_SESSION = `orch-${process.pid}`;
  const TASK = 'e2ebus-t20260901-000000';
  const wh = participantHarness(harness, WORKER, 'spawnFlags');
  const rh = participantHarness(harness, REVIEWER, 'reviewFlags');

  const { ws, repoAbs, repo } = buildWorkspace(sandbox, { root: workspace });
  const home = path.join(ws, '.promptobus');
  const workerBrief = path.join(sandbox, 'worker-brief.md');
  const reviewerBrief = path.join(sandbox, 'reviewer-brief.md');
  const reviewerScript = reviewRounds >= 2
    ? { ...REVIEWER_SCRIPT, turns: [...REVIEWER_SCRIPT.turns, REVIEW_ROUND_TURN] }
    : REVIEWER_SCRIPT;
  writeFileSync(workerBrief, briefText('Круг оркестрации E2E', WORKER_SCRIPT));
  writeFileSync(reviewerBrief, briefText('Ревью круга E2E', reviewerScript));
  // Ходы стопа приклеиваются ТОЛЬКО тому harness'у, который их играет, и только к скрипту, а
  // не к брифу: бриф собирается из `WORKER_SCRIPT`, и живой сессии эти ходы не сыграть
  //. Второй round ревью — тем же приёмом: ход появляется у reviewer'а ровно там,
  // где вызывающий этот round заказал.
  wh.plan(wh.blocks
    ? { ...WORKER_SCRIPT, turns: [...WORKER_SCRIPT.turns, ...BLOCK_TURNS] }
    : WORKER_SCRIPT);
  rh.plan(reviewerScript);

  // Contact point оркестратора — на настоящем сокете. Переменные `CLAUDE_CODE_MESSAGING_*`
  // общий перечень гигиены снимает у прогона намеренно (чужой сокет живого человека), и
  // здесь они появляются заново — но уже своим сокетом стенда, а не человека.
  const orchSock = harness.sock('orchestrator');
  const orchToken = 'e2e-orchestrator-token';
  const inbox = startInbox(orchSock, orchToken);
  await inbox.listen();

  const orchEnv = {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: ORCH_SESSION,
    CLAUDE_CODE_MESSAGING_SOCKET: orchSock,
    CLAUDE_CODE_MESSAGING_TOKEN: orchToken,
    PROMPTOBUS_HOME: home,
  };
  // Надзирателю идентичность оркестратора не нужна и вредна: его собственный launcher
  // снимает contact point родителя ровно затем же.
  const wardenEnv = { ...process.env, PROMPTOBUS_HOME: home };
  delete wardenEnv.CLAUDE_CODE_MESSAGING_SOCKET;
  delete wardenEnv.CLAUDE_CODE_MESSAGING_TOKEN;

  // Задача заводится до надзирателя: тот отказывается стеречь несуществующую, а поднять его
  // пораньше нужно ради доклада о стопе — он идёт ударом сердца, раз в 30 с, и время до
  // первого удара сценарий тратит на работу, а не на ожидание.
  store.createTask(home, { id: TASK, title: 'круг оркестрации E2E', owner: ORCH_SESSION });

  const wardenLog = path.join(sandbox, 'warden.out');
  const warden = spawn(process.execPath, [PROMPTOBUS_BIN, 'warden', '--task', TASK], {
    cwd: ws,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: wardenEnv,
  });
  // Запись под перехватом: обработчик события зовёт сам Node, и брошенное из него
  // исключение становится необработанным — а песочница к этому времени законно может быть
  // уже снесена (живой прогон убирает её сам, надзиратель ещё дописывает свой хвост).
  const keep = (c) => { try { appendFileSync(wardenLog, c); } catch { /* песочницы уже нет */ } };
  warden.stdout.on('data', keep);
  warden.stderr.on('data', keep);

  const mcp = startMcp(orchEnv, ws);
  // Contact point оркестратора сдаётся этим рукопожатием (`onJoin` сервера):
  // отдельного вызова инструмента ради него больше не нужно. Прежде тут стоял `promptobus_task`
  // сразу за `initialize` — подпорка, без которой шаг 3 ждал первого postcard'а впустую.
  await mcp.call('initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'promptobus-e2e-orchestrator', version: '1' },
  });

  // Конец хода оркестратора — тем же сторожем, каким его метит харнес.
  const orchGuard = () => spawnSync(process.execPath, [PROMPTOBUS_BIN, 'guard'], {
    cwd: ws,
    env: orchEnv,
    input: JSON.stringify({ session_id: ORCH_SESSION, cwd: ws }),
    encoding: 'utf8',
  });

  const inboxOf = (addr) => store.glanceInbox(home, TASK, addr);
  const msgOf = (addr, mark) => inboxOf(addr).find((m) => String(m.body ?? '').includes(mark)) ?? null;
  // Канон protocol v1 несёт ID участника-отправителя; адрес механизма собирается из него
  // тем же переводом, каким его пишет дверь.
  const sentBy = (m, addr) => m?.sender === store.addrDir(addr);
  const participantOf = (addr) => store.participantOf(store.readTask(home, TASK), addr);
  // Поля механизма (worktree, ветка, репозиторий) лежат в `metadata` записи v1; собственные
  // поля записи — роль, harness, режим, session reference и снимок capabilities.
  const fieldsOf = (addr) => participantOf(addr)?.metadata ?? {};
  const healthOf = (addr) => (store.readHealth(home, TASK) ?? {})[addr] ?? {};
  const postcard = (mark) => inbox.seen.find((p) => String(p.body ?? '').includes(mark)) ?? null;
  const timings = [];
  const at = (name, ms) => { timings.push({ name, ms }); trace(`${name}: ${(ms / 1000).toFixed(1)} с`); };
  // Чем прогон шёл на самом деле — по слову поднятого процесса. Уезжает в отчёт: канарейка
  // сверяет его со своим install-деревом, а сценарию знать, где «правильно», неоткуда.
  let selfBin = null;

  const t0 = Date.now();
  try {
    // --- шаг 1: стенд и надзиратель -------------------------------------------------
    const live = await waitFor(() => store.liveWarden(home, TASK), { timeoutMs: step });
    check('шаг 1: надзиратель задачи поднят настоящим процессом',
      !!live?.pid, `${JSON.stringify(live)} · ${readSafe(wardenLog)}`);
    at(STEPS[0], Date.now() - t0);

    // --- шаг 2: spawn worker'а ------------------------------------------------------
    const t2 = Date.now();
    const spawned = cli([ 'spawn', '--repo', repo, '--brief', workerBrief, '--task', TASK,
      '--worker', 'e2e', ...wh.flags], { cwd: ws, env: orchEnv });
    check('шаг 2: promptobus spawn поднял worker\'а и сказал об этом',
      spawned.status === 0 && /worker worker:e2e поднят/.test(spawned.out), tail(spawned.out));
    const wp = participantOf(WORKER);
    const wf = fieldsOf(WORKER);
    // Harness записи сверяется с ТЕМ, что назвал состав, а не с литералом: у смешанного
    // состава worker поднимается своим driver'ом, и зашитое имя проверяло бы состав, а не
    // запись. Снимок capabilities при этом от состава не зависит — доставку в живую сессию и
    // гашение объявляют все три driver'а, и участник без этого не участник вовсе.
    check('шаг 2: запись участника несёт harness, режим, ссылку на сессию и снимок capabilities',
      wp?.harness === wh.id && wp?.mode === 'managed' && typeof wp?.sessionRef === 'string'
      && wp?.capabilities?.stop === true && wp?.capabilities?.activation === 'push', JSON.stringify(wp));
    check('шаг 2: harness поднял живую сессию worker\'а, а не запись о ней',
      wh.liveSessions([wp?.sessionRef]).length === 1, wh.diagnose());
    check('шаг 2: worktree worker\'а заведён на своей ветке',
      !!wf.worktree && existsSync(wf.worktree)
      && out(git(wf.worktree, 'rev-parse', '--abbrev-ref', 'HEAD')) === wf.branch,
      `${wf.worktree} · ${out(git(wf.worktree ?? ws, 'rev-parse', '--abbrev-ref', 'HEAD'))}`);
    // Каким механизмом идёт прогон, говорит сам поднятый процесс, а не резолв путей в этом
    // файле: `promptobus spawn` пишет участнику mcp-config, и путь бинаря в нём — СВОЙ, взятый у
    // запущенного модуля (`PROMPTOBUS_BIN` в [util.js](../lib/util.js)). Резолв здесь проверял бы
    // намерение, эта строка — факт. Канарейка сверяет тот же путь со своим
    // install-деревом и берёт его из отчёта: сценарию знать, где «правильно», неоткуда.
    // Читается ОДНО поле: в остальных подставленные токены canonical-серверов.
    //
    // Вердикт идёт у harness'а, который получает mcp-config ФАЙЛОМ по пути store: у Cursor
    // тот же путь бинаря лежит в проектном `.cursor/mcp.json` рабочего каталога участника, у
    // Codex — в полях запроса подъёма, и обоих store не видит вовсе. Читать их своим резолвом
    // значило бы завести второй дом одному и тому же вопросу.
    if (wh.files) {
      selfBin = readSelfBin(store.participantMcpPath(home, TASK, WORKER));
      check('шаг 2: mcp-config участника написан бинарём проверяемого дерева — путь назвал сам процесс',
        !!selfBin && samePath(selfBin, PROMPTOBUS_BIN), `${selfBin} · ожидался ${PROMPTOBUS_BIN}`);
    }
    at(STEPS[1], Date.now() - t2);

    // --- шаг 3: первый status и postcard --------------------------------------------
    const t3 = Date.now();
    const status = await waitFor(() => msgOf(store.ORCHESTRATOR, MARK.status), { timeoutMs: step });
    check('шаг 3: первый status worker\'а лёг в mailbox оркестратора',
      sentBy(status, WORKER) && status?.type === 'status', JSON.stringify(status));
    const card = await waitFor(() => postcard(MARK.status), { timeoutMs: step });
    check('шаг 3: надзиратель разбудил оркестратора postcard\'ом с текстом самого сообщения',
      card?.auth === true && card?.tokenOk === true && card?.msgV === 1 && card?.from === 'promptobus-warden',
      JSON.stringify(inbox.seen));
    check('шаг 3: health оркестратора называет канал сокетом и считает стуки',
      healthOf(store.ORCHESTRATOR).channel === 'socket' && (healthOf(store.ORCHESTRATOR).knocks ?? 0) >= 1,
      JSON.stringify(healthOf(store.ORCHESTRATOR)));
    at(STEPS[2], Date.now() - t3);

    // --- шаг 4: answer оркестратора --------------------------------------------------
    const t4 = Date.now();
    const box = await mcp.tool('promptobus_mailbox');
    check('шаг 4: mailbox оркестратора настоящим инструментом отдал сообщение worker\'а',
      box.isError === false && box.text.includes(MARK.status), tail(box.text));
    const sent = await mcp.tool('promptobus_send', { to: WORKER, type: 'answer', body: `${MARK.answer}: правь только ${NOTE_FILE}` });
    check('шаг 4: answer оркестратора ушёл worker\'у',
      sent.isError === false && !!msgOf(WORKER, MARK.answer), `${tail(sent.text)} · ${JSON.stringify(inboxOf(WORKER))}`);
    const guarded = orchGuard();
    check('шаг 4: сторож цикла отпустил ход оркестратора и отметил его конец',
      guarded.status === 0 && !!store.lastTurnAt(home, TASK, store.ORCHESTRATOR),
      `код ${guarded.status}: ${tail(`${guarded.stdout}${guarded.stderr}`)}`);
    // : идентичность шины лежит теперь и в окружении САМОЙ сессии участника, поэтому
    // Stop-хук сторожа цикла резолвит его адрес и ставит отметку конца хода — прежде её
    // получал только оркестратор. Занятость участника при этом по-прежнему берётся из снимка
    // сессий: у него есть session reference, и `sessionBusy` выбирает ветку по РОДУ участника,
    // а не по наличию отметки.
    //
    // Вердикт идёт там, где сторож цикла зовёт САМ участник, и это про способ, а не про
    // механизм: подставной `claude` зовёт `promptobus guard` из хода
    // ([participant.mjs](participant.mjs)), участник Cursor — хуком `stop` своего проектного
    // `.cursor/hooks.json`, и оба проверяют ровно то, за что механизм отвечает: что
    // идентичности хуку хватает. Живому Claude хук приезжает файлом `--settings`,
    // но канарейкой это ещё не прогонялось, а у Codex хуков нет вовсе — и красным на
    // непроверенном и на несуществующем сценарий не идёт
    // ([10], граница покрытия).
    if (wh.guard) {
      const workerTurn = await waitFor(() => store.lastTurnAt(home, TASK, WORKER), { timeoutMs: step });
      check('шаг 4: сторож цикла отметил конец хода и у worker\'а — идентичности шины ему хватает',
        workerTurn !== null, `${workerTurn} · ${wh.diagnose()}`);
    }
    at(STEPS[3], Date.now() - t4);

    // --- шаг 5: стук и первый result --------------------------------------------------
    const t5 = Date.now();
    // Признак удавшегося стука — канал и отметка «докуда отстучали»: счётчик стуков
    // забранный mailbox обнуляет вместе с остальными отметками ожидания, и по нему судить
    // о стуке можно только до забора, то есть в гонке с самим участником.
    //
    // Сверяется ФАКТ доставки, а не ИМЯ канала в health. Имя там — слово механизма об
    // удавшейся активации, и оно принадлежит не сценарию: надзиратель пишет его на любом
    // driver'е, который будит сам (`supervisor.ts`, ветка `r?.ok`), а у составов за ним
    // разные транспорты — инъекция в TUI у Cursor, RPC держателя у Codex. Пара «отметка
    // `knockedTo` есть, ошибки стука нет» держит вердикт одинаково сильным на всех: сорванный
    // стук пишет причину в `knockError` и уводит участника на самобудку, а driver без стука
    // отметки не оставляет вовсе.
    const knocked = await waitFor(() => {
      const h = healthOf(WORKER);
      return h.knockedTo && !h.knockError ? h : null;
    }, { timeoutMs: step });
    check('шаг 5: надзиратель достучался до worker\'а его каналом и запомнил, докуда отстучал',
      !!knocked?.knockedTo && !knocked?.knockError,
      JSON.stringify(healthOf(WORKER)));
    const result1 = await waitFor(() => msgOf(store.ORCHESTRATOR, MARK.result1), { timeoutMs: step });
    check('шаг 5: worker забрал mailbox по стуку и прислал первый result',
      sentBy(result1, WORKER) && result1?.type === 'result'
      && inboxOf(WORKER).length === 0, `${JSON.stringify(result1)} · ${wh.diagnose()}`);
    check('шаг 5: правка worker\'а закоммичена в его ветке — уборке будет что сверять',
      out(git(wf.worktree, 'status', '--porcelain')) === '' && existsSync(path.join(wf.worktree, NOTE_FILE)),
      `${out(git(wf.worktree, 'status', '--porcelain'))} · ${out(git(wf.worktree, 'log', '--oneline', '-3'))}`);
    at(STEPS[4], Date.now() - t5);

    // --- шаг 6: ревью ------------------------------------------------------------------
    const t6 = Date.now();
    await mcp.tool('promptobus_mailbox');
    orchGuard();
    const reviewed = cli([ 'review', wf.worktree, '--task', TASK, ...rh.flags],
      { cwd: ws, env: orchEnv });
    check('шаг 6: promptobus review поднял reviewer\'а по worktree worker\'а',
      reviewed.status === 0 && /reviewer reviewer:e2e поднят/.test(reviewed.out), tail(reviewed.out));
    const rp = participantOf(REVIEWER);
    check('шаг 6: запись reviewer\'а легла тем же registry — harness, режим и живая сессия',
      rp?.harness === rh.id && rp?.mode === 'managed'
      && rh.liveSessions([rp?.sessionRef]).length === 1, `${JSON.stringify(rp)} · ${rh.diagnose()}`);
    // Тело отчёта reviewer'а сверять нечем, и это не послабление: `promptobus review` не принимает
    // брифа вовсе — промпт reviewer'у собирает сама команда, и она же велит ему отчитаться
    // `type=result` оркестратору. У живого harness'а поэтому свой текст, а проверяемое
    // свойство — что отчёт пришёл от адреса reviewer'а и тем типом, который назначил механизм.
    const review = await waitFor(() => inboxOf(store.ORCHESTRATOR)
      .find((m) => sentBy(m, REVIEWER) && m.type === 'result') ?? null, { timeoutMs: step });
    check('шаг 6: reviewer прислал замечания оркестратору',
      sentBy(review, REVIEWER) && review?.type === 'result',
      `${JSON.stringify(review)} · ${rh.diagnose()}`);
    at(STEPS[5], Date.now() - t6);

    // --- шаг 7: замечания worker'у и второй result --------------------------------------
    const t7 = Date.now();
    await mcp.tool('promptobus_mailbox');
    const order = await mcp.tool('promptobus_send', { to: WORKER, type: 'review', body: `${MARK.order}: замечание reviewer'а — закрой его` });
    check('шаг 7: замечания ушли worker\'у сообщением типа review',
      order.isError === false && msgOf(WORKER, MARK.order)?.type === 'review', tail(order.text));
    orchGuard();
    const result2 = await waitFor(() => msgOf(store.ORCHESTRATOR, MARK.result2), { timeoutMs: step });
    check('шаг 7: worker закрыл замечание и прислал второй result',
      sentBy(result2, WORKER) && result2?.type === 'result',
      `${JSON.stringify(result2)} · ${wh.diagnose()}`);
    // Сверяем ПРЕДИКАТОМ, а не пустотой `stalls.json`: отметку доложенного пишет только круг
    // доклада на ударе сердца, а к этому шагу удара ещё не было — пустой файл значил бы
    // «ходов никто не оценивал», и вердикт проходил бы при любой поломке (замечание ревью).
    //
    // Ход при этом кончается не отправкой: следом идут запись `state.json`, отдельный процесс
    // сторожа и только потом отметка «свободна». Пока сессия `busy`, разбор стопа отдаёт
    // `null`, и зелёный вердикт значил бы не «гейт молчания отработал», а «разбор до него не
    // дошёл» — та же гонка с другой стороны. Поэтому отданный ход ждётся явно, а его признак
    // уезжает в деталь вердикта: зелёный без него неаудируем.
    const ref = wp?.sessionRef;
    const idleAfterSend = await waitFor(() => wh.idle(ref) || null, { timeoutMs: step });
    // Снимок берётся у harness'а и подаётся driver'у ЯВНО. Умолчание разбора собрало бы его
    // через кэш реестра сессий: под набором это первый вызов в процессе и снимок свежий
    // случайно, а в живом прогоне кэш к этому шагу заполнен — одна строка сценария
    // проверяла бы у двух harness'ей разное, против обещания «различаются harness'ы, а не
    // проверки».
    const viewAfterSend = wh.inspect(ref);
    // Предикат зовётся напрямую, а не через разбор участников: у того сверх молчания есть
    // ещё окно регистрации (`justSpawned`), и в быстром сценарии участник внутри него —
    // пустой список снова оказался бы зелёным не по той причине.
    const stands = stallStands(home, TASK, participantOf(WORKER), viewAfterSend?.stall);
    check('шаг 7: участник, закончивший ход ПОСЛЕ отправки, стопом не считается',
      idleAfterSend === true && viewAfterSend?.stall?.kind === 'unknown' && stands === false,
      `ход отдан: ${idleAfterSend} · снимок ${JSON.stringify(viewAfterSend)} · предикат ${stands}`);

    // --- два участника одной задачи: каждый при своём --------------------------
    //
    // К этому месту ход закончили оба — и worker, и reviewer, — а значит оба сдали contact
    // point и оба звали Stop-хук. Проверяется то, чего до  не было: что второй не
    // занял место первого. Окружение фоновой сессии harness выдаёт от ПЕРВОГО spawn'а run'а
    // (модель демона в [harness.mjs](harness.mjs)), поэтому идентичность хука едет
    // аргументами его команды, а адрес, закреплённый в журнале за другой сессией, чужая
    // запись не двигает вовсе.
    const heldBy = (addr) => store.readWake(home, TASK, addr)?.session ?? null;
    // Спрашивается ТЕМ ЖЕ правилом, каким судит механизм (`foreignSessionOf`), а не своей
    // сверкой: собственная считала бы по короткому id, то есть запасным правилом, и регресс
    // полного `sessionId` в записи участника не покрасила бы вовсе (замечание ревью).
    const foreign = (addr) => store.foreignSessionOf(participantOf(addr), heldBy(addr));
    const own = await waitFor(() => (heldBy(WORKER) !== null && heldBy(REVIEWER) !== null
      && foreign(WORKER) === null && foreign(REVIEWER) === null) || null, { timeoutMs: step });
    check('шаг 7: contact point worker\'а и reviewer\'а держит каждый своя сессия',
      own === true,
      `worker: ${heldBy(WORKER)} против ${JSON.stringify(participantOf(WORKER)?.metadata ?? null)}`
      + ` · reviewer: ${heldBy(REVIEWER)} против ${JSON.stringify(participantOf(REVIEWER)?.metadata ?? null)}`);
    // Отметку конца хода ставит сторож, и звать его должен САМ участник
    // ([10], граница покрытия) — поэтому вердикт под
    // тем же гейтом, что и соседний вердикт , и под ним ОБА: предмет здесь — что
    // второй не занял место первого, и один размеченный участник о паре не говорит ничего.
    // Он и есть мишень главной мутационной пробы: верни в `guard` окружение первым
    // источником — хук reviewer'а отметит адрес worker'а, а свой останется без отметки.
    if (wh.guard && rh.guard) {
      const marked = await waitFor(() => (store.lastTurnAt(home, TASK, WORKER) !== null
        && store.lastTurnAt(home, TASK, REVIEWER) !== null) || null, { timeoutMs: step });
      check('шаг 7: сторож каждого участника отметил конец хода по СВОЕМУ адресу',
        marked === true,
        `worker ${store.lastTurnAt(home, TASK, WORKER)} · reviewer ${store.lastTurnAt(home, TASK, REVIEWER)}`
        + ` · ${rh.diagnose()}`);
    }
    at(STEPS[6], Date.now() - t7);

    // --- второй round ревью: тот же reviewer, новый дифф ------------------------
    //
    // Round идёт там, где его заказал вызывающий: у прогонов с одним round'ом этих вердиктов
    // нет вовсе, и их число не двигается. Предмет — обещание команды: повторный вызов
    // `promptobus review` НЕ поднимает второй сессии, а шлёт новый дифф уже поднятому
    // адресу ([08]).
    //
    // Новой правки для этого не нужно: дифф считается против базы, а не против прошлого
    // диффа, и правка worker'а с шага 5 в нём по-прежнему лежит. Второй файл диффа команда
    // заводит сама (`review-<слаг>-2.diff`).
    if (reviewRounds >= 2) {
      const t7b = Date.now();
      await mcp.tool('promptobus_mailbox');
      orchGuard();
      const again = cli([ 'review', wf.worktree, '--task', TASK, ...rh.flags],
        { cwd: ws, env: orchEnv });
      // Тождество сессии сверяется её ССЫЛКОЙ, а не счётом участников: адрес reviewer'а один
      // на задачу, и повторный подъём переписал бы запись, оставив список той же длины.
      const same = participantOf(REVIEWER);
      check('второй round: дифф ушёл ТОМУ ЖЕ reviewer\'у — второй сессии не появилось',
        again.status === 0 && /уже на шине/.test(again.out)
        && !!same?.sessionRef && same.sessionRef === rp?.sessionRef,
        `код ${again.status} · сессия была ${rp?.sessionRef}, стала ${same?.sessionRef} · ${tail(again.out)}`);
      const review2 = await waitFor(() => msgOf(store.ORCHESTRATOR, MARK.review2), { timeoutMs: step });
      check('второй round: reviewer разобрал новый дифф и прислал result',
        sentBy(review2, REVIEWER) && review2?.type === 'result',
        `${JSON.stringify(review2)} · ${rh.diagnose()}`);
      at(REVIEW_ROUND_STEP, Date.now() - t7b);
    }

    // --- шаг 8: молчаливый конец хода ----------------------------------------------------
    //
    // Шаг идёт у harness'а, чей driver называет причину конца хода строкой самой сессии:
    // последний вердикт сверяет отметку доложенного (`stalls.json`) с этой строкой, и
    // без неё сверять доклад нечем (см. способность `stalls` у `participantHarness`).
    if (wh.stalls) {
      const t8 = Date.now();
      await mcp.tool('promptobus_mailbox');
      // Ждём НОВОЙ отметки доставки, а не просто непустой: `deliveredAt` стоит там с прошлого
      // хода, и условие «mailbox пуст и отметка есть» выполнено ещё до того, как участник
      // увидел этот приказ. Сверять молчание по старой отметке значило бы сверять прошлый ход.
      //
      // Засечка берётся ДО отправки, а не после сторожа. Отметку кладёт круг надзирателя,
      // увидевший mailbox уже забранным, и весь путь «стук → забор → круг» умещается в
      // полторы секунды, а `orchGuard` — это запуск процесса: на загруженной машине он
      // возвращается ПОЗЖЕ круга, и засечка после него оказывается новее отметки, которой
      // ждём. Тогда ожидание выбирает потолок по построению — новой отметки уже не будет, —
      // и красный вердикт говорит о своей засечке, а не о молчании участника. Живой случай
      // 2026-09-02: при load average 87 так падал каждый прогон, при обычной
      // нагрузке — ни один.
      const quietAt = Date.now();
      await mcp.tool('promptobus_send', { to: WORKER, type: 'answer', body: `${MARK.quiet}: ничего не отправляй, просто закончи ход` });
      orchGuard();
      const quiet = await waitFor(() => {
        const h = healthOf(WORKER);
        return h.unread === 0 && Date.parse(h.deliveredAt ?? '') > quietAt ? h : null;
      }, { timeoutMs: step });
      // Молчание считается тем же, чем его считает механизм: последняя отправка участника
      // старше его последней активации (`stallStands`). Проверять «сообщения с таким-то
      // маркером нет» было бы слабее — участник, ответивший ЛЮБЫМ текстом, прошёл бы такую
      // проверку и утащил бы за собой красный доклад, ничего не объяснив.
      const lastSent = store.lastSentAt(home, TASK, WORKER);
      const spoke = lastSent !== null && lastSent > Date.parse(quiet?.deliveredAt ?? '');
      check('шаг 8: worker забрал mailbox и закончил ход, не отправив ничего',
        !!quiet?.deliveredAt && !spoke,
        `${JSON.stringify(quiet)} · последняя отправка ${lastSent ? new Date(lastSent).toISOString() : 'нет'}`
        + ` · ${wh.diagnose()}`);
      // Второй канал разбора стопа — ответ `mailbox` оркестратора: он считается на месте, а не
      // ударом сердца, и потому проверяется раньше доклада.
      const seenByMailbox = await waitFor(async () => {
        const answer = await mcp.tool('promptobus_mailbox');
        return answer.text.includes(WORKER) && /встал|ЧИСЛИТСЯ|ИСЧЕЗ/.test(answer.text) ? answer.text : null;
      }, { timeoutMs: step, stepMs: 500 });
      check('шаг 8: ответ mailbox оркестратора называет вставшего worker\'а тем же разбором',
        typeof seenByMailbox === 'string', `${tail(String(seenByMailbox))} · ${wh.diagnose()}`);
      const reported = await waitFor(() => {
        const line = store.tailWardenLog(home, TASK, 40).find((l) => l.includes(WORKER) && /встал:|ИСЧЕЗ|ЧИСЛИТСЯ|ГЛУХ/.test(l));
        return line ?? null;
      }, { timeoutMs: stall, stepMs: 500 });
      const stallPostcard = inbox.seen.find((p) => /встали участники/.test(String(p.body ?? '')));
      check('шаг 8: надзиратель записал стоп в журнал — postcard о стопе не шлёт',
        typeof reported === 'string' && reported.includes(WORKER) && !stallPostcard,
        `${reported} · ${JSON.stringify(inbox.seen.map((p) => String(p.body).slice(0, 60)))} · ${wh.diagnose()}`);
      // Отметка доложенного сверяется не фактом своего существования, а ПРИЧИНОЙ: она обязана
      // принадлежать молчаливому ходу — той самой строке, которую сессия написала о себе в
      // `jobs/<id>/state.json` последним ходом. Доклад о ходе, законченном отправкой, имел бы
      // там причину предыдущего хода, и «на ходах после отправки доклада не было» становится
      // следствием этой сверки, а не отдельным обещанием.
      const marks = readStalls(home, TASK) ?? {};
      const said = sessionDetail(fieldsOf(WORKER).session);
      check('шаг 8: окно регистрации доклад не заглушило — участник уже выходил на шину',
        store.lastSentAt(home, TASK, WORKER) !== null && !!reported,
        `последняя отправка ${new Date(store.lastSentAt(home, TASK, WORKER) ?? 0).toISOString()}`
        + ` · доклад ${reported ? 'есть' : 'нет'}`);
      check('шаг 8: доклад отмечен в stalls.json причиной молчаливого хода — второй раз он не пойдёт',
        Object.keys(marks).join(',') === WORKER
        && !!said && String(marks[WORKER]?.reason ?? '').endsWith(`|${said}`),
        `${JSON.stringify(marks)} · detail сессии: ${said}`);
      at(STEPS[7], Date.now() - t8);
    }

    // --- шаги 9 и 10: стоп участника, permission и limit ---------------------------------
    //
    // Обе ветки разбора стопа (`sessionStall`) до  жили только на юнитах с фикстурами:
    // в E2E их не играл никто, а живой сессии ни permission-запрос, ни лимит по команде не
    // устроить. Поэтому шаги идут ТОЛЬКО у harness'а, который такой ход играет: поле `block`
    // понимает подставной `claude`, и он метит запись сессии так же, как её метит настоящий.
    //
    // Вердикт снимается с ответа `promptobus_mailbox` оркестратора, а не с postcard'а
    // надзирателя: строка о вставшем одна на все каналы (`stallLine`/`stallRoute`), но ответ
    // `mailbox` считается на месте, а доклад пришёл бы ударом сердца — по 30 с на шаг.
    if (wh.blocks) {
      // Один помощник на оба шага: разбудить участника, дождаться его стопа в снимке и
      // прочитать маршрут в ответе `mailbox`. Разница между шагами — только в том, чем
      // участник встал и что механизм обязан об этом сказать.
      const stallStep = async (mark, order, want) => {
        await mcp.tool('promptobus_mailbox');
        await mcp.tool('promptobus_send', { to: WORKER, type: 'answer', body: `${mark}: ${order}` });
        orchGuard();
        // Снимок берётся у harness'а и подаётся driver'у явно — тем же швом, что на шаге 7:
        // умолчание собрало бы его через кэш реестра сессий, и один и тот же вызов проверял
        // бы у двух harness'ей разное.
        const view = await waitFor(() => {
          const v = wh.inspect(participantOf(WORKER)?.sessionRef);
          return v?.stall?.kind === want.kind ? v : null;
        }, { timeoutMs: step });
        // Маршрут ищется в ответе `mailbox` повторными вызовами: участник встаёт в конце
        // своего хода, и первый ответ законно приходит раньше, чем он встал.
        const said = await waitFor(async () => {
          const answer = await mcp.tool('promptobus_mailbox');
          return want.route.test(answer.text) ? answer.text : null;
        }, { timeoutMs: step, stepMs: 500 });
        return { view, said };
      };

      const t9 = Date.now();
      const perm = await stallStep(MARK.perm, 'встань на диалоге разрешения', {
        kind: 'permission', route: /ответить может только человек: claude attach/,
      });
      check('шаг 9: стоп участника на диалоге разрешения разобран как permission — причиной служит метка диалога',
        perm.view?.stall?.kind === 'permission' && perm.view.stall.reason === 'permission prompt',
        `${JSON.stringify(perm.view)} · ${wh.diagnose()}`);
      check('шаг 9: маршрут доклада ведёт к человеку — ответить может только он, claude attach',
        typeof perm.said === 'string' && perm.said.includes(WORKER)
        && /ответить может только человек: claude attach/.test(perm.said),
        `${tail(String(perm.said))} · ${wh.diagnose()}`);
      at(STEPS[8], Date.now() - t9);

      const t10 = Date.now();
      const limit = await stallStep(MARK.limit, 'упрись в лимит', {
        kind: 'limit', route: /лимит сбросится сам/,
      });
      // Причина лимита читается из `jobs/<id>/state.json` — второй половины снимка: список
      // сессий её не несёт вовсе, `waitingFor` есть только у стоящей на диалоге.
      check('шаг 10: стоп участника на исчерпанном лимите разобран как limit — причина из state.json',
        limit.view?.stall?.kind === 'limit' && /hit your usage limit/.test(limit.view.stall.reason ?? ''),
        `${JSON.stringify(limit.view)} · detail сессии: ${sessionDetail(fieldsOf(WORKER).session)}`);
      check('шаг 10: маршрут лимита человека не зовёт — лимит сбросится сам, будить сообщением',
        typeof limit.said === 'string' && limit.said.includes(WORKER)
        && /лимит сбросится сам/.test(limit.said) && !/claude attach/.test(limit.said),
        `${tail(String(limit.said))} · ${wh.diagnose()}`);
      at(STEPS[9], Date.now() - t10);
    }

    // --- шаг 11: раздача двум участникам и дедупликация артефакта ---------------------------
    // Настоящего fan-out'а (одно каноническое сообщение нескольким) поверхность не открывает:
    // adapter обрезает получателя до одного, схема инструмента объявляет `to` строкой, команды
    // «послать нескольким» нет вовсе — n>1 живёт только в engine и проверяется набором самого
    // package. Здесь проверяется то, что поверхность открывает: два независимых сообщения с
    // ОДНОГО хода оркестратора, оба дошли, обоих разбудили, третьему не легло, — и инвариант
    // раскладки, общий у любого числа получателей: канон и ссылка в mailbox'е один inode.
    const t11 = Date.now();
    await mcp.tool('promptobus_mailbox');
    const artifact = path.join(sandbox, 'artifact.md');
    writeFileSync(artifact, `# ${MARK.fan}\n\nОдин и тот же файл уходит дважды.\n`);
    // Отметка «докуда отстучали» снимается ДО отправки у ОБОИХ. Забор mailbox'а её не
    // сбрасывает: ветка доставки надзирателя переписывает отметку по полям и `knockedTo`
    // переносит из прошлого состояния (`supervisor.ts`, ветка `if (!unread)`). У worker'а он
    // стоит со стука шага 5, и условие «отметка есть» было бы зелено ещё до этой отправки —
    // то есть и при не сработавшем стуке вовсе (проверено мутационной пробой :
    // отправка одному только reviewer'у прежнюю форму вердикта не красила). Настоящий
    // признак свежего стука — СМЕНА отметки: `knockedTo` несёт id последнего сообщения, о
    // котором стучали.
    const knockedWas = Object.fromEntries([WORKER, REVIEWER].map((a) => [a, healthOf(a).knockedTo ?? null]));
    const fanned = [];
    for (const addr of [WORKER, REVIEWER]) {
      // eslint-disable-next-line no-await-in-loop
      const r = await mcp.tool('promptobus_send', {
        to: addr, type: 'artifact', body: `${MARK.fan}: тот же файл обоим`, artifactPath: artifact,
      });
      fanned.push({ addr, ok: r.isError === false, text: r.text });
    }
    check('шаг 11: оба сообщения ушли с одного хода оркестратора',
      fanned.every((f) => f.ok), JSON.stringify(fanned.map((f) => [f.addr, tail(f.text, 120)])));
    // Ссылку ищем в inbox'е И в history: участник вправе забрать mailbox прямо сейчас, и
    // проверка только по inbox'у краснела бы от скорости чужого хода, а не от поломки. Ровно
    // по этой паре мест судит и восстановление fan-out'а ([14]).
    // Ссылка ищется по ТЕЛУ, а не по числу: у обоих участников к этому шагу уже лежат ссылки
    // прошлых шагов, и «их больше нуля» было бы правдой и без единой доставки этого шага —
    // найдено мутационной пробой , отправкой одному только reviewer'у.
    const landedFan = (addr) => linkedNames(home, TASK, addr)
      .filter((n) => messageBody(home, TASK, addr, n).includes(MARK.fan));
    const delivered = await waitFor(() => ([WORKER, REVIEWER].every((a) => landedFan(a).length === 1)
      ? [WORKER, REVIEWER].map((a) => landedFan(a).length) : null), { timeoutMs: step });
    check('шаг 11: ссылка легла обоим получателям и не легла отправителю',
      Array.isArray(delivered) && landedFan(store.ORCHESTRATOR).length === 0,
      `${JSON.stringify(delivered)} · у оркестратора ${JSON.stringify(landedFan(store.ORCHESTRATOR))}`
      + ` · у получателей ${JSON.stringify([WORKER, REVIEWER].map((a) => landedFan(a).length))}`);
    // Канон и ссылка — один и тот же inode: на этом стоит и атомарность раскладки, и её
    // восстановимость. Свойство не зависит от числа получателей, и проверяется оно на том
    // дереве, которым прогон идёт, а не на исходниках package.
    const oneInode = [WORKER, REVIEWER].map((addr) => {
      const name = landedFan(addr)[0];
      if (!name) return `${addr}: ссылки нет`;
      const canon = path.join(store.taskDir(home, TASK), 'messages', name);
      const link = linkPath(home, TASK, addr, name);
      if (!existsSync(canon) || !link) return `${addr}: ${canon} / ${link}`;
      return statSync(canon).ino === statSync(link).ino ? null : `${addr}: inode разные`;
    }).filter(Boolean);
    check('шаг 11: канон сообщения и ссылка получателя — один inode',
      oneInode.length === 0, oneInode.join('; '));
    // Один и тот же файл ушёл дважды: содержимое дедуплицировано (один blob), а имён и
    // metadata-записей две — имя живёт отдельно от содержимого ([14]).
    const blobs = listDir(path.join(store.taskDir(home, TASK), 'blobs'));
    const metas = listDir(path.join(store.taskDir(home, TASK), 'artifacts'));
    // Имена берём СВОИ, а не весь каталог: рядом лежит дифф, который `promptobus review` кладёт
    // туда напрямую, без blob'а и без metadata-записи, — и счёт по всему каталогу считал бы
    // чужой файл своим.
    const named = listDir(store.filesDir(home, TASK)).filter((n) => /^artifact(-\d+)?\.md$/.test(n));
    const blobOfOurs = path.join(store.taskDir(home, TASK), 'blobs', blobs[0] ?? 'нет');
    check('шаг 11: тот же артефакт дважды — один blob, две metadata-записи, два имени',
      blobs.length === 1 && metas.length === 2 && named.length === 2,
      `blobs ${blobs.length} · artifacts ${metas.length} · имена ${JSON.stringify(named)}`);
    check('шаг 11: оба имени артефакта — ссылки на тот же blob, а не копии',
      blobs.length === 1 && named.length === 2 && named.every((n) => statSync(path.join(store.filesDir(home, TASK), n)).ino
        === statSync(blobOfOurs).ino),
      `${JSON.stringify(named)} · blob ${blobs[0] ?? 'нет'}`);
    // Разбужены оба: круг надзирателя стучит по каждому получателю отдельно, и отказ
    // активации одного не отменяет доставку другому. Сверяется СМЕНА отметки против снимка
    // выше — на неподвижной отметке вердикт был бы зелен и без единого стука.
    const knockedBoth = await waitFor(() => ([WORKER, REVIEWER].every((a) => {
      const now = healthOf(a).knockedTo ?? null;
      return !!now && now !== knockedWas[a];
    }) ? true : null), { timeoutMs: step });
    check('шаг 11: надзиратель отстучал обоим получателям по новому сообщению',
      knockedBoth === true,
      `было ${JSON.stringify(knockedWas)} · стало `
      + JSON.stringify(Object.fromEntries([WORKER, REVIEWER].map((a) => [a, healthOf(a).knockedTo ?? null]))));
    at(STEPS[10], Date.now() - t11);

    // --- шаг 12: history, status и захват mailbox'а ----------------------------------------
    const t12 = Date.now();
    // «Ничего не сделал прочитанным» судится по mailbox'у ОРКЕСТРАТОРА и ВКЛЮЧЕНИЕМ имён, а
    // не счётчиками всех троих. Двух причин довольно. Чужие mailbox'ы: участников только что
    // разбудили шагом 11, живая сессия забирает их ровно в этом окне, и равенство счётчиков
    // краснело бы от скорости чужого хода — тот же ложный красный, что снят в шаге 8.
    // Равенство ЧИСЛА не годится и у своего: живой участник вправе прислать оркестратору ещё
    // одно сообщение между двумя снимками, и mailbox законно вырастет. Под вопросом здесь
    // ровно одно — не унесла ли команда уже лежавшее.
    const boxBefore = listDir(store.inboxDir(home, TASK, store.ORCHESTRATOR));
    const hist = cli([ 'history', '--task', TASK, '--all'], { cwd: ws, env: orchEnv });
    const boxAfter = listDir(store.inboxDir(home, TASK, store.ORCHESTRATOR));
    const lost = boxBefore.filter((n) => !boxAfter.includes(n));
    check('шаг 12: history показал прочитанную переписку задачи и ничего не сделал прочитанным',
      hist.status === 0 && hist.out.includes(MARK.status) && hist.out.includes(MARK.result1)
      && lost.length === 0,
      `код ${hist.status} · унесено из mailbox'а оркестратора ${JSON.stringify(lost)}`
      + ` · было ${boxBefore.length}, стало ${boxAfter.length} · ${tail(hist.out)}`);
    const stat = cli([ 'status', '--task', TASK], { cwd: ws, env: orchEnv });
    check('шаг 12: status назвал задачу, живого надзирателя и обоих участников',
      stat.status === 0 && stat.out.includes(TASK) && stat.out.includes(WORKER)
      && stat.out.includes(REVIEWER) && /надзиратель/.test(stat.out), tail(stat.out));
    // Захват: чужая сессия видит КОПИЮ и шапку, оригиналы остаются владельцу; захват называет
    // прежнего владельца и переписывает owner'а задачи. Молчаливого перехвата не бывает.
    const heirSession = `${ORCH_SESSION}-heir`;
    const heir = startMcp({ ...orchEnv, CLAUDE_CODE_SESSION_ID: heirSession }, ws);
    let takeover = null;
    try {
      await heir.call('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'promptobus-e2e-heir', version: '1' },
      });
      const peek = await heir.tool('promptobus_mailbox', { task: TASK });
      check('шаг 12: чужой сессии mailbox оркестратора отдан с шапкой, а владелец не сменился',
        peek.text.includes(store.FOREIGN_MARK) && store.taskOwner(home, TASK) === ORCH_SESSION,
        `${tail(peek.text, 200)} · владелец ${store.taskOwner(home, TASK)}`);
      takeover = await heir.tool('promptobus_mailbox', { task: TASK, claim: true });
      check('шаг 12: захват назвал прежнего владельца и переписал owner\'а задачи',
        takeover.text.includes(store.MAILBOX_CLAIMED_MARK) && takeover.text.includes(ORCH_SESSION)
        && store.taskOwner(home, TASK) === heirSession,
        `${tail(takeover.text, 200)} · владелец ${store.taskOwner(home, TASK)}`);
    } finally {
      heir.stop();
    }
    // Возврат владения — не уборка за собой, а вторая половина проверки: захват обратим тем же
    // ходом, и `promptobus done` ниже идёт от владельца, как ему и положено.
    const back = await mcp.tool('promptobus_mailbox', { claim: true });
    check('шаг 12: владелец забрал mailbox назад — захват обратим',
      back.isError === false && store.taskOwner(home, TASK) === ORCH_SESSION,
      `${tail(back.text, 200)} · владелец ${store.taskOwner(home, TASK)}`);
    at(STEPS[11], Date.now() - t12);

    // --- шаг 13: done ---------------------------------------------------------------------
    const t13 = Date.now();
    // Работу принял оркестратор: ветку worker'а он вливает в default-ветку клона — до этого
    // уборка каталог законно не тронет, и «слитые worktree метутся» проверять было бы не на чем.
    git(repoAbs, 'merge', '--no-ff', '-q', '-m', ': работа worker\'а принята', wf.branch);
    const refs = [wp?.sessionRef, rp?.sessionRef].filter(Boolean);
    // Номера процессов снимаются ДО закрытия: после удавшегося `stop` записи сессий исчезают,
    // и вердикт «процессов не осталось», выведенный из реестра, был бы зелёным по построению —
    // сломанное гашение осталось бы невидимым (замечание ревью). Длина проверяется вместе с
    // живостью: пустой список pid'ов дал бы ту же холостую зелень с другой стороны.
    //
    // Спрашивается КАЖДЫЙ у своего harness'а, и живость тоже: реестры у составов разные, и
    // один список на двоих отдал бы половину пустой — то есть проверял бы гашение одного
    // участника, называясь проверкой обоих.
    const procs = [[wh, wp?.sessionRef], [rh, rp?.sessionRef]]
      .filter(([, ref]) => !!ref)
      .flatMap(([h, ref]) => h.pidsOf([ref]).map((pid) => ({ h, pid })));
    const pids = procs.map((p) => p.pid);
    const aliveNow = () => procs.filter(({ h, pid }) => h.pidAlive(pid)).map((p) => p.pid);
    // Секреты задачи пересчитываются ДО закрытия: после уборки их нет по построению, и
    // проверка «убрано» без этого снимка прошла бы и на стенде, где их не заводили вовсе.
    // Ждём ровно то, что этот состав заводит: contact point есть у каждого участника, а
    // mcp-config файлом по пути store — только у harness'а, который читает его оттуда.
    const secretsWant = 2 + (wh.files ? 1 : 0) + (rh.files ? 1 : 0);
    const secretsBefore = [[WORKER, wh], [REVIEWER, rh]]
      .flatMap(([a, h]) => [store.wakeFile(home, TASK, a), ...(h.files ? [store.participantMcpPath(home, TASK, a)] : [])])
      .filter((f) => existsSync(f));
    const done = cli([ 'done', '--task', TASK], { cwd: ws, env: orchEnv });
    check('шаг 13: promptobus done закрыл задачу и назвал сессии, которые гасит',
      done.status === 0 && /гашу сессии участников \(2\)/.test(done.out) && /worker:e2e/.test(done.out),
      tail(done.out));
    // С коротким ожиданием — гонка та же, что у близнеца в юните harness'а: смерти процесса
    // подставной `claude stop` дожидается сам, но не дольше своего потолка, а живой не
    // обещает и этого (замечание ревью).
    const dead = await waitFor(() => aliveNow().length === 0 || null, { timeoutMs: step });
    check('шаг 13: процессов участников не осталось — ни одного',
      pids.length === refs.length && pids.length > 0 && dead === true,
      `pid'ы до гашения ${JSON.stringify(pids)} · живы ${JSON.stringify(aliveNow())}`);
    check('шаг 13: слитый worktree убран вместе со своей веткой',
      !existsSync(wf.worktree) && !out(git(repoAbs, 'branch', '--list', wf.branch)),
      `${wf.worktree}: ${existsSync(wf.worktree)} · ветка: ${out(git(repoAbs, 'branch', '--list', wf.branch))}`);
    check('шаг 13: секреты задачи убраны — ни contact point\'ов, ни mcp-конфигов',
      secretsBefore.length === secretsWant
      && !secretsBefore.some((f) => existsSync(f))
      && !existsSync(store.wakeFile(home, TASK, store.ORCHESTRATOR)),
      `было ${JSON.stringify(secretsBefore)} · осталось ${JSON.stringify(secretsBefore.filter((f) => existsSync(f)))}`);
    at(STEPS[12], Date.now() - t13);

    // --- шаг 14: prune и выход надзирателя --------------------------------------------------
    const t14 = Date.now();
    const gone = await waitFor(() => (store.liveWarden(home, TASK) ? null : true), { timeoutMs: step });
    check('шаг 14: надзиратель вышел сам — задача закрыта, стеречь нечего',
      gone === true && /надзиратель.*вышел/.test(store.tailWardenLog(home, TASK, 200).join('\n')),
      store.tailWardenLog(home, TASK, 20).join('\n'));
    const probe = cli([ 'prune', '--older-than', '0'], { cwd: ws, env: orchEnv });
    check('шаг 14: prune пробой называет закрытую задачу и ничего не удаляет',
      probe.status === 0 && probe.out.includes(TASK) && /Ничего не удалено/.test(probe.out)
      && existsSync(store.taskDir(home, TASK)), tail(probe.out));
    const pruned = cli([ 'prune', '--older-than', '0', '--yes'], { cwd: ws, env: orchEnv });
    check('шаг 14: prune --yes снёс журнал закрытой задачи',
      pruned.status === 0 && !existsSync(store.taskDir(home, TASK)), tail(pruned.out));
    check('шаг 14: сервер шины не писал в канал протокола ничего постороннего',
      mcp.strays.length === 0, JSON.stringify(mcp.strays.slice(0, 3)));
    at(STEPS[13], Date.now() - t14);
  } finally {
    mcp.stop();
    await inbox.close();
    try { process.kill(warden.pid, 'SIGTERM'); } catch { /* уже вышел */ }
    harness.cleanup();
  }
  return { timings, totalMs: Date.now() - t0, postcards: inbox.seen, mechanism: { declared: PROMPTOBUS_BIN, reported: selfBin } };
}

function out(r) {
  return String(r?.stdout ?? '').trim();
}

/** Содержимое каталога, которого может не быть вовсе: каталоги задачи заводятся лениво. */
function listDir(dir) {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

/**
 * Имена ссылок адреса — в mailbox'е И в прочитанном. Два места, а не одно: ссылки могло не
 * быть в inbox'е по двум причинам — её не успели создать либо её уже прочитали, — и ровно по
 * этой паре судит восстановление fan-out'а. Проверка по одному inbox'у краснела бы от
 * скорости чужого хода, а не от поломки.
 */
function linkedNames(home, task, addr) {
  return [...listDir(store.inboxDir(home, task, addr)), ...listDir(store.historyDir(home, task, addr))];
}

/** Путь ссылки по имени — из того каталога, где она сейчас лежит. */
function linkPath(home, task, addr, name) {
  for (const dir of [store.inboxDir(home, task, addr), store.historyDir(home, task, addr)]) {
    const file = path.join(dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Тело сообщения по имени ссылки. Нечитаемое — пустая строка: судить о нём этому файлу нечем. */
function messageBody(home, task, addr, name) {
  const file = linkPath(home, task, addr, name);
  if (!file) return '';
  try {
    return String(JSON.parse(readFileSync(file, 'utf8')).body ?? '');
  } catch {
    return '';
  }
}

/**
 * Путь бинаря, который поднятый процесс назвал СВОИМ, — из mcp-config участника. Читается
 * одно поле: в остальных подставленные токены canonical-серверов, и уносить их в отчёт или
 * в деталь вердикта нельзя.
 */
function readSelfBin(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).mcpServers?.promptobus?.args?.[0] ?? null;
  } catch {
    return null;
  }
}

// Пути сверяем по realpath: под временным каталогом macOS один и тот же файл приезжает и как
// `/var/…`, и как `/private/var/…`, а ESM-резолв дочернего процесса отдаёт разрешённый путь.
function real(p) {
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

function samePath(a, b) {
  return !!a && !!b && real(a) === real(b);
}

function tail(text, n = 700) {
  const s = String(text ?? '').trim();
  return s.length > n ? `…${s.slice(-n)}` : s;
}

function readSafe(file) {
  try { return tail(readFileSync(file, 'utf8')); } catch { return '(лога надзирателя нет)'; }
}
