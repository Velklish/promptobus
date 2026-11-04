import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { createStandaloneHost } from 'promptobus/host';
import type { createBbManagedAdmission } from 'promptobus/bb-host';

const encoded = '__PROMPTOBUS_RUNTIME_PACKAGE_V1__';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type RuntimePackage = { createStandaloneHost: typeof createStandaloneHost; createBbManagedAdmission: typeof createBbManagedAdmission };

export async function loadRuntimePackage(dataDir: string): Promise<RuntimePackage> {
  if (encoded.startsWith('__')) throw new Error('Build the immutable Promptobus runtime before using its packaged core');
  const archive = Buffer.from(encoded, 'base64');
  const root = path.join(dataDir, 'runtime-packages', sha256(archive));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  if (realpathSync(root) !== root) throw new Error('Packaged core directory crosses a symlink');
  const files = JSON.parse(gunzipSync(archive).toString('utf8')) as [string, string][];
  for (const [relative, text] of files) {
    const file = path.join(root, relative), bytes = Buffer.from(text, 'base64');
    if (!file.startsWith(root + path.sep)) throw new Error('Packaged core file escapes its directory');
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (realpathSync(path.dirname(file)) !== path.dirname(file)) throw new Error('Packaged core directory crosses a symlink');
    try { writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink() || sha256(readFileSync(file)) !== sha256(bytes))
      throw new Error('Packaged core content differs from its frozen build');
  }
  const host = await import(pathToFileURL(path.join(root, 'dist/host-index.js')).href) as Pick<RuntimePackage, 'createStandaloneHost'>;
  const admission = await import(pathToFileURL(path.join(root, 'lib/bb-host.js')).href) as Pick<RuntimePackage, 'createBbManagedAdmission'>;
  return { createStandaloneHost: host.createStandaloneHost, createBbManagedAdmission: admission.createBbManagedAdmission };
}
