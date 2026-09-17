# GitLeaf

[English](README.md)

在 VS Code 中使用 Overleaf：将一个 Overleaf 项目关联到你选定的本地文件夹，可以选择类似 Git 的离线工作流，也可以与协作者实时编辑。

GitLeaf 与 Overleaf 没有隶属或官方合作关系。

# 快速开始

## 使用前

- 在 VSCode 插件市场搜索并安装 GitLeaf，并准备一个可访问的 Overleaf 项目。
- 想在本地编译 LaTeX、预览 PDF？另外安装 [LaTeX Workshop](https://marketplace.visualstudio.com/items?itemName=James-Yu.latex-workshop) 插件和本地 LaTeX 环境。GitLeaf 本身不提供编译或 PDF 预览，但不装 LaTeX Workshop 仍可使用同步功能。
- 使用离线模式还需要安装 Git。

## 连接项目

1. `Ctrl+Shift+P` 打开 VS Code 命令面板，运行 **`GitLeaf: Login`**。使用 overleaf.com 时按[提示](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/master/docs/wiki.md#login-with-cookies)粘贴浏览器 Cookie。自建服务器可用邮箱和密码登录。
2. 运行 **`GitLeaf: Link Folder to Overleaf Project`**，选择项目、本地文件夹，再选择工作模式：
   - **`Online`**：自动同步，适合实时协作。
   - **`Offline`**：手动提交、拉取和推送，适合 Git 式工作流。
3. 开始编辑。GitLeaf 会记住这个关联；解除关联可用 **GitLeaf: Unlink Folder**，本地文件不会因此删除。

## Online 模式

- 保存和编辑时自动同步，可以看到协作者的实时修改。不需要 Commit、Pull 或 Push。
- 想自己决定何时发布修改？运行 **GitLeaf: Change Sync Mode**，切换到离线模式。

## Offline 模式

1. 编辑并保存文件。在 VS Code **源代码管理**的 **Changes** 中点击文件查看差异。
2. 点击文件旁的 **`+`** 暂存要提交的修改，输入消息，再点击上方 **`✓`**，或在消息框按 **`Ctrl+Enter`** 提交。提交只保存在本地。
3. 点击 GitLeaf 仓库旁的**同步**按钮将自动从 Overleaf 拉取和推送本地提交。也可以从 **…** 菜单分别执行 Pull 和 Push。

常用操作：

- **Fetch**：只查看 Overleaf 的新版本，不改动本地文件。
- **Pull**：把 Overleaf 的更改合入本地。
- **Push**：上传已提交的内容。

如果 Pull 遇到冲突，在 **Merge Changes** 中选择要保留的版本或手动修改。还没准备好解决时，可运行 **GitLeaf: Abort Pull** 撤销这次拉取。

## 查看历史

- 打开源代码管理中的 **GitLeaf Graph**，点击历史记录右侧按钮可以查看全部文件差异
- 点击历史记录展开改动文件，点击文件查看单文件差异。
- 比较两个版本：右键第一个版本选择 **Select for Compare**，再右键第二个版本选择 **Compare with Selected**。先选中的版本在左侧；支持本地提交与 Overleaf 版本任意组合，不改动当前工作文件。二进制文件显示大小及内容变化摘要。
- 右键点击远程历史记录，可以执行 `restore` 和 `label` 操作，并同步到 overleaf 项目。
- 右键点击未推送的本地历史，可以撤销提交（`revert soft/hard`）。`soft` 会保留被撤销提交中的修改；`hard` 会丢弃这些修改，但有未提交修改时不能执行。

## 使用和安装 CLI

CLI 与 VS Code 界面共用登录、关联文件夹、暂存区和提交记录（需在同一台机器、同一系统用户下使用）。关闭 VS Code 后也能操作。

### 安装

1. 安装适合当前系统的 GitLeaf 插件、Node.js 22.9 或更新版本，以及 Git。确认终端能运行 `node`、`git` 和 `code`。macOS 若找不到 `code`，在 VS Code 命令面板运行 **Shell Command: Install 'code' command in PATH**。
2. 运行一次下面的安装命令，无需管理员权限，也不用另外安装 npm 包。

   **Windows PowerShell：**

   ```powershell
   $extensionPath = (code --locate-extension DisapoleXiao.gitleaf).Trim()
   node "$extensionPath/scripts/install-cli.cjs"
   ```

   **macOS / Linux（Bash、Zsh）：**

   ```bash
   node "$(code --locate-extension DisapoleXiao.gitleaf)/scripts/install-cli.cjs"
   ```

3. 完全退出并重新打开终端，再运行 `gitleaf --version` 验证。若使用 VS Code 内置终端或 agent，也重启其所在应用。

### 登录与关联

- **已在 VS Code 中登录、关联过项目？** 直接进入该文件夹，无需重复登录或 Link。
- CLI 项目操作使用 **Offline** 模式。若项目处于 Online，先在 VS Code 运行 **GitLeaf: Change Sync Mode** 切换。
- 也可以从 CLI 开始。下面的 Cookie 换成浏览器 Cookie，`PROJECT_ID` 换成 `gitleaf projects` 列出的项目 ID；`link` 会以 Offline 模式关联并下载项目。

```bash
gitleaf auth login --cookie "YOUR_OVERLEAF_COOKIE"
gitleaf projects
mkdir my-paper
cd my-paper
gitleaf link --project PROJECT_ID
```

Cookie 是登录凭据，不要分享或提交到仓库。上述写法可能保留在终端历史中；可优先使用 VS Code 登录，或按[详细说明](docs/CLI.zh-CN.md#安装与登录)使用 `--cookie-stdin`。

### 日常使用

在关联文件夹中编辑并保存后：

```bash
gitleaf status
gitleaf diff
gitleaf add main.tex
gitleaf diff --staged
gitleaf commit -m "Update introduction"
gitleaf pull
gitleaf push
```

- `add main.tex` 暂存指定文件；`add --all` 暂存全部修改；`commit` 只提交已暂存内容，`push` 只上传已提交内容。
- Pull 前先提交或暂存工作进度（`gitleaf stash save`）；遇到冲突时先解决，再 Push。具体操作见[冲突处理说明](docs/CLI.zh-CN.md#撤回stash冲突)。
- `gitleaf fetch` 只检查远程更新，不修改工作文件；`gitleaf history` 查看历史。
- 不想切换目录？用 `gitleaf -C "你的关联文件夹" status`。脚本或 agent 可用 `gitleaf status --json`。
- 更多命令：`gitleaf --help`。其他终端、卸载和安装问题见[CLI 安装说明](docs/CLI-install.zh-CN.md)。

## 致谢

感谢 [LocalLeaf](https://github.com/Teddy-van-Jerry/LocalLeaf) 项目及作者 Teddy van Jerry（Wuqiong Zhao）。GitLeaf 参考了该项目的设计与实现，并改造了其中部分 MIT 许可代码。原项目署名与许可见 [NOTICE](NOTICE) 和 [LICENSE](LICENSE)。
