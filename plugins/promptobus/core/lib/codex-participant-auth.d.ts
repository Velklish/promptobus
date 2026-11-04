/** A participant consumes subscription access credentials but never rotates the owner's refresh
 * token. [05-drivers.md](../docs/reference/05-drivers.md#codex-participant-authentication) */
export declare function participantAuthSnapshot(source: string, ownerHome: string, now?: number): string;
export declare function createParticipantAuthGuard({ ownerHome, participantHome }: {
    ownerHome: string;
    participantHome: string;
}): ({ busy }?: {
    busy?: boolean;
}) => Promise<void>;
