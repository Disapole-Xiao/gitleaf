import { promises as fs } from 'fs';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { BaseAPI, ProjectEntity, FileEntity, FolderEntity } from '../api/base';
import { SocketIOAPI, DocumentUpdate } from '../api/socketio';
import { diffText } from '../sync/textSession';
import { ProjectStore } from './projectStore';
import { IgnoreParser } from '../sync/ignoreParser';
/** Editor buffers are an adapter, never a VS Code dependency of the transport. */
export interface OnlineDocuments {
    readonly revision: number;
    open(id: string, path: string, local?: boolean): Promise<void>;
    flush(): Promise<void>;
    has(id: string): boolean;
    text(id: string): string | undefined;
    remove(id: string): void;
    receive(update: DocumentUpdate): void;
    dispose(): void;
}
interface FileCache {
    hash: number;
    timestamp: number;
}

export type SyncStatus = 'idle' | 'syncing' | 'pulling' | 'pushing' | 'error' | 'disconnected';

export interface SyncStatusEvent {
    status: SyncStatus;
    message?: string;
    file?: string;
    authError?: boolean;
}

export interface PushPlan {
    creates: string[];
    updates: string[];
    deletes: string[];
}

export function snapshotFingerprint(snapshot: ReadonlyMap<string, Uint8Array>): string {
    const hash = createHash('sha256');
    for (const [path, content] of Array.from(snapshot.entries()).sort(([a], [b]) => a.localeCompare(b))) {
        hash.update(path, 'utf8');
        hash.update(new Uint8Array([0]));
        hash.update(content);
        hash.update(new Uint8Array([0]));
    }
    return hash.digest('hex');
}

export function hashContent(content: Uint8Array | undefined): number {
    if (!content) return -1;
    const str = new TextDecoder().decode(content);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const chr = str.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0;
    }
    return hash;
}

export function contentEquals(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
    if (a === b) return true;
    if (!a || !b) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

const DEBUG = false;

export function debugLog(...args: unknown[]): void {
    if (DEBUG) {
        console.log('[GitLeaf]', ...args);
    }
}

export function ensureApiSuccess(result: { type: 'success' | 'error'; message?: string }, action: string): void {
    if (!result || result.type !== 'success') {
        throw new Error(`${action}: ${result?.message || 'unknown Overleaf API error'}`);
    }
}

export interface FileTreeEntry {
    id: string;
    type: 'doc' | 'file' | 'folder';
    name: string;
    path: string;
    parentId?: string;
}
/** Shared tested Overleaf protocol; both UI adapters use these same mutations. */
export class RemoteProject {
    protected _status: SyncStatus = 'disconnected';
    protected onlineText?: OnlineDocuments;
    private readonly events = new EventEmitter();
    readonly onStatusChange = (listener: (event: SyncStatusEvent) => void) => {
        this.events.on('status', listener);
        return {
            dispose: () => {
                this.events.off('status', listener);
            },
        };
    };
    constructor(
        protected readonly api: BaseAPI,
        protected readonly settings: ProjectStore,
        logFn?: (message: string) => void,
    ) {
        this.ignoreParser = new IgnoreParser(settings.root, settings.getSettings());
        this.logFn = logFn;
    }
    protected setStatus(status: SyncStatus, message?: string, file?: string, authError = false): void {
        this._status = status;
        this.events.emit('status', { status, message, file, authError });
    }
    protected configureSocket(_readOnly: boolean): void {
        // Short-lived offline connections observe metadata only. Never
        // touch the worktree in response to a server event in offline mode.
        this.socket!.registerHandlers({
            onFileCreated: (parentId, type, entity) => {
                const parent = this.fileTree.get(parentId);
                const entry: FileTreeEntry = {
                    id: entity._id,
                    type,
                    name: entity.name,
                    path: (parent?.path || '/') + entity.name + (type === 'folder' ? '/' : ''),
                    parentId,
                };
                this.fileTree.set(entry.id, entry);
                this.fileTreeByPath.set(entry.path, entry);
                this.treeVersion++;
            },
            onFileRenamed: (id, name) => this.updateRemoteTreePath(id, name),
            onFileMoved: (id, parentId) => this.updateRemoteTreePath(id, undefined, parentId),
            onFileRemoved: (id) => {
                const removed = this.fileTree.get(id);
                if (!removed) return;
                for (const entry of this.fileTree.values()) {
                    if (entry.id === id || (removed.type === 'folder' && entry.path.startsWith(removed.path))) {
                        this.fileTree.delete(entry.id);
                        this.fileTreeByPath.delete(entry.path);
                    }
                }
                this.treeVersion++;
            },
        });
    }
    async connect(readOnly = false): Promise<void> {
        const projectSettings = this.settings.getSettings();
        if (!projectSettings) {
            throw new Error('Project not configured');
        }

        this.setStatus('syncing', 'Connecting...');

        // Load ignore patterns
        await this.ignoreParser.load();

        // Create socket connection
        const identity = this.api.getIdentity();
        if (!identity) {
            throw new Error('Not authenticated');
        }

        this.socket = new SocketIOAPI(this.api, identity, projectSettings.projectId);
        this.configureSocket(readOnly);
        this.socket.registerHandlers({
            onDisconnected: (authError) =>
                this.setStatus(
                    authError ? 'error' : 'disconnected',
                    authError ? 'Session expired' : 'Disconnected; local edits remain on disk',
                    undefined,
                    authError,
                ),
        });
        try {
            this.project = await this.socket.joinProject();
            if (!this.project.rootFolder?.length) throw new Error('Overleaf returned no folder tree.');
            this.buildFileTree(this.project);
            this.setStatus('idle', 'Connected');
        } catch (error) {
            this.disconnect();
            throw error;
        }
        // Watchers start only after the initial download has finished.
    }
    protected socket?: SocketIOAPI;

    protected project?: ProjectEntity;

    protected fileTree: Map<string, FileTreeEntry> = new Map();

    protected fileTreeByPath: Map<string, FileTreeEntry> = new Map();

    protected fileCache: Map<string, FileCache> = new Map();

    protected baseContent: Map<string, Uint8Array> = new Map();

    protected ignoreParser: IgnoreParser;

    protected joinedDocs: Set<string> = new Set();

    protected treeVersion = 0;

    protected suppressedRemoteDeletes: Set<string> = new Set();

    protected suppressedRemoteRenames: Map<string, Set<string>> = new Map();

    protected logFn?: (message: string) => void;

    protected log(message: string): void {
        this.logFn?.(message);
    }

    get status(): SyncStatus {
        return this._status;
    }

    protected updateRemoteTreePath(id: string, name?: string, parentId?: string): void {
        const entry = this.fileTree.get(id);
        if (!entry) return;
        const previous = entry.path;
        const parent = this.fileTree.get(parentId || entry.parentId || '');
        entry.name = name || entry.name;
        entry.parentId = parentId || entry.parentId;
        entry.path = (parent?.path || '/') + entry.name + (entry.type === 'folder' ? '/' : '');
        this.fileTreeByPath.delete(previous);
        this.fileTreeByPath.set(entry.path, entry);
        if (entry.type === 'folder') {
            for (const child of this.fileTree.values()) {
                if (child.id === entry.id || !child.path.startsWith(previous)) continue;
                this.fileTreeByPath.delete(child.path);
                child.path = entry.path + child.path.slice(previous.length);
                this.fileTreeByPath.set(child.path, child);
            }
        }
        this.treeVersion++;
    }

    protected buildFileTree(project: ProjectEntity): void {
        debugLog('buildFileTree: Building tree for project', project.name);
        debugLog('buildFileTree: rootFolder count:', project.rootFolder?.length || 0);

        this.fileTree.clear();
        this.fileTreeByPath.clear();

        const traverse = (folder: FolderEntity, parentPath: string, parentId?: string, isRoot: boolean = false) => {
            // For root folder, don't add the folder itself, just its contents at /
            const folderPath = isRoot ? '/' : parentPath + folder.name + '/';

            // Add folder entry (skip for root folder)
            if (!isRoot) {
                const folderEntry: FileTreeEntry = {
                    id: folder._id,
                    type: 'folder',
                    name: folder.name,
                    path: folderPath,
                    parentId,
                };
                this.fileTree.set(folder._id, folderEntry);
                this.fileTreeByPath.set(folderPath, folderEntry);
            } else {
                // Store root folder ID for reference
                const rootEntry: FileTreeEntry = {
                    id: folder._id,
                    type: 'folder',
                    name: '',
                    path: '/',
                    parentId: undefined,
                };
                this.fileTree.set(folder._id, rootEntry);
                this.fileTreeByPath.set('/', rootEntry);
            }

            // Add docs
            for (const doc of folder.docs || []) {
                const docPath = folderPath + doc.name;
                const entry: FileTreeEntry = {
                    id: doc._id,
                    type: 'doc',
                    name: doc.name,
                    path: docPath,
                    parentId: folder._id,
                };
                this.fileTree.set(doc._id, entry);
                this.fileTreeByPath.set(docPath, entry);
                debugLog('buildFileTree: Added doc', docPath);
            }

            // Add file refs
            for (const file of folder.fileRefs || []) {
                const filePath = folderPath + file.name;
                const entry: FileTreeEntry = {
                    id: file._id,
                    type: 'file',
                    name: file.name,
                    path: filePath,
                    parentId: folder._id,
                };
                this.fileTree.set(file._id, entry);
                this.fileTreeByPath.set(filePath, entry);
                debugLog('buildFileTree: Added file', filePath);
            }

            // Recurse into subfolders
            for (const subfolder of folder.folders || []) {
                traverse(subfolder as FolderEntity, folderPath, folder._id, false);
            }
        };

        // Start from root folder - treat it as root (don't include its name in paths)
        if (project.rootFolder && project.rootFolder.length > 0) {
            traverse(project.rootFolder[0], '', undefined, true);
        }

        debugLog('buildFileTree: Total entries:', this.fileTree.size);
    }

    async detectMainDocument(): Promise<void> {
        if (!this.project?.rootDoc_id) return;

        const rootDocEntry = this.fileTree.get(this.project.rootDoc_id);
        if (!rootDocEntry || rootDocEntry.type !== 'doc') return;

        const mainTex = rootDocEntry.path.startsWith('/')
            ? rootDocEntry.path.slice(1) // Remove leading slash
            : rootDocEntry.path;
        const mainPdf = mainTex.replace(/\.tex$/, '.pdf');

        const currentSettings = this.settings.getSettings();
        if (currentSettings && (currentSettings.mainTex !== mainTex || currentSettings.mainPdf !== mainPdf)) {
            await this.settings.update({ mainTex, mainPdf });
            this.ignoreParser.updateSettings({ ...currentSettings, mainTex, mainPdf });
            debugLog('Updated main document:', mainTex, mainPdf);
        }
    }

    protected suppressRemoteRename(entityId: string, newName: string): void {
        const names = this.suppressedRemoteRenames.get(entityId) || new Set<string>();
        names.add(newName);
        this.suppressedRemoteRenames.set(entityId, names);
    }

    protected consumeSuppressedRemoteRename(entityId: string, newName: string): boolean {
        const names = this.suppressedRemoteRenames.get(entityId);
        if (!names?.delete(newName)) {
            return false;
        }
        if (names.size === 0) {
            this.suppressedRemoteRenames.delete(entityId);
        }
        return true;
    }

    protected async pushDocumentChanges(
        docId: string,
        path: string,
        newContent: Uint8Array,
        expectedContent?: Uint8Array,
    ): Promise<boolean> {
        if (!this.socket) throw new Error('Document connection unavailable.');
        if (this.onlineText) {
            // Disk watcher echoes must never replace the live OT snapshot.
            await this.onlineText.open(docId, path, true);
            await this.onlineText.flush();
            return true;
        }
        // Explicit offline push: submit once, without stale-snapshot retries.
        const { lines, version } = await this.socket.joinDoc(docId);
        if (expectedContent && lines.join('\n') !== new TextDecoder().decode(expectedContent)) {
            throw new Error(`${path} changed on Overleaf during the push. Fetch and pull before retrying.`);
        }
        const op = diffText(lines.join('\n'), new TextDecoder().decode(newContent));
        if (op.length) await this.socket.applyOtUpdate(docId, { doc: docId, op, v: version });
        this.joinedDocs.add(docId);
        return op.length > 0;
    }

    protected async refreshProjectFileTree(): Promise<void> {
        // File events update these maps. Rebuilding from the original join
        // would resurrect renamed/deleted paths.
        if (!this.project?.rootFolder?.length) throw new Error('No project folder tree. Reconnect to Overleaf.');
    }

    protected trackUploadedEntity(
        result: { file?: FileEntity },
        parentId: string,
        name: string,
        path: string,
    ): FileTreeEntry | undefined {
        if (!result.file?._id) {
            return undefined;
        }

        const entry: FileTreeEntry = {
            id: result.file._id,
            type: result.file._type || 'file',
            name: result.file.name || name,
            path,
            parentId,
        };
        this.fileTree.set(entry.id, entry);
        this.fileTreeByPath.set(path, entry);
        debugLog('Tracked uploaded file:', path, entry.id);
        return entry;
    }

    protected async createTextDocumentWithContent(
        projectId: string,
        parentId: string,
        relativePath: string,
        name: string,
        content: Uint8Array,
    ): Promise<void> {
        // Set this before creating the document so its socket acknowledgement
        // is recognized as an echo of the local operation.
        this.baseContent.set(relativePath, content);
        const result = await this.api.addDoc(projectId, parentId, name);
        ensureApiSuccess(result, `Create ${relativePath}`);

        let entry: FileTreeEntry | undefined;
        if (result.doc?._id) {
            entry = {
                id: result.doc._id,
                type: 'doc',
                name: result.doc.name || name,
                path: relativePath,
                parentId,
            };
            this.fileTree.set(entry.id, entry);
            this.fileTreeByPath.set(relativePath, entry);
        } else {
            await this.refreshProjectFileTree();
            entry = this.fileTreeByPath.get(relativePath);
        }

        if (!entry || entry.type !== 'doc') {
            throw new Error(`Create ${relativePath}: new document was not returned by Overleaf`);
        }
        if (!this.socket) {
            throw new Error(`Create ${relativePath}: real-time connection is required to write document content`);
        }

        await this.pushDocumentChanges(entry.id, relativePath, content, new Uint8Array());
    }

    protected async deleteRemoteEntry(entry: FileTreeEntry, preserveLocal = false): Promise<void> {
        const projectSettings = this.settings.getSettings()!;
        if (preserveLocal) {
            this.suppressedRemoteDeletes.add(entry.id);
        }

        const result = await this.api.deleteEntity(projectSettings.projectId, entry.type, entry.id);
        try {
            ensureApiSuccess(result, `Delete ${entry.path}`);
        } catch (error) {
            this.suppressedRemoteDeletes.delete(entry.id);
            throw error;
        }

        this.fileTree.delete(entry.id);
        this.onlineText?.remove(entry.id);
        this.suppressedRemoteRenames.delete(entry.id);
        if (this.fileTreeByPath.get(entry.path)?.id === entry.id) {
            this.fileTreeByPath.delete(entry.path);
        }
        if (!preserveLocal) {
            this.baseContent.delete(entry.path);
            this.fileCache.delete(entry.path);
        }
    }

    protected async renameRemoteEntry(entry: FileTreeEntry, name: string, action: string): Promise<void> {
        const projectSettings = this.settings.getSettings()!;
        this.suppressRemoteRename(entry.id, name);
        try {
            const result = await this.api.renameEntity(projectSettings.projectId, entry.type, entry.id, name);
            ensureApiSuccess(result, action);
        } catch (error) {
            this.consumeSuppressedRemoteRename(entry.id, name);
            throw error;
        }
    }

    protected async replaceRemoteFile(entry: FileTreeEntry, content: Uint8Array): Promise<void> {
        // Socket rename/move acknowledgements mutate the live tree entry while
        // HTTP requests are pending. Keep the upload and rollback target stable.
        entry = { ...entry };
        if (!entry.parentId) {
            throw new Error(`Replace ${entry.path}: parent folder is unknown`);
        }

        const projectSettings = this.settings.getSettings()!;
        const previousContent = this.baseContent.get(entry.path);
        const suffix = `.gitleaf-${entry.id.slice(-12)}-${Date.now().toString(36)}`;
        const temporaryName = `${entry.name.slice(0, Math.max(1, 150 - suffix.length))}${suffix}`;
        let renamedOriginal = false;
        let uploadedReplacement = false;

        this.baseContent.set(entry.path, content);
        try {
            // Move the original aside and keep it as a rollback copy until
            // the replacement is tracked.
            await this.renameRemoteEntry(entry, temporaryName, `Prepare replacement for ${entry.path}`);
            renamedOriginal = true;

            const result = await this.api.uploadFile(projectSettings.projectId, entry.parentId, entry.name, content);
            ensureApiSuccess(result, `Upload ${entry.path}`);
            uploadedReplacement = true;

            if (!this.trackUploadedEntity(result, entry.parentId, entry.name, entry.path)) {
                await this.refreshProjectFileTree();
            }

            const originalEntry = this.fileTree.get(entry.id) || entry;
            await this.deleteRemoteEntry(originalEntry, true);
            this.fileCache.set(entry.path, { hash: hashContent(content), timestamp: Date.now() });
        } catch (error) {
            if (renamedOriginal && !uploadedReplacement) {
                try {
                    await this.renameRemoteEntry(entry, entry.name, `Restore ${entry.path} after failed replacement`);
                } catch (restoreError) {
                    const replacementMessage = error instanceof Error ? error.message : String(error);
                    const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
                    if (previousContent !== undefined) {
                        this.baseContent.set(entry.path, previousContent);
                    } else {
                        this.baseContent.delete(entry.path);
                    }
                    throw new Error(
                        `${replacementMessage}; the original file remains on Overleaf under ` +
                            `${temporaryName} because restoring its name failed: ${restoreMessage}`,
                    );
                }
            }

            if (!uploadedReplacement) {
                if (previousContent !== undefined) {
                    this.baseContent.set(entry.path, previousContent);
                } else {
                    this.baseContent.delete(entry.path);
                }
            }
            throw error;
        }
    }

    protected async leaveAllDocs(): Promise<void> {
        if (!this.socket) return;

        for (const docId of this.joinedDocs) {
            try {
                await this.socket.leaveDoc(docId);
            } catch {
                // Ignore leave errors
            }
        }
        this.joinedDocs.clear();
    }

    protected async ensureParentFoldersExist(relativePath: string): Promise<string> {
        const projectSettings = this.settings.getSettings()!;
        const rootFolderId = this.project?.rootFolder[0]._id;

        if (!rootFolderId) {
            throw new Error('Project root folder not found');
        }

        // Get parent path (e.g., "/tex/chapters/" from "/tex/chapters/intro.tex")
        const parentPath = relativePath.substring(0, relativePath.lastIndexOf('/') + 1) || '/';

        // If parent exists, return its ID
        const existingParent = this.fileTreeByPath.get(parentPath);
        if (existingParent) {
            return existingParent.id;
        }

        // If parent is root, return root ID
        if (parentPath === '/') {
            return rootFolderId;
        }

        // Parse path into folder segments (e.g., ["tex", "chapters"])
        const segments = parentPath.split('/').filter((s) => s.length > 0);

        let currentPath = '/';
        let currentParentId = rootFolderId;

        for (const segment of segments) {
            const folderPath = currentPath + segment + '/';
            const existingFolder = this.fileTreeByPath.get(folderPath);

            if (existingFolder) {
                // Folder exists, move to next level
                currentParentId = existingFolder.id;
                currentPath = folderPath;
            } else {
                // Folder doesn't exist, create it
                debugLog('Creating missing parent folder:', folderPath);
                const result = await this.api.addFolder(projectSettings.projectId, currentParentId, segment);

                if (result.type !== 'success' || !result.folder) {
                    throw new Error(`Failed to create folder ${folderPath}: ${result.message}`);
                }

                // Add to file tree
                const folderEntry: FileTreeEntry = {
                    id: result.folder._id,
                    type: 'folder',
                    name: segment,
                    path: folderPath,
                    parentId: currentParentId,
                };
                this.fileTree.set(result.folder._id, folderEntry);
                this.fileTreeByPath.set(folderPath, folderEntry);
                this.baseContent.set(folderPath, new Uint8Array(0));

                this.log(`Created folder on Overleaf: ${folderPath}`);

                currentParentId = result.folder._id;
                currentPath = folderPath;
            }
        }

        return currentParentId;
    }

    protected async uploadLocalFile(relativePath: string, committedContent?: Uint8Array): Promise<void> {
        const projectSettings = this.settings.getSettings()!;
        const content = committedContent || (await fs.readFile(this.settings.file(relativePath)));

        // Ensure all parent folders exist (creates them if needed)
        const parentId = await this.ensureParentFoldersExist(relativePath);

        const name = relativePath.split('/').pop()!;
        const isTextFile = this.isTextFile(name);

        this.setStatus('pushing', `Uploading ${relativePath}`, relativePath);

        if (isTextFile) {
            await this.createTextDocumentWithContent(projectSettings.projectId, parentId, relativePath, name, content);
        } else {
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

    async readRemoteSnapshot(): Promise<Map<string, Uint8Array>> {
        if (!this.project) throw new Error('Not connected');
        await this.ignoreParser.load();
        await this.refreshProjectFileTree();
        const treeVersion = this.treeVersion;

        const projectId = this.settings.getSettings()!.projectId;
        const snapshot = new Map<string, Uint8Array>();
        for (const entry of this.fileTree.values()) {
            if (entry.type === 'folder' || this.ignoreParser.shouldIgnore(entry.path)) continue;

            let content: Uint8Array;
            if (entry.type === 'doc') {
                if (this.onlineText?.has(entry.id)) {
                    await this.onlineText.flush();
                    content = Buffer.from(this.onlineText.text(entry.id)!);
                } else if (this.socket) {
                    const joined = await this.socket.joinDoc(entry.id);
                    content = new TextEncoder().encode(joined.lines.join('\n'));
                    await this.socket.leaveDoc(entry.id);
                } else {
                    const result = await this.api.getDocContent(projectId, entry.id);
                    ensureApiSuccess(result, `Download ${entry.path}`);
                    content = new TextEncoder().encode((result.lines || []).join('\n'));
                }
            } else {
                const result = await this.api.getFile(projectId, entry.id);
                ensureApiSuccess(result, `Download ${entry.path}`);
                content = result.content || new Uint8Array();
            }
            snapshot.set(entry.path.replace(/^\//, ''), content);
        }
        if (treeVersion !== this.treeVersion)
            throw new Error('Overleaf file tree changed while downloading. Retry the fetch.');
        return snapshot;
    }

    async createPushPlan(
        remote: ReadonlyMap<string, Uint8Array>,
        local: ReadonlyMap<string, Uint8Array>,
    ): Promise<PushPlan> {
        const creates: string[] = [];
        const updates: string[] = [];
        const deletes: string[] = [];
        for (const [path, content] of local) {
            const remoteContent = remote.get(path);
            if (!remoteContent) creates.push(path);
            else if (!contentEquals(content, remoteContent)) updates.push(path);
        }
        for (const path of remote.keys()) {
            if (!local.has(path)) deletes.push(path);
        }
        return { creates: creates.sort(), updates: updates.sort(), deletes: deletes.sort() };
    }

    async applyPushPlan(
        plan: PushPlan,
        expectedRemoteFingerprint: string,
        local: ReadonlyMap<string, Uint8Array>,
    ): Promise<void> {
        const freshRemote = await this.readRemoteSnapshot();
        if (snapshotFingerprint(freshRemote) !== expectedRemoteFingerprint) {
            throw new Error('Overleaf changed while preparing the push. Pull again before pushing.');
        }

        this.setStatus('pushing', 'Uploading committed snapshot...');
        for (const path of plan.deletes) {
            const entry = this.fileTreeByPath.get(`/${path}`);
            if (!entry || entry.type === 'folder') {
                throw new Error(`Refusing unplanned remote deletion: ${path}`);
            }
            await this.deleteRemoteEntry(entry, true);
        }

        for (const path of [...plan.creates, ...plan.updates]) {
            const content = local.get(path);
            if (!content) throw new Error(`Local file changed while pushing: ${path}`);
            const remotePath = `/${path}`;
            const entry = this.fileTreeByPath.get(remotePath);
            if (!entry) {
                await this.uploadLocalFile(remotePath, content);
            } else if (entry.type === 'doc') {
                await this.pushDocumentChanges(entry.id, remotePath, content, freshRemote.get(path));
            } else if (entry.type === 'file') {
                await this.replaceRemoteFile(entry, content);
            }
        }
        const after = await this.readRemoteSnapshot();
        if (snapshotFingerprint(after) !== snapshotFingerprint(local)) {
            throw new Error(
                'Overleaf changed during the push. Uploaded files were kept; fetch/pull to reconcile before pushing again.',
            );
        }
        await this.settings.updateLastSynced();
        this.setStatus('idle', 'Push complete');
    }

    protected isTextFile(filename: string): boolean {
        const textExtensions = [
            '.tex',
            '.bib',
            '.cls',
            '.sty',
            '.txt',
            '.md',
            '.rst',
            '.json',
            '.xml',
            '.yaml',
            '.yml',
            '.csv',
            '.tsv',
            '.gitignore',
            '.latexmkrc',
            'makefile',
            '.gitleafignore',
        ];
        const lower = filename.toLowerCase();
        return textExtensions.some((ext) => lower.endsWith(ext) || lower === ext.slice(1));
    }

    getSocket(): SocketIOAPI | undefined {
        return this.socket;
    }

    getFileTree(): Map<string, FileTreeEntry> {
        return this.fileTree;
    }
    disconnect(): void {
        this.onlineText?.dispose();
        this.onlineText = undefined;
        this.socket?.disconnect();
        this.socket = undefined;
        this.setStatus('disconnected');
    }
}
