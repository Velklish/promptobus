import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
export { extractNodeTestVerdictNames } from './bb-evidence-verdict-names.js';
export { underLease, leaseRoot, keyedCommandPlan } from './lease.js';
export { assertBbDirectCommand, recordBbDirectCommand } from './bb-direct-command.js';
import path from 'node:path';
import { reviewerFiles } from './reviewer-files.js';
import { hostDenyClassification, requireStepResults } from './review.js';
import { registryOf, roleEntry, REVIEWER } from '../dist/index.js';
import { DEFAULT_PIPELINE, pipelineOf, pipelineSteps } from '../dist/pipeline.js';

const readText = file => {
  const canonical = realpathSync(file);
  if (!statSync(canonical).isFile() || statSync(canonical).size > 256 * 1024) throw new Error('Host context requires a text file of at most 256 KiB');
  const bytes = readFileSync(canonical);
  if (bytes.includes(0)) throw new Error('Host context cannot contain binary files');
  return { path: canonical, text: bytes.toString('utf8') };
};

export function renderBbHostContext(context) {
  return ['Host rules below are ordered highest priority first. Earlier rules win on conflict.',
    ...context.rules.map(rule => `Host rule ${rule.path}:\n${rule.text}`),
    ...context.skills.map(skill => `Canonical Host skill ${skill.name} (${skill.path}):\n${skill.text}`),
    'Read additional declared rule/skill resources with promptobus_host_context. Call canonical tools through promptobus_host_call.',
    `Admitted canonical tools: ${JSON.stringify(context.tools)}`].join('\n\n');
}

function selectedResources(host, { root, role, task, preparedContext }) {
  if (!task || typeof task.id !== 'string' || !task.id.trim() || !['technical', 'user-facing', 'author-voice'].includes(task.purpose)) {
    throw new Error('Selected Host context requires an explicit task identity and purpose');
  }
  const prepared = preparedContext?.selection;
  if (preparedContext && (!prepared || prepared.task.id !== task.id || prepared.task.purpose !== task.purpose)) {
    throw new Error('Host context task selection changed; prepare context again');
  }
  const selected = host.selectParticipantContext({ repoDir: root, role, task: { id: task.id, purpose: task.purpose } });
  if (!selected || !Array.isArray(selected.rules) || !Array.isArray(selected.skills)) throw new Error('Host context selection requires rules and skills arrays');
  const validPath = file => typeof file === 'string' && path.isAbsolute(file);
  const validReason = reason => typeof reason === 'string' && reason.trim();
  for (const rule of selected.rules) {
    if (!validPath(rule.path) || !validReason(rule.reason) || !Array.isArray(rule.requires ?? []) || (rule.requires ?? []).some(file => !validPath(file))) {
      throw new Error('Selected Host rules require absolute paths, a reason and exact required paths');
    }
  }
  const requiredBy = file => selected.rules.find(rule => rule.requires?.some(required => path.resolve(required) === path.resolve(file)))?.path;
  const unavailable = (file, failure, parent = requiredBy(file)) => new Error(`${parent ? `Required Host rule ${parent} -> ${file}` : `Selected Host resource ${file}`} unavailable: ${failure.message}`);
  const canonical = (file, parent) => {
    try { return realpathSync(file); } catch (failure) { throw unavailable(file, failure, parent); }
  };
  const ruleMap = new Map();
  for (const rule of selected.rules) {
    const file = canonical(rule.path), requires = (rule.requires ?? []).map(required => canonical(required, file));
    const prior = ruleMap.get(file);
    if (prior) prior.requires = [...new Set([...prior.requires, ...requires])];
    else ruleMap.set(file, { path: file, reason: rule.reason, requires: [...new Set(requires)] });
  }
  for (const rule of ruleMap.values()) for (const dependency of rule.requires) {
    if (!ruleMap.has(dependency)) throw new Error(`Required Host rule ${rule.path} -> ${dependency} is missing from selected rules; select the full closure and prepare context again`);
  }
  const skillMap = new Map();
  const addSkill = skill => {
    if (!skill || typeof skill.name !== 'string' || !skill.name.trim() || !validPath(skill.root) || !validReason(skill.reason)) {
      throw new Error('Selected Host skills require a name, an absolute root and a reason');
    }
    const directory = canonical(skill.root);
    if (!statSync(directory).isDirectory()) throw new Error(`Selected Host skill root is not a directory: ${directory}`);
    const key = JSON.stringify([skill.name, directory]);
    if (!skillMap.has(key)) skillMap.set(key, { name: skill.name, root: directory, reason: skill.reason });
  };
  selected.skills.forEach(addSkill);
  const module = host.resolveRepoModule(root), reviewSkill = role === REVIEWER && module?.meta?.review?.skill;
  if (reviewSkill) addSkill({ name: reviewSkill, root: host.reviewSkillDir(reviewSkill, root), reason: 'Required module review skill' });
  const selection = { task: { id: task.id, purpose: task.purpose }, rules: [...ruleMap.values()], skills: [...skillMap.values()] };
  if (prepared) {
    for (const rule of selection.rules) {
      if (!prepared.rules.some(prior => prior.path === rule.path)) throw new Error(`Host context selection expanded to ${rule.path}; prepare context again`);
    }
    for (const skill of selection.skills) {
      if (!prepared.skills.some(prior => prior.name === skill.name && prior.root === skill.root)) throw new Error(`Host context selection expanded to skill ${skill.root}; prepare context again`);
    }
  }
  const rules = selection.rules.map(rule => {
    try { return readText(rule.path); } catch (failure) { throw unavailable(rule.path, failure); }
  });
  const skills = selection.skills.map(skill => {
    const file = canonical(path.join(skill.root, 'SKILL.md'));
    const relative = path.relative(skill.root, file);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Selected Host skill instructions escape their root: ${file}`);
    return { name: skill.name, ...readText(file), root: skill.root };
  });
  return { rules, skills, selection };
}

export function createBbHostIntegration({ resolveHost, listTools, invokeTool, prepareEnvironment } = {}) {
  if (typeof resolveHost !== 'function') throw new Error('A consumer-owned Host resolver is required');
  const gather = async input => {
    const { root, role, signal, preparedContext } = input;
    signal?.throwIfAborted();
    const host = await resolveHost(root);
    if (preparedContext?.selection && typeof host.selectParticipantContext !== 'function') throw new Error('Host context selector disappeared; prepare context again');
    let rules, skills, selection;
    const resourceRoots = [];
    if (typeof host.selectParticipantContext === 'function') {
      ({ rules, skills, selection } = selectedResources(host, input));
    } else {
      rules = [...new Set(host.collectRules(root))].map(readText);
      skills = [];
      const source = host.skillsDir(root);
      if (source) for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isSymbolicLink()) throw new Error(`BB Host context refuses symlink skill entries: ${entry.name}`);
        if (!entry.isDirectory()) continue;
        if (entry.name === '_shared') {
          resourceRoots.push(realpathSync(path.join(source, entry.name)));
          continue;
        }
        const skill = readText(path.join(source, entry.name, 'SKILL.md'));
        skills.push({ name: entry.name, ...skill, root: realpathSync(path.join(source, entry.name)) });
      }
      const module = host.resolveRepoModule(root);
      const reviewSkill = role === REVIEWER && module?.meta?.review?.skill;
      if (reviewSkill && !skills.some(skill => skill.name === reviewSkill)) {
        const directory = host.reviewSkillDir(reviewSkill, root);
        skills.push({ name: reviewSkill, ...readText(path.join(directory, 'SKILL.md')), root: realpathSync(directory) });
      }
    }
    const { servers, external } = host.participantServers(root);
    if (external.length) throw new Error('Host canonical server delivery is incomplete');
    const names = Object.keys(servers);
    if (names.length && (typeof listTools !== 'function' || typeof invokeTool !== 'function')) throw new Error('A consumer-owned canonical tool adapter is required');
    const tools = (await Promise.all(names.map(async server => {
      const catalog = await listTools({ server, configuration: servers[server], root, signal });
      return catalog.map(tool => {
        if (!tool.name || !['read', 'write'].includes(tool.access)) throw new Error('Canonical tools require explicit read/write access classification');
        return { server, tool: tool.name, description: tool.description, inputSchema: tool.inputSchema, access: tool.access };
      });
    }))).flat();
    const constrained = role === REVIEWER || role === 'reporter';
    const denied = constrained ? hostDenyClassification(host, roleEntry(registryOf(host), role === 'reporter' ? REVIEWER : role), names, root) : null;
    if (denied && !denied.complete) throw new Error('Host canonical write-tool classification is incomplete');
    const isDenied = tool => denied?.tools.some(write => write.server === tool.server && write.tool === tool.tool);
    if (constrained && tools.some(tool => tool.access === 'write' && !isDenied(tool))) throw new Error('Host canonical write-tool classification omits a declared write');
    const context = { rules, skills, tools: tools.filter(tool => !isDenied(tool) && (!selection || !preparedContext || preparedContext.tools.some(prior =>
      prior.server === tool.server && prior.tool === tool.tool && (prior.access === 'write' || tool.access === 'read')))), ...(selection ? { selection } : {}) };
    if (Buffer.byteLength(JSON.stringify(context)) > 1024 * 1024) throw new Error('Host context exceeds 1 MiB');
    signal?.throwIfAborted();
    return { context, servers, resourceRoots };
  };
  return {
    async checkStep(input) {
      input.signal?.throwIfAborted();
      const host = await resolveHost(input.repoDir);
      const steps = pipelineOf(host), supported = pipelineSteps(DEFAULT_PIPELINE);
      if (steps.length !== supported.length || steps.some((step, index) => step.name !== supported[index].name || step.kind !== supported[index].kind)) {
        throw new Error('BB requires the shipped worker/reviewer/approver pipeline');
      }
      requireStepResults(host, input);
      input.signal?.throwIfAborted();
    },
    async prepare(input) { input.signal?.throwIfAborted(); await prepareEnvironment?.(input); return (await gather({ ...input, preparedContext: undefined })).context; },
    async collect(input) { return (await gather(input)).context; },
    async read(input) {
      const { context, resourceRoots } = await gather(input);
      const roots = [...context.rules.map(rule => rule.path), ...context.skills.map(skill => skill.root), ...resourceRoots];
      if (!roots.length) throw new Error('No Host context resources are declared');
      return reviewerFiles(roots, context.rules.map(rule => rule.path))('read_file', {
        path: input.path, start_line: input.start_line, line_count: input.line_count,
      });
    },
    async invoke(input) {
      const { context, servers } = await gather(input);
      if (!context.tools.some(tool => tool.server === input.server && tool.tool === input.tool)) throw new Error('Canonical tool is not admitted for this participant');
      input.signal?.throwIfAborted();
      return invokeTool({ server: input.server, configuration: servers[input.server], tool: input.tool, args: input.args,
        root: input.root, role: input.role, actor: input.actor, signal: input.signal });
    },
  };
}
