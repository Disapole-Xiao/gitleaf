import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { resolveIgnoreRules, ignoreMatcher } from '../sync/ignoreRules';
import { Publications } from './publications';
import { OperationBlockedError } from './operationBlocked';

export const OVERLEAF_REF = 'refs/remotes/overleaf/main';
export const INDEX_REF = '__index__';

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'conflict' | 'untracked';

export interface WorkingChange {
    path: string;
    originalPath?: string;
    x: string;
    y: string;
    kind: ChangeKind;
}

export interface CommitInfo {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    subject: string;
    refs: string;
    parents: string[];
}

export interface CommitFile {
    path: string;
    originalPath?: string;
    status: string;
}

export interface StashEntry { hash: string; ref: string; message: string; date: string }

interface RunOptions {
    workTree?: string;
    env?: NodeJS.ProcessEnv;
    allowFailure?: boolean;
    input?: Buffer | string;
}

interface RunResult {
    stdout: Buffer;
    stderr: Buffer;
    exitCode: number;
}

function validateRelativePath(value: string): string {
    const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized || normalized.split('/').includes('..') || path.isAbsolute(value)) {
        throw new Error(`Unsafe project path: ${value}`);
    }
    if (normalized === '.gitleaf' || normalized.startsWith('.gitleaf/')) {
        throw new Error('The .gitleaf directory is reserved for local metadata.');
    }
    return normalized;
}

function classifyStatus(x: string, y: string): ChangeKind {
    const pair = `${x}${y}`;
    if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(pair)) return 'conflict';
    if (pair === '??') return 'untracked';
    if (pair.includes('R')) return 'renamed';
    if (pair.includes('A')) return 'added';
    if (pair.includes('D')) return 'deleted';
    return 'modified';
}

/** Parse Git's NUL-delimited porcelain output without losing spaces in paths. */
export function parsePorcelain(buffer: Buffer): WorkingChange[] {
    const records = buffer.toString('utf8').split('\0');
    const changes: WorkingChange[] = [];
    for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (!record || record.length < 4) continue;
        const x = record[0];
        const y = record[1];
        const filePath = record.slice(3).replace(/\\/g, '/');
        const change: WorkingChange = { path: filePath, x, y, kind: classifyStatus(x, y) };
        if (x === 'R' || x === 'C') {
            change.originalPath = records[++index]?.replace(/\\/g, '/');
        }
        changes.push(change);
    }
    return changes;
}

/**
 * A normal Git repository with its object database hidden under .gitleaf.
 * Using Git itself gives GitLeaf the same three-way merge and conflict model
 * users already trust, without taking over a folder's existing .git directory.
 */
export class GitRepository {
    readonly metadataDir: string;
    readonly gitDir: string;
    readonly publications: Publications;
    private readonly remoteStageDir: string;
    private readonly remoteIndex: string;

    constructor(readonly root: string) {
        this.metadataDir = path.join(root, '.gitleaf');
        this.gitDir = path.join(this.metadataDir, 'repository');
        this.publications = new Publications(this.metadataDir);
        this.remoteStageDir = path.join(this.metadataDir, 'remote-stage');
        this.remoteIndex = path.join(this.metadataDir, 'remote.index');
    }

    private run(args: string[], options: RunOptions = {}): Promise<RunResult> {
        const gitArgs = [`--git-dir=${this.gitDir}`, `--work-tree=${options.workTree || this.root}`, ...args];
        return new Promise((resolve, reject) => {
            const child = execFile('git', gitArgs, {
                cwd: options.workTree || this.root,
                env: { ...process.env, ...options.env },
                encoding: 'buffer',
                maxBuffer: 64 * 1024 * 1024,
                windowsHide: true,
            }, (error, stdout, stderr) => {
                const exitCode = error && typeof error === 'object' && 'code' in error && typeof error.code === 'number'
                    ? error.code
                    : error ? 1 : 0;
                const result = { stdout: stdout as Buffer, stderr: stderr as Buffer, exitCode };
                if (error && !options.allowFailure) {
                    reject(new Error((stderr as Buffer).toString('utf8').trim() || error.message));
                } else {
                    resolve(result);
                }
            });
            if (options.input !== undefined) {
                child.stdin?.end(options.input);
            }
        });
    }

    async exists(): Promise<boolean> {
        try {
            await fs.stat(path.join(this.gitDir, 'HEAD'));
            return true;
        } catch {
            return false;
        }
    }

    async initialize(): Promise<void> {
        if (!(await this.exists())) {
            await fs.mkdir(this.metadataDir, { recursive: true });
            await new Promise<void>((resolve, reject) => {
                execFile('git', ['init', '--bare', '--initial-branch=main', this.gitDir], { windowsHide: true }, error => {
                    if (error) reject(error);
                    else resolve();
                });
            });
            await this.run(['config', 'core.bare', 'false']);
            await this.run(['config', 'user.name', 'GitLeaf User']);
            await this.run(['config', 'user.email', 'gitleaf@localhost']);
        }

        // Match Overleaf's LF text while accepting VS Code's CRLF editor saves.
        // Unlike autocrlf=true, checkout never rewrites snapshots to CRLF.
        await this.run(['config', 'core.autocrlf', 'input']);
        await this.refreshIgnoreRules();
    }

    async refreshIgnoreRules(): Promise<string[]> {
        const content = await fs.readFile(path.join(this.root, '.gitleafignore'), 'utf8').catch(() => undefined);
        const settings = JSON.parse(await fs.readFile(path.join(this.metadataDir, 'settings.json'), 'utf8').catch(() => '{}'));
        const rules = [...resolveIgnoreRules(content, settings), '/.git/', '/.gitleaf/', '/.gitleafignore'];
        const destination = path.join(this.gitDir, 'info', 'exclude');
        const text = rules.join('\n') + '\n';
        if (await fs.readFile(destination, 'utf8').catch(() => '') !== text) await fs.writeFile(destination, text);
        return rules;
    }

    private async revParse(ref: string): Promise<string | undefined> {
        const result = await this.run(['rev-parse', '--verify', ref], { allowFailure: true });
        return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : undefined;
    }

    async head(): Promise<string | undefined> {
        return this.revParse('HEAD');
    }

    async remoteHead(): Promise<string | undefined> {
        return this.revParse(OVERLEAF_REF);
    }

    private async materializeSnapshot(snapshot: ReadonlyMap<string, Uint8Array>, target: string, missingOnly: boolean): Promise<void> {
        for (const [rawPath, content] of snapshot) {
            const relative = validateRelativePath(rawPath);
            const destination = path.join(target, ...relative.split('/'));
            const resolved = path.resolve(destination);
            if (resolved !== path.resolve(target) && !resolved.startsWith(path.resolve(target) + path.sep)) {
                throw new Error(`Snapshot path escapes project folder: ${rawPath}`);
            }
            if (missingOnly) {
                try {
                    await fs.stat(destination);
                    continue;
                } catch {
                    // Missing files are populated below; existing work is preserved.
                }
            }
            await fs.mkdir(path.dirname(destination), { recursive: true });
            await fs.writeFile(destination, content);
        }
    }

    /** Import a remote snapshot as a commit without modifying the user's files. */
    async fetchRemoteSnapshot(snapshot: ReadonlyMap<string, Uint8Array>): Promise<string> {
        await this.initialize();
        await fs.rm(this.remoteStageDir, { recursive: true, force: true });
        await fs.rm(this.remoteIndex, { force: true });
        await fs.mkdir(this.remoteStageDir, { recursive: true });
        await this.materializeSnapshot(snapshot, this.remoteStageDir, false);

        const env = { GIT_INDEX_FILE: this.remoteIndex };
        await this.run(['read-tree', '--empty'], { workTree: this.remoteStageDir, env });
        await this.run(['add', '-A', '--', '.'], { workTree: this.remoteStageDir, env });
        const tree = (await this.run(['write-tree'], { workTree: this.remoteStageDir, env })).stdout.toString('utf8').trim();
        const previous = await this.remoteHead();
        if (previous) {
            const previousTree = (await this.run(['rev-parse', `${previous}^{tree}`])).stdout.toString('utf8').trim();
            if (tree === previousTree) return previous;
        }

        const commitArgs = ['commit-tree', tree, '-m', 'Fetch from Overleaf'];
        if (previous) commitArgs.push('-p', previous);
        const commit = (await this.run(commitArgs, {
            env: {
                GIT_AUTHOR_NAME: 'Overleaf',
                GIT_AUTHOR_EMAIL: 'overleaf@gitleaf.local',
                GIT_COMMITTER_NAME: 'GitLeaf',
                GIT_COMMITTER_EMAIL: 'gitleaf@localhost',
            },
        })).stdout.toString('utf8').trim();
        await this.run(['update-ref', OVERLEAF_REF, commit]);
        return commit;
    }

    /** Establish the first remote baseline while preserving pre-existing files. */
    async initializeFromRemote(snapshot: ReadonlyMap<string, Uint8Array>): Promise<void> {
        const remoteCommit = await this.fetchRemoteSnapshot(snapshot);
        if (await this.head()) return;
        await this.run(['symbolic-ref', 'HEAD', 'refs/heads/main']);
        await this.run(['update-ref', 'refs/heads/main', remoteCommit]);
        await this.materializeSnapshot(snapshot, this.root, true);
        await this.run(['reset', '--mixed', 'HEAD']);
    }

    async status(): Promise<WorkingChange[]> {
        await this.refreshIgnoreRules();
        const result = await this.run(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
        return parsePorcelain(result.stdout);
    }

    async isClean(): Promise<boolean> {
        return (await this.status()).length === 0;
    }

    async setAuthor(name: string, email: string): Promise<void> {
        if (!name.trim() || !email.trim() || /[\r\n]/.test(name + email))
            throw new Error('Overleaf account name and email are required for commits.');
        await this.run(['config', 'user.name', name.trim()]);
        await this.run(['config', 'user.email', email.trim()]);
    }

    async commit(message: string): Promise<string | undefined> {
        if (await this.isRebasing()) {
            await this.run(['rebase', await this.isClean() ? '--skip' : '--continue'], { env: { GIT_EDITOR: 'true' } });
            return this.head();
        }
        const staged = await this.run(['diff', '--cached', '--quiet'], { allowFailure: true });
        if (staged.exitCode === 0 && !(await this.revParse('MERGE_HEAD'))) return undefined;
        await this.run(['commit', '-m', message]);
        return this.head();
    }

    async stage(paths?: string[]): Promise<void> {
        const ignored = ignoreMatcher(await this.refreshIgnoreRules());
        const selected = paths?.map(validateRelativePath);
        // '.' selects the worktree, not a filename accepted by ignore(). Git
        // still applies our exclude rules while adding its descendants.
        if (selected?.some(value => value !== '.' && ignored(value))) throw new Error('Ignored files cannot be staged. Edit .gitleafignore first.');
        await this.run(['add', '-A', '--', ...(selected || ['.'])]);
    }

    async unstage(paths?: string[]): Promise<void> {
        const selected = paths?.map(validateRelativePath);
        if (await this.head()) await this.run(['reset', '-q', 'HEAD', '--', ...(selected || ['.'])]);
        else if (selected) await this.run(['rm', '--cached', '--ignore-unmatch', '--', ...selected]);
        else await this.run(['read-tree', '--empty']);
    }

    /** Discard only the worktree side of Changes; the index is the source of
     * truth, so a partially staged file keeps its staged edits. Never git clean
     * the folder: untracked files go through the editor's recoverable trash API.
     */
    async discard(paths: string[], trash: (relative: string) => PromiseLike<void>): Promise<void> {
        await this.assertSettled();
        const selected = new Set(paths.map(validateRelativePath));
        if (!selected.size) return;
        const changes = (await this.status()).filter(change => selected.has(change.path));
        if (changes.some(change => change.kind === 'conflict')) throw new Error('Resolve conflicts before discarding changes.');
        const tracked = changes.filter(change => change.kind !== 'untracked' && change.y !== ' ').map(change => change.path);
        if (tracked.length) await this.run(['--literal-pathspecs', 'restore', '--worktree', '--', ...tracked]);
        for (const change of changes.filter(change => change.kind === 'untracked')) await trash(change.path);
    }

    async stashes(): Promise<StashEntry[]> {
        const result = await this.run(['stash', 'list', '--format=%H%x00%gd%x00%gs%x00%cI']);
        return result.stdout.toString('utf8').trim().split('\n').filter(Boolean).map(line => {
            const [hash, ref, message, date] = line.split('\0');
            return { hash, ref, message, date };
        });
    }

    async createStash(message: string): Promise<void> {
        await this.assertSettled();
        if (!(await this.head())) throw new Error('Pull the initial project before creating a stash.');
        await this.refreshIgnoreRules();
        // Git owns stash objects/index snapshots; ignored builds and metadata
        // are deliberately excluded (--include-untracked, never --all).
        await this.run(['stash', 'push', '--include-untracked', '-m', message || 'GitLeaf stash']);
    }

    async applyStash(hash: string, pop = false): Promise<void> {
        await this.assertSettled();
        if (!(await this.isClean())) throw new Error('Commit, stash or discard current changes before applying a stash.');
        if (!(await this.stashes()).some(entry => entry.hash === hash)) throw new Error('This stash no longer exists.');
        // Recreate the staged/unstaged split. A conflict/failure leaves the stash
        // intact; Pop removes it only after Git has applied it successfully.
        await this.run(['stash', 'apply', '--index', hash]);
        if (pop) await this.dropStash(hash);
    }

    async dropStash(hash: string): Promise<void> {
        const entry = (await this.stashes()).find(item => item.hash === hash);
        if (!entry) throw new Error('This stash no longer exists.');
        // Resolve its current reflog index, not the index from an old menu.
        await this.run(['stash', 'drop', entry.ref]);
    }

    /** Counts describe the last explicit Fetch/Pull/Push, never an implicit poll. */
    async divergence(): Promise<{ ahead: number; behind: number; known: boolean }> {
        if (!(await this.head()) || !(await this.remoteHead())) return { ahead: 0, behind: 0, known: false };
        const result = await this.run(['rev-list', '--left-right', '--count', `HEAD...${OVERLEAF_REF}`]);
        const [ahead, behind] = result.stdout.toString('utf8').trim().split(/\s+/).map(Number);
        return { ahead, behind, known: true };
    }

    async committedSnapshot(ref = 'HEAD'): Promise<Map<string, Uint8Array>> {
        const ignored = ignoreMatcher(await this.refreshIgnoreRules());
        return this.readSnapshot(ref, ignored);
    }

    /** Read an exact tree without changing the worktree, index, refs or ignore rules. */
    async readSnapshot(ref: string, ignored: (file: string) => boolean = () => false): Promise<Map<string, Uint8Array>> {
        const files = await this.run(['ls-tree', '-r', '--name-only', '-z', ref]);
        const snapshot = new Map<string, Uint8Array>();
        for (const file of files.stdout.toString('utf8').split('\0').filter(Boolean)) {
            if (ignored(file)) continue;
            const result = await this.run(['show', `${ref}:${validateRelativePath(file)}`]);
            snapshot.set(file, result.stdout);
        }
        return snapshot;
    }

    async rebaseRemote(): Promise<WorkingChange[]> {
        const remote = await this.remoteHead();
        if (!remote) throw new Error('No Overleaf tracking commit exists.');
        // Only unpublished commits are replayed; public server history is never
        // rewritten. Git supplies the three-way merge and conflict machinery.
        const result = await this.run(['rebase', '--autostash', remote], { allowFailure: true, env: { GIT_EDITOR: 'true' } });
        const changes = await this.status();
        if (result.exitCode !== 0 && !changes.some(change => change.kind === 'conflict')) {
            throw new Error(result.stderr.toString('utf8').trim() || 'Git pull rebase failed.');
        }
        return changes;
    }

    async abortPull(): Promise<void> {
        await this.run(['rebase', '--abort']);
    }

    async isRebasing(): Promise<boolean> {
        return fs.stat(path.join(this.gitDir, 'rebase-merge')).then(() => true, () => false);
    }

    async assertSettled(): Promise<void> {
        if (await this.isRebasing() || await this.revParse('MERGE_HEAD')) throw new OperationBlockedError('Finish or abort the current pull first.');
        if ((await this.publications.read()).pending) throw new OperationBlockedError('A push has an unconfirmed result. Retry Push to reconcile it first.');
    }

    async unpublished(limit = 100): Promise<CommitInfo[]> {
        if (!(await this.head())) return [];
        const remote = await this.remoteHead();
        return this.log(limit, remote ? `${remote}..HEAD` : 'HEAD');
    }

    async acceptOnlineSnapshot(snapshot: ReadonlyMap<string, Uint8Array>): Promise<void> {
        await this.assertSettled();
        const previous = await this.head();
        const remote = await this.fetchRemoteSnapshot(snapshot);
        const tree = (await this.run(['rev-parse', `${remote}^{tree}`])).stdout.toString('utf8').trim();
        const oldTree = previous ? (await this.run(['rev-parse', `${previous}^{tree}`])).stdout.toString('utf8').trim() : undefined;
        const commit = oldTree === tree ? previous! : (await this.run(['commit-tree', tree, '-m', 'Online session snapshot', ...(previous ? ['-p', previous] : [])])).stdout.toString('utf8').trim();
        await this.run(['update-ref', 'refs/heads/main', commit]);
        // read-tree updates only the index. Never check out/reset the worktree:
        // edits after the online cutoff must survive as new Changes.
        await this.run(['read-tree', commit]);
        await this.run(['update-ref', OVERLEAF_REF, commit]);
        const receipts = await this.publications.read();
        delete receipts.integrated;
        await this.publications.write(receipts);
    }

    /** Reset removes the selected unpublished commit AND every newer one.
     * A fresh membership check prevents stale graph nodes resetting public history.
     */
    async resetUnpublished(hash: string, mode: 'hard' | 'soft'): Promise<void> {
        await this.assertSettled();
        const commits = await this.unpublished(100000);
        const selected = commits.find(commit => commit.hash === hash);
        if (!selected || selected.parents.length !== 1) throw new OperationBlockedError('Only unpublished linear local commits can be reverted.');
        if ((await this.publications.read()).published.some(item => item.commit.hash === hash)) throw new OperationBlockedError('Published versions require Restore, not Revert.');
        // Hard must not silently discard edits unrelated to the selected commits.
        if (mode === 'hard' && !(await this.isClean())) throw new OperationBlockedError('Commit or discard working changes before Hard Revert.');
        await this.run(['reset', `--${mode}`, selected.parents[0]]);
    }

    async isRemoteAncestorOfHead(): Promise<boolean> {
        const remote = await this.remoteHead();
        if (!remote || !(await this.head())) return false;
        const result = await this.run(['merge-base', '--is-ancestor', remote, 'HEAD'], { allowFailure: true });
        return result.exitCode === 0;
    }

    async isAncestorOfHead(hash: string): Promise<boolean> {
        if (!(await this.head())) return false;
        return (await this.run(['merge-base', '--is-ancestor', hash, 'HEAD'], { allowFailure: true })).exitCode === 0;
    }

    async mergeBaseWithRemote(): Promise<string | undefined> {
        const remote = await this.remoteHead();
        if (!remote || !(await this.head())) return undefined;
        const result = await this.run(['merge-base', 'HEAD', remote], { allowFailure: true });
        return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : undefined;
    }

    async markRemoteAsHead(ref = 'HEAD'): Promise<void> {
        const head = await this.revParse(ref);
        if (!head) throw new Error('Cannot update tracking ref before the first commit.');
        await this.run(['update-ref', OVERLEAF_REF, head]);
    }

    async resolve(pathValue: string, strategy: 'local' | 'overleaf' | 'manual'): Promise<void> {
        const relative = validateRelativePath(pathValue);
        if (strategy !== 'manual') {
            // Both rebase and its final autostash application put the local
            // changes on "theirs"; the latter no longer has rebase metadata.
            const pulling = await this.isRebasing() || !!(await this.publications.read()).pendingPull;
            const ours = pulling ? strategy === 'overleaf' : strategy === 'local';
            await this.run(['checkout', ours ? '--ours' : '--theirs', '--', relative]);
        } else {
            const file = await fs.readFile(path.join(this.root, relative), 'utf8');
            if (/^(<{7}|={7}|>{7})/m.test(file)) {
                throw new Error('Conflict markers remain in the file.');
            }
        }
        await this.run(['add', '--', relative]);
    }

    async show(ref: string, pathValue: string): Promise<string> {
        const relative = validateRelativePath(pathValue);
        const result = await this.run(['show', `${ref === INDEX_REF ? '' : ref}:${relative}`], { allowFailure: true });
        return result.exitCode === 0 ? result.stdout.toString('utf8') : '';
    }

    /** CLI uses Git's own patch/word diff; the editor serves the same blobs to
     * its native diff editor. Neither front end computes its own Git diff. */
    async diff(options: { staged?: boolean; commit?: string; paths?: string[]; word?: boolean } = {}): Promise<string> {
        const selected = options.paths?.map(validateRelativePath) || [];
        if (options.commit && !/^[a-f0-9]{40}$/.test(options.commit)) throw new Error('Use a full commit hash.');
        const flags = ['--no-ext-diff', '--no-textconv', '--no-color', ...(options.word ? ['--word-diff=plain'] : [])];
        const args = options.commit ? ['show', '--format=', ...flags, options.commit] : ['diff', ...flags, ...(options.staged ? ['--cached'] : [])];
        return (await this.run(['--literal-pathspecs', ...args, '--', ...selected])).stdout.toString('utf8');
    }

    async log(limit = 100, ref = 'HEAD'): Promise<CommitInfo[]> {
        if (ref === 'HEAD' && !(await this.head())) return [];
        if (ref === OVERLEAF_REF && !(await this.remoteHead())) return [];
        if (ref === '--all' && !(await this.head()) && !(await this.remoteHead())) return [];
        const format = '%H%x00%h%x00%an%x00%aI%x00%s%x00%D%x00%P%x00';
        const result = await this.run(['log', '--date-order', `--max-count=${limit}`, `--format=${format}`, ref]);
        const fields = result.stdout.toString('utf8').split('\0');
        const commits: CommitInfo[] = [];
        for (let index = 0; index + 6 < fields.length; index += 7) {
            if (!fields[index]) continue;
            commits.push({
                hash: fields[index].trimStart(),
                shortHash: fields[index + 1],
                author: fields[index + 2],
                date: fields[index + 3],
                subject: fields[index + 4],
                refs: fields[index + 5],
                parents: fields[index + 6].split(' ').filter(Boolean),
            });
        }
        return commits;
    }

    async filesInCommit(commit: string): Promise<CommitFile[]> {
        const parent = await this.parentOf(commit);
        const result = await this.run(['diff-tree', '--root', '--no-commit-id', '--name-status', '--find-renames', '-r', '-z', ...(parent ? [parent, commit] : [commit])]);
        const fields = result.stdout.toString('utf8').split('\0');
        const files: CommitFile[] = [];
        for (let index = 0; index < fields.length;) {
            const status = fields[index++];
            if (!status) continue;
            if (status.startsWith('R') || status.startsWith('C')) {
                const originalPath = fields[index++];
                const filePath = fields[index++];
                files.push({ status, originalPath, path: filePath });
            } else {
                const filePath = fields[index++];
                if (filePath) files.push({ status, path: filePath });
            }
        }
        return files;
    }

    async parentOf(commit: string): Promise<string | undefined> {
        const result = await this.run(['rev-parse', '--verify', `${commit}^`], { allowFailure: true });
        return result.exitCode === 0 ? result.stdout.toString('utf8').trim() : undefined;
    }
}
