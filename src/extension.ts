/**
 * GitLeaf VS Code Extension
 * Local sync for Overleaf LaTeX projects
 */

import * as vscode from 'vscode';
import { COMMANDS, EXTENSION_NAME, STATUS_BAR_PRIORITY, CONFIG_DIR, IGNORE_FILE } from './consts';
import { Credentials, login, projects } from './core/credentials';
import { EditorState } from './utils/editorState';
import { SettingsManager, createSettingsWatcher } from './utils/projectAdapter';
import { BaseAPI } from './api/base';
import { SyncEngine } from './sync/syncEngine';
import { SyncStatus } from './core/remoteProject';
import { DEFAULT_SERVER } from './consts';
import { IgnoreParser } from './sync/ignoreParser';
import { IgnoredFileDecorations } from './sync/ignoredFileDecorations';
import { CursorTracker } from './collaboration/cursorTracker';
import { renderCollaboratorStatus } from './collaboration/collaboratorTooltip';
import { setOutputChannel } from './api/socketio';
import { OfflineController } from './offline/offlineController';
import { HistoryGraph } from './offline/historyGraph';
import { GitContentProvider, GitResourceState, registerGitContentProvider } from './offline/scmProvider';
import { GitRepository, WorkingChange } from './offline/gitRepository';

/**
 * Auth state type
 */
type AuthState = 'valid' | 'expired' | 'none';

/**
 * Extension state
 */
let credentialManager: Credentials;
let syncEngine: SyncEngine | undefined;
let cursorTracker: CursorTracker | undefined;
let offlineController: OfflineController | undefined;
let ignoredFileDecorations: IgnoredFileDecorations | undefined;
const editorStates = new Map<string, EditorState>();
function trackEditorState(settings: SettingsManager): void {
    if (!editorStates.has(settings.root)) editorStates.set(settings.root, new EditorState(settings));
}
let gitContentProvider: GitContentProvider;
let historyGraph: HistoryGraph;
let statusBarItem: vscode.StatusBarItem;
let loginStatusItem: vscode.StatusBarItem;
let collaboratorStatusItem: vscode.StatusBarItem;
let outputChannel: vscode.OutputChannel;
let statusUpdateInterval: NodeJS.Timeout | undefined;
let authState: AuthState = 'none';
let offlineOperation: Promise<unknown> = Promise.resolve();
let changingMode = false;
function runOffline(operation: (controller: OfflineController) => Promise<unknown>): Promise<unknown> {
    const controller = offlineController;
    if (changingMode) return Promise.reject(new Error('Wait for the mode switch to finish.'));
    if (!controller) return Promise.resolve();
    // A commit must not race stage/reset/fetch against the same Git index.
    const result = offlineOperation.then(() => {
        if (controller !== offlineController) throw new Error('Active project changed; retry the command.');
        return operation(controller);
    });
    offlineOperation = result.catch(() => undefined);
    return result;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
    try {

    // Initialize output channel
    outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);
    context.subscriptions.push(outputChannel);

    // Share output channel with socketio module for logging
    setOutputChannel(outputChannel);

    // Initialize credential manager and the virtual document provider used by
    // VS Code's native word-level diff editor.
    credentialManager = new Credentials();
    SettingsManager.initialize(context.workspaceState);
    gitContentProvider = registerGitContentProvider(context);
    historyGraph = new HistoryGraph(context.extensionUri, context.globalState);
    context.subscriptions.push(historyGraph);

    // Create status bar items
    // Sync status (left side)
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY);
    statusBarItem.name = `${EXTENSION_NAME} Sync`;
    context.subscriptions.push(statusBarItem);

    // Login status (left side, before sync)
    loginStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY + 1);
    loginStatusItem.name = `${EXTENSION_NAME} Login`;
    loginStatusItem.command = COMMANDS.LOGIN;
    context.subscriptions.push(loginStatusItem);

    // Collaborator status (left side, next to sync)
    collaboratorStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY - 1);
    collaboratorStatusItem.name = `${EXTENSION_NAME} Collaborators`;
    // Names in the tooltip are direct jump links; clicking the status item
    // itself must not open another collaborator-selection menu.
    context.subscriptions.push(collaboratorStatusItem);

    // Update login status
    await updateLoginStatus();

    // Register commands
    registerCommands(context);

    // Discover linked folders across a multi-root workspace. A single active
    // controller keeps commands predictable; the active editor chooses it.
    let settingsManager: SettingsManager | undefined;
    for (const candidate of SettingsManager.getWorkspaceInstances()) {
        if (await candidate.isLinked()) {
            trackEditorState(candidate);
            await candidate.load();
            settingsManager ||= candidate;
        }
    }
    if (settingsManager) {
        // Show status bar only when linked
        statusBarItem.show();
        await initializeSync(context, settingsManager);
    } else {
        // Hide sync status bar when not linked
        statusBarItem.hide();
        collaboratorStatusItem.hide();
    }

    // Watch for settings changes
    const workspaceFolder = settingsManager?.getWorkspaceFolder();
    if (workspaceFolder) {
        const settingsWatcher = createSettingsWatcher(workspaceFolder, async () => {
            log('Settings changed, reloading...');
            await settingsManager?.load();
            const actualMode = syncEngine ? 'online' : 'offline';
            if (!changingMode && settingsManager?.getSettings()?.mode !== actualMode) {
                await settingsManager?.update({ mode: actualMode, autoSync: actualMode === 'online' });
                void vscode.window.showWarningMessage('Use GitLeaf: Change Mode to switch safely; editing the mode field cannot bypass sync checks.');
            }
        });
        context.subscriptions.push(settingsWatcher);
    }

    log('GitLeaf activated');

    } catch (error) {
        console.error('[GitLeaf] Activation error:', error);
        vscode.window.showErrorMessage(`GitLeaf failed to activate: ${error}`);
    }
}

/**
 * Register all commands
 */
function registerCommands(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand(COMMANDS.LOGIN, cmdLogin),
        vscode.commands.registerCommand(COMMANDS.LOGOUT, cmdLogout),
        vscode.commands.registerCommand(COMMANDS.LINK_FOLDER, () => cmdLinkFolder(context)),
        vscode.commands.registerCommand(COMMANDS.UNLINK_FOLDER, cmdUnlinkFolder),
        vscode.commands.registerCommand(COMMANDS.SYNC_NOW, cmdSyncNow),
        vscode.commands.registerCommand(COMMANDS.PULL_FROM_OVERLEAF, cmdPullFromOverleaf),
        vscode.commands.registerCommand(COMMANDS.PUSH_TO_OVERLEAF, cmdPushToOverleaf),
        vscode.commands.registerCommand(COMMANDS.EDIT_IGNORE_PATTERNS, cmdEditIgnorePatterns),
        vscode.commands.registerCommand(COMMANDS.CLEAN_IGNORED_REMOTE, cmdCleanIgnoredRemoteFiles),
        vscode.commands.registerCommand(COMMANDS.SHOW_SYNC_STATUS, cmdShowSyncStatus),
        vscode.commands.registerCommand(COMMANDS.SET_MAIN_DOCUMENT, cmdSetMainDocument),
        vscode.commands.registerCommand(COMMANDS.CONFIGURE, cmdConfigure),
        vscode.commands.registerCommand(COMMANDS.JUMP_TO_COLLABORATOR, cmdJumpToCollaborator),
        vscode.commands.registerCommand(COMMANDS.VERIFY_CREDENTIALS, cmdVerifyCredentials),
        vscode.commands.registerCommand(COMMANDS.REFRESH_COOKIE, cmdRefreshCookie),
        vscode.commands.registerCommand(COMMANDS.COMMIT, () => runOffline(controller => controller.commit())),
        vscode.commands.registerCommand(COMMANDS.STAGE, (...states: GitResourceState[]) => runOffline(controller => controller.stage(states.map(state => state.change)))),
        vscode.commands.registerCommand(COMMANDS.UNSTAGE, (...states: GitResourceState[]) => runOffline(controller => controller.unstage(states.map(state => state.change)))),
        vscode.commands.registerCommand(COMMANDS.STAGE_ALL, () => runOffline(controller => controller.stage())),
        vscode.commands.registerCommand(COMMANDS.UNSTAGE_ALL, () => runOffline(controller => controller.unstage())),
        vscode.commands.registerCommand(COMMANDS.DISCARD, (...states: GitResourceState[]) => runOffline(controller => controller.discard(states.filter(state => state?.change && !state.staged).map(state => state.change)))),
        vscode.commands.registerCommand(COMMANDS.DISCARD_ALL, () => runOffline(controller => controller.discard())),
        vscode.commands.registerCommand(COMMANDS.STASH, () => runOffline(controller => controller.stash('save'))),
        vscode.commands.registerCommand(COMMANDS.STASH_APPLY, () => runOffline(controller => controller.stash('apply'))),
        vscode.commands.registerCommand(COMMANDS.STASH_POP, () => runOffline(controller => controller.stash('pop'))),
        vscode.commands.registerCommand(COMMANDS.STASH_DROP, () => runOffline(controller => controller.stash('drop'))),
        vscode.commands.registerCommand(COMMANDS.FETCH, () => runOffline(controller => controller.fetch())),
        vscode.commands.registerCommand(COMMANDS.REMOTE_HISTORY, () => offlineController?.showRemoteHistory()),
        vscode.commands.registerCommand(COMMANDS.REFRESH_CHANGES, () => offlineController?.refresh()),
        vscode.commands.registerCommand(COMMANDS.SHOW_HISTORY, (hash?: string) => offlineController?.showHistory(hash)),
        vscode.commands.registerCommand(COMMANDS.REFRESH_HISTORY, () => offlineController?.refreshHistory()),
        vscode.commands.registerCommand(COMMANDS.HISTORY_VIEW_AS_LIST, () => historyGraph.setMode('list')),
        vscode.commands.registerCommand(COMMANDS.HISTORY_VIEW_AS_TREE, () => historyGraph.setMode('tree')),
        vscode.commands.registerCommand(COMMANDS.HISTORY_VIEW_AS_LIST_SELECTED, () => historyGraph.setMode('list')),
        vscode.commands.registerCommand(COMMANDS.HISTORY_VIEW_AS_TREE_SELECTED, () => historyGraph.setMode('tree')),
        vscode.commands.registerCommand(COMMANDS.OPEN_CHANGE, (_provider: unknown, change: WorkingChange, staged?: boolean) => offlineController?.openChange(change, staged)),
        vscode.commands.registerCommand(COMMANDS.MARK_RESOLVED, (value?: WorkingChange | GitResourceState) =>
            runOffline(controller => controller.resolveConflict(value && 'change' in value ? value.change : value))),
        vscode.commands.registerCommand(COMMANDS.ABORT_PULL, () => runOffline(controller => controller.abortPull())),
        vscode.commands.registerCommand(COMMANDS.CHANGE_MODE, () => cmdChangeMode(context)),
    );
}

/**
 * Initialize sync engine for linked folder
 */
async function initializeSync(
    context: vscode.ExtensionContext,
    settings: SettingsManager,
    fetchOfflineInitial = false,
    onlineVerified = false,
): Promise<void> {
    let projectSettings = settings.getSettings();
    if (!projectSettings) return;
    if (projectSettings.mode === 'online' && !onlineVerified) {
        const guard = new OfflineController(settings, credentialManager, gitContentProvider, historyGraph, log);
        try { await guard.prepareOnline(); }
        catch (error) {
            // Restart/reconnect must not silently publish drafts left on disk.
            // Start safely in Offline with the existing baseline and history.
            await settings.update({ mode: 'offline', autoSync: false });
            projectSettings = settings.getSettings()!;
            fetchOfflineInitial = true;
            void vscode.window.showWarningMessage(`GitLeaf opened Offline: ${errorMessage(error)}`);
        }
    }
    await syncEngine?.flushOnline();
    SettingsManager.setActive(settings);
    await vscode.commands.executeCommand('setContext', 'gitleaf.mode', projectSettings.mode);

    await syncEngine?.close();
    syncEngine = undefined;
    cursorTracker?.dispose();
    cursorTracker = undefined;
    offlineController?.dispose();
    offlineController = undefined;
    stopStatusUpdates();

    ignoredFileDecorations?.dispose();
    ignoredFileDecorations = new IgnoredFileDecorations(settings.getWorkspaceFolder(), log);
    trackEditorState(settings);

    if (projectSettings.mode === 'offline') {
        offlineController = new OfflineController(
            settings,
            credentialManager,
            gitContentProvider,
            historyGraph,
            log,
            event => updateStatusBar(event.status, event.message),
            async action => { await runOffline(() => action()); },
        );
        await offlineController.initialize(fetchOfflineInitial);
        collaboratorStatusItem.hide();
        updateStatusBar('idle', 'Offline mode · explicit commit, pull and push');
        return;
    }

    // Get credentials
    const credential = await credentialManager.getCredential(projectSettings.serverUrl);
    if (!credential) {
        updateStatusBar('disconnected', 'Not logged in');
        vscode.window.showWarningMessage('GitLeaf: Please login to Overleaf first');
        return;
    }

    // Create API
    const api = new BaseAPI(projectSettings.serverUrl);
    api.setIdentity(credential.identity);

    // Create sync engine
    syncEngine = new SyncEngine(api, settings, log);

    // Listen to status changes
    syncEngine.onStatusChange(async event => {
        updateStatusBar(event.status, event.message);
        // Handle auth errors
        if (event.authError) {
            await setAuthState('expired');
            showSessionExpiredNotification();
        }
    });

    // Connect
    try {
        await syncEngine.connect();

        // Initialize cursor tracker
        const socket = syncEngine.getSocket();
        if (socket) {
            cursorTracker = new CursorTracker(socket, settings);
            await cursorTracker.initialize();
            context.subscriptions.push({ dispose: () => cursorTracker?.dispose() });
        }

        // Start periodic status updates for collaborators
        startStatusUpdates();

        log('Sync engine connected');

        // Auto-detect main document from project settings
        await syncEngine.detectMainDocument();

        // Auto-pull on project load
        try {
            log('Auto-pulling files from Overleaf...');
            await syncEngine.pullAll();
            log('Auto-pull complete');

            // Join all docs to receive real-time OT updates
            await syncEngine.joinAllDocsForWatching();
            log('Watching for remote changes');

            vscode.window.showInformationMessage(`GitLeaf: Synced with "${projectSettings.projectName}"`);
        } catch (pullError) {
            log(`Auto-pull failed: ${pullError}`);
            throw pullError;
        }
    } catch (error) {
        log(`Failed to connect: ${error}`);
        await syncEngine?.close();
        throw error;
    }
}

/**
 * Update sync status bar
 */
function updateStatusBar(status: SyncStatus, message?: string) {
    const offline = SettingsManager.getCurrentInstance()?.getSettings()?.mode === 'offline';
    const icons: Record<SyncStatus, string> = {
        idle: '$(cloud)',
        syncing: '$(sync~spin)',
        pulling: '$(cloud-download)',
        pushing: '$(cloud-upload)',
        error: '$(warning)',
        disconnected: '$(cloud-offline)',
    };

    statusBarItem.text = offline ? '$(source-control) GitLeaf Offline' : `${icons[status]} GitLeaf Online`;
    statusBarItem.tooltip = new vscode.MarkdownString(`**GitLeaf** - ${message || status}`);
    statusBarItem.command = COMMANDS.SHOW_SYNC_STATUS;

    if (status === 'error') {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (status === 'disconnected') {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.backgroundColor = undefined;
    }

    statusBarItem.show();

    // Update collaborator status bar based on connection
    if (offline || status === 'disconnected' || status === 'error') {
        collaboratorStatusItem.hide();
    }
}

/**
 * Update auth state and refresh UI
 */
async function setAuthState(state: AuthState): Promise<void> {
    authState = state;
    await updateLoginStatus();
}

/**
 * Update login status bar
 */
async function updateLoginStatus() {
    // Only show login status if folder is linked
    const settingsManager = SettingsManager.getCurrentInstance();
    const isLinked = settingsManager && await settingsManager.isLinked();

    if (!isLinked) {
        loginStatusItem.hide();
        return;
    }

    const serverUrl = vscode.workspace.getConfiguration('gitleaf').get<string>('defaultServer', DEFAULT_SERVER);
    const credential = await credentialManager.getCredential(serverUrl);

    if (credential && authState === 'valid') {
        // Logged in with valid session
        loginStatusItem.text = `$(account) ${credential.userEmail}`;
        loginStatusItem.tooltip = new vscode.MarkdownString(
            `**Logged in to Overleaf**\n\n` +
            `Email: ${credential.userEmail}\n\n` +
            `Server: ${credential.serverUrl}`
        );
        loginStatusItem.backgroundColor = undefined;
        loginStatusItem.command = COMMANDS.LOGOUT;
    } else if (credential && authState === 'expired') {
        // Session expired - show warning state
        loginStatusItem.text = `$(warning) ${credential.userEmail} (expired)`;
        loginStatusItem.tooltip = new vscode.MarkdownString(
            `**Session Expired**\n\n` +
            `Email: ${credential.userEmail}\n\n` +
            `Server: ${credential.serverUrl}\n\n` +
            `Click to refresh your cookie`
        );
        loginStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        loginStatusItem.command = COMMANDS.REFRESH_COOKIE;
    } else if (credential) {
        // Credential exists but auth state not confirmed yet (assume valid until proven otherwise)
        loginStatusItem.text = `$(account) ${credential.userEmail}`;
        loginStatusItem.tooltip = new vscode.MarkdownString(
            `**Logged in to Overleaf**\n\n` +
            `Email: ${credential.userEmail}\n\n` +
            `Server: ${credential.serverUrl}`
        );
        loginStatusItem.backgroundColor = undefined;
        loginStatusItem.command = COMMANDS.LOGOUT;
    } else {
        // Not logged in
        authState = 'none';
        loginStatusItem.text = '$(account) Not logged in';
        loginStatusItem.tooltip = 'Click to login to Overleaf';
        loginStatusItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        loginStatusItem.command = COMMANDS.LOGIN;
    }

    loginStatusItem.show();
}

/**
 * Show session expired notification with action buttons
 */
async function showSessionExpiredNotification(): Promise<void> {
    const action = await vscode.window.showWarningMessage(
        'GitLeaf: Your Overleaf session has expired.',
        'Refresh Cookie',
        'Dismiss'
    );

    if (action === 'Refresh Cookie') {
        await cmdRefreshCookie();
    }
}

/**
 * Update collaborator status bar
 */
let collaboratorRoster = '';
function updateCollaboratorStatus() {
    if (!cursorTracker || !syncEngine || syncEngine.status === 'disconnected') {
        collaboratorRoster = renderCollaboratorStatus(collaboratorStatusItem, undefined, collaboratorRoster);
        return;
    }
    for (const entry of syncEngine.getFileTree().values()) {
        if (entry.type === 'doc') cursorTracker.updateDocMapping(entry.id, entry.path);
    }
    collaboratorRoster = renderCollaboratorStatus(collaboratorStatusItem, cursorTracker.getOnlineUsers(), collaboratorRoster);
}

/**
 * Start periodic status updates
 */
function startStatusUpdates() {
    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
    }
    collaboratorRoster = '';
    updateCollaboratorStatus();
    statusUpdateInterval = setInterval(() => {
        updateCollaboratorStatus();
    }, 1000);
}

/**
 * Stop periodic status updates
 */
function stopStatusUpdates() {
    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
        statusUpdateInterval = undefined;
    }
}

/**
 * Log to output channel
 */
function log(message: string) {
    const timestamp = new Date().toISOString();
    outputChannel.appendLine(`[${timestamp}] ${message}`);
}

// === Command Implementations ===

/**
 * Login to Overleaf
 */
async function cmdLogin() {
    const serverUrl = await vscode.window.showInputBox({
        prompt: 'Enter Overleaf server URL',
        value: vscode.workspace.getConfiguration('gitleaf').get<string>('defaultServer', DEFAULT_SERVER),
        placeHolder: 'https://www.overleaf.com',
    });

    if (!serverUrl) return;

    // For www.overleaf.com, use cookie-based login
    let isOfficialServer = false;
    try {
        const parsed = new URL(serverUrl);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
            throw new Error('Unsupported protocol');
        }
        const hostname = parsed.hostname.toLowerCase();
        isOfficialServer = hostname === 'overleaf.com' || hostname.endsWith('.overleaf.com');
    } catch {
        vscode.window.showErrorMessage('GitLeaf: Enter a valid http(s) server URL.');
        return;
    }

    if (isOfficialServer) {
        // Show help option before asking for cookies
        const helpChoice = await vscode.window.showInformationMessage(
            'You need to paste your Overleaf cookies to login.',
            'How to get cookies?',
            'Continue'
        );

        if (!helpChoice) return;

        if (helpChoice === 'How to get cookies?') {
            await vscode.env.openExternal(vscode.Uri.parse('https://github.com/overleaf-workshop/Overleaf-Workshop/blob/master/docs/wiki.md#login-with-cookies'));
            // Show input box after opening the tutorial
        }

        const cookies = await vscode.window.showInputBox({
            prompt: 'Paste your Overleaf cookies (see tutorial for help)',
            placeHolder: 'overleaf_session2=...',
            password: true,
        });

        if (!cookies) return;

        const result = await login(credentialManager, serverUrl, { cookies });
        await vscode.workspace.getConfiguration('gitleaf').update('defaultServer', serverUrl, vscode.ConfigurationTarget.Global);
        await setAuthState('valid');
        void vscode.window.showInformationMessage(`GitLeaf: Logged in as ${result.userEmail}`);
    } else {
        // For self-hosted, use email/password
        const email = await vscode.window.showInputBox({
            prompt: 'Enter your email',
            placeHolder: 'email@example.com',
        });

        if (!email) return;

        const password = await vscode.window.showInputBox({
            prompt: 'Enter your password',
            password: true,
        });

        if (!password) return;

        const result = await login(credentialManager, serverUrl, { email, password });
        await vscode.workspace.getConfiguration('gitleaf').update('defaultServer', serverUrl, vscode.ConfigurationTarget.Global);
        await setAuthState('valid');
        void vscode.window.showInformationMessage(`GitLeaf: Logged in as ${result.userEmail}`);
    }
}

/**
 * Logout from Overleaf
 */
async function cmdLogout() {
    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to logout from Overleaf?',
        'Logout',
        'Cancel'
    );

    if (confirm !== 'Logout') return;

    const serverUrl = vscode.workspace.getConfiguration('gitleaf').get<string>('defaultServer', DEFAULT_SERVER);
    await credentialManager.deleteCredential(serverUrl);

    // Disconnect sync engine but keep settings
    if (syncEngine) {
        await syncEngine.close();
        syncEngine = undefined;
    }

    if (cursorTracker) {
        cursorTracker.dispose();
        cursorTracker = undefined;
    }
    offlineController?.dispose();
    offlineController = undefined;
    stopStatusUpdates();

    updateStatusBar('disconnected', 'Logged out');
    await updateLoginStatus();
    vscode.window.showInformationMessage('GitLeaf: Logged out');
}

/**
 * Link a user-selected folder to an Overleaf project
 */
async function cmdLinkFolder(context: vscode.ExtensionContext) {
    // Get server URL
    const serverUrl = vscode.workspace.getConfiguration('gitleaf').get<string>('defaultServer', DEFAULT_SERVER);

    // Check if logged in
    let credential = await credentialManager.getCredential(serverUrl);
    if (!credential) {
        vscode.window.showWarningMessage('GitLeaf: Please login first');
        await cmdLogin();
        credential = await credentialManager.getCredential(serverUrl);
        if (!credential) return;
    }

    const activeProjects = await projects(credentialManager, serverUrl);

    // Show project picker
    const items = activeProjects.map(p => ({
        label: p.name,
        description: `${p.accessLevel}${p.lastUpdated ? ` - ${new Date(p.lastUpdated).toLocaleDateString()}` : ''}`,
        project: p,
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select an Overleaf project to link',
    });

    if (!selected) return;

    const project = selected.project;

    const folderSelection = await vscode.window.showOpenDialog({
        title: `Choose a local folder for "${project.name}"`,
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Link This Folder',
    });
    const workspaceFolder = folderSelection?.[0];
    if (!workspaceFolder) return;

    const modeSelection = await vscode.window.showQuickPick([
        {
            label: '$(radio-tower) Online',
            description: 'Live editing, automatic synchronization, collaborator cursors',
            mode: 'online' as const,
        },
        {
            label: '$(source-control) Offline',
            description: 'Explicit commit, pull, push, history and conflict resolution',
            mode: 'offline' as const,
        },
    ], { title: 'Choose the synchronization mode' });
    if (!modeSelection) return;

    // The selected directory is the worktree in both modes. Do not mutate the
    // VS Code workspace (which can restart the extension host mid-download).

    // Create settings
    const settingsManager = SettingsManager.getInstance(workspaceFolder);
    if (await settingsManager.isLinked()) {
        vscode.window.showWarningMessage('GitLeaf: The selected folder is already linked.');
        return;
    }
    const controller = new OfflineController(settingsManager, credentialManager, gitContentProvider, historyGraph, log);
    try {
        await controller.core.link({ serverUrl, projectId: project.id, projectName: project.name });
        if (modeSelection.mode === 'online') {
            await controller.prepareOnline(true);
        }
        await initializeSync(context, settingsManager, false, modeSelection.mode === 'online');
        statusBarItem.show();
        await updateLoginStatus();
        void vscode.window.showInformationMessage(`GitLeaf: Linked to "${project.name}"`);
    } catch (error) {
        if (settingsManager.getSettings()) {
            await settingsManager.update({ mode: 'offline', autoSync: false });
            await initializeSync(context, settingsManager);
        }
        log(`Initial project download failed: ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(`GitLeaf: Initial download failed. Use Pull to retry. ${errorMessage(error)}`);
    } finally { controller.dispose(); }
}

/**
 * Unlink current folder
 */
async function cmdUnlinkFolder() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showInformationMessage('GitLeaf: This folder is not linked');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to unlink this folder from Overleaf?',
        { modal: true },
        'Unlink'
    );

    if (confirm !== 'Unlink') return;

    // Disconnect
    if (syncEngine) {
        await syncEngine.close();
        syncEngine = undefined;
    }

    if (cursorTracker) {
        cursorTracker.dispose();
        cursorTracker = undefined;
    }
    offlineController?.dispose();
    offlineController = undefined;
    stopStatusUpdates();

    // Delete settings
    await settingsManager.clear();
    await vscode.commands.executeCommand('setContext', 'gitleaf.mode', undefined);
    ignoredFileDecorations?.dispose();
    ignoredFileDecorations = undefined;

    updateStatusBar('disconnected');
    vscode.window.showInformationMessage('GitLeaf: Folder unlinked');
}

/** Pull before pushing so a conflicting remote update cannot be published over. */
async function cmdSyncNow() {
    if (!syncEngine && !offlineController) {
        vscode.window.showWarningMessage('GitLeaf: Not connected. Please link a folder first.');
        return;
    }

    if (offlineController) {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'GitLeaf: Synchronizing with Overleaf...',
                cancellable: false,
            }, () => runOffline(controller => controller.sync()));
        } catch (error) {
            vscode.window.showErrorMessage(`GitLeaf: Sync failed - ${errorMessage(error)}`);
        }
        return;
    }
    // Online mode already pushes edits as they are made; pull any pending remote updates.
    await cmdPullFromOverleaf();
}

/** Switch behavior explicitly; mode changes never happen as a fallback. */
async function cmdChangeMode(context: vscode.ExtensionContext): Promise<void> {
    const settingsManager = SettingsManager.getCurrentInstance();
    const settings = settingsManager?.getSettings();
    if (!settingsManager || !settings) {
        vscode.window.showWarningMessage('GitLeaf: No linked project.');
        return;
    }

    const selected = await vscode.window.showQuickPick([
        { label: '$(radio-tower) Online', description: 'Automatic live sync and collaborator cursors', mode: 'online' as const },
        { label: '$(source-control) Offline', description: 'Manual commit, pull and push', mode: 'offline' as const },
    ], { title: `Change mode (currently ${settings.mode})` });
    if (!selected || selected.mode === settings.mode) return;

    const confirm = await vscode.window.showWarningMessage(
        selected.mode === 'online'
            ? 'Online mode will begin synchronizing editor changes immediately.'
            : 'Offline mode will stop automatic synchronization and use explicit GitLeaf commits.',
        { modal: true },
        `Switch to ${selected.mode}`,
    );
    if (confirm !== `Switch to ${selected.mode}`) return;

    await offlineOperation;
    if (changingMode) return;
    changingMode = true;
    try {
        if (selected.mode === 'online') {
            if (!offlineController) throw new Error('Offline repository is not ready.');
            await offlineController.prepareOnline(true);
        } else {
            if (!syncEngine) throw new Error('Online connection is not ready.');
            const repository = new GitRepository(settingsManager.getWorkspaceFolder().fsPath);
            await repository.initialize();
            await repository.assertSettled();
            try {
                const snapshot = await syncEngine.finishOnline();
                syncEngine = undefined;
                await repository.acceptOnlineSnapshot(snapshot);
            } catch (error) {
                if (syncEngine?.hasPendingFileOperations) throw error;
                const keep = await vscode.window.showWarningMessage(
                    `Cannot confirm a clean online snapshot: ${errorMessage(error)}\nEnter Offline with local changes preserved against the last trusted baseline?`,
                    { modal: true }, 'Keep changes and enter Offline');
                if (!keep) throw error;
                await syncEngine?.close();
                syncEngine = undefined;
            }
        }
        await settingsManager.update({ mode: selected.mode, autoSync: selected.mode === 'online' });
        try { await initializeSync(context, settingsManager, false, selected.mode === 'online'); }
        catch (error) {
            // A failed online start cannot leave an Online label or a socket
            // that later publishes changes without another explicit switch.
            await syncEngine?.close(); syncEngine = undefined;
            await settingsManager.update({ mode: 'offline', autoSync: false });
            await initializeSync(context, settingsManager);
            throw error;
        }
    } finally { changingMode = false; }
}

/**
 * Pull from Overleaf
 */
async function cmdPullFromOverleaf() {
    const mode = SettingsManager.getCurrentInstance()?.getSettings()?.mode;
    if (mode === 'offline') {
        if (!offlineController) {
            vscode.window.showWarningMessage('GitLeaf: Offline repository is not ready.');
            return;
        }
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'GitLeaf: Fetching and merging Overleaf changes...',
                cancellable: false,
            }, () => runOffline(controller => controller.pull()));
        } catch (error) {
            vscode.window.showErrorMessage(`GitLeaf: Pull failed - ${errorMessage(error)}`);
        }
        return;
    }

    if (!syncEngine) {
        vscode.window.showWarningMessage('GitLeaf: Not connected. Please link a folder first.');
        return;
    }

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'GitLeaf: Pulling from Overleaf...',
            cancellable: false,
        }, async () => {
            await syncEngine!.pullAll();
        });
        vscode.window.showInformationMessage('GitLeaf: Pull complete');
    } catch (error) {
        vscode.window.showErrorMessage(`GitLeaf: Pull failed - ${error}`);
    }
}

/**
 * Push to Overleaf
 */
async function cmdPushToOverleaf() {
    const mode = SettingsManager.getCurrentInstance()?.getSettings()?.mode;
    if (mode === 'offline') {
        if (!offlineController) {
            vscode.window.showWarningMessage('GitLeaf: Offline repository is not ready.');
            return;
        }
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'GitLeaf: Checking and pushing committed changes...',
                cancellable: false,
            }, () => runOffline(controller => controller.push()));
        } catch (error) {
            vscode.window.showErrorMessage(`GitLeaf: Push failed - ${errorMessage(error)}`);
        }
        return;
    }

    if (!syncEngine) {
        vscode.window.showWarningMessage('GitLeaf: Not connected. Please link a folder first.');
        return;
    }

    vscode.window.showInformationMessage('GitLeaf: Push is automatic via real-time sync');
}

/**
 * Edit ignore patterns
 */
async function cmdEditIgnorePatterns() {
    const workspaceFolder = SettingsManager.getCurrentInstance()?.getWorkspaceFolder();
    if (!workspaceFolder) {
        vscode.window.showErrorMessage('GitLeaf: No workspace folder open');
        return;
    }

    const ignoreFile = vscode.Uri.joinPath(workspaceFolder, IGNORE_FILE);

    // Create default if doesn't exist
    const ignoreParser = new IgnoreParser(workspaceFolder.fsPath);
    if (!(await ignoreParser.exists())) {
        await ignoreParser.createDefault();
    }

    await vscode.window.showTextDocument(ignoreFile);
}

/**
 * Remove stale remote files only after they match the current .gitleafignore
 * rules and the user explicitly confirms the operation.
 */
async function cmdCleanIgnoredRemoteFiles() {
    if (!syncEngine) {
        vscode.window.showWarningMessage('GitLeaf: Not connected. Please link a folder first.');
        return;
    }

    try {
        const paths = await syncEngine.getIgnoredRemoteFiles();
        if (paths.length === 0) {
            vscode.window.showInformationMessage('GitLeaf: No ignored files exist on Overleaf.');
            return;
        }

        const visiblePaths = paths.slice(0, 12);
        const remaining = paths.length - visiblePaths.length;
        const preview = visiblePaths.join('\n') +
            (remaining > 0 ? `\n... and ${remaining} more` : '');
        const choice = await vscode.window.showWarningMessage(
            `Delete ${paths.length} ignored file(s) from Overleaf?\n\n${preview}`,
            { modal: true },
            'Delete Ignored Files'
        );
        if (choice !== 'Delete Ignored Files') {
            return;
        }

        const result = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'GitLeaf: Cleaning ignored files from Overleaf...',
            cancellable: false,
        }, () => syncEngine!.deleteIgnoredRemoteFiles(paths));

        if (result.failed.length > 0) {
            const failedPreview = result.failed
                .slice(0, 5)
                .map(item => item.path)
                .join(', ');
            vscode.window.showWarningMessage(
                `GitLeaf: Deleted ${result.deleted} ignored file(s); ` +
                `${result.failed.length} failed: ${failedPreview}`
            );
        } else {
            vscode.window.showInformationMessage(
                `GitLeaf: Deleted ${result.deleted} ignored file(s) from Overleaf.`
            );
        }
    } catch (error) {
        vscode.window.showErrorMessage(`GitLeaf: Cleanup failed - ${errorMessage(error)}`);
    }
}

type StatusAction =
    | 'project'
    | 'server'
    | 'status'
    | 'collaborators'
    | 'commit'
    | 'pull'
    | 'push'
    | 'history'
    | 'mode';

interface StatusQuickPickItem extends vscode.QuickPickItem {
    action?: StatusAction;
}

/**
 * Show current values as actionable rows. Selecting Project, Server, Status,
 * or Mode now performs the related operation instead of duplicating it below.
 */
async function cmdShowSyncStatus() {
    const settingsManager = SettingsManager.getCurrentInstance();
    const settings = settingsManager?.getSettings();

    const items: StatusQuickPickItem[] = [];
    const offline = settings?.mode === 'offline';
    const currentStatus = offline ? 'idle' : syncEngine?.status || 'disconnected';

    if (settings) {
        items.push({
            label: `$(project) Project · ${settings.projectName}`,
            description: 'Open or unlink project',
            detail: settings.projectId,
            action: 'project',
        });
        items.push({
            label: `$(globe) Server · ${settings.serverUrl}`,
            description: authState === 'expired'
                ? 'Session expired · select to refresh'
                : 'Select to verify session',
            action: 'server',
        });
        if (!offline) {
            items.push({
                label: `$(sync) Status · ${currentStatus}`,
                description: currentStatus === 'disconnected' || currentStatus === 'error'
                    ? 'Select to reconnect'
                    : settings.lastSynced
                        ? `Select to sync · last synced ${new Date(settings.lastSynced).toLocaleString()}`
                        : 'Select to sync now',
                action: 'status',
            });
        }
        items.push({
            label: `$(settings) Mode · ${offline ? 'Offline' : 'Online'}`,
            description: 'Select to switch mode',
            action: 'mode',
        });
        if (cursorTracker && cursorTracker.getUserCount() > 0) {
            items.push({
                label: `$(organization) Collaborators · ${cursorTracker.getUserCount()} online`,
                description: 'Select to jump to a collaborator',
                action: 'collaborators',
            });
        }
    } else {
        items.push({
            label: '$(info) Not linked',
            description: 'Use "GitLeaf: Link Folder" to connect to Overleaf',
        });
    }

    items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });

    if (offline) {
        items.push(
            {
                label: '$(git-commit) Commit changes',
                description: 'Create a local offline commit',
                action: 'commit',
            },
            {
                label: '$(cloud-download) Pull from Overleaf',
                description: settings?.lastSynced
                    ? `Fetch and merge · last sync ${new Date(settings.lastSynced).toLocaleString()}`
                    : 'Fetch and three-way merge',
                action: 'pull',
            },
            {
                label: '$(cloud-upload) Push to Overleaf',
                description: 'Push committed changes after safety checks',
                action: 'push',
            },
            {
                label: '$(history) Show history',
                description: 'Inspect a commit and its word-level diff',
                action: 'history',
            },
        );
    }

    const selected = await vscode.window.showQuickPick(items, {
        title: 'GitLeaf Status',
    });

    switch (selected?.action) {
        case 'project':
            await showProjectActions();
            break;
        case 'server':
            await (authState === 'expired' ? cmdRefreshCookie() : cmdVerifyCredentials());
            break;
        case 'status':
            await (currentStatus === 'disconnected' || currentStatus === 'error'
                ? cmdReconnect()
                : cmdPullFromOverleaf());
            break;
        case 'collaborators':
            await cursorTracker?.jumpToUser();
            break;
        case 'commit':
            await runOffline(controller => controller.commit());
            break;
        case 'pull':
            await cmdPullFromOverleaf();
            break;
        case 'push':
            await cmdPushToOverleaf();
            break;
        case 'history':
            await offlineController?.showHistory();
            break;
        case 'mode':
            await vscode.commands.executeCommand(COMMANDS.CHANGE_MODE);
            break;
    }
}

async function showProjectActions(): Promise<void> {
    const settings = SettingsManager.getCurrentInstance()?.getSettings();
    if (!settings) return;

    const selected = await vscode.window.showQuickPick([
        {
            label: '$(link-external) Open in Overleaf',
            description: settings.projectName,
            action: 'open' as const,
        },
        {
            label: '$(close) Unlink folder',
            description: 'Keep local files and offline history',
            action: 'unlink' as const,
        },
    ], { title: `Project · ${settings.projectName}` });

    if (selected?.action === 'open') {
        const baseUrl = settings.serverUrl.endsWith('/')
            ? settings.serverUrl
            : `${settings.serverUrl}/`;
        const projectUrl = new URL(`project/${encodeURIComponent(settings.projectId)}`, baseUrl);
        await vscode.env.openExternal(vscode.Uri.parse(projectUrl.toString()));
    } else if (selected?.action === 'unlink') {
        await cmdUnlinkFolder();
    }
}

/**
 * Reconnect to Overleaf (after disconnect or error)
 */
async function cmdReconnect() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showWarningMessage('GitLeaf: No linked project');
        return;
    }

    // Disconnect existing sync engine
    if (syncEngine) {
        await syncEngine.close();
        syncEngine = undefined;
    }

    if (cursorTracker) {
        cursorTracker.dispose();
        cursorTracker = undefined;
    }

    stopStatusUpdates();

    const projectSettings = settingsManager.getSettings();
    if (!projectSettings) return;
    if (projectSettings.mode === 'offline') {
        await offlineController?.refresh();
        updateStatusBar('idle', 'Offline mode · connected only during pull or push');
        return;
    }

    const credential = await credentialManager.getCredential(projectSettings.serverUrl);
    if (!credential) {
        updateStatusBar('disconnected', 'Not logged in');
        vscode.window.showWarningMessage('GitLeaf: Please login to Overleaf first');
        return;
    }

    const api = new BaseAPI(projectSettings.serverUrl);
    api.setIdentity(credential.identity);

    syncEngine = new SyncEngine(api, settingsManager);

    syncEngine.onStatusChange(async event => {
        updateStatusBar(event.status, event.message);
        // Handle auth errors
        if (event.authError) {
            await setAuthState('expired');
            showSessionExpiredNotification();
        }
    });

    try {
        updateStatusBar('syncing', 'Reconnecting...');
        await syncEngine.connect();

        const socket = syncEngine.getSocket();
        if (socket) {
            cursorTracker = new CursorTracker(socket, settingsManager);
            await cursorTracker.initialize();
        }

        startStatusUpdates();
        log('Reconnected to Overleaf');

        await syncEngine.pullAll();
        vscode.window.showInformationMessage(`GitLeaf: Reconnected to "${projectSettings.projectName}"`);
    } catch (error) {
        log(`Failed to reconnect: ${error}`);
        vscode.window.showErrorMessage(`GitLeaf: Failed to reconnect - ${error}`);
    }
}

/**
 * Set main document
 */
async function cmdSetMainDocument() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showErrorMessage('GitLeaf: No linked project');
        return;
    }

    const mainTex = await vscode.window.showInputBox({
        prompt: 'Enter main TeX file name',
        value: settingsManager.getSettings()?.mainTex || 'main.tex',
    });

    if (!mainTex) return;

    const mainPdf = mainTex.replace(/\.tex$/, '.pdf');

    await settingsManager.update({ mainTex, mainPdf });
    vscode.window.showInformationMessage(`GitLeaf: Main document set to ${mainTex}`);
}

/**
 * Configure settings
 */
async function cmdConfigure() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showInformationMessage('GitLeaf: No linked project');
        return;
    }

    const workspaceFolder = settingsManager.getWorkspaceFolder();
    const settingsFile = vscode.Uri.joinPath(workspaceFolder, CONFIG_DIR, 'settings.json');
    await vscode.window.showTextDocument(settingsFile);
}

/**
 * Jump to collaborator cursor
 */
async function cmdJumpToCollaborator(clientId?: string) {
    if (!cursorTracker) {
        vscode.window.showWarningMessage('GitLeaf: Not connected');
        return;
    }

    await cursorTracker.jumpToUser(clientId);
}

/**
 * Verify credentials are still valid
 */
async function cmdVerifyCredentials() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showInformationMessage('GitLeaf: No linked project');
        return;
    }

    const projectSettings = settingsManager.getSettings();
    if (!projectSettings) return;

    const credential = await credentialManager.getCredential(projectSettings.serverUrl);
    if (!credential) {
        await setAuthState('none');
        vscode.window.showWarningMessage('GitLeaf: Not logged in');
        return;
    }

    const api = new BaseAPI(projectSettings.serverUrl);
    api.setIdentity(credential.identity);

    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'GitLeaf: Verifying credentials...',
    }, async () => {
        return api.verifyCredentials();
    });

    if (result.type === 'success') {
        await setAuthState('valid');
        vscode.window.showInformationMessage('GitLeaf: Credentials are valid');
    } else {
        await setAuthState('expired');
        showSessionExpiredNotification();
    }
}

/**
 * Refresh cookie (re-login without clearing stored info)
 */
async function cmdRefreshCookie() {
    const settingsManager = SettingsManager.getCurrentInstance();
    if (!settingsManager || !(await settingsManager.isLinked())) {
        vscode.window.showWarningMessage('GitLeaf: No linked project');
        return;
    }

    const projectSettings = settingsManager.getSettings();
    if (!projectSettings) return;

    const serverUrl = projectSettings.serverUrl;

    // Get existing credential to show user info
    const existingCredential = await credentialManager.getCredential(serverUrl);
    const userInfo = existingCredential
        ? `Refreshing session for ${existingCredential.userEmail}`
        : 'Enter your Overleaf cookie';

    // Show help option
    const helpChoice = await vscode.window.showInformationMessage(
        userInfo,
        'How to get cookies?',
        'Continue'
    );

    if (!helpChoice) return;

    if (helpChoice === 'How to get cookies?') {
        await vscode.env.openExternal(vscode.Uri.parse(
            'https://github.com/overleaf-workshop/Overleaf-Workshop/blob/master/docs/wiki.md#login-with-cookies'
        ));
    }

    const cookies = await vscode.window.showInputBox({
        prompt: 'Paste your fresh Overleaf cookie',
        placeHolder: 'overleaf_session2=...',
        password: true,
    });

    if (!cookies) return;

    const result = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification, title: 'GitLeaf: Validating cookie...',
    }, () => login(credentialManager, serverUrl, { cookies }));
    await setAuthState('valid');
    void vscode.window.showInformationMessage(`GitLeaf: Session refreshed for ${result.userEmail}`);
    await cmdReconnect();
}

/**
 * Extension deactivation
 */
export async function deactivate() {
    stopStatusUpdates();
    for (const state of editorStates.values()) state.dispose();
    editorStates.clear();
    ignoredFileDecorations?.dispose();

    if (syncEngine) {
        await syncEngine.close();
    }
    if (cursorTracker) {
        cursorTracker.dispose();
    }
    offlineController?.dispose();
}
