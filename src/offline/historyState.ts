import type { HistoryCommitNode, HistoryPosition } from './historyModel';

export interface HistorySyncState {
    incoming?: number;
    outgoing: number;
    incomingComplete: boolean;
    outgoingComplete: boolean;
}

/** The graph's filled nodes and SCM's incoming count share this definition. */
export function isHistoryNodeSynced(node: HistoryCommitNode, position: HistoryPosition): boolean {
    return node.kind === 'remote' && (!!node.published || !!node.commit
        || position.baseVersion !== undefined && node.update.toV <= position.baseVersion);
}
