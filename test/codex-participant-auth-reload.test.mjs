import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { check } from './check.mjs';
import { createParticipantAuthReload, participantAuthSnapshot } from '../lib/codex-participant-auth.js';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'promptobus-auth-'));
const now = Math.floor(Date.now() / 1000);
const token = (signature, exp = now + 3600) => `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.${signature}`;
const auth = (signature, extra = {}) => ({ auth_mode: 'chatgpt', tokens: {
  access_token: token(signature), refresh_token: 'owner-refresh-DO-NOT-ROTATE', account_id: 'same-account',
}, ...extra });
let seq = 0;
function fixture(initial = auth('invalid-signature'), reloadFailure = null) {
  const dir = path.join(scratch, String(++seq));
  const ownerHome = path.join(dir, 'owner'), participantHome = path.join(dir, 'participant');
  mkdirSync(ownerHome, { recursive: true });
  mkdirSync(participantHome);
  const ownerFile = path.join(ownerHome, 'auth.json'), privateFile = path.join(participantHome, 'auth.json');
  writeFileSync(ownerFile, JSON.stringify(initial));
  writeFileSync(privateFile, participantAuthSnapshot(JSON.stringify(initial), ownerHome), { mode: 0o600 });
  let cached = JSON.parse(readFileSync(privateFile));
  const calls = [];
  const sync = createParticipantAuthReload({ ownerHome, participantHome, reload: async () => {
    calls.push({ method: 'account/read', params: { refreshToken: false } });
    if (reloadFailure) { const failure = reloadFailure; reloadFailure = null; throw failure; }
    cached = JSON.parse(readFileSync(privateFile));
    return { account: { type: cached.auth_mode } };
  } });
  return { sync, calls, ownerHome, participantHome, ownerFile, privateFile,
    setOwner: value => writeFileSync(ownerFile, JSON.stringify(value)),
    turn: () => cached.tokens?.access_token.endsWith('.valid-signature') ? 'MODEL_OK' : 'HTTP_401',
  };
}
const refusal = async fn => { try { await fn(); return ''; } catch (error) { return error.message; } };

try {
  const f = fixture();
  const first = await f.sync();
  check('unchanged snapshot leaves cached authentication alone and makes no account/read request',
    !first.changed && !first.reloaded && f.calls.length === 0 && f.turn() === 'HTTP_401');
  const updated = auth('valid-signature');
  f.setOwner(updated);
  const ownerBytes = readFileSync(f.ownerFile, 'utf8');
  const next = await f.sync();
  check('changed owner access recovers an invalid cached credential before the next model turn',
    next.changed && next.reloaded && f.turn() === 'MODEL_OK' && f.calls.length === 1);
  check('reload uses only public account/read with refreshToken false',
    JSON.stringify(f.calls) === JSON.stringify([{ method: 'account/read', params: { refreshToken: false } }]));
  check('private copy has no refresh credential and owner auth bytes are untouched',
    JSON.parse(readFileSync(f.privateFile)).tokens.refresh_token === '' && readFileSync(f.ownerFile, 'utf8') === ownerBytes);
  check('updated private credentials stay mode 0600', (statSync(f.privateFile).mode & 0o777) === 0o600);
  const repeated = await f.sync();
  check('subsequent unchanged turn does not reload again', !repeated.changed && !repeated.reloaded && f.calls.length === 1);
  f.setOwner({ ...updated, tokens: { ...updated.tokens, refresh_token: 'rotated-owner-only' } });
  const refreshed = await f.sync();
  check('owner refresh-token-only rotation does not trigger a private reload', !refreshed.changed && !refreshed.reloaded && f.calls.length === 1);

  const rewritten = fixture();
  rewritten.setOwner(updated);
  writeFileSync(rewritten.privateFile, participantAuthSnapshot(JSON.stringify(updated), rewritten.ownerHome));
  const rewrittenResult = await rewritten.sync();
  check('externally rewritten private auth still reloads an older native cache',
    !rewrittenResult.changed && rewrittenResult.reloaded && rewritten.turn() === 'MODEL_OK' && rewritten.calls.length === 1);
  const switched = fixture();
  const other = { ...updated, tokens: { ...updated.tokens, account_id: 'other-account' } };
  switched.setOwner(other);
  writeFileSync(switched.privateFile, participantAuthSnapshot(JSON.stringify(other), switched.ownerHome));
  check('rewriting both files cannot bypass the original participant identity',
    /identity/.test(await refusal(() => switched.sync())) && switched.calls.length === 0 && switched.turn() === 'HTTP_401');

  const active = fixture();
  const before = readFileSync(active.privateFile, 'utf8');
  active.setOwner(updated);
  check('active turn refuses changed credentials before writing or reloading them',
    /active turn/.test(await refusal(() => active.sync({ busy: true })))
    && readFileSync(active.privateFile, 'utf8') === before && active.calls.length === 0 && active.turn() === 'HTTP_401');
  await active.sync();
  check('the same participant recovers after its active turn ends', active.turn() === 'MODEL_OK' && active.calls.length === 1);
  check('active steering with unchanged credentials stays available', !(await active.sync({ busy: true })).reloaded);

  const retry = fixture(auth('invalid-signature'), new Error('native reload refused once'));
  retry.setOwner(updated);
  check('reload rejection refuses the model turn and retains the old in-memory credential',
    (await refusal(() => retry.sync())) === 'native reload refused once' && retry.turn() === 'HTTP_401' && retry.calls.length === 1);
  const retried = await retry.sync();
  check('failed reload retries even when the already-written private snapshot is unchanged',
    !retried.changed && retried.reloaded && retry.calls.length === 2 && retry.turn() === 'MODEL_OK');

  const response = fixture();
  response.setOwner(updated);
  let responses = 0;
  const responseSync = createParticipantAuthReload({ ownerHome: response.ownerHome, participantHome: response.participantHome,
    reload: async () => ++responses === 1 ? { error: { message: 'native error response' } } : { account: {} },
  });
  check('an RPC error response does not clear the required reload',
    /native error response/.test(await refusal(() => responseSync())) && (await responseSync()).reloaded && responses === 2);

  for (const [name, replacement] of [
    ['another ChatGPT account', { ...updated, tokens: { ...updated.tokens, account_id: 'other-account' } }],
    ['unknown ChatGPT account', { ...updated, tokens: { ...updated.tokens, account_id: undefined } }],
    ['another auth mode', { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-api' }],
  ]) {
    const identity = fixture();
    const original = readFileSync(identity.privateFile, 'utf8');
    identity.setOwner(replacement);
    check(`${name} refuses before replacing credentials or calling account/read`,
      /identity/.test(await refusal(() => identity.sync())) && identity.calls.length === 0
      && readFileSync(identity.privateFile, 'utf8') === original);
  }

  const expired = fixture();
  const old = JSON.parse(readFileSync(expired.privateFile));
  old.tokens.access_token = token('expired-signature', now - 10);
  writeFileSync(expired.privateFile, JSON.stringify(old));
  expired.setOwner(updated);
  await expired.sync();
  check('an expired private snapshot can recover from the fresh owner access snapshot', expired.turn() === 'MODEL_OK');
  const near = fixture();
  const untouched = readFileSync(near.privateFile, 'utf8');
  near.setOwner({ ...updated, tokens: { ...updated.tokens, access_token: token('valid-signature', now + 300) } });
  check('near-expiry owner access refuses without writing or performing owner refresh',
    /expires|expiry/.test(await refusal(() => near.sync())) && near.calls.length === 0 && readFileSync(near.privateFile, 'utf8') === untouched);
  rmSync(near.ownerFile);
  check('missing owner auth refuses stale private credentials', /missing/.test(await refusal(() => near.sync())) && near.calls.length === 0);

  const api = fixture({ auth_mode: 'apikey', OPENAI_API_KEY: 'old-fixture-key' });
  const newApi = { auth_mode: 'apikey', OPENAI_API_KEY: 'new-fixture-key' };
  api.setOwner(newApi);
  check('API-key updates preserve the native auth format without JWT expiry rules',
    (await api.sync()).reloaded && readFileSync(api.privateFile, 'utf8') === JSON.stringify(newApi));
  rmSync(api.ownerFile);
  rmSync(api.privateFile);
  check('without auth files an environment API-key participant needs no snapshot reload', !(await api.sync()).reloaded);

  const malformed = fixture();
  writeFileSync(malformed.ownerFile, 'broken-json-secret-fixture');
  const message = await refusal(() => malformed.sync());
  check('malformed owner auth refuses without exposing file contents', /valid auth JSON/.test(message)
    && !message.includes('secret-fixture') && malformed.calls.length === 0);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
