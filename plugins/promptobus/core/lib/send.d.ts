interface CommandContext {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
}
export declare function send(rootOrHost: unknown, { task, to, type, body, file, artifact }?: {
    task?: string | null;
    to?: string;
    type?: string;
    body?: string;
    file?: string;
    artifact?: string;
}, { env, cwd }?: CommandContext): Promise<number>;
export declare function humanTerminalIdentity(rootOrHost: unknown, task: string, { env, cwd }?: CommandContext, command?: string): {
    role: string;
    hint: string | null;
    home: string;
    declaredTask: string | null;
    session: string | null;
    why: string | null;
};
export declare function ask(rootOrHost: unknown, { task, to, body, answers }?: {
    task?: string;
    to?: string;
    body?: string;
    answers?: boolean;
}, { env, cwd }?: CommandContext): Promise<number>;
export {};
