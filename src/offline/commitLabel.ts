const PREFIX = 'GitLeaf: ';

export function commitLabel(message: string): string {
    return PREFIX + message;
}

export function commitMessage(label: string): string | undefined {
    if (!label.startsWith(PREFIX)) return undefined;
    return label.slice(PREFIX.length).trim() || undefined;
}
