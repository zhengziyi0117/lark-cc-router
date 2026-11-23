# 整体结构

一个 Node 进程，做三件事：**收消息**（两个入口）、**跑 CC**（`claude -p`）、**把输出流式写进飞书卡片**。旁边挂一个本机的 web UI 用来看和配。

```
               ┌─────────── @我 ───────────┐        ┌────────── @机器人 ──────────┐
 飞书          │ +messages-search --is-at-me│        │ event consume               │
               │ 每 pollMs 搜一轮（user）    │        │ im.message.receive_v1（bot）│
               └─────────────┬──────────────┘        └──────────────┬──────────────┘
                             │ pollGroups                          │ onBotMessage
                             ▼                                     ▼
                     过滤：会话开了自动回？@了我/它？真人发的？
                             │
                             ▼
                    investigate()  ← 两个入口共用，差别都在 mode 上
                     1. db.claim 认领（去重）
                     2. 判定要不要回（judge.ts，可选）
                     3. 找锚点 → 接着哪个 session；同 session 在跑就掐掉接棒
                     4. 排队等名额（Pool，maxJobs）
                     5. 下截图、拼话题上下文
                     6. claude -p --output-format stream-json
                             │ AgentEvent（init/text/thinking/tool/result/done）
                ┌────────────┼─────────────────────┐
                ▼            ▼                     ▼
          CardStream    bus（SSE → web UI）    health（MCP/plugin 变化 → 私聊我）
          / KitStream
                │
                ▼
          飞书卡片：@我 = 整卡 PATCH；@机器人 = CardKit 流式
```

## 一次排查的生命周期

以 @我 为例：

1. **捞到**：一轮搜索拿回最近一段时间所有 @我 的消息（群 + 私聊，含话题回复），滤掉没开自动回的会话、不是真人发的、我自己发的（除非 `self`），以及同时 @了机器人的（让机器人那条路回）。见 [intake.md](intake.md)。
2. **认领**：`INSERT OR IGNORE` 进 `handled` 表，插不进去 = 处理过，直接返回。搜索带重叠窗口，同一条消息每轮都会被捞回来，靠这一步挡掉。
3. **判定**（模板配了 `judge` 才有）：直接调一次模型 API，得到 `answer / skip / ask_me / stop`。不是 `answer` 就到此为止。见 [judge.md](judge.md)。
4. **找 session**：消息带着话题 id 或引用了我的卡片，并且库里记过对应的 session → 这是追问，`--resume` 它。那个 session 正在跑 → 掐掉它、等它收尾、接着问。见 [session.md](session.md)。
5. **排队**：`Pool` 是进程内的并发闸，两个入口共用 `maxJobs` 个名额。
6. **跑 CC**：`claude -p --output-format stream-json --verbose`，cwd 是模板的 `project`，带上模板的权限、模型、系统提示词、`--settings`。stdout 一行一个事件，`agent.ts` 归一化成 `AgentEvent`。
7. **卡片**：@我 先**攒着不发**，等模型动了工具或说了一句不是 `SKIP` 的话才开话题；之后每 1.2 秒整卡 PATCH 一次。@机器人 一收到就发，CardKit 打字机流式更新。见 [card.md](card.md)。
8. **记锚点**：卡片一开出来就把「卡片 message_id → session」和「话题 id → session」写进 `threads` 表，跑着的时候就能被追问。
9. **收尾**：最终帧（`✅ 已完成` / `⚠️ 已中断`），`handled` 表落状态和答案，还名额，叫醒等着接棒的。

web UI 不受第 7 步的影响：作业从第一秒就在列表里，事件全程直播，最后判了不回的也看得到。

## 两个入口的差别

`investigate()` 是同一个函数，差别只有这几处：

| | @我（`mode = 'user'`） | @机器人（`mode = 'bot'`） |
|---|---|---|
| 怎么收 | 搜索轮询，分钟级 | 长连接推送，秒级 |
| 以谁的身份发卡片 | 我（`--as user`） | 机器人（`--as bot`） |
| 卡片什么时候发 | 判明要排查才开话题 | 一收到就发 |
| 卡片怎么更新 | 整卡 PATCH，节流 1.2 秒 | CardKit 流式（打字机） |
| 卡片布局 | 正文在上、完整过程折叠在下 | 按时间顺序：精简的过程在上、结论在下 |
| 默认回哪些会话 | 都不回，逐个开 | 私聊和群都回（群得先有人把它拉进去） |
| 私聊要不要 @ | 要 | 不用 |
| 库 | `state/history.db` | `state/bot.db` |

两边**都以我的身份**做的：读话题上下文（[intake.md](intake.md#话题上下文)）、私聊通知我（判了 `ask_me`、CC 环境变了）。

**库为什么分开**：两边发出去的是两张不同的卡片（不同身份、不同 message_id），「话题 / 卡片 → session」的锚点混在一张表里只会互相认错。分开之后，关掉一边、删掉一边的库都不影响另一边。

## 模块

```
src/index.ts     入口：预检 scope、轮询循环、起 web、按配置起停机器人长连接、Ctrl+C 收尾
src/pipeline.ts  主流程：搜 @我（游标 + 重叠窗口）、机器人消息、investigate、接棒、试跑
src/lark.ts      lark-cli 封装，所有飞书调用都从这里走（execFile 传数组，不经 shell）
src/agent.ts     跑 claude -p，解析 stream-json，吐归一化的 AgentEvent
src/judge.ts     要不要回的判定：默认提示词、直接调模型 API、解析
src/card.ts      卡片 JSON 组装；CardBuilder（事件 → 卡片内容）；CardStream / KitStream（懒开、节流、收尾）
src/config.ts    配置加载、会话 → 模板（resolveChat）、老格式迁移、保存前的校验
src/db.ts        node:sqlite：去重 + 历史、锚点 → session、搜索游标、杂项键值
src/health.ts    CC 环境（MCP / plugin）跟上次比变了什么
src/bus.ts       作业表 + 事件总线，web UI 的实时数据源（纯内存，最多 50 个作业）
src/store.ts     Pool：进程内并发闸，支持热改上限
src/web.ts       web UI 服务端：静态页、SSE、配置读写、试跑、终止、卡片预览
src/page.html    web UI 前端（HTML/CSS/JS 一个文件，无构建）
tools/preview.mjs  拿真页面 + 假数据生成静态预览页，调样式用
```

`Deps`（`pipeline.ts`）把所有对外副作用（跑 CC、发卡片、判定……）收在一个对象里，测试换成假的；`BOT` 是把发卡片那几样换成 `--as bot` 的版本。

## 状态

`state/` 下，两个库结构一样：

| 表 | 内容 |
|---|---|
| `handled` | 处理过的消息：去重的唯一依据，同时是 web UI 的历史（状态、答案、错误、session、判定理由） |
| `threads` | 锚点 → session。锚点是群话题 id，或我发出去的那张卡片的 message_id |
| `meta` | 搜索游标 `cursor`；健康基线 `health:<模板>:<项目>`；话题水位 `seen:<session>` |

启动时会把上次死在半路、还挂在 `running` 的作业改成 `failed / 进程中断`。

另外：

- `state/claude-settings/*.json`：合成给 `claude --settings` 的文件，0600，按内容哈希命名（见 [config.md](config.md#网关和-claude-code-settings)）。
- `/tmp/lark-cc-router/<message_id>/`：下载下来的截图。

## CC 环境监控

每次跑 claude，`init` 事件里带着这次连上了哪些 MCP（及状态）、加载了哪些 plugin。OAuth 过期、plugin 被关的时候 claude **不报错、照常跑**，只是少了那批工具，模型回一句「查不到」，谁也不知道是环境坏了。

所以每次都拿这次的跟上次比（基线按「模板 + 项目」分开存，因为 MCP 配置跟项目的 `.mcp.json` 走），变了就打日志并**以我的身份私聊我自己一条**（不需要额外 scope）：

- 只在**变化**时发：掉线、授权过期、plugin 不见了、恢复了。一直坏着不重复提醒。
- `pending` 不算坏：实测 init 那一刻常有一半 MCP 还在连，纯属赛跑。存基线时 `pending` 的沿用上次已知状态。代价是「一直卡在连接中」这种看不出来。
- plugin 被关时它带的 MCP（`plugin:<名字>:xxx`）一起消失，只报 plugin 那一条。
- 第一次跑没有基线，只报现在坏着的。

web UI 事件流里 init 那一行也会标出没连上的 MCP。

## 依赖

只有一个运行时依赖：`marked`（markdown 渲染，零传递依赖），web UI 通过 `/vendor/marked.js` 直接拿 `node_modules` 里的浏览器构建，所以**没有构建步骤**。其余全是 Node 24 原生：直接跑 `.ts`（类型擦除）、`node:sqlite`、`node:test`。

外部命令：`claude`（Claude Code CLI）和 `lark-cli`（飞书 CLI）。所有飞书调用都走 `lark-cli`，CLI 没封装的接口（更新卡片、CardKit、读消息原始字段）走它的 `api` 子命令。
