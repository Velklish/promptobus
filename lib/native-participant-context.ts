import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { isDeepStrictEqual, TextDecoder } from 'node:util';
import path from 'node:path';
import { normalizeContextDeclaration, selectParticipantContext } from './participant-context.js';
import { GateError } from '../dist/index.js';
import type { PreparedHostParticipantContextSelection, HostParticipantContextPurpose, HostTaskContextDeclaration, Driver, LaunchFile } from '../dist/index.js';
import type { ParticipantContextHost, ParticipantContextCeiling } from './participant-context.js';

type Selection = PreparedHostParticipantContextSelection | null | undefined;
interface NativeContextOptions { contextDeclaration?: unknown; contextPurpose?: string }
interface PreparedContextInput {
  root: string; role: string; taskId: string; options?: NativeContextOptions;
  participant?: { metadata?: Record<string, unknown> | null } | null;
  preparedSelection?: ParticipantContextCeiling;
}

const PURPOSES = ['technical', 'user-facing', 'author-voice'];
const MARKER = '.promptobus-context.json';
const inside = (root: string, file: string) => file === root || file.startsWith(`${root}${path.sep}`);

export const CONTEXT_FLAGS = { 'context-purpose': { type: 'string' }, 'context-file': { type: 'string' } };

function declaration(value: unknown): HostTaskContextDeclaration {
  try { return normalizeContextDeclaration(value); } catch (error) { throw new GateError((error as Error).message); }
}

export function contextCliOptions(values: Record<string, string | undefined>, cwd = process.cwd()) {
  let contextDeclaration;
  if (values['context-file'] !== undefined) {
    const file = path.resolve(cwd, values['context-file']);
    try {
      if (!statSync(file).isFile() || statSync(file).size > 256 * 1024) throw new GateError('--context-file requires a JSON file of at most 256 KiB');
      contextDeclaration = declaration(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) { throw new GateError(`Invalid --context-file ${file}: ${(error as Error).message}`); }
  }
  const contextPurpose = values['context-purpose'];
  if (contextPurpose !== undefined && !PURPOSES.includes(contextPurpose)) throw new GateError('--context-purpose requires technical, user-facing or author-voice');
  return { ...(contextPurpose !== undefined ? { contextPurpose } : {}), ...(contextDeclaration !== undefined ? { contextDeclaration } : {}) };
}

export function prepareNativeContext(host: ParticipantContextHost, { root, role, taskId, options = {}, participant = null, preparedSelection = undefined }: PreparedContextInput) {
  const prior = participant?.metadata?.participantContext as PreparedHostParticipantContextSelection | undefined;
  const context = options.contextDeclaration === undefined ? prior?.task.context : declaration(options.contextDeclaration);
  const purpose = options.contextPurpose ?? prior?.task.purpose;
  const requested = purpose !== undefined || context !== undefined || prior || preparedSelection || typeof host.selectParticipantContext === 'function';
  if (!requested) return null;
  if (!PURPOSES.includes(purpose!)) throw new GateError('Selected native context requires explicit --context-purpose or a recorded purpose');
  if (typeof host.selectParticipantContext !== 'function') throw new GateError('Selected native context requires Host selector support');
  if (participant && !prior) throw new GateError('A legacy participant needs a new preparation and session before selected context can be delivered');
  const task = { id: taskId, purpose: purpose as HostParticipantContextPurpose, ...(context === undefined ? {} : { context }) };
  if (prior && !isDeepStrictEqual(prior.task, task)) throw new GateError('Native participant context changed; prepare a new participant and session');
  let selection;
  try { selection = selectParticipantContext(host, { root, role, task, preparedSelection: prior ?? preparedSelection }); }
  catch (error) { throw new GateError((error as Error).message); }
  if ((prior ?? preparedSelection) && !isDeepStrictEqual(selection, prior ?? preparedSelection)) throw new GateError('Native context selection changed; prepare a new participant and session');
  selectedNativeFiles(selection, null);
  nativeContextPrompt(selection);
  return selection;
}

export function assertNativeContextDriver(selection: Selection, driver: Pick<Driver, 'id' | 'options'>) {
  if (selection && driver.options.selectedContext !== true) throw new GateError(`Harness ${driver.id} does not support selected native context`);
}

export function nativeContextMetadata(selection: Selection) {
  return selection ? { contextPurpose: selection.task.purpose,
    ...(selection.task.context === undefined ? {} : { contextDeclaration: selection.task.context }), participantContext: selection } : {};
}

export function contextRules(selection: Selection, legacyRules: () => string[], from: string | null = null, to: string | null = null, verify = false) {
  const rules = selection ? selection.rules.map(rule => rule.path) : legacyRules();
  return rules.map(file => {
    const mapped = from && to && inside(from, file) ? path.join(to, path.relative(from, file)) : file;
    if (verify && selection) {
      const canonical = realpathSync(mapped);
      if (!statSync(canonical).isFile() || (from && to && inside(from, file) && !inside(realpathSync(to), canonical))) {
        throw new GateError(`Selected native rule escapes its participant worktree: ${mapped}`);
      }
    }
    return mapped;
  });
}

export function nativeContextPrompt(selection: Selection) {
  if (!selection) return '';
  let resourceBytes = 0;
  const resources = selection.resources.map(resource => {
    const body = nativeResourceBody(resource.path);
    resourceBytes += body.bytes;
    if (resourceBytes > 1024 * 1024) throw new GateError('Selected native resource bodies exceed 1 MiB');
    return `Exact selected resource: ${resource.path} (${resource.reason}). Its parent and siblings are not selected.\nReference content follows; it is not an additional Host rule.\n${body.text}\nEnd selected resource: ${resource.path}`;
  });
  return ['\n\n## Selected task context',
    `Task: ${selection.task.id}\nPurpose: ${selection.task.purpose}`,
    ...selection.skills.map(skill => `Read selected skill ${skill.name}: ${path.join(skill.root, 'SKILL.md')} (${skill.reason}).`),
    ...resources,
  ].join('\n');
}

function openSelectedNativeSource(file: string) {
  if (realpathSync(file) !== file) throw new GateError(`Selected native context source changed its canonical path: ${file}`);
  const before = statSync(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd), canonical = realpathSync(file);
    if (canonical !== file) throw new GateError(`Selected native context source changed its canonical path while opening: ${file}`);
    const current = statSync(canonical);
    if ([before, current].some(entry => entry.dev !== opened.dev || entry.ino !== opened.ino)) throw new GateError(`Selected native context source changed while opening: ${file}`);
    if (!opened.isFile()) throw new GateError(`Selected native context source requires a regular file: ${file}`);
    return { fd, stat: opened };
  } catch (error) { closeSync(fd); throw error; }
}

function nativeResourceBody(file: string) {
  const { fd, stat } = openSelectedNativeSource(file), limit = 256 * 1024;
  try {
    if (stat.size > limit) throw new GateError(`Selected native resource requires a regular UTF-8 file of at most 256 KiB: ${file}`);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0, read;
    while (size < buffer.length && (read = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += read;
    if (size > limit) throw new GateError(`Selected native resource exceeds 256 KiB: ${file}`);
    const bytes = buffer.subarray(0, size);
    if (bytes.includes(0)) throw new GateError(`Selected native resource contains NUL bytes: ${file}`);
    try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), bytes: size }; }
    catch { throw new GateError(`Selected native resource is not valid UTF-8: ${file}`); }
  } finally { closeSync(fd); }
}

function filesUnder(root: string, prefix = '', skipIgnored = true): { relative: string; source: string }[] {
  const files: { relative: string; source: string }[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (skipIgnored && (entry.name === '.git' || entry.name === '.DS_Store')) continue;
    const file = path.join(root, entry.name), relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new GateError(`Selected native context refuses a symbolic link: ${file}`);
    if (entry.isDirectory()) files.push(...filesUnder(file, relative, skipIgnored));
    else if (entry.isFile()) files.push({ relative, source: file });
    else throw new GateError(`Selected native context requires regular files: ${file}`);
  }
  return files;
}

function checkDestination(destination: string, selection: PreparedHostParticipantContextSelection, expected: string[]) {
  let parent = path.dirname(destination), parentEntry;
  while (!(parentEntry = existingEntry(parent))) parent = path.dirname(parent);
  if (parentEntry.isSymbolicLink() || realpathSync(parent) !== parent) throw new GateError(`Selected native context destination traverses a symbolic link: ${destination}`);
  if (!parentEntry.isDirectory()) throw new GateError(`Selected native context parent is not a directory: ${parent}`);
  const entry = existingEntry(destination);
  if (!entry) return;
  if (entry.isSymbolicLink()) throw new GateError(`Selected native context destination refuses a symbolic link: ${destination}`);
  if (!entry.isDirectory()) throw new GateError(`Selected native context destination is not an owned directory: ${destination}`);
  if (!readdirSync(destination).length) return;
  const marker = path.join(destination, MARKER);
  let previous: { owner?: unknown; task?: unknown; paths?: unknown[] } | undefined;
  try { previous = JSON.parse(readFileSync(marker, 'utf8')); } catch { /* A foreign directory has no ownership receipt. */ }
  if (previous?.owner !== 'promptobus-selected-context' || !isDeepStrictEqual(previous.task, selection.task)
    || !Array.isArray(previous.paths)) throw new GateError(`Selected native context refuses a pre-existing unowned skills container: ${destination}`);
  for (const file of filesUnder(destination, '', false)) {
    if (file.relative !== MARKER && !previous.paths.includes(file.relative)) throw new GateError(`Selected native context refuses an unowned destination: ${path.join(destination, file.relative)}`);
  }
  for (const relative of expected) if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw new GateError(`Selected native context destination escapes its container: ${relative}`);
}

export function assertNativeContainer(directory: string, allowed: string[]) {
  const entry = existingEntry(directory);
  if (!entry) return;
  if (entry.isSymbolicLink()) throw new GateError(`Selected native container refuses a symbolic link: ${directory}`);
  if (!entry.isDirectory()) throw new GateError(`Selected native container is not a directory: ${directory}`);
  for (const name of readdirSync(directory)) {
    if (!allowed.includes(name)) throw new GateError(`Selected native container has unowned content: ${path.join(directory, name)}`);
    if (lstatSync(path.join(directory, name)).isSymbolicLink()) throw new GateError(`Selected native container refuses a symbolic link: ${path.join(directory, name)}`);
  }
}

function existingEntry(file: string) {
  try { return lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export function assertNativePluginManifest(plugin: string, selection: PreparedHostParticipantContextSelection, manifestText: string) {
  assertNativeContainer(plugin, ['skills', '.claude-plugin', 'bootstrap']);
  assertNativeContainer(path.join(plugin, '.claude-plugin'), ['plugin.json']);
  checkDestination(path.join(plugin, 'bootstrap'), selection, ['assignment.md']);
  const manifest = path.join(plugin, '.claude-plugin', 'plugin.json'), entry = existingEntry(manifest);
  if (!entry) return;
  if (!entry.isFile()) throw new GateError(`Selected native plugin manifest is unowned: ${manifest}`);
  const marker = path.join(plugin, 'skills', MARKER), receipt = existingEntry(marker);
  if (!receipt?.isFile() || receipt.isSymbolicLink()) throw new GateError(`Selected native plugin manifest is unowned: ${manifest}`);
  checkDestination(path.join(plugin, 'skills'), selection, []);
  if (readFileSync(manifest, 'utf8') !== manifestText) throw new GateError(`Selected native plugin manifest is unowned: ${manifest}`);
}

export function selectedNativePrompt(selection: Selection, prompt: string, directory: string): { argument: string; files: LaunchFile[]; addDirs: string[] } {
  if (!selection || !prompt || Buffer.byteLength(prompt, 'utf8') <= 32 * 1024) return { argument: prompt, files: [], addDirs: [] };
  const paths = ['assignment.md'], file = path.join(directory, paths[0]);
  checkDestination(directory, selection, paths);
  return {
    argument: `Read the complete task bootstrap at this exact file before doing any work:\n${file}`,
    addDirs: [directory],
    files: [
      { path: directory, clearDirectory: true, selectedContext: selection, selectedPaths: paths, text: '', secret: false },
      { path: file, text: prompt, secret: false },
      { path: path.join(directory, MARKER), text: `${JSON.stringify({ owner: 'promptobus-selected-context', task: selection.task, paths })}\n`, secret: false },
    ],
  };
}

export function selectedNativeFiles(selection: Selection, destination: string | null): LaunchFile[] {
  if (!selection) return [];
  const sources = new Map<string, string>();
  const add = (relative: string, source: string) => {
    if (relative === MARKER || relative.startsWith(`${MARKER}${path.sep}`)
      || [...sources.keys()].some(prior => prior.startsWith(`${relative}${path.sep}`) || relative.startsWith(`${prior}${path.sep}`))) {
      throw new GateError(`Selected native context destination collision: ${relative}`);
    }
    const prior = sources.get(relative);
    if (prior && prior !== source) throw new GateError(`Selected native context destination collision: ${relative}: ${prior}, ${source}`);
    sources.set(relative, source);
  };
  for (const skill of selection.skills) {
    for (const file of filesUnder(skill.root)) add(path.join(skill.name, file.relative), file.source);
  }
  for (const resource of selection.resources) {
    if (selection.skills.some(skill => inside(skill.root, resource.path))) continue;
    const targets = new Set<string>();
    for (const skill of selection.skills) {
      const relative = path.relative(path.dirname(skill.sourceRoot), resource.sourcePath);
      if (relative.startsWith(`_shared${path.sep}`) && !relative.split(path.sep).includes('..')) targets.add(relative);
    }
    if (targets.size > 1) throw new GateError(`Selected native resource has ambiguous topology: ${resource.sourcePath}`);
    if (targets.size) add([...targets][0], resource.path);
    else if (selection.skills.some(skill => skill.requires.some(ref => ref.kind === 'resource' && ref.path === resource.path))) {
      throw new GateError(`Selected native skill resource has unsupported relative topology: ${resource.sourcePath}`);
    }
  }
  const paths = [...sources.keys()].sort();
  if (!destination) return [];
  checkDestination(destination, selection, paths);
  return [
    { path: destination, clearDirectory: true, selectedContext: selection, selectedPaths: paths, text: '', secret: false },
    ...[...sources].map(([relative, source]) => ({ path: path.join(destination, relative), copyFileFrom: source, text: '', secret: false })),
    { path: path.join(destination, MARKER), text: `${JSON.stringify({ owner: 'promptobus-selected-context', task: selection.task, paths })}\n`, secret: false },
  ];
}

export function assertSelectedNativeFiles(files: LaunchFile[]) {
  for (const file of files) if (file.clearDirectory) checkDestination(file.path, file.selectedContext!, file.selectedPaths!);
  for (const file of files) if (file.selectedContext && path.basename(file.path) === 'plugin.json'
    && path.basename(path.dirname(file.path)) === '.claude-plugin') {
    assertNativePluginManifest(path.dirname(path.dirname(file.path)), file.selectedContext, file.text);
  }
  for (const file of files) if (file.copyFileFrom) {
    const source = openSelectedNativeSource(file.copyFileFrom);
    closeSync(source.fd);
  }
}

export function writeSelectedNativeFile(file: LaunchFile) {
  if (file.clearDirectory) { rmSync(file.path, { recursive: true, force: true }); mkdirSync(file.path, { recursive: true }); }
  else if (file.copyFileFrom) {
    const source = openSelectedNativeSource(file.copyFileFrom);
    let destination;
    try {
      mkdirSync(path.dirname(file.path), { recursive: true });
      destination = openSync(file.path, 'w', source.stat.mode & 0o777);
      const buffer = Buffer.alloc(64 * 1024);
      let count;
      while ((count = readSync(source.fd, buffer, 0, buffer.length, null)) > 0) {
        let written = 0;
        while (written < count) written += writeSync(destination, buffer, written, count - written, null);
      }
      chmodSync(file.path, source.stat.mode & 0o777);
    } finally { if (destination !== undefined) closeSync(destination); closeSync(source.fd); }
  }
  else return false;
  return true;
}

export function installSelectedNativeFiles(files: LaunchFile[]) {
  assertSelectedNativeFiles(files);
  for (const file of files) {
    if (writeSelectedNativeFile(file)) continue;
    mkdirSync(path.dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.text);
  }
}
