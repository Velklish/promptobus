// Engine protocol v1: единственная дверь в store v1.
//
// Корень даёт вызывающий, routing policy — тоже, и оба обязательны при ОТКРЫТИИ. Policy
// именно здесь, а не при первой отправке: engine без правила «кто кому вправе писать» — это
// шина, у которой правило появится когда-нибудь потом, а до тех пор пройдёт всё.
//
// К CLI engine подключён дверью механизма (adapter потребителя): она открывает его
// с корнем рабочего места и routing policy потребителя, а модели отдаёт потребителям как есть.
import { linkSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  blobStats, listArtifacts, nameOf, newArtifact, orphanBlobs, readArtifact, readBlob, stashBlob,
  stashBlobSync, writeArtifact,
} from './artifacts.js';
import type { ArtifactSource } from './artifacts.js';
import { fail } from './errors.js';
import {
  blobFile, brokenInboxDir, historyDir, homeOf, inboxDir, taskDir, taskFile,
} from './layout.js';
import {
  commitIntent, completeFanout, countInbox, eventFor, glanceInbox, history as historyOf,
  lastSentAt as lastSentAtOf, newMessage, newRecordId, peekInbox, readInbox, recoverTask,
} from './messages.js';
import type {
  ActivationEvent, BrokenNote, FaultHook, HistoryPage, HistoryQuery, Repair,
} from './messages.js';
import { MESSAGE_TYPES_V1 } from './model.js';
import type { ArtifactV1, MessageV1, ParticipantV1, TaskV1 } from './model.js';
import {
  addParticipant, claimOwner, closeTask, createTask, listTasks, patchParticipant, putParticipant,
  readTask, requireActive, requireParticipant, taskExists, withTaskLock, writeTask,
} from './store.js';
import type { BrokenTask, Clock, NewTask, ParticipantPatch } from './store.js';
import { requireValid } from './validate.js';

/** Решение routing policy: пропустить либо отказать с причиной. */
export type RoutingDecision = { allow: true } | { deny: true; reason: string };

/**
 * Routing policy — правило «кто кому вправе писать». Задаёт его потребитель: у CLI это
 * запрет «worker → worker», у другого adapter'а будет своё. Роли берутся из ЗАПИСЕЙ
 * участников: из id роль не выводится нигде.
 */
export type RoutingPolicy = (sender: ParticipantV1, recipient: ParticipantV1, task: TaskV1) => RoutingDecision;

/** Что подаётся engine при открытии. */
export interface EngineOptions {
  /**
   * Корень рабочего места. Store лежит в `<root>/.promptobus`; сам корень package не ищет.
   * Задаётся ровно один из двух: `root` либо `home`.
   */
  root?: string;
  /**
   * Каталог store целиком. Нужен adapter'у, у которого путь приходит переменной окружения и
   * `.promptobus` в конце может не стоять вовсе: adapter называет каталог, а не рабочее место,
   * и склеивать его с именем root'а второй раз означало бы уводить store мимо того каталога,
   * который назвал человек.
   */
  home?: string;
  policy: RoutingPolicy;
  /** Часы: набор подставляет свои, чтобы штампы были предсказуемы. */
  now?: Clock;
  /** Шов fault injection. В production не подставляется. */
  faults?: FaultHook;
  /** Восстанавливать ли fan-out при открытии. Выключается только набором. */
  recover?: boolean;
  /**
   * Версия механизма, который читает журналы этим engine. Своей у package нет
   * вовсе — её называет открывающий, как `home` и `policy`.
   * Не названа — смесь версий не различается: запись с незнакомыми полями остаётся порчей.
   */
  cli?: string | null;
}

/** Что отправляется на шину. Артефакт кладётся ЗДЕСЬ же — иначе policy его не сторожит. */
export interface SendInput {
  from: string;
  to: string[];
  type: string;
  body: string;
  artifact?: ArtifactSource;
}

/**
 * То же синхронно. Источник артефакта здесь только файл, а имя ему даёт adapter — callback
 * зовётся ПОСЛЕ того, как blob лёг на диск, и получает его digest: adapter кладёт свои
 * человеческие имена рядом , а
 * дедупликация имени без digest'а невозможна.
 */
export interface SendSyncInput {
  from: string;
  to: string[];
  type: string;
  body: string;
  artifact?: { path: string; name?: (sha256: string, size: number) => string };
}

/** Исход отправки: канон, metadata артефакта и события «кого будить». */
export interface SendResult {
  message: MessageV1;
  artifact: ArtifactV1 | null;
  events: ActivationEvent[];
}

/** Исход восстановления: что починено и кого за это надо разбудить. */
export interface RecoverResult {
  repairs: Repair[];
  events: ActivationEvent[];
  broken: BrokenNote[];
}

/** Что унёс `prune`. */
export interface PruneResult {
  task: string;
  blobs: number;
  bytes: number;
}

const NO_FAULT: FaultHook = () => {};

/** Engine v1. Все операции идут через него: сырых путей наружу package не отдаёт. */
export interface Engine {
  /** Каталог store: `<root>/.promptobus`. */
  readonly home: string;
  createTask(input: NewTask): TaskV1;
  readTask(task: string): TaskV1;
  listTasks(): { tasks: TaskV1[]; broken: BrokenTask[] };
  taskExists(task: string): boolean;
  /**
   * Закрыть задачу. `adapter` — поля adapter'а, которые ложатся ТЕМ ЖЕ ходом: отметку
   * закрытия пишет он, и второй лок ради одного поля стоил бы задачи, закрытой без неё.
   */
  closeTask(task: string, patch?: { adapter?: Record<string, unknown> }): TaskV1;
  /**
   * Поправить журнал задачи: заголовок и поля adapter'а. Поля `adapter` СЛИВАЮТСЯ, а не
   * заменяются: объект opaque, и замена целиком унесла бы соседние, дописанные тем временем.
   */
  patchTask(task: string, patch: { title?: string; adapter?: Record<string, unknown> }): TaskV1;
  addParticipant(task: string, participant: ParticipantV1): ParticipantV1;
  /** Положить запись участника целиком, заменив прежнюю: так пишет подъём участника. */
  putParticipant(task: string, participant: ParticipantV1): TaskV1;
  patchParticipant(task: string, id: string, patch: ParticipantPatch): ParticipantV1;
  /**
   * Четыре пути, которые adapter'у нужны именами, а не операциями: файл журнала называет
   * человеку диагностика «журнал не читается», за mailbox'ом следит слушатель шины
   * (`fs.watch`), а прочитанное и отложенное показывает человеку живой прогон — по ним он
   * и разбирает, куда делось сообщение. Остальная раскладка store наружу не выходит.
   */
  taskFile(task: string): string;
  inboxPath(task: string, participant: string): string;
  historyPath(task: string, participant: string): string;
  brokenPath(task: string, participant: string): string;
  claimOwner(task: string, id: string): string;
  send(task: string, input: SendInput): Promise<SendResult>;
  sendSync(task: string, input: SendSyncInput): SendResult;
  read(task: string, participant: string): { messages: MessageV1[]; broken: BrokenNote[] };
  /** Прочитать не забирая: ссылки остаются в inbox'е. Битое откладывается так же. */
  peek(task: string, participant: string): { messages: MessageV1[]; broken: BrokenNote[] };
  /** Заглянуть молча: ни ссылок не трогает, ни битого не откладывает. */
  glance(task: string, participant: string): MessageV1[];
  unread(task: string, participant: string): number;
  /** Когда участник в последний раз отправлял; `null` — не отправлял ещё ничего. */
  lastSentAt(task: string, participant: string): number | null;
  /**
   * Жёсткая ссылка на blob под именем, которое выбрал adapter. `false` — имя занято, и
   * выбирать следующее — дело вызывающего: содержимое дедуплицировано, и вторая ссылка на
   * тот же inode лишнего байта не стоит. Путь blob'а наружу при этом не выходит.
   */
  linkBlob(task: string, sha256: string, target: string): boolean;
  history(query?: HistoryQuery): HistoryPage;
  recover(task?: string): RecoverResult;
  readArtifact(task: string, id: string): ArtifactV1;
  readArtifactContent(task: string, id: string): Buffer;
  listArtifacts(task: string): { artifacts: ArtifactV1[]; broken: string[] };
  orphanBlobs(task: string): string[];
  prune(task: string): PruneResult;
}

/**
 * Открыть engine. Без routing policy — отказ ЗДЕСЬ, а не при первой отправке: шина, у
 * которой правило появится потом, до тех пор пропускает всё.
 */
export function openEngine({
  root, home: at, policy, now = () => new Date(), faults = NO_FAULT, recover = true, cli = null,
}: EngineOptions): Engine {
  if (typeof policy !== 'function') {
    fail('policy-required', 'routing policy обязательна: engine без правила «кто кому вправе писать» не открывается');
  }
  if ((root === undefined) === (at === undefined)) {
    fail('schema-invalid', 'engine открывается по одному из двух: root рабочего места либо home самого store');
  }
  const home = at ?? homeOf(root as string);

  function decide(sender: ParticipantV1, recipient: ParticipantV1, meta: TaskV1): void {
    const decision = policy(sender, recipient, meta);
    if (decision && (decision as { allow?: unknown }).allow === true) return;
    // Не решение вовсе — тоже отказ: policy, вернувшая мусор, не имеет права читаться как
    // разрешение. Молчаливый пропуск здесь стоил бы ровно того, ради чего policy обязательна.
    const reason = decision && typeof (decision as { reason?: unknown }).reason === 'string'
      ? (decision as { reason: string }).reason
      : 'policy не вернула решения';
    fail('policy-denied', `${sender.id} → ${recipient.id}: ${reason}`,
      { task: meta.id, sender: sender.id, recipient: recipient.id, reason });
  }

  /** Шаг 1: всё, что проверяется ДО первого side effect. Один на обе ветки отправки. */
  function prepare(task: string, input: { from: string; to: string[]; type: string; body: string }): {
    meta: TaskV1; sender: ParticipantV1; recipients: ParticipantV1[];
  } {
    const meta = requireActive(readTask(home, task, cli));
    const sender = requireParticipant(meta, input.from);
    if (!Array.isArray(input.to) || !input.to.length) {
      fail('recipients-empty', 'список получателей пуст', { task });
    }
    if (new Set(input.to).size !== input.to.length) {
      fail('recipients-duplicate', `дубли получателей: ${input.to.join(', ')}`, { task, to: input.to });
    }
    const recipients = input.to.map((id) => requireParticipant(meta, id));
    if (typeof input.type !== 'string' || !MESSAGE_TYPES_V1.includes(input.type)) {
      fail('message-type-unknown', `тип «${String(input.type)}» не из протокола v1: ${MESSAGE_TYPES_V1.join(', ')}`,
        { task, type: input.type });
    }
    if (typeof input.body !== 'string' || !input.body) {
      fail('schema-invalid', 'body пуст — сообщение без текста не отправляется', { task });
    }
    for (const recipient of recipients) decide(sender, recipient, meta);
    faults('validate', { task, message: null });
    return { meta, sender, recipients };
  }

  /** Шаги 2–5: точка коммита, fan-out и события «кого будить». Тоже один на обе ветки. */
  function finish(task: string, meta: TaskV1, sender: ParticipantV1, recipients: ParticipantV1[],
    input: { to: string[]; type: string; body: string }, artifact: ArtifactV1 | null): SendResult {
    const draft = newMessage(task, sender.id, input.to, input.type, input.body, artifact?.id ?? null, now());
    requireValid('message', draft, { task });
    const message = commitIntent(home, task, draft, now());
    faults('intent', { task, message: message.id });
    completeFanout(home, task, message, faults);
    // Активация НЕ здесь: engine отдаёт список «кого будить», а будит supervisor через
    // driver участника — и делает это независимо по получателям, уже после того, как
    // fan-out лёг на диск.
    return { message, artifact, events: recipients.map((r) => eventFor(home, task, r, [message])) };
  }

  const engine: Engine = {
    home,

    createTask: (input) => createTask(home, input, now),
    readTask: (task) => readTask(home, task, cli),
    listTasks: () => listTasks(home, cli),
    taskExists: (task) => taskExists(home, task),
    closeTask: (task, patch = {}) => closeTask(home, task, now, patch.adapter, cli),
    patchTask: (task, patch) => withTaskLock(home, task, () => {
      const meta = readTask(home, task, cli);
      return writeTask(home, {
        ...meta,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.adapter === undefined ? {} : { adapter: { ...meta.adapter, ...patch.adapter } }),
      }, now);
    }),
    addParticipant: (task, participant) => addParticipant(home, task, participant, now, cli),
    putParticipant: (task, participant) => putParticipant(home, task, participant, now, cli),
    taskFile: (task) => taskFile(home, task),
    inboxPath: (task, participant) => inboxDir(home, task, participant),
    historyPath: (task, participant) => historyDir(home, task, participant),
    brokenPath: (task, participant) => brokenInboxDir(home, task, participant),
    patchParticipant: (task, id, patch) => patchParticipant(home, task, id, patch, now, cli),
    claimOwner: (task, id) => claimOwner(home, task, id, now, cli),

    async send(task, input) {
      const { sender, recipients, meta } = prepare(task, input);

      // --- артефакт: после policy, до сообщения -----------------------------------------
      // Порядок обязателен: отказ policy не имеет права оставить в задаче blob. Считается
      // digest потоково, на проходе записи — источником бывает поток, и второго чтения у
      // него нет вовсе.
      let artifact: ArtifactV1 | null = null;
      if (input.artifact) {
        // Имя считается ДО записи blob'а: негодное, пойманное схемой уже после, оставило бы
        // в задаче содержимое без metadata — orphan blob до самого `prune`.
        const filename = nameOf(input.artifact);
        const { sha256, size } = await stashBlob(home, task, input.artifact);
        faults('blob', { task, sha256 });
        artifact = writeArtifact(home, task, newArtifact(newRecordId(now()), sha256, filename, size));
        faults('artifact', { task, artifact: artifact.id });
      }
      return finish(task, meta, sender, recipients, input, artifact);
    },

    sendSync(task, input) {
      const { sender, recipients, meta } = prepare(task, input);
      let artifact: ArtifactV1 | null = null;
      if (input.artifact) {
        const source = input.artifact;
        // Имя источника проверяется ДО записи blob'а — ровно как в потоковой ветке:
        // негодное, пойманное уже после, оставило бы в задаче содержимое без metadata,
        // то есть orphan blob на ровном месте.
        nameOf({ path: source.path });
        const { sha256, size } = stashBlobSync(home, task, source.path);
        faults('blob', { task, sha256 });
        // Имя, под которым запись увидит человек, даёт adapter и ПОСЛЕ blob'а:
        // дедупликация имени без digest'а невозможна. Проверяется оно тем же `nameOf`.
        const filename = nameOf({ path: source.path, filename: source.name?.(sha256, size) });
        artifact = writeArtifact(home, task, newArtifact(newRecordId(now()), sha256, filename, size));
        faults('artifact', { task, artifact: artifact.id });
      }
      return finish(task, meta, sender, recipients, input, artifact);
    },

    read(task, participant) {
      // Закрытую задачу читать законно: `requireActive` тут не при чём — переписка остаётся
      // журналом и после закрытия.
      requireParticipant(readTask(home, task, cli), participant);
      return readInbox(home, task, participant, faults);
    },

    peek: (task, participant) => peekInbox(home, task, participant),
    glance: (task, participant) => glanceInbox(home, task, participant),

    unread: (task, participant) => countInbox(home, task, participant),

    lastSentAt: (task, participant) => lastSentAtOf(home, task, participant),

    linkBlob(task, sha256, target) {
      mkdirSync(path.dirname(target), { recursive: true });
      try {
        linkSync(blobFile(home, task, sha256), target);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw e;
      }
    },

    history(query = {}) {
      const tasks = query.task ? [query.task] : listTasks(home, cli).tasks.map((t) => t.id);
      return historyOf(home, tasks, query);
    },

    recover(task) {
      const metas = task ? [readTask(home, task, cli)] : listTasks(home, cli).tasks;
      const out: RecoverResult = { repairs: [], events: [], broken: [] };
      for (const meta of metas) {
        const one = recoverTask(home, meta.id, meta, faults);
        out.repairs.push(...one.repairs);
        out.events.push(...one.events);
        out.broken.push(...one.broken);
      }
      return out;
    },

    readArtifact: (task, id) => readArtifact(home, task, id),
    readArtifactContent: (task, id) => readBlob(home, task, readArtifact(home, task, id)),
    listArtifacts: (task) => listArtifacts(home, task),
    orphanBlobs: (task) => orphanBlobs(home, task),

    /**
     * Снести задачу целиком вместе с blob'ами. Blob дедуплицирован внутри задачи, и «ничей»
     * он ровно до следующей отправки того же содержимого, — поэтому поштучно blob'ы не
     * убираются никогда, а уходят с задачей.
     */
    prune(task) {
      const meta = readTask(home, task, cli);
      if (meta.status === 'active') {
        fail('task-active', `задача ${task} активна — prune сносит её переписку и blob'ы целиком`,
          { task, status: meta.status });
      }
      const { count, bytes } = blobStats(home, task);
      rmSync(taskDir(home, task), { recursive: true, force: true });
      return { task, blobs: count, bytes };
    },
  };

  if (recover) engine.recover();
  return engine;
}
