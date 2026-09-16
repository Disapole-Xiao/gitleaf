# Changelog

## Unreleased

- Compare any two local or Overleaf history versions from GitLeaf Graph using
  Select for Compare and Compare with Selected. Open all changed files in a
  native diff view, including additions, deletions and binary change summaries,
  without modifying the worktree or sync state.

## 1.0.3 — First public release

- Link any local folder to an Overleaf project in Online or Offline mode.
- Use native Source Control to stage, commit, fetch, pull, push, stash, and
  resolve conflicts. The repository-row sync action pulls before pushing.
- Follow local and remote positions in GitLeaf Graph, expand changed files,
  and open native diffs. Pushed commit messages appear in Overleaf history
  through GitLeaf labels. Remote history hover details use Overleaf's own
  change descriptions, including project and file restores.
- Keep login credentials in the operating-system vault and offline Git history
  separate from a folder's existing `.git`.

## 1.0.2

- Bundle an opt-in, cross-platform CLI registration script. Reuse the installed
  extension instead of requiring a second global npm installation.
- Resolve the active extension through VS Code on every launch, preserving
  standalone use, stdin, argument boundaries, JSON output and exit codes.
- Add user-only Windows PATH and Bash/Zsh/Fish startup registration, idempotent
  reinstall and ownership-checked uninstall; never run on extension activation.
- Test npm-style Windows/PowerShell/Git Bash launchers and register a Linux,
  macOS and Windows CI matrix. Require Node.js 20.17+ (22.x: 22.9+) for cmd-shim.

## 1.0.1

- Accept direct `auth login --cookie` and `--email --password` arguments as well
  as explicit stdin input. Reject ambiguous credential sources and do not echo secrets.
- Use standard `--version` / `-V` flags and add `-y` for confirmation; retain
  `restore/label --version N` as their server-version selector.
- Fix `add .` to select the worktree while preserving ignored-file exclusions.
- Replace PowerShell-centric documentation with Bash / Git-style examples and
  clarify that the extension bundles the core instead of invoking the global CLI.

## 1.0.0

- Extract a VS Code-independent core API; editor and standalone CLI share login,
  folder links, index/commits, pull/push, publication receipts, stash and recovery rules.
- Add terminal commands with JSON output, explicit confirmation and meaningful
  exit codes. CLI login and remote operations do not require a running editor.
- Store shared credentials in the OS vault. Require re-login, with no legacy
  SecretStorage migration or plaintext fallback.
- Lock whole project operations across processes and hold the lease for online
  sessions; protect unsaved editor buffers and refresh SCM after CLI changes.
- Share account-scoped history caching, request pacing and 429 cooldowns across
  editor windows and CLI invocations. Preserve the versioned GitLeaf User-Agent.
- Preserve online OT, autosave, collaborator UI and native SCM/diff integration.
- Add real standalone-process CLI, shared credential and concurrency regression tests.

## 0.6.4

- Use native VS Code notifications for history failures, including list, file
  and diff requests. Restore/Revert safety checks and temporary rate limits use
  warnings; actual operation failures use errors. Destructive confirmations
  remain modal, and identical visible notifications are deduplicated.
- Remove inline graph error rows. Failed file loads leave a retryable collapsed
  node, failed paging re-enables its button, and action/diff errors do not change
  the expanded file tree. Keep cached history and never retry writes automatically.

## 0.6.3

- Identify history requests with the actual `GitLeaf/<extension version>`
  User-Agent. CV's history diff endpoint rejected node-fetch's default identity
  with 429; a controlled A/B/A diagnostic confirmed the client-header trigger.
- Preserve history request caching, deduplication, spacing and 429 cooldowns.
  Add regression coverage for client identity, authentication and unchanged
  GET/POST history request payloads.

## 0.6.2

- Make version badges completely flat: remove the translucent outline, disable
  box/text shadows, and keep the pale theme-aware pill fill and existing height.

## 0.6.1

- Dim files/folders excluded by GitLeaf sync rules with VS Code Git's native
  ignored-file theme color in both Online and Offline modes. Refresh on saved
  ignore rules and main-file settings; remove colors when the folder is unlinked.
- Respect directory-only patterns, negation and link boundaries without scanning
  the project or making network requests. Preserve staged/worktree SCM badges.

## 0.6.0

- Add native discard-arrow actions for unstaged Changes. Preserve the index and
  use VS Code's Recycle Bin for selected untracked files.
- Add local Stash / Apply / Pop / Drop using Git, including untracked files,
  preserving staging state and retaining the stash after a failed Pop.
- Restore a server version and immediately Pull it into the linked folder;
  guard dirty editors/worktrees and unpublished commits, and distinguish a
  successful server Restore from a failed local download.
- Use pale, theme-derived pill badges, larger gray timeline circles and gray
  load-more text with text-only hover feedback. Remove node chevrons.
- Add sanitized response classification/timing diagnostics for persistent 429
  failures. CV logs show isolated filetree/diff failures, not a retry burst;
  the production rejection's cause is not yet established or claimed fixed.

## 0.5.0

- Replace independent Git/server swimlanes with a lazy linear version list:
  unpublished commits first, version badges, verified published commit messages,
  nested file trees, rich hover cards and Label/Restore/Hard/Soft context actions.
- Push immutable local commits sequentially, verify server version boundaries,
  create Overleaf labels and persist receipts. Protect interrupted uploads from
  destructive reset; retry confirmation without blindly uploading again.
- Rebase unpublished commits on Pull. Hard/Soft Revert removes selected local
  commits without adding a node; published history requires server Restore.
- Enforce clean, saved, pushed and reconciled entry into Online, including on
  restart. Wait for text acknowledgements and file operations before leaving,
  align the offline baseline, and preserve edits made after the session cutoff.
- Share history throttling/caches across controllers for the same account;
  cache recent pages, avoid hover/reopen request bursts and never auto-retry 429.
- Add real-Git workflow regression coverage and isolated browser visual checks.

## 0.4.0

- Replace the history tree with a compact, theme-aware SVG graph in a stable
  Webview View. Draw actual Git parents/merges and a separate Overleaf timeline,
  with HEAD/ref labels, expandable file status rows and native diff commands.
- Coalesce and serialize history requests; cache immutable file lists and text
  diffs across refreshes. Honor 429 Retry-After cooldowns, retry brief limits
  once, and present longer limits with an explicit inline retry.
- Distinguish rate limits from expired sessions/access errors and remove the
  repetitive "Read-only server history; not a Git commit" tooltip sentence.

## 0.3.2

- Remove collaborator name tooltips, including stale locations and raw command
  URLs. Keep the online collaborator list and direct, cache-first name clicks.
- Use safe HTML links with explicit empty titles through the stable Markdown API;
  no experimental API or cursor-driven status-bar redraw is needed.

## 0.3.1

- Give collaborator name links a `path:line` title instead of exposing the raw
  command URL; show an unknown-location label when no position is cached.
- Jump immediately using the cursor cache maintained by live events. If the
  location is missing, query Overleaf once, update the cache and then jump.
- Keep location titles as roster snapshots to avoid cursor-driven hover redraws.

## 0.3.0

- Replace history picker chains with GitLeaf Graph: local Git snapshots and
  actual Overleaf version history appear directly in an expandable timeline.
  Expand a record to list changed files; click a file for the native diff.
- Add U/M/A/D/R/! file badges to Changes, Staged Changes and history, including
  distinct index/worktree states for the same file and lazy remote paging.
- Normalize editor CRLF to Overleaf LF at the OT boundary, preventing remote
  Enter from echoing back and adding unbounded newlines. Keep the local EOL style.
- Avoid repeated status-bar show calls for unchanged collaborator rosters.
  Clicking the status item shows its existing hover; only name links jump.

## 0.2.1

- List all tracked online collaborators as clickable names in the status-bar
  tooltip. Clicking a name queries the latest cursor and jumps directly there,
  without opening a selection menu or refreshing the tooltip on cursor movement.

## 0.2.0

- Keep linked projects in the selected local directory without changing workspace roots.
- Replace snapshot-overwrite online sync with versioned OT, pending/in-flight queues,
  native granular editor edits, and automatic local saves.
- Wait for Overleaf document acknowledgements, not merely transport callbacks.
- Render zero-width collaborator carets and stable status-bar tooltips; query locations on click.
- Add real Git staging/unstaging and commit only the index; push immutable HEAD content.
- Share gitignore-style exclusions between sync and offline Git, including build outputs.
- Hide empty merge changes and place actual conflicts above staged/working changes.
- Add explicit Fetch, ahead/behind counts, local/remote snapshot history, and real
  Overleaf server history with native text diffs.

## 0.1.1

- Fix initial downloads against current overleaf.com project pages by retaining
  the authoritative project tree returned by the real-time connection.
- Allow an interrupted offline link to recover through Pull from Overleaf.
- Keep a selected nested folder linked across VS Code reloads by adding that
  exact folder to the multi-root workspace.
- Merge project, server, status, and mode values into actionable status rows.

## 0.1.0

- Link an Overleaf project to a user-selected local folder.
- Add explicit Online and Offline modes.
- Add live text/file synchronization and collaborator cursor decorations.
- Add hidden Git-backed offline commits, native VS Code diffs, history, guarded
  push/pull, three-way merge, conflict resolution, and merge abort.
- Preserve offline history when unlinking.
