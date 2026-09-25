// The running bus validates a record against the schema of the package it runs from.
// A field this checkout adds is sendable in the next release: docs/reference/04-protocol.md.
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { schemaErrors } from '../lib/schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const say = (s) => process.stdout.write(`${s}\n`);
const RELEASE = 'the record can carry that field from the next release on';

function parse(argv) {
  let checkout = ROOT;
  let resolveFrom = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--checkout') checkout = path.resolve(argv[i += 1] ?? '');
    else if (arg === '--resolve-from') resolveFrom = path.resolve(argv[i += 1] ?? '');
    else {
      say(`✖ unknown argument ${arg}`);
      process.exit(2);
    }
    if (argv[i] === undefined) {
      say(`✖ ${arg} needs a directory`);
      process.exit(2);
    }
  }
  return { checkout, resolveFrom: resolveFrom ?? checkout };
}

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function deref(node, root) {
  let current = node;
  for (let guard = 0; guard < 8 && isObject(current) && typeof current.$ref === 'string'; guard += 1) {
    const name = current.$ref.startsWith('#/$defs/') ? current.$ref.slice('#/$defs/'.length) : null;
    const next = name ? root.$defs?.[name] : null;
    if (!isObject(next)) return current;
    current = next;
  }
  return current;
}

function withDefs(root, node) {
  const bare = deref(node, root);
  if (!isObject(root.$defs) || isObject(bare.$defs)) return bare;
  return { ...bare, $defs: root.$defs };
}

function faults(root, node, value) {
  const schema = withDefs(root, node);
  return schemaErrors(schema, value);
}

// A witness that fails a pattern is still evidence: the two readers are compared
// at one path, not by whether the whole value passes the checkout schema.
function installedRefusesAt(cRoot, cNode, iRoot, iNode, value, at, notes) {
  let cErr;
  let iErr;
  try {
    cErr = faults(cRoot, cNode, value);
    iErr = faults(iRoot, iNode, value);
  } catch {
    return false;
  }
  const checkout = new Set(cErr.filter((e) => e.at === at).map((e) => e.note));
  const refused = iErr.some((e) => e.at === at && (notes === null || notes.has(e.note)) && !checkout.has(e.note));
  return refused;
}

function faultKey(error) {
  return `${error.at}\0${error.note}`;
}

function branchFaults(root, node, value) {
  try {
    return faults(root, node, value);
  } catch {
    return null;
  }
}

// Judged alone, not inside the oneOf: "matches K of N" carries the branch count,
// so equal counts hide a new branch and unequal counts invent one.
function everyInstalledBranchRefuses(cRoot, cBranch, iRoot, iBranches, value) {
  const cErr = branchFaults(cRoot, cBranch, value);
  if (!cErr) return false;
  const have = new Set(cErr.map(faultKey));
  const everyBranchRefuses = iBranches.every((iBranch) => {
    const iErr = branchFaults(iRoot, iBranch, value);
    return iErr !== null && iErr.some((e) => !have.has(faultKey(e)));
  });
  return everyBranchRefuses;
}

function confirms(cRoot, cNode, iRoot, iNode, value) {
  try {
    const accepted = faults(cRoot, cNode, value);
    const refused = faults(iRoot, iNode, value);
    return accepted.length === 0 && refused.length > 0;
  } catch {
    return null;
  }
}

function sample(node, root, depth = 0) {
  if (!isObject(node) || depth > 12) return null;
  const n = deref(node, root);
  if (Object.hasOwn(n, 'const')) return n.const;
  if (Array.isArray(n.oneOf)) {
    for (const branch of n.oneOf) {
      const value = sample(branch, root, depth + 1);
      if (value !== null && value !== undefined) return value;
    }
  }
  const type = typeof n.type === 'string' ? n.type : guessType(n);
  if (type === 'string') return sampleString(n);
  if (type === 'integer') return sampleNumber(n, true);
  if (type === 'number') return sampleNumber(n, false);
  if (type === 'boolean') return false;
  if (type === 'null') return null;
  if (type === 'array') return sampleArray(n, root, depth);
  if (type === 'object') return sampleObject(n, root, depth);
  return null;
}

function guessType(n) {
  if (isObject(n.properties) || Array.isArray(n.required) || Object.hasOwn(n, 'additionalProperties')) return 'object';
  if (isObject(n.items)) return 'array';
  return null;
}

function sampleString(n) {
  const min = Number.isInteger(n.minLength) ? n.minLength : 1;
  let s = 'a'.repeat(Math.max(min, 1));
  if (Number.isInteger(n.maxLength) && s.length > n.maxLength) s = s.slice(0, Math.max(n.maxLength, 0));
  return s;
}

function sampleNumber(n, integer) {
  let v = typeof n.minimum === 'number' ? n.minimum : 0;
  if (typeof n.maximum === 'number' && v > n.maximum) v = n.maximum;
  if (integer && !Number.isInteger(v)) v = Math.ceil(v);
  if (typeof n.minimum === 'number' && v < n.minimum) v = n.minimum;
  return v;
}

function sampleArray(n, root, depth) {
  const count = Number.isInteger(n.minItems) ? n.minItems : 0;
  if (!isObject(n.items) || count === 0) return [];
  return Array.from({ length: count }, () => sample(n.items, root, depth + 1));
}

function sampleObject(n, root, depth) {
  const obj = {};
  const props = isObject(n.properties) ? n.properties : {};
  for (const key of n.required ?? []) obj[key] = sample(props[key], root, depth + 1);
  return obj;
}

function typeWitness(cType, iType) {
  if (cType === 'number' && iType === 'integer') return 0.5;
  if (cType === 'string') return 'a';
  if (cType === 'integer' || cType === 'number') return 1;
  if (cType === 'boolean') return true;
  if (cType === 'array') return [];
  if (cType === 'object') return {};
  if (cType === 'null') return null;
  return null;
}

function branchKey(node, root) {
  if (isObject(node) && typeof node.$ref === 'string') return `ref:${node.$ref}`;
  const n = deref(node, root);
  const props = isObject(n.properties) ? Object.keys(n.properties).sort().join(',') : '';
  const req = Array.isArray(n.required) ? [...n.required].sort().join(',') : '';
  return `type:${n.type ?? ''}|props:${props}|req:${req}|const:${JSON.stringify(n.const ?? null)}`;
}

function pairBranches(cBranches, iBranches, cRoot, iRoot) {
  const used = new Set();
  const matched = [];
  const unmatched = [];
  for (let ci = 0; ci < cBranches.length; ci += 1) {
    const key = branchKey(cBranches[ci], cRoot);
    let found = -1;
    for (let ii = 0; ii < iBranches.length; ii += 1) {
      if (used.has(ii)) continue;
      if (branchKey(iBranches[ii], iRoot) === key) {
        found = ii;
        break;
      }
    }
    if (found === -1) unmatched.push(ci);
    else {
      used.add(found);
      matched.push([ci, found]);
    }
  }
  return { matched, unmatched };
}

function child(at, key) {
  return `${at}/${key}`;
}

function push(found, at, kind) {
  if (!found.some((row) => row.at === at && row.kind === kind)) found.push({ at, kind });
}

function walk(cNode, iNode, at, cRoot, iRoot, seen, tag) {
  if (!isObject(cNode) || !isObject(iNode)) return [];
  const mark = `${tag}|${at}|${cNode.$ref ?? ''}|${iNode.$ref ?? ''}`;
  if (seen.has(mark)) return [];
  seen.add(mark);
  const c = deref(cNode, cRoot);
  const i = deref(iNode, iRoot);
  const found = [];
  const undefinedField = new Set(['field the schema does not define', 'required field is missing']);

  if (Object.hasOwn(c, 'const') && Object.hasOwn(i, 'const') && !sameJson(c.const, i.const)) {
    const checkoutConst = { const: c.const };
    const installedConst = { const: i.const };
    if (confirms(checkoutConst, checkoutConst, installedConst, installedConst, c.const) === true) {
      push(found, at, `const ${JSON.stringify(c.const)} the installed schema does not accept`);
    }
  }

  if (typeof c.type === 'string' && typeof i.type === 'string' && c.type !== i.type) {
    const value = typeWitness(c.type, i.type);
    const checkoutType = { type: c.type };
    const installedType = { type: i.type };
    if (value !== null && confirms(checkoutType, checkoutType, installedType, installedType, value) === true) {
      push(found, at, 'type the installed schema does not accept');
    }
  }

  const cProps = isObject(c.properties) ? c.properties : {};
  const iProps = isObject(i.properties) ? i.properties : {};
  for (const key of Object.keys(cProps)) {
    const where = child(at, key);
    if (!Object.hasOwn(iProps, key)) {
      const base = sample(c, cRoot);
      const value = isObject(base) ? { ...base } : {};
      value[key] = sample(cProps[key], cRoot);
      if (installedRefusesAt(cRoot, c, iRoot, i, value, `/${key}`, undefinedField)) {
        const kind = (c.required ?? []).includes(key)
          ? 'required property the installed schema does not define'
          : 'property the installed schema does not define';
        push(found, where, kind);
      }
    } else {
      found.push(...walk(cProps[key], iProps[key], where, cRoot, iRoot, seen, `${tag}/${key}`));
    }
  }

  for (const key of i.required ?? []) {
    if ((c.required ?? []).includes(key)) continue;
    const value = sample(c, cRoot);
    if (isObject(value)) delete value[key];
    const missing = new Set(['required field is missing']);
    if (installedRefusesAt(cRoot, c, iRoot, i, value, `/${key}`, missing)) {
      push(found, child(at, key), 'required field the installed schema still requires');
    }
  }

  if (isObject(c.items) && isObject(i.items)) {
    found.push(...walk(c.items, i.items, `${at}/0`, cRoot, iRoot, seen, `${tag}/items`));
  }
  if (isObject(c.additionalProperties) && isObject(i.additionalProperties)) {
    found.push(...walk(
      c.additionalProperties,
      i.additionalProperties,
      `${at}/*`,
      cRoot,
      iRoot,
      seen,
      `${tag}/additional`,
    ));
  }

  if (Array.isArray(c.oneOf)) {
    const iBranches = Array.isArray(i.oneOf) ? i.oneOf : [i];
    const { matched, unmatched } = pairBranches(c.oneOf, iBranches, cRoot, iRoot);
    for (const [ci, ii] of matched) {
      found.push(...walk(c.oneOf[ci], iBranches[ii], at, cRoot, iRoot, seen, `${tag}/oneOf/${ci}`));
    }
    for (const ci of unmatched) {
      const value = sample(c.oneOf[ci], cRoot);
      if (everyInstalledBranchRefuses(cRoot, c.oneOf[ci], iRoot, iBranches, value)) {
        push(found, at, 'shape the installed schema does not accept');
      }
    }
  }

  return found;
}

function recordNames(root) {
  const dir = path.join(root, 'schemas', 'v1');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith('-record.schema.json')).sort();
}

function readSchema(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function resolveInstalled(resolveFrom) {
  const require = createRequire(pathToFileURL(path.join(resolveFrom, 'package.json')));
  const dirs = require.resolve.paths('promptobus') ?? [];
  say(`resolved: Node resolve.paths("promptobus") from ${resolveFrom} upward (${dirs.length} directories)`);
  for (const dir of dirs) {
    const pkgJson = path.join(dir, 'promptobus', 'package.json');
    if (!existsSync(pkgJson)) continue;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
    } catch {
      continue;
    }
    if (pkg.name !== 'promptobus') continue;
    return { root: path.dirname(pkgJson), version: pkg.version ?? 'unknown' };
  }
  return null;
}

const opts = parse(process.argv.slice(2));
const installed = resolveInstalled(opts.resolveFrom);
if (!installed) {
  say('not run: no installed promptobus package found');
  process.exit(0);
}
say(`installed: ${installed.root} (${installed.version})`);

const names = recordNames(opts.checkout);
if (!names.length) {
  say('✖ no record schemas under schemas/v1 (*-record.schema.json)');
  process.exit(1);
}

let refusals = 0;
for (const name of names) {
  const rel = path.posix.join('schemas/v1', name);
  const checkoutFile = path.join(opts.checkout, 'schemas', 'v1', name);
  const installedFile = path.join(installed.root, 'schemas', 'v1', name);
  if (!existsSync(installedFile)) {
    say(`✖ ${rel}: no copy in the installed package; ${RELEASE}`);
    refusals += 1;
    continue;
  }
  let checkoutSchema;
  let installedSchema;
  try {
    checkoutSchema = readSchema(checkoutFile);
    installedSchema = readSchema(installedFile);
  } catch (e) {
    say(`✖ ${rel}: ${e.message}`);
    refusals += 1;
    continue;
  }
  const found = walk(checkoutSchema, installedSchema, '', checkoutSchema, installedSchema, new Set(), 'root');
  if (!found.length) {
    say(`✔ ${rel} agrees with the installed schema`);
    continue;
  }
  for (const row of found) {
    const where = row.at || '/';
    say(`✖ ${rel}: ${where} — ${row.kind}; ${RELEASE}`);
  }
  refusals += found.length;
}

say(`${names.length} record schema(s) compared, ${refusals} the running bus would refuse`);
process.exit(refusals > 0 ? 1 : 0);
