import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GateError } from '../dist/index.js';

/** A participant consumes subscription access credentials but never rotates the owner's refresh
 * token. [05-drivers.md](../docs/reference/05-drivers.md#codex-participant-authentication) */
export function participantAuthSnapshot(source, ownerHome, now = Date.now()) {
  const value = JSON.parse(source);
  if (value.auth_mode !== 'chatgpt' && !value.tokens?.refresh_token) return source;
  let expires = null;
  try {
    expires = JSON.parse(Buffer.from(value.tokens.access_token.split('.')[1], 'base64url')).exp;
  } catch {
    expires = null;
  }
  if (!Number.isFinite(expires) || expires * 1000 <= now + 600_000) {
    throw new GateError(`Codex owner's access token has unknown expiry or expires within 10 minutes — `
      + `sign in again in the owner's Codex home ${ownerHome} before lifting a participant; no model turn started`);
  }
  value.tokens.refresh_token = '';
  return JSON.stringify(value);
}

function authSource(home) {
  try {
    return readFileSync(path.join(home, 'auth.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new GateError(`Codex auth.json at ${home} could not be read (${error.code}); no model turn started`);
  }
}

function authValue(source, home) {
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new GateError(`Codex auth.json at ${home} is not valid auth JSON; no model turn started`);
  }
}

const authMode = value => value.auth_mode ?? (value.tokens ? 'chatgpt' : 'apikey');
const accountId = value => value.tokens?.account_id ?? value.account_id;

export function createParticipantAuthReload({ ownerHome, participantHome, reload }) {
  const initialSource = authSource(participantHome);
  const original = initialSource === null ? null : authValue(initialSource, participantHome);
  let loadedSnapshot = JSON.stringify(original);
  let authNeedsReload = false;
  return async function sync({ busy = false } = {}) {
    const source = authSource(ownerHome);
    const previous = authSource(participantHome);
    if (source === null) {
      if (previous !== null) {
        throw new GateError(`Codex owner's auth.json is missing at ${ownerHome}; sign in there before another participant turn`);
      }
      return { changed: false, reloaded: false };
    }
    const value = authValue(source, ownerHome);
    const snapshot = participantAuthSnapshot(source, ownerHome);
    const old = previous === null ? null : authValue(previous, participantHome);
    const normalized = JSON.stringify(authValue(snapshot, ownerHome));
    const changed = JSON.stringify(old) !== normalized;
    const needsReload = changed || authNeedsReload || loadedSnapshot !== normalized;
    if (original && (authMode(original) !== authMode(value)
      || (authMode(value) === 'chatgpt' && (accountId(original) !== accountId(value)
        || (needsReload && (!accountId(original) || !accountId(value))))))) {
      throw new GateError('Codex owner authentication identity changed or is unknown; restart the participant before another model turn');
    }
    if (!needsReload) return { changed: false, reloaded: false };
    if (busy) {
      throw new GateError('Codex participant authentication changed during an active turn; retry after the turn completes');
    }
    authNeedsReload = true;
    if (changed) {
      const target = path.join(participantHome, 'auth.json');
      writeFileSync(target, snapshot, { mode: 0o600 });
      chmodSync(target, 0o600);
    }
    const response = await reload();
    if (response?.error) {
      throw new GateError(`Codex participant auth reload failed: ${response.error.message ?? 'account/read returned an error'}`);
    }
    loadedSnapshot = normalized;
    authNeedsReload = false;
    return { changed, reloaded: true };
  };
}
