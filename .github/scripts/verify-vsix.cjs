'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { unzipSync, strFromU8 } = require('fflate');

const nativePackages = {
    'win32-x64': 'keyring-win32-x64-msvc',
    'linux-x64': 'keyring-linux-x64-gnu',
    'darwin-x64': 'keyring-darwin-x64',
    'darwin-arm64': 'keyring-darwin-arm64',
};

function verifyVsix(entries, target, expected) {
    assert(nativePackages[target], `Unsupported target: ${target}`);
    const text = name => {
        assert(entries[name], `Missing packaged file: ${name}`);
        return strFromU8(entries[name]);
    };
    const packaged = JSON.parse(text('extension/package.json'));
    for (const field of ['name', 'publisher', 'version']) assert.equal(packaged[field], expected[field]);
    const identity = text('extension.vsixmanifest').match(/<Identity\b[^>]*>/)?.[0];
    assert(identity?.includes(`TargetPlatform="${target}"`), 'Incorrect VSIX target platform.');
    assert(identity.includes(`Version="${expected.version}"`), 'Incorrect VSIX manifest version.');
    for (const file of ['out/extension.js', 'out/cli.js', 'scripts/install-cli.cjs', 'scripts/cli-launcher.cjs', 'scripts/cli-path.ps1', 'media/historyGraph.js', 'media/historyGraph.css', 'readme.md', 'changelog.md', 'LICENSE.txt', 'NOTICE']) {
        text(`extension/${file}`);
    }
    const names = Object.keys(entries);
    const nativePrefix = `extension/node_modules/@napi-rs/${nativePackages[target]}/`;
    assert(names.some(name => name.startsWith(nativePrefix) && name.endsWith('.node')), 'Native keyring binary is missing.');
    for (const name of names) {
        assert(!/^extension\/(?:docs\/|src\/|\.github\/|out\/test\/|AGENTS\.md$|scripts\/test-|build\/|coverage\/|output\/|\.cache\/)/.test(name), `Private or development-only file included: ${name}`);
        assert(!/(?:^|\/)(?:\.gitleaf(?:\/|ignore$)|\.env(?:[./]|$))|\.(?:pem|p12|pfx|key|sqlite|db)$/i.test(name), `Local data or credential file included: ${name}`);
        if (/\/keyring-[^/]+\/.*\.node$/.test(name)) assert(name.startsWith(nativePrefix), `Wrong platform binary: ${name}`);
    }
}

if (require.main === module) {
    const [file, target] = process.argv.slice(2);
    verifyVsix(unzipSync(fs.readFileSync(file)), target, JSON.parse(fs.readFileSync('package.json', 'utf8')));
    console.log(`Verified ${file}: platform, native binary, CLI, metadata and public files.`);
}

module.exports = { verifyVsix };
