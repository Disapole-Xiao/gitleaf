# GitLeaf

[简体中文](README.zh-CN.md)

Use Overleaf in VS Code: link an Overleaf project to a local folder, then choose a Git-style offline workflow or edit with collaborators in real time.

GitLeaf is not affiliated with or endorsed by Overleaf.

# Quick start

## Before you start

- Find and install GitLeaf in the VS Code Extensions Marketplace, and have access to an Overleaf project.
- Want to compile LaTeX and preview PDFs locally? Also install [LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop) and a local LaTeX distribution. GitLeaf does not compile or preview PDFs, but syncing works without LaTeX Workshop.
- Offline mode also requires Git.

## Connect a project

1. Press `Ctrl+Shift+P` to open the Command Palette and run **`GitLeaf: Login`**. For overleaf.com, follow these [instructions](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/master/docs/wiki.md#login-with-cookies) to paste your browser cookie. For a self-hosted server, sign in with your email and password.
2. Run **`GitLeaf: Link Folder to Overleaf Project`**. Choose a project, a local folder, and a mode:
   - **`Online`**: automatic syncing for real-time collaboration.
   - **`Offline`**: manual commits, pulls, and pushes for a Git-style workflow.
3. Start editing. GitLeaf remembers the link. **GitLeaf: Unlink Folder** removes the link without deleting your local files.

## Online mode

- Edits sync automatically, and you can see collaborators' changes. You do not need Commit, Pull, or Push.
- Want to control when changes are published? Run **GitLeaf: Change Sync Mode** and switch to Offline.

## Offline mode

1. Edit and save your files. In VS Code **Source Control**, click a file under **Changes** to inspect its diff.
2. Click the **`+`** beside a file to stage it. Enter a message, then click the top **`✓`** or press **`Ctrl+Enter`** in the message box to commit. The commit stays local.
3. Click the **sync** button beside the GitLeaf repository to pull from Overleaf and push your local commits. You can also run Pull and Push separately from the **…** menu.

Common actions:

- **Fetch**: check for new Overleaf versions without changing local files.
- **Pull**: bring Overleaf changes into your local files.
- **Push**: upload committed changes.

If Pull encounters a conflict, choose which version to keep under **Merge Changes** or edit the file manually. If you are not ready to resolve it, run **GitLeaf: Abort Pull** to cancel that pull.

## View history

- Open **GitLeaf Graph** in Source Control. Use the button on the right of a history record to view the diffs for all changed files.
- Click a record to expand its changed files, then click a file to view its individual diff.
- To compare two versions, right-click the first and choose **Select for Compare**, then right-click the second and choose **Compare with Selected**. The selected version is on the left. Local commits and Overleaf versions can be compared in any combination, without changing your working files. Binary changes show size and content summaries.
- Right-click a remote record to **Restore** or **Label** a version and sync that action to Overleaf.
- Right-click an unpublished local record to undo commits with **Revert Soft** or **Revert Hard**. Soft keeps the changes from the removed commits; Hard discards those changes, but is unavailable while you have uncommitted changes.

## Install and use the CLI

The CLI and VS Code share your login, linked folders, staged changes, and commits when run on the same machine under the same OS user. The CLI also works with VS Code closed.

### Install

1. Install the GitLeaf extension for your platform, Node.js 22.9 or newer, and Git. Make sure `node`, `git`, and `code` work in your terminal. On macOS, if `code` is missing, run **Shell Command: Install 'code' command in PATH** from the VS Code Command Palette.
2. Run the installer once. No administrator privileges or separate npm package are needed.

   **Windows PowerShell:**

   ```powershell
   $extensionPath = (code --locate-extension DisapoleXiao.gitleaf).Trim()
   node "$extensionPath/scripts/install-cli.cjs"
   ```

   **macOS / Linux (Bash, Zsh):**

   ```bash
   node "$(code --locate-extension DisapoleXiao.gitleaf)/scripts/install-cli.cjs"
   ```

3. Fully quit and reopen your terminal, then run `gitleaf --version` to check. For an integrated terminal or agent, restart its host application too.

### Log in and link a project

- **Already logged in and linked a project in VS Code?** Open that folder in your terminal. There is no need to log in or link it again.
- CLI project operations use **Offline** mode. If the project is Online, first run **GitLeaf: Change Sync Mode** in VS Code.
- You can also start from the CLI. Replace the cookie below with your browser cookie and `PROJECT_ID` with an ID returned by `gitleaf projects`. Linking downloads the project in Offline mode.

```bash
gitleaf auth login --cookie "YOUR_OVERLEAF_COOKIE"
gitleaf projects
mkdir my-paper
cd my-paper
gitleaf link --project PROJECT_ID
```

Your cookie is a login credential: never share it or commit it to a repository. The command above may remain in your shell history. Prefer signing in through VS Code, or use `--cookie-stdin` as described in the [detailed guide (Chinese)](docs/CLI.zh-CN.md#安装与登录).

### Daily workflow

After editing and saving files in your linked folder:

```bash
gitleaf status
gitleaf diff
gitleaf add main.tex
gitleaf diff --staged
gitleaf commit -m "Update introduction"
gitleaf pull
gitleaf push
```

- `add main.tex` stages one file; `add --all` stages all changes. Commit only includes staged changes; Push only uploads committed changes.
- Commit or stash (`gitleaf stash save`) before Pull. Resolve any conflicts before Push; see [conflict handling (Chinese)](docs/CLI.zh-CN.md#撤回stash冲突).
- `gitleaf fetch` checks remote updates without changing working files; `gitleaf history` shows history.
- To work without changing directories, use `gitleaf -C "/path/to/linked-folder" status`. Scripts and agents can use `gitleaf status --json`.
- Run `gitleaf --help` for more commands. For other shells, uninstallation, and installation troubleshooting, see the [CLI installation guide (Chinese)](docs/CLI-install.zh-CN.md).

## Acknowledgements

Thanks to [LocalLeaf](https://github.com/Teddy-van-Jerry/LocalLeaf) and its author, Teddy van Jerry (Wuqiong Zhao). GitLeaf drew on that project's design and implementation and adapted some of its MIT-licensed code. The original attribution and license are in [NOTICE](NOTICE) and [LICENSE](LICENSE).
