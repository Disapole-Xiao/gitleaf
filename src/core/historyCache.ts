import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { lock } from 'proper-lockfile';
import { HistoryRequestError } from '../api/historyRequest';
import { OperationBlockedError } from '../offline/operationBlocked';
import { writeJson } from './projectStore';

interface CacheState {
    next: number;
    retry: number;
    entries: Record<string, { expires: number; value: unknown }>;
}

/** Account-wide cache/429 cooldown survives CLI exit and is shared with every
 * editor window. Contains history responses only, never session credentials. */
export async function sharedHistoryRequest<T>(
    server: string,
    userId: string,
    key: string,
    lifetime: number,
    fresh: boolean,
    request: () => Promise<T>,
): Promise<T> {
    const account = createHash('sha256')
        .update(JSON.stringify([new URL(server).origin, userId]))
        .digest('hex');
    const directory = path.join(os.homedir(), '.gitleaf', 'history', account);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    let release: () => Promise<void>;
    try {
        release = await lock(directory, {
            lockfilePath: path.join(directory, 'request.lock'),
            stale: 120000,
            update: 10000,
            retries: 0,
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ELOCKED')
            throw new OperationBlockedError(
                'Another GitLeaf process is loading this account’s history. Wait for it to finish.',
            );
        throw error;
    }
    const file = path.join(directory, 'cache.json');
    try {
        let state: CacheState = { next: 0, retry: 0, entries: {} };
        try {
            state = JSON.parse(await fs.readFile(file, 'utf8'));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const cached = state.entries[key];
        if (!fresh && cached?.expires > Date.now()) return cached.value as T;
        if (state.retry > Date.now()) throw new HistoryRequestError(429, state.retry);
        if (state.next > Date.now())
            await new Promise((resolve) => setTimeout(resolve, Math.min(state.next - Date.now(), 2500)));
        state.next = Date.now() + 2500;
        // Persist before requesting: a killed CLI must not erase the pacing.
        await writeJson(file, state);
        try {
            const value = await request();
            if (lifetime > 0 && Buffer.byteLength(JSON.stringify(value) ?? '') < 1024 * 1024) {
                state.entries[key] = { value, expires: Date.now() + lifetime };
                const live = Object.entries(state.entries)
                    .filter(([, entry]) => entry.expires > Date.now())
                    .slice(-32);
                state.entries = Object.fromEntries(live);
            }
            await writeJson(file, state);
            return value;
        } catch (error) {
            if (error instanceof HistoryRequestError && error.status === 429) {
                state.retry = error.retryAt!;
                await writeJson(file, state);
            }
            throw error;
        }
    } finally {
        await release();
    }
}
