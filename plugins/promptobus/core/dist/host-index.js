// `./host` entry point: contract and standalone implementation in one import.
export { HOST_KIND, HostResolveError, homeOfRoot, isPromptobusHost, } from './host.js';
export { HOST_CONFIG, createStandaloneHost } from './standalone.js';
export { withDirLock } from './fs/lock.js';
export { writeFileAtomic } from './fs/atomic.js';
