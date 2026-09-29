import DiffMatchPatch from 'diff-match-patch';

export interface TextComponent { p: number; i?: string; d?: string }
export type TextOperation = TextComponent[];
export const normalizeDocumentText = (text: string): string => text.replace(/\r\n/g, '\n');

/** Overleaf text positions use UTF-16 offsets into LF-normalized text. */
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
