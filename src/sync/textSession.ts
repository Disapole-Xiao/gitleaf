import DiffMatchPatch from 'diff-match-patch';

export interface TextComponent { p: number; i?: string; d?: string }
export type TextOperation = TextComponent[];
/** Overleaf uses LF offsets. VS Code may render the same text as CRLF on Windows. */
export const normalizeEditorText = (text: string): string => text.replace(/\r\n/g, '\n');
interface JsonOperation { p: never[]; t: 'text0'; o: TextOperation }
// Use the public JSON0 subtype API. text0 is the UTF-16 p/i/d protocol used
// by Overleaf; JSON0 supplies its tested transform/compose implementation.
const json0 = (require('ot-json0') as { type: {
    apply(text: string, op: JsonOperation[]): string;
    compose(a: JsonOperation[], b: JsonOperation[]): JsonOperation[];
    transform(a: JsonOperation[], b: JsonOperation[], side: 'left' | 'right'): JsonOperation[];
} }).type;
const wrap = (op: TextOperation): JsonOperation[] => op.length ? [{ p: [], t: 'text0', o: op }] : [];
const unwrap = (op: JsonOperation[]): TextOperation => op.flatMap(item => item.o);
export const applyText = (text: string, op: TextOperation): string => json0.apply(text, wrap(op));
export const composeText = (a: TextOperation, b: TextOperation): TextOperation => unwrap(json0.compose(wrap(a), wrap(b)));
export function transformText(a: TextOperation, b: TextOperation): [TextOperation, TextOperation] {
    return [unwrap(json0.transform(wrap(a), wrap(b), 'left')), unwrap(json0.transform(wrap(b), wrap(a), 'right'))];
}
export function diffText(before: string, after: string): TextOperation {
    const diffs = new DiffMatchPatch().diff_main(before, after);
    let position = 0;
    const op: TextOperation = [];
    for (const [kind, value] of diffs) {
        if (kind === 0) position += value.length;
        else if (kind === -1) op.push({ p: position, d: value });
        else { op.push({ p: position, i: value }); position += value.length; }
    }
    return op;
}

/** One in-flight operation plus a composed pending buffer, as in ShareJS.
 * Never reconstruct an edit by downloading the latest remote text and
 * replacing it with an older local snapshot: that deletes concurrent edits.
 */
export class TextSession {
    private pending: TextOperation = [];
    private inflight?: TextOperation;
    private previousSentVersion?: number;
    constructor(public text: string, public version: number) {}
    get hasPending(): boolean { return !!this.inflight || this.pending.length > 0; }
    submit(op: TextOperation): void {
        this.text = applyText(this.text, op);
        this.pending = composeText(this.pending, op);
    }
    next(): { op: TextOperation; v: number; lastV?: number } | undefined {
        if (this.inflight || !this.pending.length) return;
        this.inflight = this.pending;
        this.pending = [];
        const update = { op: this.inflight, v: this.version, lastV: this.previousSentVersion };
        this.previousSentVersion = this.version;
        return update;
    }
    receive(version: number, op: TextOperation, own: boolean): TextOperation {
        if (version < this.version) return []; // Broadcast and callback can acknowledge the same op.
        if (version !== this.version) throw new Error(`Document version gap: expected ${this.version}, received ${version}. Reconnect before editing online.`);
        if (own) {
            if (!this.inflight) throw new Error('Unexpected document acknowledgement.');
            this.inflight = undefined;
        } else {
            if (this.inflight) [this.inflight, op] = transformText(this.inflight, op);
            [this.pending, op] = transformText(this.pending, op);
            this.text = applyText(this.text, op);
        }
        this.version++;
        return own ? [] : op;
    }
}

/** A second OT boundary bridges the synchronous document model and VS Code's
 * asynchronous edit API. Keystrokes arriving before an outstanding editor
 * edit is rendered must be transformed too, not mistaken for a remote echo.
 */
export class EditorMirror {
    private remote: TextOperation = [];
    private expected?: { version: number; text: string; tail: TextOperation };
    constructor(public text: string, readonly session: TextSession) {
        this.text = normalizeEditorText(text);
    }
    receive(op: TextOperation): void {
        this.remote = composeText(this.remote, op);
        if (this.expected) this.expected.tail = composeText(this.expected.tail, op);
    }
    accept(text: string, version: number): void {
        // A remote LF rendered as CRLF is an acknowledgement, not a fresh edit.
        // Otherwise every render adds another newline and echoes it to Overleaf.
        text = normalizeEditorText(text);
        if (this.expected?.version === version - 1 && this.expected.text === text) {
            this.remote = this.expected.tail;
        } else {
            const [local, remote] = transformText(diffText(this.text, text), this.remote);
            this.session.submit(local);
            this.remote = remote;
        }
        this.expected = undefined;
        this.text = text;
    }
    prepare(version: number): { text: string; op: TextOperation } | undefined {
        if (!this.remote.length) return;
        const text = applyText(this.text, this.remote);
        if (text === this.text) { this.remote = []; this.expected = undefined; return; }
        this.expected = { version, text, tail: [] };
        return { text, op: this.remote };
    }
    cancel(): void { this.expected = undefined; }
}
