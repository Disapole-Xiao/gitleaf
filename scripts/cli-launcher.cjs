#!/usr/bin/env node
'use strict';

// This small bootstrap is copied to a stable user directory, NOT the CLI or
// its dependencies. VS Code resolves the active extension on every invocation
// so upgrades/uninstalls cannot silently leave an old GitLeaf core running.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const extensionId = 'DisapoleXiao.gitleaf';
const manifestName = '.gitleaf-cli-install.json';

function locateExtension(code) {
    let command = code;
    let args = ['--locate-extension', extensionId];
    const env = { ...process.env };
    if (process.platform === 'win32') {
        // code.cmd cannot be execFile'd on Windows. Pass only the executable
        // through an environment variable, never interpolate shell source or
        // send the user's CLI arguments (which may contain credentials) here.
        command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
        env.GITLEAF_CODE_COMMAND = code;
        args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
            '$ErrorActionPreference = "Stop"; [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
            '& $env:GITLEAF_CODE_COMMAND --locate-extension DisapoleXiao.gitleaf; exit $LASTEXITCODE'];
    }
    const result = spawnSync(command, args, {
        encoding: 'utf8', env, windowsHide: true, timeout: 20000,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0) {
        throw new Error(`Cannot locate GitLeaf using ${code}. Check that the VS Code command is available and the extension is installed.`);
    }
    const directory = result.stdout.trim();
    if (!path.isAbsolute(directory) || /[\r\n]/.test(directory)) {
        throw new Error('VS Code did not return a GitLeaf extension directory. Install the extension first.');
    }
    const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (`${metadata.publisher}.${metadata.name}` !== extensionId) throw new Error('Unexpected extension identity.');
    const cli = path.join(directory, 'out', 'cli.js');
    if (!fs.statSync(cli).isFile()) throw new Error('The installed extension does not contain the CLI.');
    return cli;
}

function main() {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(__dirname, manifestName), 'utf8'));
        if (config.owner !== 'gitleaf-cli-installer' || typeof config.code !== 'string') {
            throw new Error('Invalid GitLeaf launcher registration. Run the installer again.');
        }
        const cli = locateExtension(config.code);
        // Direct Node invocation preserves stdin, argument boundaries, working
        // directory and JSON output. No GUI, extension host or shell proxy.
        const child = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
            stdio: 'inherit', windowsHide: true,
        });
        if (child.error) throw new Error('Could not start the GitLeaf CLI. Check your Node.js installation.');
        if (child.signal) process.kill(process.pid, child.signal);
        else process.exitCode = child.status ?? 1;
    } catch (error) {
        // Do not echo argv: it may include --cookie / --password.
        process.stderr.write(`GitLeaf launcher: ${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = { locateExtension, manifestName };
if (require.main === module) main();
