// Execution-free reads: [05-drivers](../docs/reference/05-drivers.md#execution-free-codex-review).
import { readFileSync, readdirSync, realpathSync, statSync, openSync, closeSync, fstatSync, constants } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const SKIP = new Set(['.git', 'node_modules', 'obj']);
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const stringPath = { type: 'string', description: 'Absolute local path under the declared review roots' };
const limit = { type: 'integer', minimum: 1, maximum: 1000 };
const descriptor = (name, description, properties, required) => ({ name, description,
  inputSchema: schema(properties, required),
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
});
export const REVIEW_FILE_TOOLS = [
  descriptor('read_file', 'Read text by line, without executing commands. Lines are one-based.',
    { path: stringPath, start_line: { type: 'integer', minimum: 1 }, line_count: { type: 'integer', minimum: 1, maximum: 2000 } }, ['path']),
  descriptor('list_files', 'List local files. Pattern accepts *, ** and ? against relative paths. Symlink directories are not traversed.',
    { path: stringPath, pattern: { type: 'string' }, limit }, ['path']),
  descriptor('search_text', 'Search a literal string in local text files. No shell, regular expressions, or application code are executed.',
    { path: stringPath, query: { type: 'string', minLength: 1 }, case_sensitive: { type: 'boolean' }, limit }, ['path', 'query']),
];

function boundedInteger(value, fallback, maximum, name) {
  const n = value ?? fallback;
  if (!Number.isInteger(n) || n < 1 || n > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return n;
}
function glob(pattern) {
  if (typeof pattern !== 'string') throw new Error('pattern must be a string');
  let result = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') { i++; result += '(?:.*/)?'; } else result += '.*';
    } else if (c === '*') result += '[^/]*';
    else if (c === '?') result += '[^/]';
    else result += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${result}$`);
}

export function reviewerFiles(roots) {
  if (!Array.isArray(roots) || !roots.length || roots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw new Error('Review roots must be a non-empty array of absolute paths');
  }
  const allowed = roots.map((root) => realpathSync(root));
  const resolve = (input) => {
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('path must be absolute');
    const resolved = realpathSync(input);
    if (!allowed.some((root) => resolved === root || (!path.relative(root, resolved).startsWith(`..${path.sep}`)
      && path.relative(root, resolved) !== '..' && !path.isAbsolute(path.relative(root, resolved))))) {
      throw new Error('Path is outside the declared review roots');
    }
    return resolved;
  };
  const readBytes = (file) => {
    const before = statSync(file);
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = fstatSync(fd);
      const current = statSync(resolve(file));
      if (!opened.isFile()) throw new Error('Text reads require a regular file');
      if ([before, current].some((entry) => entry.dev !== opened.dev || entry.ino !== opened.ino)) {
        throw new Error('File changed while opening it; retry the read');
      }
      if (opened.size > MAX_FILE_BYTES) throw new Error('Text file exceeds the 64 MiB read limit');
      return readFileSync(fd);
    } finally { closeSync(fd); }
  };
  const text = (file) => {
    const bytes = readBytes(file);
    if (bytes.includes(0)) throw new Error('Binary files are not supported by text reads');
    return bytes.toString('utf8');
  };
  function* files(start) {
    if (statSync(start).isFile()) { yield start; return; }
    for (const entry of readdirSync(start, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const file = path.join(start, entry.name);
      if (entry.isDirectory()) yield* files(file);
      else if (entry.isFile()) yield file;
    }
  }
  return (name, args) => {
    if (!REVIEW_FILE_TOOLS.some((tool) => tool.name === name)) throw new Error(`Unknown read-only tool: ${name}`);
    const input = resolve(args.path);
    if (name === 'read_file') {
      if (!statSync(input).isFile()) throw new Error('read_file requires a regular file');
      const start = boundedInteger(args.start_line, 1, Number.MAX_SAFE_INTEGER, 'start_line');
      const count = boundedInteger(args.line_count, 200, 2000, 'line_count');
      const lines = text(input).split(/\r?\n/);
      return { path: input, start_line: start, total_lines: lines.length,
        lines: lines.slice(start - 1, start - 1 + count).map((value, index) => ({ line: start + index, text: value })) };
    }
    const maximum = boundedInteger(args.limit, 200, 1000, 'limit');
    const result = [];
    const pattern = name === 'list_files' ? glob(args.pattern ?? '**/*') : null;
    if (name === 'search_text' && (typeof args.query !== 'string' || !args.query.length)) throw new Error('query must be a non-empty literal string');
    if (args.case_sensitive != null && typeof args.case_sensitive !== 'boolean') throw new Error('case_sensitive must be boolean');
    const needle = args.case_sensitive === false ? args.query?.toLocaleLowerCase() : args.query;
    for (const file of files(input)) {
      // Check each discovered file again so a replaced directory cannot escape the roots.
      const resolved = resolve(file);
      const relative = path.relative(input, file).split(path.sep).join('/') || path.basename(file);
      if (pattern) {
        if (pattern.test(relative)) result.push({ path: resolved, relative_path: relative });
      } else {
        if (statSync(resolved).size > MAX_FILE_BYTES) continue;
        const bytes = readBytes(resolved);
        if (bytes.includes(0)) continue;
        const lines = bytes.toString('utf8').split(/\r?\n/);
        for (let index = 0; index < lines.length && result.length < maximum; index++) {
          const haystack = args.case_sensitive === false ? lines[index].toLocaleLowerCase() : lines[index];
          if (haystack.includes(needle)) result.push({ path: resolved, line: index + 1, text: lines[index].slice(0, 1000) });
        }
      }
      if (result.length >= maximum) return { matches: result, truncated: true };
    }
    return { matches: result, truncated: false };
  };
}

async function main() {
  const read = reviewerFiles(JSON.parse(process.env.PROMPTOBUS_REVIEW_READ_ROOTS ?? 'null'));
  const input = createInterface({ input: process.stdin });
  for await (const line of input) {
    const request = JSON.parse(line);
    if (request.id == null) continue;
    const response = { jsonrpc: '2.0', id: request.id };
    if (request.method === 'initialize') response.result = { protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'promptobus-reviewer-files', version: '1.0.0' } };
    else if (request.method === 'ping') response.result = {};
    else if (request.method === 'tools/list') response.result = { tools: REVIEW_FILE_TOOLS };
    else if (request.method === 'tools/call') {
      try { response.result = { content: [{ type: 'text', text: JSON.stringify(read(request.params.name, request.params.arguments ?? {})) }] }; }
      catch (error) { response.result = { isError: true, content: [{ type: 'text', text: error.message }] }; }
    } else response.error = { code: -32601, message: 'Method not found' };
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
