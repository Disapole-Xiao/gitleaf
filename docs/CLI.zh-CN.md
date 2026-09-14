# GitLeaf 1.0：核心 API、CLI 与 VS Code

两种界面使用同一个 `GitLeafProject`，没有后台 VS Code 代理，也没有第二份暂存区。
关闭 VS Code 后，CLI 仍能登录、链接文件夹、暂存、提交、查看 diff、推拉、处理冲突、stash 和撤回提交。
在线编辑器的文本缓冲、自动保存和协作者光标仍由 VS Code 适配层提供；CLI 不启动实时编辑会话。

## 安装与登录

CLI 需要 Node.js 20.17+（22.x 需 22.9+）和 PATH 中的 Git。
只使用 VS Code 界面时，安装插件就够了，不用另外安装命令行工具：插件自己带着核心代码，不通过 `gitleaf` 命令工作。
插件已经包含 CLI。想在外部终端或 agent 中使用时，用户自己运行一次注册脚本即可，不需要再安装 npm 包。
脚本支持 Windows、macOS、Linux；插件启用时不会自动修改 PATH。两边共用核心逻辑、登录和项目数据。

```bash
node "$(code --locate-extension gitleaf.gitleaf)/scripts/install-cli.cjs"
# 完全重启终端应用 / agent 后：
gitleaf --help
gitleaf --version
```

需要 `code` 命令可用；Windows PowerShell 写法、其他 shell、自定义路径、卸载见[CLI 入口安装说明](CLI-install.zh-CN.md)。
不用插件的独立环境仍可用 `npm install --global ./gitleaf-1.0.3.tgz`，这是另一种分发方式，不需要两种都装。

1.0 的登录保存在操作系统凭据库中：Windows Credential Manager、macOS Keychain 或 Linux Secret Service。
CLI 与插件必须在同一台机器、同一个操作系统用户下运行，才能读取同一登录。
没有可用/已解锁的凭据库时明确报错，不把 cookie 或密码写入配置文件。
旧版 VS Code SecretStorage 登录不会迁移；升级后重新登录一次即可。

在 VS Code 运行 **GitLeaf: Login**，或者直接在命令参数中传入 cookie：

```bash
gitleaf auth login --cookie 'overleaf_session2=...'
gitleaf auth status --verify
```

自部署服务器可直接传密码：

```bash
gitleaf auth login --server https://overleaf.example.org \
  --email me@example.org --password 'your-password'
```

参数方式可能留在 shell 历史或进程参数里；如果介意，也可以选择 `--cookie-stdin` / `--password-stdin`。
例如 `printf '%s' "$OVERLEAF_COOKIE" | gitleaf auth login --cookie-stdin`。
一次登录只选一种凭据输入方式；密码登录需要 `--email`。两种方式最终都保存到同一个系统凭据库，正常输出不回显 cookie 或密码。
`auth status` 只读本机配置，`--verify` 才访问服务器；输出不包含 cookie 或 CSRF token。
`auth logout --yes` 删除两端共享的本机登录，不宣称撤销浏览器会话或关闭已建立的在线连接。

## 链接与日常工作

```bash
gitleaf projects
cd ~/papers/cv
gitleaf link --project PROJECT_ID
```

指定目录须已存在。CLI 默认链接为 Offline，立即下载一次；已有本地文件不覆盖。
下载中断时保留关联，使用 `pull` 重试。不能把另一项目直接覆盖关联到已有 GitLeaf 数据的目录。
原有 `.git` 不受影响，GitLeaf 的 Git 数据库位于 `.gitleaf/repository`。

对于已关联的项目，不需要再次 link。以下示例假设你的关联目录是 `~/papers/cv`，请换成实际目录：

```bash
cd ~/papers/cv
gitleaf status
gitleaf add main.tex          # 或 gitleaf add . / gitleaf add -A
gitleaf diff --staged --word
gitleaf commit -m 'Update CV'
gitleaf push
```

这些是跨平台的 Unix/Git 风格参数，不是 PowerShell 命令。
Bash、Python argparse/Click 风格常见的 `子命令`、`--长选项`、`-短选项`、位置参数都能正常使用，例如 `--cookie=VALUE`、`commit -m 'message'`。
平常进入关联目录或其子目录即可；只有不想 `cd` 时才用 `gitleaf -C /path/to/project status`，用法与 Git 的 `-C` 相同。
Windows 也用相同参数，只需把目录换成实际 Windows 路径；Git Bash 中 CV 示例目录为 `/d/Desktop/tmp/cv_test`。
文件参数相对于调用目录解释。
`add --all` 暂存全部，`unstage --all` 取消暂存；`commit` 只提交暂存区。
插件可视化 `+`、命令行 `add`、两边的 commit 都操作同一 Git index。
CLI 写操作结束后发送本地刷新信号，插件的 Changes 和本地 Graph 随之刷新；不会触发后台 Pull。

## 同步与保护规则

- Fetch：只更新最后抓取的远端快照，不覆盖工作区或 index。
- Pull：要求先 commit/stash 本地修改，抓取远端并重放未推送提交；冲突不会静默丢弃。
- Push：只上传已提交内容，逐提交确认服务器版本并保存发布回执；有未确认上传时先校验远端，不能盲目重传。
- Online：插件持有整个会话的项目锁。CLI 的 Git 操作被阻止，应先在插件切到 Offline。
- Offline → Online：要求工作区、暂存区干净，没有未推送提交，并核对远端快照；模式保留在同一锁内完成。
- CLI 和插件的多步修改操作使用同一跨进程锁，而非仅依赖每条 Git 命令自己的锁。
- 插件发布未保存编辑器路径；CLI 发现仍存活的编辑器存在脏缓冲时拒绝修改。网络下载后、改写工作区前再次检查。
- 这些检查约束 GitLeaf 两端，不阻止外部程序、原生 Git 或文本编辑器自行修改文件。

若关闭 VS Code 时停留在 Online，使用 `gitleaf offline` 显式进入离线模式。
它只在没有活动在线会话时可用，保留本地文件和上次 Git 基线，不冒充一次已确认的在线会话结算。
因此此前在线编辑可能显示为 Changes；应检查后显式 Fetch、核对并处理差异。
平常从插件切换 Offline 仍会先等待同步确认，保存对应的在线基线。

`--yes` 只替代确认对话框，不绕过以上规则。

## 撤回、stash、冲突

```bash
gitleaf stash save -m "Unfinished draft"
gitleaf stash list
gitleaf stash pop FULL_STASH_HASH
gitleaf revert FULL_COMMIT_HASH --soft
gitleaf revert FULL_COMMIT_HASH --hard
gitleaf discard main.tex
gitleaf resolve main.tex --strategy manual
gitleaf abort-pull
```

Soft/hard revert 均删除选中的未发布提交及其更新的未发布提交，不创建新节点。
Soft 把修改放回暂存区；Hard 丢弃这些修改。已发布的版本不能这样撤回。
`restore --version N` 是另一种操作：创建新的 Overleaf 恢复版本，并立即同步本地，要求本地没有待保护修改。
`discard` 只丢弃未暂存部分，保留暂存内容；新增文件进入系统回收站。
stash 包括已暂存、未暂存和未跟踪文件，不包含忽略文件。apply/pop 恢复暂存状态；冲突时保留 stash。

## 历史与 diff

```bash
gitleaf history
gitleaf history --local
gitleaf history-files --from 22 --to 23
gitleaf history-diff --from 22 --to 23 --path main.tex
gitleaf diff --commit FULL_COMMIT_HASH --word
```

默认按 Overleaf 返回的最近一页惰性获取；`history --before` 传上一页返回的 `nextBeforeTimestamp`，它是时间游标而非版本号。
`history --local` 不发网络请求，返回未发布提交及发布回执。
服务器 diff 返回 `before` / `after` 文本；本地 diff 复用 Git 的 patch/word-diff。
共享历史缓存在用户目录 `.gitleaf/history`，按服务器和账号隔离，最多 32 条、单条不超过 1 MiB。
请求间隔、429 等待时间跨 CLI 进程保存；不会自动重试服务器写操作。

## Agent / 程序调用

```bash
cd ~/papers/cv
gitleaf status --json
gitleaf commit -m 'Update CV' --json
```

标准输出为单个 JSON 对象，标准错误用于人类诊断。`--json` 永不交互：

```json
{"schemaVersion":1,"ok":true,"data":{"commit":"..."}}
```

失败为 `ok: false` 和 `error: { code, message }`。确认/保护类失败代码为 `OPERATION_BLOCKED`，其余为 `FAILED`。
退出码：0 成功，1 失败，2 被保护规则阻止或缺确认，3 Pull 有待解决冲突，4 用户取消。
远程状态是最后 Fetch 的快照；需要最新状态时显式 Fetch。

Node/TypeScript 可直接调用同一核心，不启动 CLI 子进程：

```typescript
import { GitLeafProject, ProjectStore, Credentials } from 'gitleaf/core';

const project = new GitLeafProject(new ProjectStore('/home/me/papers/cv'), new Credentials());
const status = await project.execute({ type: 'status' });
await project.execute({ type: 'stage', paths: ['main.tex'] });
await project.execute({ type: 'commit', message: 'Update CV' });
```

需要确认的 API 必须提供 `ProjectOptions.confirm`；调用方负责基于自己的用户授权决定是否允许，核心不弹 UI。
`repository` 为编辑器读历史/diff 的底层接口；业务修改应使用 `execute`，才能应用跨进程锁和同步保护。

## 模块分工与参考

- `src/core/project.ts`：公共业务命令、事务边界、同步保护和发布回执。
- `src/core/remoteProject.ts`、`src/api/*`：无 VS Code 依赖的 Overleaf 传输、文件树和快照操作。
- `src/core/credentials.ts`：两端共用的系统凭据库与登录 API。
- `src/core/projectStore.ts`、`projectLock.ts`、`historyCache.ts`：配置、跨进程互斥、共享历史缓存。
- `src/cli.ts`：参数、标准输入/输出、确认和退出码；无业务副本。
- `src/offline/offlineController.ts`：VS Code 弹窗、通知、SCM/diff 适配。
- `src/sync/onlineTextSync.ts`、`syncEngine.ts`：编辑器缓冲、自动保存和文件事件适配；OT 状态机在 `textSession.ts`。

参考成熟产品的“核心与界面分层”：
[Arduino CLI 集成方式](https://docs.arduino.cc/arduino-cli/integration-options/)、
[PlatformIO Core](https://docs.platformio.org/en/latest/core/)。
系统凭据复用 [keyring-node](https://github.com/Brooooooklyn/keyring-node)，
锁复用 [proper-lockfile](https://github.com/moxystudio/node-proper-lockfile)，
回收站复用 [trash](https://github.com/sindresorhus/trash)。

## 1.0 验证边界

验证覆盖编译、ESLint、原有在线/离线回归，以及真实独立 Node 进程的 CLI 工作流和系统凭据共享。
登录链路使用本机模拟服务器；没有将模拟测试等同于真实 Overleaf 联调。
CV 只做本地只读检查；本次没有为了测试向 CV 提交、推送或 Restore。
生产依赖审计仍有 2 项 high 告警，均属于保留的 Overleaf Socket.IO → ws 依赖链；
其余已在兼容范围内更新。后续替换该协议依赖仍需真实双端回归，不能声称审计已经清零。
