// Generation of project and managed bus hooks. The record shape is the harness
// contract; the command is the host: absolute node and bin.
import { PROMPTOBUS_SERVER as BUS_SERVER } from './contract.js';
import { shellQuote } from './fs/shell.js';
// Not written any more; kept to find and delete an entry an older install wrote.
// [guides/install.md](../docs/guides/install.md#what-the-installer-writes)
export const BUS_HOOK_EVENT = 'PostToolUse';
export { BUS_SERVER };
export const GUARD_HOOK_EVENT = 'Stop';
export const GUARD_START_EVENT = 'SessionStart';
function quoteFlag(value, platform) {
    return platform === 'win32'
        ? `"${String(value).replace(/"/g, '""')}"`
        : shellQuote(value);
}
export function guardHookCommand(host, identity = null, platform = 'posix') {
    return renderGuardCommand(host.nodePath(), host.guardArgv(['guard']), identity, platform);
}
export function managedGuardHookCommand(host, identity, platform = 'posix') {
    return renderGuardCommand(host.nodePath(), host.busArgv(['guard']), identity, platform);
}
function renderGuardCommand(nodePath, argv, identity, platform) {
    const identityFlags = identity
        ? [
            '--role', quoteFlag(identity.address, platform),
            '--task', quoteFlag(identity.taskId, platform),
            '--home', quoteFlag(identity.home, platform),
        ]
        : [];
    return [
        `"${nodePath}"`,
        ...argv.map((arg, index) => index === 0 ? `"${arg}"` : arg),
        ...identityFlags,
    ].join(' ');
}
export function guardHookSettings(host, identity = null, platform = 'posix') {
    const command = guardHookCommand(host, identity, platform);
    const group = () => [{ hooks: [{ type: 'command', command }] }];
    return { [GUARD_HOOK_EVENT]: group(), [GUARD_START_EVENT]: group() };
}
export function planPromptobusHooks(host, identity = null, platform = 'posix') {
    return { settings: guardHookSettings(host, identity, platform) };
}
