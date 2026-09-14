# 使用插件自带的 CLI

GitLeaf 插件包已经包含完整 CLI；不必再安装一份 npm 包。
需要在终端或 agent 中操作 Overleaf 的用户，主动运行下面的脚本即可。
插件安装、启动、登录都不会自动运行此脚本，也不会自行修改 PATH。

## 前提

- 已安装当前操作系统/架构对应的 GitLeaf 插件（1.0.2+ 包含此安装脚本）。
- Node.js 满足 `^20.17.0 || >=22.9.0`，Git 和 VS Code 的 `code` 命令均在 PATH 中。
- 以普通用户运行，无需管理员权限或 `sudo`。
- macOS 若没有 `code` 命令，先在 VS Code 命令面板运行 **Shell Command: Install 'code' command in PATH**。

这只是注册命令入口，不会下载运行时或依赖，不会读取登录凭据、修改项目或请求 Overleaf。

## 安装

Bash / Zsh（也适用于 Windows Git Bash）：

```bash
node "$(code --locate-extension gitleaf.gitleaf)/scripts/install-cli.cjs"
```

Windows PowerShell：

```powershell
$extensionPath = (code --locate-extension gitleaf.gitleaf).Trim()
node "$extensionPath/scripts/install-cli.cjs"
```

Fish：

```fish
set extension_path (code --locate-extension gitleaf.gitleaf)
node "$extension_path/scripts/install-cli.cjs" --shell fish
```

在源码目录也可以运行 `node scripts/install-cli.cjs`；脚本仍使用已安装插件，不会把源码目录作为 CLI 运行目录。

安装后完全退出并重新启动终端应用/agent，再运行：

```bash
gitleaf --version
cd ~/papers/cv
gitleaf status --json
gitleaf add main.tex
gitleaf commit -m 'Update CV'
gitleaf push
```

关闭 VS Code 后仍然可用。若项目处于 Online，应先在插件切到 Offline；模式约束和同步保护不会被脚本绕过。
如果 agent 从旧的 IDE/终端父进程启动，也要重启该父进程，否则它继承的仍是旧 PATH。
macOS/Linux 上不读取 shell 配置的 GUI agent、服务或定时任务，应从已生效的终端启动，或在其环境配置中加入下表的入口目录；单纯重启这类进程不一定加载 shell 配置。

## 修改哪些位置

| 平台 | 命令入口 | PATH 注册 |
| --- | --- | --- |
| Windows | `%LOCALAPPDATA%\GitLeaf\bin` | 当前用户 PATH，保留原有值和环境变量；不改系统 PATH |
| macOS / Linux | `~/.local/share/gitleaf/bin` | 只修改选择的 shell 配置，添加带标记的 PATH 段落 |

Windows 使用 npm 的 `cmd-shim` 生成 PowerShell、cmd.exe 和 Git Bash 入口。
Bash 修改 `.bashrc` 和实际生效的登录配置（优先 `.bash_profile`，再 `.bash_login`，否则 `.profile`）。
Zsh 修改 `.zshrc` / `.zprofile`，尊重 `ZDOTDIR`。
Fish 使用 `conf.d/gitleaf-cli.fish`，尊重 `XDG_CONFIG_HOME`。
Unix 默认根据 `SHELL` 选择；使用多个 shell 时，可以分别运行 `--shell bash` / `--shell zsh` / `--shell fish`。
其他 shell 可用 `--no-modify-path`，自行配置 PATH。

重复运行不重复添加 PATH；遇到同名非本脚本生成的文件，或用户改过的入口/配置块，会停止覆盖。
脚本不会卸载或覆盖之前通过 npm 全局安装的 GitLeaf；若旧命令优先，可用 Bash 的 `type -a gitleaf` 或 PowerShell 的 `Get-Command gitleaf -All` 检查。

## 可选参数

```bash
# 只创建入口，不改 PATH / shell 配置
node scripts/install-cli.cjs --no-modify-path

# 自选专用目录；以后重新安装/卸载都传同一个目录
node scripts/install-cli.cjs --bin-dir /path/to/my-gitleaf-bin

# VS Code Insiders 或自定义 code 可执行文件位置
node scripts/install-cli.cjs --code code-insiders
```

在插件目录运行时，把上例 `scripts/install-cli.cjs` 换成前面的完整脚本路径即可。
`--code` 接收一个命令名或可执行文件路径，不接收整段 shell 命令。自定义编辑器参数不是这个选项的一部分。
Windows 命令入口支持空格和中文路径；若用户目录包含 `&`、`%` 等 cmd 特殊字符，请用 `--bin-dir` 选择不含这些字符的专用目录。
若 PowerShell 安全策略禁止执行 `.ps1`，可以用 `gitleaf.cmd` 或 Git Bash；脚本不会永久修改 PowerShell 执行策略。

入口只保存定位方式，每次使用 VS Code 的 `--locate-extension` 查询当前版本，再用 Node 直接执行插件里的 CLI。
不会启动编辑器窗口，不依赖 extension host；插件升级不需要重装入口。插件卸载后入口明确报错，不会偷偷运行旧版本。
如果 VS Code 本身换了安装位置，更新 `code` 命令，或者重跑脚本指定新的 `--code`。

CLI 和插件仍要求同一台机器、同一个系统用户、可用的系统凭据库。
此脚本不建立 Windows 与 WSL/远程主机之间的登录桥接；Linux 无桌面环境也需要配置可用的 Secret Service，不能把“入口安装成功”视为“登录已经可用”。

## 卸载入口

在卸载插件之前运行：

```bash
node "$(code --locate-extension gitleaf.gitleaf)/scripts/install-cli.cjs" --uninstall
```

只移除本脚本生成且未被改动的入口、自己添加的 PATH 项/配置块；不递归删除目录，不删除其他文件、插件、凭据或项目。
若插件已经卸载，可从项目源码运行同一个脚本并加 `--uninstall`。
使用过自定义 `--bin-dir` 时，卸载也须提供该参数。

实现依据：[VS Code 的扩展定位命令](https://code.visualstudio.com/docs/remote/troubleshooting)、[npm 的 cmd-shim](https://github.com/npm/cmd-shim)。
