import { check } from './check.mjs';
import { codexStandaloneNewExec } from '../lib/standalone-root-state.js';

const cwd = '/private/tmp/owned-fixture', store = '/private/tmp/owned-fixture-store';
const prompt = 'Call exactly one mcp__promptobus__promptobus_status tool, with empty arguments.';
const hooks = `hooks.state={"${store}/hooks.json:post_tool_use:0:0"={enabled=false},"${store}/hooks.json:stop:0:0"={enabled=false},`
  + '"warp@codex-warp:hooks/hooks.json:session_start:0:0"={enabled=false}}';
const controls = ['--strict-config', '--ignore-user-config', '--dangerously-bypass-hook-trust', '--skip-git-repo-check',
  '--sandbox', 'read-only', '--json', '--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"',
  '-c', `projects={"${cwd}"={trust_level="trusted"}}`, '-c', hooks,
  '-c', 'mcp_servers.promptobus.tools={promptobus_status={approval_mode="approve"}}',
  '-c', 'mcp_servers.promptobus.enabled_tools=["promptobus_status"]'];
const approved = ['exec', ...controls, prompt];

check('the approved 21-argument control invocation is a Codex NEW exec', approved.length === 21 && codexStandaloneNewExec(approved, cwd));
check('the same controls with an explicit prompt separator are NEW', codexStandaloneNewExec(['exec', ...controls, '--', prompt], cwd));
check('the bare exec -- prompt form stays NEW', codexStandaloneNewExec(['exec', '--', prompt], cwd));
for (const name of ['resume', 'help', 'Resume']) {
  check(`a prompt ${name} after the separator is a prompt, not a subcommand`, codexStandaloneNewExec(['exec', '--', name], cwd));
}

const replace = (from, to) => approved.map(arg => arg === from ? to : arg);
const without = (...drop) => approved.filter((_, index) => !drop.includes(index));
const refused = {
  'no prompt': ['exec', ...controls],
  'stdin prompt': ['exec', ...controls, '-'],
  'empty prompt after separator': ['exec', ...controls, '--', ''],
  'two prompt tokens after separator': ['exec', '--', prompt, 'extra'],
  'option-like prompt': ['exec', ...controls, '--last'],
  'resume subcommand': ['exec', 'resume', '--last'],
  'fork subcommand': ['exec', 'fork', '0199a213-81c0-7800-8aa1-bbab2a035a53', prompt],
  'review subcommand as prompt': ['exec', ...controls, 'review'],
  'help subcommand as prompt': ['exec', ...controls, 'help'],
  'not exec': ['--no-daemon', ...controls, prompt],
  'unknown flag': ['exec', '--ephemeral', prompt],
  'thread source selector': ['exec', '--thread-source', 'exec', prompt],
  'duplicated boolean flag': ['exec', '--json', '--json', prompt],
  'duplicated model': ['exec', '--model', 'a', '--model', 'b', prompt],
  'joined sandbox value': ['exec', '--sandbox=read-only', prompt],
  'short sandbox alias': ['exec', '-s', 'read-only', prompt],
  'writable sandbox': replace('read-only', 'workspace-write'),
  'option-like model value': replace('gpt-6.1-sol', '--json'),
  'missing config value': ['exec', prompt, '-c'],
  'config without key': ['exec', '-c', '=x', prompt],
  'duplicated config key': ['exec', '-c', 'model_reasoning_effort="low"', '-c', 'model_reasoning_effort="high"', prompt],
  'unknown config key': ['exec', '-c', 'model="o3"', prompt],
  'unknown effort': replace('model_reasoning_effort="xhigh"', 'model_reasoning_effort="custom"'),
  'unquoted effort': replace('model_reasoning_effort="xhigh"', 'model_reasoning_effort=xhigh'),
  'trusted project other than cwd': replace(`projects={"${cwd}"={trust_level="trusted"}}`, 'projects={"/"={trust_level="trusted"}}'),
  'two trusted projects': replace(`projects={"${cwd}"={trust_level="trusted"}}`,
    `projects={"${cwd}"={trust_level="trusted"},"/tmp"={trust_level="trusted"}}`),
  'project with other trust fields': replace(`projects={"${cwd}"={trust_level="trusted"}}`, `projects={"${cwd}"={trust_level="untrusted"}}`),
  'hook enabled through state': replace(hooks, hooks.replace('stop:0:0"={enabled=false}', 'stop:0:0"={enabled=true}')),
  'hook state with trust hash': replace(hooks, hooks.replace('stop:0:0"={enabled=false}', 'stop:0:0"={enabled=false,trusted_hash="x"}')),
  'duplicated hook state key': replace(hooks, hooks.replace('stop:0:0', 'post_tool_use:0:0')),
  'hook state key with escape': replace(hooks, hooks.replace('stop:0:0', 'stop\\":0:0')),
  'approval outside exposed tools': replace('mcp_servers.promptobus.tools={promptobus_status={approval_mode="approve"}}',
    'mcp_servers.promptobus.tools={promptobus_send={approval_mode="approve"}}'),
  'approval without exposure list': without(18, 19),
  'other approval mode': replace('mcp_servers.promptobus.tools={promptobus_status={approval_mode="approve"}}',
    'mcp_servers.promptobus.tools={promptobus_status={approval_mode="auto"}}'),
  'foreign server tool exposure': replace('mcp_servers.promptobus.enabled_tools=["promptobus_status"]', 'mcp_servers.promptobus.enabled_tools=["shell"]'),
  'duplicated exposed tool': replace('mcp_servers.promptobus.enabled_tools=["promptobus_status"]',
    'mcp_servers.promptobus.enabled_tools=["promptobus_status","promptobus_status"]'),
  'joined model value': ['exec', '--model=x', prompt],
  'joined boolean value': ['exec', '--json=true', prompt],
  'long config alias': ['exec', '--config', 'model_reasoning_effort="xhigh"', prompt],
  'short model alias': ['exec', '-m', 'x', prompt],
  'sandbox without value': ['exec', prompt, '--sandbox'],
  'model without value': ['exec', prompt, '--model'],
  'duplicated sandbox': ['exec', '--sandbox', 'read-only', '--sandbox', 'read-only', prompt],
  'uppercase exposed tool': replace('mcp_servers.promptobus.enabled_tools=["promptobus_status"]', 'mcp_servers.promptobus.enabled_tools=["promptobus_Status"]'),
  'newline in config value': replace('model_reasoning_effort="xhigh"', 'model_reasoning_effort="xhigh"\n'),
  'whitespace around config key': replace('model_reasoning_effort="xhigh"', ' model_reasoning_effort="xhigh"'),
  'whitespace around config value': replace('model_reasoning_effort="xhigh"', 'model_reasoning_effort= "xhigh"'),
  'empty hook state table': replace(hooks, 'hooks.state={}'),
  'empty hook state key': replace(hooks, 'hooks.state={""={enabled=false}}'),
  'flags after the separator': ['exec', '--', '--json', prompt],
  'other server tool policy': replace('mcp_servers.promptobus.tools={promptobus_status={approval_mode="approve"}}',
    'mcp_servers.other.tools={promptobus_status={approval_mode="approve"}}'),
};
for (const [name, args] of Object.entries(refused)) {
  check(`Codex NEW exec refuses ${name}`, !codexStandaloneNewExec(args, cwd), JSON.stringify(args));
}
