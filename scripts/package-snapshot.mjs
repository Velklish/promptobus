import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// npm 10 can run prepare despite --ignore-scripts. Keep its writes in an owned copy.
export function withPackageSnapshot(root, use) {
  root = path.resolve(root);
  const snapshot = mkdtempSync(path.join(tmpdir(), 'promptobus-pack-snapshot-'));
  const filter = (file) => !['.git', 'node_modules'].includes(path.basename(file))
    && !lstatSync(file).isSymbolicLink();
  const copy = (relative) => {
    if (typeof relative !== 'string' || path.isAbsolute(relative) || path.win32.parse(relative).root) {
      throw new Error(`package snapshot path must be relative: ${relative}`);
    }
    const normalized = path.posix.normalize(relative.replaceAll('\\', '/'));
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`package snapshot path leaves its owned directory: ${relative}`);
    }
    if (normalized.split('/').some((part) => part === '.git' || part === 'node_modules')) {
      throw new Error(`package snapshot path names a reserved tree: ${relative}`);
    }
    relative = normalized;
    const source = path.join(root, relative);
    if (!existsSync(source) || !filter(source)) return;
    const target = path.join(snapshot, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, filter });
  };
  try {
    if (lstatSync(path.join(root, '.git'), { throwIfNoEntry: false })) {
      const files = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'])
        .toString('utf8').split('\0').filter(Boolean);
      for (const file of files) copy(file);
      const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
      // The package declares literal file trees; include their ignored build artifacts too.
      for (const file of manifest.files ?? []) copy(file);
    } else {
      cpSync(root, snapshot, { recursive: true, filter });
    }
    const dependencies = path.join(root, 'node_modules');
    if (existsSync(dependencies)) symlinkSync(dependencies, path.join(snapshot, 'node_modules'), 'junction');
    return use(snapshot);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}
