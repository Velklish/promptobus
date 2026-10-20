import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { REVIEWER } from 'promptobus';
import { executionSchema } from './protocol.js';
import type { Binding, ExecutionSelection } from './protocol.js';

export const REVIEWER_PROVIDER = 'promptobus-codex-reviewer';
export const SUPPORTED_PROVIDERS = executionSchema.shape.providerId.options;
type Request = { model: string; provider?: string; reasoningLevel?: ExecutionSelection['reasoningLevel'] };

function providerFor(role: Binding['role'], requested?: string): ExecutionSelection['providerId'] {
  const required = role === REVIEWER ? REVIEWER_PROVIDER : 'codex';
  const allowed: ExecutionSelection['providerId'][] = role === 'worker' ? ['codex', 'acp-cursor', 'acp-opencode']
    : role === 'approver' ? ['codex', 'acp-cursor'] : [required];
  const provider = requested ?? required;
  if (!allowed.some(id => id === provider)) throw new Error(`Role ${role} requires provider ${allowed.join(' or ')}`);
  return provider as ExecutionSelection['providerId'];
}

export async function selectBbExecution(bb: BbPluginApi, b: Pick<Binding, 'role' | 'hostId' | 'environmentId' | 'environmentOwner'>,
  request: Request, signal?: AbortSignal): Promise<ExecutionSelection> {
  const required = providerFor(b.role, request.provider);
  const host = await bb.sdk.hosts.get({ hostId: b.hostId, signal });
  if (host.id !== b.hostId || host.status !== 'connected' || host.lifecycle.phase !== 'active') throw new Error('BB execution host is unavailable');
  if (b.environmentOwner !== 'bb') {
    const environment = await bb.sdk.environments.get({ environmentId: b.environmentId, signal });
    if (environment.id !== b.environmentId || environment.hostId !== b.hostId
      || environment.status !== 'ready' || environment.lifecycle.phase !== 'active') throw new Error('BB execution environment is unavailable');
  }
  const scope = b.environmentOwner === 'bb' ? { hostId: b.hostId } : { environmentId: b.environmentId };
  const provider = (await bb.sdk.providers.list({ ...scope, signal })).find(p => p.id === required);
  const family = required.startsWith('acp-') ? 'acp' : 'codex';
  if (!provider?.available || (provider.family && provider.family !== family)) throw new Error(`BB provider ${required} is unavailable`);
  if (!provider.capabilities.permissionModes.includes('accept-edits')) throw new Error(`BB provider ${required} does not support accept-edits`);
  if (b.environmentOwner === 'bb' && provider.capabilities.modelCatalogScope !== 'host') {
    throw new Error('A new BB environment requires a host-scoped model catalog');
  }
  const catalog = await bb.sdk.providers.models({ ...scope, providerId: required, signal });
  if (catalog.modelLoadError) throw new Error(`BB provider ${required} model availability is unknown: ${catalog.modelLoadError.code}`);
  const model = catalog.models.find(m => m.id === request.model || m.model === request.model);
  if (!model || (model.routeProviderId && model.routeProviderId !== required)) throw new Error(`Model ${request.model} is unavailable on provider ${required}`);
  const reasoningLevel = request.reasoningLevel ?? model.defaultReasoningEffort;
  if (!model.supportedReasoningEfforts.some(r => r.reasoningEffort === reasoningLevel)) throw new Error(`Model ${request.model} does not support reasoning level ${reasoningLevel}`);
  let health: ExecutionSelection['health'] = 'unknown';
  if (provider.maintenance.health) {
    let state: string | undefined;
    try {
      state = (await bb.sdk.system.providerStates({ ...scope, signal })).providers.find(p => p.providerId === required)?.status;
    } catch {
      signal?.throwIfAborted();
    }
    if (state && state !== 'ready' && state !== 'unknown') throw new Error(`BB provider ${required} is ${state}`);
    health = state === 'ready' ? 'ready' : 'unknown';
  }
  let quota: ExecutionSelection['quota'] = { status: 'unknown', reason: 'Provider usage is not exposed', windows: [] };
  if (provider.maintenance.usage) {
    try {
      const usage = (await bb.sdk.system.usageLimits({ hostId: b.hostId, providerId: required, signal }))[required];
      quota = usage?.status === 'ok' && usage.windows.length
        ? { status: 'known', reason: null, windows: usage.windows.map(({ label, usedPercent, resetsAt }) => ({ label, usedPercent, resetsAt })) }
        : { status: 'unknown', reason: usage?.status ?? 'No provider usage response', windows: [] };
      if (usage?.status === 'ok' && !usage.windows.length) quota.reason = 'No account windows reported';
    } catch {
      signal?.throwIfAborted();
      quota = { status: 'unknown', reason: 'Provider usage request failed', windows: [] };
    }
  }
  signal?.throwIfAborted();
  const harness = required === 'acp-cursor' ? 'cursor' : required === 'acp-opencode' ? 'opencode' : 'codex';
  return executionSchema.parse({ runtime: 'bb', harness, providerId: required,
    providerSource: request.provider ? 'explicit' : 'role', requestedModel: request.model, model: model.id, nativeModel: model.model,
    reasoningLevel, reasoningSource: request.reasoningLevel ? 'explicit' : 'catalog', health, quota,
    observedAt: new Date().toISOString(), scope: { hostId: b.hostId, environmentId: 'environmentId' in scope ? scope.environmentId : null } });
}
