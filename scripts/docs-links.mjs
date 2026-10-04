// Documentation links: source checkout, packed files, installed skills.
// What it covers and what it leaves to the external command: guides/contributing.md § Documentation links.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/exec.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Skill directories `promptobus install` writes. Held equal to the driver constants by the suite. */
export const INSTALL_LAYOUT = [
  { harness: 'claude', skillsRel: path.join('.claude', 'skills') },
  { harness: 'cursor', skillsRel: path.join('.cursor', 'skills') },
  { harness: 'codex', skillsRel: path.join('.codex', 'skills') },
];

const TASK_ROOTS = ['docs/backlog', 'docs/archive'];

/** GitHub's heading slug: punctuation goes, letters stay, each space becomes a hyphen. */
export function slugBase(value) {
  return String(value).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
}

/** Unique slugs in document order. A repeated heading takes `-1`, then `-2`, as GitHub does. */
export function uniqueSlugs(bases) {
  const occurrences = Object.create(null);
  const out = [];
  for (const base of bases) {
    let result = base;
    const original = base;
    while (Object.hasOwn(occurrences, result)) {
      occurrences[original] += 1;
      result = `${original}-${occurrences[original]}`;
    }
    occurrences[result] = 0;
    out.push(result);
  }
  return out;
}

function fenceMarker(line) {
  const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!open) return null;
  return { char: open[1][0], len: open[1].length, rest: open[2] };
}

function skipFenced(text, onProseLine) {
  const lines = text.split('\n');
  let fence = null;
  const kept = [];
  for (const line of lines) {
    const marker = fenceMarker(line);
    if (!fence && marker) {
      fence = marker;
      kept.push('');
      continue;
    }
    if (fence && marker && marker.char === fence.char && marker.len >= fence.len && marker.rest.trim() === '') {
      fence = null;
      kept.push('');
      continue;
    }
    if (fence) {
      kept.push('');
      continue;
    }
    kept.push(onProseLine ? onProseLine(line) : line);
  }
  return kept.join('\n');
}

function maskComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (block) => block.replace(/[^\n]/g, ' '));
}

function maskCommentsAndCode(text) {
  const noFence = skipFenced(text);
  return maskComments(noFence).replace(/`+[^`\n]*`+/g, (span) => ' '.repeat(span.length));
}

function visibleHeading(raw) {
  return raw
    .replace(/!\[[^\]]*]\([^)]*\)/g, (m) => m.slice(2, m.indexOf(']')))
    .replace(/\[([^\]]*)]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)]\[[^\]]*]/g, '$1')
    .replace(/<[^>]+>/g, '');
}

/** Anchors a file actually exposes: heading slugs, duplicate suffixes, and explicit ids. */
export function anchorsOf(text) {
  const lines = maskComments(skipFenced(text)).split('\n');
  const bases = [];
  for (const line of lines) {
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.*)$/);
    if (!heading) continue;
    const raw = heading[1].replace(/[ \t]+#+[ \t]*$/, '');
    bases.push(slugBase(visibleHeading(raw)));
  }
  const anchors = new Set(uniqueSlugs(bases));
  const prose = maskCommentsAndCode(text);
  for (const m of prose.matchAll(/\sid\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) anchors.add(m[1] ?? m[2]);
  for (const m of prose.matchAll(/<a\b[^>]*\bname\s*=\s*(?:"([^"]+)"|'([^']+)')/gi)) anchors.add(m[1] ?? m[2]);
  return anchors;
}

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

function labelKey(label) {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

function cleanDest(raw) {
  let dest = raw.trim();
  if (dest.startsWith('<') && dest.endsWith('>')) dest = dest.slice(1, -1).trim();
  return dest;
}

function readParenDest(text, openParen) {
  let i = openParen + 1;
  while (text[i] === ' ' || text[i] === '\t') i += 1;
  let dest;
  if (text[i] === '<') {
    const end = text.indexOf('>', i + 1);
    if (end === -1) return null;
    dest = text.slice(i + 1, end).trim();
    i = end + 1;
  } else {
    const raw = text.slice(i).match(/^[^\s)]+/);
    if (!raw) return null;
    dest = raw[0];
    i += raw[0].length;
  }
  const title = text.slice(i).match(/^[ \t]+(?:"[^"]*"|'[^']*')/);
  if (title) i += title[0].length;
  if (text[i] !== ')') return null;
  return { dest, end: i + 1 };
}

function parseWrapped(text, openBracket) {
  if (text[openBracket] !== '[') return null;
  let i = openBracket + 1;
  let depth = 1;
  while (i < text.length && depth > 0) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '[') depth += 1;
    else if (text[i] === ']') depth -= 1;
    if (depth > 0) i += 1;
  }
  if (depth !== 0) return null;
  const label = text.slice(openBracket + 1, i);
  const next = text[i + 1];
  if (next === '(') {
    const dest = readParenDest(text, i + 1);
    if (!dest) return null;
    return { label, dest: dest.dest, end: dest.end, form: 'inline' };
  }
  if (next === '[') {
    const ref = text.slice(i + 1).match(/^\[([^\]]*)]/);
    if (!ref) return null;
    return { label, ref: ref[1], end: i + 1 + ref[0].length, form: 'reference' };
  }
  return { label, end: i + 1, form: 'shortcut' };
}

/** Inline, reference-style and HTML links, taken from prose. Code and comments are not links. */
export function linksOf(text) {
  const masked = maskCommentsAndCode(text);
  const defs = new Map();
  const found = [];
  const taken = [];
  const occupy = (index, length) => taken.push([index, index + length]);
  const free = (index) => taken.every(([a, b]) => index < a || index >= b);
  const defRe = /^ {0,3}\[([^\]]+)]:[ \t]*(<[^>\n]+>|[^\s)]+)/gm;
  for (const m of masked.matchAll(defRe)) {
    const key = labelKey(m[1]);
    const dest = cleanDest(m[2]);
    const line = lineAt(masked, m.index);
    if (!defs.has(key)) defs.set(key, { dest, line });
    occupy(m.index, m[0].length);
    found.push({ line, dest, form: 'definition' });
  }
  const push = (index, length, dest, form) => {
    occupy(index, length);
    found.push({ line: lineAt(masked, index), dest, form });
  };
  const emitRef = (start, end, label, ref) => {
    const key = labelKey(ref || label);
    const def = defs.get(key);
    push(start, end - start, def ? def.dest : null, def ? 'reference' : 'unresolved-reference');
  };
  const emitImages = (label, labelStart) => {
    for (let k = 0; k < label.length; k += 1) {
      if (label[k] !== '!' || label[k + 1] !== '[') continue;
      const image = parseWrapped(label, k + 1);
      if (!image || image.form === 'shortcut') continue;
      const at = labelStart + k;
      if (image.form === 'inline') push(at, image.end - k, image.dest, 'inline');
      else emitRef(at, labelStart + image.end, image.label, image.ref);
      k = image.end - 1;
    }
  };

  for (let i = 0; i < masked.length; i += 1) {
    if (!free(i)) continue;
    const imageAt = masked[i] === '!' && masked[i + 1] === '[';
    const open = imageAt ? i + 1 : (masked[i] === '[' ? i : -1);
    if (open === -1) continue;
    const node = parseWrapped(masked, open);
    if (!node) continue;
    const start = imageAt ? i : open;
    if (node.form === 'inline') push(start, node.end - start, node.dest, 'inline');
    else if (node.form === 'reference') emitRef(start, node.end, node.label, node.ref);
    else {
      const def = defs.get(labelKey(node.label));
      if (!def) {
        if (imageAt) i = node.end - 1;
        continue;
      }
      push(start, node.end - start, def.dest, 'reference');
    }
    if (!imageAt) emitImages(node.label, open + 1);
    i = node.end - 1;
  }

  const htmlRe = /<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')/gi;
  for (const m of masked.matchAll(htmlRe)) {
    if (!free(m.index)) continue;
    push(m.index, m[0].length, cleanDest(m[2] ?? m[3] ?? ''), 'html');
  }

  const autoRe = /<(https?:\/\/[^>\s]+)>/gi;
  for (const m of masked.matchAll(autoRe)) {
    if (!free(m.index)) continue;
    push(m.index, m[0].length, m[1], 'autolink');
  }

  found.sort((a, b) => a.line - b.line || a.form.localeCompare(b.form));
  return found;
}

export function splitDest(dest) {
  if (dest == null) return { kind: 'unresolved' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(dest)) {
    return /^https?:\/\//i.test(dest) ? { kind: 'external', href: dest } : { kind: 'external-other', href: dest };
  }
  const hash = dest.indexOf('#');
  const file = (hash === -1 ? dest : dest.slice(0, hash)).split('?')[0];
  const anchor = hash === -1 ? null : decodeFragment(dest.slice(hash + 1).split('?')[0]);
  return { kind: 'local', file, anchor };
}

function decodeFragment(fragment) {
  if (!fragment) return fragment;
  try { return decodeURIComponent(fragment); } catch { return fragment; }
}

function posixRel(fromRel, filePart) {
  if (!filePart) return { escapes: false, rel: fromRel };
  if (filePart.startsWith('/')) {
    const rel = path.posix.normalize(filePart.slice(1));
    return { escapes: rel.startsWith('../'), rel };
  }
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), filePart));
  return { escapes: rel === '..' || rel.startsWith('../'), rel };
}

export function isConsumerDoc(rel) {
  if (rel === 'README.md') return true;
  if (rel.startsWith('skills/')) return true;
  if (rel === 'docs/ROLES.md') return false;
  if (!rel.startsWith('docs/')) return false;
  return !TASK_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`));
}

export function inUnreleased(text, line) {
  const lines = text.split('\n');
  let start = 0;
  let end = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (start === 0 && /^## \[Unreleased]/.test(lines[i])) start = i + 1;
    else if (start && /^## \[/.test(lines[i])) { end = i + 1; break; }
  }
  if (!start) return false;
  if (!end) end = lines.length + 1;
  return line > start && line < end;
}

export function consumerLink(rel, line, text) {
  if (rel === 'CHANGELOG.md') return inUnreleased(text, line);
  return isConsumerDoc(rel);
}

function isTaskPath(rel) {
  return TASK_ROOTS.some((root) => rel === root || rel.startsWith(`${root}/`));
}

function hasTracked(tracked, rel) {
  if (tracked.has(rel)) return true;
  const prefix = rel.endsWith('/') ? rel : `${rel}/`;
  for (const file of tracked) if (file.startsWith(prefix)) return true;
  return false;
}

function anchorMatches(anchors, fragment) {
  if (fragment == null || fragment === '') return true;
  return anchors.has(fragment) || anchors.has(fragment.toLowerCase());
}

export function classifyHttpStatus(status) {
  if (status >= 200 && status < 400) return 'ok';
  if (status === 401 || status === 403 || status === 408 || status === 429) return 'unverified';
  if (status >= 500 && status <= 599) return 'unverified';
  return 'dead';
}

export function classifyTransportFailure() {
  return 'unverified';
}

function sortCount(values) {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The whole local check. An empty file list or an empty link list is a failure. */
export function collect(docs, ctx) {
  const files = docs.length;
  let links = 0;
  let external = 0;
  const sourceFailures = [];
  const taskDependencies = [];
  const deliveryMisses = [];
  const externalHrefs = new Set();
  const anchorCache = new Map(docs.map((doc) => [doc.rel, anchorsOf(doc.text)]));
  const byRel = new Map(docs.map((doc) => [doc.rel, doc]));

  for (const doc of docs) {
    for (const link of linksOf(doc.text)) {
      links += 1;
      const split = splitDest(link.dest);
      if (split.kind === 'unresolved') {
        sourceFailures.push(`${doc.rel}:${link.line} unresolved reference`);
        continue;
      }
      if (split.kind !== 'local') {
        external += 1;
        if (split.kind === 'external') externalHrefs.add(split.href.split('#')[0]);
        continue;
      }
      const where = posixRel(doc.rel, split.file);
      const id = `${doc.rel}:${link.line} -> ${link.dest}`;
      if (where.escapes || !hasTracked(ctx.tracked, where.rel)) {
        sourceFailures.push(`${id} (${where.escapes ? 'leaves the repository' : 'missing file'})`);
      } else if (!anchorMatches(anchorCache.get(where.rel) ?? new Set(), split.anchor)) {
        sourceFailures.push(`${id} (missing anchor)`);
      }
      if (consumerLink(doc.rel, link.line, doc.text)) {
        if (!where.escapes && isTaskPath(where.rel)) taskDependencies.push(`${doc.rel} -> ${link.dest}`);
        else if (!where.escapes && !hasTracked(ctx.tracked, where.rel) && existsSync(path.join(ctx.root, where.rel))) {
          taskDependencies.push(`${doc.rel} -> ${link.dest} (untracked)`);
        }
      }
      if (ctx.packed.has(doc.rel) && (where.escapes || !ctx.packed.has(where.rel) && !packedDir(ctx.packed, where.rel))) {
        deliveryMisses.push(`packed:${doc.rel} -> ${link.dest}`);
      }
    }
  }

  for (const skill of ctx.skills) {
    for (const fileRel of skill.files) {
      const sourceRel = path.posix.join('skills', skill.name, fileRel.split(path.sep).join('/'));
      const doc = byRel.get(sourceRel);
      if (!doc) continue;
      for (const place of INSTALL_LAYOUT) {
        const installedRel = path.posix.join(place.skillsRel.split(path.sep).join('/'), skill.name, fileRel.split(path.sep).join('/'));
        for (const link of linksOf(doc.text)) {
          const split = splitDest(link.dest);
          if (split.kind !== 'local') continue;
          const where = posixRel(installedRel, split.file);
          if (where.escapes || !ctx.installed.has(where.rel)) {
            deliveryMisses.push(`installed:${place.harness}:${installedRel} -> ${link.dest}`);
          }
        }
      }
    }
  }

  const empty = files === 0 || links === 0;
  return {
    files, links, external, externalHrefs: [...externalHrefs].sort(),
    empty,
    sourceFailures: sortCount(sourceFailures),
    taskDependencies: sortCount(taskDependencies),
    deliveryMisses: sortCount(deliveryMisses),
  };
}

function packedDir(packed, rel) {
  const prefix = rel.endsWith('/') ? rel : `${rel}/`;
  for (const file of packed) if (file.startsWith(prefix)) return true;
  return false;
}

export function trackedPaths(root) {
  const buf = execFileSync('git', ['-C', root, 'ls-files', '-z']);
  return buf.toString('utf8').split('\0').filter(Boolean);
}

function walkFiles(abs, rel, out) {
  const st = statSync(abs);
  if (st.isSymbolicLink()) return;
  if (st.isFile()) { out.push(rel); return; }
  if (!st.isDirectory()) return;
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.isSymbolicLink()) continue;
    const child = rel ? path.posix.join(rel, ent.name) : ent.name;
    walkFiles(path.join(abs, ent.name), child, out);
  }
}

export function packedPaths(root) {
  const args = ['pack', '--dry-run', '--json', '--ignore-scripts'];
  const result = run('npm', args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.signal || result.status !== 0) {
    const detail = result.error?.message
      ?? (result.signal ? `signal ${result.signal}` : `status ${result.status}`);
    throw new Error(`npm ${args.join(' ')} failed: ${detail}`);
  }
  let parsed;
  try {
    const stdout = String(result.stdout ?? '');
    parsed = JSON.parse(stdout.slice(Math.max(0, stdout.indexOf('['))));
  } catch (err) {
    throw new Error(`npm pack returned a malformed inventory: ${err.message}`);
  }
  const files = parsed?.[0]?.files;
  if (!Array.isArray(files) || files.length === 0) throw new Error('npm pack returned no files');
  return files.map((file) => String(file.path).split('\\').join('/'));
}

export function skillFiles(root) {
  const base = path.join(root, 'skills');
  if (!existsSync(base)) return [];
  const skills = [];
  for (const ent of readdirSync(base, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
    const files = [];
    walkFiles(path.join(base, ent.name), '', files);
    files.sort((a, b) => a.localeCompare(b));
    skills.push({ name: ent.name, files });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function installedPaths(skills) {
  const out = new Set();
  for (const skill of skills) {
    for (const fileRel of skill.files) {
      for (const place of INSTALL_LAYOUT) {
        out.add(path.posix.join(place.skillsRel.split(path.sep).join('/'), skill.name, fileRel.split(path.sep).join('/')));
      }
    }
  }
  return out;
}

export function loadDocs(root, list = null) {
  const tracked = list ?? trackedPaths(root);
  const markdown = tracked.filter((rel) => rel.endsWith('.md')).sort();
  const docs = markdown.map((rel) => ({ rel, text: readFileSync(path.join(root, rel), 'utf8') }));
  const packed = new Set(packedPaths(root));
  const skills = skillFiles(root);
  return {
    docs,
    ctx: { root, tracked: new Set(tracked), packed, skills, installed: installedPaths(skills) },
  };
}

export function audit(root, opts = {}) {
  if (opts.docs) return collect(opts.docs, opts.ctx);
  const loaded = loadDocs(root, opts.list);
  return collect(loaded.docs, loaded.ctx);
}

export function multisetDiff(baseline, actual) {
  const count = (values) => {
    const map = new Map();
    for (const value of values) map.set(value, (map.get(value) ?? 0) + 1);
    return map;
  };
  const owed = count(baseline);
  const have = count(actual);
  const stale = [];
  const added = [];
  for (const [key, n] of owed) for (let i = have.get(key) ?? 0; i < n; i += 1) stale.push(key);
  for (const [key, n] of have) for (let i = owed.get(key) ?? 0; i < n; i += 1) added.push(key);
  return { stale: sortCount(stale), added: sortCount(added) };
}

async function checkExternal(hrefs) {
  const rows = [];
  for (const href of hrefs) {
    try {
      const res = await fetch(href, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
        headers: { 'user-agent': 'promptobus-docs-links' },
      });
      rows.push({ href, class: classifyHttpStatus(res.status), status: res.status });
    } catch (err) {
      rows.push({ href, class: classifyTransportFailure(), error: err.name || err.code || 'error' });
    }
  }
  return rows;
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

async function main() {
  const external = process.argv.includes('--external');
  const printBaseline = process.argv.includes('--print-baseline');
  const report = audit(ROOT);
  if (printBaseline) {
    say(JSON.stringify({
      taskDependencies: report.taskDependencies,
      delivery: report.deliveryMisses,
    }, null, 2));
    return;
  }
  if (external) {
    const rows = await checkExternal(report.externalHrefs);
    let dead = 0;
    let unverified = 0;
    for (const row of rows) {
      if (row.class === 'dead') dead += 1;
      if (row.class === 'unverified') unverified += 1;
      const detail = row.status ?? row.error;
      say(`${row.class}\t${detail}\t${row.href}`);
    }
    say(`docs-links external: ${rows.length} urls, ${dead} dead, ${unverified} unverified`);
    if (dead) process.exitCode = 1;
    else if (unverified) process.exitCode = 2;
    return;
  }
  say(`docs-links: ${report.files} files, ${report.links} links, ${report.external} external`);
  for (const failure of report.sourceFailures) say(`source ${failure}`);
  if (report.empty || report.sourceFailures.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
