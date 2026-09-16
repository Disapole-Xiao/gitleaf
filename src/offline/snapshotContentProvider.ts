import * as vscode from 'vscode';
import { createHash } from 'crypto';

export const SNAPSHOT_SCHEME = 'gitleaf-snapshot';

/** Immutable bytes for native diffs, retained across project switches. */
export class SnapshotContentProvider implements vscode.FileSystemProvider, vscode.Disposable {
    private readonly files = new Map<string, Uint8Array>();
    private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this.changed.event;

    snapshot(root: string, version: string, file: string, bytes: Uint8Array): vscode.Uri {
        const id = createHash('sha256').update(root).update('\0').update(version).update('\0').update(bytes).digest('hex');
        const uri = vscode.Uri.from({ scheme: SNAPSHOT_SCHEME, path: `/${file}`, query: new URLSearchParams({ id, version }).toString() });
        this.files.set(uri.toString(), bytes);
        return uri;
    }

    readFile(uri: vscode.Uri): Uint8Array {
        const bytes = this.files.get(uri.toString());
        if (!bytes) throw vscode.FileSystemError.FileNotFound(uri);
        return bytes;
    }

    stat(uri: vscode.Uri): vscode.FileStat {
        return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: this.readFile(uri).byteLength,
            permissions: vscode.FilePermission.Readonly };
    }

    watch(): vscode.Disposable { return { dispose() {} }; }
    readDirectory(uri: vscode.Uri): [string, vscode.FileType][] { throw vscode.FileSystemError.FileNotADirectory(uri); }
    createDirectory(): void { throw vscode.FileSystemError.NoPermissions('History snapshots are read-only.'); }
    writeFile(): void { throw vscode.FileSystemError.NoPermissions('History snapshots are read-only.'); }
    delete(): void { throw vscode.FileSystemError.NoPermissions('History snapshots are read-only.'); }
    rename(): void { throw vscode.FileSystemError.NoPermissions('History snapshots are read-only.'); }
    dispose(): void { this.files.clear(); this.changed.dispose(); }
}
