# Changelog

Only versions released on the Visual Studio Marketplace are listed here.

## 1.1.2 — 2026-09-29

### New Features

- Online text synchronization now uploads local changes when a file is saved and refreshes clean local files from the latest Overleaf document after collaborator edits. Save your changes before expecting them on Overleaf.
- Show progress while switching between Online and Offline modes.
- Allow Offline commits without a message and keep their Overleaf history entries distinct.

### Improvements

- Fetch and Pull use a fixed Overleaf history version, so active collaborator edits do not repeatedly invalidate a download.
- Push checks the files changed by each local commit, allowing unrelated collaborator edits while stopping if those same files changed on Overleaf.

### Fixes

- Prevent remote editor updates from being sent back to Overleaf repeatedly, which could cause an Online sync loop.
- Pause Online sync for the entire project when local and remote edits conflict, an incoming update encounters unsaved editor changes, a document lacks a confirmed sync baseline, text grows unexpectedly, or the connection fails. Further remote writes remain blocked until reconnection.
- Keep conflict resolution usable while a Pull notification is open, continue resolved rebases on the next Pull or sync, and identify unstaged files that prevent continuation.
- Retry transient Windows file-access errors while atomically replacing the history cache.

## 1.1.1 — 2026-09-25

### Fixes

- Fix sync failures caused by interrupted file downloads from Overleaf.
- Fix image and PDF uploads failing with a "Delete ... 404" error or leaving temporary filenames.
- Fix missing history entries and commit messages in GitLeaf Graph. History entries now match Overleaf's All history view.
- Fix long commit messages missing in history details. The full message now appears above the file changes, separated by a blank line.
- Fix the release workflow incorrectly rejecting matching release notes.

## 1.1.0 — 2026-09-17

### New Features

- Compare any two local or remote history versions in GitLeaf Graph.
- Allow Offline pulls with uncommitted tracked-file changes by automatically stashing and restoring them.

### Fixes

- Keep repository incoming and outgoing counts consistent with GitLeaf Graph. Show `N+` when history is only partially loaded.
- Fix CLI extension discovery when the publisher ID uses mixed capitalization.
- Improve history hover behavior, long-message scrolling, and version badge placement.

### Docs

- Expand the English and Chinese guides for CLI installation, usage, and history management.

## 1.0.3 — 2026-09-14

- First public release, for Windows x64.
- Link Overleaf projects to local folders for real-time Online collaboration or a Git-style Offline workflow.
- Stage and commit changes, fetch, pull, push, stash, and resolve conflicts through VS Code Source Control or the bundled CLI.
- View local and remote history in GitLeaf Graph, inspect file diffs, and manage Overleaf labels and restored versions.
- Share login and project data between VS Code and the CLI, with credentials stored in the operating system's credential vault.
