'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const targets = new Set(['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64']);
const target = process.argv[2];
if (!targets.has(target)) {
    throw new Error(`Pass a supported VSIX target: ${[...targets].join(', ')}`);
}

const root = path.resolve(__dirname, '..');
const current = require(path.join(root, 'package.json')).version;
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
if (!match) throw new Error(`Expected a stable extension version, got ${current}`);
const version = `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
const output = path.join(root, 'output', `gitleaf-${version}-${target}-debug.vsix`);
fs.mkdirSync(path.dirname(output), { recursive: true });

if (target === 'linux-x64') {
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    execFileSync('cc', ['-O2', '-o', 'bin/keyring-session', 'scripts/keyring-session.c'], { cwd: root, stdio: 'inherit' });
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
execFileSync(npx, [
    '--yes', '@vscode/vsce@3.6.0', 'package', version,
    '--no-update-package-json', '--pre-release',
    '--target', target, '--out', output,
], { cwd: root, stdio: 'inherit' });
execFileSync(process.execPath, ['.github/scripts/verify-vsix.cjs', output, target, version], { cwd: root, stdio: 'inherit' });
console.log(`Debug VSIX: ${output}`);
