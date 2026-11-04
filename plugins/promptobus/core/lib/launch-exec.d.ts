export interface RootExecCommand {
    file: string;
    args: readonly string[];
    env: Readonly<Record<string, string | null | undefined>>;
}
export declare function writeRootExecPlan(directory: string, command: RootExecCommand, generation?: `${string}-${string}-${string}-${string}-${string}`): string;
