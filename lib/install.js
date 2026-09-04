// Project-level hook install for a consumer repository.
// Layout knowledge comes from the host. User-level directories
// (~/.claude, ~/.cursor, ~/.codex) are never written.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { info, ok, warn } from './util.js';
import { hostOf } from './host.js';
import { GateError } from './store.js';
import { HOST_CONFIG } from '../dist/host-index.js';
import {
  BUS_HOOK_MATCHER,
  busHookCommand,
  guardHookCommand,
  renderBusHook,
} from '../dist/hooks.js';

export const INSTALL_HARNESSES = ['claude', 'cursor', 'codex'];
export const HOME_HOOK_DIRS = ['.claude', '.cursor', '.codex'];
export const HARNESSES_FIELD = 'harnesses';
export const MANIFEST_KIND = 'promptobus-hooks';

// Same five names as driver-cursor `KNOWN_HOOK_EVENTS`. An unknown name in
// `.cursor/hooks.json` silently disables every hook in the file.
export const CURSOR_HOOK_EVENTS = ['sessionStart', 'beforeSubmitPrompt', 'stop', 'sessionEnd', 'afterFileEdit'];

const TRUST_NOTE = 'Review: Codex requires /hooks; project hooks also depend on workspace trust.';
const CURSOR_NOTE = 'Cursor: stop guard only. Bus feedback is driver injection, not a project hook.';
const CODEX_BUS_MATCHER = `${BUS_HOOK_MATCHER}|promptobus_send|promptobus_mailbox`;

export function assertCursorHookEvents(hooks) {
  const unknown = Object.keys(hooks ?? {}).filter((event) => !CURSOR_HOOK_EVENTS.includes(event));
  if (unknown.length) {
    throw new GateError(
      `install: unknown Cursor hook event ${unknown.map((event) => `"${event}"`).join(', ')} — known: ${CURSOR_HOOK_EVENTS.join(', ')}`,
    );
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function jsonText(doc) {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function platformOf() {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

function under(abs, root) {
  const resolved = path.resolve(abs);
  const base = path.resolve(root);
  return resolved === base || resolved.startsWith(base + path.sep);
}

export function homeHookRoots(env = process.env) {
  const homes = new Set([env?.HOME, env?.USERPROFILE, os.homedir()].filter(Boolean));
  const roots = [];
  for (const home of homes) {
    for (const name of HOME_HOOK_DIRS) roots.push(path.resolve(home, name));
  }
  return roots;
}

export function parseHarnessList(raw) {
  if (raw === undefined || raw === null || raw === '') {
    throw new GateError('install: --harnesses is empty');
  }
  const parts = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map((part) => String(part).trim())
    .filter(Boolean);
  if (!parts.length) throw new GateError('install: --harnesses is empty');
  const unknown = [...new Set(parts)].filter((name) => !INSTALL_HARNESSES.includes(name));
  if (unknown.length) {
    throw new GateError(
      `install: unknown harness ${unknown.map((name) => `"${name}"`).join(', ')} — known: ${INSTALL_HARNESSES.join(', ')}`,
    );
  }
  return INSTALL_HARNESSES.filter((name) => parts.includes(name));
}

export function resolveProjectRoot(host, cwd) {
  const start = path.resolve(cwd ?? host.workspaceRoot());
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, HOST_CONFIG))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
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

function readJsonObject(abs, label) {
  if (!existsSync(abs)) return { missing: true, doc: {}, text: null };
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (e) {
    throw new GateError(`install: cannot read ${label}: ${e.message}`);
  }
  if (!String(raw).trim()) return { missing: false, doc: {}, text: raw };
  let parsed;
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

function hookHostOf(host, root) {
  return {
    commandName: host.commandName,
    nodePath: () => host.nodePath(),
    layoutBinPath: () => host.layoutBinPath(),
    workspaceRoot: () => root,
    busHookRel: () => host.busHookRel(),
  };
}

function groupCommand(group, style) {
  if (style === 'flat') return typeof group?.command === 'string' ? group.command : '';
  return typeof group?.hooks?.[0]?.command === 'string' ? group.hooks[0].command : '';
}

function hookGroupId(event, group, style) {
  const matcher = typeof group?.matcher === 'string' ? group.matcher : '';
  return matcher ? `${event}:${matcher}` : `${event}::${groupCommand(group, style)}`;
}

function ownedIds(events, style) {
  const ids = [];
  for (const [event, groups] of Object.entries(events)) {
    for (const group of groups) ids.push(hookGroupId(event, group, style));
  }
  return ids;
}

function isOwnedGroup(event, group, ctx) {
  const id = hookGroupId(event, group, ctx.style);
  if (ctx.prevIds.has(id) || ctx.oursIds.has(id)) return true;
  const cmd = groupCommand(group, ctx.style);
  if (!cmd) return false;
  if (event === ctx.busEvent) {
    return cmd === ctx.busCommand || (ctx.scriptNeedle && cmd.includes(ctx.scriptNeedle));
  }
  if (ctx.guardEvents.includes(event)) {
    return cmd === ctx.guardCommand
      || (cmd.includes('promptobus guard') && ctx.binNeedle && cmd.includes(ctx.binNeedle));
  }
  return false;
}

function mergeHookEvents(existingHooks, ourEvents, ctx) {
  if (existingHooks != null && !isPlainObject(existingHooks)) {
    throw new GateError(`install: ${ctx.label} hooks value is not an object — fix it and retry`);
  }
  const oursIds = new Set();
  for (const [event, groups] of Object.entries(ourEvents)) {
    for (const group of groups) oursIds.add(hookGroupId(event, group, ctx.style));
  }
  const rest = {};
  for (const [event, groups] of Object.entries(existingHooks ?? {})) {
    if (!Array.isArray(groups)) {
      throw new GateError(`install: ${ctx.label} hooks.${event} is not an array — fix it and retry`);
    }
    const left = groups.filter((group) => !isOwnedGroup(event, group, { ...ctx, oursIds }));
    if (left.length) rest[event] = left;
  }
  for (const [event, groups] of Object.entries(ourEvents)) {
    rest[event] = [...(rest[event] ?? []), ...groups];
  }
  return rest;
}

function nestedGroup(command, matcher) {
  const hooks = [{ type: 'command', command }];
  return matcher ? { matcher, hooks } : { hooks };
}

function claudeEvents(busCmd, guardCmd, matcher) {
  return {
    PostToolUse: [nestedGroup(busCmd, matcher)],
    Stop: [nestedGroup(guardCmd)],
    SessionStart: [nestedGroup(guardCmd)],
  };
}

function cursorEvents(_busCmd, guardCmd) {
  return { stop: [{ command: guardCmd }] };
}

const SPECS = {
  claude: {
    rel: path.join('.claude', 'settings.json'),
    style: 'nested',
    busEvent: 'PostToolUse',
    guardEvents: ['Stop', 'SessionStart'],
    matcher: BUS_HOOK_MATCHER,
    usesRunner: true,
    events: claudeEvents,
    wrap(doc, hooks) {
      const next = { ...doc };
      if (Object.keys(hooks).length) next.hooks = hooks;
      else delete next.hooks;
      return next;
    },
  },
  cursor: {
    rel: path.join('.cursor', 'hooks.json'),
    style: 'flat',
    // busEvent is only for stripping a leftover bus group from an older install.
    // Owned Cursor writes are `stop` alone. Bus feedback for this harness is driver injection.
    busEvent: 'postToolUse',
    guardEvents: ['stop'],
    matcher: BUS_HOOK_MATCHER,
    usesRunner: false,
    events: cursorEvents,
    wrap(doc, hooks) {
      const next = { ...doc };
      if (next.version === undefined) next.version = 1;
      next.hooks = hooks;
      return next;
    },
  },
  codex: {
    rel: path.join('.codex', 'hooks.json'),
    style: 'nested',
    busEvent: 'PostToolUse',
    guardEvents: ['Stop', 'SessionStart'],
    matcher: CODEX_BUS_MATCHER,
    usesRunner: true,
    events: claudeEvents,
    wrap(doc, hooks) {
      const next = { ...doc };
      next.hooks = hooks;
      return next;
    },
  },
};

function savedHarnesses(doc) {
  if (!doc || !Object.hasOwn(doc, HARNESSES_FIELD)) return null;
  if (!Array.isArray(doc[HARNESSES_FIELD])) {
    throw new GateError(`install: ${HOST_CONFIG} ${HARNESSES_FIELD} must be an array`);
  }
  if (!doc[HARNESSES_FIELD].length) return [];
  return parseHarnessList(doc[HARNESSES_FIELD]);
}

function readOwned(root, host) {
  const rel = host.installManifestRel();
  const abs = path.join(root, rel);
  const got = readJsonObject(abs, rel);
  const raw = isPlainObject(got.doc.owned) ? got.doc.owned : {};
  const owned = {};
  for (const name of INSTALL_HARNESSES) {
    owned[name] = Array.isArray(raw[name]) ? raw[name].map(String) : [];
  }
  return { abs, rel, doc: got.doc, missing: got.missing, owned };
}

function assertNotHomeWrites(writes, env) {
  const banned = homeHookRoots(env);
  for (const write of writes) {
    for (const root of banned) {
      if (under(write.abs, root)) {
        throw new GateError(`install: refuses to write user-level hooks (${write.rel})`);
      }
    }
  }
}

function applyWrites(writes) {
  const staged = [];
  try {
    for (const write of writes) {
      mkdirSync(path.dirname(write.abs), { recursive: true });
      const tmp = path.join(
        path.dirname(write.abs),
        `.tmp-${path.basename(write.abs)}-${process.pid}-${staged.length}`,
      );
      writeFileSync(tmp, write.text);
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

export function planHookInstall(host, root, wanted) {
  const hookHost = hookHostOf(host, root);
  const platform = platformOf();
  const runnerRel = host.busHookRel();
  const runnerAbs = path.join(root, runnerRel);
  const guardCmd = guardHookCommand(hookHost, null, platform);
  const prev = readOwned(root, host);
  const writes = [];
  const owned = {};

  const needsRunner = wanted.some((name) => SPECS[name].usesRunner);
  if (needsRunner) {
    writes.push({ rel: runnerRel, abs: runnerAbs, text: renderBusHook(hookHost) });
  } else if (existsSync(runnerAbs)) {
    writes.push({ rel: runnerRel, abs: runnerAbs, text: null, remove: true });
  }

  for (const name of INSTALL_HARNESSES) {
    const spec = SPECS[name];
    const selected = wanted.includes(name);
    const prevIds = new Set(prev.owned[name] ?? []);
    const fileAbs = path.join(root, spec.rel);
    const existing = readJsonObject(fileAbs, spec.rel);
    if (!selected && existing.missing && !prevIds.size) {
      owned[name] = [];
      continue;
    }
    const busCmd = busHookCommand(hookHost, [], platform);
    const ourEvents = selected ? spec.events(busCmd, guardCmd, spec.matcher) : {};
    if (name === 'cursor') assertCursorHookEvents(ourEvents);
    const hooks = mergeHookEvents(existing.doc.hooks, ourEvents, {
      style: spec.style,
      prevIds,
      busEvent: spec.busEvent,
      guardEvents: spec.guardEvents,
      busCommand: busCmd,
      guardCommand: guardCmd,
      scriptNeedle: runnerAbs,
      binNeedle: host.layoutBinPath(),
      label: spec.rel,
    });
    owned[name] = selected ? ownedIds(ourEvents, spec.style) : [];
    writes.push({ rel: spec.rel, abs: fileAbs, text: jsonText(spec.wrap(existing.doc, hooks)) });
  }

  return { writes, owned, prev, hookHost, runnerAbs, runnerRel };
}

function configWrite(root, doc, wanted) {
  const next = { ...doc };
  if (wanted.length) next[HARNESSES_FIELD] = wanted;
  else delete next[HARNESSES_FIELD];
  return {
    rel: HOST_CONFIG,
    abs: path.join(root, HOST_CONFIG),
    text: jsonText(next),
  };
}

function manifestWrite(root, host, prev, wanted, owned) {
  const next = {
    ...prev.doc,
    version: 1,
    kind: MANIFEST_KIND,
    [HARNESSES_FIELD]: wanted,
    owned,
  };
  return {
    rel: host.installManifestRel(),
    abs: path.join(root, host.installManifestRel()),
    text: jsonText(next),
  };
}

function driftOf(writes, cfgWrite, wanted, saved) {
  const drifts = [];
  const savedList = saved ?? [];
  if (savedList.join(',') !== wanted.join(',')) drifts.push(`${HOST_CONFIG} ${HARNESSES_FIELD}`);
  for (const write of writes) {
    if (write.remove) {
      if (existsSync(write.abs)) drifts.push(write.rel);
      continue;
    }
    const current = existsSync(write.abs) ? readFileSync(write.abs, 'utf8') : null;
    if (current !== write.text) drifts.push(write.rel);
  }
  if (existsSync(cfgWrite.abs)) {
    if (readFileSync(cfgWrite.abs, 'utf8') !== cfgWrite.text) {
      if (!drifts.includes(HOST_CONFIG) && !drifts.includes(`${HOST_CONFIG} ${HARNESSES_FIELD}`)) {
        drifts.push(HOST_CONFIG);
      }
    }
  } else if (wanted.length) {
    if (!drifts.includes(`${HOST_CONFIG} ${HARNESSES_FIELD}`)) drifts.push(HOST_CONFIG);
  }
  return [...new Set(drifts)];
}

function resolveWanted(host, opts, cfg) {
  if (opts.harnesses !== undefined) return parseHarnessList(opts.harnesses);
  return savedHarnesses(cfg.doc);
}

function runPlan(host, opts, { wanted, uninstalling }) {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? host.workspaceRoot();
  const root = resolveProjectRoot(host, cwd);
  const cfg = readJsonObject(path.join(root, HOST_CONFIG), HOST_CONFIG);
  const selected = wanted ?? resolveWanted(host, opts, cfg);
  const check = !!opts.check;
  const dryRun = !!opts.dryRun;

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

  const plan = planHookInstall(host, root, selected);
  const cfgWrite = configWrite(root, cfg.doc, selected);
  const manWrite = manifestWrite(root, host, plan.prev, selected, plan.owned);
  const diskWrites = [...plan.writes, cfgWrite, manWrite];
  assertNotHomeWrites(diskWrites.filter((w) => !w.remove), env);

  if (check) {
    const saved = savedHarnesses(cfg.doc);
    const drifts = driftOf(plan.writes, cfgWrite, selected, saved);
    if (drifts.length) {
      for (const rel of drifts) warn(`drift: ${rel}`);
      return 1;
    }
    ok('configured');
    return 0;
  }

  if (dryRun) {
    for (const write of diskWrites) {
      if (write.remove) info(`dry-run: would remove ${write.rel}`);
      else info(`dry-run: would write ${write.rel}`);
    }
    ok('dry-run: nothing written');
    return 0;
  }

  const pending = [];
  const removals = [];
  for (const write of diskWrites) {
    if (write.remove) {
      if (existsSync(write.abs)) removals.push(write);
      continue;
    }
    const current = existsSync(write.abs) ? readFileSync(write.abs, 'utf8') : null;
    if (current !== write.text) pending.push(write);
  }
  applyWrites(pending);
  for (const write of removals) rmSync(write.abs, { force: true });
  if (uninstalling) ok(selected.length ? `uninstalled; remaining ${selected.join(', ')}` : 'uninstalled');
  else {
    ok('configured');
    if (selected.includes('codex') || selected.includes('claude')) info(TRUST_NOTE);
    if (selected.includes('cursor')) info(CURSOR_NOTE);
  }
  return 0;
}

export function install(rootOrHost, opts = {}) {
  return runPlan(hostOf(rootOrHost), opts, { uninstalling: false });
}

export function uninstall(rootOrHost, opts = {}) {
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
