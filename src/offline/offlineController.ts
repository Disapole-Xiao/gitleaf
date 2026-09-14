import * as vscode from 'vscode';
import { Credentials } from '../core/credentials';
import { GitLeafProject, ProjectCommand } from '../core/project';
import { SyncStatusEvent } from '../core/remoteProject';
import { SettingsManager } from '../utils/projectAdapter';
import { GitRepository, WorkingChange } from './gitRepository';
import { GitContentProvider, OfflineScmProvider } from './scmProvider';
import { HistoryAction, HistoryCommitNode } from './historyModel';
import { HistoryGraph } from './historyGraph';
import { OperationBlockedError } from './operationBlocked';

/** Editor adapter only: prompts, notifications and native SCM/diff rendering.
 * Repository and network decisions belong exclusively to GitLeafProject. */
export class OfflineController implements vscode.Disposable {
    readonly repository: GitRepository;
    readonly core: GitLeafProject;
    private scm?: OfflineScmProvider;
    constructor(
        private readonly settings: SettingsManager,
        credentials: Credentials,
        private readonly contentProvider: GitContentProvider,
        private readonly historyGraph: HistoryGraph,
        log: (message: string) => void,
        onStatus?: (event: SyncStatusEvent) => void,
        private readonly serialize: (action: () => Promise<void>) => Promise<void> = (action) => action(),
    ) {
        this.core = new GitLeafProject(settings, credentials, {
            log,
            status: onStatus,
            checkEditors: () => this.assertSavedEditors(),
            confirm: async (message, action) =>
                (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
            trash: async (file) => {
                await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true });
            },
        });
        this.repository = this.core.repository;
    }
    private async execute(command: ProjectCommand): Promise<any> {
        try {
            return await this.core.execute(command);
        } finally {
            await this.scm?.refresh();
        }
    }
    async initialize(fetchInitial: boolean): Promise<void> {
        this.scm = new OfflineScmProvider(
            this.repository,
            this.contentProvider,
            this.core.history,
            this.historyGraph,
            (node, action) => this.serialize(() => this.historyAction(node, action)),
        );
        await this.execute({ type: 'initialize', fetch: fetchInitial });
    }
    async cloneInitialSnapshot(): Promise<void> {
        await this.execute({ type: 'initialize', fetch: true });
    }
    assertSavedEditors(): void {
        if (
            vscode.workspace.textDocuments.some(
                (document) => document.isDirty && this.settings.getRelativePath(document.uri),
            )
        ) {
            throw new OperationBlockedError('Save the linked folder’s editor changes first.');
        }
    }
    async prepareOnline(reserve = false): Promise<void> {
        await this.execute({ type: reserve ? 'activateOnline' : 'prepareOnline' });
    }
    async commit(): Promise<void> {
        const value =
            this.scm?.getCommitMessage() ||
            (await vscode.window.showInputBox({
                title: 'Commit Offline Changes',
                prompt: 'Describe this local snapshot',
                placeHolder: 'Update introduction',
            }));
        if (!value) return;
        const result = await this.execute({ type: 'commit', message: value });
        if (result.commit) this.scm?.clearCommitMessage();
        void vscode.window.showInformationMessage(
            result.commit
                ? `GitLeaf: Committed ${result.commit.slice(0, 8)}.`
                : 'GitLeaf: No staged changes. Stage files with + before committing.',
        );
    }
    async pull(): Promise<{ conflicts: string[] }> {
        const result = await this.execute({ type: 'pull' });
        await this.refreshHistory();
        if (result.conflicts.length) {
            const action = await vscode.window.showWarningMessage(
                `GitLeaf: Pull produced ${result.conflicts.length} conflict(s).`,
                'Open First Conflict',
            );
            if (action) await vscode.window.showTextDocument(this.settings.getFilePath(result.conflicts[0]));
        } else void vscode.window.showInformationMessage('GitLeaf: Pull complete.');
        return result;
    }
    async sync(): Promise<void> {
        const result = await this.pull();
        if (!result.conflicts.length) await this.push();
    }
    async push(): Promise<void> {
        const result = await this.execute({ type: 'push' });
        void vscode.window.showInformationMessage(
            result.pushed ? 'GitLeaf: Push complete.' : 'GitLeaf: Overleaf is already up to date.',
        );
        await this.refreshHistory();
    }
    private async historyAction(node: HistoryCommitNode, action: HistoryAction): Promise<void> {
        if (action === 'label') {
            const message = await vscode.window.showInputBox({
                title: 'Label version',
                prompt: 'Version label',
                ignoreFocusOut: true,
            });
            if (!message?.trim()) return;
            await this.execute({
                type: 'label',
                message,
                ...(node.kind === 'remote' ? { version: node.update.toV } : { commit: node.commit.hash }),
            });
        } else if (action === 'restore' && node.kind === 'remote') {
            await this.execute({ type: 'restore', version: node.update.toV });
        } else if ((action === 'hard' || action === 'soft') && node.kind === 'local') {
            await this.execute({ type: 'revert', commit: node.commit.hash, mode: action });
        }
        await this.refreshHistory();
    }
    async resolveConflict(change?: WorkingChange): Promise<void> {
        const selected =
            change ||
            (
                await vscode.window.showQuickPick(
                    (await this.repository.status())
                        .filter((item) => item.kind === 'conflict')
                        .map((item) => ({ label: item.path, item })),
                    { title: 'Choose a conflict' },
                )
            )?.item;
        if (!selected) return;
        const action = await vscode.window.showQuickPick(
            [
                { label: '$(edit) Open and resolve manually', strategy: 'open' as const },
                { label: '$(check) Mark edited file resolved', strategy: 'manual' as const },
                { label: '$(arrow-left) Keep local version', strategy: 'local' as const },
                { label: '$(cloud-download) Keep Overleaf version', strategy: 'overleaf' as const },
            ],
            { title: `Resolve ${selected.path}` },
        );
        if (!action) return;
        if (action.strategy === 'open') {
            await vscode.window.showTextDocument(this.settings.getFilePath(selected.path));
            return;
        }
        await this.execute({ type: 'resolve', path: selected.path, strategy: action.strategy });
    }
    async abortPull(): Promise<void> {
        await this.execute({ type: 'abortPull' });
    }
    async refresh(): Promise<void> {
        await this.scm?.refresh();
    }
    async stage(changes?: WorkingChange[]): Promise<void> {
        await this.execute({ type: 'stage', paths: changes?.map((change) => change.path) });
    }
    async unstage(changes?: WorkingChange[]): Promise<void> {
        await this.execute({
            type: 'unstage',
            paths: changes?.flatMap((change) =>
                change.originalPath ? [change.path, change.originalPath] : [change.path],
            ),
        });
    }
    async discard(changes?: WorkingChange[]): Promise<void> {
        await this.execute({ type: 'discard', paths: changes?.map((change) => change.path) });
    }
    async stash(action: 'save' | 'apply' | 'pop' | 'drop'): Promise<void> {
        if (action === 'save') {
            const message = await vscode.window.showInputBox({
                title: 'Stash Changes',
                prompt: 'Save staged, unstaged and untracked files locally. Ignored files are excluded.',
                placeHolder: 'Optional stash message',
            });
            if (message !== undefined) await this.execute({ type: 'stash', action, message });
        } else {
            const entries = (await this.core.execute({ type: 'stashes' })) as Awaited<
                ReturnType<GitRepository['stashes']>
            >;
            if (!entries.length) {
                void vscode.window.showInformationMessage('GitLeaf: No stashes.');
                return;
            }
            const entry = await vscode.window.showQuickPick(
                entries.map((item) => ({
                    label: item.message,
                    description: item.ref,
                    detail: new Date(item.date).toLocaleString(),
                    item,
                })),
                { title: `${action} Stash` },
            );
            if (entry) await this.execute({ type: 'stash', action, hash: entry.item.hash });
        }
    }
    async fetch(): Promise<void> {
        await this.execute({ type: 'fetch' });
        await this.refreshHistory();
        void vscode.window.showInformationMessage(
            'GitLeaf: Fetched Overleaf. Local files and the index were not changed.',
        );
    }
    async openChange(change: WorkingChange, staged = false): Promise<void> {
        await this.scm?.openChange(change, staged);
    }
    async showHistory(hash?: string): Promise<void> {
        await this.scm?.history.show(hash);
    }
    async showRemoteHistory(): Promise<void> {
        await this.scm?.history.show();
    }
    async refreshHistory(): Promise<void> {
        await this.scm?.history.refresh();
    }
    dispose(): void {
        this.scm?.dispose();
        this.scm = undefined;
    }
}
