import { createHash } from 'node:crypto';
import path from 'node:path';
import type { JsonRpcMessage } from '../dist/mcp/server.js';
import { requireKnownNativeOutcomes } from './native-admission.js';
import { REVIEW_FILE_TOOLS } from './reviewer-files.js';
import { HttpFailure } from './service-grant.js';
import { privateDirectory, readPrivate, recordOf, writePrivate } from './service-state.js';
import type { ServicePaths } from './service-state.js';

interface RequestReceipt { digest: string; state: 'started' | 'completed'; readOnly: boolean; response?: object | null }
const REPLAYABLE_READS = new Set(['read_file', 'read_files', 'list_files', 'search_text']);

function receiptOf(value: unknown): RequestReceipt | null {
  if (!recordOf(value) || typeof value.digest !== 'string' || (value.state !== 'started' && value.state !== 'completed')
    || typeof value.readOnly !== 'boolean' || (value.response !== undefined && value.response !== null && !recordOf(value.response))) return null;
  return { digest: value.digest, state: value.state, readOnly: value.readOnly, ...(value.response === undefined ? {} : { response: value.response }) };
}

export function dispatch(paths: ServicePaths, session: { id: string; endpoint: string }, message: JsonRpcMessage, connection: { handle(message: JsonRpcMessage): object | null }, rootNonce?: string) {
  if (message.method !== 'tools/call' || message.id === undefined || message.id === null) return connection.handle(message);
  const key = createHash('sha256').update(JSON.stringify(message.id)).digest('hex');
  const digest = createHash('sha256').update(JSON.stringify(message)).digest('hex');
  const readOnly = session.endpoint === 'reviewer_files'
    && typeof message.params?.name === 'string' && REPLAYABLE_READS.has(message.params.name)
    && REVIEW_FILE_TOOLS.some(tool => tool.name === message.params?.name && tool.annotations.readOnlyHint === true);
  const directory = rootNonce ? path.join(paths.requests, `root-${rootNonce}`, session.id) : path.join(paths.requests, session.id);
  privateDirectory(directory);
  const file = path.join(directory, `${key}.json`), previous = readPrivate(file);
  if (previous !== null) {
    const receipt = receiptOf(previous);
    if (!receipt) throw new HttpFailure(409, 'The saved request receipt is invalid; inspect the journal before retrying');
    if (receipt.digest !== digest) throw new HttpFailure(409, 'This request id was already used for different arguments');
    if (receipt.readOnly && readOnly) return connection.handle(message);
    if (receipt.state === 'started') throw new HttpFailure(409, 'The earlier request outcome is uncertain; inspect the journal instead of repeating it');
    return receipt.response ?? null;
  }
  writePrivate(file, { digest, state: 'started', readOnly });
  const response = connection.handle(message);
  writePrivate(file, { digest, state: 'completed', readOnly, ...(readOnly ? {} : { response }) });
  return response;
}

export function requireKnownRootOutcomes(paths: ServicePaths, nonce: string) {
  try { requireKnownNativeOutcomes(paths, nonce); }
  catch (error) { throw new HttpFailure(409, error instanceof Error ? error.message : 'Native request outcomes are unavailable'); }
}
