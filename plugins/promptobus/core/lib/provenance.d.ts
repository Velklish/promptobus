interface Provenance {
    mechanismPath?: string | null;
    mechanismPathIssue?: string | null;
    mechanismVersion?: string | null;
    packagePath?: string | null;
    packageVersion?: string | null;
    packageIssue?: string | null;
    hostVersion?: string | null;
    binaryPath?: string | null;
    binaryVersion?: string | null;
}
interface ProvenanceHost {
    binPath?: () => unknown;
    version?: unknown;
}
interface ProvenanceTool {
    bin?: unknown;
    version?: unknown;
}
export declare function launchProvenance(host: ProvenanceHost | null | undefined, tool?: ProvenanceTool | null): Provenance;
export declare function provenanceLine(provenance?: Provenance): string;
export declare function provenanceFromRecord(record?: Provenance & {
    bin?: string | null;
}): Provenance;
export {};
