interface Piece {
    slug: string;
    step: string | null;
}
export declare function buildDigest(rootOrHost: unknown, { task, now }?: {
    task?: string;
    now?: number;
}): {
    schemaVersion: number;
    generatedAt: string;
    tasks: {
        id: string;
        title: string;
        status: "active" | "done";
        depth: number;
        parent?: string | undefined;
        pipeline: string[];
        participants: {
            address: string;
            unread: number;
            lastStatus: {
                firstLine: string | undefined;
                at: string;
                ageSeconds: number | null;
            } | null;
            stall: {
                reason: string;
                at: string | null;
            } | null;
            silent: {
                since: {} | null;
                escalatedAt: {};
            } | null;
            unanswered: {
                since: string;
            } | null;
        }[];
        questions: {
            id: string;
            state: string;
            originTask?: string | undefined;
            from: string | null;
            to: string | null;
            at: string;
            ageSeconds: number | null;
            body: string;
        }[];
        pieces: Piece[];
    }[];
};
export declare function digest(rootOrHost: unknown, { task, json, now }?: {
    task?: string;
    json?: boolean;
    now?: number;
}): {
    schemaVersion: number;
    generatedAt: string;
    tasks: {
        id: string;
        title: string;
        status: "active" | "done";
        depth: number;
        parent?: string | undefined;
        pipeline: string[];
        participants: {
            address: string;
            unread: number;
            lastStatus: {
                firstLine: string | undefined;
                at: string;
                ageSeconds: number | null;
            } | null;
            stall: {
                reason: string;
                at: string | null;
            } | null;
            silent: {
                since: {} | null;
                escalatedAt: {};
            } | null;
            unanswered: {
                since: string;
            } | null;
        }[];
        questions: {
            id: string;
            state: string;
            originTask?: string | undefined;
            from: string | null;
            to: string | null;
            at: string;
            ageSeconds: number | null;
            body: string;
        }[];
        pieces: Piece[];
    }[];
};
export {};
