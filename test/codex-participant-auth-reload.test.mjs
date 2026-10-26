import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { check } from './check.mjs';
import { createParticipantAuthGuard, participantAuthSnapshot } from '../lib/codex-participant-auth.js';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'promptobus-auth-'));
const now = Math.floor(Date.now() / 1000);
const token = (signature, exp = now + 3600) => `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.${signature}`;
const auth = (signature, extra = {}) => ({ auth_mode: 'chatgpt', tokens: {
  access_token: token(signature), refresh_token: 'owner-refresh-DO-NOT-ROTATE', account_id: 'same-account',
}, ...extra });
let seq = 0;
function fixture(initial = auth('initial')) {
  const dir = path.join(scratch, String(++seq));
  const ownerHome = path.join(dir, 'owner'), participantHome = path.join(dir, 'participant');
  mkdirSync(ownerHome, { recursive: true });
  mkdirSync(participantHome);
  const ownerFile = path.join(ownerHome, 'auth.json'), privateFile = path.join(participantHome, 'auth.json');
  if (initial !== null) {
    writeFileSync(ownerFile, JSON.stringify(initial));
    writeFileSync(privateFile, participantAuthSnapshot(JSON.stringify(initial), ownerHome), { mode: 0o600 });
  }
  const calls = [];
  const sync = createParticipantAuthGuard({ ownerHome, participantHome });
  const turn = async options => { await sync(options); calls.push('turn/start'); };
  return { sync, calls, turn, ownerHome, participantHome, ownerFile, privateFile,
    setOwner: value => writeFileSync(ownerFile, JSON.stringify(value)),
  };
}
const refusal = async fn => { try { await fn(); return ''; } catch (error) { return error.message; } };
const freshLift = message => /fresh lift/.test(message) && /owner|snapshot/.test(message);

try {
  const f = fixture();
  await f.turn();
  check('unchanged snapshot admits a model turn without account/read', f.calls.join() === 'turn/start');
  f.calls.length = 0;
  const before = readFileSync(f.privateFile, 'utf8');
  const updated = auth('changed');
  f.setOwner(updated);
  const ownerBytes = readFileSync(f.ownerFile, 'utf8');
  const message = await refusal(() => f.turn());
  check('same-account owner access change refuses before turn/start and requires a fresh lift',
    freshLift(message) && /sign-in|sign in/.test(message) && f.calls.length === 0, message);
  check('changed owner access leaves private snapshot and owner fixture untouched',
    readFileSync(f.privateFile, 'utf8') === before && readFileSync(f.ownerFile, 'utf8') === ownerBytes);
  check('refusal exposes no owner or private token bytes',
    ![updated.tokens.access_token, updated.tokens.refresh_token, auth('initial').tokens.access_token].some(value => message.includes(value)));
  check('private copy has no refresh credential and remains mode 0600',
    JSON.parse(before).tokens.refresh_token === '' && (statSync(f.privateFile).mode & 0o777) === 0o600);
  const repeated = await refusal(() => f.turn());
  check('repeated attempts cannot revive a refused holder', freshLift(repeated) && f.calls.length === 0);
  f.setOwner(auth('initial'));
  check('restoring the old owner snapshot cannot revive a refused holder',
    freshLift(await refusal(() => f.turn())) && f.calls.length === 0);

  const refreshed = fixture();
  refreshed.setOwner({ ...auth('initial'), tokens: { ...auth('initial').tokens, refresh_token: 'rotated-owner-only' } });
  await refreshed.turn();
  check('owner refresh-token-only rotation does not change the access snapshot', refreshed.calls.join() === 'turn/start');

  const rewritten = fixture();
  rewritten.setOwner(updated);
  writeFileSync(rewritten.privateFile, participantAuthSnapshot(JSON.stringify(updated), rewritten.ownerHome));
  check('rewriting both files cannot replace the original holder access snapshot',
    freshLift(await refusal(() => rewritten.turn())) && rewritten.calls.length === 0);
  const privateOnly = fixture();
  writeFileSync(privateOnly.privateFile, participantAuthSnapshot(JSON.stringify(updated), privateOnly.ownerHome));
  check('private-only snapshot change refuses cached credential reuse',
    freshLift(await refusal(() => privateOnly.turn())) && privateOnly.calls.length === 0);

  const active = fixture();
  await active.turn({ busy: true });
  check('active steering with unchanged credentials stays available', active.calls.join() === 'turn/start');
  active.calls.length = 0;
  const activeBefore = readFileSync(active.privateFile, 'utf8');
  active.setOwner(updated);
  check('active turn refuses changed credentials before writing or reloading them',
    /active turn/.test(await refusal(() => active.turn({ busy: true })))
    && readFileSync(active.privateFile, 'utf8') === activeBefore && active.calls.length === 0);
  check('ending the active turn does not revive a changed owner snapshot',
    freshLift(await refusal(() => active.turn())) && active.calls.length === 0);

  for (const [name, replacement] of [
    ['another ChatGPT account', { ...updated, tokens: { ...updated.tokens, account_id: 'other-account' } }],
    ['unknown ChatGPT account', { ...updated, tokens: { ...updated.tokens, account_id: undefined } }],
    ['another auth mode', { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-api' }],
  ]) {
    const identity = fixture();
    const original = readFileSync(identity.privateFile, 'utf8');
    identity.setOwner(replacement);
    const reason = await refusal(() => identity.turn());
    check(`${name} refuses before replacing credentials or calling account/read`,
      /identity/.test(reason) && freshLift(reason) && identity.calls.length === 0
      && readFileSync(identity.privateFile, 'utf8') === original);
  }

  for (const [label, exp] of [['expired', now - 10], ['near-expiry', now + 300], ['unknown-expiry', undefined]]) {
    const expiry = fixture();
    const untouched = readFileSync(expiry.privateFile, 'utf8');
    expiry.setOwner({ ...updated, tokens: { ...updated.tokens,
      access_token: exp === undefined ? 'malformed-fixture-token' : token('changed', exp) } });
    const reason = await refusal(() => expiry.turn());
    check(`${label} owner access refuses without writing or performing owner refresh`,
      /expires|expiry/.test(reason) && freshLift(reason) && expiry.calls.length === 0 && readFileSync(expiry.privateFile, 'utf8') === untouched);
  }
  const missing = fixture();
  rmSync(missing.ownerFile);
  const missingMessage = await refusal(() => missing.turn());
  check('missing owner auth refuses stale private credentials', /missing/.test(missingMessage) && freshLift(missingMessage) && missing.calls.length === 0);
  missing.setOwner(auth('initial'));
  check('restoring missing owner auth still requires a fresh lift', freshLift(await refusal(() => missing.turn())) && missing.calls.length === 0);
  const missingPrivate = fixture();
  rmSync(missingPrivate.privateFile);
  check('missing private auth cannot be recreated inside a running holder',
    freshLift(await refusal(() => missingPrivate.turn())) && missingPrivate.calls.length === 0);

  const api = fixture({ auth_mode: 'apikey', OPENAI_API_KEY: 'old-fixture-key' });
  await api.turn();
  check('unchanged API-key snapshot admits a turn without JWT expiry rules', api.calls.join() === 'turn/start');
  api.calls.length = 0;
  api.setOwner({ auth_mode: 'apikey', OPENAI_API_KEY: 'new-fixture-key' });
  check('API-key changes also require a fresh lift without changing the private file',
    freshLift(await refusal(() => api.turn())) && api.calls.length === 0 && JSON.parse(readFileSync(api.privateFile)).OPENAI_API_KEY === 'old-fixture-key');
  const absent = fixture(null);
  await absent.turn();
  check('without auth files an environment API-key participant needs no snapshot reload', absent.calls.join() === 'turn/start');
  absent.calls.length = 0;
  absent.setOwner(auth('initial'));
  check('auth appearing after holder creation requires a fresh lift', freshLift(await refusal(() => absent.turn())) && absent.calls.length === 0);

  const malformed = fixture();
  writeFileSync(malformed.ownerFile, 'broken-json-secret-fixture');
  const malformedMessage = await refusal(() => malformed.turn());
  check('malformed owner auth refuses without exposing file contents', /valid auth JSON/.test(malformedMessage)
    && freshLift(malformedMessage) && !malformedMessage.includes('secret-fixture') && malformed.calls.length === 0);
  check('current authentication documentation requires a fresh lift after changed owner access',
    readFileSync('README.md', 'utf8').includes('the holder refuses changed owner access and requires a fresh lift')
    && readFileSync('docs/reference/03-cli.md', 'utf8').includes('Long-lived holders refuse changed owner access before the next model input')
    && readFileSync('docs/reference/05-drivers.md', 'utf8').includes('A changed owner sign-in/access snapshot requires a fresh lift before another model turn.'));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
