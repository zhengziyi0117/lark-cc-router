import { updateCard } from './lark.ts';
import type { AgentEvent } from './agent.ts';

/**
 * 卡片 JSON 组装 + CardStream（正文 / 排查过程分开累积，节流后原地更新同一条消息）。
 * 发送 / 更新都用我本人的身份，见 lark.ts 的 replyCard / updateCard。
 *
 * CardBuilder 是唯一把事件流折叠成卡片内容的地方 —— 群里的卡片和 web UI 的预览
 * 走的是同一条路径，预览不会跟真实卡片漂移。
 */

const MAX_RESULT = 500;     // 单条工具返回
/**
 * 整卡 JSON 的字节预算。飞书对卡片 JSON 的硬上限是 30KB（超了直接拒收），
 * 留 6KB 给外层那层 `{content: "<转义过的卡片>"}` 和 JSON 结构。
 *
 * **按字节不按字数**：中文一个字 3 字节，转义出来的 `&#60;` 一个字符占 5 字节。
 * 正文优先吃这个预算，过程吃剩下的 —— 见 buildCard。
 */
const MAX_BYTES = 24 * 1024;
/** 正文短的时候过程也别无限长 —— 一堆工具输出不叫信息 */
const MAX_PROCESS_BYTES = 8 * 1024;
/** 机器人的卡片（chrono）上每段思考留多少字 */
const THINK_HEAD = 100;
/** 过程被正文挤到这么小就不值得占地方了，整个撤掉 */
const MIN_PROCESS_BYTES = 600;
/** 流式节流：CC 事件很密，全推会把更新接口打爆 */
const THROTTLE_MS = 1200;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/**
 * 按**字节**裁。直接 slice 会把一个汉字/emoji 切成半个，出去是乱码 ——
 * 在 UTF-8 字节上退到字符边界再解码。`tail` = 保留尾部（流式看最新）。
 */
function clipBytes(s: string, max: number, tail = false): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= max) return s;
  let a = 0;
  let b = max;
  if (tail) {
    a = buf.length - max;
    b = buf.length;
    while (a < b && (buf[a] & 0xc0) === 0x80) a++;
    // 从下一段开头接上：切在一行中间会留下半个 <text_tag>，原样露在卡片上
    const rest = buf.subarray(a, b).toString('utf8');
    const i = rest.indexOf('\n\n');
    return '…\n\n' + (i >= 0 ? rest.slice(i + 2) : rest);
  }
  while (b > 0 && (buf[b] & 0xc0) === 0x80) b--;
  return buf.subarray(0, b).toString('utf8') + '…';
}

/**
 * 卡片 markdown 会真的解析 `* _ ~ \` > < [ ] #` —— 这些字符出现在**内容**里必须转义，
 * 不然思考里的 `a_b_c` 会变斜体、`<T>` 会消失。转义成数字实体，渲染出来还是原字符。
 * `---` 单独一行会变分割线，所以连着的三个以上减号也转；单个 `-` 留着，列表还能用。
 */
const esc = (s: string) =>
  String(s)
    .replace(/[\\*_~`><[\]!#]/g, (c) => `&#${c.charCodeAt(0)};`)
    .replace(/-{3,}/g, (m) => m.replace(/-/g, '&#45;'));

/** 工具入参里挑一个最能说明"在干嘛"的字段，比甩一坨 JSON 可读 */
const ARG_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'description', 'skill'];

export function summarize(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const k of ARG_KEYS) if (typeof o[k] === 'string' && o[k]) return clip(oneLine(o[k] as string), 120);
    try { return clip(oneLine(JSON.stringify(input)), 120); } catch { return ''; }
  }
  return typeof input === 'string' ? clip(oneLine(input), 120) : '';
}

/** 工具返回可能自带 ``` —— 不剥掉会把外层代码块提前闭合 */
const fence = (s: string) => '```\n' + s.replace(/```/g, '') + '\n```';

/**
 * 思考在时间线里当旁白：引用块 + 灰字，跟工具调用区分得开，但**不跟它断开**。
 * 逐行加 `>` —— 跟卡片顶部那句原问题用的是同一个写法，飞书渲染得出来。
 */
const quote = (s: string) => s.split('\n').map((l) => `> <font color='grey'>${esc(l)}</font>`).join('\n');

export type CardStatus = 'running' | 'done' | 'failed' | 'skipped';

/**
 * 状态 → 卡片头部。群里扫一眼颜色就知道结果：蓝=在跑，绿=好了，橙=断了。
 *
 * 措辞**不跟场景绑** —— 这套东西不只用来排查问题，模板配成什么它就是什么（写代码、答问题、
 * 跑脚本都行）。"排查中/排查完成"在排查场景下贴切，换个场景就别扭了。
 */
export function titleFor(s: CardStatus): { title: string; template: string } {
  if (s === 'running') return { title: '⏳ 处理中…', template: 'blue' };
  if (s === 'done') return { title: '✅ 已完成', template: 'green' };
  if (s === 'skipped') return { title: '🚫 已跳过', template: 'grey' };
  return { title: '⚠️ 已中断', template: 'orange' };
}

export interface CardInput {
  who: string;
  q: string;
  status: CardStatus;
  text: string;
  /** 排查过程：思考 + 工具调用 + 工具返回，**按发生的顺序**排成一条时间线 */
  process: string;
  tools: number;
  /** CC 的 session id —— 贴在卡片最后，方便 --resume 接着问 */
  session?: string;
  /** CardKit 流式卡片（见 KitStream）：config 里开 streaming_mode，跑的时候面板标题不带工具次数 */
  streaming?: boolean;
  /** 按时间顺序排（机器人的卡片）：过程在上、结论在下。正文怎么取见 CardBuilder.chrono */
  chrono?: boolean;
}

/**
 * 正文和过程的 element_id。流式卡片靠它往这两块里"打字"（CardKit 的文本流式接口按 element_id 写）；
 * 普通卡片带着也无妨。
 */
export const BODY_ID = 'body';
export const PROC_ID = 'proc';
const panel = (title: string, el: unknown) => ({
  tag: 'collapsible_panel',
  expanded: false,
  header: { title: { tag: 'plain_text', content: title } },
  elements: [el],
});

/**
 * 打字机的节奏。默认 70ms 一个字，一段 2000 字的结论要打两分多钟 —— 调到 ~150 字/秒。
 * fast：新内容来了，上一段没打完的直接上屏，接着打新的，不排队。
 */
const STREAMING_CONFIG = { print_frequency_ms: { default: 30 }, print_step: { default: 5 }, print_strategy: 'fast' };

/**
 * 卡片布局（按飞书卡片视觉规范排的层级）：
 *   原问题（引用 + 小一号 + grey）= 次要
 *   正文                            = 唯一焦点
 *   排查过程（折叠）                 = 次要信息收进面板
 *   session（小一号 + grey）         = 最次要
 *
 * 思考和工具调用**不拆两个框**：它们是"看到报错 → 想到查 X → 调 Bash → 返回 → 想到 Y"
 * 这条因果链的两半，拆开就得让读的人自己在脑子里 zip 回去。而且工具返回的原始输出本来
 * 就在这一块里，拆出思考并不是"信号 vs 噪声"，只是随手拆的。
 *
 * 正文和过程由 buildCard 按预算裁好了再传进来，这里只管布局。
 */
function assemble(s: CardInput, text: string, process: string): any {
  const { title, template } = titleFor(s.status);
  const elements: unknown[] = [
    { tag: 'markdown', text_size: 'notation', content: `> <font color='grey'>${esc(clip(oneLine(s.q), 240))}</font>` },
  ];
  // 结论全文直接露出来，过程收进面板想看自己点开
  elements.push({ tag: 'markdown', element_id: BODY_ID, content: text });

  // 一次工具都没调也有可能 —— 光想了几段就答了。那时候别写"0 次工具调用"。
  // 流式卡片跑的时候不写次数：次数一变就得整卡重写，正在打的字会被打断（见 KitStream）
  const counted = s.tools && !(s.streaming && s.status === 'running');
  if (process) elements.push(panel(counted ? `过程 · ${s.tools} 次工具调用` : '过程', { tag: 'markdown', element_id: PROC_ID, content: process, text_size: 'notation' }));

  // session id 贴在最下面：想接着问的人可以 `claude --resume` 它，不用从零重查
  if (s.session) {
    const label = s.session.startsWith('codex:') ? 'Codex session ' + s.session.slice(6) : 'session ' + s.session;
    elements.push({ tag: 'markdown', text_size: 'notation', content: `<font color='grey'>${esc(label)}</font>` });
  }

  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', ...(s.streaming ? { streaming_mode: true, streaming_config: STREAMING_CONFIG } : {}) },
    header: {
      title: { tag: 'plain_text', content: title },
      subtitle: { tag: 'plain_text', content: `${s.who} @你` },
      template,
    },
    body: { elements },
  };
}

/** 除正文和过程之外的固定开销（头部、原问题、session、JSON 结构）—— 实测，不估算 */
const overhead = (s: CardInput) => bytes(JSON.stringify(assemble(s, '', '')));

/**
 * 一张卡片。**预算是抢的，正文优先**：
 *
 *   1. 过程先按自己的上限裁（正文短的时候它也别长成流水账）
 *   2. 一起塞得下就原样出 —— 绝大多数卡片走这条
 *   3. 塞不下：正文先吃满整卡预算，过程吃剩下的；剩不到 MIN_PROCESS_BYTES 就整个撤掉
 *
 * 截断方向跟着状态走：跑的时候看最新，收尾了看结论（system prompt 要求结论在前）。
 */
export function buildCard(s: CardInput): unknown {
  const tail = s.status === 'running';
  const body = s.text.trim() || (tail ? '_正在处理…_' : '_没有输出_');
  const raw = s.process.trim();
  // 机器人的卡片（过程已经是精简版）：过程吃正文剩下的全部，超了丢最老的步骤，跑完也是 —— 最后几步离结论最近
  const cap = s.chrono ? MAX_BYTES : MAX_PROCESS_BYTES;
  const procTail = tail || !!s.chrono;

  const card = assemble(s, body, clipBytes(raw, cap, procTail));
  if (bytes(JSON.stringify(card)) <= MAX_BYTES) return card;

  const room = MAX_BYTES - overhead(s) - 256;
  const text = clipBytes(body, room, tail);
  const left = Math.min(cap, room - bytes(text));
  if (!raw) return assemble(s, text, '');
  // 撤掉过程但留一句 —— 群里看不到工具痕迹，至少知道它调过 N 次（面板标题里）
  if (left < MIN_PROCESS_BYTES) return assemble(s, text, "> <font color='grey'>正文较长，过程已省略</font>");
  // overhead 量的时候没有面板，过程里的换行转义后也变长 —— 超了多少再裁多少。
  // 一次不一定够：tail 是从下一段开头接上的，两次切点可能落到同一段开头
  for (let max = left; ; max -= 512) {
    const fit = assemble(s, text, clipBytes(raw, Math.max(0, max), procTail));
    const over = bytes(JSON.stringify(fit)) - MAX_BYTES;
    if (over <= 0 || max <= 0) return fit;
    max -= over;
  }
}

/** 先发出去的那张"我收到了"，让群里不用干等 */
export function thinkingCard(who: string, q: string): unknown {
  return buildCard({ who, q, status: 'running', text: '', process: '', tools: 0 });
}

/** 事件流 → 卡片内容。web UI 的预览和历史作业重建也用它 */
export class CardBuilder {
  private committedText = '';
  private partialText = '';
  get text(): string { return this.committedText + this.partialText; }
  set text(value: string) { this.committedText = value; this.partialText = ''; }
  process = '';
  tools = 0;
  session?: string;
  /**
   * 按时间顺序（机器人的卡片）：正文只留**最后一段话**。说完一段又接着想 / 调工具，那段就是
   * "我先看下日志"这种过场话，挪进过程、排在它引出的那次工具调用前面。
   * 跑的时候分不清哪段是最后一段，所以每段话先进正文，后面又动了手再挪走。
   */
  chrono = false;
  private readonly names = new Map<string, string>();

  /** 一个事件都没产出。`--resume` 到不存在的 session 就是这样：claude 连 init 都不发，直接退出 */
  get silent(): boolean {
    return !this.text && !this.process && !this.tools && !this.session;
  }

  push(ev: AgentEvent): void {
    if (this.chrono && this.text && (ev.kind === 'thinking' || ev.kind === 'tool' || ev.kind === 'result')) {
      this.process += this.text;
      this.text = '';
    }
    switch (ev.kind) {
      case 'init': {
        this.session = ev.sessionId;
        return;
      }
      case 'text': {
        if (ev.partial) { this.partialText = ev.text; break; }
        this.partialText = '';
        const t = ev.text.trim();
        if (!t) return;
        this.text += t + '\n\n';
        break;
      }
      case 'thinking': {
        const t = ev.text.trim();
        if (!t) return;
        // 机器人的卡片每段思考只留开头一行：CC 一次排查能想出几十上百 KB，整卡才 30KB
        this.process += quote(this.chrono ? clip(oneLine(t), THINK_HEAD) : t) + '\n\n';
        break;
      }
      case 'tool': {
        this.tools++;
        this.names.set(ev.id, ev.name);
        const arg = summarize(ev.input);
        // 工具名做成飞书的标签，比一行 `**⚙ Bash**` 干净
        this.process += `<text_tag color='neutral'>${esc(ev.name)}</text_tag>${arg ? ' `' + esc(arg) + '`' : ''}\n\n`;
        break;
      }
      case 'result': {
        const t = ev.text.trim();
        if (!t) return;
        const who = this.names.get(ev.id);
        if (ev.isError && who) this.process += `<text_tag color='red'>${esc(who)} 报错</text_tag>\n\n`;
        if (!this.chrono) this.process += fence(clip(t, MAX_RESULT)) + '\n\n'; // 机器人的卡片不放工具输出，全文在 web UI
        break;
      }
      default:
        return; // done 不进卡片
    }
  }
}

/**
 * 一次排查的卡片。
 *
 * **开话题是懒的**：构造时不给 messageId，只给一个"怎么开"的函数。事件从第一秒就攒着，
 * 但在 `open()` 之前一个字节都不往群里发。这样调用方可以先看模型到底要干嘛，再决定开不开。
 */
export class CardStream {
  protected readonly b = new CardBuilder();
  private readonly who: string;
  private readonly q: string;
  private readonly openCard: () => Promise<string>;
  protected readonly update: typeof updateCard;
  protected messageId?: string;
  /** 流式卡片（KitStream）把它打开：卡片 config 带 streaming_mode */
  protected streaming = false;
  /** 两帧之间至少隔多久。PATCH 消息有频控；流式卡片不受 QPS 限制，可以更密 */
  protected throttle = THROTTLE_MS;
  private opening: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 所有刷新串成的一条链，见 flush() */
  private chain: Promise<void> = Promise.resolve();
  /** 排在链上、还没写出去的那一帧。只留最新的一个 */
  private queued: CardStatus | null = null;
  /** 最胖的一帧（字节 + 正文/过程的占比），收尾时打日志用 */
  private peak = { bytes: 0, body: 0, process: 0 };
  private done = false;
  /** 最近一次 PATCH 的错（成功一次就清掉）。刷不上不弄死运行，但试跑要把它报出来 */
  error?: string;

  constructor(openCard: () => Promise<string>, who: string, q: string, update: typeof updateCard = updateCard) {
    this.openCard = openCard;
    this.who = who;
    this.q = q;
    this.update = update;
  }

  /** 话题开出来了没有（攒着不算） */
  get opened(): boolean {
    return !!this.messageId;
  }

  /** 群里那条卡片消息的 id，用来撤回 */
  get cardId(): string | undefined {
    return this.messageId;
  }

  /** 这次跑的 CC session —— 记到话题上，下次在同一个话题里追问就接着它 */
  get session(): string | undefined {
    return this.b.session;
  }

  /** 一个事件都没产出（见 CardBuilder.silent） */
  get silent(): boolean {
    return this.b.silent;
  }

  /** 开话题。攒着的事件在这一刻一次性推出去。开失败会抛，之后 await 还是同一个错 */
  open(): Promise<void> {
    this.opening ??= this.doOpen();
    return this.opening;
  }

  protected async doOpen(): Promise<void> {
    this.messageId = await this.openCard();
    await this.flush('running');
  }

  push(ev: AgentEvent): void {
    const b = this.b;
    const before = b.text.length + b.process.length + b.tools;
    b.push(ev);
    if (b.text.length + b.process.length + b.tools === before) return; // init/done/空事件，不用刷
    if (!this.opened) return; // 还没开话题，接着攒
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.done) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush('running');
    }, this.throttle);
  }

  /**
   * 刷一帧。**所有刷新串成一条链**，两个好处：
   *
   *   - 不会并发 PATCH 同一条消息（慢的时候乱序回来，卡片会闪回旧内容）
   *   - `finish()` await 到的是"这一帧真写完了"，不是"我把它排上队了"
   *
   * `queued` 只留最新的一帧：中间态漏几帧无所谓（下一帧就追上），但**收尾那一帧绝不能丢**
   * —— 丢了群里那张卡片就永远停在"处理中…"，而 web UI 走 SSE 不经过飞书、照样显示完成，
   * 两边对不上，还只有群里的人看得见。
   */
  protected flush(status: CardStatus): Promise<void> {
    if (!this.messageId) return Promise.resolve();
    this.queued = status;
    this.chain = this.chain.then(() => {
      const s = this.queued;
      this.queued = null;
      return s ? this.write(s) : undefined;
    });
    return this.chain;
  }

  /** 这一刻的卡片。顺手记下最胖的一帧 */
  protected frame(status: CardStatus): unknown {
    const card = buildCard({
      who: this.who, q: this.q, status,
      text: this.b.text, process: this.b.process,
      tools: this.b.tools, session: this.b.session, chrono: this.b.chrono,
      streaming: this.streaming && status === 'running',
    });
    const n = bytes(JSON.stringify(card));
    if (n > this.peak.bytes) this.peak = { bytes: n, body: bytes(this.b.text), process: bytes(this.b.process) };
    return card;
  }

  /** 真的打一次 PATCH。异常在这儿吞掉 —— 刷不上去不该弄死这次运行 */
  protected async write(status: CardStatus): Promise<void> {
    try {
      await this.update(this.messageId!, this.frame(status));
      this.error = undefined;
    } catch (e: any) {
      this.error = e.message;
      console.log(`card update failed: ${e.message}`);
    }
  }

  /**
   * 这一跑里卡片最胖的那一帧。贴近 30KB 就在收尾时打一条 —— 一次运行最多一条，不刷屏。
   * 日志里长期一条都没有，说明预算够用，不用去做"正文拆多条消息"那套。
   */
  private logPeak(): void {
    if (this.peak.bytes <= MAX_BYTES * 0.8) return;
    const { bytes: n, body, process } = this.peak;
    console.log(`card near limit: peak ${n}B body=${body}B process=${process}B`);
  }

  /** 收尾：CC 一句正文都没吐（纯工具调用）时，用 result 兜底。没开过话题就什么都不做 */
  async finish(text: string, ok: boolean): Promise<void> {
    if (!this.messageId) return;
    this.done = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.b.text.trim()) this.b.text = text || (ok ? '' : '_中断了，没有输出（看服务端日志）_');
    await this.flush(ok ? 'done' : 'failed');
    this.logPeak();
  }
}

/* ---------- 流式卡片（CardKit）：只有机器人用得上 ---------- */

/**
 * CardKit 的几个接口（卡片实体 + 流式更新）。**只认机器人身份**（tenant token + cardkit:card:write），
 * 所以 @我 那条路用不了 —— 那边的卡片得"显示成我本人发的"。
 * 同一张卡片上的每次操作都要带**严格递增**的 sequence。
 */
export interface Kit {
  /** 建卡片实体，返回 card_id。建出来还没发 */
  create(card: unknown): Promise<string>;
  /** 往某个 element 里写全量文本：旧文本是新文本的前缀，新增那段就以打字机效果出来；不是前缀就直接整段上屏 */
  text(cardId: string, elementId: string, content: string, sequence: number): Promise<void>;
  /** 整卡替换（流式模式下也能用，不受 QPS 限制） */
  update(cardId: string, card: unknown, sequence: number): Promise<void>;
  /** 开 / 关流式模式。开着 10 分钟会自己关 */
  streaming(cardId: string, on: boolean, sequence: number): Promise<void>;
}

/** 卡片里正文 / 过程那两块的内容，和"其它所有东西"（骨架）。骨架没变就只往两块里打字 */
function parts(card: any): { skel: string; body: string; proc: string } {
  const c = structuredClone(card);
  const all = c.body.elements.flatMap((e: any) => [e, ...(e.elements ?? [])]);
  const take = (id: string) => {
    const e = all.find((x: any) => x.element_id === id);
    const v = e?.content ?? '';
    if (e) e.content = '';
    return v;
  };
  const body = take(BODY_ID);
  const proc = take(PROC_ID);
  return { skel: JSON.stringify(c), body, proc };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 机器人的流式卡片。生命周期跟 CardStream 一样（懒开、节流、写串成一条链、收尾帧不丢），差在怎么开、怎么写：
 *
 *   - 开：先建卡片实体（streaming_mode 开着），再按 card_id 回复出去
 *   - 跑的时候：骨架（面板有没有、session 那行……）没变，就只往正文 / 过程两块里**打字**；
 *     变了才整卡替换（会打断正在打的字，所以面板标题跑的时候不写工具次数，见 assemble）
 *   - 收尾：先关流式，再整卡写最终帧。写失败隔一会儿重试 —— 收尾帧丢了卡片就永远停在"处理中"
 *   - 流式模式开 10 分钟会自己关（CC 跑久了很常见），之后打字报 300309：重新打开接着写
 *
 * CardKit 建不出来（没开 cardkit:card:write 之类）就退回普通卡片（CardStream 那套），别让机器人不吭声。
 */
export class KitStream extends CardStream {
  private readonly kit: Kit;
  private readonly send: (content: unknown) => Promise<string>;
  /** CardKit 卡片实体 id。退回普通卡片时没有 */
  entity?: string;
  private seq = 0;
  private sent = { skel: '', body: '', proc: '' };
  /** CardKit 用不了，退回普通卡片 */
  private plain = false;

  constructor(
    kit: Kit, send: (content: unknown) => Promise<string>, who: string, q: string,
    update: typeof updateCard,
  ) {
    super(() => send(thinkingCard(who, q)), who, q, update);
    this.kit = kit;
    this.send = send;
    this.streaming = true;
    this.b.chrono = true;
    this.throttle = 400;
  }

  protected override async doOpen(): Promise<void> {
    const card = this.frame('running');
    try {
      this.entity = await this.kit.create(card);
    } catch (e: any) {
      console.log(`CardKit 建卡失败，退回普通卡片: ${e.message}`);
      this.plain = true;
      this.streaming = false;
      return super.doOpen();
    }
    this.messageId = await this.send({ type: 'card', data: { card_id: this.entity } });
    this.sent = parts(card);
    await this.flush('running');
  }

  protected override async write(status: CardStatus): Promise<void> {
    if (this.plain) return super.write(status);
    const card = this.frame(status);
    try {
      if (status !== 'running') { await this.last(card); this.error = undefined; return; }
      const now = parts(card);
      if (now.skel !== this.sent.skel) {
        await this.kit.update(this.entity!, card, ++this.seq);
      } else {
        if (now.body !== this.sent.body) await this.type(BODY_ID, now.body);
        if (now.proc !== this.sent.proc) await this.type(PROC_ID, now.proc);
      }
      this.sent = now;
      this.error = undefined;
    } catch (e: any) {
      this.error = e.message;
      console.log(`card update failed: ${e.message}`);
    }
  }

  private async type(id: string, content: string): Promise<void> {
    try {
      await this.kit.text(this.entity!, id, content, ++this.seq);
    } catch (e: any) {
      if (e.code !== 300309) throw e;
      await this.kit.streaming(this.entity!, true, ++this.seq);
      await this.kit.text(this.entity!, id, content, ++this.seq);
    }
  }

  private async last(card: unknown): Promise<void> {
    for (let i = 0; ; i++) {
      try {
        await this.kit.streaming(this.entity!, false, ++this.seq);
        await this.kit.update(this.entity!, card, ++this.seq);
        return;
      } catch (e: any) {
        if (i >= 2) throw e;
        await sleep(1500);
      }
    }
  }
}
