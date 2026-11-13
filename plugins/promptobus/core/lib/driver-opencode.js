import { replaceLaunchMcpConfig } from './driver-runtime.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import path from 'node:path';
import { PROMPTOBUS_SERVER } from './contract.js';
import { selectedNativeFiles } from './native-participant-context.js';
import { addressOf, canonicalPath, participantOf, participantSessionPath, readTask, taskExists, withTaskLock, workersDir, writeJsonAtomic } from './store.js';
import { PARENT_SESSION_ENV } from './session-env.js';
import { harnessBin } from './harness-home.js';
import { run, wouldResolve } from './exec.js';
import { info } from './util.js';
import { createHarnessRegistry } from './harness-registry.js';
import { orderBody as commonOrderBody } from './notification.js';
import { opencodeAvailability } from './model-routing/adapter-opencode.js';
import { GateError } from '../dist/index.js';
import { processIdentity, processState, readPrivate, recordOf, recordVersion, sameRecordVersion } from './service-state.js';
import { processExecutable } from './root-process.js';
import { foreignSession, wakeAddressOf, writeWake, } from './store.js';
import { bindBeforeLaunch, readRecordAt, revokeFailedManagedLaunch, sayForeignWrite as commonSayForeignWrite, sessionEnvFor } from './driver-common.js';
import { createSession, deleteSession, holderPassword, holderRequestSync, holderUrl, idleOutcome, listPermissions, parsePermissionList, pidAlive, portOfLog, readMessages, reapHolder, replyPermission, sendPrompt, startHolder, waitReady, } from './opencode-session.js';
// OpenCode harness driver: EVERYTHING that knows about opencode lives here — the engine
// reaches it through the registry ([drivers.js](drivers.js)). Contract: 05-drivers.
/** Harness name in the participant record and the key in the registry map. */
export const OPENCODE = 'opencode';
/** Skills directory the driver names for a lift: carried by `OPENCODE_CONFIG_DIR`, so nothing of
 * the driver's lands in the participant's working directory. */
export const OPENCODE_SKILLS_REL = path.join('.opencode', 'skills');
// Allowed --permission-mode values: unattended turns run under `--auto` in the lift env; the
// denials themselves travel in the config permission map, so the list holds one mode.
export const PERMISSION_MODES = ['auto'];
export const DEFAULT_PERMISSION_MODE = 'auto';
// Effort has no mapping: `--variant` is provider-specific, and guessing it would lift the session
// on an effort nobody asked for. Any explicit value refuses in the engine on this empty list.
export const EFFORT_LEVELS = [];
// Participant model in `-m provider/model` form, measured off a live session's export. It travels
// as the config `model` default: the holder API names no model on prompt.
export const DEFAULT_MODEL = 'opencode-go/muse-spark-1.3-contributor';
// Floor for the holder API below: the shape v1 stands on, measured on 2.0.20.
export const OPENCODE_MIN_VERSION = '2.0.0';
// After the prompt returns, an external_directory ask can appear a few seconds later.
// One immediate read misses it; inspect still answers a later one. Contract: 05-drivers.
export const PERMISSION_POLL_MS = 4_000;
const PERMISSION_POLL_STEP_MS = 200;
// Tools taken from the reviewer: it reads a report on the bus and does not edit or run.
// The reviewer role itself arrives separately.
export const REVIEWER_DENY = ['edit', 'write', 'bash', 'webfetch', 'websearch'];
// Bus deny names in Claude spelling into opencode permission keys. Unmapped names pass lowercased.
const DENY_NAME_MAP = {
    Edit: 'edit', Write: 'write', NotebookEdit: 'edit', Bash: 'bash', Read: 'read',
    WebFetch: 'webfetch', WebSearch: 'websearch',
};
export function permissionDeny(denyTools) {
    const out = {};
    for (const name of denyTools ?? []) {
        const key = DENY_NAME_MAP[name] ?? String(name).toLowerCase();
        out[key] = 'deny';
    }
    return out;
}
// 2.0.20 types external_directory as an action or a pattern-to-action map. A filesystem
// root is not expanded: that pattern would allow the whole disk.
export function permissionGrant(denyTools, roots) {
    const permission = permissionDeny(denyTools);
    const external = {};
    for (const root of roots ?? []) {
        if (typeof root !== 'string' || filesystemRoot(path.resolve(root)))
            continue;
        const base = root.endsWith(path.sep) ? root.slice(0, -1) : root;
        if (!base || filesystemRoot(base))
            continue;
        external[`${base}/*`] = 'allow';
        external[`${base}/**`] = 'allow';
    }
    if (Object.keys(external).length)
        permission.external_directory = external;
    return permission;
}
// The bus entry's pointer at the session record a lift writes beside its config.
export const SESSION_RECORD_VAR = 'PROMPTOBUS_OPENCODE_SESSION';
// Host-classified MCP writes into opencode permission patterns, both tool-name spellings.
export function mcpDenyTools(tools) {
    const out = [];
    for (const { server, tool } of tools ?? []) {
        if (!server || !tool)
            continue;
        out.push(`${server}_${tool}`, `mcp__${server}__${tool}`);
    }
    return out;
}
// Parent variables that must not reach the participant: foreign harness identities and the
// participant pointers of other drivers.
export const SESSION_ENV_DROP = [...PARENT_SESSION_ENV, 'PROMPTOBUS_CLAUDE_SESSION', 'PROMPTOBUS_CODEX_SESSION'];
/** Harness words the adapter inserts into its own strings: shared prose stays with it. */
export const PHRASES = {
    sessions: 'opencode session list',
    unreadable: 'opencode session list --format json is unreadable',
    enter: (id) => (id ? `opencode --session ${id}` : 'opencode'),
    stop: (id) => (id ? `opencode session delete ${id}` : 'opencode session delete'),
    logs: () => 'the holder log beside the session record',
    // MCP tools register as `mcp__server__tool`, the same convention as Claude Code.
    tool: (_server, name) => name,
    mcpBoundary: '**Host-classified MCP write tools are denied by the harness config; the remaining external MCP surface is read-only under this prompt, the second layer.**',
    reviewerCommands: {
        isolation: 'File edits and command starts are disabled for you by the mechanism.',
        procedureSkip: 'a command start',
        record: 'you run nothing',
        gate: 'not run, because a reviewer runs nothing',
    },
    promptRules: '',
};
// Participant opencode config into the form read through `OPENCODE_CONFIG`. The bus entry of
// a bound lift carries the session-record pointer for its MCP children.
function mcpConfig({ servers }, pointer = null) {
    const mcp = {};
    for (const [name, raw] of Object.entries(servers ?? {})) {
        const entry = raw;
        if (!entry || typeof entry !== 'object')
            continue;
        if (typeof entry.url === 'string' && entry.url) {
            mcp[name] = {
                type: 'remote', url: entry.url, ...(entry.headers ? { headers: entry.headers } : {}),
                ...(entry.oauth === false ? { oauth: false } : {}),
            };
        }
        else if (typeof entry.command === 'string' && entry.command) {
            // The bus entry carries the binary twice (`command` plus a `busArgv` head) — dedupe, or the
            // holder would exec the runtime as a script of itself.
            const args = Array.isArray(entry.args) ? entry.args : [];
            const command = args[0] === entry.command ? args : [entry.command, ...args];
            mcp[name] = {
                type: 'local',
                command,
                ...(entry.env ? { environment: entry.env } : {}),
            };
        }
    }
    const bus = mcp[PROMPTOBUS_SERVER];
    if (bus?.type === 'local' && pointer) {
        bus.environment = { ...bus.environment, [SESSION_RECORD_VAR]: pointer };
    }
    return { mcp };
}
/** The workspace skills canon: `.opencode/skills` at the workspace root. No directory — null. */
export function workspaceSkillsDir(root) {
    if (!root)
        return null;
    const src = path.join(root, OPENCODE_SKILLS_REL);
    try {
        return existsSync(src) ? src : null;
    }
    catch {
        return null;
    }
}
function filesystemRoot(abs) {
    const root = path.parse(abs).root;
    return root !== '' && abs === root;
}
/** Session cwd and absolute addDirs. A relative path is not a root: resolving it would follow the wrong process. */
export function declaredRoots(cwd, addDirs = []) {
    const roots = [];
    for (const dir of [cwd, ...(Array.isArray(addDirs) ? addDirs : [])]) {
        if (typeof dir !== 'string' || !path.isAbsolute(dir))
            continue;
        const abs = path.resolve(dir);
        if (filesystemRoot(abs) || roots.includes(abs))
            continue;
        roots.push(abs);
    }
    return roots;
}
/** The directory an external_directory resource names, after a trailing glob is stripped. */
export function resourceInRoots(resource, roots) {
    if (typeof resource !== 'string')
        return false;
    const trimmed = resource.trim();
    const pattern = trimmed.endsWith('/**') ? trimmed.slice(0, -3)
        : trimmed.endsWith('/*') ? trimmed.slice(0, -2)
            : trimmed;
    if (!pattern || pattern.includes('*') || !path.isAbsolute(pattern))
        return false;
    const abs = path.resolve(pattern);
    return (roots ?? []).some((root) => {
        if (typeof root !== 'string' || !root)
            return false;
        const base = path.resolve(root);
        if (filesystemRoot(base))
            return false;
        const prefix = base.endsWith(path.sep) ? base : base + path.sep;
        return abs === base || abs.startsWith(prefix);
    });
}
export function askResources(ask) {
    const out = [];
    if (typeof ask?.resource === 'string')
        out.push(ask.resource);
    if (Array.isArray(ask?.resources)) {
        for (const resource of ask.resources) {
            if (typeof resource === 'string')
                out.push(resource);
        }
    }
    return out;
}
/** An external_directory ask whose every resource is a declared root or inside one. */
export function coveredExternalDirectory(ask, roots) {
    if (ask?.action !== 'external_directory')
        return false;
    const resources = askResources(ask);
    return resources.length > 0 && resources.every((resource) => resourceInRoots(resource, roots));
}
export function pendingPermissionNote(asks) {
    const parts = [];
    for (const ask of asks ?? []) {
        const action = typeof ask?.action === 'string' && ask.action ? ask.action : 'permission';
        const resources = askResources(ask);
        parts.push(resources.length ? `${action} ${resources.join(' ')}` : action);
    }
    const note = `permission ask pending: ${parts.join('; ')}`;
    return note.length > 400 ? `${note.slice(0, 397)}...` : note;
}
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
async function readPermissionAsks(url, password, sessionId, fetchFn) {
    const res = await listPermissions(url, password, sessionId, fetchFn);
    if (res?.status !== 200)
        return null;
    return parsePermissionList(res.data);
}
/** Reply for declared-root external_directory asks. Any ask still listed fails the lift. */
export async function settlePermissionAsks({ url, password, sessionId, roots, pollMs = PERMISSION_POLL_MS, stepMs = PERMISSION_POLL_STEP_MS, fetchFn, sleepFn = pause, }) {
    const deadline = Date.now() + Math.max(0, pollMs);
    for (;;) {
        let asks = await readPermissionAsks(url, password, sessionId, fetchFn);
        if (Array.isArray(asks)) {
            const answerable = asks.filter((ask) => coveredExternalDirectory(ask, roots) && typeof ask.id === 'string' && ask.id);
            for (const ask of answerable) {
                await replyPermission(url, password, sessionId, ask.id, fetchFn);
            }
            if (answerable.length)
                asks = await readPermissionAsks(url, password, sessionId, fetchFn);
            if (!Array.isArray(asks))
                throw new GateError('permission list unreadable after a reply');
            if (asks.length)
                throw new GateError(pendingPermissionNote(asks));
        }
        if (Date.now() >= deadline)
            return;
        const wait = Math.min(stepMs, Math.max(0, deadline - Date.now()));
        if (wait > 0)
            await sleepFn(wait);
    }
}
/** Lift plan from harness-neutral context. Writes nothing and starts nothing. */
export function prepare({ ref, role: _role = null, mcp, prompt, model, effort = null, permissionMode: _permissionMode = null, mcpConfigPath, env = {}, denyTools = null, root = null, skillsRoot = root, selectedContext = null, home = null, task = null, address = null, cwd = null, addDirs = [], }) {
    if (effort !== null && effort !== undefined) {
        throw new GateError(`--effort ${effort}: opencode maps no effort level — omit it`);
    }
    const configDir = path.dirname(mcpConfigPath);
    const holderDir = path.join(configDir, '.opencode');
    const skillsSrc = selectedContext ? null : workspaceSkillsDir(skillsRoot);
    const skillsDest = path.join(holderDir, 'skills');
    const password = holderPassword();
    const pointer = safeRecordPath(home, task, address, ref);
    const roots = declaredRoots(cwd, addDirs);
    const permission = permissionGrant(denyTools, roots);
    const cfg = {
        $schema: 'https://opencode.ai/config.json',
        model: model ?? DEFAULT_MODEL,
        mcp: mcpConfig(mcp, pointer).mcp,
        ...(Object.keys(permission).length ? { permission } : {}),
    };
    return {
        argv: ['serve', '--port', '0', '--hostname', '127.0.0.1'],
        prompt,
        cwd: cwd,
        roots,
        holder: { password, title: ref },
        env: {
            ...env,
            OPENCODE_CONFIG: mcpConfigPath,
            OPENCODE_CONFIG_DIR: holderDir,
            OPENCODE_SERVER_PASSWORD: password,
            ...(pointer ? { [SESSION_RECORD_VAR]: pointer } : {}),
        },
        mcpConfig: cfg,
        mcpConfigPath,
        settings: cfg,
        files: [
            { path: mcpConfigPath, text: `${JSON.stringify(cfg, null, 2)}\n`, secret: true },
            ...(skillsSrc ? [{ path: skillsDest, copyFrom: skillsSrc, text: '', secret: false }] : []),
            ...(selectedContext ? selectedNativeFiles(selectedContext, skillsDest) : []),
        ],
    };
}
function replaceMcpServers(plan, servers) {
    const former = plan.mcpConfig;
    const { reviewer_files: previousFiles, ...kept } = former.mcp;
    replaceLaunchMcpConfig(plan, { ...former, mcp: { ...kept, ...mcpConfig({ servers }).mcp } });
    plan.settings = plan.mcpConfig;
}
const sessionEnv = sessionEnvFor(SESSION_ENV_DROP);
const sayForeignWrite = commonSayForeignWrite;
export { sayForeignWrite };
function optionRefusal() {
    return null;
}
// Personal servers in the person's global config shadowing canonical names.
function opencodeUserMcp(canonServerNames) {
    let names = [];
    try {
        const doc = JSON.parse(readFileSync(path.join(homedir(), '.config', 'opencode', 'opencode.json'), 'utf8'));
        names = Object.keys(doc?.mcp ?? {}).sort();
    }
    catch {
        names = [];
    }
    const canon = new Set(canonServerNames);
    return { shadowed: names.filter((n) => canon.has(n)), extras: names.filter((n) => !canon.has(n)) };
}
function shadowedUserServers(names) {
    return opencodeUserMcp(names).shadowed;
}
// The holder record before the first holder call: pid first, then url, then session id.
export function holderRecord({ home, task, address, password, pid, log, cwd }) {
    return {
        url: null, password: password ?? null,
        sessionId: null, holderPid: pid, log, cwd, started: new Date().toISOString(),
        home, task, address,
    };
}
// The harness session registry: ref → record path for ref-only `inspect` and `stop`.
const opencodeRegistry = createHarnessRegistry({ harness: OPENCODE });
/** Registry file key of a ref — the name `writeSession` files it under. */
export const registrySessionKey = (ref) => opencodeRegistry.sessionKey(ref);
function recordPath(home, task, address, ref = null) {
    try {
        return participantSessionPath(home, task, address);
    }
    catch {
        // Addresses without a file stem (the teamlead's `orchestrator` slot) fall back to the
        // lift ref: same file for every relift of it, and never a shared one.
        if (!home || !task || !ref)
            return null;
        try {
            const stem = String(ref).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'session';
            return path.join(workersDir(home, task), `${stem}.session.json`);
        }
        catch {
            return null;
        }
    }
}
/** The pointer a lift binds before launch, or null outside a task store. */
function safeRecordPath(home, task, address, ref = null) {
    if (!home || !task || !address)
        return null;
    return recordPath(home, task, address, ref);
}
function opencodeBin(tool) {
    if (tool?.bin)
        return tool.bin;
    const { bin } = harnessBin(OPENCODE);
    return bin ?? OPENCODE;
}
const APPEAR_TIMEOUT_MS = 30_000;
function underRecordTask(record, fn, taskLocked) {
    const home = record.home ? canonicalPath(record.home) : null;
    if (taskLocked && home === canonicalPath(taskLocked.home) && taskLocked.task === record.task)
        return fn();
    return home && record.task && taskExists(home, record.task) ? withTaskLock(home, record.task, fn) : fn();
}
function captureRetirement(ref, file, record, env = process.env, taskLocked) {
    return underRecordTask(record, () => {
        const version = recordVersion(file), entry = opencodeRegistry.readSession(ref, env);
        const entryVersion = entry ? recordVersion(opencodeRegistry.sessionFile(ref, env)) : null;
        const participantState = () => {
            const p = record.home && record.task && taskExists(record.home, record.task) ? participantOf(readTask(record.home, record.task), record.address) : null;
            return [p?.harness, p?.sessionRef, p?.metadata.sessionRecord, p?.metadata.nativeLaunchId, p?.metadata.sessionId];
        };
        const participant = participantState();
        const current = readRecordAt(file);
        if (!current || current.ref !== record.ref || current.launchId !== record.launchId || current.sessionId !== record.sessionId
            || current.holderPid !== record.holderPid || !isDeepStrictEqual(current.holderProcess, record.holderProcess)
            || current.home !== record.home || current.task !== record.task || current.address !== record.address
            || (entry && (entry.recordPath !== file || entry.launchId !== record.launchId || entry.sessionId !== record.sessionId))
            || (participant[0] !== undefined && (participant[0] !== OPENCODE || participant[1] !== ref
                || (participant[2] !== undefined && participant[2] !== file)
                || (record.sessionId && participant[4] !== undefined && participant[4] !== record.sessionId)))
            || !sameRecordVersion(version) || (entryVersion && !sameRecordVersion(entryVersion))) {
            throw new GateError(`OpenCode launch ${ref} changed ownership before native cleanup: ${file}`);
        }
        return (cleanup) => underRecordTask(record, () => {
            if (!sameRecordVersion(version) || !isDeepStrictEqual(participantState(), participant)
                || (entryVersion ? !sameRecordVersion(entryVersion) : existsSync(opencodeRegistry.sessionFile(ref, env)))) {
                throw new GateError(`OpenCode launch ${ref} changed ownership during native cleanup; replacement retained: ${file}`);
            }
            cleanup();
        }, taskLocked);
    }, taskLocked);
}
// Lift a worker session from its plan: holder up, session created, first turn sent. The record
// binds holder port, password, holder pid and session id before the turn runs.
async function spawn(rawPlan, { tool, home, task, address, cwd, env, ref, role, launchFailNote = '', persist = null, }) {
    const plan = rawPlan;
    const bin = opencodeBin(tool);
    const file = recordPath(home, task, address, ref);
    const dir = file ? path.dirname(file) : null;
    if (dir)
        mkdirSync(dir, { recursive: true });
    const log = file ? `${file}.holder.log` : null;
    const runEnv = { ...(plan.env ?? env ?? {}) };
    const record = {
        ...holderRecord({ home, task, address, password: plan.holder?.password ?? runEnv.OPENCODE_SERVER_PASSWORD ?? null,
            log, cwd: plan.cwd ?? cwd }),
        ref, launchId: plan.service?.launchId ?? plan.launchId ?? randomUUID(),
        launcherProcess: processIdentity(process.pid),
    };
    if (file)
        underRecordTask(record, () => writeJsonAtomic(file, record, { mode: 0o600 }));
    if (file)
        plan.liveSeat?.staged(file, record.launchId);
    const ownsRecord = () => !file || (() => {
        const current = readRecordAt(file);
        return current?.ref === ref && current.launchId === record.launchId
            && current.home === home && current.task === task && current.address === address;
    })();
    const publishRecord = (expected) => underRecordTask(record, () => {
        if (!ownsRecord() || (expected && !sameRecordVersion(expected)))
            throw new GateError(`OpenCode launch ${ref} changed its owned record`);
        if (file)
            writeJsonAtomic(file, record, { mode: 0o600 });
    });
    const initialVersion = file ? recordVersion(file) : null;
    if (plan.service)
        plan.sessionRecord = file;
    const undo = plan.service && file && role !== 'teamlead' ? bindBeforeLaunch(home, task, address, { sessionRecord: file }) : () => { };
    let child = null;
    let admitted = !plan.service;
    let nativeBin = bin;
    try {
        if (plan.service) {
            if (!file)
                throw new GateError('OpenCode shared HTTP launch requires its owned record');
            const selected = wouldResolve(bin, runEnv, plan.cwd ?? cwd);
            if (!selected || !isDeepStrictEqual(plan.argv, ['serve', '--port', '0', '--hostname', '127.0.0.1'])) {
                throw new GateError('OpenCode shared launch requires its owned local serve command');
            }
            if (runEnv.OPENCODE_SIMULATE)
                throw new GateError('OpenCode managed native admission does not support simulation');
            const dataHome = runEnv.XDG_DATA_HOME || (runEnv.HOME ? path.join(runEnv.HOME, '.local', 'share') : null);
            if (!dataHome || !path.isAbsolute(dataHome))
                throw new GateError('OpenCode managed launch requires its actual absolute native data root');
            const nativeDataHome = realpathSync(dataHome);
            const database = runEnv.OPENCODE_DB ?? path.join(nativeDataHome, 'opencode', 'opencode.db');
            if (!path.isAbsolute(database) || database === ':memory:')
                throw new GateError('OpenCode managed native admission requires an absolute filesystem database');
            const databaseParent = path.dirname(database);
            const nativeDatabase = existsSync(databaseParent) ? path.join(realpathSync(databaseParent), path.basename(database)) : database;
            runEnv.XDG_DATA_HOME = nativeDataHome;
            runEnv.OPENCODE_DB = nativeDatabase;
            nativeBin = realpathSync(selected);
            record.nativeCommand = { executable: recordVersion(nativeBin), argv: [...plan.argv],
                nativeEnvironment: { XDG_DATA_HOME: nativeDataHome, OPENCODE_DB: nativeDatabase,
                    ...(runEnv.OPENCODE_SIMULATE !== undefined ? { OPENCODE_SIMULATE: runEnv.OPENCODE_SIMULATE } : {}) } };
            publishRecord(initialVersion);
            await plan.service.beforeStart(file);
        }
        const stagedVersion = plan.service && file ? recordVersion(file) : null;
        plan.liveSeat?.starting();
        child = startHolder(nativeBin, plan.argv, { cwd: plan.cwd ?? cwd, env: runEnv, log });
        const started = await new Promise((resolve) => {
            child.once('error', resolve);
            child.once('spawn', () => resolve(null));
        });
        if (started)
            throw new GateError(`opencode serve did not start: ${started.message}.${launchFailNote}`);
        if (child.pid === undefined)
            throw new GateError(`opencode serve did not start.${launchFailNote}`);
        record.holderPid = child.pid;
        record.holderProcess = processIdentity(child.pid);
        publishRecord(stagedVersion);
        const holderVersion = plan.service && file ? recordVersion(file) : null;
        const fail = note => { throw new GateError(`${note}.${launchFailNote}`); };
        const url = await waitHolderUrl(child.pid, log);
        if (!url)
            fail('the holder never printed its listening port');
        const password = record.password;
        if (!await waitReady(url, password, { timeoutMs: APPEAR_TIMEOUT_MS })) {
            fail('the holder never answered its session list');
        }
        record.url = url;
        publishRecord(holderVersion);
        const endpointVersion = plan.service && file ? recordVersion(file) : null;
        if (plan.service && (!record.holderProcess || processState(record.holderProcess) !== 'alive'
            || !record.nativeCommand || await processExecutable(record.holderProcess) !== record.nativeCommand.executable.file
            || !sameRecordVersion(record.nativeCommand.executable)))
            fail('the owned serve process/image is not current');
        if (plan.service) {
            record.nativeCreationPending = { endpoint: url };
            publishRecord(endpointVersion);
        }
        const creationVersion = plan.service && file ? recordVersion(file) : null;
        const created = await createSession(url, password, plan.holder?.title ?? ref);
        const sessionId = created?.data?.data?.id ?? null;
        if (created?.status !== 200 || typeof sessionId !== 'string' || !/^\S+$/u.test(sessionId))
            fail(`session create answered ${created?.status ?? 'nothing'} without its actual native ID`);
        if (!ownsRecord() || (creationVersion && !sameRecordVersion(creationVersion))
            || (record.holderProcess && processState(record.holderProcess) !== 'alive'))
            fail('the owned session creation record or process changed before publication');
        const roots = declaredRoots(plan.cwd ?? cwd, [...(plan.roots ?? []), ...(plan.addDirs ?? [])]);
        record.sessionId = sessionId;
        record.roots = roots;
        delete record.nativeCreationPending;
        if (plan.service) {
            record.nativeAdmissionUnknown = { harness: 'opencode', nativeId: sessionId, reason: 'native store/process admission proof is pending' };
            publishRecord(creationVersion);
        }
        const proofVersion = plan.service && file ? recordVersion(file) : null;
        if (plan.service) {
            const command = record.nativeCommand, process = record.holderProcess, nativeStore = command.nativeEnvironment.OPENCODE_DB;
            const database = lstatSync(nativeStore);
            if (!database.isFile() || database.isSymbolicLink() || (globalThis.process.getuid && database.uid !== globalThis.process.getuid())
                || (database.mode & 0o022) !== 0 || realpathSync(nativeStore) !== nativeStore || database.size === 0
                || processState(process) !== 'alive' || await processExecutable(process) !== command.executable.file
                || !sameRecordVersion(command.executable) || (proofVersion && !sameRecordVersion(proofVersion))) {
                fail('the actual filesystem database or owned serve generation is unavailable after create');
            }
            record.nativeAdmission = { harness: 'opencode', nativeStore, nativeId: sessionId, process };
            record.nativeAdmissionEvidence = { kind: 'opencode-session-api', method: 'session/create', nativeStore, nativeId: sessionId,
                process, endpoint: url, executable: command.executable };
            delete record.nativeAdmissionUnknown;
        }
        else
            record.nativeAdmissionUnknown = { harness: 'opencode', nativeId: sessionId,
                reason: 'this legacy launch has no managed native-store publication' };
        publishRecord(proofVersion);
        if (plan.service) {
            underRecordTask(record, () => opencodeRegistry.writeSession({ ref, recordPath: file, sessionId, home, task, address, launchId: record.launchId }, env));
            persist?.(sessionId, 'alive', sessionId);
            await plan.service.realize(sessionId);
            const client = readPrivate(plan.service.credentialFile);
            admitted = recordOf(client) && recordOf(client.nativeBinding) && client.nativeBinding.kind === 'opencode'
                && client.nativeBinding.state === 'bound' && client.nativeBinding.sessionId === sessionId;
            if (!admitted)
                fail('the exact native grant remains pending; the first prompt was not sent');
        }
        const sent = await sendPrompt(url, password, sessionId, plan.prompt);
        if (sent?.status !== 200)
            fail(`the first turn answered ${sent?.status ?? 'nothing'}`);
        try {
            await settlePermissionAsks({
                url, password, sessionId, roots, pollMs: plan.permissionPollMs ?? PERMISSION_POLL_MS,
            });
        }
        catch (caught) {
            const error = caught;
            if (error instanceof GateError)
                fail(error.message);
            throw error;
        }
        if (!plan.service) {
            underRecordTask(record, () => opencodeRegistry.writeSession({ ref, recordPath: file, sessionId, home, task, address, launchId: record.launchId }, env));
            persist?.(sessionId, 'alive', sessionId);
        }
        return { output: '', session: sessionId, seen: { state: 'alive', session: { id: sessionId, sessionId }, ghost: null } };
    }
    catch (caught) {
        const error = caught;
        return revokeFailedManagedLaunch(plan, error, async () => {
            if (record.nativeCreationPending || (plan.service && record.sessionId && !admitted)) {
                throw new GateError(`OpenCode native creation/admission is unresolved; retained its primary record and owned holder: ${file}`);
            }
            if (!ownsRecord())
                throw new GateError(`OpenCode launch ${ref} changed ownership before cleanup`);
            const retire = file ? captureRetirement(ref, file, record, env) : (cleanup) => cleanup();
            if (child?.pid)
                await reapHolder(child.pid, { identity: record.holderProcess });
            retire(() => {
                undo();
                if (log)
                    rmSync(log, { force: true });
                opencodeRegistry.dropSession(ref, env);
                if (file)
                    rmSync(file, { force: true });
            });
            plan.liveSeat?.stopped();
        });
    }
}
// The holder prints its port on stdout; `--port 0` lets it choose. A missing line after the
// ceiling is a failed lift, not a slow one.
async function waitHolderUrl(pid, log, { timeoutMs = APPEAR_TIMEOUT_MS, stepMs = 200 } = {}) {
    const edge = Date.now() + timeoutMs;
    for (;;) {
        if (!pidAlive(pid))
            return null;
        try {
            const port = portOfLog(log ? readFileSync(log, 'utf8') : '');
            if (port)
                return holderUrl(port);
        }
        catch { /* log not written yet */ }
        if (Date.now() >= edge)
            return null;
        await new Promise((r) => { setTimeout(r, stepMs); });
    }
}
// Snapshot state, ref-only: the registry names the record. No entry — null, unknown is not
// death. Synchronous: the warden calls it on its beat, so the list call is one subprocess.
function inspect(ref) {
    const entry = opencodeRegistry.readSession(ref);
    const record = entry?.recordPath ? readRecordAt(entry.recordPath) : null;
    if (!record?.holderPid)
        return null;
    if (!pidAlive(record.holderPid)) {
        return { state: 'gone', busy: false, stall: null, id: record.sessionId ?? null, note: 'holder process is gone' };
    }
    if (!record.url || !record.sessionId) {
        return { state: 'alive', busy: true, stall: null, id: null, note: 'holder up, lift in progress' };
    }
    const list = listSessionsSync(record);
    if (list === null) {
        return { state: 'unknown', busy: false, stall: null, id: record.sessionId, note: PHRASES.unreadable };
    }
    return viewOf(record, list, remainingPermissionAsks(record));
}
/** Pending asks after declared-root replies. Null when the permission route cannot be read. */
export function remainingPermissionAsks(record, runFn = run) {
    const read = () => {
        const res = holderRequestSync(record.url, record.password, 'GET', `/api/session/${record.sessionId}/permission`, undefined, runFn);
        if (res?.status !== 200)
            return null;
        return parsePermissionList(res.data);
    };
    const first = read();
    if (!Array.isArray(first))
        return null;
    const roots = Array.isArray(record.roots) && record.roots.length ? record.roots : declaredRoots(record.cwd);
    const answerable = first.filter((ask) => coveredExternalDirectory(ask, roots) && typeof ask.id === 'string' && ask.id);
    if (!answerable.length)
        return first;
    let repliedAll = true;
    for (const ask of answerable) {
        const replied = holderRequestSync(record.url, record.password, 'POST', `/api/session/${record.sessionId}/permission/${ask.id}/reply`, { decision: 'once' }, runFn);
        if (replied?.status !== 200 && replied?.status !== 204)
            repliedAll = false;
    }
    const again = read();
    if (Array.isArray(again))
        return again;
    return repliedAll ? null : first;
}
export function listSessionsSync(record, runFn = run) {
    const r = runFn(opencodeBin(), apiArgv(record), {
        cwd: record.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: record.password },
    });
    if (r.error || r.status !== 0)
        return null;
    return parseSessionList(r.stdout);
}
/** The argv reading the holder session list: one local subprocess per heartbeat. */
export function apiArgv(record) {
    return ['api', '--server', record.url, 'session.list'];
}
/** The `{data:[...]}` envelope off the list call, or null when it does not parse. */
export function parseSessionList(text) {
    try {
        const doc = JSON.parse(String(text ?? ''));
        return Array.isArray(doc?.data) ? doc.data : null;
    }
    catch {
        return null;
    }
}
/** The snapshot view off a list the holder answered. A pending ask is not a model call. */
export function viewOf(record, list, asks = undefined) {
    const hit = (list ?? []).find((raw) => raw?.id === record.sessionId);
    if (!hit) {
        return { state: 'gone', busy: false, stall: null, id: record.sessionId, note: 'session left the holder list' };
    }
    if (asks === null) {
        return { state: 'alive', busy: true, stall: null, id: record.sessionId, note: 'permission list unreadable' };
    }
    if (Array.isArray(asks) && asks.length) {
        return { state: 'alive', busy: true, stall: null, id: record.sessionId, note: pendingPermissionNote(asks) };
    }
    const busy = !hit?.time?.idle;
    return { state: 'alive', busy, stall: null, id: record.sessionId, note: busy ? 'turn running' : 'idle' };
}
// What is said about lift after success. The holder log carries the port; the session id names
// the turn to watch.
function saidLiftoff({ output, session }) {
    if (output)
        info(output);
    if (session)
        info(`opencode session ${session} on its holder — watch it with the record beside the task`);
}
function forgetSessions() { }
// Stop a session, ref-only. Idempotent: no entry is an outcome with its own words. The session
// is deleted first — the holder is its server, and after the reap no delete would reach it.
async function stop(ref) {
    const entry = opencodeRegistry.readSession(ref);
    const record = entry?.recordPath ? readRecordAt(entry.recordPath) : null;
    if (!record) {
        if (entry) {
            const version = recordVersion(opencodeRegistry.sessionFile(ref));
            underRecordTask(entry, () => {
                if (!sameRecordVersion(version) || !isDeepStrictEqual(opencodeRegistry.readSession(ref), entry)
                    || (entry.recordPath && existsSync(entry.recordPath)))
                    throw new GateError(`OpenCode launch ${ref} changed before empty retirement`);
                opencodeRegistry.dropSession(ref);
            });
        }
        return { ok: true, stopped: false, note: `no opencode session record for «${ref}»` };
    }
    const retire = captureRetirement(ref, entry.recordPath, record);
    if (record.url && record.sessionId) {
        try {
            await deleteSession(record.url, record.password, record.sessionId);
        }
        catch { /* holder already gone; the reap below is the cleanup */ }
    }
    await reapHolder(record.holderPid, { identity: record.holderProcess });
    retire(() => {
        if (record.log)
            rmSync(record.log, { force: true });
        opencodeRegistry.dropSession(ref);
        if (entry.recordPath)
            rmSync(entry.recordPath, { force: true });
    });
    return { ok: true, stopped: true, note: `session ${record.sessionId} stopped` };
}
// Sweep only this participant's harness state; done walks a closed task participant by participant.
// The task and address must both match before a holder, record, log or registry entry is removed.
export async function sweepParticipant(participant, taskId, env = process.env, context) {
    const address = addressOf(participant);
    if (!address || !taskId)
        return { swept: 0 };
    const scope = context ? { home: canonicalPath(context.home), task: context.task } : null;
    if (scope && scope.task !== taskId)
        throw new GateError('OpenCode cleanup context names a different task');
    const taskLocked = context?.taskLocked ? scope : undefined;
    const records = opencodeRegistry.registrySessions(env)
        .filter((r) => r?.task === taskId && r?.address === address);
    if (!records.length) {
        if (!scope)
            throw new GateError(`OpenCode cleanup cannot prove the owned primary record absent without its task scope: ${participant.sessionRef}`);
        return underRecordTask(scope, () => {
            const current = participantOf(readTask(scope.home, taskId), address);
            if (!current || current.harness !== OPENCODE || current.sessionRef !== participant.sessionRef
                || current.metadata.sessionId !== participant.metadata.sessionId
                || current.metadata.sessionRecord !== participant.metadata.sessionRecord
                || current.metadata.nativeLaunchId !== participant.metadata.nativeLaunchId) {
                throw new GateError(`OpenCode cleanup selected participant changed before proving absence: ${participant.sessionRef}`);
            }
            const primary = safeRecordPath(scope.home, taskId, address, participant.sessionRef ?? null);
            if (!primary)
                throw new GateError(`OpenCode cleanup has no exact owned primary path: ${participant.sessionRef}`);
            const selected = participant.sessionRef ? opencodeRegistry.sessionFile(participant.sessionRef, env) : null;
            for (const file of new Set([selected, primary, participant.metadata.sessionRecord].filter(Boolean))) {
                try {
                    lstatSync(file);
                }
                catch (error) {
                    if (error.code === 'ENOENT')
                        continue;
                    throw new GateError(`OpenCode cleanup cannot read its selected record; cleanup is unknown: ${file}`);
                }
                throw new GateError(`OpenCode cleanup has a selected record without a matching registry entry; retained: ${file}`);
            }
            return { swept: 0 };
        }, taskLocked);
    }
    let swept = 0;
    for (const r of records) {
        const record = r.recordPath ? readRecordAt(r.recordPath) : null;
        if (!record || !r.recordPath)
            throw new GateError(`OpenCode launch ${r.ref} has no readable owned record; cleanup is unknown: ${r.recordPath}`);
        if (scope && (!record.home || canonicalPath(record.home) !== scope.home || record.task !== scope.task)) {
            throw new GateError(`OpenCode launch ${r.ref} belongs to another task scope; retained: ${r.recordPath}`);
        }
        if (participant.sessionRef !== r.ref || participant.metadata.sessionId !== record.sessionId
            || record.launchId !== r.launchId || record.sessionId !== r.sessionId) {
            throw new GateError(`OpenCode launch ${r.ref} changed its selected native identity before cleanup: ${r.recordPath}`);
        }
        const retire = captureRetirement(r.ref, r.recordPath, record, env, taskLocked);
        if (record.url && record.sessionId) {
            try {
                await deleteSession(record.url, record.password, record.sessionId);
            }
            catch { /* The captured holder still requires confirmed reap. */ }
        }
        await reapHolder(record.holderPid, { identity: record.holderProcess });
        retire(() => {
            if (r.recordPath)
                rmSync(`${r.recordPath}.holder.log`, { force: true });
            opencodeRegistry.dropSession(r.ref, env);
            if (r.recordPath)
                rmSync(r.recordPath, { force: true });
        });
        swept += 1;
    }
    return { swept };
}
/** Contact point of an opencode participant: the session-record path. The record holds url,
 * password and session id behind mode 0600 — no secret travels the journal. */
export function registerWake(home, task, addr, env = process.env, session = null) {
    try {
        const file = String(env?.[SESSION_RECORD_VAR] ?? '').trim();
        if (!file)
            return null;
        const record = readRecordAt(file);
        // The bus server hands over with no session argument; the record names it.
        const who = session ?? record?.sessionId ?? null;
        if (!who)
            return null;
        if (record?.sessionId && record.sessionId !== who)
            return null;
        const held = foreignSession(home, task, addr, who);
        if (held) {
            sayForeignWrite(home, task, addr, held, who, 'contact-point handoff');
            return false;
        }
        const at = wakeAddressOf(home, task, addr);
        return writeWake(home, at.task, at.address, { socket: file, token: null, session: who });
    }
    catch {
        return null;
    }
}
/** Channel smoke: the holder process is up and the record names a session. It answers no
 * turn state — an optimistic smoke for doctor/integration; `activate` is the real gate. */
export function checkWake(env = process.env) {
    const file = String(env?.[SESSION_RECORD_VAR] ?? '').trim();
    if (!file)
        return { endpoint: null, ok: false, error: `${SESSION_RECORD_VAR} is empty — not an opencode participant session` };
    const record = readRecordAt(file);
    if (!record?.url || !record?.sessionId)
        return { endpoint: file, ok: false, error: 'no holder url or session id at this path — lift is not confirmed' };
    if (!pidAlive(record.holderPid))
        return { endpoint: file, ok: false, error: 'holder process is gone' };
    return { endpoint: file, ok: true, error: null };
}
export function renderNotification(n) {
    return commonOrderBody(n.task, n.address, n.unread, n.messages ?? [], {
        fetchLine: `Fetch the mailbox with \`${PHRASES.tool(PROMPTOBUS_SERVER, 'promptobus_mailbox')}\`: only that tool marks messages read. `,
    });
}
/** Wake a participant with a follow-up turn on its session. An idle session takes the text; a
 * running turn refuses honestly, and the warden falls back to self-wake and retries. */
export async function activate(target, notification) {
    // The warden hands the wake record's socket; older callers hand the record path itself.
    const file = String(target?.endpoint?.socket ?? target?.endpoint ?? '').trim();
    if (!file)
        return { ok: false, error: 'the participant record has no contact point — nothing to wake' };
    const record = readRecordAt(file);
    if (!record?.url || !record?.sessionId) {
        return { ok: false, error: 'no holder url or session id at the contact point' };
    }
    if (!pidAlive(record.holderPid))
        return { ok: false, error: 'holder process is gone — lift the participant again' };
    let messages;
    try {
        messages = await readMessages(record.url, record.password, record.sessionId, 3);
    }
    catch (caught) {
        const error = caught;
        return { ok: false, error: `the preceding turn state could not be read: ${error.message}` };
    }
    const items = Array.isArray(messages?.data) ? messages.data : messages?.data?.data;
    if (messages?.status !== 200 || !Array.isArray(items) || !items.length || typeof items[0]?.type !== 'string') {
        return { ok: false, error: 'the preceding turn state is unreadable — the message waits for proven idle' };
    }
    if (idleOutcome(items) === null) {
        return { ok: false, error: 'a turn is running — the message waits for its idle' };
    }
    const sent = await sendPrompt(record.url, record.password, record.sessionId, renderNotification(notification));
    if (sent?.status !== 200)
        return { ok: false, error: `the follow-up turn answered ${sent?.status ?? 'nothing'}` };
    try {
        await settlePermissionAsks({
            url: record.url, password: record.password, sessionId: record.sessionId,
            roots: Array.isArray(record.roots) && record.roots.length ? record.roots : declaredRoots(record.cwd),
            pollMs: 0,
        });
    }
    catch (caught) {
        const error = caught;
        return { ok: false, error: error.message };
    }
    return { ok: true };
}
/** Recovery instructions for a holder-backed session; no interactive attach is advertised. */
function stallRoute({ kind }) {
    if (kind === 'gone' || kind === 'stale') {
        return 'the holder or its session is gone — nobody to wake. Work delivered — a normal end; '
            + 'otherwise repeat the original lift with --harness opencode';
    }
    if (kind === 'wake-taken') {
        return 'the session is alive, but another session holds its contact point. Check the session record '
            + `and ${PHRASES.logs()}; the bound session restores its contact point on its next bus call`;
    }
    return `inspect the session record and ${PHRASES.logs()}. A follow-up prompt runs when the session `
        + 'is idle; a running turn holds queued mail until it ends';
}
/** OpenCode driver — worker, reviewer and approver lifts through a per-participant holder. */
export const opencodeDriver = {
    id: OPENCODE,
    capabilities: {
        spawn: true,
        attach: false,
        activation: 'push',
        inspect: true,
        stop: true,
        denyTools: true,
        mcpDenyTools: true,
        systemPrompt: true,
        sessionList: true,
        enter: true,
        approverLift: true,
    },
    options: {
        tool: OPENCODE,
        effortLevels: EFFORT_LEVELS,
        permissionModes: PERMISSION_MODES,
        defaultPermissionMode: DEFAULT_PERMISSION_MODE,
        defaultModel: DEFAULT_MODEL,
        provenVersion: '2.0.20',
        denyTools: REVIEWER_DENY,
        knockChannel: 'http',
        identityVar: null,
        mcpIdentity: { recordVar: SESSION_RECORD_VAR, idField: 'sessionId' },
        envDrop: SESSION_ENV_DROP,
        launchDirs: [],
        selectedContext: true,
    },
    phrases: PHRASES,
    availability: opencodeAvailability(),
    prepare,
    replaceMcpServers,
    mcpDenyTools,
    spawn,
    saidLiftoff,
    inspect,
    forgetSessions,
    stop,
    sweepParticipant,
    activate,
    renderNotification,
    registerWake,
    checkWake,
    stallRoute,
    sayForeignWrite,
    sessionEnv,
    optionRefusal,
    shadowedUserServers,
};
