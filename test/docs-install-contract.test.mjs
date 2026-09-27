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

const glossary = read('docs/GLOSSARY.md');
const trust = read('docs/guides/hooks-and-trust.md');
const drivers = read('docs/reference/05-drivers.md');
const englishFeatures = section(english, '## Features', '## Requirements');
const russianFeatures = section(russian, '## Что умеет', '## Требования');
const englishHooks = starts(englishFeatures, '- **MCP server and hooks.**');
const russianHooks = starts(russianFeatures, '- **MCP-сервер и хуки.**');
const englishMcpTools = section(english, '### MCP tools', '### Model routing');
const russianMcpTools = section(russian, '### Инструменты MCP', '### Маршрутизация моделей');
const toolRows = (doc) => [...doc.matchAll(/^\| `(promptobus_[a-z]+)` \|/gm)].map((match) => match[1]);
const sixTools = ['promptobus_send', 'promptobus_mailbox', 'promptobus_task',
  'promptobus_digest', 'promptobus_status', 'promptobus_ask'];
const overviewTools = section(overview, '### The tool declarations', '### Rendering a reply for a participant');
const englishLibrary = section(english, '## Library', '## Development');
const russianLibrary = section(russian, '## Библиотека', '## Разработка');
const englishDevelopment = section(english, '## Development', '## Contributing');
const russianDevelopment = section(russian, '## Разработка', '## Как участвовать');
const trustRoles = section(trust, "## A participant's hooks are not the workspace's", '## What is never touched');
const trustNeverTouched = section(trust, '## What is never touched', '## How to verify');
const driversIntro = section(drivers, '# Drivers', '## Participant binding before launch');
const russianCommands = section(russian, '### Команды', '### Инструменты MCP');
const russianSteps = starts(russianFeatures, '- **Шаги проверки.**');
const russianAcceptance = starts(russianFeatures, '- **Адресованная приёмка.**');
const russianStepCommand = starts(russianCommands, '| `promptobus step <name> <path> --task <id>` |');
check('PB-293 entry points match current hooks tools roles and package',
  englishHooks.includes('`promptobus mcp` exposes six tools over stdio, including three restricted to a proven reporter session.')
    && englishHooks.includes('Stop and SessionStart loop guard for Claude Code and Codex, and a stop guard for Cursor.')
    && englishHooks.includes('as soon as an orchestrator receives a question from `user`.')
    && russianHooks.includes('`promptobus mcp` отдаёт шесть инструментов по stdio; три доступны только подтверждённой сессии reporter.')
    && russianHooks.includes('Stop и SessionStart для Claude Code и Codex, только на stop для Cursor.')
    && russianHooks.includes('сразу после вопроса `user` оркестратору.')
    && same(toolRows(englishMcpTools), sixTools)
    && same(toolRows(russianMcpTools), sixTools)
    && sixTools.slice(3).every((name) => starts(englishMcpTools, `| \`${name}\` |`).includes('Reporter only:'))
    && sixTools.slice(3).every((name) => starts(russianMcpTools, `| \`${name}\` |`).includes('Только для reporter:'))
    && overviewTools.includes('The service declares six tools: `send`, `mailbox`, and `task` for participants,')
    && overviewTools.includes('and `digest`, `status`, and `ask` for a proven reporter.')
    && overviewTools.includes('six declarations carry `additionalProperties: false`')
    && section(overview, '### Rendering a reply for a participant', '### The package entry point')
      .includes('names the home, task and address')
    && starts(englishLibrary, '| `promptobus/hooks` |').includes('Stop and SessionStart loop guard')
    && starts(russianLibrary, '| `promptobus/hooks` |').includes('Stop и SessionStart; Cursor ставит только stop')
    && englishDevelopment.includes('`skills/`, `schemas/` and `models/` ship in the tarball.')
    && russianDevelopment.includes('`skills/`, `schemas/` и `models/` едут в tarball.')
    && starts(glossary, '| hook |').includes('Claude Code and Codex use Stop and SessionStart; Cursor uses stop.')
    && starts(glossary, '| hook |').includes('former PostToolUse feed hook is recognised only for removal.')
    && starts(glossary, '| unanswered |').includes('an orchestrator\'s question from `user` is visible immediately, before its turn ends.')
    && section(trust, '# Hooks, trust, and troubleshooting', '## What the installer edits')
      .includes('Stop and SessionStart on Claude Code and Codex, and stop on Cursor.')
    && trustRoles.includes('A worker works in its worktree, an approver in its own worktree, and a diff reviewer in a separate directory or sandbox.')
    && trustRoles.includes('Teamlead and reporter sessions work at the install root')
    && !trustNeverTouched.includes('runner must stay')
    && driversIntro.includes('Claude Code and Codex install Stop and SessionStart,')
    && driversIntro.includes('while Cursor installs stop only')
    && driversIntro.includes('Teamlead and reporter sessions work at the install root')
    && ['promptobus spawn --teamlead', 'promptobus report', 'promptobus step', 'promptobus ask']
      .every((command) => russianCommands.includes(`| \`${command}`))
    && russianSteps.includes('Первый гейт чтения диффа можно поднять без результата предыдущего участника; каждый следующий гейт требует текущий результат предшествующего объявленного гейта для того же объекта проверки.')
    && russianAcceptance.includes('после текущих результатов предшествующего объявленного гейта и владельца для того же объекта проверки.')
    && russianStepCommand.includes('первому гейту чтения диффа предшествующий результат не нужен; следующим нужен текущий результат предшествующего объявленного гейта для того же объекта проверки, а гейту записи — также результат владельца'),
  'Current entry prose must describe the six-tool, guard-only, root-role and packed-file contracts');

const cli = read('docs/reference/03-cli.md');
const orchestrate = read('skills/orchestrate/SKILL.md');
const soloReview = read('skills/solo-review/SKILL.md');
const cliWakeRecipe = section(cli, '**Re-proving it costs one lift and one message.**', '**Nothing runs `claude` with a bare word.**');
const englishWorkspace = section(english, '### 1. Declare the workspace', '### 2. Give the orchestrator the MCP server');
const russianWorkspace = section(russian, '### 1. Объявить рабочее место', '### 2. Дать оркестратору MCP-сервер');
const orchestrateHarness = starts(orchestrate, '`--harness` must be listed');
const soloClose = section(soloReview, '## Close', '## Not this skill');
const overviewEntry = section(overview, '## Entry points', '### Documentation in the package');
check('PB-293.1 CLI recipes state routed and task-selection conditions',
  cliWakeRecipe.includes('The measured orchestrator side used `promptobus mcp` driven over stdio')
    && cliWakeRecipe.includes('`promptobus send` is also a CLI command (`lib/cli.js`)')
    && englishWorkspace.includes('On a new `spawn` or `review` lift without that flag, an explicit or recorded strategy can select a harness when routing applies; without a strategy, the new lift uses the `claude` fallback.')
    && englishWorkspace.includes('A repeat `spawn` reuses its participant\'s recorded harness. A repeat `review` reuses the reviewer\'s recorded harness unless an allowed explicit harness rebind takes effect.')
    && russianWorkspace.includes('При новом подъёме `spawn` или `review` без этого флага явная или записанная стратегия может выбрать инструмент, если работает маршрутизация; без стратегии новый участник получает запасной `claude`.')
    && russianWorkspace.includes('Повторный `spawn` использует записанный инструмент участника. Повторный `review` использует записанный инструмент ревьюера, кроме разрешённой явной смены инструмента.')
    && orchestrateHarness.includes('For a new ordinary `spawn` or `review` without the flag, an explicit or recorded strategy can select a harness from that list.')
    && orchestrateHarness.includes('With no strategy, the new unrouted lift falls back to `claude`.')
    && orchestrateHarness.includes('A repeat `spawn` uses its participant\'s recorded harness; a repeat `review` uses the reviewer\'s recorded harness unless an allowed explicit harness rebind takes effect.')
    && soloClose.includes('Commands using `resolveTaskId` try an explicit `--task` or `PROMPTOBUS_TASK`, then the session binding, then the sole active task.')
    && soloClose.includes('A single leftover active task can therefore be selected without a flag; with several active tasks and no binding, the command asks for `--task`.')
    && soloClose.includes('`review <path>` has separate directory pickup')
    && overviewEntry.includes('Commands that call `resolveTaskId` try an explicit task, then the session binding, then the sole active task')
    && overviewEntry.includes('Without `--harness`, a new routed lift takes the selected harness, and a new lift with no strategy reaches the Claude Code fallback')
    && overviewEntry.includes('A repeat `spawn` uses its participant\'s recorded driver; a repeat `review` uses its reviewer\'s recorded driver unless an allowed explicit rebind takes effect'),
  'Send, harness fallback and task selection must retain their actual conditions');

const host = read('docs/reference/02-host.md');
const hostWritable = section(host, '## The writable layer', '## Harness state homes');
const hostWriterContract = section(host, '### The layer the tool writes', '### `harnessStateHome`');
const hostPaths = section(host, '### `HostRoutingPaths` — where model routing keeps its files', '### The binary version a host read');
check('PB-300 host routing paths and writable behavior agree',
  hostPaths.includes('The cache and `user` overlay are account-scoped:')
    && hostPaths.includes('They do not derive from\n`promptobusHome()`, the task store of one workspace.')
    && hostPaths.includes('the `workspace` overlay is per-workspace and lives at\n`<promptobusHome>/model-routing.json`; it is the writable layer, independent\nof the account paths')
    && hostWriterContract.includes('The writable flag names the layer that `models strategy --set` and `--clear` write.')
    && hostWriterContract.includes('`--set` records `defaults.strategy`; `--clear` removes just that key and does\nnot create a file when there is nothing to clear.')
    && hostWriterContract.includes('Both preserve other keys in\nthe writable document. A changed file is written atomically with mode `0600`.')
    && hostWriterContract.includes('Exactly one layer carries it whenever any layer is declared; `readLayers`\nrefuses zero and refuses two')
    && hostWriterContract.includes('If a layer above the writable\none already names `defaults.strategy`, a successful `--set` prints\n`what was just written is shadowed`')
    && hostWritable.includes('The standalone `workspace` layer lives at `<promptobusHome>/model-routing.json`: `models strategy --set` writes its default there and `--clear` removes that key')
    && hostWritable.includes('The cache and the `user` overlay are untouched by this and stay account-scoped')
    && ![hostPaths, hostWriterContract, hostWritable].some((doc) => /PB-32 adds|the writer PB-32 adds|Both are ACCOUNT-scoped/.test(doc)),
  'HostRoutingPaths must distinguish scopes and describe the current writer');
