#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');
const { spawnSync } = require('node:child_process');
const { locateExtension, manifestName } = require('./cli-launcher.cjs');

const owner = 'gitleaf-cli-installer';
const launcherName = 'gitleaf-launcher.cjs';
const HELP = `Register the CLI bundled with your installed GitLeaf extension.

Usage: node scripts/install-cli.cjs [options]
  --code COMMAND       VS Code command or absolute path (default: code)
  --bin-dir DIRECTORY  Dedicated user directory for the command entry
  --shell bash|zsh|fish Shell whose startup files receive PATH (Unix only)
  --no-modify-path      Create the entry without changing PATH/startup files
  --uninstall          Remove this installer's entry and owned PATH changes
  -h, --help           Show help

Run explicitly as your normal user; no administrator/sudo access is needed.
Requires Node.js 20.17+ (22.x: 22.9+), Git and the VS Code command on PATH.
No login, project files or network sync are touched. Restart your terminal/agent
after installation. VS Code need not be open when using the installed command.
`;

const hash = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${value.replace(/'/g, `'"'"'`)}'`;
const fishQuote = value => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function readOptional(file) {
    try { return await fs.readFile(file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

function defaultBinDir(platform = process.platform, home = os.homedir(), env = process.env) {
    if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'GitLeaf', 'bin');
    return path.join(home, '.local', 'share', 'gitleaf', 'bin');
}

function pathBlock(binDir, shell) {
    const id = hash(binDir).slice(0, 12);
    const body = shell === 'fish'
        ? `if not contains -- ${fishQuote(binDir)} $PATH\n    set -gx PATH ${fishQuote(binDir)} $PATH\nend`
        : `case ":$PATH:" in\n    *:${quote(binDir)}:*) ;;\n    *) export PATH=${quote(binDir)}:"$PATH" ;;\nesac`;
    return `# >>> GitLeaf CLI ${id} >>>\n${body}\n# <<< GitLeaf CLI ${id} <<<`;
}

async function shellFiles(shell, home = os.homedir(), env = process.env) {
    if (shell === 'bash') {
        // Bash reads only the first existing login file, in this order.
        const loginNames = ['.bash_profile', '.bash_login', '.profile'];
        let login = path.join(home, '.profile');
        for (const name of loginNames) {
            const candidate = path.join(home, name);
            if (await readOptional(candidate) !== undefined) { login = candidate; break; }
        }
        return [path.join(home, '.bashrc'), login];
    }
    if (shell === 'zsh') {
        const directory = env.ZDOTDIR || home;
        return [path.join(directory, '.zshrc'), path.join(directory, '.zprofile')];
    }
    if (shell === 'fish') return [path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'fish', 'conf.d', 'gitleaf-cli.fish')];
    throw new Error('Choose --shell bash, zsh or fish, or use --no-modify-path for another shell.');
}

function windowsPath(binDir, remove = false, registrySubKey) {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(__dirname, 'cli-path.ps1'), '-BinDir', binDir];
    if (remove) args.push('-Remove');
    if (registrySubKey) args.push('-RegistrySubKey', registrySubKey);
    const result = spawnSync(powershell, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    if (result.error || result.status !== 0) throw new Error('Could not update the user PATH. The command entry remains; use --no-modify-path or check PowerShell permissions.');
    return JSON.parse(result.stdout).changed;
}

async function fingerprint(file) {
    const stat = await fs.lstat(file);
    return stat.isSymbolicLink() ? `link:${await fs.readlink(file)}` : hash(await fs.readFile(file));
}

async function validateOwned(binDir, config) {
    if (config.owner !== owner || !config.files || !Array.isArray(config.pathEdits)) throw new Error('This directory is not a GitLeaf CLI registration.');
    const allowed = new Set([launcherName, 'gitleaf', 'gitleaf.cmd', 'gitleaf.ps1']);
    for (const [name, expected] of Object.entries(config.files)) {
        if (!allowed.has(name)) throw new Error('Unexpected file in the GitLeaf registration.');
        if (await fingerprint(path.join(binDir, name)) !== expected) {
            throw new Error(`${name} was modified outside the installer; refusing to overwrite or remove it.`);
        }
    }
    for (const edit of config.pathEdits) {
        const content = await readOptional(edit.file);
        if (!content?.includes(edit.addition)) throw new Error(`The managed PATH block in ${edit.file} was modified. Restore it before reinstalling/uninstalling.`);
    }
}

async function install(options) {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (!(major === 20 && minor >= 17 || major === 22 && minor >= 9 || major > 22)) {
        throw new Error('Use Node.js 20.17+ (22.x: 22.9+) for the CLI installer.');
    }
    const binDir = path.resolve(options.binDir || defaultBinDir());
    if ([os.homedir(), path.parse(binDir).root, process.cwd()].some(value => path.resolve(value) === binDir) || /[\r\n;]/.test(binDir) || process.platform !== 'win32' && binDir.includes(':')) {
        throw new Error('Use a dedicated bin directory, not a home/workspace/filesystem root or a path containing newlines/PATH separators.');
    }
    if (!['win32', 'darwin', 'linux'].includes(process.platform)) throw new Error('Supported operating systems: Windows, macOS and Linux.');
    // npm's batch shim uses SET dp0=%~dp0. Do not generate a command in a
    // directory whose name cmd.exe would interpret as shell syntax.
    if (process.platform === 'win32' && /[&|<>^%!"]/.test(binDir)) {
        throw new Error('Choose --bin-dir without Windows shell metacharacters; spaces and Unicode are supported.');
    }
    const configPath = path.join(binDir, manifestName);
    const existing = await readOptional(configPath);
    let config = existing ? JSON.parse(existing) : undefined;
    if (config) await validateOwned(binDir, config);
    if (options.uninstall) {
        if (!config) return { binDir, message: 'No GitLeaf CLI registration exists here.' };
        // Only remove exact owned files/blocks. Never recursively delete the
        // directory, user startup files, extension, credentials or projects.
        if (config.windowsPathAdded) windowsPath(binDir, true);
        for (const edit of config.pathEdits) {
            const content = (await fs.readFile(edit.file, 'utf8')).replace(edit.addition, '');
            if (edit.created && !content) await fs.unlink(edit.file);
            else await fs.writeFile(edit.file, content);
        }
        for (const name of Object.keys(config.files)) await fs.unlink(path.join(binDir, name));
        await fs.unlink(configPath);
        await fs.rmdir(binDir).catch(error => { if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error; });
        return { binDir, message: 'Removed the command entry and its owned PATH changes. Login and project data were kept.' };
    }

    const codeOption = options.code || config?.code || 'code';
    const code = /[/\\]/.test(codeOption) ? path.resolve(codeOption) : codeOption;
    const cli = locateExtension(code);
    const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
    if (git.error || git.status !== 0) throw new Error('Install Git and make git available on PATH first.');
    const shell = options.shell || path.basename(process.env.SHELL || '');
    const targets = options.modifyPath !== false && process.platform !== 'win32' ? await shellFiles(shell) : [];
    const names = process.platform === 'win32' ? [launcherName, 'gitleaf', 'gitleaf.cmd', 'gitleaf.ps1'] : [launcherName, 'gitleaf'];
    // No --force: unrelated launchers must be left intact, even on reinstall.
    for (const name of names) {
        try {
            await fs.lstat(path.join(binDir, name));
            if (!config?.files[name]) throw new Error(`Refusing to overwrite existing ${path.join(binDir, name)}.`);
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.mkdir(binDir, { recursive: true });
    // A VSIX built on Windows may contain CRLF. Unix shebangs must use LF.
    await fs.writeFile(path.join(binDir, launcherName), (await fs.readFile(path.join(__dirname, 'cli-launcher.cjs'), 'utf8')).replace(/\r\n/g, '\n'));
    await fs.chmod(path.join(binDir, launcherName), 0o755);
    if (process.platform === 'win32') {
        // The same library npm uses: cmd.exe, PowerShell and Git Bash entries,
        // including its established argument/path quoting and stdin handling.
        await require('cmd-shim')(path.join(binDir, launcherName), path.join(binDir, 'gitleaf'));
    } else {
        if (config?.files.gitleaf) await fs.unlink(path.join(binDir, 'gitleaf'));
        await fs.symlink(launcherName, path.join(binDir, 'gitleaf'));
    }
    config = { owner, code, files: {}, pathEdits: config?.pathEdits || [], windowsPathAdded: config?.windowsPathAdded || false };
    for (const name of names) config.files[name] = await fingerprint(path.join(binDir, name));
    const save = () => fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
    // Persist ownership before PATH changes so a denied startup-file write can
    // be retried or uninstalled without touching someone else's files.
    await save();
    if (options.modifyPath !== false && process.platform === 'win32') {
        config.windowsPathAdded = windowsPath(binDir) || config.windowsPathAdded;
        await save();
    }
    for (const file of targets) {
        if (config.pathEdits.some(edit => edit.file === file)) continue;
        const before = await readOptional(file);
        const block = pathBlock(binDir, shell);
        if (before?.includes('# >>> GitLeaf CLI')) throw new Error(`An unowned GitLeaf PATH block exists in ${file}; refusing to duplicate it.`);
        const addition = `${before && !before.endsWith('\n') ? '\n' : ''}${block}\n`;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, addition);
        config.pathEdits.push({ file, addition, created: before === undefined });
        await save();
    }
    return { binDir, cli, message: options.modifyPath === false
        ? 'Command entry created; PATH was not modified.'
        : 'Command entry registered. Restart your terminal app/agent, then run gitleaf --version.' };
}

async function main(argv = process.argv.slice(2)) {
    const { values } = parseArgs({ args: argv, options: {
        code: { type: 'string' }, 'bin-dir': { type: 'string' }, shell: { type: 'string' },
        'no-modify-path': { type: 'boolean' }, uninstall: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    } });
    if (values.help) { process.stdout.write(HELP); return; }
    const result = await install({ code: values.code, binDir: values['bin-dir'], shell: values.shell,
        modifyPath: !values['no-modify-path'], uninstall: values.uninstall });
    process.stdout.write(`${result.message}\nDirectory: ${result.binDir}\n`);
}

module.exports = { install, defaultBinDir, pathBlock, shellFiles, windowsPath };
if (require.main === module) main().catch(error => { process.stderr.write(`GitLeaf installer: ${error.message}\n`); process.exitCode = 1; });
