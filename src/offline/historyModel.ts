import * as vscode from 'vscode';
import * as path from 'path';
import { HistoryUpdate } from '../api/base';
import { CommitFile, CommitInfo, GitRepository } from './gitRepository';
import type { GitContentProvider } from './scmProvider';
import { RemoteHistorySource } from './remoteHistory';
import { PublicationState } from './publications';
import { HistorySyncState, isHistoryNodeSynced } from './historyState';

export type HistoryAction = 'label' | 'restore' | 'hard' | 'soft';
export interface HistoryPosition { baseVersion?: number }

export type HistoryCommitNode =
    | { kind: 'local'; id: string; commit: CommitInfo; labels?: string[]; pending?: boolean }
    | { kind: 'remote'; id: string; update: HistoryUpdate; commit?: CommitInfo };
export type HistoryNode = HistoryCommitNode
    | { kind: 'file'; id: string; parent: HistoryCommitNode; file: CommitFile }
    | { kind: 'more'; source: 'local' | 'remote' };

/** History data and native diffs, independent of the graph presentation. */
export class HistoryModel implements vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChange = this.changed.event;
    private readonly failed = new vscode.EventEmitter<unknown>();
    readonly onDidFail = this.failed.event;
    private local: HistoryCommitNode[] = [];
    private remote: HistoryCommitNode[] = [];
    private readonly files = new Map<string, Promise<HistoryNode[]>>();
    private localLimit = 100;
    private localHasMore = false;
    private remoteLimit = 5;
    private receipts: PublicationState = { published: [], labels: {} };
    private position: HistoryPosition = {};
    private nextBefore?: number;
    private remoteLoaded = false;
    private remoteKnown = false;
    private remoteEndReached = false;
    private loading?: Promise<void>;
    private disposed = false;

    constructor(
        private readonly repository: GitRepository,
        private readonly remoteSource: RemoteHistorySource,
        private readonly content: GitContentProvider,
        private readonly localFileResources: (commit: string, file: CommitFile) => Promise<readonly [vscode.Uri, vscode.Uri]>,
        readonly action: (node: HistoryCommitNode, action: HistoryAction) => Promise<void> = async () => {},
    ) {}

    async refreshLocal(): Promise<void> {
        const [commits, receipts, pulling] = await Promise.all([
            this.repository.unpublished(this.localLimit + 1), this.repository.publications.read(), this.repository.isRebasing(),
        ]);
        if (this.disposed) return;
        this.receipts = receipts;
        let baseVersion: number | undefined;
        if (!pulling) {
            if (receipts.integrated && await this.repository.isAncestorOfHead(receipts.integrated.gitHash)) {
                baseVersion = receipts.integrated.version;
            } else {
                const common = await this.repository.mergeBaseWithRemote();
                baseVersion = receipts.published.find(item => item.commit.hash === common)?.toV;
            }
        }
        this.position = { baseVersion };
        this.localHasMore = commits.length > this.localLimit;
        this.local = commits.slice(0, this.localLimit).filter(commit => !receipts.published.some(item => item.commit.hash === commit.hash))
            .map(commit => ({ kind: 'local', id: `git:${commit.hash}`, commit, labels: receipts.labels[commit.hash], pending: receipts.pending?.commit.hash === commit.hash }));
        this.changed.fire();
    }

    graphPosition(): HistoryPosition { return this.position; }

    syncState(): HistorySyncState {
        const base = this.position.baseVersion;
        const known = this.remoteKnown && base !== undefined;
        return {
            incoming: known ? this.remoteNodes().filter(node => !isHistoryNodeSynced(node, this.position)).length : undefined,
            outgoing: this.local.length,
            incomingComplete: known && (this.remoteEndReached
                || this.remote.some(node => node.kind === 'remote' && node.update.fromV <= base)),
            outgoingComplete: !this.localHasMore,
        };
    }

    private remoteNodes(limit = this.remote.length): HistoryCommitNode[] {
        const records: HistoryCommitNode[] = [];
        const remote = this.remote.filter((item): item is Extract<HistoryCommitNode, { kind: 'remote' }> => item.kind === 'remote')
            .sort((a, b) => b.update.toV - a.update.toV).slice(0, limit);
        for (const node of remote) {
            const cuts = new Set([node.update.fromV, node.update.toV]);
            for (const receipt of this.receipts.published) {
                for (const version of [receipt.fromV, receipt.toV]) if (version > node.update.fromV && version < node.update.toV) cuts.add(version);
            }
            const baseVersion = this.position.baseVersion;
            if (baseVersion !== undefined && baseVersion > node.update.fromV && baseVersion < node.update.toV) cuts.add(baseVersion);
            const versions = [...cuts].sort((a, b) => b - a);
            for (let index = 0; index < versions.length - 1; index++) {
                const toV = versions[index], fromV = versions[index + 1];
                const receipt = this.receipts.published.find(item => item.toV === toV);
                // A published snapshot can span multiple server summaries.
                // Verified receipts combine them; timestamps never do.
                if (this.receipts.published.some(item => toV < item.toV && toV > item.fromV)) continue;
                records.push({ kind: 'remote', id: `overleaf:${receipt?.fromV ?? fromV}:${toV}`, commit: receipt?.commit,
                    update: { ...node.update, fromV: receipt?.fromV ?? fromV, toV,
                        labels: node.update.labels?.filter(label => label.version === toV) } });
            }
        }
        return records;
    }

    private loadRemote(append = false): Promise<void> {
        if (this.loading) return this.loading;
        const before = append ? this.nextBefore : undefined;
        this.loading = (async () => {
            try {
                const page = await this.remoteSource.list(before);
                if (this.disposed) return;
                const records = new Map((append ? this.remote : []).map(node => [node.id, node]));
                for (const update of page.updates) {
                    const id = `overleaf:${update.fromV}:${update.toV}`;
                    records.set(id, { kind: 'remote', id, update });
                }
                this.remote = [...records.values()];
                this.nextBefore = page.nextBeforeTimestamp !== before ? page.nextBeforeTimestamp : undefined;
                this.remoteLoaded = true;
                this.remoteKnown = true;
                this.remoteEndReached = page.nextBeforeTimestamp === undefined;
                // Includes the lazy first page, not just explicit Graph refreshes.
                this.changed.fire();
            } catch (error) {
                if (!this.disposed) {
                    // Do not retry on every worktree event. Refresh explicitly retries.
                    this.remoteLoaded = true;
                    // Preserve local/cached records; presentation owns the native notification.
                    this.failed.fire(error);
                }
            }
        })().finally(() => { this.loading = undefined; });
        return this.loading;
    }

    async refresh(): Promise<void> {
        await Promise.all([this.refreshLocal(), this.loadRemote()]);
        if (!this.disposed) this.changed.fire();
    }

    async loadMore(source: 'local' | 'remote'): Promise<void> {
        if (source === 'local') { this.localLimit += 100; await this.refreshLocal(); }
        else {
            // min_count is a minimum, not a page-size cap. Reveal the cached
            // tail before requesting another server chunk.
            if (this.remoteLimit >= this.remote.length && this.nextBefore !== undefined) await this.loadRemote(true);
            this.remoteLimit += 5;
            this.changed.fire();
        }
    }

    async getChildren(node?: HistoryNode): Promise<HistoryNode[]> {
        if (!node) {
            if (!this.remoteLoaded) await this.loadRemote();
            return [
                ...this.local, ...this.remoteNodes(this.remoteLimit),
                ...(this.nextBefore !== undefined || this.remote.length > this.remoteLimit ? [{ kind: 'more' as const, source: 'remote' as const }] : []),
                ...(this.localHasMore ? [{ kind: 'more' as const, source: 'local' as const }] : []),
            ];
        }
        if (node.kind === 'file' || node.kind === 'more') return [];
        if (!this.files.has(node.id)) {
            const request = node.kind === 'local' || node.commit
                ? this.repository.filesInCommit(node.commit!.hash) : this.remoteSource.files(node.update);
            this.files.set(node.id, request.then(files => files.map(file => ({
                kind: 'file' as const, id: `${node.id}:${file.path}`, parent: node, file,
            }))).catch(error => { this.files.delete(node.id); throw error; }));
        }
        return this.files.get(node.id)!;
    }

    async open(node: HistoryNode): Promise<void> {
        if (node.kind !== 'file') return;
        const [left, right] = await this.changeResources(node);
        const title = node.parent.kind === 'local' || node.parent.commit
            ? `${node.file.path} (${node.parent.commit!.hash.slice(0, 8)})`
            : `${node.file.path} (Overleaf v${node.parent.update.fromV} ↔ v${node.parent.update.toV})`;
        if (this.disposed) return;
        await vscode.commands.executeCommand('vscode.diff', left, right, title);
    }

    async openAll(record: HistoryCommitNode): Promise<void> {
        const files = await this.getChildren(record);
        if (this.disposed) return;
        const changes: Array<[vscode.Uri, vscode.Uri, vscode.Uri]> = [];
        for (const node of files) {
            if (node.kind !== 'file') continue;
            const [before, after] = await this.changeResources(node);
            if (this.disposed) return;
            const label = vscode.Uri.file(path.join(this.repository.root, ...node.file.path.split('/')));
            changes.push([label, before, after]);
        }
        if (!changes.length) return;
        if (this.disposed) return;
        const title = record.kind === 'local' ? `Changes in ${record.commit.subject}`
            : `Changes in Overleaf v${record.update.toV}`;
        await vscode.commands.executeCommand('vscode.changes', title, changes);
    }

    private async changeResources(node: Extract<HistoryNode, { kind: 'file' }>): Promise<readonly [vscode.Uri, vscode.Uri]> {
        if (node.parent.kind === 'local' || node.parent.commit) return this.localFileResources(node.parent.commit!.hash, node.file);
        const update = node.parent.update;
        const texts = await this.remoteSource.texts(update, node.file.originalPath || node.file.path);
        const left = this.content.snapshot(this.repository.root, `overleaf-v${update.fromV}`, node.file.originalPath || node.file.path,
            node.file.status === 'A' ? '' : texts.before);
        const right = this.content.snapshot(this.repository.root, `overleaf-v${update.toV}`, node.file.path,
            node.file.status === 'D' ? '' : texts.after);
        return [left, right];
    }

    dispose(): void {
        this.disposed = true;
        this.changed.dispose();
        this.failed.dispose();
        this.files.clear();
    }
}
