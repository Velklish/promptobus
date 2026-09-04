// Генерация project-level hooks шины. Форма записи — контракт harness'а, команда —
// host: абсолютные node и bin, путь скрипта из host.busHookRel(). Раскладка потребителя
// сюда не зашита.
//
// Скрипт хука лежит шаблоном рядом с исходниками (`templates/bus-hook.mjs`), а не
// строковым литералом: в шаблоне есть имена harness'ов (комментарии генерата), и гейт
// harness-neutral исходников package их в `.ts` не пускает.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { PromptobusHost } from './host.js';

export const BUS_HOOK_EVENT = 'PostToolUse';
export const BUS_HOOK_SEP = '\n';
// Имя сервера шины. Своего `contract.js` у package нет, и литерал здесь — не копия
// константы CLI, а объявление package. Расхождение с `PROMPTOBUS_SERVER` ловит
// `sync.test.mjs`: матчер стейдженного хука перестаёт совпадать, и группа не находится.
export const BUS_SERVER = 'promptobus';
export const BUS_HOOK_MATCHER = `mcp__${BUS_SERVER}__(promptobus_send|promptobus_mailbox)`;

export const GUARD_HOOK_EVENT = 'Stop';
export const GUARD_START_EVENT = 'SessionStart';

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellQuote(arg: string): string {
  const s = String(arg);
  return SHELL_SAFE.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function quoteFlag(value: string, platform: string): string {
  return platform === 'win32'
    ? `"${String(value).replace(/"/g, '""')}"`
    : shellQuote(value);
}

export interface GuardIdentity {
  address: string;
  taskId: string;
  home: string;
}

export function renderBusHook(host: Pick<PromptobusHost, 'commandName'>): string {
  const file = new URL('../templates/bus-hook.mjs', import.meta.url);
  return readFileSync(file, 'utf8').replaceAll('__COMMAND__', host.commandName);
}

export function busHookSettings(host: Pick<PromptobusHost, 'nodePath' | 'workspaceRoot' | 'busHookRel'>): Record<string, unknown> {
  const script = path.join(host.workspaceRoot(), host.busHookRel());
  return {
    [BUS_HOOK_EVENT]: [{
      matcher: BUS_HOOK_MATCHER,
      hooks: [{ type: 'command', command: `"${host.nodePath()}" "${script}"` }],
    }],
  };
}

export function guardHookCommand(
  host: Pick<PromptobusHost, 'nodePath' | 'layoutBinPath'>,
  identity: GuardIdentity | null = null,
  platform = 'posix',
): string {
  const flags = identity
    ? ` --role ${quoteFlag(identity.address, platform)} --task ${quoteFlag(identity.taskId, platform)}`
      + ` --home ${quoteFlag(identity.home, platform)}`
    : '';
  return `"${host.nodePath()}" "${host.layoutBinPath()}" promptobus guard${flags}`;
}

export function guardHookSettings(
  host: Pick<PromptobusHost, 'nodePath' | 'layoutBinPath'>,
  identity: GuardIdentity | null = null,
  platform = 'posix',
): Record<string, unknown> {
  const command = guardHookCommand(host, identity, platform);
  const group = () => [{ hooks: [{ type: 'command', command }] }];
  return { [GUARD_HOOK_EVENT]: group(), [GUARD_START_EVENT]: group() };
}

export interface HookPlan {
  rel: string;
  text: string;
  settings: Record<string, unknown>;
}

// Не полный PromptobusHost: тип объявляет, какие члены спрашивает план, и sync
// передаёт ровно их.
export type PromptobusHookHost = Pick<PromptobusHost,
  'commandName' | 'workspaceRoot' | 'busHookRel' | 'nodePath' | 'layoutBinPath'>;

export function planPromptobusHooks(
  host: PromptobusHookHost,
  identity: GuardIdentity | null = null,
  platform = 'posix',
): HookPlan {
  return {
    rel: host.busHookRel(),
    text: renderBusHook(host),
    settings: {
      ...busHookSettings(host),
      ...guardHookSettings(host, identity, platform),
    },
  };
}
