import type { LibRegistry } from './driver-runtime.js';
export declare function stop(rootOrHost: unknown, { task, address }?: {
    task?: string | null;
    address?: string;
}, { registry }?: {
    registry?: LibRegistry;
}): Promise<0 | 1>;
