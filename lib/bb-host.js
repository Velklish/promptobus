import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
export { extractNodeTestVerdictNames } from './bb-evidence-verdict-names.js';
export { assertBbDirectCommand } from './bb-direct-command.js';
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

export function createBbHostIntegration({ resolveHost, listTools, invokeTool, prepareEnvironment } = {}) {
  if (typeof resolveHost !== 'function') throw new Error('A consumer-owned Host resolver is required');
  const gather = async ({ root, role, signal }) => {
    signal?.throwIfAborted();
    const host = await resolveHost(root);
    const rules = [...new Set(host.collectRules(root))].map(readText);
    const skills = [];
    const source = host.skillsDir();
    if (source) for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`BB Host context refuses symlink skill entries: ${entry.name}`);
      if (!entry.isDirectory()) continue;
      const skill = readText(path.join(source, entry.name, 'SKILL.md'));
      skills.push({ name: entry.name, ...skill, root: realpathSync(path.join(source, entry.name)) });
    }
    const module = host.resolveRepoModule(root);
    const reviewSkill = role === REVIEWER && module?.meta?.review?.skill;
    if (reviewSkill && !skills.some(skill => skill.name === reviewSkill)) {
      const directory = host.reviewSkillDir(reviewSkill);
      skills.push({ name: reviewSkill, ...readText(path.join(directory, 'SKILL.md')), root: realpathSync(directory) });
    }
    const { servers, external } = host.participantServers();
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
    const denied = constrained ? hostDenyClassification(host, roleEntry(registryOf(host), role === 'reporter' ? REVIEWER : role), names) : null;
    if (denied && !denied.complete) throw new Error('Host canonical write-tool classification is incomplete');
    const isDenied = tool => denied?.tools.some(write => write.server === tool.server && write.tool === tool.tool);
    if (constrained && tools.some(tool => tool.access === 'write' && !isDenied(tool))) throw new Error('Host canonical write-tool classification omits a declared write');
    const context = { rules, skills, tools: tools.filter(tool => !isDenied(tool)) };
    if (Buffer.byteLength(JSON.stringify(context)) > 1024 * 1024) throw new Error('Host context exceeds 1 MiB');
    signal?.throwIfAborted();
    return { context, servers };
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
    async prepare(input) { input.signal?.throwIfAborted(); await prepareEnvironment?.(input); return (await gather(input)).context; },
    async collect(input) { return (await gather(input)).context; },
    async read(input) {
      const { context } = await gather(input);
      const roots = [...context.rules.map(rule => rule.path), ...context.skills.map(skill => skill.root)];
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
