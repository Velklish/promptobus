// Content-addressed артефакты v1 (ADR-032, §6).
//
// Содержимое адресуется SHA-256 и дедуплицируется внутри задачи; имя файла живёт отдельно,
// в metadata. Одно и то же содержимое под двумя именами даёт две записи metadata и один
// blob. Blob неизменяем и удаляется только вместе с задачей — `prune`.
//
// Digest считается ПОТОКОВО, на проходе записи: читать файл дважды значило бы хешировать
// не то, что легло на диск, — между двумя чтениями источник может смениться.
import { createHash } from 'node:crypto';
import {
  createReadStream, createWriteStream, existsSync, linkSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pipeline } from 'node:stream/promises';
import { writeJsonAtomic } from '../fs/atomic.js';
import { fail, PromptobusError } from './errors.js';
import {
  artifactFile, artifactsDir, blobFile, blobOf, blobRef, blobsDir, brokenArtifactsDir,
} from './layout.js';
import { FILENAME_RE, SCHEMA_VERSION } from './model.js';
import type { ArtifactV1 } from './model.js';
import { requireValid, validate } from './validate.js';

/**
 * Источник артефакта: файл на диске либо поток. Больше ничего — «строка как содержимое»
 * приглашала бы класть в шину то, что уже лежит в теле сообщения.
 */
export type ArtifactSource =
  | { path: string; filename?: string }
  | { stream: NodeJS.ReadableStream; filename: string };

let tmpSeq = 0;

/**
 * Имя файла артефакта — из источника. Зовётся ДО записи blob'а: негодное имя, пойманное
 * схемой уже после, оставляло бы в задаче содержимое без metadata, то есть orphan blob на
 * ровном месте (замечание ревью).
 */
export function nameOf(source: ArtifactSource): string {
  let name: string;
  if ('stream' in source) {
    if (typeof source.filename !== 'string' || !source.filename) {
      fail('artifact-source', 'у потока нет имени файла — назвать его некому');
    }
    name = source.filename;
  } else {
    if (typeof source.path !== 'string' || !source.path) fail('artifact-source', 'путь артефакта не назван');
    name = source.filename || path.basename(source.path);
  }
  // Та же грамматика, что у схемы: разделитель пути в имени означал бы, что metadata
  // адресует что-то за пределами задачи. Схема её тоже проверяет — но уже у записи с диска.
  if (!FILENAME_RE.test(name) || name === '.' || name === '..' || name.length > 255) {
    fail('artifact-source', `негодное имя файла артефакта: «${name}»`, { filename: name });
  }
  return name;
}

function inputOf(source: ArtifactSource): NodeJS.ReadableStream {
  if ('stream' in source) return source.stream;
  if (!existsSync(source.path)) fail('artifact-source', `артефакта нет: ${source.path}`, { path: source.path });
  return createReadStream(source.path);
}

/**
 * Положить содержимое в blob задачи. Возвращает digest и размер.
 *
 * Записывается через временного соседа, а на место встаёт `link`: занятое имя даёт `EEXIST`,
 * и это не отказ, а дедупликация — содержимое под этим digest'ом уже лежит. Перезаписывать
 * blob нельзя вовсе: он неизменяем, и вторая запись поверх меняла бы содержимое у всех
 * metadata-записей разом.
 */
export async function stashBlob(home: string, task: string, source: ArtifactSource): Promise<{ sha256: string; size: number }> {
  const dir = blobsDir(home, task);
  mkdirSync(dir, { recursive: true });
  tmpSeq += 1;
  const tmp = path.join(dir, `.tmp-blob-${process.pid}-${tmpSeq}`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(inputOf(source), async function* count(chunks: AsyncIterable<Buffer | string>) {
      for await (const chunk of chunks) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        hash.update(buf);
        size += buf.length;
        yield buf;
      }
    }, createWriteStream(tmp));
    const sha256 = hash.digest('hex');
    try {
      linkSync(tmp, blobFile(home, task, sha256));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // Тот же digest уже лежит — это и есть дедупликация внутри задачи.
      if (code !== 'EEXIST') throw linkFailure(e, blobFile(home, task, sha256));
    }
    return { sha256, size };
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * То же синхронно, из файла. Заведено для adapter'а, чей путь отправки синхронен целиком
 * (`sendSync` ниже): MCP-сервер шины отвечает на `tools/call` одним синхронным проходом, и
 * промис в его середине переписал бы диспетчер инструментов ради одного артефакта.
 *
 * Инвариант потоковой ветки при этом держится, а не ослабляется: файл читается ОДИН раз,
 * и digest считается по тем самым байтам, которые лягут в blob. Цена — размер файла в
 * памяти; артефакты шины это дифф и контракт, а не образ диска.
 *
 * **Свойство «один проход» структурное, и гейтом оно не покрыто.** Держится оно тем, что
 * окна между чтением и записью в коде нет вовсе: `readFileSync` один, digest считается по
 * этому же буферу, он же и пишется. Подменить содержимое «между двумя чтениями» негде, и
 * проба двухпроходной редакцией не красит ничего — значит проверки на это свойство нет, а
 * не что она зелёная. Что проверяется реально: digest записи сходится с содержимым blob'а,
 * а чтение отказывает `artifact-integrity` на расхождении.
 */
export function stashBlobSync(home: string, task: string, file: string): { sha256: string; size: number } {
  if (typeof file !== 'string' || !file) fail('artifact-source', 'путь артефакта не назван');
  let content: Buffer;
  try {
    content = readFileSync(file);
  } catch {
    fail('artifact-source', `артефакта нет: ${file}`, { path: file });
  }
  const sha256 = createHash('sha256').update(content).digest('hex');
  const dir = blobsDir(home, task);
  mkdirSync(dir, { recursive: true });
  tmpSeq += 1;
  const tmp = path.join(dir, `.tmp-blob-${process.pid}-${tmpSeq}`);
  try {
    writeFileSync(tmp, content);
    try {
      linkSync(tmp, blobFile(home, task, sha256));
    } catch (e) {
      // Тот же digest уже лежит — это и есть дедупликация внутри задачи.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw linkFailure(e, blobFile(home, task, sha256));
    }
  } finally {
    rmSync(tmp, { force: true });
  }
  return { sha256, size: content.length };
}

// Отказы, которыми ФС говорит «жёсткую ссылку сюда поставить нельзя»: чужой том, отсутствие
// жёстких ссылок вовсе, нет прав на каталог, предел числа ссылок у inode.
//
// `ENOENT` в список попасть не имеет права: `materialize` ([messages.ts](messages.ts)) читает
// его как «intent унёс сосед, материализовавший сообщение раньше» и сверяет для этого сырой
// `code` исключения. Попади `ENOENT` сюда — отсюда вернулся бы `PromptobusError` с кодом
// `link-refused`, сверка его не узнала бы, и терпимость к гонке умерла бы молча.
const LINK_REFUSALS = ['EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EACCES', 'EMLINK'];

/**
 * Отказ жёсткой ссылки — типизированным кодом, а не голым errno.
 *
 * ФС без жёстких ссылок и ссылка через границу тома — законные условия среды, а не поломка
 * механизма (ADR-032, §4: общий локальный filesystem назван условием работы). Отвечает на
 * них код, чтобы adapter сказал человеку словами; половинчатой записи при этом не остаётся —
 * fan-out обрывается на шаге, а intent остаётся открытым, и восстановление доведёт его до
 * конца, когда условие снимут.
 */
export function linkFailure(e: unknown, target: string): Error {
  const code = (e as NodeJS.ErrnoException).code ?? '';
  if (LINK_REFUSALS.includes(code)) {
    return new PromptobusError('link-refused',
      `жёсткая ссылка не поставлена (${code}): ${target}`, { target, errno: code });
  }
  return e as Error;
}

/** Записать metadata артефакта. Валидация до записи: негодное в store не попадает. */
export function writeArtifact(home: string, task: string, meta: ArtifactV1): ArtifactV1 {
  requireValid('artifact', meta, { task, artifact: meta.id });
  writeJsonAtomic(artifactFile(home, task, meta.id), meta);
  return meta;
}

export function newArtifact(id: string, sha256: string, filename: string, size: number): ArtifactV1 {
  return { schemaVersion: SCHEMA_VERSION, id, sha256, filename, size, blob: blobRef(sha256) };
}

/**
 * Прочитать metadata. Невалидная уезжает в `broken/artifacts` — одна испорченная запись не
 * имеет права стоить задаче остальных.
 */
export function readArtifact(home: string, task: string, id: string): ArtifactV1 {
  const file = artifactFile(home, task, id);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    fail('artifact-not-found', `артефакта ${id} нет в задаче ${task}`, { task, artifact: id });
  }
  let meta: unknown;
  try {
    meta = JSON.parse(raw);
  } catch (e) {
    isolateArtifact(home, task, `${id}.json`);
    fail('artifact-not-found', `metadata артефакта ${id} не разобрана (${(e as Error).message}) — отложена в broken`,
      { task, artifact: id });
  }
  const verdict = validate('artifact', meta);
  if (!verdict.ok) {
    // Запись из будущего в `broken` не уезжает: она не испорчена, её просто нечем читать.
    if (verdict.code !== 'schema-version-unsupported') isolateArtifact(home, task, `${id}.json`);
    fail(verdict.code ?? 'schema-invalid',
      `metadata артефакта ${id} не по схеме: ${verdict.at} ${verdict.note}`,
      { task, artifact: id, at: verdict.at });
  }
  return meta as ArtifactV1;
}

function isolateArtifact(home: string, task: string, name: string): void {
  const attic = brokenArtifactsDir(home, task);
  try {
    mkdirSync(attic, { recursive: true });
    renameSync(path.join(artifactsDir(home, task), name), path.join(attic, name));
  } catch {
    // Отложить не вышло — читателя это остановить не имеет права: он и так отказывает
    // кодом, а файл остаётся на месте под тем же именем.
  }
}

/**
 * Прочитать содержимое артефакта, сверив digest. Расхождение — типизированный отказ, а не
 * тихое чтение: испорченный blob, отданный как содержимое, и есть тот случай, ради которого
 * артефакты адресуются хешем.
 */
export function readBlob(home: string, task: string, meta: ArtifactV1): Buffer {
  const file = blobOf(home, task, meta);
  let content: Buffer;
  try {
    content = readFileSync(file);
  } catch {
    fail('artifact-not-found', `blob'а ${meta.sha256} нет в задаче ${task}`,
      { task, artifact: meta.id, sha256: meta.sha256 });
  }
  const actual = createHash('sha256').update(content).digest('hex');
  if (actual !== meta.sha256) {
    fail('artifact-integrity',
      `blob артефакта ${meta.id} не сходится с digest'ом: объявлено ${meta.sha256}, посчитано ${actual}`,
      { task, artifact: meta.id, declared: meta.sha256, actual });
  }
  if (content.length !== meta.size) {
    fail('artifact-integrity',
      `размер артефакта ${meta.id} не сходится: объявлено ${meta.size}, на диске ${content.length}`,
      { task, artifact: meta.id, declared: meta.size, actual: content.length });
  }
  return content;
}

/** Перечислить metadata-записи задачи, пропуская нечитаемые. */
export function listArtifacts(home: string, task: string): { artifacts: ArtifactV1[]; broken: string[] } {
  const artifacts: ArtifactV1[] = [];
  const broken: string[] = [];
  let names: string[];
  try {
    names = readdirSync(artifactsDir(home, task));
  } catch {
    return { artifacts, broken };
  }
  for (const name of names.filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort()) {
    try {
      artifacts.push(readArtifact(home, task, name.slice(0, -'.json'.length)));
    } catch (e) {
      broken.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { artifacts, broken };
}

/**
 * Blob'ы, на которые не ссылается ни одна metadata-запись. Появляются они законно: падение
 * между записью blob'а и записью metadata оставляет содержимое без имени. Удалять их
 * поштучно нельзя — blob дедуплицирован, и «ничей» он ровно до следующей отправки того же
 * содержимого; уносит их `prune` вместе с задачей.
 */
export function orphanBlobs(home: string, task: string): string[] {
  let names: string[];
  try {
    names = readdirSync(blobsDir(home, task));
  } catch {
    return [];
  }
  const used = new Set(listArtifacts(home, task).artifacts.map((a) => a.sha256));
  return names.filter((n) => !n.startsWith('.') && !used.has(n)).sort();
}

/** Сколько blob'ов и байт лежит у задачи — для отчёта `prune`. */
export function blobStats(home: string, task: string): { count: number; bytes: number } {
  let names: string[];
  try {
    names = readdirSync(blobsDir(home, task)).filter((n) => !n.startsWith('.'));
  } catch {
    return { count: 0, bytes: 0 };
  }
  let bytes = 0;
  for (const name of names) {
    try {
      bytes += statSync(path.join(blobsDir(home, task), name)).size;
    } catch {
      // Унёс сосед между листингом и `stat` — не наша беда: считаем оставшееся.
    }
  }
  return { count: names.length, bytes };
}
