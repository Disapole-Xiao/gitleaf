import { BaseAPI } from '../api/base';
import { GitRepository } from '../offline/gitRepository';
import { OverleafHistory } from '../offline/remoteHistory';
import { commitLabel } from '../offline/commitLabel';
import { OperationBlockedError } from '../offline/operationBlocked';
import { CredentialStore } from './credentials';
import { ProjectStore } from './projectStore';
import { RemoteProject, snapshotFingerprint, SyncStatusEvent } from './remoteProject';
import { withProjectLock } from './projectLock';
import { assertSavedEditors } from './editorState';
import { writeJson } from './projectStore';
import * as path from 'path';
import { IgnoreParser } from '../sync/ignoreParser';

export type ProjectCommand =
    | { type: 'initialize'; fetch: boolean }
    | {
          type:
              | 'status'
              | 'pull'
              | 'push'
              | 'fetch'
              | 'prepareOnline'
              | 'activateOnline'
              | 'enterOffline'
              | 'abortPull'
              | 'stashes';
      }
    | { type: 'stage' | 'unstage' | 'discard'; paths?: string[] }
    | { type: 'commit'; message: string }
    | { type: 'restore'; version: number }
    | { type: 'label'; version?: number; commit?: string; message: string }
    | { type: 'revert'; commit: string; mode: 'hard' | 'soft' }
    | { type: 'stash'; action: 'save' | 'apply' | 'pop' | 'drop'; message?: string; hash?: string }
    | { type: 'resolve'; path: string; strategy: 'manual' | 'local' | 'overleaf' }
    | { type: 'diff'; staged?: boolean; commit?: string; paths?: string[]; word?: boolean }
    | { type: 'history'; before?: number; local?: boolean }
    | { type: 'historyFiles' | 'historyDiff'; from: number; to: number; path?: string };

export interface ProjectOptions {
    confirm?: (message: string, action: string) => Promise<boolean>;
    checkEditors?: () => void;
    trash?: (path: string) => Promise<void>;
    log?: (message: string) => void;
    status?: (event: SyncStatusEvent) => void;
}

/** Public business API. CLI and editor call this same transaction boundary.
 * It never imports VS Code, prompts for input, or renders errors/diffs. */
export class GitLeafProject {
    readonly repository: GitRepository;
    readonly history: OverleafHistory;
    constructor(
        readonly store: ProjectStore,
        private readonly credentials: CredentialStore,
        private readonly options: ProjectOptions = {},
    ) {
        this.repository = new GitRepository(store.root);
        this.history = new OverleafHistory(store, credentials, options.log);
    }
    private async confirm(message: string, action: string): Promise<boolean> {
        if (!this.options.confirm) throw new OperationBlockedError(`Confirmation required: ${message}`);
        return this.options.confirm(message, action);
    }
    private async checkEditors(): Promise<void> {
        this.options.checkEditors?.();
        await assertSavedEditors(this.store.root);
    }

    async link(project: { serverUrl: string; projectId: string; projectName: string }): Promise<void> {
        await withProjectLock(this.store.root, async () => {
            if ((await this.store.isLinked()) || (await this.repository.exists()))
                throw new OperationBlockedError('This folder already has GitLeaf project data. Choose a new folder.');
            await this.checkEditors();
            await this.store.save(
                ProjectStore.createDefaultSettings(
                    project.serverUrl,
                    project.projectId,
                    project.projectName,
                    'offline',
                ),
            );
            const ignore = new IgnoreParser(this.store.root);
            if (!(await ignore.exists())) await ignore.createDefault();
            await this.repository.initialize();
            await this.clone();
        });
    }

    async execute(command: ProjectCommand): Promise<any> {
        if (!(await this.store.isLinked())) throw new OperationBlockedError('Link an Overleaf project first.');
        return withProjectLock(this.store.root, async () => {
            const settings = await this.store.load();
            if (!settings) throw new OperationBlockedError('Link an Overleaf project first.');
            if (settings.mode !== 'offline' && command.type !== 'prepareOnline' && command.type !== 'enterOffline')
                throw new OperationBlockedError('Switch the project Offline before Git operations.');
            if (!['status', 'diff', 'history', 'historyFiles', 'historyDiff', 'stashes'].includes(command.type))
                await this.checkEditors();
            try {
                switch (command.type) {
                    case 'enterOffline':
                        if (settings.mode === 'offline') return { mode: 'offline' };
                        if (
                            !(await this.confirm(
                                'Switch a detached Online project to Offline? Keep every local file and the last Git baseline unchanged. Previously synced edits may appear in Changes; inspect them and Fetch before reconciling.',
                                'Enter Offline',
                            ))
                        )
                            return { canceled: true };
                        await this.store.update({ mode: 'offline', autoSync: false });
                        return {
                            mode: 'offline',
                            baseline: 'last-trusted',
                            message:
                                'Local files preserved. Inspect Changes and Fetch to reconcile the detached session.',
                        };
                    case 'initialize':
                        await this.repository.initialize();
                        if (command.fetch && !(await this.repository.head())) await this.clone();
                        return { initialized: true };
                    case 'status':
                        return {
                            project: settings,
                            changes: await this.repository.status(),
                            remote: await this.repository.divergence(),
                        };
                    case 'stage':
                        await this.repository.stage(command.paths);
                        return { staged: true };
                    case 'unstage':
                        await this.repository.unstage(command.paths);
                        return { unstaged: true };
                    case 'commit': {
                        const message = command.message.replace(/\s+/g, ' ').trim();
                        if (!message) throw new OperationBlockedError('Commit message is required.');
                        const credential = await this.credentials.getCredential(settings.serverUrl);
                        if (!credential) throw new OperationBlockedError('Log in to Overleaf first.');
                        await this.repository.setAuthor(credential.userName, credential.userEmail);
                        const commit = await this.repository.commit(message);
                        const receipts = await this.repository.publications.read();
                        if (receipts.pendingPull && !(await this.repository.isRebasing())
                            && await this.repository.isAncestorOfHead(receipts.pendingPull.gitHash)) {
                            receipts.integrated = receipts.pendingPull;
                            delete receipts.pendingPull;
                            await this.repository.publications.write(receipts);
                        }
                        return { commit: commit || null };
                    }
                    case 'pull':
                        return await this.pull();
                    case 'push':
                        return await this.push();
                    case 'fetch':
                        await this.withRemote(async (remote) =>
                            this.repository.fetchRemoteSnapshot(await remote.readRemoteSnapshot()),
                        );
                        return { fetched: true };
                    case 'prepareOnline':
                        return await this.prepareOnline();
                    case 'activateOnline':
                        await this.prepareOnline();
                        await this.store.update({ mode: 'online', autoSync: true });
                        return { mode: 'online' };
                    case 'restore':
                        return await this.restore(command.version);
                    case 'label': {
                        if (!command.message.trim()) throw new OperationBlockedError('Label must not be empty.');
                        if (command.version !== undefined) {
                            this.version(command.version);
                            return await this.history.label(command.version, command.message.trim());
                        }
                        const commits = await this.repository.unpublished(100000);
                        if (!commits.some((commit) => commit.hash === command.commit))
                            throw new OperationBlockedError('Select an unpublished commit.');
                        const state = await this.repository.publications.read(),
                            hash = command.commit!;
                        state.labels[hash] = [...new Set([...(state.labels[hash] || []), command.message.trim()])];
                        await this.repository.publications.write(state);
                        return { labeled: hash };
                    }
                    case 'revert': {
                        const commits = await this.repository.unpublished(100000),
                            index = commits.findIndex((commit) => commit.hash === command.commit);
                        if (index < 0) throw new OperationBlockedError('This commit is no longer unpublished.');
                        if (
                            !(await this.confirm(
                                `Revert ${index + 1} local commit(s)? ${command.mode === 'hard' ? 'Their changes will be discarded.' : 'Their changes return to Staged Changes.'}`,
                                `${command.mode === 'hard' ? 'Hard' : 'Soft'} Revert`,
                            ))
                        )
                            return { canceled: true };
                        await this.checkEditors();
                        await this.repository.resetUnpublished(command.commit, command.mode);
                        return { reverted: index + 1 };
                    }
                    case 'discard':
                        return await this.discard(command.paths);
                    case 'stashes':
                        return this.repository.stashes();
                    case 'stash': {
                        await this.repository.assertSettled();
                        if (command.action === 'save') {
                            await this.repository.createStash(command.message || 'GitLeaf stash');
                            return { saved: true };
                        }
                        if (!command.hash) throw new OperationBlockedError('Select a stash hash.');
                        if (command.action === 'drop') {
                            if (!(await this.confirm('Delete the selected stash?', 'Drop Stash')))
                                return { canceled: true };
                            await this.repository.dropStash(command.hash);
                        } else await this.repository.applyStash(command.hash, command.action === 'pop');
                        return { action: command.action, stash: command.hash };
                    }
                    case 'resolve':
                        await this.repository.resolve(command.path, command.strategy);
                        return { resolved: command.path };
                    case 'abortPull': {
                        if (
                            !(await this.confirm(
                                'Abort the current pull and restore the pre-pull files?',
                                'Abort Pull',
                            ))
                        )
                            return { canceled: true };
                        await this.repository.abortPull();
                        const receipts = await this.repository.publications.read();
                        delete receipts.pendingPull;
                        await this.repository.publications.write(receipts);
                        return { aborted: true };
                    }
                    case 'diff':
                        return { patch: await this.repository.diff(command) };
                    case 'history':
                        return {
                            local: await this.repository.unpublished(100),
                            server: command.local ? undefined : await this.history.list(command.before),
                            publications: await this.repository.publications.read(),
                        };
                    case 'historyFiles':
                    case 'historyDiff': {
                        this.version(command.from);
                        this.version(command.to);
                        if (command.from >= command.to) throw new OperationBlockedError('History requires from < to.');
                        const update = {
                            fromV: command.from,
                            toV: command.to,
                            meta: { start_ts: 0, end_ts: 0, users: [] },
                            pathnames: [],
                        };
                        const files = await this.history.files(update);
                        if (command.type === 'historyFiles') return files;
                        const file = files.find((file) => file.path === command.path);
                        if (!file) throw new OperationBlockedError('Select a changed file in this history range.');
                        return this.history.texts(update, file.originalPath || file.path);
                    }
                }
            } finally {
                // Await returned workflows above before sending this signal.
                // The editor watches this signal, not the Git index: a status
                // refresh itself may touch Git metadata and must not loop.
                if (!['status', 'diff', 'history', 'historyFiles', 'historyDiff', 'stashes'].includes(command.type)) {
                    await writeJson(path.join(this.store.metadataDir, 'changed.json'), {
                        time: Date.now(),
                        operation: command.type,
                    });
                }
            }
        });
    }
    private version(version: number): void {
        if (!Number.isSafeInteger(version) || version < 0)
            throw new OperationBlockedError('Version must be a non-negative integer.');
    }
    private async withRemote<T>(action: (remote: RemoteProject) => Promise<T>): Promise<T> {
        const settings = this.store.getSettings()!;
        const credential = await this.credentials.getCredential(settings.serverUrl);
        if (!credential) throw new OperationBlockedError('Log in to Overleaf first.');
        const remote = new RemoteProject(
            new BaseAPI(settings.serverUrl, this.options.log).setIdentity(credential.identity),
            this.store,
            this.options.log,
        );
        if (this.options.status) remote.onStatusChange(this.options.status);
        try {
            await remote.connect(true);
            return await action(remote);
        } finally {
            remote.disconnect();
            this.options.status?.({ status: 'idle', message: 'Offline · manual sync' });
        }
    }
    private async clone(): Promise<void> {
        await this.withRemote(async (remote) => {
            const beforeV = await this.history.currentVersion(true);
            const snapshot = await remote.readRemoteSnapshot();
            const afterV = await this.history.currentVersion(true);
            if (beforeV !== afterV) throw new OperationBlockedError('Overleaf changed while reading the initial snapshot. Retry Clone.');
            await this.checkEditors();
            await this.repository.initializeFromRemote(snapshot);
            const receipts = await this.repository.publications.read();
            receipts.integrated = { version: afterV, gitHash: (await this.repository.remoteHead())! };
            await this.repository.publications.write(receipts);
        });
        await this.store.updateLastSynced();
    }
    private async pull(): Promise<{ conflicts: string[] }> {
        if (!(await this.repository.head())) {
            await this.clone();
            return { conflicts: [] };
        }
        const current = await this.repository.status();
        if (current.some((change) => change.kind === 'conflict'))
            throw new OperationBlockedError('Resolve or abort the current conflict before pulling.');
        if (current.length) throw new OperationBlockedError('Commit or stash your local changes before pulling.');
        await this.checkEditors();
        const conflicts = await this.withRemote(async (remote) => {
            const beforeV = await this.history.currentVersion(true);
            const snapshot = await remote.readRemoteSnapshot(),
                receipts = await this.repository.publications.read();
            const afterV = await this.history.currentVersion(true);
            if (beforeV !== afterV) throw new OperationBlockedError('Overleaf changed while reading the snapshot. Retry Pull.');
            await this.checkEditors();
            const gitHash = await this.repository.fetchRemoteSnapshot(snapshot);
            await this.checkEditors();
            receipts.pendingPull = { version: afterV, gitHash };
            await this.repository.publications.write(receipts);
            let changes;
            try { changes = await this.repository.rebaseRemote(); }
            catch (error) {
                if (!(await this.repository.isRebasing())) {
                    delete receipts.pendingPull;
                    await this.repository.publications.write(receipts);
                }
                throw error;
            }
            const conflicts = changes.filter((change) => change.kind === 'conflict');
            if (!conflicts.length) {
                receipts.integrated = receipts.pendingPull;
                delete receipts.pendingPull;
                delete receipts.pending;
                await this.repository.publications.write(receipts);
            }
            return conflicts.map((change) => change.path);
        });
        await this.store.updateLastSynced();
        return { conflicts };
    }
    private async prepareOnline(): Promise<void> {
        await this.repository.initialize();
        await this.checkEditors();
        await this.repository.assertSettled();
        if (!(await this.repository.isClean()))
            throw new OperationBlockedError(
                'Commit and push (or discard) all Changes and Staged Changes before Online.',
            );
        if ((await this.repository.unpublished(1)).length)
            throw new OperationBlockedError('Push all local commits before Online.');
        await this.withRemote(async (remote) => {
            const snapshot = await remote.readRemoteSnapshot();
            if (!(await this.repository.head())) await this.repository.initializeFromRemote(snapshot);
            else await this.repository.fetchRemoteSnapshot(snapshot);
            await this.checkEditors();
            if (
                !(await this.repository.isClean()) ||
                (await this.repository.divergence()).behind ||
                snapshotFingerprint(await this.repository.committedSnapshot()) !== snapshotFingerprint(snapshot)
            )
                throw new OperationBlockedError(
                    'Local files and Overleaf differ. Pull and reconcile in Offline before switching.',
                );
        });
    }
    private async restore(version: number): Promise<any> {
        this.version(version);
        await this.repository.assertSettled();
        await this.checkEditors();
        if (!(await this.repository.isClean()))
            throw new OperationBlockedError('Commit, stash or discard local changes before Restore.');
        if ((await this.repository.unpublished(1)).length)
            throw new OperationBlockedError('Push or revert unpublished commits before Restore.');
        if (
            !(await this.confirm(
                `Restore Overleaf and the linked folder to v${version}? This creates a new server version and affects collaborators. Local files are synchronized immediately.`,
                'Restore and Sync',
            ))
        )
            return { canceled: true };
        await this.checkEditors();
        if (!(await this.repository.isClean()))
            throw new OperationBlockedError(
                'Local files changed while confirming Restore. Stash or commit them first.',
            );
        await this.history.restore(version);
        try {
            return { restored: version, ...(await this.pull()) };
        } catch (error) {
            throw new Error(
                `Overleaf was restored, but local synchronization failed. Use Pull to finish; do not repeat Restore. ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }
    private async discard(paths?: string[]): Promise<any> {
        await this.repository.assertSettled();
        const wanted = paths && new Set(paths);
        const changes = (await this.repository.status()).filter(
            (change) => change.kind !== 'conflict' && change.y !== ' ' && (!wanted || wanted.has(change.path)),
        );
        if (!changes.length) return { discarded: [] };
        if (changes.some((change) => change.kind === 'untracked') && !this.options.trash)
            throw new OperationBlockedError('A recoverable trash provider is required to discard new files.');
        if (
            !(await this.confirm(
                `Discard unstaged changes in ${changes.length} file(s)? Staged changes are kept. New files go to the Recycle Bin; tracked edits cannot be recovered by Git.\n\n${changes.map((change) => change.path).join('\n')}`,
                'Discard Changes',
            ))
        )
            return { canceled: true };
        await this.checkEditors();
        await this.repository.discard(
            changes.map((change) => change.path),
            (relative) => this.options.trash!(this.store.file(relative)),
        );
        return { discarded: changes.map((change) => change.path) };
    }
    private async push(): Promise<any> {
        // Each publication is verified before its receipt is finalized. An
        // uncertain request must reconcile, never blindly retry a remote write.
        if (!(await this.repository.head()))
            throw new OperationBlockedError('Create an offline baseline and commit before pushing.');
        if (await this.repository.isRebasing())
            throw new OperationBlockedError('Finish or abort the current pull before pushing.');
        if ((await this.repository.status()).some((change) => change.kind === 'conflict'))
            throw new OperationBlockedError('Resolve conflicts before pushing.');
        return this.withRemote(async (remote) => {
            const receipts = await this.repository.publications.read();
            if (receipts.pending) {
                const pending = receipts.pending,
                    version = await this.history.currentVersion(true);
                const expected = await this.repository.committedSnapshot(pending.commit.hash),
                    actual = await remote.readRemoteSnapshot();
                if (
                    version <= pending.fromV ||
                    snapshotFingerprint(actual) !== snapshotFingerprint(expected) ||
                    version !== (await this.history.currentVersion())
                )
                    throw new OperationBlockedError(
                        'The interrupted push does not match Overleaf. Pull to reconcile before another push or revert.',
                    );
                await this.history.label(version, commitLabel(pending.commit.subject));
                receipts.published.push({ ...pending, toV: version });
                await this.repository.markRemoteAsHead(pending.commit.hash);
                receipts.integrated = { version, gitHash: pending.commit.hash };
                delete receipts.pending;
                await this.repository.publications.write(receipts);
            }
            let snapshot = await remote.readRemoteSnapshot();
            await this.repository.fetchRemoteSnapshot(snapshot);
            if (!(await this.repository.isRemoteAncestorOfHead()))
                throw new OperationBlockedError('Overleaf has new changes. Pull and resolve them before pushing.');
            const commits = (await this.repository.unpublished(100000)).reverse();
            if (!commits.length) return { pushed: 0 };
            const snapshots = await Promise.all(
                commits.map((commit) => this.repository.committedSnapshot(commit.hash)),
            );
            const plans = await Promise.all(
                snapshots.map((value, index) => remote.createPushPlan(index ? snapshots[index - 1] : snapshot, value)),
            );
            let fromV = await this.history.currentVersion(true);
            await this.history.ensureBoundary(fromV);
            for (let index = 0; index < commits.length; index++) {
                const commit = commits[index];
                receipts.pending = { commit, fromV };
                await this.repository.publications.write(receipts);
                await remote.applyPushPlan(plans[index], snapshotFingerprint(snapshot), snapshots[index]);
                const toV = await this.history.currentVersion(true),
                    actual = await remote.readRemoteSnapshot();
                if (
                    toV <= fromV ||
                    snapshotFingerprint(actual) !== snapshotFingerprint(snapshots[index]) ||
                    toV !== (await this.history.currentVersion())
                )
                    throw new Error(
                        'Overleaf changed while confirming the version. Push paused; its pending receipt protects your commit.',
                    );
                await this.history.label(toV, commitLabel(commit.subject));
                receipts.published.push({ commit, fromV, toV });
                await this.repository.markRemoteAsHead(commit.hash);
                receipts.integrated = { version: toV, gitHash: commit.hash };
                delete receipts.pending;
                await this.repository.publications.write(receipts);
                fromV = toV;
                snapshot = actual;
            }
            return { pushed: commits.length };
        });
    }
}
