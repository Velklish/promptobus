import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check } from './check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const version = JSON.parse(read('package.json')).version;

const install = read('docs/guides/install.md');
const english = read('README.md');
const russian = read('README.ru.md');
const release = `github:Velklish/promptobus#v${version}`;
check('PB-290 supported release source for local and global installation',
  [install, english, russian].every((doc) => doc.includes(`npm install ${release}`)
    && doc.includes(`npm install -g ${release}`)
    && !/^npm install promptobus\s*$/m.test(doc)),
  'All three installation surfaces must use the current GitHub tag for both forms');
