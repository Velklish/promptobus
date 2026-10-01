import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { check } from './check.mjs';
import { makeParticipantHome, participantCodexHome } from '../lib/driver-codex.js';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'promptobus-auth-'));
const owner = path.join(scratch, 'owner');
const env = { ...process.env, PROMPTOBUS_CODEX_HOME: path.join(scratch, 'registry') };
mkdirSync(owner);
const token = exp => `e30.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.fixture`;
const auth = exp => ({ auth_mode: 'chatgpt', tokens: { access_token: token(exp), refresh_token: 'owner-refresh-DO-NOT-ROTATE', id_token: 'fixture', account_id: 'fixture' }, last_refresh: '2026-10-01T00:00:00Z' });
const homes = [];
const lift = (name, value) => {
  const dir = participantCodexHome({ task: 'auth-proof', address: `worker:${name}` }, env);
  homes.push(dir);
  writeFileSync(path.join(owner, 'auth.json'), JSON.stringify(value));
  return makeParticipantHome({ dir, ownerHome: owner, env });
};
const now = Math.floor(Date.now() / 1000);
try {
  const original = auth(now + 3600);
  const a = lift('one', original), b = lift('two', original);
  const copies = [a, b].map(x => JSON.parse(readFileSync(path.join(x.dir, 'auth.json'), 'utf8')));
  check('ChatGPT participants retain access credentials but receive no owner refresh token',
    copies.every(x => x.tokens.refresh_token === '' && x.tokens.access_token === original.tokens.access_token));
  check('two participant lifts preserve owner credentials byte for byte',
    readFileSync(path.join(owner, 'auth.json'), 'utf8') === JSON.stringify(original));
  check('subscription auth snapshots stay private',
    [a, b].every(x => (statSync(path.join(x.dir, 'auth.json')).mode & 0o777) === 0o600));
  const refusal = value => { try { lift('refused', value); return ''; } catch (e) { return e.message; } };
  check('expired credentials refuse before a participant starts and name owner sign-in',
    /owner.*sign in|sign in.*owner/i.test(refusal(auth(now - 1))));
  check('near-expiry credentials refuse before Codex proactive refresh window',
    /expires|expiry|expired/i.test(refusal(auth(now + 300))));
  check('an undecodable subscription access token refuses rather than guess its expiry',
    /expir/i.test(refusal({ ...auth(now + 3600), tokens: { ...auth(now + 3600).tokens, access_token: 'malformed' } })));
  const api = { auth_mode: 'apikey', OPENAI_API_KEY: 'fixture-api-key' };
  const apiHome = lift('apikey', api);
  check('API-key credentials preserve the native file format',
    JSON.stringify(JSON.parse(readFileSync(path.join(apiHome.dir, 'auth.json'), 'utf8'))) === JSON.stringify(api));
} finally {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
