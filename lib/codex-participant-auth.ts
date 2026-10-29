import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GateError } from '../dist/index.js';

function property(value: unknown, key: string): unknown {
  // Keep the native nullish property-access failure.
  if (value == null) return (value as never)[key];
  return Reflect.get(Object(value), key);
}
function optionalProperty(value: unknown, key: string): unknown {
  return value == null ? undefined : property(value, key);
}

/** A participant consumes subscription access credentials but never rotates the owner's refresh
 * token. [05-drivers.md](../docs/reference/05-drivers.md#codex-participant-authentication) */
export function participantAuthSnapshot(source: string, ownerHome: string, now = Date.now()) {
  const value: unknown = JSON.parse(source);
  if (property(value, 'auth_mode') !== 'chatgpt' && !optionalProperty(property(value, 'tokens'), 'refresh_token')) return source;
  let expires: unknown = null;
  try {
    const accessToken = property(property(value, 'tokens'), 'access_token');
    if (typeof accessToken !== 'string') throw new TypeError();
    const payload: unknown = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString());
    expires = property(payload, 'exp');
  } catch {
    expires = null;
  }
  if (typeof expires !== 'number' || !Number.isFinite(expires) || expires * 1000 <= now + 600_000) {
    throw new GateError(`Codex owner's access token has unknown expiry or expires within 10 minutes — `
      + `sign in again in the owner's Codex home ${ownerHome} before lifting a participant; no model turn started`);
  }
  Reflect.set(Object(property(value, 'tokens')), 'refresh_token', '');
  return JSON.stringify(value);
}

function authSource(home: string) {
  try {
    return readFileSync(path.join(home, 'auth.json'), 'utf8');
  } catch (caught) {
    const error = caught as NodeJS.ErrnoException;
    if (error.code === 'ENOENT') return null;
    throw new GateError(`Codex auth.json at ${home} could not be read (${error.code}); no model turn started`);
  }
}

function authValue(source: string, home: string) {
  try {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new GateError(`Codex auth.json at ${home} is not valid auth JSON; no model turn started`);
  }
}

const authMode = (value: object) => property(value, 'auth_mode') ?? (property(value, 'tokens') ? 'chatgpt' : 'apikey');
const accountId = (value: object) => optionalProperty(property(value, 'tokens'), 'account_id') ?? property(value, 'account_id');

export function createParticipantAuthGuard({ ownerHome, participantHome }: { ownerHome: string; participantHome: string }) {
  const initialSource = authSource(participantHome);
  const original = initialSource === null ? null : authValue(initialSource, participantHome);
  const loadedSnapshot = JSON.stringify(original);
  let refused: GateError | null = null;
  return async function check({ busy = false }: { busy?: boolean } = {}) {
    if (refused) throw refused;
    try {
      const source = authSource(ownerHome);
      const previous = authSource(participantHome);
      if (source === null) {
        if (original !== null || previous !== null) {
          throw new GateError(`Codex owner's auth.json is missing at ${ownerHome}`);
        }
        return;
      }
      const value = authValue(source, ownerHome);
      const snapshot = participantAuthSnapshot(source, ownerHome);
      const normalized = JSON.stringify(authValue(snapshot, ownerHome));
      if (original && (authMode(original) !== authMode(value)
        || (authMode(value) === 'chatgpt' && (accountId(original) !== accountId(value)
          || (loadedSnapshot !== normalized && (!accountId(original) || !accountId(value))))))) {
        throw new GateError('Codex owner authentication identity changed or is unknown');
      }
      if (loadedSnapshot !== normalized) {
        throw new GateError('Codex owner sign-in/access snapshot changed');
      }
      const privateSnapshot = previous === null ? null : authValue(previous, participantHome);
      if (JSON.stringify(privateSnapshot) !== loadedSnapshot) {
        throw new GateError('Codex participant access snapshot changed or is missing');
      }
    } catch (caught) {
      const error = caught as Error;
      refused = new GateError(`${error.message}${busy ? ' during an active turn' : ''}; `
        + 'a fresh lift is required from the owner sign-in/access snapshot before another model turn; no model turn started');
      throw refused;
    }
  };
}
