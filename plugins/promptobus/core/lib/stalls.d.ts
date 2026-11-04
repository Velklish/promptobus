import type { StalledParticipant } from '../dist/index.js';
type Stall = Pick<StalledParticipant, 'reset' | 'kind' | 'reason' | 'address' | 'id' | 'ref'>;
/** The state word of a stall: a refusal with a named reset still ahead is unreachable until then. */
export declare function stallWord(s: Pick<Stall, 'reset'>): string;
/** Line about a stalled participant. `route` is what to do, in that harness's words. */
export declare function stallLine(s: Stall, route: string): string;
export declare function stallTail(stalled: Pick<Stall, 'kind'>[]): string;
export {};
