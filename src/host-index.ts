// Entry point `./host`: контракт и standalone-реализация одним импортом.
export {
  HOST_KIND, HostResolveError, homeOfRoot, isPromptobusHost,
} from './host.js';
export type {
  HostFreshness, HostModuleNote, HostRepo, HostRepoCandidate, HostRepoModule,
  HostServers, HostToolBin, PromptobusHost,
} from './host.js';
export { HOST_CONFIG, createStandaloneHost } from './standalone.js';
export type { StandaloneHostOptions } from './standalone.js';
