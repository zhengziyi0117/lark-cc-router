import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { bin, killTree } from './bins.ts';

const exec = promisify(execFile);

/**
 * 以谁的身份调。**发 / 改 / 撤卡片必须同一个身份**：更新接口只认消息的发送者
 * （实测 230001 not the message's sender）。@我 那条路全程 user，@机器人 那条路全程 bot。
 */
export type As = 'user' | 'bot';

export interface Sender {
  id: string;
  name?: string;
  sender_type?: string;
}

export interface Mention {
  id: string;
  name?: string;
}

export interface Message {
  message_id: string;
  chat_id: string;
  message_position: string;
  content: string;
  create_time?: string;
  msg_type?: string;
  sender: Sender;
  mentions?: Mention[];
  /** `p2p` = 单聊，`group` = 群（搜索结果自带）。单聊回复不带 --reply-in-thread —— 私聊没有话题 */
  chat_type?: string;
  /** 群名 / 私聊对方的名字（搜索结果自带）。私聊提醒我"哪个群里有人找"用 */
  chat_name?: string;
  /** 这条消息挂在哪个话题里。追问靠它把消息找回上次那个 CC session */
  thread_id?: string;
  /**
   * 这条消息**引用**了谁（被引用消息的 message_id）。私聊没有话题，`thread_id` 恒为空，
   * 引用我发的那张卡片是唯一能指回上次会话的线索 —— 见 pipeline 的 anchorOf。
   * 搜索接口会带这个字段，但引用原文**不在 `content` 里**，别指望它。
   */
  reply_to?: string;
  /** 话题里第几条（回复从 0 起，根消息我们记成 -1）。只有话题里的消息带。话题上下文的水位用它 */
  thread_message_position?: string;
  deleted?: boolean;
}

export interface Chat {
  chatId: string;
  name: string;
  /** group = 群，p2p = 单聊。判定规则一样（都要 @我），单聊只是回复时不带 --reply-in-thread */
  mode: 'group' | 'p2p';
  /** 群头像，飞书 CDN 的公开 URL（100x100），直接 <img> 就行。**单聊没有**，只能退回首字色块 */
  avatar?: string;
  description?: string;
  external?: boolean;
  /** 单聊时是对方的 open_id */
  target?: string;
  /** 最后一条消息的时间（"2026-10-10 18:31"），由 chatActivity 事后填 */
  lastAt?: string | null;
}

export class LarkError extends Error {
  readonly missingScopes: string[];
  /** 飞书的错误码（有的话）。流式卡片要认 300309「流式模式已关」 */
  readonly code?: number;
  constructor(message: string, missingScopes: string[] = [], code?: number) {
    super(message);
    this.missingScopes = missingScopes;
    this.code = code;
  }
}

/** 所有飞书调用都走 lark-cli，用 execFile 传数组参数 —— 不经 shell，省掉一整类转义问题 */
async function cli(args: string[]): Promise<any> {
  let stdout: string;
  try {
    ({ stdout } = await exec(bin('lark-cli'), args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }));
  } catch (e: any) {
    throw new LarkError(`lark-cli ${args[0]} ${args[1] ?? ''} 执行失败: ${e.message}`);
  }
  let r: any;
  try {
    r = JSON.parse(stdout);
  } catch {
    throw new LarkError(`lark-cli 返回不是 JSON: ${stdout.slice(0, 200)}`);
  }
  // 注意：auth status 的返回里没有 ok 字段，所以只能判 === false，不能判 !r.ok
  if (r.ok === false) throw new LarkError(r.error?.message ?? 'lark-cli 调用失败', r.error?.missing_scopes ?? [], r.error?.code);
  return r;
}

/**
 * 飞书的 `--start` 只吃 ISO 8601，**Unix 时间戳会被拒**（field validation failed），
 * 而且要是本地时区带偏移那种。`toISOString()` 出来的 `...Z` 带毫秒也会被拒。
 */
export function iso(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const [sign, abs] = off >= 0 ? ['+', off] : ['-', -off];
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

/**
 * 搜"@我"的消息。**不带 `--chat-id`，一次覆盖我在的所有会话**（群 + 单聊）。
 *
 * 这是整个机器人捞消息的入口，它比轮询消息列表强在两点：
 *   1. 返回是**扁平**的 —— 话题里的回复作为独立条目出现，不像 `chat-messages-list`
 *      那样嵌套在父消息的 `thread_replies` 下、还受"最近 50 条"窗口限制
 *   2. `--start` 按**消息自己的**时间过滤，不是按它所属话题根的时间
 *
 * 代价是**索引延迟**（实测约 2 分钟才搜得到），见 pipeline 的 OVERLAP_MS。
 */
export async function searchMentions(since: number): Promise<Message[]> {
  const r = await cli([
    'im', '+messages-search',
    '--query', '',
    '--is-at-me',
    '--as', 'user',
    '--no-reactions',
    '--start', iso(since),
    '--page-all',
  ]);
  return r.data?.messages ?? [];
}

/**
 * 拉某个群/单聊最近的 N 条消息。只给 web UI 显示"这个会话最近有没有人说话"用。
 * `--no-reactions`：默认那套表情回复富化要 `im:message.reactions:read`，而这里只用 `create_time` ——
 * 不关的话别人少授一个 scope，web UI 的"最近消息"时间会静默空掉（chatActivity 吞异常）。
 */
export async function listMessages(chatId: string, pageSize = 50): Promise<Message[]> {
  const r = await cli([
    'im', '+chat-messages-list',
    '--chat-id', chatId,
    '--as', 'user',
    '--order', 'desc',
    '--page-size', String(pageSize),
    '--no-reactions',
  ]);
  return r.data?.messages ?? [];
}

/**
 * 这条消息落在哪个话题里。**只有 mget 返回 thread_id** —— 发消息 / 回消息的接口
 * 只回 message_id，拿不到话题，所以卡片发出去之后要再问一次才知道它进了哪个话题。
 * `--no-reactions` 省掉一次没用的表情回复查询。
 */
export async function threadIdOf(messageId: string, as: As = 'user'): Promise<string | undefined> {
  return (await getMessage(messageId, as))?.thread_id || undefined;
}

/** 按 id 取一条消息（带发送人名字 —— 机器人收到的事件里只有 open_id，卡片上要写是谁问的） */
export async function getMessage(messageId: string, as: As = 'user'): Promise<Message | undefined> {
  const r = await cli(['im', '+messages-mget', '--message-ids', messageId, '--as', as, '--no-reactions']);
  return r.data?.messages?.[0];
}

/**
 * 「再跑一次」用：按 id 把原消息取回来，补上 mget 不给的两样 —— 群还是单聊（单聊回复不开话题），
 * 引用了谁（私聊追问靠它接回上次的 session，见 pipeline 的 anchorOf）
 */
export async function fetchMessage(messageId: string, as: As): Promise<Message | undefined> {
  const m = await getMessage(messageId, as);
  if (!m) return undefined;
  const [chat, raw] = await Promise.all([
    cli(['api', 'GET', `/open-apis/im/v1/chats/${m.chat_id}`, '--as', as]),
    cli(['api', 'GET', `/open-apis/im/v1/messages/${messageId}`, '--as', as]),
  ]);
  return { ...m, chat_type: chat.data?.chat_mode === 'p2p' ? 'p2p' : 'group', reply_to: raw.data?.items?.[0]?.parent_id || undefined };
}

/**
 * 一个话题里的全部消息，按顺序：根消息在前（位置记 -1），后面是回复。
 * `+threads-messages-list` 只给回复、不带根消息；根 id 只有原始接口给（格式化过的 mget / 搜索结果都把 root_id 去掉了）。
 *
 * **用我的身份读**，两个入口都是：机器人读群消息要另外开「获取群组中所有消息」（可能要审批），
 * 而我的 `group_msg:get_as_user` 是 @我 那条路本来就要的。代价是只读得到我在的群。
 */
export async function topicMessages(messageId: string, threadId: string): Promise<Message[]> {
  const [raw, list] = await Promise.all([
    cli(['api', 'GET', `/open-apis/im/v1/messages/${messageId}`, '--as', 'user']),
    cli(['im', '+threads-messages-list', '--thread', threadId, '--as', 'user', '--page-all', '--no-reactions']),
  ]);
  const rootId: string | undefined = raw.data?.items?.[0]?.root_id;
  const root = rootId ? await getMessage(rootId, 'user') : undefined;
  return [...(root ? [{ ...root, thread_message_position: '-1' }] : []), ...(list.data?.messages ?? [])];
}

/** 最后一条消息的时间，只用于 web UI 显示"这个群最近有没有人说话" */
export async function lastMessageAt(chatId: string): Promise<string | null> {
  const msgs = await listMessages(chatId, 1);
  return msgs[0]?.create_time ?? null;
}

/**
 * 我在的会话，**按最近活跃倒序**（--sort active_time）。web UI 的列表就是它。
 * `--types p2p,group` 才带单聊 —— 不加就只有群，单聊永远进不了白名单。
 * 一次调用，快。活跃时间接口不返回，要具体时间看 chatActivity。
 */
export async function listChats(): Promise<Chat[]> {
  const r = await cli([
    'im', '+chat-list', '--as', 'user', '--types', 'p2p,group', '--sort', 'active_time', '--page-size', '100',
  ]);
  return (r.data?.chats ?? []).map((c: any) => ({
    chatId: c.chat_id,
    name: c.name || c.chat_id,
    mode: c.chat_mode === 'p2p' ? 'p2p' : 'group',
    avatar: c.avatar || undefined,
    description: c.description || undefined,
    external: c.external,
    target: c.p2p_target_id || undefined,
    lastAt: null,
  }));
}

/** 每个群的最后一条消息时间。一个群一次 CLI 调用（~1s），所以只问前几个 + 全并发，失败就留空 */
export async function chatActivity(chatIds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    chatIds.map(async (id) => {
      try {
        const t = await lastMessageAt(id);
        if (t) out[id] = t;
      } catch { /* 拿不到就不显示时间，不影响勾选 */ }
    }),
  );
  return out;
}

/**
 * 回一张卡片。**话题回复**：落在那条 @我 的消息的话题里（单聊没有话题，thread 传 false）。
 * 身份必须是**我本人** —— 更新卡片的接口只认「消息的发送者」，实测 bot 改不了 user 发的消息
 * （230001 not the message's sender），反过来也一样。所以发送 / 更新 / 撤回三步必须同一个身份。
 */
export async function replyCard(messageId: string, card: unknown, thread = true, as: As = 'user'): Promise<string> {
  const args = [
    'im', '+messages-reply',
    '--as', as,
    '--message-id', messageId,
    '--msg-type', 'interactive',
    '--content', JSON.stringify(card),
    // 一次调用一个键：lark-cli 自己重试时不会发出两张。不能按消息 id 固定 —— 飞书拿到同一个键直接返回第一次那条消息，
    // 「再跑一次」就拿回了上回的旧卡片、新卡片根本没发（机器人的流式卡片于是一直停在「处理中」）。
    // 同一条消息别回两遍是 db.claim 的事。飞书限 50 字符，UUID 36
    '--idempotency-key', randomUUID(),
  ];
  if (thread) args.push('--reply-in-thread');
  const r = await cli(args);
  return r.data?.message_id;
}

/** 原地更新卡片。CLI 没封装这个接口（更新消息卡片），走 api 逃生口。身份同上，必须是我。 */
export async function updateCard(messageId: string, card: unknown, as: As = 'user'): Promise<void> {
  await cli([
    'api', 'PATCH', `/open-apis/im/v1/messages/${messageId}`,
    '--as', as,
    '--data', JSON.stringify({ content: JSON.stringify(card) }),
  ]);
}

/**
 * 把消息里的一张图下到本地，返回落盘路径（CLI 自己补扩展名，所以以 saved_path 为准）。
 * 消息正文里图片只是个 `![Image](img_xxx)` 占位符，不下下来模型就只能猜。
 * `--output` 只能落在 CLI 的白名单根下（工作目录 / `/tmp` / `~/files`），所以调用方给 /tmp 下的路径。
 */
export async function downloadImage(messageId: string, key: string, out: string, as: As = 'user'): Promise<string> {
  const r = await cli([
    'im', '+messages-resources-download', '--as', as,
    '--message-id', messageId, '--file-key', key, '--type', 'image', '--output', out,
  ]);
  return r.data?.saved_path ?? out;
}

/** 以我的身份给某人发一条纯文本私聊。给自己发 = 通知（MCP 掉线这类），我本人的会话里能看到 */
export async function sendText(userId: string, text: string): Promise<void> {
  await cli(['im', '+messages-send', '--as', 'user', '--user-id', userId, '--text', text]);
}

/** 以我的身份给某人发一张卡片，返回消息 id。试跑发给我自己：发卡片、改卡片这条路真走一遍 */
export async function sendCard(userId: string, card: unknown): Promise<string> {
  const r = await cli(['im', '+messages-send', '--as', 'user', '--user-id', userId, '--msg-type', 'interactive', '--content', JSON.stringify(card)]);
  return r.data?.message_id;
}

/** 撤回自己发的消息（SKIP 时把那张"排查中"的卡片收回去）。身份同上。 */
export async function deleteMessage(messageId: string, as: As = 'user'): Promise<void> {
  await cli(['im', 'messages', 'delete', '--as', as, '--message-id', messageId, '--yes']);
}

/**
 * CardKit（卡片实体 + 流式更新），见 card.ts 的 KitStream。CLI 没封装，走 api 逃生口，**只能机器人身份**。
 * 请求形状实测过：建卡 `{type, data}`；整卡替换 `{card: {type, data}, sequence}`；设置 `{settings: "<JSON 串>", sequence}`。
 */
const KIT = '/open-apis/cardkit/v1/cards';
const cardJson = (card: unknown) => ({ type: 'card_json', data: JSON.stringify(card) });
export const kit = {
  async create(card: unknown): Promise<string> {
    const r = await cli(['api', 'POST', KIT, '--as', 'bot', '--data', JSON.stringify(cardJson(card))]);
    if (!r.data?.card_id) throw new LarkError('CardKit 建卡没返回 card_id');
    return r.data.card_id;
  },
  async text(cardId: string, elementId: string, content: string, sequence: number): Promise<void> {
    await cli(['api', 'PUT', `${KIT}/${cardId}/elements/${elementId}/content`, '--as', 'bot', '--data', JSON.stringify({ content, sequence })]);
  },
  async update(cardId: string, card: unknown, sequence: number): Promise<void> {
    await cli(['api', 'PUT', `${KIT}/${cardId}`, '--as', 'bot', '--data', JSON.stringify({ card: cardJson(card), sequence })]);
  },
  async streaming(cardId: string, on: boolean, sequence: number): Promise<void> {
    const settings = JSON.stringify({ config: { streaming_mode: on } });
    await cli(['api', 'PATCH', `${KIT}/${cardId}/settings`, '--as', 'bot', '--data', JSON.stringify({ settings, sequence })]);
  },
};

export interface Bot {
  name: string;
  /**
   * 认 mentions 用：消息里 @机器人 那一项的 id 实测是 **app_id**（`cli_xxx`），不是它的 open_id
   * —— 两个都放进来，哪种写法都认。
   */
  ids: string[];
}

/** lark-cli 绑的那个应用的机器人。bot/v3/info 不要任何 scope，应用开了机器人能力就行 */
export async function botIdentity(): Promise<Bot> {
  const [info, status] = await Promise.all([
    cli(['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot']),
    cli(['auth', 'status', '--json']),
  ]);
  const ids = [info.data?.open_id, status.appId].filter(Boolean);
  if (ids.length < 2) throw new LarkError('bot/v3/info 或 auth status 没给 id（应用开了机器人能力没有？）');
  return { name: info.data?.app_name || '机器人', ids };
}

/**
 * 长连接收事件：`lark-cli event consume <key> --as bot`，stdout 一行一个 JSON。
 *
 *   - **stdin 要一直开着**：它把 stdin EOF 当成"该退了"（给 AI 子进程调用设计的）
 *   - 挂了就隔一会儿重连，越挂越久（5 秒翻倍到 5 分钟）；连上跑过一分钟算恢复，间隔归位
 *   - 停用 SIGTERM，别 kill -9（会漏掉服务端的订阅清理）
 *
 * 返回停止函数。
 */
export function consume(key: string, onEvent: (e: any) => void, log: (s: string) => void): () => void {
  let child: ChildProcess | null = null;
  let stopped = false;
  let wait = 5_000;
  const start = () => {
    const t0 = Date.now();
    const c = spawn(bin('lark-cli'), ['event', 'consume', key, '--as', 'bot'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    child = c;
    createInterface({ input: c.stdout! }).on('line', (l) => {
      if (!l.trim()) return;
      let e: any;
      try { e = JSON.parse(l); } catch { return log(`[${key}] 不是 JSON: ${l.slice(0, 120)}`); }
      onEvent(e);
    });
    // 只留要紧的：连上 / 断开 / 出错。每条事件那几行不打
    createInterface({ input: c.stderr! }).on('line', (l) => {
      if (/ready|exited|error|fail|blocked|denied|not subscribed|hint/i.test(l)) log(`[${key}] ${l.replace(/^\[\w+\]\s*/, '')}`);
    });
    c.on('error', (e) => log(`[${key}] 起不来: ${e.message}`));
    c.on('exit', (code) => {
      child = null;
      if (stopped) return;
      if (Date.now() - t0 > 60_000) wait = 5_000;
      log(`[${key}] 断了（exit ${code}），${wait / 1000}s 后重连`);
      setTimeout(() => { if (!stopped) start(); }, wait);
      wait = Math.min(wait * 2, 300_000);
    });
  };
  start();
  return () => { stopped = true; if (child) killTree(child); };
}

/**
 * lark-cli 当前以谁的身份登录（open_id）、授了哪些 scope。没以用户身份登录就是空的。
 * open_id 就是"我"：搜 @我、以我的身份发卡片用的都是这个用户，所以不让手填 —— 填错了只会静默地什么都不回。
 */
export async function userAuth(): Promise<{ openId: string; scopes: string[] }> {
  const r = await cli(['auth', 'status', '--json']);
  const u = r.identities?.user;
  return { openId: String(u?.openId ?? ''), scopes: String(u?.scope ?? '').split(/\s+/).filter(Boolean) };
}
