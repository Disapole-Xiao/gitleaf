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
- 右键点击远程历史记录，可以执行 `restore` 和 `label` 操作，并同步到 overleaf 项目。
- 右键点击未推送的本地历史，可以撤销提交（`revert soft/hard`）。`soft` 会保留被撤销提交中的修改；`hard` 会丢弃这些修改，但有未提交修改时不能执行。

## 致谢

感谢 [LocalLeaf](https://github.com/Teddy-van-Jerry/LocalLeaf) 项目及作者 Teddy van Jerry（Wuqiong Zhao）。GitLeaf 参考了该项目的设计与实现，并改造了其中部分 MIT 许可代码。原项目署名与许可见 [NOTICE](NOTICE) 和 [LICENSE](LICENSE)。
