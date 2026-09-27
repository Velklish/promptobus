import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, skip } from './check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');
const version = JSON.parse(read('package.json')).version;
const section = (doc, start, end) => {
  const from = doc.indexOf(start);
  if (from < 0) return '';
  const to = end ? doc.indexOf(end, from + start.length) : -1;
  if (end && to < 0) return '';
  return doc.slice(from, to < 0 ? undefined : to);
};
const lines = (doc) => doc.split('\n');
const line = (doc, value) => lines(doc).includes(value);
const starts = (doc, value) => lines(doc).find((entry) => entry.startsWith(value)) ?? '';
const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
const firstFencedCommandAfter = (doc, lead) => {
  const offset = doc.indexOf(lead);
  return offset < 0 ? '' : doc.slice(offset + lead.length).match(/^\n\n```bash\n([^\n]+)\n/)?.[1] ?? '';
};
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const installLine = new RegExp(`^npm install (-g )?github:Velklish/promptobus#v${escaped}$`, 'gm');
const installSection = section(read('docs/guides/install.md'), '## 1. Package', '## 2. Workspace file');

const install = read('docs/guides/install.md');
const english = read('README.md');
const russian = read('README.ru.md');
const englishInstall = section(english, '## Installation', '### 1. Declare the workspace');
const russianInstall = section(russian, '## Установка', '### 1. Объявить рабочее место');
const snippet = (heading, language) => mcpSection.split(heading)[1]?.split('\n### ')[0]
  ?.match(new RegExp(`\x60\x60\x60${language}\\n([\\s\\S]*?)\\n\x60\x60\x60`))?.[1] ?? '';
const json = (value) => {
  try { return JSON.parse(value); } catch { return null; }
};
const release = `github:Velklish/promptobus#v${version}`;
check('PB-290 supported release source for local and global installation',
  [installSection, englishInstall, russianInstall].every((doc) =>
    same([...doc.matchAll(installLine)].map((match) => match[1] ?? ''), ['', '-g '])
    && !/^npm install(?: -g)? promptobus$/m.test(doc)
    && firstFencedCommandAfter(installSection,
      'As a local library dependency, pin the GitHub release tag (the package is not published on the npm registry):')
      === `npm install ${release}`
    && firstFencedCommandAfter(installSection, 'For a global CLI on `PATH`, install the same release globally:')
      === `npm install -g ${release}`
    && firstFencedCommandAfter(englishInstall, 'The package is not on the npm registry. Install the current GitHub release as a local library dependency:')
      === `npm install ${release}`
    && firstFencedCommandAfter(englishInstall, 'For a global CLI on `PATH`, use the same pinned tag:')
      === `npm install -g ${release}`
    && firstFencedCommandAfter(russianInstall, 'Пакета нет в реестре npm. Локальную зависимость ставят с GitHub, закрепив текущий тег релиза:')
      === `npm install ${release}`
    && firstFencedCommandAfter(russianInstall, 'Для глобальной CLI-команды в `PATH` используйте тот же тег:')
      === `npm install -g ${release}`),
  'All three installation surfaces must use the current GitHub tag for both forms');

const mcpSection = section(install, '## 3. MCP server for the orchestrator', '## 4. Project hooks');
const claudeSection = section(mcpSection, '### Claude Code:', '### Cursor:');
const cursorSection = section(mcpSection, '### Cursor:', '### Codex:');
const codexSection = section(mcpSection, '### Codex:', 'For a global CLI');
const claudeMcp = json(snippet('### Claude Code:', 'json'));
const cursorMcp = json(snippet('### Cursor:', 'json'));
const codexMcp = snippet('### Codex:', 'toml');
const home = '/absolute/path/to/workspace/.promptobus';
const cliArgs = ['/absolute/path/to/bin/promptobus.js', 'mcp'];
const readmeMcp = section(english, '### 2. Give the orchestrator the MCP server', '### 3. Install the project hooks');
const russianMcp = section(russian, '### 2. Дать оркестратору MCP-сервер', '### 3. Поставить project hooks');
check('PB-291 orchestrator MCP setup names three project formats',
  mcpSection.includes('`install` writes project hooks and process skills; it does not register an MCP server for the orchestrator.')
    && mcpSection.includes('Each participant lift writes its own MCP entry.')
    && claudeSection.includes('`.mcp.json` at the workspace root')
    && cursorSection.includes('`.cursor/mcp.json` at the workspace root')
    && codexSection.includes('`.codex/config.toml` at the workspace root')
    && same(claudeMcp, { mcpServers: { promptobus: {
      type: 'stdio', command: 'node', args: cliArgs, env: { PROMPTOBUS_HOME: home },
    } } })
    && same(cursorMcp, { mcpServers: { promptobus: {
      command: 'node', args: cliArgs, env: { PROMPTOBUS_HOME: home },
    } } })
    && same(lines(codexMcp).filter(Boolean), [
      '[mcp_servers.promptobus]', 'command = "node"',
      'args = ["/absolute/path/to/bin/promptobus.js", "mcp"]',
      '[mcp_servers.promptobus.env]', `PROMPTOBUS_HOME = "${home}"`,
    ])
    && claudeSection.includes('Trust this project when Claude Code asks.')
    && claudeSection.includes('`claude mcp list` is a read-only check')
    && cursorSection.includes('approve the server when Cursor asks.')
    && cursorSection.includes('`cursor-agent mcp list-tools promptobus` reads the available tool names')
    && codexSection.includes('Trust the project so Codex loads its `.codex/config.toml` layer.')
    && codexSection.includes('`codex mcp list` checks the server entry')
    && mcpSection.includes('an owner-bound orchestrator mailbox read then returns a copy and leaves the originals unread')
    && readmeMcp.includes('Register the orchestrator\'s stdio server separately in the project file for its harness: Claude Code `.mcp.json`, Cursor `.cursor/mcp.json`, or Codex `.codex/config.toml`.')
    && readmeMcp.includes('`promptobus install` writes hooks and skills, not this MCP entry.')
    && russianMcp.includes('регистрируют отдельно в project-файле его инструмента: `.mcp.json` для Claude Code, `.cursor/mcp.json` для Cursor, `.codex/config.toml` для Codex.')
    && russianMcp.includes('`promptobus install` пишет хуки и скиллы, но не эту запись MCP.'),
  'The guide must give a destination, syntax and read-only verification for each harness');

const shippedDocs = ['README.md', 'README.ru.md', 'skills/orchestrate/SKILL.md', 'skills/solo-review/SKILL.md'];
const releasePrefix = 'https://github.com/Velklish/promptobus/blob/';
const markdownLinks = (file) => [...read(file).matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]);
const releaseLinks = (file) => markdownLinks(file).filter((target) => target.startsWith(releasePrefix));
const relativeLinks = (file) => markdownLinks(file)
  .map((target) => target.split('#')[0])
  .filter((target) => target && !/^[a-z]+:/i.test(target));
const packageFiles = new Set(['README.md', 'README.ru.md', 'LICENSE', 'package.json']);
const packagedLink = (file, target) => {
  const resolved = path.normalize(path.join(path.dirname(file), target));
  const inSkills = resolved.startsWith(`skills${path.sep}`);
  return (file.startsWith('skills/') ? inSkills : packageFiles.has(resolved) || inSkills)
    && path.resolve(root, resolved).startsWith(`${root}${path.sep}`)
    && existsSync(path.join(root, resolved));
};
const pinnedTarget = (target) => {
  try {
    const url = new URL(target);
    const parts = url.pathname.split('/');
    const rel = parts.slice(5).join('/');
    if (url.origin !== 'https://github.com' || parts[1] !== 'Velklish'
      || parts[2] !== 'promptobus' || parts[3] !== 'blob'
      || parts[4] !== `v${version}` || !rel || rel !== path.posix.normalize(rel)
      || url.search) return null;
    return { rel, anchor: decodeURIComponent(url.hash.slice(1)) };
  } catch { return null; }
};
const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
const tag = `refs/tags/v${version}`;
const tagAvailable = git('rev-parse', '--verify', '--quiet', tag).status === 0;
const taggedContents = new Map();
const taggedFile = (rel) => {
  if (!taggedContents.has(rel)) {
    const result = git('show', `${tag}:${rel}`);
    taggedContents.set(rel, result.status === 0 ? result.stdout : null);
  }
  return taggedContents.get(rel);
};
const headingAnchors = (doc) => {
  const anchors = new Set();
  const counts = new Map();
  let fenced = false;
  for (const entry of lines(doc)) {
    if (/^\s*(```|~~~)/.test(entry)) { fenced = !fenced; continue; }
    const heading = !fenced && entry.match(/^#{1,6} +(.+?)(?: +#+)?\s*$/)?.[1];
    if (!heading) continue;
    const slug = heading.replace(/<[^>]+>/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[`*_~]/g, '').toLowerCase()
      .replace(/[^\p{L}\p{N}_\s-]/gu, '').replace(/\s/g, '-');
    const count = counts.get(slug) ?? 0;
    anchors.add(count ? `${slug}-${count}` : slug);
    counts.set(slug, count + 1);
  }
  return anchors;
};
const taggedAnchors = new Map();
const reachesTag = (target) => {
  const parsed = pinnedTarget(target);
  if (!parsed) return false;
  const content = taggedFile(parsed.rel);
  if (content === null) return false;
  if (!parsed.anchor) return true;
  if (!taggedAnchors.has(parsed.rel)) taggedAnchors.set(parsed.rel, headingAnchors(content));
  return taggedAnchors.get(parsed.rel).has(parsed.anchor);
};
const overview = read('docs/reference/01-overview.md');
const packageOverview = section(overview, '### Documentation in the package', '## Store home');
const allReleaseLinks = shippedDocs.flatMap((file) => releaseLinks(file));
check('PB-292 shipped and installed documentation links use release targets',
  shippedDocs.every((file) => relativeLinks(file).every((target) => packagedLink(file, target)))
    && shippedDocs.slice(0, 3).every((file) => releaseLinks(file).length > 0)
    && allReleaseLinks.every((target) => pinnedTarget(target) !== null)
    && relativeLinks('skills/orchestrate/SKILL.md').includes('../solo-review/SKILL.md')
    && packageOverview.includes('`package.json` ships both READMEs and the two process skills, but not `docs/`')
    && packageOverview.includes('After changing `package.json`\'s version for a release, refresh all package documentation links and installation examples with this one command')
    && packageOverview.includes('for (const file of ["README.md", "README.ru.md", "docs/guides/install.md", "skills/orchestrate/SKILL.md"])')
    && packageOverview.includes('On `main` between releases, these links still open the last tagged release\'s pages')
    && packageOverview.includes('A version bump before its tag exists briefly points to a future destination'),
  'Packaged relative links must resolve and source links must name this package version');
if (tagAvailable) {
  const broken = allReleaseLinks.find((target) => !reachesTag(target));
  check('PB-292 pinned paths and anchors resolve on the release tag', allReleaseLinks.length > 0 && !broken,
    allReleaseLinks.length ? `Missing path or heading on ${tag}: ${broken}` : 'No release links found in shipped Markdown');
} else {
  const shallow = git('rev-parse', '--is-shallow-repository').stdout?.trim() === 'true';
  skip('PB-292 pinned paths and anchors resolve on the release tag',
    shallow ? `${tag} unavailable in shallow checkout; tag-tree reachability unverified`
      : `${tag} unavailable before release tag or without fetched tags; tag-tree reachability unverified`);
}
