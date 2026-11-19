// `./host` entry point: contract and standalone implementation in one import.
export {
  HOST_KIND, HostResolveError, homeOfRoot, isPromptobusHost, PARTICIPANT_MCP_POLICY_VERSION,
} from './host.js';
export type {
  HostClone, HostFreshness, HostModuleNote, HostRepo, HostRepoCandidate,
  HostMcpAudience, HostMcpTool, HostMcpToolClassification, HostPipelineStep, HostRepoModule, HostRoutingOverlay, HostRoutingPaths, HostServers, HostToolBin, PromptobusHost,
  HostParticipantContextPurpose, HostParticipantContextTask, HostParticipantContextRequest, HostParticipantContextSelection,
  HostContextRef, HostTaskContextDeclaration, PreparedHostParticipantContextSelection,
} from './host.js';
export { HOST_CONFIG, createStandaloneHost } from './standalone.js';
export type { StandaloneHostOptions } from './standalone.js';

export { withDirLock } from './fs/lock.js';
export { writeFileAtomic } from './fs/atomic.js';
