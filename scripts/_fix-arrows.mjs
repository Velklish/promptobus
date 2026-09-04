import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function walk(dir, acc = []) {
  for (const n of readdirSync(dir)) {
    if (n.startsWith('_')) continue;
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (n.endsWith('.mjs')) acc.push(p);
  }
  return acc;
}

let n = 0;
for (const f of [...walk('test'), ...walk('scripts')]) {
  let s = readFileSync(f, 'utf8');
  const before = s;
  s = s.replaceAll('(async =>', '(async () =>');
  s = s.replaceAll(', async =>', ', async () =>');
  s = s.replaceAll(', =>', ', () =>');
  s = s.replaceAll('return =>', 'return () =>');
  if (s !== before) {
    writeFileSync(f, s);
    n += 1;
    console.log(f);
  }
}
console.log(`updated ${n} files`);
