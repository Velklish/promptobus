// Standalone check of the package: the built dist is imported on its own,
// without the CLI, without a workplace, and without foreign dependencies.
// Run with the package's own command: `npm test`.
//
// The file lives in the package on purpose: the package must be checked
// separately from the consumer — otherwise "it builds standalone" would rest
// on a word.
//
// dist is built by the pretest script, so a clean checkout is checked without
// preparation: the file does not wait for a pre-created dist.
// Home diversion before any import that is not a Node built-in: a module that
// resolved a home path at load would see the real one. [home.mjs](home.mjs) says
// what it applies; the sentinel in tmpdir-sweep.test.mjs keeps the order.
import './home.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// The import of the built module lives INSIDE the test, not at the top of the
// file: if one entry point failed to build, its own check goes red, and the
// other verdicts remain. An import at the top would abort the whole file, and
// there would be no verdicts for any check — a broken file would be
// indistinguishable from a lying one.
test('entry point "." yields the protocol version and the package name', async () => {
  const index = await import('../dist/index.js');
  assert.equal(index.PROTOCOL_VERSION, 1);
  assert.equal(index.PACKAGE_NAME, 'promptobus');
});

test('entry point "./driver" is built as a separate module', async () => {
  // Types are erased by compilation, so the driver stub is checked for the
  // fact of being built as a separate module, not for its exports: their
  // content lives in the driver contract.
  const driver = await import('../dist/driver.js');
  assert.equal(typeof driver, 'object');
});

test('entry point "./host" yields the contract and the standalone implementation', async () => {
  const host = await import('../dist/host-index.js');
  assert.equal(typeof host.createStandaloneHost, 'function');
  assert.equal(typeof host.isPromptobusHost, 'function');
  assert.equal(typeof host.HOST_KIND, 'string');
});

test('entry point "./hooks" yields the hook plan', async () => {
  const hooks = await import('../dist/hooks.js');
  assert.equal(typeof hooks.planPromptobusHooks, 'function');
  assert.equal(typeof hooks.renderBusHook, 'function');
});

test('declarations are built next to the code', async () => {
  const dts = await readFile(new URL('../dist/driver.d.ts', import.meta.url), 'utf8');
  assert.match(dts, /interface Driver\b/);
});
