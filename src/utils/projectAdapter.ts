import * as vscode from 'vscode';
import { ProjectStore, ProjectSettings } from '../core/projectStore';
import { CONFIG_DIR, SETTINGS_FILE } from '../consts';

/** VS Code selects/remembers folders. The shared store owns project data and IO. */
export class SettingsManager extends ProjectStore {
    private static readonly instances = new Map<string, SettingsManager>();
    private static active?: SettingsManager;
    private static registry?: vscode.Memento;
    private constructor(private readonly workspaceFolder: vscode.Uri) {
        super(workspaceFolder.fsPath);
    }
    static getInstance(folder: vscode.Uri): SettingsManager {
        const key = process.platform === 'win32' ? folder.fsPath.toLowerCase() : folder.fsPath;
        if (!this.instances.has(key)) this.instances.set(key, new SettingsManager(folder));
        return this.instances.get(key)!;
    }
    static initialize(registry: vscode.Memento): void {
        this.registry = registry;
    }
    static setActive(instance: SettingsManager): void {
        this.active = instance;
    }
    static getCurrentInstance(): SettingsManager | undefined {
        if (this.active?.getSettings()) return this.active;
        const uri = vscode.window.activeTextEditor?.document.uri;
        const folder = uri && vscode.workspace.getWorkspaceFolder(uri);
        if (folder?.uri.scheme === 'file') {
            const selected = this.getInstance(folder.uri);
            if (selected.getSettings()) return selected;
        }
        const loaded = [...this.instances.values()].find((instance) => instance.getSettings());
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        return loaded || (root?.scheme === 'file' ? this.getInstance(root) : undefined);
    }
    static getWorkspaceInstances(): SettingsManager[] {
        const roots = (vscode.workspace.workspaceFolders || [])
            .filter((folder) => folder.uri.scheme === 'file')
            .map((folder) => folder.uri.toString());
        return [...new Set([...(this.registry?.get<string[]>('gitleaf.linkedFolders', []) || []), ...roots])].map(
            (root) => this.getInstance(vscode.Uri.parse(root)),
        );
    }
    async save(settings: ProjectSettings): Promise<void> {
        await super.save(settings);
        const roots = SettingsManager.registry?.get<string[]>('gitleaf.linkedFolders', []) || [];
        await SettingsManager.registry?.update('gitleaf.linkedFolders', [
            ...new Set([this.workspaceFolder.toString(), ...roots]),
        ]);
    }
    async clear(): Promise<void> {
        await super.clear();
        const roots = SettingsManager.registry?.get<string[]>('gitleaf.linkedFolders', []) || [];
        await SettingsManager.registry?.update(
            'gitleaf.linkedFolders',
            roots.filter((root) => root !== this.workspaceFolder.toString()),
        );
    }
    getWorkspaceFolder(): vscode.Uri {
        return this.workspaceFolder;
    }
    getConfigDir(): vscode.Uri {
        return vscode.Uri.file(this.metadataDir);
    }
    getFilePath(relative: string): vscode.Uri {
        return vscode.Uri.file(this.file(relative));
    }
    getRelativePath(uri: vscode.Uri): string | undefined {
        const prefix = this.workspaceFolder.path.replace(/\/$/, '') + '/';
        const normalize = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
        if (uri.scheme === 'file' && normalize(uri.path).startsWith(normalize(prefix)))
            return '/' + uri.path.slice(prefix.length);
    }
}
export function createSettingsWatcher(folder: vscode.Uri, listener: () => void): vscode.FileSystemWatcher {
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, `${CONFIG_DIR}/${SETTINGS_FILE}`),
    );
    watcher.onDidChange(listener);
    watcher.onDidCreate(listener);
    watcher.onDidDelete(listener);
    return watcher;
}
