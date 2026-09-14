#!/usr/bin/env node
import { parseArgs } from 'node:util';
import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
    Credentials,
    GitLeafProject,
    OperationBlockedError,
    ProjectCommand,
    ProjectStore,
    login,
    projects,
    serverUrl,
} from './core';
import { DEFAULT_SERVER } from './consts';

const HELP = `GitLeaf 1 — shared Overleaf workflow for the terminal and VS Code

Usage: gitleaf [-C folder] [--json] [--yes] <command> [options]

auth login --cookie COOKIE                Login using a browser session cookie
auth login --email EMAIL --password PASS   Self-hosted password login
auth status [--verify] | auth logout       Shared system credential vault
projects [--server URL]                    List accessible Overleaf projects
link --project ID [--server URL]           Link -C folder and download once
status                                    Staged/unstaged files and last fetched state
add <paths...> | add --all                 Stage files (same index as VS Code)
unstage <paths...> | unstage --all         Return staged edits to Changes
commit -m MESSAGE                         Commit staged changes only
diff [--staged] [--word] [--commit HASH]    Git patch or word-level diff
fetch | pull | push                       Explicit Overleaf synchronization
offline                                   Leave a detached Online mode; preserve files/baseline
history [--local] [--before CURSOR]        Unpublished commits and server history
history-files --from N --to N              Changed files in a server version range
history-diff --from N --to N --path FILE   Before/after text for a changed file
label --version N -m TEXT                 Label a server version
label --commit HASH -m TEXT               Label an unpublished local commit
restore --version N                       Restore server and local files together
revert HASH --soft | --hard                Remove unpublished commits, no new node
stash [save [-m TEXT] | list]              Save/list staged, unstaged, new files
stash apply|pop|drop HASH                  Apply/pop/drop a stash by full hash
discard <paths...> | discard --all         Discard unstaged edits; new files to trash
resolve FILE --strategy manual|local|overleaf
abort-pull                                Abort an unfinished pull

--server defaults to the linked project's server, then overleaf.com.
Use --cookie-stdin or --password-stdin instead if you prefer not to pass secrets in arguments.
--version prints the installed version; -h / --help prints this help.
--json never prompts. --yes confirms an operation but never bypasses safety guards.
Exit: 0 success, 1 failure, 2 blocked/confirmation needed, 3 conflicts, 4 canceled.
Online live editing remains owned by the VS Code editor; switch Offline before CLI writes.
`;

export async function runCli(argv: string[]): Promise<void> {
    const options = {
        cwd: { type: 'string', short: 'C' },
        json: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        help: { type: 'boolean', short: 'h' },
        server: { type: 'string' },
        project: { type: 'string' },
        cookie: { type: 'string' },
        password: { type: 'string' },
        'cookie-stdin': { type: 'boolean' },
        'password-stdin': { type: 'boolean' },
        email: { type: 'string' },
        verify: { type: 'boolean' },
        message: { type: 'string', short: 'm' },
        all: { type: 'boolean', short: 'A' },
        staged: { type: 'boolean' },
        word: { type: 'boolean' },
        commit: { type: 'string' },
        path: { type: 'string' },
        local: { type: 'boolean' },
        before: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        soft: { type: 'boolean' },
        hard: { type: 'boolean' },
        strategy: { type: 'string' },
    } as const;
    // At the root --version is a flag; restore/label use --version N as
    // their server-version selector. Let the parser consume option values
    // before deciding, so a cookie or a -C path is never mistaken for a command.
    const probe = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: false,
        options: { ...options, version: { type: 'boolean', short: 'V' } },
    });
    if (!probe.positionals.length && probe.values.version) {
        const result = parseArgs({
            args: argv,
            options: {
                cwd: options.cwd,
                json: options.json,
                version: { type: 'boolean', short: 'V' },
            },
        });
        const version = require('../package.json').version;
        process.stdout.write(
            result.values.json
                ? JSON.stringify({ schemaVersion: 1, ok: true, data: { version } }) + '\n'
                : version + '\n',
        );
        return;
    }
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        strict: true,
        options: { ...options, version: { type: 'string' } },
    });
    const [command, ...args] = positionals;
    const output = (data: any) => {
        if (values.json) process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: true, data }) + '\n');
        else if (typeof data?.patch === 'string') process.stdout.write(data.patch || 'No changes.\n');
        else process.stdout.write(typeof data === 'string' ? data + '\n' : JSON.stringify(data, null, 2) + '\n');
    };
    if (values.help || command === 'help' || !command) {
        output(HELP);
        return;
    }
    const cwd = path.resolve(values.cwd || process.cwd());
    let root = cwd;
    if (command !== 'link') {
        // Paths are interpreted relative to the caller, even when invoked in a
        // subdirectory. There is no dependency on VS Code's active workspace.
        while (!(await new ProjectStore(root).isLinked()) && path.dirname(root) !== root) root = path.dirname(root);
        if (!(await new ProjectStore(root).isLinked())) root = cwd;
    }
    const store = new ProjectStore(root),
        settings = await store.load(),
        credentials = new Credentials();
    const server = serverUrl(values.server || settings?.serverUrl || DEFAULT_SERVER);
    const requireValue = (value: string | undefined, flag: string) => {
        if (!value?.trim()) throw new OperationBlockedError(`Required: ${flag}`);
        return value;
    };
    const number = (value: string | undefined, flag: string) => {
        const text = requireValue(value, flag);
        if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
            throw new OperationBlockedError(`${flag} must be a non-negative integer.`);
        return Number(text);
    };
    const confirm = async (message: string, action: string): Promise<boolean> => {
        if (values.yes) return true;
        if (values.json || !process.stdin.isTTY || !process.stderr.isTTY)
            throw new OperationBlockedError(`Confirmation required. Review the operation, then pass --yes. ${message}`);
        const prompt = createInterface({ input: process.stdin, output: process.stderr });
        try {
            return /^y(es)?$/i.test((await prompt.question(`${message}\n${action}? [y/N] `)).trim());
        } finally {
            prompt.close();
        }
    };
    if (command === 'auth') {
        if (args[0] === 'login') {
            const sources = [
                values.cookie !== undefined,
                values.password !== undefined,
                !!values['cookie-stdin'],
                !!values['password-stdin'],
            ];
            if (sources.filter(Boolean).length !== 1)
                throw new OperationBlockedError(
                    'Choose exactly one of --cookie, --password, --cookie-stdin or --password-stdin.',
                );
            const cookieLogin = values.cookie !== undefined || !!values['cookie-stdin'];
            const email = cookieLogin ? undefined : requireValue(values.email, '--email');
            let secret = values.cookie ?? values.password;
            if (secret === undefined) {
                if (process.stdin.isTTY)
                    throw new OperationBlockedError('Pipe the credential to stdin, or use --cookie / --password.');
                secret = '';
                process.stdin.setEncoding('utf8');
                for await (const chunk of process.stdin) {
                    secret += chunk;
                    if (Buffer.byteLength(secret) > 65536) throw new Error('Credential input is too large.');
                }
                if (!cookieLogin) secret = secret.replace(/\r?\n$/, '');
            }
            if (cookieLogin) secret = secret.trim();
            if (Buffer.byteLength(secret) > 65536) throw new Error('Credential input is too large.');
            if (!secret) throw new OperationBlockedError('Credential input is empty.');
            output(
                await login(
                    credentials,
                    server,
                    cookieLogin
                        ? { cookies: secret }
                        : { email: email!, password: secret },
                ),
            );
        } else if (args[0] === 'logout') {
            if (!(await confirm(`Remove this user's shared GitLeaf login for ${server}?`, 'Log out'))) {
                output({ canceled: true });
                process.exitCode = 4;
                return;
            }
            await credentials.deleteCredential(server);
            output({ loggedOut: true, server });
        } else if (args[0] === 'status') {
            const credential = await credentials.getCredential(server);
            if (credential && values.verify) await projects(credentials, server);
            output({
                server,
                configured: !!credential,
                userEmail: credential?.userEmail,
                verified: !!credential && !!values.verify,
            });
        } else throw new OperationBlockedError('Use auth login, status or logout.');
        return;
    }
    if (command === 'projects') {
        output(await projects(credentials, server));
        return;
    }
    if (values.server && settings && server !== settings.serverUrl && command !== 'link')
        throw new OperationBlockedError(
            'Project operations use the linked server. --server cannot retarget a linked project.',
        );
    const project = new GitLeafProject(store, credentials, {
        confirm,
        log: (message) => {
            if (!values.json) process.stderr.write(message + '\n');
        },
        trash: async (file) => {
            const { default: trash } = await import('trash');
            await trash(file, { glob: false });
        },
    });
    if (command === 'link') {
        const id = requireValue(values.project, '--project'),
            selected = (await projects(credentials, server)).find((item) => item.id === id);
        if (!selected)
            throw new OperationBlockedError('Project ID is not in your accessible projects. Run gitleaf projects.');
        await project.link({ serverUrl: server, projectId: selected.id, projectName: selected.name });
        output({ linked: true, folder: root, projectId: selected.id, mode: 'offline' });
        return;
    }
    const paths = () => {
        if (values.all) {
            if (args.length) throw new OperationBlockedError('Use paths or --all, not both.');
            return undefined;
        }
        if (!args.length) throw new OperationBlockedError('Specify paths or --all.');
        return args.map((file) => {
            const relative = path.relative(root, path.resolve(cwd, file));
            if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
                throw new OperationBlockedError('Path is outside the linked folder.');
            return relative.replace(/\\/g, '/') || '.';
        });
    };
    let request: ProjectCommand;
    switch (command) {
        case 'offline':
            request = { type: 'enterOffline' };
            break;
        case 'status':
        case 'pull':
        case 'push':
        case 'fetch':
            request = { type: command };
            break;
        case 'add':
            request = { type: 'stage', paths: paths() };
            break;
        case 'unstage':
        case 'discard':
            request = { type: command, paths: paths() };
            break;
        case 'commit':
            request = { type: 'commit', message: requireValue(values.message, '-m MESSAGE') };
            break;
        case 'diff':
            request = {
                type: 'diff',
                staged: values.staged,
                commit: values.commit,
                word: values.word,
                paths: args.length ? paths() : undefined,
            };
            break;
        case 'history':
            request = {
                type: 'history',
                local: values.local,
                before: values.before === undefined ? undefined : number(values.before, '--before'),
            };
            break;
        case 'history-files':
        case 'history-diff':
            request = {
                type: command === 'history-files' ? 'historyFiles' : 'historyDiff',
                from: number(values.from, '--from'),
                to: number(values.to, '--to'),
                path: values.path,
            };
            break;
        case 'label':
            if (!!values.version === !!values.commit) throw new OperationBlockedError('Choose --version or --commit.');
            request = {
                type: 'label',
                version: values.version === undefined ? undefined : number(values.version, '--version'),
                commit: values.commit,
                message: requireValue(values.message, '-m TEXT'),
            };
            break;
        case 'restore':
            request = { type: 'restore', version: number(values.version, '--version') };
            break;
        case 'revert':
            if (!!values.soft === !!values.hard)
                throw new OperationBlockedError('Choose exactly one of --soft or --hard.');
            request = { type: 'revert', commit: requireValue(args[0], 'HASH'), mode: values.hard ? 'hard' : 'soft' };
            break;
        case 'stash': {
            const action = args[0] || 'save';
            if (action === 'list') request = { type: 'stashes' };
            else if (action === 'save' || action === 'apply' || action === 'pop' || action === 'drop')
                request = {
                    type: 'stash',
                    action,
                    message: values.message,
                    hash: action === 'save' ? undefined : requireValue(args[1], 'HASH'),
                };
            else throw new OperationBlockedError('Unknown stash action.');
            break;
        }
        case 'resolve': {
            const strategy = values.strategy;
            if (strategy !== 'manual' && strategy !== 'local' && strategy !== 'overleaf')
                throw new OperationBlockedError('Choose --strategy manual, local or overleaf.');
            request = { type: 'resolve', path: paths()![0], strategy };
            break;
        }
        case 'abort-pull':
            request = { type: 'abortPull' };
            break;
        default:
            throw new OperationBlockedError(`Unknown command: ${command}. Run gitleaf help.`);
    }
    const result = await project.execute(request);
    output(result ?? { completed: true });
    if (result?.canceled) process.exitCode = 4;
    else if (result?.conflicts?.length) process.exitCode = 3;
}

if (require.main === module)
    void runCli(process.argv.slice(2)).catch((error) => {
        const blocked = error instanceof OperationBlockedError;
        const message = error instanceof Error ? error.message : 'Unknown GitLeaf error';
        if (process.argv.includes('--json'))
            process.stdout.write(
                JSON.stringify({
                    schemaVersion: 1,
                    ok: false,
                    error: { code: blocked ? 'OPERATION_BLOCKED' : 'FAILED', message },
                }) + '\n',
            );
        else process.stderr.write(`GitLeaf: ${message}\n`);
        process.exitCode = blocked ? 2 : 1;
    });
