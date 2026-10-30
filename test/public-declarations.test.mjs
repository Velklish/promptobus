import './home.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function compileConsumer(t, source) {
  const dir = mkdtempSync(path.join(tmpdir(), 'promptobus-test-declarations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = path.join(dir, 'node_modules', 'promptobus');
  mkdirSync(path.join(pkg, 'lib'), { recursive: true });
  cpSync(path.join(ROOT, 'package.json'), path.join(pkg, 'package.json'));
  cpSync(path.join(ROOT, 'dist'), path.join(pkg, 'dist'), { recursive: true });
  cpSync(path.join(ROOT, 'lib'), path.join(pkg, 'lib'), {
    recursive: true, filter: file => !file.endsWith('.ts') || file.endsWith('.d.ts'),
  });
  symlinkSync(path.join(ROOT, 'node_modules', '@types'), path.join(dir, 'node_modules', '@types'), 'junction');
  writeFileSync(path.join(dir, 'consumer.mts'), `${source}\n`);
  writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true,
      types: ['node'],
    },
    files: ['consumer.mts'],
  }));
  const compiled = spawnSync(process.execPath, [
    path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', path.join(dir, 'tsconfig.json'),
  ], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, `public declaration consumer compile failed:\n${compiled.stdout}${compiled.stderr}`);
}

test('public driverFor preserves declarations options and full driver operations', t => {
  compileConsumer(t, `
import { driverFor } from 'promptobus/driver';
import type { Driver, DriverOptions, Registry, SpawnContext, LaunchPlan } from 'promptobus/driver';
import { DRIVER_DECLARATIONS } from 'promptobus/integration';

declare const harness: string;
const declaration = driverFor(DRIVER_DECLARATIONS, harness);
const options: Readonly<DriverOptions> = declaration.options;
// @ts-expect-error: the declaration does not carry driver phrases.
declaration.phrases;
// @ts-expect-error: the declaration does not carry driver operations.
declaration.prepare;

declare const registry: Registry;
declare const context: SpawnContext;
declare const plan: LaunchPlan;
const driver: Driver = driverFor(registry, harness);
driver.phrases;
driver.prepare?.(context);
driver.spawn?.(plan, context);
driver.inspect?.('session');
driver.stop?.('session');
void options;
`);
});

test('public HostToolBin accepts unread null, raw string and omitted versions', t => {
  compileConsumer(t, `
import type { HostToolBin } from 'promptobus/host';

const unread: HostToolBin = { ok: true, bin: 'harness', version: null };
const read: HostToolBin = { ok: true, bin: 'harness', version: 'harness 1.2.3' };
const omitted: HostToolBin = { ok: false };
const version: string | null | undefined = unread.version;
// @ts-expect-error: a version is a string or unread, never a number.
const numeric: HostToolBin = { ok: true, version: 123 };
// @ts-expect-error: a version is a string or unread, never a boolean.
const boolean: HostToolBin = { ok: true, version: false };
void [read, omitted, version, numeric, boolean];
`);
});
