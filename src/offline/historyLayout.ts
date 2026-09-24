import type { HistoryCommitNode, HistoryPosition } from './historyModel';
import type { HistoryUpdate } from '../api/base';
import { commitMessage } from './commitLabel';
import { isHistoryNodeSynced } from './historyState';

export interface GraphRow {
    id: string;
    kind: 'local' | 'remote';
    lane: 'linear' | 'local' | 'remote' | 'join';
    pointers: string[];
    version?: number;
    localVersion?: number;
    label: string;
    hoverMessage: string;
    author: string;
    date: string;
    labels: string[];
    hash?: string;
    pending: boolean;
    combined: boolean;
    synced: boolean;
}

function overleafDate(timestamp: number): string {
    const date = new Date(timestamp);
    const day = date.getDate();
    const suffix = day % 100 >= 11 && day % 100 <= 13 ? 'th'
        : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[day % 10] || 'th';
    const month = new Intl.DateTimeFormat('en', { month: 'long' }).format(date);
    const time = new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit', hour12: true })
        .format(date).replace(/[\u00a0\u202f]/g, ' ').toLowerCase();
    return `${day}${suffix} ${month}, ${time}`;
}

/** Match the change summary shown in Overleaf's History panel. */
export function overleafHistoryMessage(update: HistoryUpdate): string {
    const origin = update.meta.origin;
    if (origin?.kind === 'project-restore') return `Restored project from ${overleafDate(origin.timestamp)}`;
    if (origin?.kind === 'file-restore') return `Restored ${origin.path} from: ${overleafDate(origin.timestamp)}`;
    if (origin?.kind === 'history-resync') return 'History resync';

    const changes = update.pathnames.map(pathname => `Edited\n${pathname}`);
    for (const op of update.project_ops || []) {
        if (op.rename) changes.push(`Renamed\n${op.rename.pathname} → ${op.rename.newPathname}`);
        if (op.add) changes.push(`Created\n${op.add.pathname}`);
        if (op.remove) changes.push(`Deleted\n${op.remove.pathname}`);
    }
    return changes.join('\n') || `Overleaf v${update.toV}`;
}

/** Version timeline, not fabricated Git ancestry. The badge and optional
 * commit message distinguish server-only, published, and unpublished nodes.
 */
export function layoutHistory(nodes: HistoryCommitNode[], position: HistoryPosition = {}): { rows: GraphRow[] } {
    const newestRemote = Math.max(-1, ...nodes.flatMap(node => node.kind === 'remote' ? [node.update.toV] : []));
    const local = nodes.filter(node => node.kind === 'local');
    const baseNode = nodes.find(node => node.kind === 'remote' && position.baseVersion !== undefined
        && node.update.fromV < position.baseVersion && position.baseVersion <= node.update.toV);
    const split = position.baseVersion !== undefined && newestRemote > position.baseVersion && local.length > 0;
    const rows: GraphRow[] = nodes.map(node => {
        const remoteLabels = node.kind === 'remote' ? [...(node.update.labels || [])]
            .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')) : [];
        const messages = remoteLabels.map(label => commitMessage(label.comment)).filter((message): message is string => message !== undefined);
        const version = node.kind === 'remote' ? node.update.toV : undefined;
        const pointers: string[] = [];
        if (node === local[0] || !local.length && node === baseNode) pointers.push('LOCAL');
        if (version === newestRemote) pointers.push('REMOTE');
        return {
            id: node.id, kind: node.kind,
            lane: split ? node.kind === 'local' ? 'local' : node === baseNode ? 'join'
                : version! > position.baseVersion! ? 'remote' : 'linear' : 'linear',
            pointers,
            version,
            localVersion: node.kind === 'remote' && pointers.includes('LOCAL') ? position.baseVersion : undefined,
            label: node.kind === 'local' ? node.commit.subject
                : messages[0] || '',
            hoverMessage: node.kind === 'remote' ? [...messages, overleafHistoryMessage(node.update)].join('\n\n') : node.commit.subject,
            author: node.kind === 'remote' ? node.update.meta.users
                .map(user => [user.first_name, user.last_name].filter(Boolean).join(' ')).join(', ')
                : node.commit.author,
            date: new Date(node.kind === 'remote' ? node.update.meta.end_ts : node.commit.date).toISOString(),
            labels: node.kind === 'remote' ? remoteLabels.filter(label => commitMessage(label.comment) === undefined)
                .map(label => label.comment) : node.labels || [],
            hash: node.commit?.shortHash,
            pending: node.kind === 'local' && !!node.pending,
            combined: node.kind === 'remote' && !!node.commit,
            synced: isHistoryNodeSynced(node, position),
        };
    });
    return { rows };
}
