import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { HistoryModel, HistoryCommitNode, historyVersionLabel } from './historyModel';
import { layoutHistory } from './historyLayout';
import { historyGraphHtml } from './historyGraphHtml';
import { OperationBlockedError } from './operationBlocked';
import { HistoryRequestError } from '../api/historyRequest';
import { graphFileIcons } from './graphFileIcons';

/** One provider for the extension lifetime, with a replaceable project model.
 * VS Code keeps resolved views when a provider is unregistered: registering a
 * replacement provider does not reconnect that existing view. Native
 * vscode.diff still owns comparisons; only known IDs cross the message boundary.
 */
export class HistoryGraph implements vscode.WebviewViewProvider, vscode.Disposable {
    private view?: vscode.WebviewView;
    private ready = false;
    private records = new Map<string, HistoryCommitNode>();
    private readonly disposables: vscode.Disposable[];
    private readonly viewDisposables: vscode.Disposable[] = [];
    private readonly modelDisposables: vscode.Disposable[] = [];
    private model?: HistoryModel;
    private session = '';
    private selected?: string;
    private compareBase?: HistoryCommitNode;
    private mode: 'list' | 'tree';
    private readonly notifications = new Set<string>();

    constructor(private readonly extensionUri: vscode.Uri, private readonly storage: vscode.Memento) {
        this.mode = storage.get('gitleaf.historyMode') === 'list' ? 'list' : 'tree';
        this.disposables = [vscode.window.registerWebviewViewProvider('gitleaf.history', this)];
        if (vscode.workspace.onDidChangeConfiguration) this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('workbench.iconTheme')) void this.publishIcons();
        }));
        if (vscode.window.onDidChangeActiveColorTheme) this.disposables.push(vscode.window.onDidChangeActiveColorTheme(() => {
            void this.publishIcons();
        }));
        void vscode.commands.executeCommand('setContext', 'gitleaf.historyMode', this.mode);
    }

    /** The SCM owns this binding, not the view provider. Detaching an older SCM
     * must never dispose a newer project's model. */
    bind(model: HistoryModel): vscode.Disposable {
        this.clearModel();
        this.model = model;
        this.modelDisposables.push(model, model.onDidChange(() => { void this.publish(); }),
            model.onDidFail(error => { void this.notify(error, 'Load Overleaf history'); }));
        this.resetView();
        return { dispose: () => {
            if (this.model !== model) return;
            this.clearModel();
            this.resetView();
        } };
    }

    private clearModel(): void {
        this.model = undefined;
        this.selected = undefined;
        this.compareBase = undefined;
        this.records.clear();
        this.modelDisposables.splice(0).forEach(item => item.dispose());
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.viewDisposables.splice(0).forEach(item => item.dispose());
        this.view = view;
        view.onDidDispose(() => {
            if (this.view === view) { this.view = undefined; this.ready = false; }
        }, null, this.viewDisposables);
        // Subscribe before assigning HTML: even an immediate ready handshake
        // must reach the provider. Rebinding never requires VS Code to resolve again.
        view.webview.onDidReceiveMessage(message => { void this.receive(message); }, null, this.viewDisposables);
        this.resetView();
    }

    private resetView(): void {
        this.ready = false;
        this.session = randomBytes(16).toString('hex');
        this.records.clear();
        const view = this.view;
        if (!view) return;
        const media = vscode.Uri.joinPath(this.extensionUri, 'media');
        view.webview.options = { enableScripts: true, localResourceRoots: [media] };
        const script = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'historyGraph.js'));
        const style = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'historyGraph.css'));
        // A new document clears expanded files/menus from the previous project.
        // Its session also rejects delayed messages with coincident version IDs.
        view.webview.html = historyGraphHtml(script.toString(), style.toString(), view.webview.cspSource, this.session);
    }

    private async publish(): Promise<void> {
        const { view, model, session } = this;
        if (!view || !this.ready) return;
        try {
            const nodes = model ? await model.getChildren() : [];
            if (this.session !== session || this.view !== view || this.model !== model) return;
            const commits = nodes.filter((node): node is HistoryCommitNode => node.kind === 'local' || node.kind === 'remote');
            this.records = new Map(commits.map(node => [node.id, node]));
            await view.webview.postMessage({ type: 'records', session, mode: this.mode, ...layoutHistory(commits, model?.graphPosition()),
                more: nodes.filter(node => node.kind === 'more').map(node => node.source), selected: this.selected,
                comparison: this.comparisonSelection() });
            if (this.session === session) this.selected = undefined;
        } catch (error) {
            if (this.session === session && this.view === view && this.model === model) void this.notify(error, 'Load history');
        }
    }

    private async publishIcons(): Promise<void> {
        const { view, session } = this;
        if (!view || !this.ready) return;
        let icons;
        try { icons = await graphFileIcons(view.webview); }
        catch { /* A broken icon theme must not break history. */ }
        if (this.session !== session || this.view !== view) return;
        const media = vscode.Uri.joinPath(this.extensionUri, 'media');
        view.webview.options = { ...view.webview.options, localResourceRoots: icons ? [media, icons.root] : [media] };
        await view.webview.postMessage({ type: 'iconTheme', session, icons: icons?.data });
    }

    private async notify(error: unknown, operation: string): Promise<void> {
        const message = `GitLeaf: ${operation}: ${error instanceof Error ? error.message : String(error)}`;
        // Concurrent clicks can share one failed request. Keep one native message
        // visible, never duplicate it per node or turn it into file-list content.
        if (this.notifications.has(message)) return;
        this.notifications.add(message);
        try {
            if (error instanceof OperationBlockedError || error instanceof HistoryRequestError && error.status === 429) {
                await vscode.window.showWarningMessage(message);
            } else await vscode.window.showErrorMessage(message);
        } finally { this.notifications.delete(message); }
    }

    private comparisonSelection(): { id: string; label: string } | undefined {
        return this.compareBase ? { id: this.compareBase.id, label: historyVersionLabel(this.compareBase) } : undefined;
    }

    private async receive(message: unknown): Promise<void> {
        if (!message || typeof message !== 'object') return;
        const { type, id, index, source, session } = message as Record<string, unknown>;
        if (session !== this.session) return;
        const model = this.model;
        try {
            if (type === 'ready') { this.ready = true; await this.publishIcons(); await this.publish(); return; }
            if (!model) return;
            if (type === 'more' && (source === 'local' || source === 'remote')) { await model.loadMore(source); return; }
            if (typeof id !== 'string') return;
            const record = this.records.get(id);
            if (!record) return;
            if (type === 'selectCompare') {
                this.compareBase = record;
                await this.view?.webview.postMessage({ type: 'comparison', session, comparison: this.comparisonSelection() });
                return;
            }
            if (type === 'compare') {
                if (this.compareBase && this.compareBase.id !== record.id) await model.compare(this.compareBase, record);
                return;
            }
            if (type === 'label' || type === 'restore' || type === 'hard' || type === 'soft') {
                await model.action(record, type);
                return;
            }
            if (type !== 'files' && type !== 'open' && type !== 'openAll') return;
            const files = await model.getChildren(record);
            if (this.session !== session || this.model !== model) return;
            if (type === 'files') {
                await this.view?.webview.postMessage({ type: 'files', session, id, files: files.flatMap(node => node.kind === 'file' ? [node.file] : []) });
            } else if (type === 'openAll') {
                await model.openAll(record);
            } else if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < files.length) {
                await model.open(files[index]);
            }
        } catch (error) {
            if (this.session !== session || this.model !== model) return;
            // Only failed reads have loading state to clear. Restore/Revert/Label
            // and diff failures must not expand, collapse or replace a file tree.
            if (type === 'files' || type === 'more') {
                await this.view?.webview.postMessage({ type: 'requestFailed', session, id, source, action: type });
            }
            const operation = ({ files: 'Load changed files', open: 'Open diff', openAll: 'Open changes', more: 'Load older history',
                compare: 'Compare versions', label: 'Label', restore: 'Restore', hard: 'Hard Revert', soft: 'Soft Revert' } as Record<string, string>)[String(type)] || 'History';
            void this.notify(error, operation);
        }
    }

    async refresh(): Promise<void> { await this.model?.refresh(); }

    async setMode(mode: 'list' | 'tree'): Promise<void> {
        if (this.mode === mode) return;
        this.mode = mode;
        await this.storage.update('gitleaf.historyMode', mode);
        await vscode.commands.executeCommand('setContext', 'gitleaf.historyMode', mode);
        if (this.ready) await this.view?.webview.postMessage({ type: 'mode', session: this.session, mode });
    }

    async show(hash?: string): Promise<void> {
        this.selected = hash ? `git:${hash}` : undefined;
        await vscode.commands.executeCommand('gitleaf.history.focus');
        // Opening/focusing is not Refresh. Reuse the already loaded page.
        await this.publish();
    }

    dispose(): void {
        this.view = undefined;
        this.ready = false;
        this.clearModel();
        this.viewDisposables.splice(0).forEach(item => item.dispose());
        this.disposables.splice(0).forEach(item => item.dispose());
    }
}
