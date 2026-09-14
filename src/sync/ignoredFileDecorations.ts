import * as path from 'path';
import * as vscode from 'vscode';
import { CONFIG_DIR, IGNORE_FILE, SETTINGS_FILE } from '../consts';
import { ignoreMatcher, MainFiles, resolveIgnoreRules } from './ignoreRules';

/** Ignore colors belong to the folder link, not the offline SCM or a live
 * connection. Use the same matcher as sync/Git, and Git's native theme token.
 */
export class IgnoredFileDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<undefined>();
    readonly onDidChangeFileDecorations = this.changed.event;
    private readonly disposables: vscode.Disposable[] = [];
    private matches?: (relative: string) => boolean;
    private loading: Promise<void> = Promise.resolve();
    private disposed = false;
    private timer?: NodeJS.Timeout;
    private readonly decoration: vscode.FileDecoration = {
        color: new vscode.ThemeColor('gitDecoration.ignoredResourceForeground'),
    };

    constructor(private readonly root: vscode.Uri, private readonly log: (message: string) => void) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, `{${IGNORE_FILE},${CONFIG_DIR}/${SETTINGS_FILE}}`));
        const schedule = () => {
            if (this.timer) clearTimeout(this.timer);
            this.timer = setTimeout(() => { void this.refresh(); }, 100);
        };
        this.disposables.push(watcher, watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule),
            vscode.window.registerFileDecorationProvider(this));
        void this.refresh();
    }

    private async read(relative: string): Promise<string | undefined> {
        try { return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.root, relative))); }
        catch (error) {
            if ((error as { code?: string }).code === 'FileNotFound') return;
            throw error;
        }
    }

    refresh(): Promise<void> {
        // Serialize reloads so an older file read cannot win over a newer save.
        this.loading = this.loading.then(async () => {
            if (this.disposed) return;
            try {
                const [config, content] = await Promise.all([this.read(`${CONFIG_DIR}/${SETTINGS_FILE}`), this.read(IGNORE_FILE)]);
                this.matches = config === undefined ? undefined : ignoreMatcher(resolveIgnoreRules(content, JSON.parse(config) as MainFiles));
            } catch {
                this.matches = undefined;
                this.log('Could not refresh ignored-file colors. Check the linked folder settings and .gitleafignore.');
            }
            if (!this.disposed) this.changed.fire(undefined);
        });
        return this.loading;
    }

    async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
        // Virtual history/SCM URIs and sibling folders must not inherit colors.
        if (uri.scheme !== 'file' || uri.query || this.disposed) return;
        const relative = path.relative(this.root.fsPath, uri.fsPath).replace(/\\/g, '/');
        if (!relative || relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) return;
        await this.loading;
        if (this.disposed || !this.matches) return;
        if (this.matches(relative)) return this.decoration;
        // A trailing slash is significant to gitignore. Only stat a path when
        // a directory-only rule could match; never scan the project recursively.
        if (this.matches(`${relative}/`)) {
            try {
                const stat = await vscode.workspace.fs.stat(uri);
                if (!this.disposed && this.matches?.(`${relative}/`) && (stat.type & vscode.FileType.Directory)) return this.decoration;
            } catch { /* A deleted/moved file no longer needs a decoration. */ }
        }
        return;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (this.timer) clearTimeout(this.timer);
        this.matches = undefined;
        this.changed.fire(undefined);
        this.disposables.forEach(item => item.dispose());
        this.changed.dispose();
    }
}
