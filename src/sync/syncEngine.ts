import {
    RemoteProject,
    SyncStatus,
    FileTreeEntry,
    hashContent,
    contentEquals,
    debugLog,
    ensureApiSuccess,
} from '../core/remoteProject';
import { acquireProject } from '../core/projectLock';
/**
 * GitLeaf Sync Engine
 * Handles real-time bidirectional sync between local files and Overleaf
 */

import * as vscode from 'vscode';
import { OnlineTextSync } from './onlineTextSync';

import { BaseAPI, FileEntity } from '../api/base';

import { SettingsManager } from '../utils/projectAdapter';

import { DEBOUNCE_DELAY } from '../consts';

/**
 * Check if an error is a FileNotFound error (race condition safe)
 * This handles the case where a file is deleted between the watcher event and the read
 */
function isFileNotFoundError(error: unknown): boolean {
    if (error instanceof vscode.FileSystemError) {
        // VS Code FileSystemError has a 'code' property
        return error.code === 'FileNotFound' || error.code === 'EntryNotFound';
    }
    // Also check error message as fallback
    if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        return msg.includes('entrynotfound') || msg.includes('filenotfound') || msg.includes('enoent');
    }
    return false;
}

/**
 * Check if an error indicates session expiration
 */
function isAuthError(error: unknown): boolean {
    if (!error) return false;
    const errorStr = String(error).toLowerCase();
    return (
        errorStr.includes('session expired') ||
        errorStr.includes('403') ||
        errorStr.includes('401') ||
        errorStr.includes('unauthorized')
    );
}

/**
 * Sync Engine - manages real-time file synchronization
 */
export class SyncEngine extends RemoteProject {
    private localWatcher?: vscode.FileSystemWatcher;
    private disposables: vscode.Disposable[] = [];
    private syncLock: Set<string> = new Set();
    private readonly onlineTasks = new Set<Promise<void>>();
    private readonly delayedTasks = new Map<NodeJS.Timeout, () => void>();
    private onlineFailure?: Error;
    private activity = 0;
    constructor(
        api: BaseAPI,
        protected readonly settings: SettingsManager,
        logFn?: (message: string) => void,
    ) {
        super(api, settings, logFn);
    }

    /**
     * Set status and emit event
     */
    protected setStatus(status: SyncStatus, message?: string, file?: string, authError: boolean = false): void {
        if (status === 'error' && this.onlineText) this.onlineFailure = new Error(message || 'Online sync failed.');
        this._status = status;
        super.setStatus(status, message, file, authError);
    }
    protected configureSocket(readOnly: boolean): void {
        if (this.settings.getSettings()?.mode !== 'online' || readOnly) {
            super.configureSocket(readOnly);
            return;
        }

        this.onlineText = new OnlineTextSync(this.socket!, this.settings, (message) => {
            this.log(message);
            this.setStatus('error', message);
            void vscode.window.showErrorMessage(`GitLeaf: Online sync paused. ${message}`);
        });
        this.socket!.registerHandlers({
            onFileCreated: (parentId, type, entity) =>
                this.trackOnline(() => this.handleRemoteFileCreated(parentId, type, entity)),
            onFileRenamed: (id, name) => this.trackOnline(() => this.handleRemoteFileRenamed(id, name)),
            onFileRemoved: (id) => this.trackOnline(() => this.handleRemoteFileRemoved(id)),
            onFileMoved: (id, parentId) => this.trackOnline(() => this.handleRemoteFileMoved(id, parentId)),
            onFileChanged: (update) => this.onlineText?.receive(update),
        });
    }
    private releaseSession?: () => Promise<void>;
    private releasing: Promise<void> = Promise.resolve();
    async close(): Promise<void> {
        this.disconnect();
        await this.releasing;
    }
    async connect(readOnly = false): Promise<void> {
        if (!readOnly) this.releaseSession = await acquireProject(this.settings.root);
        try {
            await super.connect(readOnly);
        } catch (error) {
            await this.close();
            throw error;
        }
    }

    /**
     * Setup local file system watcher
     */
    private setupLocalWatcher(): void {
        const workspaceFolder = this.settings.getWorkspaceFolder();
        const pattern = new vscode.RelativePattern(workspaceFolder, '**/*');

        this.localWatcher = vscode.workspace.createFileSystemWatcher(pattern);

        this.disposables.push(
            this.localWatcher.onDidChange((uri) => this.trackLocal(uri, () => this.handleLocalFileChange(uri))),
            this.localWatcher.onDidCreate((uri) => this.trackLocal(uri, () => this.handleLocalFileCreate(uri))),
            this.localWatcher.onDidDelete((uri) => this.trackLocal(uri, () => this.handleLocalFileDelete(uri))),
            this.localWatcher,
        );
    }

    async flushOnline(): Promise<void> {
        if (!this.onlineText) return;
        if (this.status === 'disconnected') throw new Error('Reconnect before confirming an online snapshot.');
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                (async () => {
                    do {
                        if (this.onlineFailure) throw this.onlineFailure;
                        await Promise.all(this.onlineTasks);
                        await this.onlineText?.flush();
                    } while (this.onlineTasks.size);
                    if (this.onlineFailure) throw this.onlineFailure;
                })(),
                new Promise<void>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error('Online operations are still pending. Try again after sync finishes.')),
                        20000,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    private trackOnline(action: () => Promise<void>): void {
        this.activity++;
        const task = action().catch((error) => {
            this.onlineFailure = error instanceof Error ? error : new Error(String(error));
            this.setStatus('error', this.onlineFailure.message);
        });
        this.onlineTasks.add(task);
        void task.finally(() => this.onlineTasks.delete(task));
    }

    private trackLocal(uri: vscode.Uri, action: () => Promise<void>): void {
        // Build output and .gitleaf metadata are not online activity. They must
        // not invalidate a stable cutoff while LaTeX or Git is writing files.
        if (this.shouldSync(this.getRelativePath(uri))) this.trackOnline(action);
    }

    private deferOnline(action: () => Promise<void>): void {
        this.trackOnline(
            () =>
                new Promise<void>((resolve) => {
                    const timer = setTimeout(() => {
                        this.delayedTasks.delete(timer);
                        if (!this.socket) {
                            resolve();
                            return;
                        }
                        void action().then(resolve, (error) => {
                            this.onlineFailure = new Error(String(error));
                            resolve();
                        });
                    }, DEBOUNCE_DELAY);
                    this.delayedTasks.set(timer, resolve);
                }),
        );
    }

    /** Establish a precise cut: flush text acknowledgements AND file CRUD,
     * capture a stable version, then detach synchronously before returning.
     * Changes made after this cut remain ordinary offline working changes.
     */
    async finishOnline(): Promise<Map<string, Uint8Array>> {
        await this.flushOnline();
        const revision = this.activity + (this.onlineText?.revision || 0);
        const snapshot = await this.readRemoteSnapshot();
        await this.flushOnline();
        if (revision !== this.activity + (this.onlineText?.revision || 0))
            throw new Error('The project changed while switching modes. Wait for sync to settle and try again.');
        await this.close();
        return snapshot;
    }

    get hasPendingFileOperations(): boolean {
        return this.onlineTasks.size > 0;
    }

    /**
     * Get relative path from URI
     */
    private getRelativePath(uri: vscode.Uri): string {
        return this.settings.getRelativePath(uri) || '';
    }

    /**
     * Check if path should be synced (not ignored)
     */
    private shouldSync(relativePath: string): boolean {
        return !!relativePath && !this.ignoreParser.shouldIgnore(relativePath);
    }

    /**
     * Check if we should propagate a change (prevent echo)
     */
    private shouldPropagate(action: 'push' | 'pull', path: string, content?: Uint8Array): boolean {
        const cache = this.fileCache.get(path);
        const newHash = hashContent(content);

        // Only identical content is an echo. Editors often emit an empty
        // create/change event followed immediately by the actual contents.
        if (cache && cache.hash === newHash) {
            return false;
        }

        this.fileCache.set(path, { hash: newHash, timestamp: Date.now() });
        return true;
    }

    /**
     * Acquire sync lock for a path
     */
    private acquireLock(path: string): boolean {
        if (this.syncLock.has(path)) {
            return false;
        }
        this.syncLock.add(path);
        return true;
    }

    /**
     * Release sync lock for a path
     */
    private releaseLock(path: string): void {
        this.syncLock.delete(path);
    }

    // === Local change handlers ===

    /**
     * Handle local file change
     */
    private async handleLocalFileChange(uri: vscode.Uri): Promise<void> {
        const relativePath = this.getRelativePath(uri);
        if (!this.shouldSync(relativePath)) return;
        if (!this.acquireLock(relativePath)) {
            this.deferOnline(() => this.handleLocalFileChange(uri));
            return;
        }

        try {
            const watchedEntry = this.fileTreeByPath.get(relativePath);
            if (this.onlineText && watchedEntry?.type === 'doc' && this.onlineText.has(watchedEntry.id)) return;
            // Read file content - may throw if file was deleted between watcher event and now
            let content: Uint8Array;
            try {
                content = await vscode.workspace.fs.readFile(uri);
            } catch (readError) {
                // File was deleted between watcher event and read - this is normal during rapid operations
                if (isFileNotFoundError(readError)) {
                    debugLog(`File no longer exists (race condition): ${relativePath}`);
                    return;
                }
                throw readError;
            }

            if (!this.shouldPropagate('push', relativePath, content)) return;

            const entry = this.fileTreeByPath.get(relativePath);
            if (!entry) {
                debugLog(`File not in remote tree: ${relativePath}`);
                return;
            }

            this.setStatus('pushing', `Uploading ${relativePath}`, relativePath);

            // For documents, we need to use OT updates
            // For binary files, we upload directly
            if (entry.type === 'doc') {
                if (!this.socket) {
                    throw new Error(`Cannot update ${relativePath}: real-time connection is unavailable`);
                }
                const pushed = await this.pushDocumentChanges(entry.id, relativePath, content);
                if (pushed) {
                    this.log(`Pushed to Overleaf: ${relativePath}`);
                }
            } else {
                await this.replaceRemoteFile(entry, content);
                this.log(`Replaced on Overleaf: ${relativePath}`);
            }

            this.baseContent.set(relativePath, content);
            this.setStatus('idle');
        } catch (error) {
            // Don't show error for file-not-found during rapid operations
            if (isFileNotFoundError(error)) {
                debugLog(`File disappeared during sync: ${relativePath}`);
                this.setStatus('idle');
                return;
            }
            console.error(`[GitLeaf] Failed to sync ${relativePath}:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to sync: ${error}`, undefined, authErr);
        } finally {
            this.releaseLock(relativePath);
        }
    }

    /**
     * Handle local file creation
     */
    private async handleLocalFileCreate(uri: vscode.Uri): Promise<void> {
        const relativePath = this.getRelativePath(uri);
        if (!this.shouldSync(relativePath)) return;
        if (!this.acquireLock(relativePath)) {
            this.deferOnline(() => this.handleLocalFileCreate(uri));
            return;
        }

        try {
            // Stat the file - may throw if file was deleted between watcher event and now
            let stat: vscode.FileStat;
            try {
                stat = await vscode.workspace.fs.stat(uri);
            } catch (statError) {
                if (isFileNotFoundError(statError)) {
                    debugLog(`File no longer exists (race condition): ${relativePath}`);
                    return;
                }
                throw statError;
            }

            const trackedPath = stat.type === vscode.FileType.Directory ? relativePath + '/' : relativePath;
            if (this.fileTreeByPath.has(trackedPath)) {
                // A create event can be the local echo of a remote write or an
                // editor's atomic replacement of an existing file. Folders
                // already exist remotely; files are re-evaluated as changes.
                if (stat.type !== vscode.FileType.Directory) {
                    this.deferOnline(() => this.handleLocalFileChange(uri));
                }
                return;
            }

            const projectSettings = this.settings.getSettings()!;

            this.setStatus('pushing', `Creating ${relativePath}`, relativePath);

            // Ensure parent folders exist (creates them if needed)
            const parentId = await this.ensureParentFoldersExist(relativePath);
            const name = relativePath.split('/').pop()!;

            if (stat.type === vscode.FileType.Directory) {
                const folderPath = relativePath + '/';
                const result = await this.api.addFolder(projectSettings.projectId, parentId, name);
                ensureApiSuccess(result, `Create folder ${folderPath}`);

                // Add folder to file tree immediately (don't wait for socket event)
                if (result.type === 'success' && result.folder) {
                    const folderEntry: FileTreeEntry = {
                        id: result.folder._id,
                        type: 'folder',
                        name: name,
                        path: folderPath,
                        parentId: parentId,
                    };
                    this.fileTree.set(result.folder._id, folderEntry);
                    this.fileTreeByPath.set(folderPath, folderEntry);
                    debugLog('Added folder to tree:', folderPath, result.folder._id);
                }

                // Track folder in baseContent so delete/rename operations work
                this.baseContent.set(folderPath, new Uint8Array(0));
                this.log(`Created folder on Overleaf: ${folderPath}`);
            } else {
                // Read file content - may throw if file was deleted
                let content: Uint8Array;
                try {
                    content = await vscode.workspace.fs.readFile(uri);
                } catch (readError) {
                    if (isFileNotFoundError(readError)) {
                        debugLog(`File no longer exists (race condition): ${relativePath}`);
                        return;
                    }
                    throw readError;
                }

                const isTextFile = this.isTextFile(name);

                if (isTextFile) {
                    await this.createTextDocumentWithContent(
                        projectSettings.projectId,
                        parentId,
                        relativePath,
                        name,
                        content,
                    );
                } else {
                    // Set this before upload so the socket acknowledgement is
                    // recognized as an echo of the local operation.
                    this.baseContent.set(relativePath, content);
                    const result = await this.api.uploadFile(projectSettings.projectId, parentId, name, content);
                    ensureApiSuccess(result, `Upload ${relativePath}`);
                    if (!this.trackUploadedEntity(result, parentId, name, relativePath)) {
                        await this.refreshProjectFileTree();
                    }
                }

                this.baseContent.set(relativePath, content);
                this.fileCache.set(relativePath, { hash: hashContent(content), timestamp: Date.now() });
            }

            this.setStatus('idle');
        } catch (error) {
            // Don't show error for file-not-found during rapid operations
            if (isFileNotFoundError(error)) {
                debugLog(`File disappeared during create: ${relativePath}`);
                this.setStatus('idle');
                return;
            }
            console.error(`[GitLeaf] Failed to create ${relativePath}:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to create: ${error}`, undefined, authErr);
        } finally {
            this.releaseLock(relativePath);
        }
    }

    /**
     * Handle local file deletion
     */
    private async handleLocalFileDelete(uri: vscode.Uri): Promise<void> {
        const relativePath = this.getRelativePath(uri);
        if (!this.shouldSync(relativePath)) return;
        if (!this.acquireLock(relativePath)) {
            this.deferOnline(() => this.handleLocalFileDelete(uri));
            return;
        }

        try {
            // Try both file path and folder path (with trailing slash)
            let entry = this.fileTreeByPath.get(relativePath);
            let pathToUse = relativePath;
            if (!entry) {
                // Maybe it's a folder - try with trailing slash
                const folderPath = relativePath + '/';
                entry = this.fileTreeByPath.get(folderPath);
                if (entry) {
                    pathToUse = folderPath;
                }
            }
            if (!entry) {
                // Socket events can be missed while reconnecting. Refresh the
                // server tree before deciding there is nothing to delete.
                await this.refreshProjectFileTree();
                entry = this.fileTreeByPath.get(relativePath);
                if (!entry) {
                    const folderPath = relativePath + '/';
                    entry = this.fileTreeByPath.get(folderPath);
                    if (entry) {
                        pathToUse = folderPath;
                    }
                }
            }
            if (!entry) return;

            // Only delete from Overleaf if the file was previously synced locally.
            // If baseContent doesn't have this path, the file was never downloaded/synced,
            // so we should NOT propagate this deletion to Overleaf (prevents deleting
            // new upstream files that haven't been pulled yet).
            if (!this.baseContent.has(pathToUse)) {
                debugLog(`Ignoring delete for never-synced file: ${pathToUse}`);
                return;
            }

            this.setStatus('pushing', `Deleting ${pathToUse}`, pathToUse);

            await this.deleteRemoteEntry(entry, true);
            this.baseContent.delete(pathToUse);
            this.fileCache.delete(pathToUse);

            this.log(`Deleted from Overleaf: ${pathToUse}`);
            this.setStatus('idle');
        } catch (error) {
            console.error(`[GitLeaf] Failed to delete ${relativePath}:`, error);
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Failed to delete: ${error}`, undefined, authErr);
        } finally {
            this.releaseLock(relativePath);
        }
    }

    // === Remote change handlers ===

    /**
     * Handle remote file created
     */
    private async handleRemoteFileCreated(
        parentId: string,
        type: 'doc' | 'file' | 'folder',
        entity: FileEntity,
    ): Promise<void> {
        const parent = this.fileTree.get(parentId);
        const parentPath = parent?.path || '/';
        const path = type === 'folder' ? parentPath + entity.name + '/' : parentPath + entity.name;

        // Record the remote identity before taking the path lock. Local
        // uploads hold this lock while Overleaf emits the create event.
        const entry: FileTreeEntry = {
            id: entity._id,
            type,
            name: entity.name,
            path,
            parentId,
        };
        this.fileTree.set(entity._id, entry);
        this.fileTreeByPath.set(path, entry);

        if (!this.shouldSync(path)) return;
        if (!this.acquireLock(path)) {
            this.deferOnline(() => this.handleRemoteFileCreated(parentId, type, entity));
            return;
        }

        try {
            this.setStatus('pulling', `Downloading ${path}`, path);

            const localUri = this.settings.getFilePath(path);

            // Check if this is an echo of our own creation (file already in baseContent)
            const alreadySynced = this.baseContent.has(path);
            if (alreadySynced) {
                debugLog(`Ignoring remote create echo for already-synced: ${path}`);
                this.setStatus('idle');
                return;
            }

            if (type === 'doc' && this.onlineText) {
                await this.onlineText.open(entry.id, path);
                const content = Buffer.from(this.onlineText.text(entry.id)!);
                this.baseContent.set(path, content);
                this.fileCache.set(path, { hash: hashContent(content), timestamp: Date.now() });
            } else if (type === 'folder') {
                await vscode.workspace.fs.createDirectory(localUri);
                // Track folders in baseContent with empty content
                this.baseContent.set(path, new Uint8Array(0));
            } else {
                // Download content - use correct API based on type
                const projectSettings = this.settings.getSettings()!;
                let content: Uint8Array | undefined;

                if (type === 'doc') {
                    // For docs, use getDocContent
                    const result = await this.api.getDocContent(projectSettings.projectId, entity._id);
                    if (result.type === 'success' && result.lines) {
                        content = new TextEncoder().encode(result.lines.join('\n'));
                    }
                } else {
                    // For binary files, use getFile
                    const result = await this.api.getFile(projectSettings.projectId, entity._id);
                    if (result.type === 'success' && result.content) {
                        content = result.content;
                    }
                }

                if (content) {
                    // Do not overwrite an unrelated local file with the same name.
                    if (await this.localFileExists(localUri)) {
                        const resolution = await this.askConflictResolution(path, localUri, content);
                        if (resolution !== 'useRemote') return;
                    }
                    await vscode.workspace.fs.writeFile(localUri, content);
                    this.baseContent.set(path, content);
                    this.fileCache.set(path, { hash: hashContent(content), timestamp: Date.now() });
                    this.log(`Downloaded new file from Overleaf: ${path}`);
                }

                // Join new docs to receive OT updates
                if (type === 'doc' && this.socket && !this.joinedDocs.has(entity._id)) {
                    try {
                        await this.socket.joinDoc(entity._id);
                        this.joinedDocs.add(entity._id);
                    } catch {
                        // Ignore join errors
                    }
                }
            }

            this.setStatus('idle');
        } catch (error) {
            console.error(`[GitLeaf] Failed to sync remote create ${path}:`, error);
        } finally {
            this.releaseLock(path);
        }
    }

    /**
     * Handle remote file renamed
     */
    private async handleRemoteFileRenamed(entityId: string, newName: string): Promise<void> {
        if (this.consumeSuppressedRemoteRename(entityId, newName)) {
            return;
        }

        const entry = this.fileTree.get(entityId);
        if (!entry) return;

        const oldPath = entry.path;
        const parentPath = oldPath.substring(0, oldPath.lastIndexOf('/') + 1);
        const newPath = entry.type === 'folder' ? parentPath + newName + '/' : parentPath + newName;

        if (!this.acquireLock(oldPath)) return;

        try {
            this.setStatus('pulling', `Renaming ${oldPath} to ${newPath}`, oldPath);

            // Update tree
            entry.name = newName;
            entry.path = newPath;
            this.fileTreeByPath.delete(oldPath);
            this.fileTreeByPath.set(newPath, entry);

            // Rename local file
            const oldUri = this.settings.getFilePath(oldPath);
            const newUri = this.settings.getFilePath(newPath);
            await vscode.workspace.fs.rename(oldUri, newUri);

            // Update caches
            const content = this.baseContent.get(oldPath);
            if (content) {
                this.baseContent.delete(oldPath);
                this.baseContent.set(newPath, content);
            }
            const cache = this.fileCache.get(oldPath);
            if (cache) {
                this.fileCache.delete(oldPath);
                this.fileCache.set(newPath, cache);
            }

            this.setStatus('idle');
        } catch (error) {
            console.error(`[GitLeaf] Failed to sync remote rename:`, error);
        } finally {
            this.releaseLock(oldPath);
        }
    }

    /**
     * Handle remote file removed
     */
    private async handleRemoteFileRemoved(entityId: string): Promise<void> {
        if (this.suppressedRemoteDeletes.delete(entityId)) {
            const suppressedEntry = this.fileTree.get(entityId);
            if (suppressedEntry) {
                this.fileTree.delete(entityId);
                if (this.fileTreeByPath.get(suppressedEntry.path)?.id === entityId) {
                    this.fileTreeByPath.delete(suppressedEntry.path);
                }
            }
            return;
        }

        const entry = this.fileTree.get(entityId);
        if (!entry) return;

        if (!this.shouldSync(entry.path)) return;
        if (!this.acquireLock(entry.path)) return;

        try {
            this.setStatus('pulling', `Deleting ${entry.path}`, entry.path);

            // Leave doc if joined
            if (entry.type === 'doc' && this.joinedDocs.has(entityId)) {
                try {
                    await this.socket?.leaveDoc(entityId);
                } catch {
                    // Ignore leave errors
                }
                this.joinedDocs.delete(entityId);
            }

            // Remove from tree
            this.fileTree.delete(entityId);
            this.onlineText?.remove(entityId);
            this.fileTreeByPath.delete(entry.path);

            // Delete local file
            const localUri = this.settings.getFilePath(entry.path);
            await vscode.workspace.fs.delete(localUri, { recursive: true });

            this.baseContent.delete(entry.path);
            this.fileCache.delete(entry.path);

            this.setStatus('idle');
        } catch (error) {
            console.error(`[GitLeaf] Failed to sync remote delete:`, error);
        } finally {
            this.releaseLock(entry.path);
        }
    }

    /**
     * Handle remote file moved
     */
    private async handleRemoteFileMoved(entityId: string, newParentId: string): Promise<void> {
        const entry = this.fileTree.get(entityId);
        const newParent = this.fileTree.get(newParentId);
        if (!entry || !newParent) return;

        const oldPath = entry.path;
        const newPath = entry.type === 'folder' ? newParent.path + entry.name + '/' : newParent.path + entry.name;

        if (!this.acquireLock(oldPath)) return;

        try {
            this.setStatus('pulling', `Moving ${oldPath} to ${newPath}`, oldPath);

            // Update tree
            entry.path = newPath;
            entry.parentId = newParentId;
            this.fileTreeByPath.delete(oldPath);
            this.fileTreeByPath.set(newPath, entry);

            // Move local file
            const oldUri = this.settings.getFilePath(oldPath);
            const newUri = this.settings.getFilePath(newPath);
            await vscode.workspace.fs.rename(oldUri, newUri);

            this.setStatus('idle');
        } catch (error) {
            console.error(`[GitLeaf] Failed to sync remote move:`, error);
        } finally {
            this.releaseLock(oldPath);
        }
    }

    /** Ensure all online text sessions are initialized and stay joined. */
    async joinAllDocsForWatching(): Promise<void> {
        if (!this.onlineText) return;
        for (const entry of this.fileTree.values()) {
            if (entry.type === 'doc' && this.shouldSync(entry.path)) {
                await this.onlineText.open(entry.id, entry.path);
            }
        }
    }

    // === Public methods ===

    /**
     * Conflict resolution options
     */
    private conflictResolution: 'ask' | 'useRemote' | 'useLocal' | 'skip' = 'ask';
    private applyToAll: boolean = false;

    /**
     * Check if local file exists
     */
    private async localFileExists(uri: vscode.Uri): Promise<boolean> {
        try {
            await vscode.workspace.fs.stat(uri);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Compare local and remote content
     */
    private async hasConflict(localUri: vscode.Uri, remoteContent: Uint8Array): Promise<boolean> {
        try {
            const localContent = await vscode.workspace.fs.readFile(localUri);
            const isEqual = contentEquals(localContent, remoteContent);
            if (!isEqual) {
                debugLog(
                    'hasConflict: DIFFERENT',
                    localUri.fsPath,
                    'local:',
                    localContent.length,
                    'bytes',
                    'remote:',
                    remoteContent.length,
                    'bytes',
                );
            }
            return !isEqual;
        } catch {
            return false; // File doesn't exist locally, no conflict
        }
    }

    /**
     * Show diff between local and remote file
     */
    private async showDiff(filePath: string, localUri: vscode.Uri, remoteContent: Uint8Array): Promise<void> {
        // Create a temporary URI for the remote content
        const remoteUri = vscode.Uri.parse(`gitleaf-remote:${filePath}`);

        // Register a content provider for the remote file
        const provider = new (class implements vscode.TextDocumentContentProvider {
            provideTextDocumentContent(): string {
                return new TextDecoder().decode(remoteContent);
            }
        })();

        const disposable = vscode.workspace.registerTextDocumentContentProvider('gitleaf-remote', provider);

        try {
            // Open diff editor
            await vscode.commands.executeCommand('vscode.diff', localUri, remoteUri, `${filePath} (Local ↔ Remote)`);
        } finally {
            // Keep provider registered while diff is open
            setTimeout(() => disposable.dispose(), 60000); // Dispose after 1 minute
        }
    }

    /**
     * Ask user how to resolve conflict
     */
    private async askConflictResolution(
        filePath: string,
        localUri: vscode.Uri,
        remoteContent: Uint8Array,
    ): Promise<'useRemote' | 'useLocal' | 'skip'> {
        if (this.applyToAll && this.conflictResolution !== 'ask') {
            return this.conflictResolution as 'useRemote' | 'useLocal' | 'skip';
        }

        // First ask: show diff or choose action?
        const firstChoice = await vscode.window.showWarningMessage(
            `Conflict: "${filePath}"`,
            'Diff',
            'Remote',
            'Local',
            'All Remote',
            'All Local',
        );

        switch (firstChoice) {
            case 'Diff':
                await this.showDiff(filePath, localUri, remoteContent);
                return this.askConflictResolutionAfterDiff(filePath);
            case 'Remote':
                return 'useRemote';
            case 'Local':
                return 'useLocal';
            case 'All Remote':
                this.conflictResolution = 'useRemote';
                this.applyToAll = true;
                return 'useRemote';
            case 'All Local':
                this.conflictResolution = 'useLocal';
                this.applyToAll = true;
                return 'useLocal';
            default:
                return 'skip';
        }
    }

    /**
     * Ask after viewing diff
     */
    private async askConflictResolutionAfterDiff(filePath: string): Promise<'useRemote' | 'useLocal' | 'skip'> {
        const result = await vscode.window.showWarningMessage(
            `After reviewing diff for "${filePath}", what would you like to do?`,
            { modal: false },
            'Use Remote',
            'Keep Local',
            'Skip',
        );

        switch (result) {
            case 'Use Remote':
                return 'useRemote';
            case 'Keep Local':
                return 'useLocal';
            default:
                return 'skip';
        }
    }

    /**
     * Ask user how to handle a new file from Overleaf that doesn't exist locally
     */
    private async askNewRemoteFileResolution(
        filePath: string,
        remoteContent: Uint8Array,
    ): Promise<'useRemote' | 'skip'> {
        if (this.applyToAll && this.conflictResolution !== 'ask') {
            return this.conflictResolution === 'useRemote' ? 'useRemote' : 'skip';
        }

        const sizeStr =
            remoteContent.length < 1024
                ? `${remoteContent.length} bytes`
                : `${(remoteContent.length / 1024).toFixed(1)} KB`;

        const choice = await vscode.window.showInformationMessage(
            `New file on Overleaf: "${filePath}" (${sizeStr})`,
            'Download',
            'Skip',
            'Download All New',
            'Skip All New',
        );

        switch (choice) {
            case 'Download':
                return 'useRemote';
            case 'Download All New':
                this.conflictResolution = 'useRemote';
                this.applyToAll = true;
                return 'useRemote';
            case 'Skip All New':
                this.conflictResolution = 'skip';
                this.applyToAll = true;
                return 'skip';
            default:
                return 'skip';
        }
    }

    /**
     * Handle local files that were deleted on Overleaf.
     * These are files that exist locally, were previously synced (in baseContent),
     * but no longer exist on Overleaf.
     */
    private async handleOrphanedLocalFiles(orphanedPaths: string[]): Promise<void> {
        if (orphanedPaths.length === 0) return;

        const fileList =
            orphanedPaths.length <= 5
                ? orphanedPaths.join(', ')
                : `${orphanedPaths.slice(0, 5).join(', ')}... and ${orphanedPaths.length - 5} more`;

        const choice = await vscode.window.showWarningMessage(
            `${orphanedPaths.length} file(s) were deleted on Overleaf but exist locally: ${fileList}`,
            { modal: false },
            'Delete Locally',
            'Keep Locally',
            'Re-upload',
        );

        if (choice === 'Delete Locally') {
            for (const path of orphanedPaths) {
                try {
                    const localUri = this.settings.getFilePath(path);
                    await vscode.workspace.fs.delete(localUri, { recursive: false });
                    this.baseContent.delete(path);
                    this.fileCache.delete(path);
                    this.log(`Deleted local file (removed from Overleaf): ${path}`);
                } catch (error) {
                    console.error(`[GitLeaf] Failed to delete local file: ${path}`, error);
                }
            }
        } else if (choice === 'Re-upload') {
            for (const path of orphanedPaths) {
                try {
                    await this.uploadLocalFile(path);
                    this.log(`Re-uploaded to Overleaf: ${path}`);
                } catch (error) {
                    console.error(`[GitLeaf] Failed to re-upload: ${path}`, error);
                }
            }
        } else {
            // Keep Locally - clear from baseContent so it's not tracked as synced
            for (const path of orphanedPaths) {
                this.baseContent.delete(path);
                debugLog(`Keeping local file, removed from sync tracking: ${path}`);
            }
        }
    }

    /**
     * Handle files that exist only locally (not on Overleaf, never synced).
     * These could be new files the user wants to upload or files to ignore.
     */
    private async handleLocalOnlyFiles(localOnlyPaths: string[]): Promise<void> {
        if (localOnlyPaths.length === 0) return;

        const fileList =
            localOnlyPaths.length <= 5
                ? localOnlyPaths.join(', ')
                : `${localOnlyPaths.slice(0, 5).join(', ')}... and ${localOnlyPaths.length - 5} more`;

        const choice = await vscode.window.showInformationMessage(
            `${localOnlyPaths.length} local file(s) not on Overleaf: ${fileList}`,
            { modal: false },
            'Upload All',
            'Ignore',
        );

        if (choice === 'Upload All') {
            for (const path of localOnlyPaths) {
                try {
                    await this.uploadLocalFile(path);
                    this.log(`Uploaded new file: ${path}`);
                } catch (error) {
                    console.error(`[GitLeaf] Failed to upload: ${path}`, error);
                }
            }
        }
        // 'Ignore' - do nothing, files stay local only
    }

    /**
     * Return remote files currently excluded by .gitleafignore.
     * Refreshing both sources also finds artifacts left by earlier sessions.
     */
    async getIgnoredRemoteFiles(): Promise<string[]> {
        await this.ignoreParser.load();
        await this.refreshProjectFileTree();

        return Array.from(this.fileTree.values())
            .filter((entry) => entry.type !== 'folder' && this.ignoreParser.shouldIgnore(entry.path))
            .map((entry) => entry.path)
            .sort((a, b) => a.localeCompare(b));
    }

    /**
     * Delete a user-confirmed list of ignored remote files.
     * Every path is revalidated immediately before deletion.
     */
    async deleteIgnoredRemoteFiles(
        paths: readonly string[],
    ): Promise<{ deleted: number; failed: Array<{ path: string; error: unknown }> }> {
        await this.ignoreParser.load();
        await this.refreshProjectFileTree();

        let deleted = 0;
        const failed: Array<{ path: string; error: unknown }> = [];
        this.setStatus('pushing', 'Cleaning ignored files from Overleaf...');

        for (const path of paths) {
            const entry = this.fileTreeByPath.get(path);
            if (!entry || entry.type === 'folder' || !this.ignoreParser.shouldIgnore(path)) {
                continue;
            }

            try {
                await this.deleteRemoteEntry(entry, true);
                this.baseContent.delete(path);
                this.fileCache.delete(path);
                this.log(`Deleted ignored file from Overleaf: ${path}`);
                deleted++;
            } catch (error) {
                failed.push({ path, error });
            }
        }

        if (failed.length > 0) {
            this.setStatus('error', `Cleanup completed with ${failed.length} failure(s)`);
        } else {
            this.setStatus('idle', `Deleted ${deleted} ignored file(s) from Overleaf`);
        }

        return { deleted, failed };
    }

    /**
     * Perform full sync (pull all files)
     */
    async pullAll(): Promise<void> {
        if (!this.project) {
            throw new Error('Not connected');
        }

        debugLog('pullAll: Starting pull');
        debugLog('pullAll: File tree size:', this.fileTree.size);
        debugLog('pullAll: Project name:', this.project.name);

        // Reset conflict resolution state
        this.conflictResolution = 'ask';
        this.applyToAll = false;

        this.setStatus('pulling', 'Downloading all files...');
        const projectSettings = this.settings.getSettings()!;

        let downloadedCount = 0;
        let skippedCount = 0;
        let conflictCount = 0;

        try {
            const downloadFile = async (entry: FileTreeEntry) => {
                debugLog('pullAll: Processing', entry.path, entry.type);

                if (entry.type === 'doc' && this.onlineText) {
                    if (!this.shouldSync(entry.path)) return;
                    await this.onlineText.open(entry.id, entry.path);
                    const content = Buffer.from(this.onlineText.text(entry.id)!);
                    this.baseContent.set(entry.path, content);
                    this.fileCache.set(entry.path, { hash: hashContent(content), timestamp: Date.now() });
                    downloadedCount++;
                    return;
                }
                if (entry.type === 'folder') {
                    const localUri = this.settings.getFilePath(entry.path);
                    await vscode.workspace.fs.createDirectory(localUri);
                    // Track folders in baseContent with empty content
                    this.baseContent.set(entry.path, new Uint8Array(0));
                    return;
                }

                if (this.ignoreParser.shouldIgnore(entry.path)) {
                    debugLog('pullAll: Ignored', entry.path);
                    return;
                }

                // Get remote content - docs use joinDoc via socket, files use HTTP
                const result = await this.api.getFile(projectSettings.projectId, entry.id);
                ensureApiSuccess(result, `Download ${entry.path}`);
                if (!result.content) throw new Error(`Download returned no content: ${entry.path}`);
                const remoteContent = result.content;

                const localUri = this.settings.getFilePath(entry.path);
                const exists = await this.localFileExists(localUri);

                // Check for conflicts or new remote files
                if (exists) {
                    const hasConflict = await this.hasConflict(localUri, remoteContent);
                    if (hasConflict) {
                        conflictCount++;
                        const resolution = await this.askConflictResolution(entry.path, localUri, remoteContent);

                        if (resolution === 'skip') {
                            debugLog('pullAll: Skipped (user choice)', entry.path);
                            skippedCount++;
                            return;
                        }

                        if (resolution === 'useLocal') {
                            // Push local content to Overleaf
                            debugLog('pullAll: Using local, pushing to Overleaf', entry.path);
                            this.setStatus('pushing', `Uploading ${entry.path}`, entry.path);
                            const localContent = await vscode.workspace.fs.readFile(localUri);

                            if (entry.type === 'doc') {
                                if (!this.socket) {
                                    throw new Error(`Cannot update ${entry.path}: real-time connection is unavailable`);
                                }
                                await this.pushDocumentChanges(entry.id, entry.path, localContent);
                            } else {
                                await this.replaceRemoteFile(entry, localContent);
                            }

                            this.baseContent.set(entry.path, localContent);
                            this.fileCache.set(entry.path, { hash: hashContent(localContent), timestamp: Date.now() });
                            return;
                        }
                        // resolution === 'useRemote' - continue to download
                    }
                }

                // Download file only if content is different (prevents file flashing)
                let localContent: Uint8Array | undefined;
                if (exists) {
                    try {
                        localContent = await vscode.workspace.fs.readFile(localUri);
                    } catch {
                        localContent = undefined;
                    }
                }

                // Skip write if content is identical
                if (contentEquals(localContent, remoteContent)) {
                    // Content is the same, just update cache
                    this.baseContent.set(entry.path, remoteContent);
                    this.fileCache.set(entry.path, { hash: hashContent(remoteContent), timestamp: Date.now() });
                    return;
                }

                this.setStatus('pulling', `Downloading ${entry.path}`, entry.path);
                await vscode.workspace.fs.writeFile(localUri, remoteContent);
                this.baseContent.set(entry.path, remoteContent);
                this.fileCache.set(entry.path, { hash: hashContent(remoteContent), timestamp: Date.now() });
                downloadedCount++;
            };

            // Download all files
            for (const entry of this.fileTree.values()) {
                await downloadFile(entry);
            }

            // Detect files that were deleted on Overleaf but exist locally
            // (files in baseContent but not in fileTreeByPath)
            const orphanedPaths: string[] = [];
            for (const [syncedPath] of this.baseContent) {
                // Skip if still exists on Overleaf
                if (this.fileTreeByPath.has(syncedPath)) continue;
                // Skip folders
                if (syncedPath.endsWith('/')) continue;
                // Skip ignored files
                if (this.ignoreParser.shouldIgnore(syncedPath)) continue;
                // Check if local file actually exists
                const localUri = this.settings.getFilePath(syncedPath);
                if (await this.localFileExists(localUri)) {
                    orphanedPaths.push(syncedPath);
                }
            }
            if (orphanedPaths.length > 0) {
                await this.handleOrphanedLocalFiles(orphanedPaths);
            }

            // Detect local-only files (exist locally but not on Overleaf or in baseContent)
            const localOnlyPaths: string[] = [];
            const workspaceFolder = this.settings.getWorkspaceFolder();
            const scanLocalFiles = async (dirUri: vscode.Uri, basePath: string = '/'): Promise<void> => {
                try {
                    const entries = await vscode.workspace.fs.readDirectory(dirUri);
                    for (const [name, type] of entries) {
                        const relativePath = basePath + name;
                        const fullPath = type === vscode.FileType.Directory ? relativePath + '/' : relativePath;

                        // Skip ignored files
                        if (this.ignoreParser.shouldIgnore(fullPath)) continue;

                        if (type === vscode.FileType.Directory) {
                            await scanLocalFiles(vscode.Uri.joinPath(dirUri, name), fullPath);
                        } else {
                            // Check if this file is known to Overleaf or baseContent
                            if (!this.fileTreeByPath.has(fullPath) && !this.baseContent.has(fullPath)) {
                                localOnlyPaths.push(fullPath);
                            }
                        }
                    }
                } catch (error) {
                    debugLog(`Error scanning directory: ${basePath}`, error);
                }
            };
            await scanLocalFiles(workspaceFolder);
            if (localOnlyPaths.length > 0) {
                await this.handleLocalOnlyFiles(localOnlyPaths);
            }

            await this.settings.updateLastSynced();

            if (this.onlineText && !this.localWatcher) this.setupLocalWatcher();
            const message = `Pull complete: ${downloadedCount} downloaded, ${skippedCount} skipped, ${conflictCount} conflicts`;
            debugLog('pullAll:', message);
            this.setStatus('idle', message);
        } catch (error) {
            const authErr = isAuthError(error);
            this.setStatus('error', authErr ? 'Session expired' : `Pull failed: ${error}`, undefined, authErr);
            throw error;
        }
    }

    /**
     * Disconnect and cleanup
     */
    disconnect(): void {
        for (const [timer, resolve] of this.delayedTasks) {
            clearTimeout(timer);
            resolve();
        }
        this.delayedTasks.clear();
        this.onlineText?.dispose();
        this.onlineText = undefined;
        this.socket?.disconnect();
        this.socket = undefined;
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
        this.localWatcher = undefined;
        this.setStatus('disconnected');
        const release = this.releaseSession;
        this.releaseSession = undefined;
        if (release) {
            this.releasing = release();
            void this.releasing.catch((error) => this.log(`Project lease release failed: ${error}`));
        }
    }
}
