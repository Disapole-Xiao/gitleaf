import * as vscode from 'vscode';
import DiffMatchPatch from 'diff-match-patch';
import { SocketIOAPI, DocumentUpdate } from '../api/socketio';
import { SettingsManager } from '../utils/projectAdapter';
import { EditorMirror, TextSession, diffText, normalizeEditorText } from './textSession';

interface DocumentState {
    id: string;
    path: string;
    model: TextSession;
    mirror?: EditorMirror;
    document?: vscode.TextDocument;
    queued: DocumentUpdate[];
    rendering?: Promise<void>;
    timer?: NodeJS.Timeout;
    ackTimer?: NodeJS.Timeout;
    error?: Error;
}

/** Online documents stay joined for their entire session. The disk is an
 * autosaved replica, never the authority for transforming collaborator edits.
 */
export class OnlineTextSync implements vscode.Disposable {
    private readonly documents = new Map<string, DocumentState>();
    private readonly joining = new Map<string, Promise<void>>();
    private readonly early = new Map<string, DocumentUpdate[]>();
    private readonly listener: vscode.Disposable;
    private disposed = false;
    revision = 0;
    constructor(
        private readonly socket: SocketIOAPI,
        private readonly settings: SettingsManager,
        private readonly onError: (message: string) => void,
    ) {
        this.listener = vscode.workspace.onDidChangeTextDocument(event => {
            if (!event.contentChanges.length) return;
            const state = [...this.documents.values()].find(item => item.document === event.document);
            if (!state?.mirror) return;
            this.revision++;
            try {
                state.mirror.accept(event.document.getText(), event.document.version);
                if (!state.error) this.schedule(state);
            } catch (error) { this.fail(state, error); }
        });
    }

    has(id: string): boolean { return this.documents.has(id); }
    text(id: string): string | undefined { return this.documents.get(id)?.model.text; }
    remove(id: string): void {
        const state = this.documents.get(id);
        if (!state) return;
        state.error = new Error('Document removed');
        clearTimeout(state.timer);
        clearTimeout(state.ackTimer);
        this.documents.delete(id);
    }

    async open(id: string, path: string, createdLocally = false): Promise<void> {
        if (this.joining.has(id)) return this.joining.get(id);
        if (this.documents.has(id)) return;
        const task = this.openDocument(id, path, createdLocally);
        this.joining.set(id, task);
        try { await task; } finally { this.joining.delete(id); }
    }

    private async openDocument(id: string, path: string, createdLocally: boolean): Promise<void> {
        this.early.set(id, []);
        const { lines, version } = await this.socket.joinDoc(id);
        if (this.disposed) return;
        const initial = lines.join('\n');
        const state: DocumentState = { id, path, model: new TextSession(initial, version), queued: this.early.get(id) || [] };
        this.early.delete(id);
        this.documents.set(id, state);
        const uri = this.settings.getFilePath(path);
        let exists = true;
        try { await vscode.workspace.fs.stat(uri); } catch { exists = false; }
        if (!exists) {
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
            await vscode.workspace.fs.writeFile(uri, Buffer.from(initial));
        }
        const document = await vscode.workspace.openTextDocument(uri);
        const keepLocal = createdLocally;
        if (!createdLocally && exists && normalizeEditorText(document.getText()) !== initial) {
            // Mode switching is not an implicit Push or a destructive Pull.
            // Reconcile the local draft through the offline workflow first.
            throw new Error(`${path} differs from Overleaf. Use Offline Pull/Commit/Push before starting Online.`);
        }
        if (this.disposed) return;
        const local = normalizeEditorText(document.getText());
        if (keepLocal) state.model.submit(diffText(initial, local));
        state.document = document;
        state.mirror = new EditorMirror(local, state.model);
        if (!keepLocal) state.mirror.receive(diffText(local, initial));
        for (const update of state.queued) this.applyUpdate(state, update);
        state.queued = [];
        await this.render(state);
        this.send(state);
    }

    receive(update: DocumentUpdate): void {
        if (this.disposed) return;
        this.revision++;
        const state = this.documents.get(update.doc);
        if (!state) { this.early.get(update.doc)?.push(update); return; }
        if (!state.mirror) { state.queued.push(update); return; }
        if (state.error) return;
        try {
            this.applyUpdate(state, update);
            void this.render(state).catch(error => this.fail(state, error));
            this.send(state);
        } catch (error) { this.fail(state, error); }
    }

    private applyUpdate(state: DocumentState, update: DocumentUpdate): void {
        // Overleaf sends {doc,v} to the sender, and {doc,v,op,meta} to peers.
        // The applyOtUpdate callback only means queued, NOT committed by OT.
        const own = update.op === undefined || (!!update.meta?.source && update.meta.source === this.socket.publicId);
        const oldVersion = state.model.version;
        const op = state.model.receive(update.v, update.op || [], own);
        if (own && state.model.version > oldVersion) {
            clearTimeout(state.ackTimer);
            state.ackTimer = undefined;
        }
        state.mirror?.receive(op);
    }

    private schedule(state: DocumentState): void {
        clearTimeout(state.timer);
        // Persist immediately (including format-on-save edits); debounce only
        // transport. No global files.autoSave or workspace configuration changes.
        void this.render(state).catch(error => this.fail(state, error));
        const delay = vscode.workspace.getConfiguration('gitleaf').get('liveSyncDebounce', 250);
        state.timer = setTimeout(() => this.send(state), delay);
    }

    private send(state: DocumentState): void {
        if (this.disposed || state.error) return;
        const update = state.model.next();
        if (!update) return;
        state.ackTimer = setTimeout(() => this.fail(state, new Error('No OT acknowledgement received; local changes are saved. Reconnect to reconcile.')), 15000);
        void this.socket.applyOtUpdate(state.id, { doc: state.id, ...update })
            .catch(error => this.fail(state, error));
    }

    private render(state: DocumentState): Promise<void> {
        if (state.rendering) return state.rendering;
        state.rendering = this.renderLoop(state).finally(() => { state.rendering = undefined; });
        return state.rendering;
    }

    private async renderLoop(state: DocumentState): Promise<void> {
        const document = state.document;
        const mirror = state.mirror;
        if (!document || !mirror) return;
        while (!this.disposed && !state.error) {
            const pending = mirror.prepare(document.version);
            if (pending && pending.text !== normalizeEditorText(document.getText())) {
                const edit = new vscode.WorkspaceEdit();
                // Small, non-overlapping edits preserve selections/undo anchors.
                // VS Code stamps the open document's version on WorkspaceEdit;
                // a keystroke racing the edit rejects it, then the mirror retries.
                let offset = 0;
                const edits: vscode.TextEdit[] = [];
                // Diff in the editor's own EOL representation so positionAt()
                // receives CRLF offsets, while the OT model stays canonical LF.
                const renderedText = document.eol === vscode.EndOfLine.CRLF
                    ? pending.text.replace(/\n/g, '\r\n') : pending.text;
                const diffs = new DiffMatchPatch().diff_main(document.getText(), renderedText);
                for (let index = 0; index < diffs.length; index++) {
                    const [kind, value] = diffs[index];
                    if (kind === 0) { offset += value.length; continue; }
                    const start = offset;
                    let inserted = '';
                    if (kind === -1) {
                        offset += value.length;
                        if (diffs[index + 1]?.[0] === 1) inserted = diffs[++index][1];
                    } else inserted = value;
                    edits.push(vscode.TextEdit.replace(new vscode.Range(document.positionAt(start), document.positionAt(offset)), inserted));
                }
                edit.set(document.uri, edits);
                if (!(await vscode.workspace.applyEdit(edit))) mirror.cancel();
                continue;
            }
            if (document.isDirty && !(await document.save())) throw new Error(`Cannot autosave ${state.path}.`);
            // New edits or remote updates can arrive while save participants run.
            if (normalizeEditorText(document.getText()) !== state.model.text || document.isDirty) continue;
            return;
        }
    }

    private fail(state: DocumentState, error: unknown): void {
        if (this.disposed || state.error) return;
        state.error = error instanceof Error ? error : new Error(String(error));
        clearTimeout(state.ackTimer);
        this.onError(`${state.path}: ${state.error.message}`);
        // Even when the network fails, never strand the user's edits in memory.
        void state.document?.save();
    }

    async flush(): Promise<void> {
        await Promise.all(this.joining.values());
        for (const state of this.documents.values()) {
            if (state.error) throw state.error;
            await this.render(state);
            this.send(state);
        }
        const deadline = Date.now() + 16000;
        while ([...this.documents.values()].some(state => state.model.hasPending)) {
            const failure = [...this.documents.values()].find(state => state.error);
            if (failure?.error) throw failure.error;
            if (Date.now() > deadline) throw new Error('Online edits are not acknowledged yet. Keep this session open or reconnect.');
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }

    dispose(): void {
        this.disposed = true;
        this.listener.dispose();
        for (const state of this.documents.values()) {
            clearTimeout(state.timer);
            clearTimeout(state.ackTimer);
        }
        this.documents.clear();
    }
}
