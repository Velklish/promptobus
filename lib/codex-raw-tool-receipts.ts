import path from 'node:path';

interface ToolOutcome {
  terminal: boolean; exitCode: number | null; running: boolean;
  sessionId?: string | null; unresolved?: string;
}
interface RawToolItem { type?: string; name?: string; input?: string | null; call_id?: unknown; arguments?: string; output?: unknown }
interface RawToolMessage { method?: string; params?: { threadId?: unknown; turnId?: unknown; item?: RawToolItem | null } | null }
export interface ExecutionContext { launchId: string; threadId: string; cwd: string }
export interface CommandCall {
  callId: string; turnId: string; type: string; exec: boolean; sessionId: string | null;
  ownerCallId: string | null | undefined; command: string | null; cwd: string | null;
  processId: string | null | undefined; outcome: ToolOutcome | null; finalOutcome: ToolOutcome | null;
}
interface ObservedCommand {
  itemId: string; turnId?: string | null; command?: string; cwd?: string;
  processId?: string | null; exitCode?: number | null;
}
function property(value: unknown, key: string): unknown {
  // Keep the native nullish property-access failure.
  if (value == null) return (value as never)[key];
  return Reflect.get(Object(value), key);
}
function optionalProperty(value: unknown, key: string): unknown {
  return value == null ? undefined : property(value, key);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function singleCodeToolCall(input: string) {
  const match = /^\s*text\s*\(\s*await\s+tools\.([A-Za-z_$][\w$]*)\s*\(\s*(\{[\s\S]*\})\s*\)\s*\)\s*;?\s*$/.exec(input);
  if (!match) return null;
  const text = match[2]; let i = 0;
  const ws = () => { while (/\s/.test(text[i] ?? '') && i < text.length) i++; };
  const take = (char: string) => { ws(); if (text[i++] !== char) throw new Error('Expected literal delimiter'); };
  const value = (): unknown => {
    ws();
    const token = /"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
    token.lastIndex = i; const m = token.exec(text);
    if (!m) throw new Error('Only JSON primitive literal values are supported');
    i = token.lastIndex; return JSON.parse(m[0]);
  };
  try {
    const args: Record<string, unknown> = Object.create(null); take('{'); ws();
    while (text[i] !== '}') {
      ws(); let key: string;
      if (text[i] === '"') { const parsedKey = value(); if (typeof parsedKey !== 'string') return null; key = parsedKey; }
      else { const m = /^[A-Za-z_$][\w$]*/.exec(text.slice(i)); if (!m) return null; key = m[0]; i += key.length; }
      if (Object.hasOwn(args, key)) return null;
      take(':'); args[key] = value(); ws();
      if (text[i] === '}') break;
      take(','); ws();
    }
    take('}'); ws(); if (i !== text.length) return null;
    return { name: match[1], args };
  } catch { return null; }
}
export function toolResultOutcome(output: unknown, legacy = false): ToolOutcome {
  const blocks = typeof output === 'string' ? [{ type: 'input_text', text: output }] : output;
  const results: Record<string, unknown>[] = [];
  let structured = false;
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (property(block, 'type') !== 'input_text') continue;
    const text = property(block, 'text');
    if (typeof text !== 'string') continue;
    try {
      const value: unknown = JSON.parse(text);
      structured = true;
      if (isRecord(value) && typeof value.output === 'string'
        && (Object.hasOwn(value, 'exit_code') || Object.hasOwn(value, 'session_id'))) results.push(value);
    } catch { /* The public wrapper header is text, not a serialized exec result. */ }
  }
  if (!structured && legacy && typeof output === 'string') {
    const parts = output.split(/\n(?:Final output|Output):[^\S\n]*\n/);
    const header = parts.length > 1 ? parts[0] : '';
    const ids = [...header.matchAll(/^Process running with session ID\s+(\d+)\s*$/gmi)];
    const exits = [...header.matchAll(/^Process exited with code\s+(-?\d+)\s*$/gm)];
    if (ids.length + exits.length === 1) {
      const exit = exits.length ? Number(exits[0][1]) : null;
      return { terminal: typeof exit === 'number' && Number.isSafeInteger(exit) && exit >= 0, exitCode: typeof exit === 'number' && Number.isSafeInteger(exit) && exit >= 0 ? exit : null,
        running: ids.length === 1, sessionId: ids[0]?.[1] ?? null };
    }
  }
  if (results.length !== 1) return { terminal: false, exitCode: null, running: false, unresolved: 'Expected exactly one actual serialized exec result' };
  const value = results[0];
  const sessionId = value.session_id, exitCode = value.exit_code;
  if (sessionId != null && (typeof sessionId !== 'number' || !Number.isSafeInteger(sessionId) || sessionId <= 0))
    return { terminal: false, exitCode: null, running: false, unresolved: 'Invalid actual session identifier' };
  const running = typeof sessionId === 'number' && Number.isSafeInteger(sessionId) && sessionId > 0;
  const knownExit = typeof exitCode === 'number' && Number.isSafeInteger(exitCode) && exitCode >= 0;
  if (running && exitCode != null) return { terminal: false, exitCode: null, running: false, unresolved: 'Conflicting actual session and exit outcome' };
  return { terminal: knownExit && !running, exitCode: knownExit && !running ? exitCode : null,
    running, sessionId: running ? String(sessionId) : null };
}

export function rawToolReceipts(append: (kind: string, data: { notification: RawToolMessage }) => unknown, fail: (reason: string) => unknown, identity: { launchId?: unknown; cwd?: unknown } = {}) {
  const calls = new Map<string, CommandCall>(), sessions = new Map<string | null | undefined, string>();
  const callContexts = new Map<string, ExecutionContext>(), turns = new Set<string>(), unsupported = new Set<string>();
  const refusedEnvelopes: { threadId: string; turnId: string | null; callId: string | null }[] = [];
  let context: ExecutionContext | null = null, invalidated = false;
  return {
    context(kind: string, data: Record<string, unknown>) {
      if (kind === 'invalidated') { invalidated = true; return; }
      if (invalidated) return;
      if (kind === 'thread/accepted') {
        if (context || typeof identity.launchId !== 'string' || !identity.launchId
          || data.launchId !== identity.launchId || data.cwd !== identity.cwd
          || typeof data.cwd !== 'string' || !path.isAbsolute(data.cwd)
          || typeof data.threadId !== 'string' || !data.threadId || data.profile !== 'fixed-single-local') {
          invalidated = true; fail('accepted execution context does not match the launch'); return;
        }
        context = Object.freeze({ launchId: data.launchId, threadId: data.threadId, cwd: data.cwd });
      } else if (kind === 'turn/accepted' && context) {
        if (data.launchId !== context.launchId || data.threadId !== context.threadId
          || typeof data.turnId !== 'string' || !data.turnId || turns.has(data.turnId)) {
          invalidated = true; fail('accepted execution context does not match the turn'); return;
        }
        turns.add(data.turnId);
      } else if (kind !== 'turn/accepted') { invalidated = true; fail('unknown execution context evidence'); }
    },
    observe(msg: RawToolMessage, threadId: string | null | undefined) {
      if (msg.method !== 'rawResponseItem/completed') return;
      const p = msg.params ?? {}, item = p.item ?? {};
      if (!threadId || p.threadId !== threadId) return;
      const custom = item.type === 'custom_tool_call';
      if (custom || item.type === 'function_call') {
        let tool = item.name, args: unknown;
        if (custom) {
          if (!/(^|\.)exec$/.test(tool ?? '')) return;
          if (item.input?.trim() === 'text(ALL_TOOLS.filter(x => /promptobus_(task|mailbox|send)$/.test(x.name)).map(x => ({name:x.name})));') return;
          const parsed = typeof item.input === 'string' ? singleCodeToolCall(item.input) : null;
          if (!parsed) {
            refusedEnvelopes.push({ threadId: p.threadId,
              turnId: typeof p.turnId === 'string' ? p.turnId : null,
              callId: typeof item.call_id === 'string' ? item.call_id : null });
            fail('original code-mode envelope is outside the supported single literal call shape'); return;
          }
          tool = parsed.name; args = parsed.args;
        }
        const exec = /(^|\.)exec_command$/.test(tool ?? ''), poll = /(^|\.)write_stdin$/.test(tool ?? '');
        if (!exec && !poll) return;
        if (!custom) {
          try { args = JSON.parse(item.arguments!); }
          catch { fail('original command arguments are malformed'); return; }
        }
        append('rawResponseItem/completed', { notification: msg });
        if (typeof item.call_id !== 'string' || !item.call_id || calls.has(item.call_id)
          || typeof p.turnId !== 'string' || !p.turnId) { fail('original command call identity is missing or duplicated'); return; }
        const sessionId = poll ? String(optionalProperty(args, 'session_id')) : null;
        if (poll && !sessions.has(sessionId)) { fail('original poll does not target a recorded owned command session'); return; }
        const workdir = optionalProperty(args, 'workdir'), cmd = optionalProperty(args, 'cmd');
        if (exec) {
          if (optionalProperty(args, 'environment_id') != null || (optionalProperty(args, 'workdir') != null && workdir !== ''
            && (typeof workdir !== 'string' || !path.isAbsolute(workdir) || workdir.startsWith('//'))))
            unsupported.add(item.call_id);
          if ((optionalProperty(args, 'workdir') == null || workdir === '') && !invalidated && context?.threadId === threadId)
            callContexts.set(item.call_id, context);
        }
        calls.set(item.call_id, { callId: item.call_id, turnId: p.turnId, type: item.type!, exec, sessionId,
          ownerCallId: poll ? sessions.get(sessionId) : null,
          command: exec && typeof cmd === 'string' ? cmd : null,
          cwd: exec && typeof workdir === 'string' ? workdir : null,
          processId: null, outcome: null, finalOutcome: null });
      } else if (['function_call_output', 'custom_tool_call_output'].includes(item.type ?? '')) {
        const call = calls.get(typeof item.call_id === 'string' ? item.call_id : '');
        if (!call) return;
        append('rawResponseItem/completed', { notification: msg });
        const expected = call.type === 'custom_tool_call' ? 'custom_tool_call_output' : 'function_call_output';
        if (call.outcome || item.type !== expected || p.turnId !== call.turnId) { fail('original command output identity or order is inconsistent'); return; }
        const outcome = toolResultOutcome(item.output, item.type === 'function_call_output');
        if (call.sessionId && outcome.sessionId && call.sessionId !== outcome.sessionId)
          fail('original poll returned a different command session');
        else {
          call.outcome = outcome;
          if (call.exec && outcome.terminal) call.finalOutcome = outcome;
          if (call.exec && outcome.running) {
            call.processId = outcome.sessionId;
            if (sessions.has(outcome.sessionId)) fail('original command session was reused by another invocation');
            else sessions.set(outcome.sessionId, call.callId);
          }
          if (call.sessionId && outcome.terminal && call.type === 'function_call') {
            const owner = calls.get(call.ownerCallId!);
            if (!owner) fail('original terminal poll has no recorded owning invocation');
            else owner.finalOutcome = outcome;
            if (sessions.get(call.sessionId) === call.ownerCallId) sessions.delete(call.sessionId);
          }
        }
      } else return;
    },
    snapshot(commands: readonly ObservedCommand[]) {
      const items = [...calls.values()];
      const pending = items.filter(call => call.type !== 'function_call' || !call.outcome
        || (!call.outcome.terminal && !call.outcome.running)).map(call => call.callId);
      pending.push(...[...sessions.keys()].map(id => `running-session:${id}`));
      const bindings: { itemId: string; callId: string; turnId: string | null | undefined; requestedCommand: string | null;
        command: string | undefined; cwd: string | undefined; exitCode: number | null | undefined;
        cwdSource?: string; defaultContext?: ExecutionContext }[] = [], used = new Set<string>();
      for (const command of commands) {
        const matching = items.filter(call => call.exec && call.turnId === command.turnId
          && call.type === 'function_call' && call.callId === command.itemId && !unsupported.has(call.callId)
          && (callContexts.has(call.callId)
            ? !invalidated && turns.has(call.turnId) && callContexts.get(call.callId)!.cwd === command.cwd
            : call.cwd !== null && call.cwd !== '' && call.cwd === command.cwd));
        const call = matching[0];
        if (!command.turnId || matching.length !== 1 || used.has(call.callId)
          || (call.processId !== null && call.processId !== command.processId)
          || !call.finalOutcome?.terminal || call.finalOutcome.exitCode !== command.exitCode)
          pending.push(`missing-original-command:${command.itemId}`);
        else {
          used.add(call.callId);
          bindings.push({ itemId: command.itemId, callId: call.callId, turnId: command.turnId,
            requestedCommand: call.command, command: command.command, cwd: command.cwd, exitCode: command.exitCode,
            ...(callContexts.has(call.callId) ? { cwdSource: 'accepted-fixed-context', defaultContext: callContexts.get(call.callId) } : {}) });
        }
      }
      for (const call of items.filter(item => item.exec)) if (!used.has(call.callId)) pending.push(`unbound-original-command:${call.callId}`);
      return { calls: items, bindings, pending, ...(refusedEnvelopes.length ? { refusedEnvelopes: [...refusedEnvelopes] } : {}) };
    },
  };
}
