import { promises as fs } from 'fs';
import * as path from 'path';
import { lock } from 'proper-lockfile';
import { OperationBlockedError } from '../offline/operationBlocked';
/** Lock the entire operation, not just individual Git subprocesses. Live
 * sessions keep the lease until disconnected; stale leases recover after crashes. */
export async function acquireProject(root: string): Promise<() => Promise<void>> {
    const canonical = await fs.realpath(root),
        metadata = path.join(canonical, '.gitleaf');
    await fs.mkdir(metadata, { recursive: true });
    if ((await fs.lstat(metadata)).isSymbolicLink())
        throw new OperationBlockedError('The .gitleaf metadata directory must not be a symbolic link or junction.');
    try {
        return await lock(canonical, {
            lockfilePath: path.join(metadata, 'operation.lock'),
            stale: 120000,
            update: 10000,
            retries: 0,
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ELOCKED')
            throw new OperationBlockedError(
                'Project busy in another GitLeaf operation or online session. Wait, or switch that session Offline.',
            );
        throw error;
    }
}
export async function withProjectLock<T>(root: string, action: () => Promise<T>): Promise<T> {
    const release = await acquireProject(root);
    try {
        return await action();
    } finally {
        await release();
    }
}
