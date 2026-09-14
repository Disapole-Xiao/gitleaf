import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { SettingsManager } from './projectAdapter';

/** A synchronous, atomic dirty-state transition closes the gap between a
 * VS Code change event and a CLI checking whether it may replace disk files. */
export class EditorState implements vscode.Disposable {
    private readonly subscriptions: vscode.Disposable[];
    private readonly file: string;
    private previous = '';
    constructor(private readonly settings: SettingsManager) {
        this.file = path.join(settings.metadataDir, `editor-${process.pid}.json`);
        const update = () => this.update();
        this.subscriptions = [
            vscode.workspace.onDidChangeTextDocument(update),
            vscode.workspace.onDidSaveTextDocument(update),
            vscode.workspace.onDidOpenTextDocument(update),
            vscode.workspace.onDidCloseTextDocument(update),
        ];
        this.update();
    }
    private update(): void {
        const dirty = vscode.workspace.textDocuments
            .filter((doc) => doc.isDirty && this.settings.getRelativePath(doc.uri))
            .map((doc) => this.settings.getRelativePath(doc.uri)!)
            .sort();
        const value = JSON.stringify({ dirty });
        if (value === this.previous) return;
        fs.mkdirSync(this.settings.metadataDir, { recursive: true });
        fs.writeFileSync(this.file + '.tmp', value, { mode: 0o600 });
        fs.renameSync(this.file + '.tmp', this.file);
        this.previous = value;
    }
    dispose(): void {
        this.subscriptions.forEach((item) => item.dispose());
        fs.rmSync(this.file, { force: true });
    }
}
