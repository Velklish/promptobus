// What the installer knows and never writes.
// [guides/install.md#what-the-installer-knows-and-never-writes](../docs/guides/install.md#what-the-installer-knows-and-never-writes)

import {
  accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { info, ok, warn } from './util.js';
import { hostOf } from './host.js';
import { GateError } from './store.js';
import { resolveCommand } from './exec.js';
import { HOST_CONFIG } from '../dist/host-index.js';
import { findHostRoot } from '../dist/standalone.js';
import {
  BUS_HOOK_EVENT,
  GUARD_HOOK_EVENT,
  GUARD_START_EVENT,
  guardHookCommand,
} from '../dist/hooks.js';
import { CLAUDE_SKILLS_REL, CURSOR_SKILLS_REL, CODEX_SKILLS_REL } from './drivers.js';

import type { PromptobusHost } from '../dist/index.js';

export type InstallHarness = 'claude' | 'cursor' | 'codex';
export interface InstallTarget { readonly hooksRel: string; readonly skillsRel: string }
export interface PackageSkillFile { rel: string; abs: string; buffer: Uint8Array; text: string }
export interface PackageSkill { name: string; files: PackageSkillFile[] }
export type InstallPlanHost = Pick<PromptobusHost, 'nodePath' | 'guardArgv' | 'busHookRel' | 'installManifestRel'>;
export interface InstallWrite { rel: string; abs: string; text: string | null; buffer?: Uint8Array | null; remove?: true }
interface PlannedWrite extends InstallWrite { foreign?: boolean }
export interface InstallPlan {
  writes: InstallWrite[]; owned: Record<InstallHarness, string[]>;
  ownedSkills: Record<InstallHarness, string[]>; unproven: string[];
}
interface InstallOptions {
  env?: NodeJS.ProcessEnv; cwd?: string; harnesses?: unknown; check?: boolean; dryRun?: boolean; skillsDir?: string;
}
type HookStyle = 'nested' | 'flat';
type HookEvents = Record<string, unknown[]>;
interface HookContext {
  style: HookStyle; prevIds: Set<string>; oursIds?: Set<string>; busEvent: string; guardEvents: string[];
  guardCommand: string; nodePath: string; runnerRoot: string; runnerRel: string; label: string;
}
interface HookSpec {
  rel: string; skillsRel: string; style: HookStyle; busEvent: string; guardEvents: string[];
  events: (guardCmd: string) => HookEvents;
  wrap: (doc: Record<string, unknown>, hooks: HookEvents) => Record<string, unknown>;
}

export const INSTALL_HARNESSES: InstallHarness[] = ['claude', 'cursor', 'codex'];
export const HOME_HOOK_DIRS = ['.claude', '.cursor', '.codex'];
export const HARNESSES_FIELD = 'harnesses';
export const MANIFEST_KIND = 'promptobus-hooks';
export const SKILL_OWNERSHIP_MARKER: string = '<!-- promptobus:owned -->';
const GITIGNORE_BUFFER = Buffer.from('*\n');

// The same names as driver-cursor `KNOWN_HOOK_EVENTS`, held equal by the suite rather than
// imported: an unknown name in `.cursor/hooks.json` silently disables every hook in the file.
export const CURSOR_HOOK_EVENTS = [
  'beforeShellExecution', 'beforeMCPExecution', 'afterShellExecution', 'afterMCPExecution',
  'beforeReadFile', 'afterFileEdit', 'beforeTabFileRead', 'afterTabFileEdit', 'stop',
  'beforeSubmitPrompt', 'afterAgentResponse', 'afterAgentThought', 'sessionStart', 'sessionEnd',
  'preCompact', 'subagentStart', 'subagentStop', 'preToolUse', 'postToolUse', 'postToolUseFailure',
  'workspaceOpen',
];

// The five names a live spike drove, and the build the list above was read from — the same values
// as driver-cursor `PROVEN_HOOK_EVENTS` and `HOOK_EVENTS_SOURCE_VERSION`, held equal by the suite.
export const CURSOR_PROVEN_HOOK_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'stop', 'sessionEnd', 'afterFileEdit'];
export const CURSOR_HOOK_EVENTS_SOURCE_VERSION = '2026.09.10-fd3934a';

const TRUST_NOTE = 'Review: Codex requires /hooks; project hooks also depend on workspace trust.';
// `harnesses` records where hooks went; `tools` is the spawn allow-list and install never
// writes it. Said here because the next command otherwise refuses ([guides/install.md#2-workspace-file](../docs/guides/install.md#2-workspace-file)).
const declareNote = (missing: readonly string[]) =>
  `Spawn allow-list: "tools" in ${HOST_CONFIG} does not list ${missing.join(', ')}, and install does not write it`
  + ` — "harnesses" only records where hooks went. spawn and review refuse an undeclared harness;`
  + ` add ${missing.map((name) => `"${name}"`).join(', ')} to the "tools" array by hand.`;
const CURSOR_NOTE = 'Cursor: the stop guard only, with no SessionStart. Bus text reaches a Cursor participant by driver injection.';

// Names the gate lets through on the inventory of ONE build, with no spike behind them.
export function cursorUnprovenHookEvents(hooks: unknown) {
  return Object.keys(hooks ?? {}).filter((event) => CURSOR_HOOK_EVENTS.includes(event)
    && !CURSOR_PROVEN_HOOK_EVENTS.includes(event));
}

// A warning and never a refusal: the name is legal on the build the inventory was read from, and
// refusing it would refuse a hooks file that works today.
const unprovenNote = (names: readonly string[]) =>
  `Cursor: ${names.map((event) => `"${event}"`).join(', ')} in .cursor/hooks.json — known from the`
  + ` ${CURSOR_HOOK_EVENTS_SOURCE_VERSION} bundle inventory and never seen firing here. The gate reads that one`
  + ' build: on a build that does not know the name, every hook in the file is disabled in silence.';

export function assertCursorHookEvents(hooks: unknown) {
  const unknown = Object.keys(hooks ?? {}).filter((event) => !CURSOR_HOOK_EVENTS.includes(event));
  if (unknown.length) {
    throw new GateError(
      `install: unknown Cursor hook event ${unknown.map((event) => `"${event}"`).join(', ')} — known: ${CURSOR_HOOK_EVENTS.join(', ')}`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function jsonText(doc: unknown) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function platformOf() {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

function under(abs: string, root: string) {
  const resolved = path.resolve(abs);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(base + path.sep);
}

export function homeHookRoots(env = process.env) {
  const homes = new Set([env?.HOME, env?.USERPROFILE, os.homedir()].filter(Boolean) as string[]);
  const roots = [];
  for (const home of homes) {
    for (const name of HOME_HOOK_DIRS) roots.push(path.resolve(home, name));
  }
  return roots;
}

export function parseHarnessList(raw: unknown) {
  if (raw === undefined || raw === null || raw === '') {
    throw new GateError('install: --harnesses is empty');
  }
  const parts = (Array.isArray(raw) ? raw as unknown[] : String(raw).split(','))
    .map((part) => String(part).trim())
    .filter(Boolean);
  if (!parts.length) throw new GateError('install: --harnesses is empty');
  const unknown = [...new Set(parts)].filter((name) => !(INSTALL_HARNESSES as readonly string[]).includes(name));
  if (unknown.length) {
    throw new GateError(
      `install: unknown harness ${unknown.map((name) => `"${name}"`).join(', ')} — known: ${INSTALL_HARNESSES.join(', ')}`,
    );
  }
  return INSTALL_HARNESSES.filter((name) => parts.includes(name));
}

export function resolveProjectRoot(host: Pick<PromptobusHost, 'workspaceRoot'>, cwd?: string) {
  const start = path.resolve(cwd ?? host.workspaceRoot());
  const found = findHostRoot(start);
  if (found) return found;
  const git = spawnSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 15_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (git.status === 0) {
    const top = String(git.stdout ?? '').trim();
    if (top) return top;
  }
  return path.resolve(host.workspaceRoot());
}

function readJsonObject(abs: string, label: string): { missing: boolean; doc: Record<string, unknown>; text: string | null } {
  if (!existsSync(abs)) return { missing: true, doc: {}, text: null };
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (e) {
    throw new GateError(`install: cannot read ${label}: ${(e as Error).message}`);
  }
  if (!String(raw).trim()) return { missing: false, doc: {}, text: raw };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GateError(`install: ${label} is not valid JSON — fix it and retry`);
  }
  if (!isPlainObject(parsed)) {
    throw new GateError(`install: ${label} must be a JSON object — fix it and retry`);
  }
  return { missing: false, doc: parsed, text: raw };
}

function hookHostOf(host: InstallPlanHost, root: string) {
  return {
    commandName: (host as Partial<Pick<PromptobusHost, 'commandName'>>).commandName,
    syncHint: () => (host as Partial<Pick<PromptobusHost, 'syncHint'>>).syncHint!(),
    nodePath: () => host.nodePath(),
    guardArgv: (args: string[]) => host.guardArgv(args),
    workspaceRoot: () => root,
    busHookRel: () => host.busHookRel(),  // the path an old feed hook is recognised by
  };
}

function groupCommand(raw: unknown, style: HookStyle) {
  const group = raw as { command?: unknown; hooks?: { command?: unknown }[] } | null;
  if (style === 'flat') return typeof group?.command === 'string' ? group.command : '';
  return typeof group?.hooks?.[0]?.command === 'string' ? group.hooks[0].command : '';
}

function hookGroupId(event: string, raw: unknown, style: HookStyle) {
  const group = raw as { matcher?: unknown } | null;
  const matcher = typeof group?.matcher === 'string' ? group.matcher : '';
  return matcher ? `${event}:${matcher}` : `${event}::${groupCommand(group, style)}`;
}

function ownedIds(events: HookEvents, style: HookStyle) {
  const ids = [];
  for (const [event, groups] of Object.entries(events)) {
    for (const group of groups) ids.push(hookGroupId(event, group, style));
  }
  return ids;
}

// Only commands rendered by guardHookCommand are recognised; hand-edited
// settings are not a supported input.
const GUARD_VALUE = String.raw`"(?:[^"]|"")*"|'(?:[^']|'\\'')*'|[^\s"']+`;
const GUARD_SIGNATURE = new RegExp(
  String.raw`^"[^"-][^"]*" "[^"-][^"]*"(?: [^\s"'-][^\s"']*)* guard(?: --role (?:${GUARD_VALUE}) --task (?:${GUARD_VALUE}) --home (?:${GUARD_VALUE}))?$`,
);

function isGuardCommand(command: unknown) {
  return GUARD_SIGNATURE.test(String(command));
}

function legacyExecutable(command: string) {
  const resolved = resolveCommand(command);
  if (!resolved) return null;
  const candidates = path.isAbsolute(resolved) ? [resolved] : resolved === path.basename(resolved)
    ? String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, resolved)) : [];
  for (const file of candidates) {
    try {
      accessSync(file, constants.X_OK);
      const entry = statSync(file);
      if (entry.isFile()) return entry;
    } catch { /* An unresolved executable supplies no ownership evidence. */ }
  }
  return null;
}

function isLegacyFeedback(group: unknown, ctx: HookContext) {
  if (ctx.style === 'nested') {
    if (!isPlainObject(group) || !Array.isArray(group.hooks) || group.hooks.length !== 1
      || !isPlainObject(group.hooks[0]) || group.hooks[0].type !== 'command') return false;
  }
  const match = /^"([^"]+)" "([^"]+)"$/.exec(groupCommand(group, ctx.style));
  if (!match || !path.isAbsolute(match[2])
    || !match[2].endsWith(path.sep + ctx.runnerRel)) return false;
  const executable = legacyExecutable(match[1]), node = legacyExecutable(ctx.nodePath);
  if (!executable || !node || executable.dev !== node.dev || executable.ino !== node.ino) return false;
  const root = match[2].slice(0, -ctx.runnerRel.length);
  try { return realpathSync(root) === realpathSync(ctx.runnerRoot); }
  catch { return false; }
}

function isOwnedGroup(event: string, group: unknown, ctx: HookContext & { oursIds: Set<string> }) {
  const id = hookGroupId(event, group, ctx.style);
  if (ctx.prevIds.has(id) || ctx.oursIds.has(id)) return true;
  const cmd = groupCommand(group, ctx.style);
  if (!cmd) return false;
  // Resolve only the trusted root alias; the legacy runner's owned suffix stays exact.
  if (event === ctx.busEvent) return isLegacyFeedback(group, ctx);
  if (ctx.guardEvents.includes(event)) {
    return cmd === ctx.guardCommand
      || isGuardCommand(cmd);
  }
  return false;
}

function mergeHookEvents(existingHooks: unknown, ourEvents: HookEvents, ctx: HookContext) {
  if (existingHooks != null && !isPlainObject(existingHooks)) {
    throw new GateError(`install: ${ctx.label} hooks value is not an object — fix it and retry`);
  }
  const oursIds = new Set<string>();
  for (const [event, groups] of Object.entries(ourEvents)) {
    for (const group of groups) oursIds.add(hookGroupId(event, group, ctx.style));
  }
  const rest: HookEvents = {};
  let removed = false;
  for (const [event, groups] of Object.entries(existingHooks ?? {})) {
    if (!Array.isArray(groups)) {
      throw new GateError(`install: ${ctx.label} hooks.${event} is not an array — fix it and retry`);
    }
    const left = groups.filter((group) => !isOwnedGroup(event, group, { ...ctx, oursIds }));
    if (left.length !== groups.length) removed = true;
    if (left.length) rest[event] = left;
  }
  for (const [event, groups] of Object.entries(ourEvents)) {
    rest[event] = [...(rest[event] ?? []), ...groups];
  }
  return { hooks: rest, removed };
}

function nestedGroup(command: string, matcher?: string) {
  const hooks = [{ type: 'command', command }];
  return matcher ? { matcher, hooks } : { hooks };
}

function claudeEvents(guardCmd: string) {
  return {
    [GUARD_HOOK_EVENT]: [nestedGroup(guardCmd)],
    [GUARD_START_EVENT]: [nestedGroup(guardCmd)],
  };
}

function cursorEvents(guardCmd: string) {
  return { stop: [{ command: guardCmd }] };
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_SKILLS_DIR = path.join(PACKAGE_ROOT, 'skills');

export function packageSkills(skillsDir = PACKAGE_SKILLS_DIR) {
  if (!existsSync(skillsDir)) {
    throw new GateError('install: package skills directory is missing');
  }
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch (e) {
    throw new GateError(`install: cannot read package skills directory: ${(e as Error).message}`);
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new GateError(`install: package skills contains symlink at ${entry.name}`);
    }
  }
  const skillDirs = entries.filter((e) => e.isDirectory());
  if (!skillDirs.length) {
    throw new GateError('install: package skills directory has no skills');
  }
  const skills: PackageSkill[] = [];
  for (const entry of skillDirs) {
    const skillName = entry.name;
    const skillBase = path.join(skillsDir, skillName);
    const files: PackageSkillFile[] = [];
    const walk = (dir: string, rel = ''): void => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const itemRel = rel ? path.join(rel, item.name) : item.name;
        const itemAbs = path.join(dir, item.name);
        if (item.isSymbolicLink()) {
          throw new GateError(`install: package skills contains symlink at ${itemRel || item.name}`);
        }
        if (item.isDirectory()) {
          walk(itemAbs, itemRel);
        } else if (item.isFile()) {
          const buffer = readFileSync(itemAbs);
          const text = buffer.toString('utf8');
          files.push({ rel: itemRel, abs: itemAbs, buffer, text });
        }
      }
    };
    walk(skillBase);
    files.sort((a, b) => a.rel.localeCompare(b.rel));
    skills.push({ name: skillName, files });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

const SPECS: Record<InstallHarness, HookSpec> = {
  claude: {
    rel: path.join('.claude', 'settings.json'),
    skillsRel: CLAUDE_SKILLS_REL,
    style: 'nested',
    busEvent: BUS_HOOK_EVENT,
    guardEvents: [GUARD_HOOK_EVENT, GUARD_START_EVENT],
    events: claudeEvents,
    wrap(doc, hooks) {
      const next: Record<string, unknown> = { ...doc };
      if (Object.keys(hooks).length) next.hooks = hooks;
      else delete next.hooks;
      return next;
    },
  },
  cursor: {
    rel: path.join('.cursor', 'hooks.json'),
    skillsRel: CURSOR_SKILLS_REL,
    style: 'flat',
    // busEvent is only for stripping a leftover bus group from an older install.
    // Owned Cursor writes are `stop` alone, and were while the feed hook was written too.
    busEvent: 'postToolUse',
    guardEvents: ['stop'],
    events: cursorEvents,
    wrap(doc, hooks) {
      const next: Record<string, unknown> = { ...doc };
      if (next.version === undefined) next.version = 1;
      next.hooks = hooks;
      return next;
    },
  },
  codex: {
    rel: path.join('.codex', 'hooks.json'),
    skillsRel: CODEX_SKILLS_REL,
    style: 'nested',
    busEvent: BUS_HOOK_EVENT,
    guardEvents: [GUARD_HOOK_EVENT, GUARD_START_EVENT],
    events: claudeEvents,
    wrap(doc, hooks) {
      const next: Record<string, unknown> = { ...doc };
      next.hooks = hooks;
      return next;
    },
  },
};

// Where each harness's hook file and package skills land, relative to the project root.
export const INSTALL_TARGETS = Object.freeze(Object.fromEntries(INSTALL_HARNESSES.map((name) => [
  name, Object.freeze({ hooksRel: SPECS[name].rel, skillsRel: SPECS[name].skillsRel }),
]))) as Readonly<Record<InstallHarness, InstallTarget>>;

// Read, never written here: the two keys stay two, and writing a hook file must not imply
// permission to spawn.
function declaredTools(doc: Record<string, unknown> | null | undefined) {
  return Array.isArray(doc?.tools) ? doc.tools.map(String) : [];
}

function savedHarnesses(doc: Record<string, unknown> | null | undefined) {
  if (!doc || !Object.hasOwn(doc, HARNESSES_FIELD)) return null;
  if (!Array.isArray(doc[HARNESSES_FIELD])) {
    throw new GateError(`install: ${HOST_CONFIG} ${HARNESSES_FIELD} must be an array`);
  }
  if (!doc[HARNESSES_FIELD].length) return [];
  return parseHarnessList(doc[HARNESSES_FIELD]);
}

function readOwned(root: string, host: Pick<PromptobusHost, 'installManifestRel'>) {
  const rel = host.installManifestRel();
  const abs = path.join(root, rel);
  const got = readJsonObject(abs, rel);
  const raw = isPlainObject(got.doc.owned) ? got.doc.owned : {};
  const owned = {} as Record<InstallHarness, string[]>;
  for (const name of INSTALL_HARNESSES) {
    owned[name] = Array.isArray(raw[name]) ? raw[name].map(String) : [];
  }
  const rawSkills = isPlainObject(got.doc.ownedSkills) ? got.doc.ownedSkills : {};
  const ownedSkills = {} as Record<InstallHarness, string[]>;
  for (const name of INSTALL_HARNESSES) {
    ownedSkills[name] = Array.isArray(rawSkills[name]) ? rawSkills[name].map(String) : [];
  }
  return { abs, rel, doc: got.doc, missing: got.missing, owned, ownedSkills };
}

function pruneEmptyDirs(dir: string, stopDir: string) {
  let current = path.resolve(dir);
  const stop = path.resolve(stopDir);
  while (current && current !== stop && current.startsWith(stop + path.sep)) {
    if (!existsSync(current)) {
      current = path.dirname(current);
      continue;
    }
    try {
      const entries = readdirSync(current);
      if (entries.length === 0) {
        rmSync(current, { force: true, recursive: true });
        current = path.dirname(current);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

function assertNotHomeWrites(writes: readonly PlannedWrite[], env: NodeJS.ProcessEnv) {
  const banned = homeHookRoots(env);
  for (const write of writes) {
    for (const root of banned) {
      if (under(write.abs, root)) {
        throw new GateError(`install: refuses to write user-level hooks (${write.rel})`);
      }
    }
  }
}

function applyWrites(writes: readonly PlannedWrite[]) {
  const staged: { tmp: string; abs: string }[] = [];
  try {
    for (const write of writes) {
      mkdirSync(path.dirname(write.abs), { recursive: true });
      const tmp = path.join(
        path.dirname(write.abs),
        `.tmp-${path.basename(write.abs)}-${process.pid}-${staged.length}`,
      );
      if (write.buffer) {
        writeFileSync(tmp, write.buffer);
      } else {
        writeFileSync(tmp, write.text!);
      }
      staged.push({ tmp, abs: write.abs });
    }
    for (const item of staged) renameSync(item.tmp, item.abs);
  } catch (e) {
    for (const item of staged) {
      try { rmSync(item.tmp, { force: true, recursive: true }); } catch { /* leftover tmp */ }
    }
    throw e;
  }
}

function pendingWrites(writes: readonly PlannedWrite[]) {
  return writes.filter((write) => {
    if (write.remove) return existsSync(write.abs);
    if (!existsSync(write.abs)) return true;
    if (write.foreign) return true;
    if (write.buffer) {
      try {
        const current = readFileSync(write.abs);
        return !current.equals(write.buffer);
      } catch {
        return true;
      }
    }
    const current = readFileSync(write.abs, 'utf8');
    return current !== write.text;
  });
}

function isSkillFileOwned(abs: string, rel: string, prevOwnedSet: Set<string>) {
  if (prevOwnedSet.has(rel)) return true;
  if (!existsSync(abs)) return true;
  if (path.basename(abs) === '.gitignore') {
    try {
      const content = readFileSync(abs, 'utf8');
      if (content.trim() === '*') return true;
    } catch {
      return false;
    }
  }
  try {
    const content = readFileSync(abs, 'utf8');
    if (content.includes(SKILL_OWNERSHIP_MARKER)) return true;
  } catch {
    return false;
  }
  return false;
}

export function planHookInstall(
  host: InstallPlanHost, root: string, wanted: readonly InstallHarness[], { check = false, dryRun = false, skillsDir = PACKAGE_SKILLS_DIR } = {},
) {
  const unproven: string[] = [];
  const hookHost = hookHostOf(host, root);
  const platform = platformOf();
  const runnerRel = host.busHookRel();
  const runnerAbs = path.join(root, runnerRel);
  const guardCmd = guardHookCommand(hookHost, null, platform);
  const prev = readOwned(root, host);
  const writes: PlannedWrite[] = [];
  const owned = {} as Record<InstallHarness, string[]>;
  const ownedSkills = {} as Record<InstallHarness, string[]>;
  const pSkills = wanted.length ? packageSkills(skillsDir) : [];

  // Nothing writes the runner any more; an install that finds one deletes it.
  if (existsSync(runnerAbs)) writes.push({ rel: runnerRel, abs: runnerAbs, text: null, remove: true });

  for (const name of INSTALL_HARNESSES) {
    const spec = SPECS[name];
    const selected = wanted.includes(name);
    const prevIds = new Set(prev.owned[name] ?? []);
    const fileAbs = path.join(root, spec.rel);
    const existing = readJsonObject(fileAbs, spec.rel);
    if (!selected && existing.missing && !prevIds.size) {
      owned[name] = [];
    } else {
      const ourEvents = selected ? spec.events(guardCmd) : {};
      const merged = mergeHookEvents(existing.doc.hooks, ourEvents, {
        style: spec.style,
        prevIds,
        busEvent: spec.busEvent,
        guardEvents: spec.guardEvents,
        guardCommand: guardCmd,
        nodePath: host.nodePath(),
        runnerRoot: root,
        runnerRel,
        label: spec.rel,
      });
      const { hooks } = merged;
      if (name === 'cursor') {
        assertCursorHookEvents(hooks);
        unproven.push(...cursorUnprovenHookEvents(hooks));
      }
      owned[name] = selected ? ownedIds(ourEvents, spec.style) : [];
      if (selected || merged.removed) {
        writes.push({ rel: spec.rel, abs: fileAbs, text: jsonText(spec.wrap(existing.doc, hooks)) });
      }
    }

    const currentOwnedSkills: string[] = [];
    if (selected) {
      if (!spec.skillsRel) {
        throw new GateError(`install: harness ${name} has no declared skills location`);
      }
      const prevSkillsSet = new Set(prev.ownedSkills[name] ?? []);
      for (const skill of pSkills) {
        for (const file of skill.files) {
          const rel = path.join(spec.skillsRel, skill.name, file.rel);
          const abs = path.join(root, rel);
          const foreign = existsSync(abs) && !isSkillFileOwned(abs, rel, prevSkillsSet);
          if (foreign && !check && !dryRun) {
            throw new GateError(`install: ${rel} already exists and is not owned by promptobus — remove or rename it and retry`);
          }
          writes.push({ rel, abs, buffer: file.buffer, text: file.text, foreign });
          currentOwnedSkills.push(rel);
        }
        const giRel = path.join(spec.skillsRel, skill.name, '.gitignore');
        const giAbs = path.join(root, giRel);
        const foreignGi = existsSync(giAbs) && !isSkillFileOwned(giAbs, giRel, prevSkillsSet);
        if (foreignGi && !check && !dryRun) {
          throw new GateError(`install: ${giRel} already exists and is not owned by promptobus — remove or rename it and retry`);
        }
        writes.push({ rel: giRel, abs: giAbs, buffer: GITIGNORE_BUFFER, text: '*\n', foreign: foreignGi });
        currentOwnedSkills.push(giRel);
      }
    }
    currentOwnedSkills.sort();
    ownedSkills[name] = currentOwnedSkills;

    const prevSkills = new Set(prev.ownedSkills[name] ?? []);
    for (const rel of prevSkills) {
      if (!currentOwnedSkills.includes(rel)) {
        const abs = path.join(root, rel);
        writes.push({ rel, abs, text: null, buffer: null, remove: true });
      }
    }
  }

  return { writes, owned, ownedSkills, prev, hookHost, runnerAbs, runnerRel, unproven };
}

function configWrite(root: string, doc: Record<string, unknown>, wanted: readonly InstallHarness[]) {
  const next: Record<string, unknown> = { ...doc };
  if (wanted.length) next[HARNESSES_FIELD] = wanted;
  else delete next[HARNESSES_FIELD];
  return {
    rel: HOST_CONFIG,
    abs: path.join(root, HOST_CONFIG),
    text: jsonText(next),
  };
}

function manifestWrite(root: string, host: InstallPlanHost, prev: ReturnType<typeof readOwned>, wanted: readonly InstallHarness[], owned: InstallPlan['owned'], ownedSkills: InstallPlan['ownedSkills']) {
  const next = {
    ...prev.doc,
    version: 1,
    kind: MANIFEST_KIND,
    [HARNESSES_FIELD]: wanted,
    owned,
    ownedSkills,
  };
  return {
    rel: host.installManifestRel(),
    abs: path.join(root, host.installManifestRel()),
    text: jsonText(next),
  };
}

function driftOf(pending: readonly PlannedWrite[], wanted: readonly InstallHarness[], saved: readonly InstallHarness[] | null) {
  const drifts = [];
  const savedList = saved ?? [];
  if (savedList.join(',') !== wanted.join(',')) drifts.push(`${HOST_CONFIG} ${HARNESSES_FIELD}`);
  for (const write of pending) {
    if (write.rel === HOST_CONFIG) {
      if (!drifts.includes(HOST_CONFIG) && !drifts.includes(`${HOST_CONFIG} ${HARNESSES_FIELD}`)) {
        drifts.push(HOST_CONFIG);
      }
    } else if (write.foreign) {
      drifts.push(`${write.rel} — not owned by promptobus`);
    } else {
      drifts.push(write.rel);
    }
  }
  return [...new Set(drifts)];
}

function resolveWanted(_host: PromptobusHost, opts: InstallOptions, cfg: ReturnType<typeof readJsonObject>) {
  if (opts.harnesses !== undefined) return parseHarnessList(opts.harnesses);
  return savedHarnesses(cfg.doc);
}

function runPlan(host: PromptobusHost, opts: InstallOptions, { wanted, uninstalling }: { wanted?: readonly InstallHarness[]; uninstalling: boolean }) {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? host.workspaceRoot();
  const root = resolveProjectRoot(host, cwd);
  const cfg = readJsonObject(path.join(root, HOST_CONFIG), HOST_CONFIG);
  const selected = wanted ?? resolveWanted(host, opts, cfg);
  const check = !!opts.check;
  const dryRun = !!opts.dryRun;
  const skillsDir = opts.skillsDir ?? PACKAGE_SKILLS_DIR;

  if (selected == null) {
    if (check) {
      warn('drift: hooks are not installed');
      return 1;
    }
    if (dryRun) {
      info('dry-run: nothing to install (no --harnesses, no saved list)');
      return 0;
    }
    if (uninstalling) {
      ok('nothing to uninstall');
      return 0;
    }
    throw new GateError(`install: --harnesses is required on the first install (no saved list in ${HOST_CONFIG})`);
  }

  const plan = planHookInstall(host, root, selected, { check, dryRun, skillsDir });
  // Before the branches part, and `uninstall` comes through here too: the file is the same one on
  // check, dry-run, apply and uninstall, and an inventory-only group stays in it on all four.
  if (plan.unproven.length) warn(unprovenNote(plan.unproven));
  const cfgWrite = configWrite(root, cfg.doc, selected);
  const manWrite = manifestWrite(root, host, plan.prev, selected, plan.owned, plan.ownedSkills);
  const diskWrites: PlannedWrite[] = [...plan.writes, cfgWrite, manWrite];
  assertNotHomeWrites(diskWrites.filter((w) => !w.remove), env);
  // The manifest joins the same content delta: this catches an absent or field-changed
  // manifest, not foreign keys inside an existing one, which manifestWrite spreads from prev.doc.
  const pending = pendingWrites(diskWrites);

  if (check) {
    const saved = savedHarnesses(cfg.doc);
    const drifts = driftOf(pending, selected, saved);
    if (drifts.length) {
      for (const rel of drifts) warn(`drift: ${rel}`);
      return 1;
    }
    ok('configured');
    return 0;
  }

  if (dryRun) {
    for (const write of pending) {
      if (write.remove) info(`dry-run: would remove ${write.rel}`);
      else if (write.foreign) info(`dry-run: would refuse ${write.rel} — not owned by promptobus`);
      else info(`dry-run: would write ${write.rel}`);
    }
    ok('dry-run: nothing written');
    return 0;
  }

  const removals = [];
  const writes: PlannedWrite[] = [];
  for (const write of pending) {
    if (write.remove) {
      removals.push(write);
      continue;
    }
    writes.push(write);
  }
  applyWrites(writes);
  for (const write of removals) {
    rmSync(write.abs, { force: true });
    pruneEmptyDirs(path.dirname(write.abs), root);
  }
  if (uninstalling) ok(selected.length ? `uninstalled; remaining ${selected.join(', ')}` : 'uninstalled');
  else {
    ok('configured');
    if (selected.includes('codex') || selected.includes('claude')) info(TRUST_NOTE);
    if (selected.includes('cursor')) info(CURSOR_NOTE);
    const undeclared = selected.filter((name) => !declaredTools(cfg.doc).includes(name));
    if (undeclared.length) info(declareNote(undeclared));
  }
  return 0;
}

export function install(rootOrHost: unknown, opts: InstallOptions = {}) {
  return runPlan(hostOf(rootOrHost), opts, { uninstalling: false });
}

export function uninstall(rootOrHost: unknown, opts: InstallOptions = {}) {
  const host = hostOf(rootOrHost);
  const cwd = opts.cwd ?? host.workspaceRoot();
  const root = resolveProjectRoot(host, cwd);
  const cfg = readJsonObject(path.join(root, HOST_CONFIG), HOST_CONFIG);
  const saved = savedHarnesses(cfg.doc) ?? [];
  if (opts.check) throw new GateError('uninstall: --check is not supported');
  const remove = opts.harnesses !== undefined ? parseHarnessList(opts.harnesses) : saved;
  const wanted = saved.filter((name) => !remove.includes(name));
  if (!saved.length && opts.harnesses === undefined) {
    if (opts.dryRun) {
      info('dry-run: nothing to uninstall');
      return 0;
    }
    ok('nothing to uninstall');
    return 0;
  }
  return runPlan(host, { ...opts, harnesses: undefined }, { wanted, uninstalling: true });
}
