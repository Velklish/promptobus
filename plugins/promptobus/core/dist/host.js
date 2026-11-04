// The host contract, in one sentence per member.
// [reference/02-host.md#the-host-contract-in-one-sentence-per-member](../docs/reference/02-host.md#the-host-contract-in-one-sentence-per-member)
import path from 'node:path';
import { ROOT_DIR } from './v1/layout.js';
/** Host object marker: the suite uses it to tell a host from a root string. */
export const HOST_KIND = 'promptobus-host';
export class HostResolveError extends Error {
    candidates;
    constructor(message, candidates = []) {
        super(message);
        this.name = 'HostResolveError';
        this.candidates = candidates;
    }
}
export function isPromptobusHost(value) {
    if (!value || typeof value !== 'object')
        return false;
    const rec = value;
    return rec.kind === HOST_KIND
        && typeof rec.workspaceRoot === 'function'
        && typeof rec.commandName === 'string';
}
export function homeOfRoot(root, rel = ROOT_DIR) {
    return path.join(root, rel);
}
