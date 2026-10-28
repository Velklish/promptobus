// Validate committed provenance and finite consumed protocol, then measure the installed generator.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_CODEX_VERSION, PROVEN_CODEX_VERSION } from '../lib/driver-codex.js';
import { readCapture, readConsumedContract, consumedContract, validateConsumedContract } from './codex-schema-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function checkCodexSchema({
  captureDir = path.join(ROOT, 'test/fixtures/codex-app-server', PROVEN_CODEX_VERSION),
  run = spawnSync, say = s => process.stdout.write(`${s}\n`), raw = s => process.stderr.write(s),
} = {}) {
  let temporary;
  try {
    const minimum = readConsumedContract(path.join(ROOT, 'test/fixtures/codex-app-server', MIN_CODEX_VERSION), MIN_CODEX_VERSION);
    validateConsumedContract(minimum);
    const committed = readConsumedContract(captureDir, PROVEN_CODEX_VERSION);
    const counts = validateConsumedContract(committed);
    say(`✔ committed Codex ${PROVEN_CODEX_VERSION}: ${committed.size} schemas; consumed ${counts.requests} requests, ${counts.responses} responses, ${counts.notifications} notifications, ${counts.serverRequests} server requests`);
    const options = { encoding: 'utf8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024 };
    const version = run('codex', ['--version'], options);
    if (version.error?.code === 'ENOENT') {
      say('installed comparison notRun: codex binary missing; committed contract validated');
      return 0;
    }
    if (version.stderr) raw(version.stderr);
    say(`Codex version telemetry: ${JSON.stringify(version.stdout?.trim() ?? '')}; exit ${version.status ?? 'unknown'}`);
    if (version.error) say(`version telemetry warning: ${version.error.message}`);
    temporary = mkdtempSync(path.join(tmpdir(), 'promptobus-codex-schema-'));
    const generated = run('codex', ['app-server', 'generate-json-schema', '--out', temporary], options);
    if (generated.stdout) raw(generated.stdout);
    if (generated.stderr) raw(generated.stderr);
    if (generated.error || generated.status !== 0 || generated.signal) {
      throw new Error(`codex app-server generate-json-schema failed: exit ${generated.status}, signal ${generated.signal ?? 'none'}, ${generated.error?.message ?? 'see raw output'}`);
    }
    const installed = consumedContract(readCapture(temporary));
    validateConsumedContract(installed);
    for (const [name, schema] of installed) {
      if (JSON.stringify(schema) !== JSON.stringify(committed.get(name))) {
        throw new Error(`${name}: regenerated consumed contract differs from committed Codex ${PROVEN_CODEX_VERSION}`);
      }
    }
    say(`✔ installed consumed protocol matches committed contract (${installed.size} schemas); version label is informational`);
    return 0;
  } catch (error) {
    say(`✖ ${error.message}`);
    return 1;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = checkCodexSchema();
