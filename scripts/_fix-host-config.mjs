import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function files(dir) {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.mjs') && n !== '_transfer-suite.mjs')
    .map((n) => path.join(dir, n));
}

const pat = /writeFileSync\(path\.join\(([^,]+), '\.agents', 'tools\.json'\), `\$\{JSON\.stringify\(\{ tools: ([^`]+?) \}\)\}\\n`\);/g;
const patPretty = /writeFileSync\(path\.join\(([^,]+), '\.agents', 'tools\.json'\), `\$\{JSON\.stringify\(\{ tools: ([^`]+?) \}, null, 2\)\}\\n`\);/g;

for (const f of [...files('test'), ...files('scripts')]) {
  let s = readFileSync(f, 'utf8');
  const before = s;
  s = s.replace(pat, 'writeHostConfig($1, { tools: $2 });');
  s = s.replace(patPretty, 'writeHostConfig($1, { tools: $2 });');
  if (s === before) continue;

  const fromTest = f.startsWith('scripts/') ? '../test/sandbox.mjs' : './sandbox.mjs';
  if (!/writeHostConfig/.test(s.match(/import \{[^}]+\} from '[^']*sandbox\.mjs'/)?.[0] ?? '')) {
    if (s.includes(`from '${fromTest}'`)) {
      s = s.replace(
        new RegExp(`import \\{([^}]+)\\} from '${fromTest.replace(/\./g, '\\.')}'`),
        (m, names) => (names.includes('writeHostConfig')
          ? m
          : `import {${names.replace(/\s+$/, '')}, writeHostConfig } from '${fromTest}'`),
      );
    } else {
      s = `import { writeHostConfig } from '${fromTest}';\n${s}`;
    }
  }
  writeFileSync(f, s);
  console.log('updated', f);
}
