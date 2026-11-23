# 开发

```bash
npm run dev     # 改代码自动重启（node --watch）
npm test        # node --test src/*.test.ts，无框架
```

Node 24 直接跑 `.ts`（类型擦除），没有构建步骤。`src/page.html` 是 web UI 的全部前端，改完刷新页面就行，不用重启。

## 测试

`pipeline.ts` 的所有对外副作用都收在 `Deps` 里（跑 CC、发 / 改 / 撤卡片、判定、下图、读话题……），测试传假的进去，不碰飞书也不起 claude。`card.ts`、`config.ts`、`judge.ts`、`health.ts` 的逻辑都是纯函数，直接测。

## 调 UI 不用等人 @你

```bash
node tools/preview.mjs
```

拿真页面 + 一份假数据生成一个静态预览页，打印出路径直接打开。走的是真页面的真渲染代码，只把 SSE 和 fetch 换成假的，所以看到的和真机一致。深色版一并生成。

URL 后面带这些可以直接切到对应状态：

| hash | 状态 |
|---|---|
| `#card` | 卡片页签 |
| `#cfg` | 设置 · 模板 |
| `#cfg-general` | 设置 · 通用 |
| `#cfg-adv` | 设置 · 高级展开 |
| `#chat` | 选中一个会话 |
| `#run` | 试跑弹窗 |
| `#empty` | 空状态 |

截图的命令写在 `tools/preview.mjs` 的开头注释里（headless Chrome）。

## 已知的坑

**`page.html` 的 CSS 别用通用单词当裸类名**。`.top` / `.live` / `.at` 这种既是基础类又会被写成修饰类的名字，撞上就是整块布局静默走样。已经踩过三次：`.fld.top` 吃到顶栏的 `height:48px`；`.trace.live` 吃到 `display:flex`；空状态的 `@我` 被 `.at` 的绝对定位甩出屏幕。现在顶栏叫 `.topbar`、连接灯叫 `.conn`，修饰类一律带块名前缀。

**飞书的 `--start` 只吃带本地时区偏移的 ISO 8601**。Unix 时间戳会被拒（field validation failed），`toISOString()` 出来的 `...Z` 带毫秒也会被拒。见 `lark.ts` 的 `iso()`。

**`lark-cli auth status` 的返回里没有 `ok` 字段**，所以判失败只能判 `ok === false`，不能判 `!ok`。

**`lark-cli` 默认会做表情回复富化**，要 `im:message.reactions:read`。只要 `create_time` 的地方都加了 `--no-reactions`，不然别人少授一个 scope，web UI 的「最近消息」时间会静默空掉。**例外：`+messages-search` 加了 `--no-reactions` 也要这个 scope**，所以它在 `NEED` 里。

**`+chat-list` 不加 `--types p2p,group` 就只有群**，单聊永远进不了白名单。

**卡片内容必须转义**，见 [card.md](card.md#markdown-转义)。

**claude 的 `result` 可能是空串**（最后一步是工具调用），收尾时要用正文块兜底：用 `||` 不用 `??`。

**claude 起不来（ENOENT）时 `error` 和 `close` 都会来**，只收一次尾，不然时间线上会出现两个「结束」。

## web UI 的一些行为

- 群列表先出名字（一次 CLI 调用）；「最近消息」时间再异步补：前 24 个会话各查一次（约 5 秒），之后缓存 5 分钟。所以排在 24 名之后的会话不显示时间。
- 群头像是飞书 CDN 的公开 URL，加载失败退回首字色块。单聊的条目不带 `avatar`，只能用色块（要真头像得再申请 `contact:user:search`）。
- 作业只留在内存里，最多 50 个，每个最多 400 条事件（`bus.ts`）。重启后历史作业只剩库里的状态、答案和 session。
- 项目候选扫 `~` 下的 `IdeaProjects`、`AI`、`CProjects` 等几个目录；模型候选是别名 + `~/.claude/settings.json` 里映射的模型名。

## 下一步

- **追问能不能不 @**：现在还得 @ 才算（跟别处一个规矩），但「已经在这个话题里了」「引用的就是那张卡片」本身就够明确了，或许可以免掉。
- **私聊要不要永远续最近一次 session**：现在私聊里不引用直接 @ 是新会话，看实际用起来别扭不别扭。
