# 桌面版

给不用终端的同学：双击打开，按向导点完，之后别人在飞书里 @你，本机 CC 以你的名义回。只有 **@我**，没有 @机器人（原因见 [desktop-plan.md](desktop-plan.md)）。

壳子是 Electron：主进程（`desktop/main.js`）设好环境，直接跑命令行那个 `start()`，再开一个窗口指向它的 web UI。没有构建步骤，`.ts` 靠 Node 自带的类型擦除直接跑。

## 开发态

```bash
npm i
npm run desktop
```

第一次 `npm i` 要下 Electron（约 120MB）。连 GitHub 慢的话换个镜像，比如：

```bash
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/   # 本地打包才用得到
```

开发态跟打包后用的是**同一个数据目录**（见下），跟命令行版互不相干。想用一份干净的配置从头走一遍向导：`LCR_HOME=/某个空目录 npm run desktop`。终端里 Ctrl+C 跟点「退出」一样：先把在跑的作业收尾再退。

## 打包

```bash
npm run dist       # mac + Windows 一起打
npm run dist:mac   # dist/lark-cc-router-<版本>-arm64.dmg（只打 Apple 芯片，不出 Intel 包）
npm run dist:win   # dist/lark-cc-router-Setup-<版本>.exe（x64，一键安装到当前用户，不要管理员）
```

两个都能在 mac 上打，Windows 包不需要 wine。

打进去的只有 `src/`（不含测试）、`desktop/`、`node_modules/marked`、`package.json`。没开 asar，代码原样放在 `.app/Contents/Resources/app/`（Windows 是 `resources\app\`）。

### 发版

走 GitHub Actions（`.github/workflows/release.yml`）：**推 `release` 分支就发版**。CI 在 macOS runner 上跑测试、一次打出 mac + Windows 两个包，发到仓库的 Releases，tag 是 `v<package.json 里的版本>`。同一个版本号重复推会覆盖那个 Release 里的包。也能在 Actions 页面手动触发。

GitHub 仓库（remote 名 `github`）只放 `release` 一个分支，历史是单独起的，不带 main 的老提交（老提交里有内网地址）。所以不能直接推 main，发版是把 main 当前的代码快照成 release 上的一个新提交：

```bash
npm run release          # 版本补丁位 +1、提交、打标签、推 origin → 再跑下面这个
npm run release:github   # 只做后半段：main 的代码快照成 release 上一个新提交，推到 github 触发 CI（不加版本就是重打当前版本）
```

GitHub 仓库是公开的：快照提交的作者 / 提交者固定写成 GitHub 的 noreply 邮箱，不带公司邮箱。

只用 macOS runner：mac 包只能在 macOS 上打（Apple 芯片要求程序至少 ad-hoc 签名，`codesign` 只有 mac 有），Windows 包顺手交叉打。

### 自动更新

装好的应用自己更新（`desktop/update.js`，开发态不查）：

- 仓库来自 `package.json` 的 `repository`（`github:用户/仓库`）。CI 发版时每个 Release 多传一个 `latest.json`（版本号 + 每个包的大小、sha256），应用读 `https://github.com/<仓库>/releases/latest/download/latest.json`。不带 token，所以**仓库必须是公开的**，私有的会报 404。
- 不走 `api.github.com`：不带 token 每个 IP 一小时只有 60 次，公司里大家共用一个出口 IP，实测早就用光了（403）。
- 启动 1 分钟后查一次，之后每 6 小时查一次。有新版就在后台下好：大小和 `latest.json` 里的 sha256 都对上才算数。
- 下好后等**窗口收着、而且没有作业在跑**的时候自己装上并重启，重启后回托盘，不弹窗口。窗口一直开着就不动，托盘菜单里会多一项「重启并更新到 x.y.z」。
- mac：从 dmg 里把新的 `.app` 拷到旧的旁边，停服务后两个对调再重启。没装在「应用程序」里（直接从 dmg 或下载目录打开的）、或者目录没写权限，就换不了，托盘里改成「安装 x.y.z」，点了打开安装包自己拖。
- Windows：静默跑新的安装程序（`/S`），装完把应用拉起来。

没用 electron-updater：它在 mac 上走 Squirrel.Mac，要正式的开发者签名，ad-hoc 签名装不上。

公开安装包使用仓库里的 `desktop/preset.json`。飞书应用、网关和工作区由用户在向导里配置。安装包内的预置文件可以直接读取，公开预置只填写可公开的信息。

## 图标

源文件是 `desktop/icon.svg`（应用图标）和 `desktop/tray.svg`（菜单栏 / 托盘），改了要重新导出这几张 PNG：

| 文件 | 尺寸 | 用在哪 |
|---|---|---|
| `icon.png` | 1024，透明底 | mac：打包时 electron-builder 转成 `.icns`；开发态程序坞也用它 |
| `icon-win.png` | 1024 | Windows：安装包和 exe 图标（electron-builder 转 `.ico`）、托盘。跟 mac 版同一张图，裁掉了四周留白、去掉了阴影 |
| `trayTemplate.png` / `trayTemplate@2x.png` | 16 / 32 | mac 菜单栏。文件名带 `Template` 才会按菜单栏深浅色自动反色，只看 alpha |

`@` 是用 Georgia 字体排的，导出要在装了 Georgia 的机器上（mac 自带）。用浏览器打开 SVG 截图，或者 `rsvg-convert -w 1024 icon.svg -o icon.png` 都行。

## 数据目录

| | 位置 |
|---|---|
| mac | `~/Library/Application Support/lark-cc-router/` |
| Windows | `%APPDATA%\lark-cc-router\` |

`config.json`、`state/`、向导装的工具（`bin/`）、工作区（`workspaces/`）都在这里，开发态和打包后共用，跟命令行版的仓库目录互不相干。打包后的日志在这里的 `app.log`（每次启动覆盖），出问题让对方把它发过来。

第一次打开会写一份默认配置：开 @我、关 @机器人，一个「通用」模板（`auto` 权限、内置的提示词和判定提示词，`project` 留给向导选工作区时填）。

## 三个环境变量

主进程在加载 `src/` 之前设好，claude、lark-cli 这些子进程继承过去：

| 变量 | 值 | 为什么 |
|---|---|---|
| `LCR_HOME` | 数据目录 | `config.ts` 一加载就靠它定数据目录。安装目录可能只读，升级还会整个换掉 |
| `LARKSUITE_CLI_CONFIG_DIR` | `~/.lark-cc-router/lark-cli` | 跟命令行版的 `~/.lark-cli` 分开。不放应用数据目录：@机器人 长连接要在 `events/<应用>/bus.sock` 建 unix socket，macOS 上路径超过 103 字符 lark-cli 就起不来（Application Support 下正好 104，踩过） |
| `CLAUDE_CONFIG_DIR` | `$LCR_HOME/claude` | 跟自己平时用的 `~/.claude` 分开：插件、MCP 授权各是各的，不会搞混 |

配过一次就存在这里，下次启动直接进主页；只有真缺东西（不是「还在检测」）才进向导。

之后的事不用回向导：MCP 授权过期了、要加别的插件 / skill / 插件市场，都在 设置 → Claude Code 里，点了立刻生效。

想跟自己终端里的 Claude Code 用同一套：设置 → Claude Code →「从本机同步」，勾要搬的点一下。能搬的有插件和插件市场（走 `claude plugin` 命令装，启用 / 停用状态跟本机一样）、用户级 MCP、skills / 子代理 / 自定义命令、`CLAUDE.md`、`settings.json` 里的其它设置（hooks、权限、非 API 的环境变量）。同名的以本机为准，这边多出来的不删。不搬的：
- 模型、API、登录相关的（`model`、`effortLevel`、`ANTHROPIC_*` 这些），归「API 来源」管。
- 项目级插件。
- MCP 的授权：在钥匙串里搬不了，同步完重新点「授权」。

每一项旁边先列出本机有什么、这边差多少。有 MCP 要重新授权时，主界面「设置」按钮上会有个小点（页面开着时每 30 分钟查一次）。

另外顺手修的：

- **PATH**：从 Finder 起的 mac 应用只有 `/usr/bin:/bin:/usr/sbin:/sbin`，所以启动时起一次登录 shell 取回 PATH，再补上 `~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`。`$LCR_HOME/bin`、`$LCR_HOME/bin/git/cmd`（向导装的 lark-cli、Windows 便携 git）排在最前面。
- **代理 / 证书**：shell 里 export 的 `HTTPS_PROXY` 这些也一起取回来；主进程的 fetch 打开环境变量代理、信任系统证书库（公司 HTTPS 检查的根证书在钥匙串 / Windows 证书库里就行）；`127.0.0.1`、`localhost` 加进 `NO_PROXY`。
- **端口**：8787 被占（比如命令行版也开着）就随便挑一个空闲的。

## 行为

- 只能开一个：再双击一次 = 把已有窗口拉到前面。
- 关窗口 = 收进托盘（mac 菜单栏 / Windows 右下角），服务接着跑，照样监听、自动回。mac 上程序坞图标也一起藏起来，只剩菜单栏那个；从托盘点「打开」再出来。托盘菜单：打开、开机自启、打开日志、检查更新、退出。
- 设置按「连接 → 执行器 → 入口 → 模板」排：飞书、代码仓库（向导那一段嵌进来，点了立刻生效）；Claude Code（API 来源 + 插件 / MCP / skill）、Codex（连接 + MCP / 插件开关）；@我 / @机器人；模板。没有模板在用的执行器灰掉。
- 上手向导的检查项跟设置是同一份状态（`/api/setup/status`）：设置里不再单独有「上手向导」一页，每页顶上列自己还没弄好的（缺工具、没填令牌、判定没处打……，带按钮直接修），导航上标红点。顶栏「上手向导」按钮还在，一步步走一遍用。
- API 来源（网关 / Claude 订阅，按顺序、出问题自动换）在 Claude Code 页里加、改 key、填每一档的模型名，跟模板一起点「保存」。飞书配好了也能「换一个飞书应用」「重新扫码 · 换账号」（换账号立刻生效，换应用要重新扫码）。桌面版的 claude 配置是隔离的，用订阅得在终端跑 `claude setup-token`，把令牌贴进去。
- Codex 页只开关 MCP / 插件，默认模型只显示不改：那是你本机 Codex 的配置，改了终端里的 codex 也跟着变。要换模型在模板里单独选。
- 没配完进向导（`/setup`），配完了进主界面。页面里的外链用系统浏览器打开。
- 模板、试跑里的「项目」：点开第一项是「在 Finder 里选文件夹…」（Windows 是系统的选目录框），选过的记进「用过的」，× 掉只是不列了、不删文件。一个都没选过时点一下直接弹框。命令行版在 mac 上也能弹（osascript），别的平台粘贴路径。
- mac 没有系统标题栏：红绿灯嵌在页面顶栏里，拖顶栏挪窗口。

## 已知限制

- **没签名**。mac 包是 ad-hoc 签名：从网上下载后第一次打开会被拦，要在「系统设置 → 隐私与安全性」里点「仍要打开」（或 `xattr -cr /Applications/lark-cc-router.app`）。Windows 会弹 SmartScreen，点「更多信息 → 仍要运行」。
- **mac 开机自启会弹窗口**：macOS 13 以后认不出是不是开机起的。Windows 开机起的时候不弹，只在托盘。
- **系统代理（PAC / 系统设置里配的代理）不认**，只认环境变量里的；claude、lark-cli 子进程同理。
- Windows 包只在 mac 上交叉打过，没在 Windows 真机上跑过。
