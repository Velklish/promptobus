import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const marker = '__PROMPTOBUS_BUILD_IDENTITY_UNBUILT_V1__';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

function filesIn(root, selected = ['.'], includeDependencies = false) {
  const files = new Set();
  const visit = relative => {
    const file = path.join(root, relative);
    if (!existsSync(file)) return;
    if (statSync(file).isDirectory()) {
      for (const entry of readdirSync(file).sort()) if (entry !== '.git' && (includeDependencies || entry !== 'node_modules')) visit(path.join(relative, entry));
    } else files.add(relative.split(path.sep).join('/'));
  };
  for (const file of selected) visit(file);
  return [...files].sort();
}
const contentDigest = (root, files) => sha256(JSON.stringify(files.map(file => [file, sha256(readFileSync(path.join(root, file)))])));

function packageInput(from, name) {
  const require = createRequire(path.join(from, 'package.json'));
  let directory = path.dirname(require.resolve(name));
  while (!existsSync(path.join(directory, 'package.json')) || readJson(path.join(directory, 'package.json')).name !== name) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate resolved package ${name}`);
    directory = parent;
  }
  directory = realpathSync(directory);
  const manifest = readJson(path.join(directory, 'package.json'));
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  const selected = Array.isArray(manifest.files) && manifest.files.every(file => !/[*?!]/.test(file))
    ? [...manifest.files, manifest.main ?? 'index.js', ...bins, 'package.json', 'README.md', 'LICENSE'] : ['.'];
  return { directory, manifest, files: filesIn(directory, selected) };
}

function dependencyInputs(root, names) {
  const visited = new Set(), inputs = [];
  const visit = (from, name) => {
    const { directory, manifest, files } = packageInput(from, name);
    if (visited.has(directory)) return;
    visited.add(directory);
    inputs.push({ name: manifest.name, version: manifest.version, sha256: contentDigest(directory, files) });
    for (const child of Object.keys(manifest.dependencies ?? {}).sort()) visit(directory, child);
  };
  for (const name of names.sort()) visit(root, name);
  return [...new Map(inputs.map(input => [JSON.stringify(input), input])).values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.sha256.localeCompare(b.sha256));
}

function copyFiles(from, to, files) {
  for (const file of files) {
    mkdirSync(path.dirname(path.join(to, file)), { recursive: true });
    cpSync(path.join(from, file), path.join(to, file), { dereference: true });
  }
}

function freezeDependencies(from, to, names) {
  for (const name of names) {
    const { directory, manifest, files } = packageInput(from, name);
    const destination = path.join(to, 'node_modules', name);
    copyFiles(directory, destination, files);
    freezeDependencies(directory, destination, Object.keys(manifest.dependencies ?? {}));
  }
}

const hostSource = root => existsSync(path.join(root, 'host.mjs')) ? 'host.mjs' : 'host.ts';
function consumerIntegration(root) {
  if (hostSource(root) !== 'host.mjs') return null;
  const entry = readFileSync(path.join(root, 'host.mjs'), 'utf8');
  const selected = entry.match(/^import options from ("(?:[^"\\]|\\.)*");$/m);
  if (!selected) throw new Error('Generated consumer Host entry must declare its selected integration');
  return { file: path.resolve(root, JSON.parse(selected[1])), declaration: selected[0] };
}

function commandToolchain(root) {
  if (!existsSync(path.join(root, 'command-runner.ts'))) return [];
  const require = createRequire(path.join(root, 'package.json'));
  const names = ['typescript', `@typescript/typescript-${process.platform}-${process.arch}`, '@types/node'];
  const packages = [];
  for (const name of names) {
    const directory = path.dirname(require.resolve(`${name}/package.json`));
    const manifest = readJson(path.join(directory, 'package.json'));
    if (name === 'typescript' && manifest.version !== readJson(path.join(root, 'package.json')).devDependencies?.typescript) {
      throw new Error('Command compiler must match the exact local development pin');
    }
    packages.push({ name, version: manifest.version, directory, files: filesIn(directory) });
    for (const dependency of Object.keys(manifest.dependencies ?? {})) if (!names.includes(dependency)) names.push(dependency);
  }
  return packages;
}
const toolchainIdentity = packages => packages.map(input => ({ name: input.name, version: input.version, sha256: contentDigest(input.directory, input.files) }));

function inspectInputs(root, builderVersion) {
  const manifest = readJson(path.join(root, 'package.json'));
  const selected = [...readdirSync(root).filter(file => file.endsWith('.ts')), 'scripts', 'skills', 'package.json', 'package-lock.json', 'tsconfig.json', 'server.ts', hostSource(root)];
  const files = filesIn(root, selected);
  const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const tracked = git('ls-files', '--error-unmatch', '--', ...files);
  const revision = git('rev-parse', 'HEAD');
  const sourceRevision = tracked.status === 0 && revision.status === 0 && /^[a-f0-9]{40,64}$/.test(revision.stdout.trim()) ? revision.stdout.trim() : null;
  const dirty = sourceRevision ? git('status', '--porcelain', '--untracked-files=all', '--', '*.ts', ...selected.filter(file => !file.endsWith('.ts'))) : null;
  const integration = consumerIntegration(root);
  if (integration) integration.bytes = readFileSync(integration.file);
  const consumerIntegrationSha256 = integration ? sha256(integration.bytes) : null;
  const compiler = toolchainIdentity(commandToolchain(root));
  const inputs = { ...(compiler.length ? { commandCompiler: compiler } : {}), sourceSha256: contentDigest(root, files), sourceRevision,
    sourceDirty: dirty?.status === 0 ? dirty.stdout.length > 0 : null,
    lockSha256: sha256(readFileSync(path.join(root, 'package-lock.json'))), builderVersion,
    dependencies: dependencyInputs(root, Object.keys(manifest.dependencies ?? {})), consumerIntegrationSha256, consumerBundleSha256: null };
  return { manifest, files, inputs, integration };
}

function identityOf(pluginVersion, inputs) {
  return { format: 1, buildId: randomUUID(), pluginVersion, inputSha256: sha256(JSON.stringify({ pluginVersion, inputs })), inputs };
}

export function computeBuildIdentity(root, builderVersion = null, consumerBundleSha256 = null) {
  const { manifest, inputs } = inspectInputs(root, builderVersion);
  return identityOf(manifest.version, { ...inputs, consumerBundleSha256 });
}

function runBuild(bb, root) {
  let child;
  const sigint = () => child?.kill('SIGINT'), sigterm = () => child?.kill('SIGTERM');
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  return new Promise((resolve, reject) => {
    child = spawn(bb, ['plugin', 'build'], { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`bb plugin build failed (${signal ?? code})`)));
  }).finally(() => { process.off('SIGINT', sigint); process.off('SIGTERM', sigterm); });
}

export async function build(root) {
  const bb = process.env.BB_CLI || 'bb';
  const version = spawnSync(bb, ['--version'], { encoding: 'utf8' });
  const versionText = version.stdout?.trim();
  const builderVersion = version.status === 0 && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(versionText) ? versionText : null;
  const before = inspectInputs(root, builderVersion);
  const stage = mkdtempSync(path.join(root, '.runtime-stage-'));
  let generation;
  try {
    const capturedRoot = path.join(stage, 'inputs');
    copyFiles(root, capturedRoot, before.files);
    for (const compiler of commandToolchain(root)) copyFiles(compiler.directory, path.join(capturedRoot, 'toolchain/node_modules', compiler.name), compiler.files);
    copyFiles(capturedRoot, stage, ['tsconfig.json']);
    const manifest = readJson(path.join(capturedRoot, 'package.json'));
    const rawHost = before.integration ? 'host.mjs' : 'host.ts';
    copyFiles(capturedRoot, path.join(stage, 'source'), before.files.filter(file => !file.includes('/') && (file.endsWith('.ts') || file === rawHost)));
    cpSync(path.join(capturedRoot, 'skills'), path.join(stage, 'skills'), { recursive: true });
    freezeDependencies(root, stage, Object.keys(manifest.dependencies ?? {}));
    if (before.integration) writeFileSync(path.join(stage, 'consumer-input.mjs'), before.integration.bytes);
    const toolchainRoot = path.join(capturedRoot, 'toolchain');
    const capturedCompiler = commandToolchain(root).map(compiler => ({ ...compiler, directory: path.join(toolchainRoot, 'node_modules', compiler.name) }));
    const captured = { ...before.inputs, ...(capturedCompiler.length ? { commandCompiler: toolchainIdentity(capturedCompiler) } : {}), sourceSha256: contentDigest(capturedRoot, before.files),
      lockSha256: sha256(readFileSync(path.join(capturedRoot, 'package-lock.json'))),
      dependencies: dependencyInputs(stage, Object.keys(manifest.dependencies ?? {})),
      consumerIntegrationSha256: before.integration ? sha256(readFileSync(path.join(stage, 'consumer-input.mjs'))) : null };
    const unchanged = inputs => JSON.stringify(inputs) === JSON.stringify(before.inputs);
    if (!unchanged(captured)) throw new Error('Build inputs changed during capture');
    const installManifest = { name: manifest.name, version: manifest.version, type: 'module', engines: manifest.engines,
      bb: { ...manifest.bb, server: './source/server.ts', host: `./source/${rawHost}`, skills: ['skills'] },
      dependencies: Object.fromEntries(Object.keys(manifest.dependencies ?? {}).map(name => [name, packageInput(stage, name).manifest.version])) };
    let consumerBundleSha256 = null;
    if (before.integration) {
      const selected = path.relative(stage, before.integration.file).split(path.sep).join('/');
      writeFileSync(path.join(stage, 'consumer-entry.mjs'), `export { default } from ${JSON.stringify(selected.startsWith('.') ? selected : './' + selected)};\n`);
      writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ ...installManifest,
        bb: { ...installManifest.bb, host: './consumer-entry.mjs' } }));
      await runBuild(bb, stage);
      const options = readFileSync(path.join(stage, 'dist/host.js'), 'utf8').replace(/\n\/\/# sourceMappingURL=[^\n]*\n?$/, '\n');
      consumerBundleSha256 = sha256(options);
      writeFileSync(path.join(stage, 'consumer-options.mjs'), options);
      const entry = readFileSync(path.join(capturedRoot, 'host.mjs'), 'utf8');
      writeFileSync(path.join(stage, 'source/host.mjs'), entry.replace(before.integration.declaration, "import options from '../consumer-options.mjs';"));
      rmSync(path.join(stage, 'consumer-entry.mjs'));
      rmSync(path.join(stage, 'dist'), { recursive: true });
    }
    if (!unchanged(inspectInputs(root, builderVersion).inputs)) throw new Error('Build inputs changed during capture');
    const identity = identityOf(manifest.version, { ...captured, consumerBundleSha256 });
    const encoded = Buffer.from(JSON.stringify(identity)).toString('base64');
    const original = readFileSync(path.join(capturedRoot, 'build-identity.ts'), 'utf8');
    if (original.split(marker).length !== 2) throw new Error('Expected exactly one unbuilt identity placeholder');
    writeFileSync(path.join(stage, 'source/build-identity.ts'), original.replace(marker, encoded));
    writeFileSync(path.join(stage, 'package.json'), JSON.stringify(installManifest, null, 2) + '\n');
    const installationDirectory = `.runtime/${identity.buildId}`;
    generation = path.join(root, installationDirectory);
    mkdirSync(path.dirname(generation), { recursive: true });
    renameSync(stage, generation);
    await runBuild(bb, generation);
    if (!unchanged(inspectInputs(root, builderVersion).inputs)) throw new Error('Build inputs changed during capture');
    const artifacts = {};
    if (capturedCompiler.length) {
      const compile = spawnSync(process.execPath, [path.join(generation, 'inputs/toolchain/node_modules/typescript/bin/tsc'),
        '--ignoreConfig', '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
        '--types', 'node', '--typeRoots', './inputs/toolchain/node_modules/@types', '--rootDir', './source', '--outDir', './commands',
        './source/command-runner.ts'], { cwd: generation, encoding: 'utf8' });
      if (compile.status !== 0) throw new Error(`Command launcher compilation failed (${compile.status}): ${compile.stdout}${compile.stderr}`);
      const commandFiles = filesIn(generation, ['commands']);
      if (!commandFiles.includes('commands/command-runner.js') || !readFileSync(path.join(generation, 'commands/build-identity.js')).includes(encoded)) {
        throw new Error('Command launcher identity or entry is missing');
      }
      for (const file of commandFiles) artifacts[file] = sha256(readFileSync(path.join(generation, file)));
    }
    for (const name of ['server.js', 'host.js']) {
      const bundle = readFileSync(path.join(generation, 'dist', name));
      if (bundle.toString('utf8').split(encoded).length !== 2 || bundle.includes(Buffer.from(marker))) throw new Error(`Build identity was not embedded in ${name}`);
      artifacts[name] = sha256(bundle);
    }
    const metadata = readJson(path.join(generation, 'dist/host.meta.json'));
    if (metadata.artifactDigest !== artifacts['host.js']) throw new Error('Host artifact digest does not match the final bundle');
    const entries = ['inputs', 'source', 'skills', 'commands', 'node_modules', 'consumer-input.mjs', 'consumer-options.mjs', 'package.json', 'tsconfig.json']
      .filter(entry => existsSync(path.join(generation, entry)));
    const result = { identity, installationDirectory,
      snapshot: { sha256: contentDigest(generation, filesIn(generation, entries, true)), entries,
        server: installManifest.bb.server, host: installManifest.bb.host, skills: installManifest.bb.skills },
      ...(capturedCompiler.length ? { commandLauncher: 'commands/command-runner.js', commandCompiler: toolchainIdentity(capturedCompiler.map(compiler => ({ ...compiler, directory: path.join(generation, 'inputs/toolchain/node_modules', compiler.name) }))) } : {}),
      artifacts, builtWith: metadata.builtWith };
    writeFileSync(path.join(generation, 'dist/build-manifest.json'), JSON.stringify(result, null, 2) + '\n');
    mkdirSync(path.join(root, 'dist'), { recursive: true });
    writeFileSync(path.join(root, 'dist/build-manifest.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } catch (error) {
    if (generation) rmSync(generation, { recursive: true, force: true });
    throw error;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await build(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}
