# 桌面版规划

目标：产品同学（被 @ 的人）双击装好，点点点完成全部配置，之后别人在飞书里 @他，本机 CC 以他的名义回。mac + Windows。

只做 **@我**。@机器人 不进桌面版：同一个飞书应用多台机器连长连接会抢消息，而且它是谁都能私聊的全权限 CC。

## 架构

```
Electron 主进程 (desktop/main.js)
 ├─ 设 LCR_HOME = 应用数据目录，修 PATH，挑端口
 ├─ start({ strict: false })  ← src/app.ts：现有服务原样跑（轮询、web、作业）
 ├─ BrowserWindow → http://127.0.0.1:<port>/setup（没就绪）或 /（就绪）
 └─ 托盘、单实例、开机自启
```

已验证：Electron 45（Node 24.22）主进程能直接 import `src/*.ts`，`node:sqlite` 可用，不需要构建步骤。

**配置隔离**：桌面版在 import `src/` 之前设好三个环境变量，lark-cli 和 claude 的配置都落在应用数据目录里，跟命令行版、用户自己平时用的 Claude Code（`~/.lark-cli`、`~/.claude`）分开，不会搞混：

| 变量 | 值 |
|---|---|
| `LCR_HOME` | 应用数据目录（`app.getPath('userData')`，开发态、打包后同一个）；显式设了就听它的 |
| `LARKSUITE_CLI_CONFIG_DIR` | `~/.lark-cc-router/lark-cli`（显式设了 `LCR_HOME` 时是 `$LCR_HOME/lark-cli`）。不放应用数据目录：@机器人 长连接的 `events/<应用>/bus.sock` 路径在 macOS 上超过 103 字符就起不来，Application Support 下正好 104 |
| `CLAUDE_CONFIG_DIR` | `$LCR_HOME/claude` |

子进程默认继承 `process.env`，所以 claude、lark-cli 自然吃到。**自己另开终端窗口跑命令时（Windows 的 MCP 授权）要把这两个变量带过去**。代码里要读 claude 配置目录的地方用 `bins.ts` 的 `claudeDir()`，不要写死 `~/.claude`。

配过的东西都存在这些目录里，重启、升级都在。启动时开哪页看 `/api/setup/status` 的 `todo`（有明确缺的 / 报错的才进向导），不看 `ready`：网关、MCP 每次启动都要在后台重测几秒，测完之前不算 ok。

同一份数据目录同时只能跑一个（`state/run.pid` 锁，见 `app.ts` 的 `lock()`），防止同一条 @ 被回两遍。

## 已经做好的底座（别的模块直接用，不要改）

| 文件 | 给什么 |
|---|---|
| `src/config.ts` | `HOME_DIR`：数据目录（`LCR_HOME`，默认仓库目录）。config.json、state/ 都在它下面 |
| `src/bins.ts` | `bin('claude' \| 'lark-cli' \| 'git')`：找可执行文件（`LCR_*` 环境变量 → `HOME_DIR/bin` → `~/.local/bin` → PATH）。`killTree(child)`：Windows 上连子进程一起杀。`WIN`、`BIN_DIR` |
| `src/app.ts` | `start({ strict })` → `{ cfg, port, stop() }`。非 strict 时没扫码也照样起 web，就绪后下一轮自动开始轮询。`NEED`：@我 必需的两个 scope |
| `src/setup/types.ts` | 向导契约：`Section` / `Check` / `Handler` / `progress()` |
| `src/setup/index.ts` | 汇总各模块：`GET /api/setup/status`、`GET /api/setup/preset`，按 `'POST /api/setup/xxx'` 分发路由 |
| `src/setup/preset.ts` + `desktop/preset.json` | 向导预置。公开包中的飞书应用、网关和推荐工作区由用户配置（见 [desktop.md](desktop.md#发版)） |
| `src/setup/git.ts` | GitLab token 按 host 存（`HOME_DIR/git-credentials.json`，0600）。`gitEnv()`：给 git 子进程的环境变量，有 token 的 host 自动把 SSH 地址改写成 HTTPS 并带上认证头 |

所有起子进程的地方：`spawn(bin(...), args, { windowsHide: true })`，Windows 上不加 `windowsHide` 会弹黑框。

## 向导接口

通用规则：

- 请求体是 JSON，必须带 `Content-Type: application/json`（web.ts 会拦）。GET 的参数走 query。
- 抛错 → `500 { error }`。业务失败（比如网关不通）→ `200 { ok: false, error }`。
- 慢操作（下载、clone、装插件）立即返回 `{ started: true }`，过程推到 SSE `/api/events`：`{ type: 'setup', section, msg, done?, ok? }`，`done: true` 表示结束。
- `sections()` 要快（几百毫秒内），慢的检测（`claude mcp list`）后台跑、结果缓存，没出结果时 check 的 `state` 是 `running`。

段的顺序固定：`tools → model → lark → workspace → plugin`。

### tools（`src/setup/tools.ts`）

段 `tools`：三个 check：`lark-cli`、`claude`、`git`，`detail` 是版本号。缺的带 `action: { label: '安装', route: '/api/setup/tools/install', body: { tool } }`。

| 接口 | 请求 | 返回 |
|---|---|---|
| `POST /api/setup/tools/install` | `{ tool: 'lark-cli' \| 'claude' \| 'git' }` | `{ started: true }` |

### model / lark / plugin（`src/setup/auth.ts`）

段 `model`：一个 check `gateway`。段 `lark`：`app`（应用配好没）、`login`（用户登录 + 两个必需 scope）。段 `plugin`：每个预置插件一个 `plugin:<name>`，每个 MCP 一个 `mcp:<server 名>`（没授权的带「授权」action）。

| 接口 | 请求 | 返回 |
|---|---|---|
| `GET /api/setup/model` | — | `{ baseUrl, model, hasToken }` |
| `POST /api/setup/model` | `{ baseUrl, token?, model }`（token 不传 = 沿用已存的） | 先真调一次，通了才存：`{ ok: true, detail }` / `{ ok: false, error }` |
| `POST /api/setup/lark/app` | `{ appId?, appSecret? }`（空 = 用 preset） | `{ ok, error? }` |
| `POST /api/setup/lark/login` | `{}` | `{ url, qr, expiresIn }`，`qr` 是 `data:image/png;base64,...`。扫完的结果走 SSE（section `lark`，`done`） |
| `POST /api/setup/plugin/install` | `{ plugin }`（preset 里的 `plugin` 字段） | `{ started: true }` |
| `POST /api/setup/mcp/login` | `{ name }` | mac：`{ opened: true, url }`，后台用伪终端（系统自带 `script`）跑 `claude mcp login --no-browser`，抠出授权链接替用户打开浏览器；它自己在本机收回调，进程退出就重查状态、推 SSE（section `plugin`，`done`）。Windows：`{ opened: true, terminal: true }`，弹终端窗口跑，之后每 5 秒查一次直到连上。没有 TTY 它会拒绝，所以 mac 要伪终端 |
| `POST /api/setup/mcp/refresh` | `{}` | `{ started: true }`：重跑 `claude mcp list` |

#### 设置页「Claude Code」：之后的日常管理

向导只管第一次装好。MCP 授权过期、加别的插件 / skill 在 设置 → Claude Code 里做，立刻生效（每个作业起的是新的 claude 进程）。都是包 `claude plugin …` / `claude mcp …`，作用在这套 CC 的配置目录上（桌面版是独立那份）。插件的 `mcpServers` 里可能带 token 请求头，只在服务端用，不下发。

| 路由 | 入参 | 返回 |
|---|---|---|
| `GET /api/setup/cc` | `?fresh=1` 顺手后台重扫；第一次调也会扫 | `{ scanning, error, configDir, plugins: [{ id, name, marketplace, version, enabled, preset, busy, mcp, skills }], marketplaces: [{ name, url, preset, busy }], mcp: [{ name, label, plugin?, status?, state, loggingIn }], skills: [{ name, description, plugin?, personal }], needsAuth }` |
| `GET /api/setup/cc/available` | `?q=` | `{ plugins: [{ id, name, description, marketplace, version }] }`：已加的市场里能装的，最多 50 条；自己加的市场排前面 |
| `POST /api/setup/cc/plugin` | `{ action: install \| uninstall \| update \| enable \| disable, plugin: 'name@marketplace' }` | `{ started: true }`，过程和结果走 SSE（section `plugin`） |
| `POST /api/setup/cc/marketplace` | `{ action: 'add', source }` / `{ action: 'remove' \| 'update', name }` | `{ started: true }` |
| `POST /api/setup/cc/skill` | `{ action: 'add', path }` / `{ action: 'remove', name }` | `{ ok, name? }`：把带 `SKILL.md` 的文件夹拷进 `<配置目录>/skills/<名字>`；只删这里面的 |
| `POST /api/setup/mcp/logout` | `{ name }` | `{ ok, error? }` |

`mcp/login`、`mcp/logout` 只认 `claude mcp list` 里有的名字；插件名、市场名只放 `\w.-`，市场地址不能 `-` 开头 —— 都要当参数交给 claude。

### workspace（`src/setup/workspace.ts`）

通用的代码库管理，不绑死某个仓库。工作区 = 一个目录，CC 在里面跑。默认放在 `HOME_DIR/workspaces/<name>`，也能登记已有目录。两种来源：

- **clone 一个仓库**（比如一个把各服务当子模块的工作区仓库）：clone 后初始化子模块，没权限的子模块跳过不中断。
- **新建空工作区**，再往 `repos/` 里一个个加仓库。

段 `workspace`：`git-token:<host>`（每个 preset host 一个，带填写入口，optional）；每个工作区一个 `ws:<name>`；`in-use`：默认模板的 project 指向了某个工作区。

| 接口 | 请求 | 返回 |
|---|---|---|
| `GET /api/setup/workspace/list` | — | `{ root, workspaces: [{ name, path, inUse, repos: [{ name, path, url, state: 'ok' \| 'missing' \| 'stale' \| 'error', date?, error? }] }] }` |
| `POST /api/setup/workspace/git-token` | `{ host, token }` | `{ ok, error? }`（存之前 `git ls-remote` 验一下） |
| `POST /api/setup/workspace/clone` | `{ url, name? }` | `{ started: true }` |
| `POST /api/setup/workspace/create` | `{ name }` | `{ ok: true, path }` |
| `POST /api/setup/workspace/add-existing` | `{ path, name? }` | `{ ok: true }` |
| `POST /api/setup/workspace/add-repo` | `{ workspace, url, name? }` | `{ started: true }` |
| `POST /api/setup/workspace/update` | `{ workspace }` | `{ started: true }`：每个仓库切到默认分支最新（线上代码），失败的保留旧版本标 `stale` |
| `POST /api/setup/workspace/remove-repo` | `{ workspace, repo }` | `{ ok: true }` |
| `POST /api/setup/workspace/use` | `{ workspace }` | `{ ok: true }`：把默认模板的 `project` 指过去 |

clone / create / add-existing 完成时，默认模板还没项目（或者指的目录没了）就自动指过去，不用再点「用」。

设置页、试跑的项目选择器用：`GET /api/projects` → `{ workspaces: [{ name, path, managed }], canPick, home }`；`POST /api/pick-folder` → `{ path | null }`（弹系统选目录框：桌面版是主进程通过 `web.ts` 的 `setPickFolder` 塞进来的 Electron dialog，命令行版在 mac 上用 osascript 弹 Finder 的，别的平台没有、只能粘贴路径）。选过的目录登记成工作区，`POST /api/setup/workspace/forget` 把它从列表里去掉（不删文件；`managed` = workspaces/ 下向导拉的，不让去掉）。

## 分工

每个人只改自己的文件。要动别人的文件，在汇报里说，不要自己改。

| 负责 | 文件 |
|---|---|
| 底座（已完成） | `src/app.ts` `src/bins.ts` `src/index.ts` `src/web.ts` `src/bus.ts` `src/setup/{types,index,preset,git}.ts` `desktop/preset.json` |
| 桌面壳 | `desktop/` 下除 `preset.json` 外的一切、根 `package.json`、`doc/desktop.md` |
| 工具安装 | `src/setup/tools.ts` + 测试；可以给 `src/bins.ts` 的候选目录加路径 |
| 授权与插件 | `src/setup/auth.ts` + 测试；可以改 `src/config.ts`（让 `saveConfig` 能存 `gateway`） |
| 工作区 | `src/setup/workspace.ts` + 测试 |
| 向导前端 | `src/setup.html`；`src/page.html` 只加一个进向导的入口 |

## 验收

- `npm test` 全过；每个模块至少一个能跑的测试覆盖它最容易错的逻辑（解析、路径、改写）。
- 命令行 `npm start` 行为不变。
- mac 上打出来的 `.app` 能启动、能打开向导；Windows 包能打出来（真机验证另说，汇报里写清哪些没在 Windows 上跑过）。
- 不在本机真实环境里做破坏性操作：不重装已有的 claude / lark-cli，不动 `~/.claude`，不碰仓库里的 `config.json` 和 `state/`。测试用临时 `LCR_HOME`。
