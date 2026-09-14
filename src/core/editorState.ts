import { promises as fs } from 'fs';
import * as path from 'path';
import { OperationBlockedError } from '../offline/operationBlocked';

/** Editor buffers are not on disk. Publish only their paths, never contents or
 * credentials. A dead extension host cannot leave a permanent dirty guard. */
export async function assertSavedEditors(root: string): Promise<void> {
    const directory = path.join(root, '.gitleaf');
    const files = await fs.readdir(directory);
    for (const file of files.filter((name) => /^editor-\d+\.json$/.test(name))) {
        const pid = Number(file.slice(7, -5));
        try {
            process.kill(pid, 0);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
        }
        let value: { dirty: string[] };
        try {
            value = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
        }
        if (value.dirty.length)
            throw new OperationBlockedError(`Save the linked folder’s editor changes first: ${value.dirty.join(', ')}`);
    }
}
