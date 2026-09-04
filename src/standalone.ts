// Standalone host: рабочее место из cwd, Git и promptobus.json. Раскладки чужого
// механизма, удалённых namespace и серверов памяти здесь нет — это дело реализации
// потребителя.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  HOST_KIND, HostResolveError, homeOfRoot,
} from './host.js';
import type {
  HostFreshness, HostModuleNote, HostRepo, HostRepoCandidate, HostRepoModule,
  HostServers, HostToolBin, PromptobusHost,
} from './host.js';

export const HOST_CONFIG = 'promptobus.json';

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT = 32 * 1024 * 1024;

export interface StandaloneHostOptions {
  cwd?: string;
  home?: string;
  id?: string;
  commandName?: string;
  version?: string;
  locale?: string;
  nodePath?: string;
  binPath?: string;
  extraEnv?: Record<string, string>;
  config?: Record<string, unknown>;
}

interface HostFile {
  commandName?: string;
  locale?: string;
  version?: string;
  tools?: string[];
  rules?: string[];
  mcp?: Record<string, unknown>;
  skills?: string;
}

function readConfig(file: string): HostFile {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as HostFile : {};
  } catch {
    return {};
  }
}

function findConfig(start: string): { root: string; config: HostFile } {
  let dir = path.resolve(start);
  for (;;) {
    const file = path.join(dir, HOST_CONFIG);
    if (existsSync(file)) return { root: dir, config: readConfig(file) };
    const parent = path.dirname(dir);
    if (parent === dir) return { root: path.resolve(start), config: {} };
    dir = parent;
  }
}

function git(repo: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0 ? (r.stdout ?? '').trim() : null;
}

function isDiskPath(target: string): boolean {
  return /^\.{1,2}([\\/]|$)/.test(target) || path.isAbsolute(target);
}

function defaultBranchOf(repoDir: string): string | null {
  const head = git(repoDir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head) return head.replace(/^refs\/remotes\/origin\//, '');
  for (const br of ['master', 'main']) {
    if (git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${br}`]) !== null) {
      return br;
    }
  }
  return git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export function createStandaloneHost(options: StandaloneHostOptions = {}): PromptobusHost {
  const found = findConfig(options.cwd ?? '.');
  const config: HostFile = { ...found.config, ...(options.config ?? {}) };
  const root = found.root;
  const commandName = options.commandName ?? config.commandName ?? 'promptobus';
  const version = options.version ?? config.version ?? '0.0.0';
  const locale = options.locale ?? config.locale ?? 'en';
  const nodePath = options.nodePath ?? process.execPath;
  const binPath = options.binPath ?? nodePath;
  const extra = { ...(options.extraEnv ?? {}) };
  const home = options.home ?? homeOfRoot(root);
  const tools = Array.isArray(config.tools) ? config.tools.map(String) : [];
  const ruleFiles = Array.isArray(config.rules) ? config.rules.map(String) : [];
  const mcp = config.mcp && typeof config.mcp === 'object' ? config.mcp : {};
  const skills = typeof config.skills === 'string' ? config.skills : null;

  const host: PromptobusHost = {
    kind: HOST_KIND,
    id: options.id ?? 'standalone',
    commandName,
    version,
    locale,

    workspaceRoot: () => root,
    promptobusHome: () => home,
    findRoot: (cwd) => {
      const hit = findConfig(cwd);
      return existsSync(path.join(hit.root, HOST_CONFIG)) ? hit.root : path.resolve(cwd);
    },

    nodePath: () => nodePath,
    binPath: () => binPath,
    layoutBinPath: () => binPath,

    toolsManifestRel: () => HOST_CONFIG,
    skillsDir: () => (skills ? path.join(root, skills) : null),
    pluginDir: () => null,
    pluginManifestRel: () => path.join('.promptobus', 'plugin.json'),
    busHookRel: () => path.join('.promptobus', 'hooks', 'bus.mjs'),
    installManifestRel: () => path.join('.promptobus', 'manifest.json'),
    reposRoot: () => root,
    pluginSkillsRel: () => path.join('.promptobus', 'skills'),

    declaredTools: () => [...tools],
    collectRules: (repoDir) => {
      const files = [];
      const agents = path.join(repoDir, 'AGENTS.md');
      if (existsSync(agents)) files.push(agents);
      for (const rel of ruleFiles) {
        const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
        if (existsSync(abs)) files.push(abs);
      }
      return files;
    },
    moduleNote: (): HostModuleNote => ({
      level: 'info',
      text: 'модуль рабочего места не применяется — host standalone',
    }),
    resolveRepoModule: (): HostRepoModule | null => null,
    reviewSkillDir: (name) => path.join(root, '.promptobus', 'skills', name),

    participantServers: (): HostServers => ({
      servers: { ...mcp },
      external: [],
    }),
    memorySection: () => null,

    resolveRepo: async (query: string): Promise<HostRepo> => {
      if (!query) throw new HostResolveError('нужно имя или путь репозитория');
      const abs = isDiskPath(query) ? path.resolve(query) : path.resolve(root, query);
      if (!existsSync(abs)) {
        throw new HostResolveError(`«${query}» не найден на диске (${abs})`);
      }
      const rel = path.relative(root, abs);
      const nsPath = (!rel || rel.startsWith('..') || path.isAbsolute(rel))
        ? path.basename(abs)
        : rel.split(path.sep).join('/');
      return { nsPath, abs, via: 'путь на диске' };
    },
    repoAbsPath: (nsPath) => (path.isAbsolute(nsPath) ? nsPath : path.join(root, nsPath)),
    isClone: (abs) => existsSync(path.join(abs, '.git')),
    formatCandidate: (candidate: HostRepoCandidate) => candidate.nsPath,
    inWorkspace: (abs) => {
      const rel = path.relative(root, abs);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    },
    reviewLayoutError: (kind, ctx = {}) => {
      switch (kind) {
        case 'not-clone':
          return `${ctx.targetDir}: не клон — своего .git здесь нет (ближайший репозиторий выше: ${ctx.repoDir})`;
        case 'outside':
          return `${ctx.repoDir}: вне рабочего места`;
        case 'no-clone':
          return `${ctx.repoDir}: клон не найден`;
        case 'cwd-outside':
          return 'вне рабочего места';
        case 'ask-path':
          return 'Назови путь к git-репозиторию внутри рабочего места.';
        default:
          return null;
      }
    },

    defaultBranch: (repoDir) => defaultBranchOf(repoDir),
    freshenRepo: (repoDir): HostFreshness => {
      const res: HostFreshness = {
        branch: null, checkout: null, behind: null, ahead: null,
        headBehindDefault: null, checkoutBehind: null, checkoutAhead: null,
        dirty: null, updated: false, warnings: [],
      };
      const fetch = spawnSync('git', ['-C', repoDir, 'fetch', '--quiet', 'origin'], {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (fetch.status !== 0) {
        res.warnings.push(`fetch origin не удался: ${(fetch.stderr ?? '').toString().trim() || `exited ${fetch.status}`}`);
        return res;
      }
      res.updated = true;
      res.branch = defaultBranchOf(repoDir);
      res.checkout = git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const porcelain = git(repoDir, ['status', '--porcelain']);
      res.dirty = porcelain === null ? null : porcelain.length > 0;
      return res;
    },
    reportFresh: () => {
      // Package не пишет в stdout/stderr: доклад свежести — дело CLI-адаптера.
    },

    extraEnv: () => ({ ...extra }),
    resolveToolBin: (name): HostToolBin => ({ ok: true, bin: name }),
    substituteVars: (value) => value,
    legacyLayout: () => null,

    formatCommand: (args) => [commandName, ...args].join(' '),
    formatNpx: (args) => ['npx', commandName, ...args].join(' '),
    busCommand: (args) => [commandName, ...args].join(' '),
    cloneHint: (nsPath) => `git clone <url> ${nsPath}`,
    syncHint: () => `${commandName} install`,
    workerPreamble: ({ taskId, nsPath, branch }) => (
      `Ты — worker задачи ${taskId}. Твоя рабочая директория — изолированный git worktree `
      + `репозитория ${nsPath} (ветка ${branch}); правишь только его. Основное дерево репозитория `
      + 'не трогай: твой результат остаётся в этой ветке, забирает его оркестратор.'
    ),
    liveRunNote: () => '',
  };
  return host;
}
