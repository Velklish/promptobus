// `./host` entry point: contract and standalone implementation in one import.
export {
  HOST_KIND, HostResolveError, homeOfRoot, isPromptobusHost,
} from './host.js';
export type {
  HostFreshness, HostLegacyLayout, HostModuleNote, HostRepo, HostRepoCandidate, HostRepoModule,
  HostRoutingOverlay, HostRoutingPaths, HostServers, HostToolBin, PromptobusHost,
} from './host.js';
export { HOST_CONFIG, createStandaloneHost } from './standalone.js';
export type { StandaloneHostOptions } from './standalone.js';
