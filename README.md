# lark-cc-router

在飞书里有人找你 → 本机的 Claude Code 去翻代码、查日志 → 答案以一张**流式卡片**回在那条消息下面。

两个入口，可以都开，也可以只开一个：

| | **@我** | **@机器人** |
|---|---|---|
| 触发 | 群里或私聊里有人 @你本人 | 群里 @机器人，或私聊机器人 |
| 谁回 | **你本人**（卡片显示成你发的） | 机器人 |
| 多快 | 分钟级（要等飞书搜索索引，约 2 分钟） | 秒级（长连接推送） |
| 卡片 | 每 1.2 秒整张刷新一次 | 打字机效果的流式卡片 |
| 默认 | 开 | 关 |

排查用的是同一套 CC、同一份模板库。使用示例见 [doc/examples.md](doc/examples.md)，原理见 [doc/](doc/)。

**适合**：值班被 @ 问线上问题，查了什么、结论是什么，群里所有人都看得见；同事问某个项目的实现细节；你不在电脑前，问题也不急。

**不是**：

- **不是聊天机器人**：模板开了「先判定」的话，闲聊、通知、MR 卡片直接跳过，群里什么都不留；只有你本人能回答的事会私聊转给你。
- **不是对所有群开放的全权限 CC**：只有开了「自动回」的会话才响应，权限按模板配（可以只读）。
- **@我 这条路不是秒回**：分钟级。要秒回就用 @机器人。

## 快速开始

```bash
# 0. 前置：Node ≥ 24、已登录可用的 claude、已装好的 lark-cli
node -v && claude --version && lark-cli doctor

# 1. 装依赖（只有一个 marked）
npm i

# 2. 建飞书应用、开权限：见下一节「飞书应用与权限」

# 3. 以你本人身份授权（会弹出二维码，扫一下）
lark-cli auth login --scope "search:message im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user im:message:readonly im:message.send_as_user im:message im:chat:read im:message.reactions:read"

# 4. 配置
cp config.example.json config.json
# 把模板里的 project 改成你要查的项目（「我」是谁不用填：启动时取 lark-cli 登录的用户）

# 5. 启动
npm start
```

打开 **http://127.0.0.1:8787**，在左边点一个会话，在它顶部打开「自动回」。**没打开就不会响应**。`config.json` 里没有必填项，但模板没配 `project` 的会话会直接跳过。

**确认它在工作**：在开了自动回的群里 @自己 问一句真问题（要用 `SELF=1 npm start` 启动，否则你自己发的消息会被忽略），大约 2 分钟后，卡片会出现在那条消息的话题里。不想在群里刷屏的话，用 web UI 的「试跑」：卡片以你的身份发给你自己（不进群），飞书这条路不通会当场报出来；不写去重记录。

## 飞书应用与权限

### 两层授权，缺一层都不行

| 层 | 在哪开 | 说明 |
|---|---|---|
| **应用级 scope** | 飞书开放平台 → 你的应用 → 权限管理 | 开通后要**创建版本并发布**才生效 |
| **用户级授权** | 你的电脑上 | `lark-cli auth login` 扫码，用你本人身份授权 |

只在后台开了、没跑 `auth login`：`auth status` 里的 scope 是空的，启动预检直接退出。
跑了 `auth login`、后台没开：授权页会报错，错误信息里带后台链接。

### 建应用

1. 在开放平台建一个**企业自建应用**，或者让 CLI 建：
   ```bash
   lark-cli config init --new        # 浏览器里走一遍，自动建应用并绑定
   # 已经有应用：lark-cli config init --app-id cli_xxx --app-secret-stdin
   ```
2. 导入下面的权限 JSON，**发布版本**。
3. **可用范围**要包含你自己，否则 `auth login` 授权不了。
4. 只用 @我 的话，机器人**不用进群**：全程用你本人的身份，卡片以你的名义发出。

### @我 需要的权限（user scope）

开放平台 → 权限管理 → **批量导入权限**：

```json
{
  "scopes": {
    "tenant": [],
    "user": [
      "search:message",
      "im:message.group_msg:get_as_user",
      "im:message.p2p_msg:get_as_user",
      "im:message:readonly",
      "im:message.send_as_user",
      "im:message",
      "im:chat:read",
      "im:message.reactions:read"
    ]
  }
}
```

`tenant` 故意留空：@我 这条路全程用你本人的身份（`--as user`），不需要任何 bot 权限。

| scope | 用在哪 | 缺了会怎样 |
|---|---|---|
| `search:message` | 搜索 @我 的消息，**收消息的唯一入口** | 什么都搜不到，群里永远没反应 |
| `im:message.group_msg:get_as_user` | 以你的身份读群消息、读话题上下文 | **启动时直接退出** |
| `im:message.send_as_user` | 以你的身份发卡片、私聊提醒你 | **启动时直接退出** |
| `im:message` | 发消息，原地更新卡片，撤回卡片 | 卡片发不出去，或者停在第一帧不动 |
| `im:message:readonly` | 读消息正文、查卡片落在哪个话题 | 能搜到消息，但拿不到正文 |
| `im:chat:read` | 读群列表和群名（web UI 左栏） | web UI 里看不到会话 |
| `im:message.p2p_msg:get_as_user` | 以你的身份读私聊 | 私聊的 @ 读不到（只用群聊的话可以不开） |
| `im:message.reactions:read` | 搜索接口要它（带了 `--no-reactions` 也要） | 跟缺 `search:message` 一样：什么都搜不到 |

启动时检查四个：`group_msg:get_as_user`、`send_as_user`、`search:message`、`reactions:read`，缺了不会开始搜，日志里写着缺哪个。其它缺了只影响对应功能。

> 这是**最小集**。飞书对同一个能力常常允许几个 scope 任选一个（比如更新卡片用 `im:message:update` 或 `im:message` 都行），这里只列了 JSON 里那一个。

### @机器人 额外需要的

| 要什么 | 在哪开 | 用在哪 |
|---|---|---|
| **tenant scope**：`im:message.group_at_msg:readonly` `im:message.p2p_msg:readonly` `im:message:send_as_bot` `im:message:update` `im:message:recall` `im:message:readonly` `im:resource` `cardkit:card:write` | 权限管理（tenant 那一栏），然后发布版本 | 接收群里 @它 和私聊它的消息；发、改、撤卡片；读发送人名字；下载截图；流式卡片（没有 `cardkit:card:write` 就退回普通卡片） |
| **机器人能力** | 应用能力 → 机器人 | 启动时读机器人身份（`bot/v3/info`） |
| **事件** `im.message.receive_v1`，订阅方式选**长连接** | 事件与回调 → 事件配置 | 接收消息 |
| 把机器人拉进群 | 群设置 | 群里才能 @它 |

**不要开** `im:message.group_msg`（接收群里全部消息）：开了以后每句群聊都会推过来。代码会把没 @它 的消息过滤掉，但没必要让飞书推。

**最好也做一次上面的 `auth login`**：机器人读话题上下文、私聊通知你，都是以**你本人**身份做的（原因见 [doc/intake.md](doc/intake.md#话题上下文)）。没授权也能跑，只是在话题里 @它 时它只能看到那一句。

检查是否就绪：`lark-cli event consume im.message.receive_v1 --as bot --dry-run`，`status` 是 `ready` 就行。

机器人背后是能执行命令的 CC，公司里谁都能私聊它，所以**默认是关的**。打开之前，先把它的默认模板设成只读（设置 → 通用里，不是只读会标黄）。只想在某个群里用的话：关掉它的「所有私聊」「所有群」，然后在那个群的会话顶部打开「@机器人 自动回」。

## 配置

`config.json` 不进仓库（里面有本地路径，可能还有网关 token）。「我」是谁不用配：启动时取 `lark-cli` 当前登录的用户，换人就重新 `auth login`。绝大多数配置都能在 web UI 上改，保存后立即生效，不用重启。

```jsonc
{
  // ---- 服务级 ----
  "port": 8787,
  "pollMs": 60000,                   // @我 多久搜一轮。索引延迟本来就有分钟级，调得比 60 秒还小没意义
  "maxJobs": 3,                      // 同时最多跑几个 CC（两个入口共用）
  "stateDir": "state",
  "judgeModel": "claude-haiku-4-5",  // 「先判定」用的模型
  "gateway": { "baseUrl": "…", "token": "…" },  // 可选：默认网关，模板没单独配网关时用它

  // ---- 模板：一个模板 = 一套「在哪查、怎么回」，两个入口共用 ----
  "templates": {
    "排障": {
      "project": "~/code/my-service",            // 在哪个仓库里跑 claude
      "model": "opus",                            // claude --model；不填就用 claude 自己的默认
      "permissionMode": "plan",                   // plan = 只读；auto = 自动（默认）；bypassPermissions = 全放开
      "prompt": "只回答本项目相关的问题。",        // 系统提示词。留空 = 不加任何系统提示词
      "judge": "你在帮我筛飞书里 @我 的消息…",     // 填了就先判定要不要回；不填 = 每条都回
      "gateway": { "baseUrl": "http://gw.example.com", "token": "…" },  // 不填走顶层 gateway，再没有就用 ~/.claude/settings.json
      "claudeSettings": { "env": { "ANTHROPIC_MODEL": "xxx" } },        // 叠加给 claude --settings
      "claudeArgs": ["--max-turns", "30"],
      "self": false                               // 是否也处理你自己发的消息（自测用）
    }
  },

  // ---- 入口：各管各的开关和会话绑定 ----
  "user": { "on": true,  "defaultTemplate": "排障", "chats": { "oc_aaa": "", "oc_bbb": "排障" }, "allP2p": false, "allGroups": false },
  "bot":  { "on": false, "defaultTemplate": "排障", "chats": {},                                 "allP2p": true,  "allGroups": true }
}
```

- `chats`：会话 id → 用哪个模板（空字符串 = 默认模板）。**出现在这里就算开了自动回**。
- `allP2p` / `allGroups`：整类放开，开了就不看 `chats` 白名单，`chats` 只用来决定用哪个模板。
- 老格式的 `config.json` 加载时会自动迁移，下次保存时会把老字段从文件里清掉。

各字段为什么这么分、网关和 settings 怎么叠加，见 [doc/config.md](doc/config.md)。

## Web UI

**http://127.0.0.1:8787**。只监听本机回环，因为这是全权限 CC 的操作台。要远程访问就自己 `ssh -L`。

- **左栏 · 会话**：你所在的所有群和私聊。开了自动回的正常显示，没开的是灰色；有作业在跑的会话有脉动点，有失败的会显示红色数字。按 `/` 搜索。顶部的「全部作业」是全局视图，机器人私聊里的作业也在那里。
- **中栏 · 这个会话**：每个入口一行「自动回」开关 + 用哪个模板（改了立即生效）。下面显示实际生效的项目、权限、模型、是否先判定，再下面是作业列表。
- **右栏 · 详情**：
  - **事件流**：这次排查的完整时间线，包括思考、工具调用及入参、工具返回、正文。底部有 session id（点击复制）、「接着问」「终止」。
  - **卡片**：这次排查在飞书里长什么样，用的是真实的卡片渲染代码。
  - 标题旁边的标签说明**群里到底发没发东西**：`话题已建` / `还没建话题 · 在看要不要回` / `没建话题 · 判断不用回`。判定的理由也写在作业旁边。
- **再跑一次**：群里 / 私聊来的作业，回到**原会话**、用原来的身份（@我 是你本人，@机器人 是机器人）重新回一次，不再判定。跑断了、重启打断了都用它。想改了问题私下试，点旁边的「试跑」。
- **飞书卡片发成功才算完成**：CC 跑完了、但卡片没发出去或者收尾那帧没改上，作业显示「没发出去」，标题旁的标签写明是没发出还是没改上（悬停看原因）。这时同一个按钮变成「重发到飞书」：不重跑，把结论重新发一张卡片到原会话（试跑的发给你自己）。
- **停服务**：按一次 Ctrl+C，在跑的作业（包括试跑）卡片都会收成「已中断」再退出。没来得及收尾的（关窗口、连按两下、被 kill），下次启动时补上。
- **试跑**：写一句话，选一个会话（决定用哪个模板），真跑一次 CC。卡片发给你自己、不进群，发不出去或改不上会算这次试跑失败；不写去重记录（CC 环境有变化时仍会私聊提醒你）。有「只看判定」，改判定提示词时不用真跑 CC。
- **设置**：左边是「通用」和模板列表，右边编辑，⌘S 保存。新建的模板默认只读。

作业的逐条事件只存在内存里（最多 50 条），重启后就没了。session id 写在磁盘上，所以历史作业的「接着问」重启后照样能用。完整记录在 `~/.claude/projects/*/*.jsonl`。

## 在飞书里怎么用

- **新问题**：在群里直接 @你（或 @机器人）。各跑各的，互不影响。
- **追问**：群里，在那张卡片的**话题里**再 @一次；私聊里，**引用那张卡片**再 @一次。会接着上次的 CC session 问，不用从头查。
- **追问进来时上一次还在跑**：会把它掐掉，接着往下问。被掐的那张卡片显示「⚠️ 已中断」。上一次还在排队、没开跑的不掐，追问排在它后面。
- **在话题里 @**：话题里之前的讨论（含截图）会一起带给 CC，只 @一句「看下」也行。
- **截图**：消息里的图会被下载下来给 CC 看。
- **叫停**：模板开了判定的话，说「别查了」「停止处理」会掐掉正在跑的。web UI 上也能点「终止」。
- **@我 的私聊也要 @**：不 @ 的私聊不处理，不然你跟人正常聊天的每句话都会被它以你的名义接过去。@机器人 的私聊不用 @。
- **同一条消息同时 @了你和机器人**：只有机器人回。目前只要机器人入口开着，@我 就会让路，不看这个会话有没有开 @机器人；没开的话两边都不回。

## 运行

```bash
npm start              # 启动
npm run dev            # 改代码自动重启
npm test               # 单测（node --test，无框架）
SELF=1 npm start       # 也处理你自己发的消息（自测用）
PORT=8888 npm start    # 换端口
```

**Ctrl+C** 会把在跑的作业收尾（群里的卡片变成「⚠️ 已中断」）再退出，最多等 10 秒。再按一次立刻退出。

`state/` 是运行时状态：`history.db`（@我）和 `bot.db`（@机器人）。删掉它会丢掉去重记录和追问用的 session 映射，启动后从「现在」开始，不会回放历史。

### 常见问题

| 现象 | 原因 / 怎么办 |
|---|---|
| 启动就退出，日志 `缺 scope` | 按日志里给的命令重新 `lark-cli auth login` |
| `EADDRINUSE` | 上一个进程还占着端口：`lsof -ti:8787 \| xargs kill` |
| @了没反应 | 会话没开自动回？发的是自己的消息却没开 `SELF=1`？等够 2 分钟了吗？再看作业列表里有没有「判断不用回」 |
| 日志 `模板「X」没配项目` | 给那个模板填 `project` |
| 私聊收到「CC 环境有变化」 | 某个 MCP 掉线、授权过期或 plugin 被关了。claude 不会报错，只是少了那批工具，所以由它来提醒你 |
| 机器人不回 | 日志里有 `@机器人 没起来` 就是应用没开机器人能力；再用上面的 `--dry-run` 检查事件订阅 |
| 换了网关后 claude 报模型不存在 | `~/.claude/settings.json` 里的 `ANTHROPIC_MODEL` 等变量在新网关上不认，在模板的 Claude Code settings 或「模型」里改掉 |

## 文档

| | |
|---|---|
| [doc/architecture.md](doc/architecture.md) | 整体结构：两个入口、一次排查的生命周期、模块和状态 |
| [doc/intake.md](doc/intake.md) | 消息怎么进来：搜索轮询、长连接、哪些会话回、话题上下文、截图 |
| [doc/judge.md](doc/judge.md) | 先判定要不要回 |
| [doc/card.md](doc/card.md) | 卡片：什么时候发、怎么更新、30KB 预算、CardKit 流式 |
| [doc/examples.md](doc/examples.md) | 使用示例：试跑卡片、判定结果 |
| [doc/session.md](doc/session.md) | 追问和 session：锚点、接棒、中断、停机 |
| [doc/config.md](doc/config.md) | 配置为什么分两级，网关和 settings 怎么叠加 |
| [doc/security.md](doc/security.md) | 安全边界：谁能往 CC 里喂字，挡在哪 |
| [doc/development.md](doc/development.md) | 开发：测试、UI 预览、已知的坑、下一步 |
