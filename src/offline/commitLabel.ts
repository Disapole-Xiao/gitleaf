const PREFIX = 'GitLeaf: ';
const EMPTY_MESSAGE_LABEL = 'GitLeaf:empty-message';

export function commitLabel(message: string): string {
    return message ? PREFIX + message : EMPTY_MESSAGE_LABEL;
}

export function commitMessage(label: string): string | undefined {
    if (label === EMPTY_MESSAGE_LABEL) return '';
    if (!label.startsWith(PREFIX)) return undefined;
    return label.slice(PREFIX.length).trim() || undefined;
}
