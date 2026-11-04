import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../integrations/bb/scripts/build.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--directory') throw new Error('Use --directory <new release directory>');
const destination = path.resolve(args[1]);
if (existsSync(destination)) throw new Error('Release directory must not already exist');
const state = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' });
if (state.status !== 0 || state.stdout.trim()) throw new Error('BB release requires a clean committed source checkout');
const initialRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (initialRevision.status !== 0) throw new Error('BB release requires a committed source revision');
const adapter = path.join(root, 'integrations/bb'), panel = path.join(root, 'integrations/bb-native-observer');
const adapterManifest = readJson(path.join(adapter, 'package.json')), panelManifest = readJson(path.join(panel, 'package.json'));
if (adapterManifest.version !== panelManifest.version) throw new Error('Both BB plugins must use the same release version');
const receipt = await build(adapter), generation = path.join(adapter, receipt.installationDirectory);
const revision = receipt.identity.inputs.sourceRevision;
if (!revision || revision !== initialRevision.stdout.trim()) throw new Error('source changed during BB release');
const result = spawnSync('npm', ['run', 'build'], { cwd: panel, stdio: 'inherit' });
if (result.status !== 0) throw new Error(`Native panel build failed (${result.status})`);
mkdirSync(destination, { recursive: true });
for (const [name, source, manifest] of [['promptobus', generation, adapterManifest], ['native-panel', panel, panelManifest]]) {
  const target = path.join(destination, 'plugins', name);
  mkdirSync(target, { recursive: true });
  cpSync(path.join(source, 'dist'), path.join(target, 'bundle'), { recursive: true });
  cpSync(path.join(source, 'skills'), path.join(target, 'skills'), { recursive: true });
  for (const file of ['README.md', 'PLUGIN_OVERVIEW.md']) {
    const text = readFileSync(path.join(name === 'promptobus' ? adapter : panel, file), 'utf8')
      .replace(/\]\(\.\.\/\.\.\/((?:docs|scripts)\/[^)]+)\)/g, `](https://github.com/Velklish/promptobus/blob/${revision}/$1)`);
    writeFileSync(path.join(target, file), text);
  }
  cpSync(path.join(root, 'LICENSE'), path.join(target, 'LICENSE'));
  const bb = { ...manifest.bb, server: './server.mjs', host: './host.mjs', skills: ['skills'] };
  writeFileSync(path.join(target, 'server.mjs'), "export { default } from './bundle/server.js';\n");
  writeFileSync(path.join(target, 'host.mjs'), "export { default } from './bundle/host.js';\n" + (name === 'promptobus' ? "export { experimental_providerBridge } from './bundle/host.js';\n" : ''));
  if (name === 'native-panel') {
    bb.app = './app.mjs';
    writeFileSync(path.join(target, 'app.mjs'), "export { default } from './bundle/app.js';\n");
  } else {
    cpSync(path.join(generation, 'commands'), path.join(target, 'commands'), { recursive: true });
    cpSync(path.join(generation, 'node_modules/promptobus'), path.join(target, 'core'), { recursive: true });
  }
  json(path.join(target, 'package.json'), { name: manifest.name, version: manifest.version, type: 'module',
    license: 'MIT', engines: manifest.engines, bb,
    dependencies: { zod: manifest.dependencies.zod, ...(name === 'promptobus' ? { promptobus: 'file:./core' } : {}) },
    devDependencies: { '@get-bb/plugin-sdk': manifest.devDependencies['@get-bb/plugin-sdk'] } });
}
mkdirSync(path.join(destination, '.bb'));
json(path.join(destination, '.bb/plugins.json'), { schemaVersion: 1, name: 'promptobus', plugins: [
  { name: 'promptobus', source: './plugins/promptobus' }, { name: 'native-panel', source: './plugins/native-panel' },
] });
const files = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else files.push([path.relative(destination, file), createHash('sha256').update(readFileSync(file)).digest('hex')]);
  }
}
visit(destination);
const finalState = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' });
const finalRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (finalState.status !== 0 || finalState.stdout.trim() || finalRevision.status !== 0 || finalRevision.stdout.trim() !== revision) {
  throw new Error('source changed during BB release');
}
json(path.join(destination, 'release.json'), { format: 1, version: adapterManifest.version,
  sourceRevision: receipt.identity.inputs.sourceRevision, adapterIdentity: receipt.identity, files });
console.log(JSON.stringify({ directory: destination, version: adapterManifest.version, sourceRevision: receipt.identity.inputs.sourceRevision, files: files.length }));
