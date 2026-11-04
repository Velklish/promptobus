import type { BbPluginApi } from '@get-bb/plugin-sdk';
import type { BuildIdentity } from './build-identity.js';

type Plugins = Awaited<ReturnType<BbPluginApi['sdk']['plugins']['list']>>['plugins'];
type Source = Awaited<ReturnType<BbPluginApi['sdk']['plugins']['getSource']>>;
export function inspectInstallation(plugins: Plugins, sources: Record<string, Source>, identity: BuildIdentity | null) {
  const sdk = identity?.inputs.dependencies.find(dependency => dependency.name === '@get-bb/plugin-sdk')?.version;
  const components = ['promptobus', 'promptobus-native-panel'].map(id => {
    const plugin = plugins.find(plugin => plugin.id === id), source = sources[id], issues: string[] = [];
    if (!plugin) issues.push('not-installed');
    else {
      if (plugin.status !== 'running') issues.push(`status:${plugin.status}`);
      if (plugin.version !== identity?.pluginVersion) issues.push('release-version-mismatch');
      if (!source?.requested.startsWith('git:') || !source.range || !source.resolvedTag) issues.push('release-tracking-source-required');
      if (source && source.resolvedTag !== `bb/v${plugin.version}`) issues.push('release-tag-mismatch');
      if (/\.claude[\\/]worktrees|[\\/](?:sandbox|tmp|var[\\/]folders)[\\/]/.test(source?.requested ?? plugin.rootDir)) issues.push('disposable-install-source');
      if (!sdk || source?.engines.bbPluginSdk !== sdk || (plugin.app.bundle && plugin.app.bundle.sdkVersion !== sdk)) issues.push('sdk-version-mismatch');
    }
    return { id, version: plugin?.version ?? null, source: source?.requested ?? null,
      resolved: source?.resolved ?? null, tag: source?.resolvedTag ?? null, issues };
  });
  return { status: identity && components.every(component => component.issues.length === 0) ? 'complete' : 'incomplete',
    buildId: identity?.buildId ?? null, coreVersion: identity?.inputs.dependencies.find(dependency => dependency.name === 'promptobus')?.version ?? null,
    sdkVersion: sdk ?? null, components };
}
