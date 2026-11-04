import { createStandaloneHost } from '../dist/host-index.js';
export { HOST_KIND, HostResolveError, homeOfRoot, isPromptobusHost, } from '../dist/host.js';
export { createStandaloneHost } from '../dist/host-index.js';
export declare function hostOf(rootOrHost: unknown, options?: Parameters<typeof createStandaloneHost>[0]): import("../dist/host.js").PromptobusHost;
