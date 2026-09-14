import * as path from 'path';
import * as vscode from 'vscode';
import { WorkingChange } from './gitRepository';
import { ignoreMatcher } from '../sync/ignoreRules';

const statuses: Record<string, { tooltip: string; color: string }> = {
    U: { tooltip: 'Untracked', color: 'untrackedResourceForeground' },
    M: { tooltip: 'Modified', color: 'modifiedResourceForeground' },
    A: { tooltip: 'Added', color: 'addedResourceForeground' },
    D: { tooltip: 'Deleted', color: 'deletedResourceForeground' },
    R: { tooltip: 'Renamed', color: 'renamedResourceForeground' },
    C: { tooltip: 'Copied', color: 'addedResourceForeground' },
    T: { tooltip: 'Type changed', color: 'modifiedResourceForeground' },
    '!': { tooltip: 'Conflict', color: 'conflictingResourceForeground' },
};

export function changeLetter(change: WorkingChange, staged = false): string {
    if (change.kind === 'conflict') return '!';
    const flag = staged ? change.x : change.y;
    return flag === '?' ? 'U' : flag;
}

/** Same badge/ThemeColor mechanism as VS Code Git; no hard-coded theme icons. */
export class GitLeafFileDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this.changed.event;
    private readonly registration = vscode.window.registerFileDecorationProvider(this);
    private working = new Map<string, string>();
    constructor(private readonly root: string) {}

    refresh(changes: WorkingChange[], ignoreRules: string[]): void {
        const next = new Map<string, string>();
        const ignored = ignoreMatcher(ignoreRules);
        for (const change of changes) {
            const uri = vscode.Uri.file(path.join(this.root, change.path));
            const staged = changeLetter(change, true);
            const working = changeLetter(change);
            // A previously tracked file can now be excluded from sync. Leave
            // Explorer's color to the ignore provider, but keep SCM badges.
            if (!ignored(change.path)) next.set(uri.toString(), working === ' ' ? staged : working);
            next.set(uri.with({ query: 'gitleaf=staged' }).toString(), staged);
            next.set(uri.with({ query: 'gitleaf=working' }).toString(), working);
        }
        const affected = new Set([...this.working.keys(), ...next.keys()]);
        this.working = next;
        this.changed.fire([...affected].map(value => vscode.Uri.parse(value)));
    }

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        const status = this.working.get(uri.toString());
        const definition = status && statuses[status];
        if (!definition) return;
        return { badge: status!, tooltip: definition.tooltip, color: new vscode.ThemeColor(`gitDecoration.${definition.color}`) };
    }

    dispose(): void {
        this.working.clear();
        this.changed.fire(undefined);
        this.registration.dispose();
        this.changed.dispose();
    }
}
