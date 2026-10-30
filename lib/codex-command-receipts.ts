import { appendFileSync, closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { rawToolReceipts } from './codex-raw-tool-receipts.js';

interface CommandItem {
  itemId: string; completed?: boolean; exitCode?: number | null; status?: string; threadId?: string | null;
  turnId?: string | null; command?: string; cwd?: string; processId?: string | null; aggregatedOutput?: string | null;
  [key: string]: unknown;
}
interface ReceiptIdentity {
  ref: string; launchId?: string; task?: string; address?: string; threadId?: string | null; cwd?: string;
  rawToolReceipts?: boolean; holderPid?: number; appPid?: number;
  [key: string]: unknown;
}
interface CommandNotification {
  method: string; params?: { threadId?: string; turnId?: string | null; id?: string;
    status?: string; turn?: { id?: string; status?: string }; itemId?: string; delta?: string;
    item?: { type?: string; id?: string; command?: string; cwd?: string; processId?: string | null;
      status?: string; exitCode?: number | null; aggregatedOutput?: string | null };
  };
}
interface ReceiptRow extends CommandItem {
  sequence: number; at: string; kind: string; format?: number; ref?: string; task?: string; address?: string;
  launchId?: string; threadId?: string | null; deadlineAt: number; holderPid?: number; appPid?: number;
  rawToolReceipts?: boolean; appClose?: { code?: number | null; signal?: string | null };
  code?: number | null; signal?: string | null; notification: Parameters<ReturnType<typeof rawToolReceipts>['observe']>[0];
  rawTools?: unknown; originalToolReceipt?: unknown; commands?: unknown;
}

function commandAccounting(fail: (reason: string) => unknown) {
  const commands = new Map<string, CommandItem>(), output = new Set<string>(), declined = new Set<string>(), ambiguous = new Set<string>(), turns = new Set<string | null | undefined>();
  const nonStart = (item: CommandItem | null | undefined) => item && typeof item.threadId === 'string' && !!item.threadId.trim()
    && typeof item.turnId === 'string' && !!item.turnId.trim()
    && typeof item.itemId === 'string' && !!item.itemId.trim()
    && typeof item.command === 'string' && !!item.command.trim()
    && typeof item.cwd === 'string' && !!item.cwd.trim()
    && item.processId === null && item.exitCode === null
    && (item.aggregatedOutput === null || item.aggregatedOutput === '');
  return {
    commands,
    startTurn: (turnId: string | null | undefined) => turns.add(turnId),
    terminal: (item: CommandItem) => item.completed === true && (declined.has(item.itemId)
      || (['completed', 'failed'].includes(item.status!) && Number.isInteger(item.exitCode) && item.exitCode! >= 0)),
    observe(kind: string, item: CommandItem) {
      const previous = commands.get(item.itemId);
      if (kind === 'item/commandExecution/outputDelta') {
        output.add(item.itemId);
        if (previous?.completed) fail('command output arrived after item completion');
        if (!previous) commands.set(item.itemId, { itemId: item.itemId, completed: false, exitCode: null });
        return;
      }
      if (item.completed !== (kind === 'item/completed')) fail('command lifecycle kind and completion flag disagree');
      if (declined.has(item.itemId)) fail('command notification arrived after declined completion');
      if (kind === 'item/started' && previous) ambiguous.add(item.itemId);
      if (item.status === 'declined') {
        if (kind !== 'item/completed' || item.completed !== true || !nonStart(item)
          || previous?.completed !== false || previous.status !== 'inProgress' || !nonStart(previous)
          || ['threadId', 'turnId', 'command', 'cwd'].some(field => item[field] !== previous[field])
          || !turns.has(item.turnId) || output.has(item.itemId) || ambiguous.has(item.itemId))
          fail('declined command lacks matching explicit non-start evidence');
        else declined.add(item.itemId);
      }
      commands.set(item.itemId, item);
    },
  };
}

export function commandReceipts(file: string, identity: ReceiptIdentity) {
  let error: string | null = null;
  let envelopeOnly = true;
  const fail = (reason: string) => {
    error ??= reason;
    if (reason !== 'original code-mode envelope is outside the supported single literal call shape') envelopeOnly = false;
  };
  const accounting = commandAccounting(fail), { commands } = accounting;
  let sequence = 0;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(file, 'wx', 0o600);
    closeSync(fd);
  } catch (err) { fail(`command receipt creation failed: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`); }
  const append = (kind: string, data: object) => {
    if (error) return false;
    let fd;
    try {
      fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
      appendFileSync(fd, JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(), kind, ...data }) + '\n');
      fsyncSync(fd);
    } catch (err) {
      fail(`command receipt persistence failed: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
    } finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch (err) { fail(`command receipt close failed: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`); }
      }
    }
    return !error;
  };
  const rawTools = identity.rawToolReceipts ? rawToolReceipts(append, fail, identity) : null;
  append('launch', identity);
  return {
    file,
    append,
    context(kind: string, data: Record<string, unknown>) {
      if (!rawTools) return;
      append('execution-context/' + kind, data);
      rawTools.context(kind, data);
    },
    fail,
    observe(msg: CommandNotification, threadId: string) {
      const p = msg.params ?? {};
      if (p.threadId && p.threadId !== threadId) return;
      rawTools?.observe(msg, threadId);
      if (msg.method === 'turn/started' || msg.method === 'turn/completed') {
        const turnId = p.turn?.id ?? p.id;
        const status = p.turn?.status ?? p.status ?? null;
        if (typeof turnId !== 'string' || !turnId.trim()
          || (msg.method === 'turn/completed' && !['completed', 'interrupted', 'failed'].includes(status!)))
          fail('terminal turn notification is malformed');
        if (msg.method === 'turn/started') accounting.startTurn(turnId);
        append(msg.method, { threadId, turnId, status });
      } else if (['item/started', 'item/completed'].includes(msg.method) && p.item?.type === 'commandExecution') {
        const item = p.item;
        if (typeof item.id !== 'string' || !item.id.trim() || typeof item.command !== 'string'
          || typeof item.cwd !== 'string') {
          fail('command item notification is malformed');
          return;
        }
        const entry = { itemId: item.id, threadId: p.threadId ?? null, turnId: p.turnId ?? null, processId: item.processId,
          command: item.command, cwd: item.cwd, status: item.status, exitCode: item.exitCode,
          aggregatedOutput: item.aggregatedOutput ?? null, completed: msg.method === 'item/completed' };
        accounting.observe(msg.method, entry);
        append(msg.method, entry);
      } else if (msg.method === 'item/commandExecution/outputDelta') {
        if (typeof p.itemId !== 'string' || typeof p.delta !== 'string') {
          fail('command output notification is malformed');
          return;
        }
        accounting.observe(msg.method, p as CommandItem);
        append(msg.method, { itemId: p.itemId, turnId: p.turnId ?? null, delta: p.delta });
      }
    },
    snapshot() {
      const items = [...commands.values()];
      return { file, error, envelopeOnlyFailure: error !== null && envelopeOnly, commands: items, rawTools: rawTools?.snapshot(items) ?? null,
        pending: items.filter(item => !accounting.terminal(item)).map(item => item.itemId) };
    },
  };
}

export function readStopConfirmation(file: string, record: ReceiptIdentity) {
  try {
    if (!lstatSync(file).isFile()) throw new Error('receipt is not a regular file');
    const text = readFileSync(file, 'utf8');
    if (!text.endsWith('\n')) throw new Error('receipt has an incomplete final row');
    const rows: ReceiptRow[] = text.trimEnd().split('\n').map(JSON.parse as (line: string) => ReceiptRow);
    if (!rows.every((row, i) => row.sequence === i + 1)) throw new Error('receipt sequence is incomplete');
    const launch = rows[0], final = rows.at(-1)!;
    if (launch.kind !== 'launch' || launch.format !== 1 || launch.ref !== record.ref
      || (record.task !== undefined && launch.task !== record.task)
      || (record.address !== undefined && launch.address !== record.address)
      || launch.launchId !== record.launchId || final.kind !== 'stop/confirmed'
      || final.launchId !== record.launchId || final.threadId !== record.threadId)
      throw new Error('receipt launch/thread identity does not match');
    const requested = rows.filter(row => row.kind === 'stop/requested').at(-1);
    if (!requested || requested.threadId !== record.threadId || !Number.isFinite(requested.deadlineAt)
      || rows.slice(rows.indexOf(requested)).filter(row => row.kind === 'app-server/close').length !== 1
      || !Number.isFinite(Date.parse(requested.at))
      || final.deadlineAt !== requested.deadlineAt || Date.parse(requested.at) >= requested.deadlineAt
      || requested.deadlineAt - Date.parse(requested.at) > 10_000
      || rows.slice(rows.indexOf(requested)).some(row =>
        !Number.isFinite(Date.parse(row.at)) || Date.parse(row.at) < Date.parse(requested.at)
        || Date.parse(row.at) >= requested.deadlineAt))
      throw new Error('Stop confirmation is outside its recorded request deadline');
    for (const field of ['holderPid', 'appPid'] as const) {
      if (!Number.isInteger(record[field]) || record[field]! <= 0
        || launch[field] !== record[field] || final[field] !== record[field])
        throw new Error(`receipt ${field} identity does not match`);
    }
    const accounting = commandAccounting(reason => { throw new Error(reason); });
    const { commands } = accounting, turns = new Set();
    if (!!launch.rawToolReceipts !== !!record.rawToolReceipts) throw new Error('raw tool receipt selection does not match the launch');
    if (rows.some(row => row.kind.startsWith('execution-context/')) && launch.cwd !== record.cwd)
      throw new Error('execution context launch cwd does not match');
    const rawTools = launch.rawToolReceipts ? rawToolReceipts(() => {}, reason => { throw new Error(reason); }, launch) : null;
    let closed = false;
    for (const { sequence, at, kind, ...data } of rows.slice(1, -1)) {
      if (kind === 'turn/started') {
        turns.add(data.turnId);
        if (data.threadId === record.threadId) accounting.startTurn(data.turnId);
      }
      if (kind === 'turn/completed') {
        if (!data.turnId || !['completed', 'interrupted', 'failed'].includes(data.status!))
          throw new Error('terminal turn evidence is malformed');
        turns.delete(data.turnId);
      }
      if (kind === 'item/started' || kind === 'item/completed') {
        if (data.status === 'declined' && data.threadId !== record.threadId)
          throw new Error('declined command thread identity does not match');
        accounting.observe(kind, data);
      }
      if (kind === 'item/commandExecution/outputDelta') {
        if (typeof data.itemId !== 'string' || !data.itemId || typeof data.delta !== 'string' || commands.get(data.itemId)?.completed)
          throw new Error('command output order is incomplete');
        accounting.observe(kind, data);
      }
      if (kind === 'app-server/close') closed = data.code === 0 && data.signal === null;
      if (kind === 'rawResponseItem/completed') rawTools?.observe(data.notification, record.threadId);
      if (kind.startsWith('execution-context/')) {
        if (data.threadId !== record.threadId) throw new Error('execution context thread does not match');
        rawTools?.context(kind.slice('execution-context/'.length), data);
      }
    }
    const items = [...commands.values()];
    if (rawTools && (rawTools.snapshot(items).pending.length
      || !isDeepStrictEqual(rawTools.snapshot(items), final.rawTools)))
      throw new Error('original selected tool receipts are incomplete');
    if (!closed || turns.size || final.appClose?.code !== 0 || final.appClose?.signal !== null
      || final.originalToolReceipt !== 'not synthesized' || !isDeepStrictEqual(items, final.commands)
      || items.some(item => typeof item.itemId !== 'string' || !item.itemId || !accounting.terminal(item)))
      throw new Error('terminal command/output evidence is incomplete');
    return { ok: true, receiptFile: file };
  } catch (error) { return { ok: false, note: `Stop confirmation is unresolved: ${(error as Error).message}` }; }
}
