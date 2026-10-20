// `./host` entry point: contract and standalone implementation in one import.
export {
  HOST_KIND, HostResolveError, homeOfRoot, isPromptobusHost,
} from './host.js';
export type {
  HostClone, HostFreshness, HostModuleNote, HostRepo, HostRepoCandidate,
  HostMcpTool, HostMcpToolClassification, HostPipelineStep, HostRepoModule, HostRoutingOverlay, HostRoutingPaths, HostServers, HostToolBin, PromptobusHost,
  HostParticipantContextPurpose, HostParticipantContextTask, HostParticipantContextRequest, HostParticipantContextSelection,
} from './host.js';
export { HOST_CONFIG, createStandaloneHost } from './standalone.js';
export type { StandaloneHostOptions } from './standalone.js';

export { withDirLock } from './fs/lock.js';
export { writeFileAtomic } from './fs/atomic.js';
