import { promises as fs } from 'fs';
import * as path from 'path';
import type { CommitInfo } from './gitRepository';

export interface Publication { commit: CommitInfo; fromV: number; toV: number }
export interface PublicationState {
    published: Publication[];
    labels: Record<string, string[]>;
    pending?: { commit: CommitInfo; fromV: number };
    integrated?: { version: number; gitHash: string };
    pendingPull?: { version: number; gitHash: string };
}

/** Durable push receipts and verified sync position, never guessed timestamps.
 * A pending receipt is written BEFORE uploading: interruption must not make a
 * possibly published commit eligible for a destructive local reset.
 * No credentials are stored here.
 */
export class Publications {
    private readonly file: string;
    constructor(metadataDir: string) { this.file = path.join(metadataDir, 'publications.json'); }
    async read(): Promise<PublicationState> {
        try { return JSON.parse(await fs.readFile(this.file, 'utf8')) as PublicationState; }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return { published: [], labels: {} };
        }
    }
    async write(state: PublicationState): Promise<void> {
        const temporary = this.file + '.tmp';
        await fs.writeFile(temporary, JSON.stringify(state, null, 2));
        await fs.rename(temporary, this.file);
    }
}
