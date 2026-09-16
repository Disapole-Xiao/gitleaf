import { BaseAPI, HistoryDiff, HistoryFile, HistoryPage, HistoryUpdate, HistoryLabel } from '../api/base';
import { Credentials } from '../core/credentials';
import { ProjectStore } from '../core/projectStore';
import { CommitFile } from './gitRepository';
import { historyRequestsFor } from '../api/historyRequest';
import { sharedHistoryRequest } from '../core/historyCache';
import { HistorySnapshot, readHistoryArchive } from './historySnapshot';

/** History API segments are unchanged/deleted/inserted text, not Git commits. */
export function historyTexts(response: HistoryDiff): { before: string; after: string } {
    if (!Array.isArray(response.diff)) throw new Error('This history entry has no text diff (it may be binary or outside your history access).');
    return {
        before: response.diff.map(part => (part.u || '') + (part.d || '')).join(''),
        after: response.diff.map(part => (part.u || '') + (part.i || '')).join(''),
    };
}

export function historyFile(file: HistoryFile): CommitFile | undefined {
    // Undefined operation means unchanged: do not invent a modification badge.
    const statuses: Record<string, string> = { added: 'A', edited: 'M', removed: 'D', renamed: 'R' };
    const status = statuses[file.operation || ''];
    if (!status) return;
    return { status, path: file.newPathname || file.pathname,
        originalPath: file.newPathname ? file.pathname : undefined };
}

export interface RemoteHistorySource {
    snapshot(version: number): Promise<HistorySnapshot>;
    list(before?: number): Promise<HistoryPage>;
    files(update: HistoryUpdate): Promise<CommitFile[]>;
    texts(update: HistoryUpdate, pathname: string): Promise<{ before: string; after: string }>;
}

/** Read-only history access, separate from Fetch/Pull and the live sync socket. */
export class OverleafHistory implements RemoteHistorySource {
    private api?: BaseAPI;
    private server?: string;
    private latestStale = false;
    private recent?: HistoryPage;
    constructor(private readonly settings: ProjectStore, private readonly credentials: Pick<Credentials, 'getCredential'>,
        private readonly log: (message: string) => void = () => {}) {}

    private async request<T>(operation: (api: BaseAPI, project: string) => Promise<T>): Promise<T> {
        const project = this.settings.getSettings();
        if (!project) throw new Error('Link an Overleaf project to view its history.');
        const credential = await this.credentials.getCredential(project.serverUrl);
        if (!credential) throw new Error('Log in to Overleaf to view server history.');
        if (!this.api || this.server !== project.serverUrl) {
            this.server = project.serverUrl;
            this.api = new BaseAPI(project.serverUrl, this.log);
        }
        return operation(this.api.setIdentity(credential.identity), project.projectId);
    }

    private async queued<T>(key: string, lifetime: number, request: () => Promise<T>, fresh = false): Promise<T> {
        const project = this.settings.getSettings();
        if (!project) throw new Error('Link an Overleaf project to view history.');
        const credential = await this.credentials.getCredential(project.serverUrl);
        if (!credential) throw new Error('Log in to Overleaf to view history.');
        const queue = historyRequestsFor(project.serverUrl, credential.userId);
        if (fresh) queue.invalidate(key);
        return queue.run(key, lifetime, () => sharedHistoryRequest(project.serverUrl, credential.userId, key, lifetime, fresh, request));
    }

    private key(kind: string, ...parts: unknown[]): string {
        const project = this.settings.getSettings();
        return JSON.stringify([project?.serverUrl, project?.projectId, kind, ...parts]);
    }

    async list(before?: number, fresh = false): Promise<HistoryPage> {
        if (before === undefined && this.latestStale) { fresh = true; this.latestStale = false; }
        // Recent groups and labels can change: cache briefly, not forever.
        const page = await this.queued(this.key('list', before), 30000,
            () => this.request((api, project) => api.getHistory(project, before)), fresh);
        if (before === undefined) this.recent = page;
        return page;
    }

    async currentVersion(flush = false): Promise<number> {
        if (flush) await this.queued(this.key('flush'), 0, () => this.request((api, project) => api.flushHistory(project)));
        const page = await this.list(undefined, true);
        const version = Math.max(0, ...page.updates.map(update => update.toV));
        if (!Number.isSafeInteger(version)) throw new Error('Overleaf returned an invalid history version.');
        return version;
    }

    async label(version: number, comment: string): Promise<HistoryLabel> {
        const existing = this.recent?.updates.flatMap(update => update.labels || []).find(label => label.version === version && label.comment === comment);
        if (existing) return existing;
        this.latestStale = true;
        return this.queued(this.key('label', version, comment), 0,
            () => this.request((api, project) => api.labelHistory(project, version, comment)));
    }

    async ensureBoundary(version: number): Promise<void> {
        if (this.recent?.updates.some(update => update.labels?.some(label => label.version === version))) return;
        await this.label(version, 'GitLeaf sync base');
    }

    restore(version: number): Promise<unknown> {
        this.latestStale = true;
        return this.queued(this.key('restore', version), 0,
            () => this.request((api, project) => api.restoreHistory(project, version)));
    }

    snapshot(version: number): Promise<HistorySnapshot> {
        // A zero lifetime preserves account-wide pacing/429 cooldown across
        // processes without serializing binary snapshots into the JSON cache.
        return this.queued(this.key('snapshot', version), 0,
            async () => readHistoryArchive(await this.request((api, project) => api.downloadHistoryVersion(project, version))));
    }

    async files(update: HistoryUpdate): Promise<CommitFile[]> {
        const result = await this.queued(this.key('files', update.fromV, update.toV), Infinity,
            () => this.request((api, project) => api.getHistoryFiles(project, update.fromV, update.toV)));
        return result.diff.map(historyFile).filter((file): file is CommitFile => !!file);
    }

    async texts(update: HistoryUpdate, pathname: string): Promise<{ before: string; after: string }> {
        return this.queued(this.key('text', update.fromV, update.toV, pathname), Infinity,
            async () => historyTexts(await this.request((api, project) => api.getHistoryDiff(project, pathname, update.fromV, update.toV))));
    }
}
