import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const marker = '__PROMPTOBUS_BUILD_IDENTITY_UNBUILT_V1__';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

function filesIn(root, selected = ['.']) {
  const files = new Set();
  const visit = relative => {
    const file = path.join(root, relative);
    if (!existsSync(file)) return;
    if (statSync(file).isDirectory()) {
      for (const entry of readdirSync(file).sort()) if (!['node_modules', '.git'].includes(entry)) visit(path.join(relative, entry));
    } else files.add(relative.split(path.sep).join('/'));
  };
  for (const file of selected) visit(file);
  return [...files].sort();
}
const contentDigest = (root, files) => sha256(JSON.stringify(files.map(file => [file, sha256(readFileSync(path.join(root, file)))])));

function dependencyInputs(root, names) {
  const visited = new Set(), inputs = [];
  const visit = (from, name) => {
    const require = createRequire(path.join(from, 'package.json'));
    let directory = path.dirname(require.resolve(name));
    while (!existsSync(path.join(directory, 'package.json')) || readJson(path.join(directory, 'package.json')).name !== name) {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`Cannot locate resolved package ${name}`);
      directory = parent;
    }
    directory = realpathSync(directory);
    if (visited.has(directory)) return;
    visited.add(directory);
    const manifest = readJson(path.join(directory, 'package.json'));
    const selected = Array.isArray(manifest.files) && manifest.files.every(file => !/[*?!]/.test(file))
      ? [...manifest.files, 'package.json', 'README.md', 'LICENSE'] : ['.'];
    inputs.push({ name: manifest.name, version: manifest.version, sha256: contentDigest(directory, filesIn(directory, selected)) });
    for (const child of Object.keys(manifest.dependencies ?? {}).sort()) visit(directory, child);
  };
  for (const name of names.sort()) visit(root, name);
  return inputs.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.sha256.localeCompare(b.sha256));
}

export function computeBuildIdentity(root, builderVersion = null) {
  const manifest = readJson(path.join(root, 'package.json'));
  const selected = [...readdirSync(root).filter(file => file.endsWith('.ts')), 'scripts', 'skills', 'package.json', 'package-lock.json', 'tsconfig.json', manifest.bb.server, manifest.bb.host];
  const files = filesIn(root, selected);
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const tracked = git('ls-files', '--error-unmatch', '--', ...files);
  const revision = git('rev-parse', 'HEAD');
  const sourceRevision = tracked.status === 0 && revision.status === 0 && /^[a-f0-9]{40,64}$/.test(revision.stdout.trim()) ? revision.stdout.trim() : null;
  const dirty = sourceRevision ? git('status', '--porcelain', '--untracked-files=all', '--', '*.ts', ...selected.filter(file => !file.endsWith('.ts'))) : null;
  let consumerIntegrationSha256 = null;
  if (manifest.bb.host === './host.mjs') {
    const entry = readFileSync(path.join(root, manifest.bb.host), 'utf8');
    const selectedIntegration = entry.match(/^import options from ("(?:[^"\\]|\\.)*");$/m);
    if (!selectedIntegration) throw new Error('Generated consumer Host entry must declare its selected integration');
    consumerIntegrationSha256 = sha256(readFileSync(path.resolve(root, JSON.parse(selectedIntegration[1]))));
  }
  const inputs = { sourceSha256: contentDigest(root, files), sourceRevision,
    sourceDirty: dirty?.status === 0 ? dirty.stdout.length > 0 : null,
    lockSha256: sha256(readFileSync(path.join(root, 'package-lock.json'))), builderVersion,
    dependencies: dependencyInputs(root, Object.keys(manifest.dependencies ?? {})), consumerIntegrationSha256 };
  return { format: 1, buildId: randomUUID(), pluginVersion: manifest.version, inputSha256: sha256(JSON.stringify({ pluginVersion: manifest.version, inputs })), inputs };
}

export async function build(root) {
  const bb = process.env.BB_CLI || 'bb';
  const version = spawnSync(bb, ['--version'], { encoding: 'utf8' });
  const versionText = version.stdout?.trim();
  const builderVersion = version.status === 0 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(versionText) ? versionText : null;
  const identity = computeBuildIdentity(root, builderVersion);
  const source = path.join(root, 'build-identity.ts');
  const original = readFileSync(source);
  const text = original.toString('utf8');
  if (text.split(marker).length !== 2) throw new Error('Expected exactly one unbuilt identity placeholder; restore build-identity.ts before building');
  const encoded = Buffer.from(JSON.stringify(identity)).toString('base64');
  let child;
  const interrupt = signal => child?.kill(signal);
  const sigint = () => interrupt('SIGINT'), sigterm = () => interrupt('SIGTERM');
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  try {
    writeFileSync(source, text.replace(marker, encoded));
    await new Promise((resolve, reject) => {
      child = spawn(bb, ['plugin', 'build'], { cwd: root, stdio: 'inherit' });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`bb plugin build failed (${signal ?? code})`)));
    });
  } finally {
    writeFileSync(source, original);
    process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
  }
  const artifacts = {};
  for (const name of ['server.js', 'host.js']) {
    const bundle = readFileSync(path.join(root, 'dist', name));
    if (bundle.toString('utf8').split(encoded).length !== 2 || bundle.includes(Buffer.from(marker))) throw new Error(`Build identity was not embedded in ${name}`);
    artifacts[name] = sha256(bundle);
  }
  const metadata = readJson(path.join(root, 'dist/host.meta.json'));
  if (metadata.artifactDigest !== artifacts['host.js']) throw new Error('Host artifact digest does not match the final bundle');
  const manifest = { identity, artifacts, builtWith: metadata.builtWith };
  writeFileSync(path.join(root, 'dist/build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await build(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
