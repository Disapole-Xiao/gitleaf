'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const targets = ['win32-x64', 'linux-x64', 'darwin-x64', 'darwin-arm64'];
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function versionParts(version) {
    assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Use a stable x.y.z version.');
    return version.split('.').map(BigInt);
}

function releaseNotes(changelog, version) {
    const sections = [...changelog.matchAll(/^## +([^\r\n]+)\r?$/gm)];
    const matches = sections.filter(section => section[1].split(/\s/)[0] === version);
    assert.equal(matches.length, 1, `CHANGELOG.md must contain exactly one "## ${version}" section reviewed by the user.`);
    const section = matches[0];
    const next = sections[sections.indexOf(section) + 1];
    const body = changelog.slice(section.index + section[0].length, next?.index).trim();
    assert.match(body, /^[-*] +\S.+/m, `CHANGELOG ${version} must describe the changes, not just the version.`);
    return body;
}

function shouldPublish(version, previousVersion, eventName, ref) {
    const current = versionParts(version);
    if (eventName !== 'push' || ref !== 'refs/heads/main') return false;
    const previous = versionParts(previousVersion);
    const different = current.findIndex((part, index) => part !== previous[index]);
    if (different === -1) return false;
    assert(current[different] > previous[different], 'A release version must increase, never decrease.');
    return true;
}

function manifest() {
    const pkg = readJson('package.json');
    const lock = readJson('package-lock.json');
    versionParts(pkg.version);
    assert.equal(pkg.name, 'gitleaf');
    assert.equal(pkg.publisher, 'DisapoleXiao');
    assert.equal(lock.version, pkg.version, 'package-lock.json version differs from package.json.');
    assert.equal(lock.packages[''].version, pkg.version, 'Lockfile root version differs from package.json.');
    return pkg;
}

function prepare() {
    const { version } = manifest();
    let previousVersion;
    if (process.env.GITHUB_EVENT_NAME === 'push' && process.env.GITHUB_REF === 'refs/heads/main') {
        const { before } = readJson(process.env.GITHUB_EVENT_PATH);
        assert.match(before, /^[a-f0-9]{40}$/);
        assert(!/^0+$/.test(before), 'Initial main creation does not authorize a release; merge a reviewed version bump.');
        previousVersion = JSON.parse(execFileSync('git', ['show', `${before}:package.json`], { encoding: 'utf8' })).version;
    }
    const publish = shouldPublish(version, previousVersion, process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF);
    if (publish) releaseNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), version);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\npublish=${publish}\n`);
    console.log(publish ? `Release ${version}: checked CHANGELOG; awaiting platform builds and environment approval.` : `Check and package ${version}; no release.`);
}

function packagePaths(directory, version) {
    const expected = targets.map(target => `gitleaf-${version}-${target}.vsix`).sort();
    const actual = fs.readdirSync(directory).filter(file => file.endsWith('.vsix')).sort();
    assert.deepEqual(actual, expected, 'Exactly one VSIX for each of the four platforms is required.');
    return expected.map(file => path.join(directory, file));
}

function gh(...args) {
    return execFileSync('gh', args, { encoding: 'utf8' }).trim();
}

function publishGitHubRelease(run = gh, query = args => spawnSync('gh', args, { encoding: 'utf8' })) {
    assert.equal(process.env.GITHUB_EVENT_NAME, 'push');
    assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
    const { version } = manifest();
    const tag = `v${version}`;
    const sha = process.env.GITHUB_SHA;
    const repository = process.env.GITHUB_REPOSITORY;
    assert.match(sha, /^[a-f0-9]{40}$/);
    assert.match(repository, /^[\w.-]+\/[\w.-]+$/);
    const notes = releaseNotes(fs.readFileSync('CHANGELOG.md', 'utf8'), version);
    const packages = packagePaths('artifacts', version);
    const notesFile = path.join(process.env.RUNNER_TEMP, 'gitleaf-release-notes.md');
    fs.writeFileSync(notesFile, notes + '\n');

    const lookup = query(['api', `repos/${repository}/releases/tags/${tag}`]);
    if (lookup.error) throw lookup.error;
    let release;
    if (lookup.status === 0) {
        release = JSON.parse(lookup.stdout);
        assert.equal(release.body.trim(), notes, 'Existing release notes differ; refusing to overwrite a release.');
        assert.equal(release.prerelease, false, 'Expected a stable release.');
        if (release.draft) {
            assert.equal(release.target_commitish, sha, 'Existing draft belongs to another commit.');
        } else {
            assert.equal(run('api', `repos/${repository}/commits/${tag}`, '--jq', '.sha'), sha, 'Existing release tag belongs to another commit.');
        }
    } else {
        assert.match(lookup.stderr, /HTTP 404/, 'Could not query GitHub releases; refusing to publish.');
        // A pre-existing tag must not silently redirect the release to older source.
        const tagLookup = query(['api', `repos/${repository}/commits/${tag}`, '--jq', '.sha']);
        if (tagLookup.error) throw tagLookup.error;
        if (tagLookup.status === 0) assert.equal(tagLookup.stdout.trim(), sha, 'Existing tag belongs to another commit.');
        else assert.match(tagLookup.stderr, /HTTP (404|422)/, 'Could not check the release tag.');
        run('release', 'create', tag, '--draft', '--target', sha, '--title', tag, '--notes-file', notesFile);
        release = { draft: true };
    }

    if (release.draft) {
        // Drafts can be repaired after an interrupted upload; public assets are never replaced.
        run('release', 'upload', tag, ...packages, '--clobber');
        run('release', 'edit', tag, '--draft=false', '--latest');
    }
    assert.equal(run('api', `repos/${repository}/commits/${tag}`, '--jq', '.sha'), sha, 'Published tag belongs to another commit.');
    fs.mkdirSync('published', { recursive: true });
    run('release', 'download', tag, '--pattern', '*.vsix', '--dir', 'published');
    packagePaths('published', version);
    console.log(`GitHub Release ${tag} is published; Marketplace will use its exact VSIX assets.`);
}

if (require.main === module) {
    const command = process.argv[2];
    if (command === 'prepare') prepare();
    else if (command === 'github-release') publishGitHubRelease();
    else throw new Error('Usage: release.cjs prepare|github-release');
}

module.exports = { releaseNotes, shouldPublish, manifest, packagePaths, targets, publishGitHubRelease };
