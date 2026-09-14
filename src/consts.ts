/**
 * GitLeaf Constants
 */

export const EXTENSION_ID = 'gitleaf.gitleaf';
export const EXTENSION_NAME = 'GitLeaf';

// Configuration paths
export const CONFIG_DIR = '.gitleaf';
export const SETTINGS_FILE = 'settings.json';
export const IGNORE_FILE = '.gitleafignore';

// Default server
export const DEFAULT_SERVER = 'https://www.overleaf.com';

// Sync settings
export const DEFAULT_SYNC_INTERVAL = 5000;
export const DEBOUNCE_DELAY = 500;

// Special variables for .gitleafignore
export const VAR_MAIN_TEX = '$MAIN_TEX';
export const VAR_MAIN_PDF = '$MAIN_PDF';

// Default ignore patterns
export const DEFAULT_IGNORE_PATTERNS = [
    // Hidden files
    '.*',
    '.*/**',
    // LaTeX build artifacts
    'build/',
    '$MAIN_PDF',
    '*.aux',
    '*.bbl',
    '*.bcf',
    '*.blg',
    '*.fdb_latexmk',
    '*.fls',
    '*.log',
    '*.out',
    '*.run.xml',
    '*.synctex.gz',
    '*.synctex(busy)',
    '*.toc',
    '*.lof',
    '*.lot',
    '*.xdv',
    // Config directory itself
    '.gitleaf/**',
];

// Status bar
export const STATUS_BAR_PRIORITY = 100;

// Commands
export const COMMANDS = {
    LOGIN: 'gitleaf.login',
    LOGOUT: 'gitleaf.logout',
    LINK_FOLDER: 'gitleaf.linkFolder',
    UNLINK_FOLDER: 'gitleaf.unlinkFolder',
    SYNC_NOW: 'gitleaf.syncNow',
    PULL_FROM_OVERLEAF: 'gitleaf.pullFromOverleaf',
    PUSH_TO_OVERLEAF: 'gitleaf.pushToOverleaf',
    EDIT_IGNORE_PATTERNS: 'gitleaf.editIgnorePatterns',
    CLEAN_IGNORED_REMOTE: 'gitleaf.cleanIgnoredRemoteFiles',
    SHOW_SYNC_STATUS: 'gitleaf.showSyncStatus',
    SET_MAIN_DOCUMENT: 'gitleaf.setMainDocument',
    CONFIGURE: 'gitleaf.configure',
    JUMP_TO_COLLABORATOR: 'gitleaf.jumpToCollaborator',
    VERIFY_CREDENTIALS: 'gitleaf.verifyCredentials',
    REFRESH_COOKIE: 'gitleaf.refreshCookie',
    COMMIT: 'gitleaf.commit',
    STAGE: 'gitleaf.stage',
    UNSTAGE: 'gitleaf.unstage',
    STAGE_ALL: 'gitleaf.stageAll',
    UNSTAGE_ALL: 'gitleaf.unstageAll',
    DISCARD: 'gitleaf.discard',
    DISCARD_ALL: 'gitleaf.discardAll',
    STASH: 'gitleaf.stash',
    STASH_APPLY: 'gitleaf.stashApply',
    STASH_POP: 'gitleaf.stashPop',
    STASH_DROP: 'gitleaf.stashDrop',
    FETCH: 'gitleaf.fetch',
    REMOTE_HISTORY: 'gitleaf.remoteHistory',
    REFRESH_CHANGES: 'gitleaf.refreshChanges',
    SHOW_HISTORY: 'gitleaf.showHistory',
    OPEN_CHANGE: 'gitleaf.openChange',
    REFRESH_HISTORY: 'gitleaf.refreshHistory',
    HISTORY_VIEW_AS_LIST: 'gitleaf.historyViewAsList',
    HISTORY_VIEW_AS_TREE: 'gitleaf.historyViewAsTree',
    HISTORY_VIEW_AS_LIST_SELECTED: 'gitleaf.historyViewAsListSelected',
    HISTORY_VIEW_AS_TREE_SELECTED: 'gitleaf.historyViewAsTreeSelected',
    MARK_RESOLVED: 'gitleaf.markResolved',
    ABORT_PULL: 'gitleaf.abortPull',
    CHANGE_MODE: 'gitleaf.changeMode',
} as const;
