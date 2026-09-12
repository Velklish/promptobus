// The environment a lifted participant inherits. Run: npm test
//
// Subject: a participant must not be able to READ its parent's session — not merely have the
// mechanism decline to use it. Measured 2026-09-12 across all three drivers on a synthetic
// parent environment, which is enough because `sessionEnv` is pure and `lib/spawn.js` calls
// exactly the one on the driver object:
//
//   before PB-182   claude 8/10 parent values survived, codex 9/10, cursor 8/10, and
//                   `sessionIdentity()` returned the PARENT's id in all three.
//
// `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` are why this is not only
// wrong data: they are the pair `registerWake` writes into the contact point and the warden
// knocks with, so a participant held its orchestrator's wake credentials. Whether a knock from
// a stranger holding that token is accepted was NOT measured and is not claimed here.
//
// The ordering is a check of its own. Two drivers merged `extra` and then deleted, so a host
// naming a dropped variable would have had it silently removed; Codex deleted first and merged
// after, so the caller won. With a one-name list that was cosmetic; with this list it is not,
// and the contract is Codex's order for everyone.
//
// Written against `node:test` rather than the shared `check` helper. That is also why `home.mjs` is
// imported by hand and first, before anything that could read the real home: `check.mjs` is
// where every other file picks the diversion up.
import './home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = (name) => import(path.join(here, '..', 'lib', name));

const { PARENT_SESSION_ENV } = await lib('session-env.js');
const { bindSessionIdentity, sessionIdentity } = await lib('store.js');
// Without this the core is UNBOUND and answers `null` for every environment, so the
// identity assertion below would hold with the drop reverted. See the positive control.
bindSessionIdentity((await lib('drivers.js')).resolveSessionIdentity);
const drivers = {
  claude: (await lib('driver-claude.js')).claudeDriver,
  codex: (await lib('driver-codex.js')).codexDriver,
  cursor: (await lib('driver-cursor.js')).cursorDriver,
};

// A parent that carries every name plus one the mechanism sets itself, so a drop that takes too
// much is as visible as one that takes too little.
const PARENT = Object.fromEntries([
  ...PARENT_SESSION_ENV.map((name) => [name, `PARENT-${name}`]),
  ['PATH', '/usr/bin'], ['HOME', '/home/parent'], ['PROMPTOBUS_HOME', '/home/parent/.promptobus'],
]);

// A name still PRESENT counts as survived whatever its value: comparing to the parent's
// value would let a mutation that overwrites instead of deleting pass both checks here.
const survivors = (driver) => {
  const out = driver.sessionEnv(PARENT, {});
  return PARENT_SESSION_ENV.filter((name) => out[name] !== undefined);
};

function pinsDropAndOrder(name) {
  const driver = drivers[name];
  assert.deepEqual(survivors(driver), [],
    `${name}: these parent variables reached the participant`);
  assert.equal(sessionIdentity(driver.sessionEnv(PARENT, {})), null,
    `${name}: sessionIdentity() still answers from the parent's environment`);
  // `extra` on top of the drop, not under it: a caller that names a dropped variable wins.
  const extra = { CLAUDE_CODE_SESSION_ID: 'SET-BY-THE-CALLER' };
  assert.equal(driver.sessionEnv(PARENT, extra).CLAUDE_CODE_SESSION_ID, 'SET-BY-THE-CALLER',
    `${name}: the drop list deleted a value the caller set deliberately`);
  // What the mechanism and the shell legitimately need is untouched.
  const kept = driver.sessionEnv(PARENT, {});
  assert.equal(kept.PROMPTOBUS_HOME, PARENT.PROMPTOBUS_HOME, `${name}: PROMPTOBUS_HOME was dropped`);
  assert.equal(kept.PATH, PARENT.PATH, `${name}: PATH was dropped`);
}

test('claude: no parent identity or messaging variable reaches a lifted participant', () => {
  pinsDropAndOrder('claude');
});

test('codex: no parent identity or messaging variable reaches a lifted participant', () => {
  pinsDropAndOrder('codex');
});

test('cursor: no parent identity or messaging variable reaches a lifted participant', () => {
  pinsDropAndOrder('cursor');
});

// The list is the contract, and an empty or shrunken one would make every check above pass for
// the wrong reason — the shape this run kept finding by eye.
test('the shared list still names the parent identity and messaging variables', () => {
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN']) {
    assert.ok(PARENT_SESSION_ENV.includes(name), `${name} left the shared list`);
  }
  assert.ok(PARENT_SESSION_ENV.length >= 12, `the shared list shrank to ${PARENT_SESSION_ENV.length}`);
  assert.ok(survivors(drivers.claude).length === 0 && Object.keys(PARENT).length > PARENT_SESSION_ENV.length,
    'the parent fixture must carry more than the list, or "nothing survived" proves nothing');
});

// Positive control for the identity assertion above. An unbound core answers `null` for
// everything, so without this the three checks would hold with the drop lists emptied.
test('the identity reader used above can answer, so its null means the drop and not an unbound core', () => {
  assert.equal(sessionIdentity({ CLAUDE_CODE_SESSION_ID: 'x' }), 'x',
    'sessionIdentity() answered null for an environment that names a session — the registry is not bound, '
    + 'and every `null` asserted in this file proves nothing');
});
