// Host contract: знание о рабочем месте, которое потребитель передаёт шине явно
// на каждый вызов. Process-wide singleton'а нет: два host'а в одном
// процессе законны и независимы.
//
// Имена полей — про рабочее место вообще, не про раскладку какого-то одного
// потребителя. Конкретные пути (каталог правил, манифест инструментов) называет
// реализация.

import path from 'node:path';

/** Маркер объекта host: им набор отличает host от корня-строки. */
export const HOST_KIND = 'promptobus-host';

export interface HostRepo {
  nsPath: string;
  abs: string;
  via: string;
  group?: boolean;
}

export interface HostRepoCandidate {
  nsPath: string;
  kind?: string;
  personal?: boolean;
}

export class HostResolveError extends Error {
  readonly candidates: HostRepoCandidate[];

  constructor(message: string, candidates: HostRepoCandidate[] = []) {
    super(message);
    this.name = 'HostResolveError';
    this.candidates = candidates;
  }
}

export interface HostModuleNote {
  level: 'info' | 'warn';
  text: string;
}

export interface HostRepoModule {
  name: string;
  dir: string;
  via: string;
  meta: { review?: { skill?: string } } | null;
}

export interface HostServers {
  servers: Record<string, unknown>;
  external: string[];
}

export interface HostFreshness {
  branch: string | null;
  checkout: string | null;
  behind: number | null;
  ahead: number | null;
  headBehindDefault: number | null;
  checkoutBehind: number | null;
  checkoutAhead: number | null;
  dirty: boolean | null;
  updated: boolean;
  warnings: string[];
}

export interface HostToolBin {
  ok: boolean;
  bin?: string;
  note?: string;
  warn?: string;
  reason?: string;
}

/**
 * Прежний store, если у этого рабочего места он бывает.
 * `rel` — от корня рабочего места, ровно два сегмента через `/`: внешний каталог и store
 * внутри него. Сегменты непустые, не `.` и не `..`; абсолютный путь и `\\` — ошибка формы,
 * а не «legacy нет». `done` — команда закрытия активных задач прежнего CLI, плейсхолдер `<id>`.
 */
export interface HostLegacyLayout {
  rel: string;
  done: string;
}

export interface PromptobusHost {
  readonly kind: typeof HOST_KIND;
  readonly id: string;
  readonly commandName: string;
  readonly version: string;
  readonly locale: string;

  workspaceRoot(): string;
  promptobusHome(): string;
  findRoot(cwd: string): string | null;

  nodePath(): string;
  /** Точка входа CLI, которой подняли этот вызов — ею объявлен stdio-сервер шины участника. */
  binPath(): string;
  /** Точка входа, которую пишут на диск (hooks). У standalone совпадает с binPath. */
  layoutBinPath(): string;

  toolsManifestRel(): string;
  skillsDir(): string | null;
  pluginDir(): string | null;
  pluginManifestRel(): string;
  busHookRel(): string;
  installManifestRel(): string;
  reposRoot(): string;
  pluginSkillsRel(): string;

  declaredTools(): string[];
  collectRules(repoDir: string): string[];
  moduleNote(repoDir: string): HostModuleNote;
  resolveRepoModule(repoDir: string): HostRepoModule | null;
  reviewSkillDir(name: string): string;

  participantServers(): HostServers;
  memorySection(toolName: (server: string, name: string) => string): string | null;

  resolveRepo(query: string): Promise<HostRepo>;
  repoAbsPath(nsPath: string): string;
  isClone(abs: string): boolean;
  formatCandidate(candidate: HostRepoCandidate): string;
  inWorkspace(abs: string): boolean;
  /**
   * Отказ reviewer'а по раскладке клонов. `null` — этот вид отказа у host'а не действует
   * (standalone не требует пару group/repo).
   */
  reviewLayoutError(
    kind: 'not-clone' | 'outside' | 'no-clone' | 'need-pair' | 'cwd-outside' | 'cwd-need-pair' | 'ask-path',
    ctx?: { targetDir?: string; repoDir?: string; abs?: string; dir?: string },
  ): string | null;

  defaultBranch(repoDir: string): string | null;
  freshenRepo(repoDir: string): HostFreshness;
  reportFresh(result: HostFreshness, label: string): void;

  extraEnv(): Record<string, string>;
  resolveToolBin(name: string): HostToolBin;
  substituteVars(value: unknown): unknown;
  /**
   * Откуда мигрировать и чем закрывать прежние задачи. `null` — мигрировать не из чего;
   * так у standalone и у любого host'а без истории прежнего store.
   */
  legacyLayout(): HostLegacyLayout | null;

  formatCommand(args: string[]): string;
  formatNpx(args: string[]): string;
  busCommand(args: string[]): string;
  cloneHint(nsPath: string): string;
  syncHint(): string;
  workerPreamble(ctx: { taskId: string; nsPath: string; branch: string }): string;
  liveRunNote(nsPath: string): string;
}

export function isPromptobusHost(value: unknown): value is PromptobusHost {
  if (!value || typeof value !== 'object') return false;
  const rec = value as { kind?: unknown; workspaceRoot?: unknown; commandName?: unknown };
  return rec.kind === HOST_KIND
    && typeof rec.workspaceRoot === 'function'
    && typeof rec.commandName === 'string';
}

export function homeOfRoot(root: string, rel = '.promptobus'): string {
  return path.join(root, rel);
}
