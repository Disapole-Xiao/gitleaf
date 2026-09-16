import { unzip } from 'fflate';
import { createHash } from 'crypto';
import { isUtf8 } from 'buffer';
import { lookup } from 'mime-types';

export type HistorySnapshot = ReadonlyMap<string, Uint8Array>;

/** Read the version archive in memory; never extract server paths to disk. */
export function readHistoryArchive(archive: Uint8Array): Promise<HistorySnapshot> {
    return new Promise((resolve, reject) => {
        let size = 0;
        let invalid: Error | undefined;
        const names = new Set<string>();
        unzip(archive, { filter: file => {
            if (invalid || file.name.endsWith('/')) return false;
            if (file.name.includes('\\') || file.name.includes('\0')
                || file.name.split('/').some(part => !part || part === '.' || part === '..') || names.has(file.name)) {
                invalid = new Error('Overleaf returned an invalid or duplicate archive path.');
                return false;
            }
            names.add(file.name);
            size += file.originalSize;
            if (size > 256 * 1024 * 1024 || names.size > 20000) {
                invalid = new Error('This history snapshot is too large to compare (maximum 256 MB or 20,000 files).');
                return false;
            }
            return true;
        } }, (error, files) => {
            if (error || invalid) reject(invalid || new Error('Could not read the Overleaf history archive.', { cause: error }));
            else if (Object.keys(files).length !== names.size) reject(new Error('The history archive contains an unsupported filename.'));
            else resolve(new Map(Object.entries(files)));
        });
    });
}

function binaryContent(file: string, bytes: Uint8Array | undefined): boolean {
    if (!bytes) return false;
    const mime = lookup(file) || '';
    if (/^(image\/(?!svg\+xml)|audio\/|video\/|application\/(pdf|zip|octet-stream))/.test(mime)) return true;
    // Let VS Code decode text with a UTF-16 BOM. Other non-UTF-8 or NUL-bearing
    // content needs an explicit summary: Multi Diff silently omits binary models.
    if (bytes.length >= 2 && (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0xfe && bytes[1] === 0xff)) return false;
    return bytes.includes(0) || !isUtf8(bytes);
}

export function snapshotDiffBytes(file: string, before: Uint8Array | undefined, after: Uint8Array | undefined):
    readonly [Uint8Array | undefined, Uint8Array | undefined] {
    if (!binaryContent(file, before) && !binaryContent(file, after)) return [before, after];
    const describe = (bytes: Uint8Array | undefined) => bytes === undefined ? undefined
        : Buffer.from(`Binary file (no text preview)\nSize: ${bytes.byteLength} bytes\nSHA-256: ${createHash('sha256').update(bytes).digest('hex')}\n`);
    return [describe(before), describe(after)];
}

/** Missing and empty files differ; compare bytes so binary files are included. */
export function changedSnapshotPaths(before: HistorySnapshot, after: HistorySnapshot): string[] {
    return [...new Set([...before.keys(), ...after.keys()])].filter(file => {
        const left = before.get(file), right = after.get(file);
        return !left || !right || Buffer.compare(left, right) !== 0;
    }).sort();
}
