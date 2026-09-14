/**
 * GitLeaf Cursor Tracker
 * Tracks and displays collaborator cursors in real-time
 */

import * as vscode from 'vscode';
import { SocketIOAPI, OnlineUser, UserCursorUpdate } from '../api/socketio';
import { SettingsManager } from '../utils/projectAdapter';

/**
 * User cursor colors - matches Overleaf's color palette
 */
const CURSOR_COLORS = [
    '#ff8000', // orange
    '#8000ff', // purple
    '#ff00ff', // pink
    '#804000', // brown
    '#808080', // gray
    '#0080ff', // light blue
    '#00ff80', // light green
    '#ff80ff', // light purple
    '#ff80c0', // light pink
    '#ffff80', // light yellow
    '#ffc080', // light orange
    '#ff8080', // light red
    '#c0c0c0', // light gray
    '#c08040', // light brown
    '#000080', // dark blue
    '#008040', // dark green
];

/**
 * Generate a consistent hash from a string
 */
function hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
}

/**
 * Get a consistent color for a user based on their user ID
 */
function getColorForUserId(userId: string): string {
    const hash = hashString(userId);
    return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

/**
 * Extended user with decoration info
 */
export interface TrackedUser {
    clientId: string;
    userId: string;
    name: string;
    email: string;
    docId: string;
    docPath?: string;
    row: number;
    column: number;
    lastUpdated: number;
    color: string;
    decoration: vscode.TextEditorDecorationType;
    hoverMessage: vscode.MarkdownString;
}

/**
 * Cursor Tracker - manages collaborator cursor display
 */
export class CursorTracker {
    private users: Map<string, TrackedUser> = new Map();
    private userIdToColor: Map<string, string> = new Map(); // Consistent colors per user ID
    private disposables: vscode.Disposable[] = [];
    private _publicId?: string;
    private docIdToPath: Map<string, string> = new Map();

    constructor(
        private readonly socket: SocketIOAPI,
        private readonly settings: SettingsManager
    ) {
        this._publicId = socket.publicId;
        this.buildDocIdToPathMap();
        this.registerHandlers();
    }

    /**
     * Build mapping from doc IDs to file paths
     */
    private buildDocIdToPathMap(): void {
        // This will be populated by the sync engine
        // For now, we'll get paths from the project tree
        const project = this.socket.project;
        if (project) {
            this.traverseProject(project.rootFolder[0], '', true);
        }
    }

    /**
     * Traverse project tree to build doc ID to path mapping
     */
    private traverseProject(folder: any, parentPath: string, isRoot: boolean = false): void {
        // Root folder contents go directly to /, subfolders include their name
        const folderPath = isRoot ? '/' : parentPath + folder.name + '/';

        for (const doc of folder.docs || []) {
            this.docIdToPath.set(doc._id, folderPath + doc.name);
        }

        for (const subfolder of folder.folders || []) {
            this.traverseProject(subfolder, folderPath, false);
        }
    }

    /**
     * Register socket event handlers
     */
    private registerHandlers(): void {
        this.socket.registerHandlers({
            onConnected: (publicId) => {
                this._publicId = publicId;
            },
            onUserCursorUpdated: (update) => this.handleCursorUpdate(update),
            onUserDisconnected: (clientId) => this.handleUserDisconnected(clientId),
        });
    }

    /**
     * Initialize with connected users
     */
    async initialize(): Promise<void> {
        try {
            const users = await this.socket.getConnectedUsers();
            for (const user of users) {
                if (user.clientId !== this._publicId) {
                    this.addOrUpdateUser(user);
                }
            }
        } catch (error) {
            console.error('[GitLeaf] Failed to get connected users:', error);
        }

        // Listen for selection changes to update our position
        this.disposables.push(
            vscode.window.onDidChangeTextEditorSelection(e => this.handleLocalSelectionChange(e)),
            vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
            vscode.workspace.onDidChangeTextDocument(() => this.refreshDecorations())
        );
    }

    /**
     * Handle cursor update from another user
     */
    private handleCursorUpdate(update: UserCursorUpdate): void {
        if (update.id === this._publicId) return;

        const user: OnlineUser = {
            clientId: update.id,
            userId: update.user_id,
            name: update.name,
            email: update.email,
            docId: update.doc_id,
            row: update.row,
            column: update.column,
            lastUpdated: Date.now(),
        };

        this.addOrUpdateUser(user);
    }

    /**
     * Add or update a user's cursor
     */
    private addOrUpdateUser(user: OnlineUser): void {
        const existing = this.users.get(user.clientId);

        if (existing) {
            // Update existing user
            const oldDocPath = existing.docPath;
            existing.docId = user.docId;
            existing.docPath = this.docIdToPath.get(user.docId);
            existing.row = user.row;
            existing.column = user.column;
            existing.lastUpdated = user.lastUpdated;
            if (user.name) existing.name = user.name;

            // Clear decoration from old document if changed
            if (oldDocPath && oldDocPath !== existing.docPath) {
                this.clearDecoration(existing, oldDocPath);
            }

            // Update decoration in new document
            this.updateDecoration(existing);
        } else {
            // Create new tracked user
            // Use consistent color based on user ID (same user = same color across sessions)
            let color = this.userIdToColor.get(user.userId);
            if (!color) {
                color = getColorForUserId(user.userId);
                this.userIdToColor.set(user.userId, color);
            }

            const decoration = vscode.window.createTextEditorDecorationType({
                // A zero-width attachment is a caret, not a border around the
                // next character. It also renders consistently at line endings.
                before: { contentText: '', border: `1px solid ${color}`, width: '0px', height: '1em', margin: '0 -1px 0 0' },
                overviewRulerColor: color,
                overviewRulerLane: vscode.OverviewRulerLane.Center,
                rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
            });

            const hoverMessage = new vscode.MarkdownString();
            hoverMessage.appendText(user.name);

            const tracked: TrackedUser = {
                clientId: user.clientId,
                userId: user.userId,
                name: user.name,
                email: user.email,
                docId: user.docId,
                docPath: this.docIdToPath.get(user.docId),
                row: user.row,
                column: user.column,
                lastUpdated: user.lastUpdated,
                color,
                decoration,
                hoverMessage,
            };

            this.users.set(user.clientId, tracked);
            this.updateDecoration(tracked);
        }
    }

    /**
     * Update decoration for a user
     */
    private updateDecoration(user: TrackedUser): void {
        if (!user.docPath) return;

        const workspaceFolder = this.settings.getWorkspaceFolder();
        // Remove leading slash for proper path joining
        const relativePath = user.docPath.startsWith('/') ? user.docPath.slice(1) : user.docPath;
        const uri = vscode.Uri.joinPath(workspaceFolder, relativePath);

        const editors = vscode.window.visibleTextEditors.filter(
            e => e.document.uri.toString() === uri.toString()
        );

        for (const editor of editors) {
            const position = editor.document.validatePosition(new vscode.Position(Math.max(0, user.row), Math.max(0, user.column)));
            const range = new vscode.Range(position, position);
            editor.setDecorations(user.decoration, [{
                range,
                hoverMessage: user.hoverMessage,
            }]);
        }
    }

    /**
     * Clear decoration for a user from a specific document
     */
    private clearDecoration(user: TrackedUser, docPath: string): void {
        const workspaceFolder = this.settings.getWorkspaceFolder();
        // Remove leading slash for proper path joining
        const relativePath = docPath.startsWith('/') ? docPath.slice(1) : docPath;
        const uri = vscode.Uri.joinPath(workspaceFolder, relativePath);

        const editor = vscode.window.visibleTextEditors.find(
            e => e.document.uri.toString() === uri.toString()
        );

        if (editor) {
            editor.setDecorations(user.decoration, []);
        }
    }

    /**
     * Refresh all decorations
     */
    private refreshDecorations(): void {
        for (const user of this.users.values()) {
            this.updateDecoration(user);
        }
    }

    /**
     * Handle user disconnection
     */
    private handleUserDisconnected(clientId: string): void {
        const user = this.users.get(clientId);
        if (user) {
            // Clear decoration
            if (user.docPath) {
                this.clearDecoration(user, user.docPath);
            }
            user.decoration.dispose();
            this.users.delete(clientId);
        }
    }

    /**
     * Handle local selection change to update our position
     */
    private async handleLocalSelectionChange(event: vscode.TextEditorSelectionChangeEvent): Promise<void> {
        // Don't filter by event.kind - we want to track all cursor movements

        const uri = event.textEditor.document.uri;
        if (uri.scheme !== 'file') return;

        // Get relative path
        const relativePath = this.settings.getRelativePath(uri);
        if (!relativePath) return;

        // Find doc ID for this path
        let docId: string | undefined;
        for (const [id, path] of this.docIdToPath.entries()) {
            if (path === relativePath) {
                docId = id;
                break;
            }
        }

        if (docId) {
            const selection = event.selections[0];
            try {
                await this.socket.updatePosition(docId, selection.active.line, selection.active.character);
            } catch (error) {
                // Ignore errors (e.g., if disconnected)
            }
        }
    }

    /**
     * Update doc ID to path mapping
     */
    updateDocMapping(docId: string, path: string): void {
        this.docIdToPath.set(docId, path);
        for (const user of this.users.values()) {
            if (user.docId !== docId || user.docPath === path) continue;
            if (user.docPath) this.clearDecoration(user, user.docPath);
            user.docPath = path;
            this.updateDecoration(user);
        }
    }

    /**
     * Get online users
     */
    getOnlineUsers(): TrackedUser[] {
        return Array.from(this.users.values());
    }

    /**
     * Get user count
     */
    getUserCount(): number {
        return this.users.size;
    }

    /**
     * Jump to a user's cursor position
     */
    async jumpToUser(clientId?: string): Promise<void> {
        // Socket cursor events already keep this cache current. A name click
        // with a known location must not wait for a network round trip.
        const cached = clientId ? this.users.get(clientId) : undefined;
        if (!cached?.docPath) {
            // With no cached location, refresh the roster/cache once, then use
            // that updated cache for the jump below. Never jump a second time.
            const connected = await this.socket.getConnectedUsers();
            const ids = new Set(connected.map(user => user.clientId));
            for (const id of this.users.keys()) if (!ids.has(id)) this.handleUserDisconnected(id);
            for (const user of connected) if (user.clientId !== this._publicId) this.addOrUpdateUser(user);
        }
        let user: TrackedUser | undefined;

        if (clientId) {
            user = this.users.get(clientId);
            if (!user) {
                vscode.window.showInformationMessage('This collaborator is no longer online.');
                return;
            }
        } else if (this.users.size > 0) {
            // Show picker
            const items = Array.from(this.users.values()).map(u => ({
                label: u.name,
                description: u.docPath ? `${u.docPath}:${u.row + 1}` : 'Unknown location',
                user: u,
            }));

            const selected = await vscode.window.showQuickPick(items, {
                placeHolder: 'Select a collaborator to jump to',
            });

            if (selected) {
                user = selected.user;
            }
        } else {
            vscode.window.showInformationMessage('No collaborators online');
            return;
        }

        if (user && user.docPath) {
            const workspaceFolder = this.settings.getWorkspaceFolder();
            // Remove leading slash from docPath for proper joining
            const relativePath = user.docPath.startsWith('/') ? user.docPath.slice(1) : user.docPath;
            const uri = vscode.Uri.joinPath(workspaceFolder, relativePath);

            try {
                await vscode.window.showTextDocument(uri, {
                    selection: new vscode.Selection(user.row, user.column, user.row, user.column),
                    preview: false,
                });
            } catch (error) {
                // File might not exist locally yet, offer to pull
                vscode.window.showWarningMessage(
                    `Cannot open ${user.docPath}. The file may not exist locally. Try pulling from Overleaf.`,
                    'Pull Now'
                ).then(choice => {
                    if (choice === 'Pull Now') {
                        vscode.commands.executeCommand('gitleaf.pullFromOverleaf');
                    }
                });
            }
        } else if (user) {
            vscode.window.showInformationMessage(`${user.name} is not currently editing a document`);
        }
    }

    /**
     * Dispose resources
     */
    dispose(): void {
        for (const user of this.users.values()) {
            user.decoration.dispose();
        }
        this.users.clear();
        this.disposables.forEach(d => d.dispose());
    }
}
