import * as path from 'path';
import * as vscode from 'vscode';
import { COMMANDS } from '../consts';
import { CommitFile, GitRepository, WorkingChange, INDEX_REF } from './gitRepository';
import { HistoryModel, HistoryAction, HistoryCommitNode } from './historyModel';
import { HistoryGraph } from './historyGraph';
import { RemoteHistorySource } from './remoteHistory';
import { GitLeafFileDecorations } from './fileDecorations';
import { SnapshotContentProvider, SNAPSHOT_SCHEME } from './snapshotContentProvider';

const GIT_CONTENT_SCHEME = 'gitleaf-git';
const EMPTY_REF = '__empty__';

function gitUri(root: string, ref: string, filePath: string): vscode.Uri {
    return vscode.Uri.from({
        scheme: GIT_CONTENT_SCHEME,
        path: `/${filePath.replace(/\\/g, '/')}`,
        query: new URLSearchParams({ root, ref }).toString(),
    });
}

function decoration(change: WorkingChange): vscode.SourceControlResourceDecorations {
    const values: Record<WorkingChange['kind'], string> = {
        modified: 'Modified',
        added: 'Added',
        deleted: 'Deleted',
        renamed: 'Renamed',
        conflict: 'Conflict',
        untracked: 'Untracked',
    };
    return { strikeThrough: change.kind === 'deleted', tooltip: values[change.kind] };
}

export interface GitResourceState extends vscode.SourceControlResourceState {
    change: WorkingChange;
    staged: boolean;
}

/** Serves commit blobs to VS Code's native diff editor. */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
    readonly comparison = new SnapshotContentProvider();
    private readonly repositories = new Map<string, GitRepository>();
    private readonly served = new Map<string, vscode.Uri>();
    private readonly snapshots = new Map<string, string>();
    private readonly changed = new vscode.EventEmitter<vscode.Uri>();
    readonly onDidChange = this.changed.event;

    snapshot(root: string, ref: string, file: string, content: string): vscode.Uri {
        const uri = gitUri(root, ref, file);
        this.snapshots.set(uri.toString(), content);
        return uri;
    }

    refresh(root: string): void {
        for (const uri of this.served.values()) {
            if (new URLSearchParams(uri.query).get('root') === root) this.changed.fire(uri);
        }
    }

    register(repository: GitRepository): void {
        this.repositories.set(repository.root, repository);
    }

    unregister(repository: GitRepository): void {
        this.repositories.delete(repository.root);
    }

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const snapshot = this.snapshots.get(uri.toString());
        if (snapshot !== undefined) return snapshot;
        this.served.set(uri.toString(), uri);
        const query = new URLSearchParams(uri.query);
        const root = query.get('root');
        const ref = query.get('ref');
        if (!root || !ref) return '';
        if (ref === EMPTY_REF) return '';
        const repository = this.repositories.get(root);
        return repository?.show(ref, uri.path.replace(/^\//, '')) || '';
    }
}

/** One VS Code Source Control panel backed by the hidden Git repository. */
export class OfflineScmProvider implements vscode.Disposable {
    readonly sourceControl: vscode.SourceControl;
    private readonly historyModel: HistoryModel;
    private readonly fileDecorations: GitLeafFileDecorations;
    private readonly changesGroup: vscode.SourceControlResourceGroup;
    private readonly conflictsGroup: vscode.SourceControlResourceGroup;
    private readonly stagedGroup: vscode.SourceControlResourceGroup;
    private readonly disposables: vscode.Disposable[] = [];
    private refreshTimer?: NodeJS.Timeout;

    constructor(
        readonly repository: GitRepository,
        private readonly contentProvider: GitContentProvider,
        remoteHistory: RemoteHistorySource,
        readonly history: HistoryGraph,
        action?: (node: HistoryCommitNode, action: HistoryAction) => Promise<void>,
    ) {
        const rootUri = vscode.Uri.file(repository.root);
        this.sourceControl = vscode.scm.createSourceControl('gitleaf', 'GitLeaf', rootUri);
        this.sourceControl.inputBox.placeholder = 'Commit message (Ctrl+Enter to commit)';
        this.sourceControl.acceptInputCommand = { command: COMMANDS.COMMIT, title: 'Commit' };
        this.sourceControl.quickDiffProvider = {
            provideOriginalResource: uri => {
                const relative = path.relative(repository.root, uri.fsPath).replace(/\\/g, '/');
                return relative.startsWith('..') ? undefined : gitUri(repository.root, INDEX_REF, relative);
            },
        };

        this.conflictsGroup = this.sourceControl.createResourceGroup('conflicts', 'Merge Changes');
        this.conflictsGroup.hideWhenEmpty = true;
        this.stagedGroup = this.sourceControl.createResourceGroup('staged', 'Staged Changes');
        this.stagedGroup.hideWhenEmpty = true;
        this.changesGroup = this.sourceControl.createResourceGroup('changes', 'Changes');
        this.historyModel = new HistoryModel(repository, remoteHistory, contentProvider,
            (commit, file) => this.historyFileResources(commit, file), action);
        this.fileDecorations = new GitLeafFileDecorations(repository.root);
        this.disposables.push(this.historyModel.onDidChange(() => this.refreshSyncStatus()),
            history.bind(this.historyModel), this.fileDecorations);
        this.refreshSyncStatus();
        this.contentProvider.register(repository);

        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(rootUri, '**/*'));
        const schedule = (uri: vscode.Uri) => {
            // Main-file settings change ignore variables as well as file colors.
            if (uri.fsPath.startsWith(repository.metadataDir + path.sep) && !['settings.json', 'changed.json'].includes(path.basename(uri.fsPath))) return;
            if (this.refreshTimer) clearTimeout(this.refreshTimer);
            this.refreshTimer = setTimeout(() => void this.refresh(), 120);
        };
        this.disposables.push(
            watcher,
            watcher.onDidCreate(schedule),
            watcher.onDidChange(schedule),
            watcher.onDidDelete(schedule),
            this.sourceControl,
        );
    }

    async refresh(): Promise<WorkingChange[]> {
        const changes = await this.repository.status();
        const toState = (change: WorkingChange, staged = false): GitResourceState => {
            // Separate index and worktree decorations even when a file appears
            // in both groups (for example staged A plus unstaged M).
            const resourceUri = vscode.Uri.file(path.join(this.repository.root, ...change.path.split('/')))
                .with({ query: staged ? 'gitleaf=staged' : 'gitleaf=working' });
            return {
                resourceUri,
                change,
                staged,
                decorations: decoration(change),
                command: {
                    command: COMMANDS.OPEN_CHANGE,
                    title: 'Open Change',
                    arguments: [this, change, staged],
                },
            };
        };
        const slice = (change: WorkingChange, staged: boolean): WorkingChange => {
            const flag = staged ? change.x : change.y;
            const kind = flag === 'D' ? 'deleted' : flag === 'A' ? 'added' : flag === 'R' ? 'renamed' : flag === '?' ? 'untracked' : 'modified';
            return { ...change, kind };
        };
        const ordinary = changes.filter(change => change.kind !== 'conflict');
        this.conflictsGroup.resourceStates = changes.filter(change => change.kind === 'conflict').map(change => toState(change));
        this.stagedGroup.resourceStates = ordinary.filter(change => ![' ', '?'].includes(change.x)).map(change => toState(slice(change, true), true));
        this.changesGroup.resourceStates = ordinary.filter(change => change.y !== ' ').map(change => toState(slice(change, false)));
        this.fileDecorations.refresh(changes, await this.repository.refreshIgnoreRules());
        await this.historyModel.refreshLocal();
        this.contentProvider.refresh(this.repository.root);
        this.sourceControl.count = changes.length;
        return changes;
    }

    private refreshSyncStatus(): void {
        const state = this.historyModel.syncState();
        const incoming = state.incoming === undefined ? '?' : `${state.incoming}${state.incomingComplete ? '' : '+'}`;
        const outgoing = `${state.outgoing}${state.outgoingComplete ? '' : '+'}`;
        const details = state.incoming === undefined ? 'Incoming history is not yet known.'
            : `${state.incomingComplete ? '' : 'At least '}${state.incoming} incoming history entries.`;
        this.sourceControl.statusBarCommands = [{
            command: COMMANDS.SYNC_NOW, title: `$(sync) ${incoming}↓ ${outgoing}↑`,
            tooltip: `${details} ${state.outgoingComplete ? '' : 'At least '}${state.outgoing} outgoing commits. Pull Overleaf changes, then push local commits if there are no conflicts.`,
        }];
    }

    async openChange(change: WorkingChange, staged = false): Promise<void> {
        const localUri = vscode.Uri.file(path.join(this.repository.root, ...change.path.split('/')));
        if (change.kind === 'conflict') {
            await vscode.window.showTextDocument(localUri);
            return;
        }

        const beforePath = change.originalPath || change.path;
        const before = change.kind === 'added' || change.kind === 'untracked'
            ? gitUri(this.repository.root, EMPTY_REF, beforePath)
            : gitUri(this.repository.root, staged ? 'HEAD' : INDEX_REF, beforePath);
        const after = change.kind === 'deleted'
            ? gitUri(this.repository.root, EMPTY_REF, change.path)
            : staged ? gitUri(this.repository.root, INDEX_REF, change.path) : localUri;
        await vscode.commands.executeCommand(
            'vscode.diff',
            before,
            after,
            `${change.path} (${staged ? 'HEAD ↔ Index' : 'Index ↔ Working Tree'})`,
        );
    }

    private async historyFileResources(commit: string, file: CommitFile): Promise<readonly [vscode.Uri, vscode.Uri]> {
        const parent = await this.repository.parentOf(commit);
        const before = parent && !file.status.startsWith('A')
            ? gitUri(this.repository.root, parent, file.originalPath || file.path)
            : gitUri(this.repository.root, EMPTY_REF, file.path);
        const after = file.status.startsWith('D')
            ? gitUri(this.repository.root, EMPTY_REF, file.path)
            : gitUri(this.repository.root, commit, file.path);
        return [before, after];
    }

    getCommitMessage(): string {
        return this.sourceControl.inputBox.value.trim();
    }

    clearCommitMessage(): void {
        this.sourceControl.inputBox.value = '';
    }

    dispose(): void {
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.contentProvider.unregister(this.repository);
        this.disposables.forEach(disposable => disposable.dispose());
    }
}

export function registerGitContentProvider(context: vscode.ExtensionContext): GitContentProvider {
    const provider = new GitContentProvider();
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(GIT_CONTENT_SCHEME, provider));
    context.subscriptions.push(provider.comparison,
        vscode.workspace.registerFileSystemProvider(SNAPSHOT_SCHEME, provider.comparison, { isReadonly: true, isCaseSensitive: true }));
    return provider;
}
