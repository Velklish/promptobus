import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('installed instruction delivery is a complete SDK configuration with explicit authenticated tool selection', () => {
  const stand = mkdtempSync(path.join(tmpdir(), 'promptobus-bb-instruction-types-'));
  const installed = name => fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)).replaceAll('\\', '/');
  const file = path.join(stand, 'check.mts');
  try {
    writeFileSync(file, `import { createBbInstructionDelivery } from ${JSON.stringify(installed('promptobus/lib/instructions.js'))};
import type { PluginAgentConfiguration } from ${JSON.stringify(installed('@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts'))};
const delivery = createBbInstructionDelivery('approver', { taskId:'task', address:'approver:bb', environmentId:'env', workspace:'/owned', assignment:'accept', tools:{promptobus_send:'send'}, workerAddress:'worker:bb', allowDirectWorkerMessages:true });
const denied: PluginAgentConfiguration = delivery.configuration;
const authenticatedToolSelection: string[] = ['send'];
const selected: PluginAgentConfiguration = { ...delivery.configuration, tools: authenticatedToolSelection };
`);
    const result = spawnSync(process.execPath, [installed('typescript/lib/tsc.js'), '--noEmit', '--strict', '--skipLibCheck',
      '--target', 'es2023', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--types', 'node',
      '--typeRoots', installed('@types'), file], { cwd:stand, encoding:'utf8', timeout:60000 });
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  } finally { rmSync(stand, { recursive:true, force:true }); }
});
