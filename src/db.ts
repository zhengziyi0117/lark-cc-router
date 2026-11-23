import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface Handled {
  msgId: string;
  chatId: string;
  who: string;
  q: string;
  status: 'running' | 'done' | 'skipped' | 'failed';
  answer?: string;
  error?: string;
  startedAt: number;
  endedAt?: number;
  /** 这次跑的 CC session。web UI 上历史作业的「接着问」靠它 —— 逐条事件重启就没了，这个得落盘 */
  session?: string;
  /** 判定的结论 + 理由（"不用回：MR 通知"）。没配判定的模板没有 */
  reason?: string;
  /** 飞书卡片没发出去 / 没改上（见 bus 的 Job.sendError） */
  sendError?: string;
}

/**
 * 处理过的消息的落盘记录。两个用处：
 *   1. 去重 —— 搜索带重叠窗口，同一条每轮都会被捞回来，这张表是唯一的依据
 *   2. 历史 —— 重启后 web UI 还能看到以前回过什么
 * node:sqlite 是 Node 自带的，不用装依赖。
 *
 * **两个入口各一个库**（@我 是 history.db，@机器人 是 bot.db）：话题 → session 的锚点、去重、
 * 历史各管各的 —— 机器人的卡片和我的卡片是两条消息，混在一张表里只会互相认错。
 */
/** 上一轮进程没收尾就没了的作业里、卡片已经发出去的那些（见 Db.orphans） */
export interface Orphan { msgId: string; who: string; q: string; session?: string; card: string; entity?: string }

export class Db {
  private readonly db: DatabaseSync;
  /**
   * 上一轮进程死在半路（kill、崩溃、关终端、连按两下 Ctrl+C —— 没走 drain）、卡片还停在「处理中」的作业。
   * 开库时取一次，pipeline 的 closeOrphans 拿去把卡片补成「已中断」
   */
  readonly orphans: Orphan[];

  constructor(dir: string, file = 'history.db') {
    mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(join(dir, file));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS handled (
        msg_id     TEXT PRIMARY KEY,
        chat_id    TEXT NOT NULL,
        who        TEXT NOT NULL,
        q          TEXT NOT NULL,
        status     TEXT NOT NULL,
        answer     TEXT,
        error      TEXT,
        started_at INTEGER NOT NULL,
        ended_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS handled_started ON handled(started_at DESC);
      CREATE TABLE IF NOT EXISTS threads (
        -- 这一列存的是"锚点"：群话题 id（omt_…），或者我发的那张卡片自己的 message_id（om_…）
        -- —— 后者给私聊用（私聊没话题，只能靠引用回复的 reply_to 指回来）。见 pipeline 的 anchorOf
        thread_id  TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `);
    // 老库没有这几列。sqlite 没有 ADD COLUMN IF NOT EXISTS，只能先看一眼
    const cols = new Set((this.db.prepare(`PRAGMA table_info(handled)`).all() as any[]).map((c) => c.name));
    // card_msg / card_entity：发出去的卡片（消息 id；机器人的流式卡片还有卡片实体 id），死在半路时启动后靠它补收尾
    for (const c of ['session_id', 'reason', 'card_msg', 'card_entity', 'send_error']) if (!cols.has(c)) this.db.exec(`ALTER TABLE handled ADD COLUMN ${c} TEXT`);
    this.orphans = (this.db.prepare(`SELECT msg_id, who, q, session_id, card_msg, card_entity FROM handled WHERE status = 'running' AND card_msg IS NOT NULL`).all() as any[])
      .map((r) => ({ msgId: r.msg_id, who: r.who, q: r.q, session: r.session_id ?? undefined, card: r.card_msg, entity: r.card_entity ?? undefined }));
    // 上一轮进程死在半路的作业会永远挂在 running，启动时收个尾
    this.db.prepare(`UPDATE handled SET status = 'failed', error = '进程中断', ended_at = ? WHERE status = 'running'`)
      .run(Date.now());
  }

  /** 认领这条消息。第一次见到返回 true，处理过返回 false —— false 就别再回一遍了 */
  claim(m: Pick<Handled, 'msgId' | 'chatId' | 'who' | 'q'>): boolean {
    const r = this.db
      .prepare(`INSERT OR IGNORE INTO handled (msg_id, chat_id, who, q, status, started_at) VALUES (?,?,?,?,?,?)`)
      .run(m.msgId, m.chatId, m.who, m.q, 'running', Date.now());
    return r.changes === 1;
  }

  /** 卡片发出去了就记下：进程死在半路的话，下次启动靠它把卡片补成「已中断」（见 orphans） */
  setCard(msgId: string, card: string, entity?: string): void {
    this.db.prepare(`UPDATE handled SET card_msg = ?, card_entity = ? WHERE msg_id = ?`).run(card, entity ?? null, msgId);
  }

  /** 「再跑一次」：忘掉处理过这条，好让它重新认领。话题 → session 的映射在另一张表，不动，重跑照样接得上 */
  forget(msgId: string): void {
    this.db.prepare(`DELETE FROM handled WHERE msg_id = ?`).run(msgId);
  }

  settle(msgId: string, status: Handled['status'], answer?: string, error?: string, session?: string, sendError?: string): void {
    this.db
      .prepare(`UPDATE handled SET status = ?, answer = ?, error = ?, ended_at = ?, session_id = ?, send_error = ? WHERE msg_id = ?`)
      .run(status, answer ?? null, error ?? null, Date.now(), session ?? null, sendError ?? null, msgId);
  }

  /** 「重发到飞书」发出去了：这才算成功，新卡片记成它的卡片 */
  delivered(msgId: string, card: string): void {
    this.db.prepare(`UPDATE handled SET status = 'done', error = NULL, send_error = NULL, card_msg = ?, card_entity = NULL WHERE msg_id = ?`).run(card, msgId);
  }

  get(msgId: string): Handled | undefined {
    return this.rows(`SELECT * FROM handled WHERE msg_id = ?`, msgId)[0];
  }

  /** 判定的结论 + 理由。判完就写，不等跑完 —— 跑到一半重启了也知道当时为什么要回 */
  setReason(msgId: string, reason: string): void {
    this.db.prepare(`UPDATE handled SET reason = ? WHERE msg_id = ?`).run(reason, msgId);
  }

  /**
   * 这个锚点用的是哪个 CC session。**接着上次问要复用 session**，
   * 不然每次 @我 都从零重查一遍（全权限 CC，白烧）。
   * 锚点是话题 id 或卡片 message_id，怎么来的见 pipeline 的 anchorOf / rememberThread。
   */
  setSession(anchor: string, sessionId: string): void {
    this.db
      .prepare(`INSERT INTO threads (thread_id, session_id, updated_at) VALUES (?,?,?)
                ON CONFLICT(thread_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at`)
      .run(anchor, sessionId, Date.now());
  }

  sessionFor(anchor: string): string | undefined {
    const r = this.db.prepare(`SELECT session_id FROM threads WHERE thread_id = ?`).get(anchor) as any;
    return r?.session_id ?? undefined;
  }

  /** session 没了（被清理 / 换机器）时把它忘掉，下次从零开始，别一直撞同一堵墙 */
  dropSession(anchor: string): void {
    this.db.prepare(`DELETE FROM threads WHERE thread_id = ?`).run(anchor);
  }

  /**
   * 上次搜到哪了（epoch ms）。搜"@我"是按时间窗查的，这就是那个游标。
   * 第一次跑没有值 = 从"现在"开始，不回放历史。
   */
  cursor(): number | undefined {
    const r = this.db.prepare(`SELECT v FROM meta WHERE k = 'cursor'`).get() as any;
    return r ? Number(r.v) : undefined;
  }

  setCursor(t: number): void {
    this.db
      .prepare(`INSERT INTO meta (k, v) VALUES ('cursor', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
      .run(String(t));
  }

  /** 杂项键值（健康基线这类）。值是 JSON */
  meta<T>(k: string): T | undefined {
    const r = this.db.prepare(`SELECT v FROM meta WHERE k = ?`).get(k) as any;
    return r ? JSON.parse(r.v) : undefined;
  }

  setMeta(k: string, v: unknown): void {
    this.db
      .prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
      .run(k, JSON.stringify(v));
  }

  recent(limit = 50): Handled[] {
    // rowid 兜底：同一毫秒认领的两条，光按 started_at 排不出先后
    return this.rows(`SELECT * FROM handled ORDER BY started_at DESC, rowid DESC LIMIT ?`, limit);
  }

  private rows(sql: string, ...args: (string | number)[]): Handled[] {
    return (this.db.prepare(sql).all(...args) as any[]).map((r) => ({
      msgId: r.msg_id,
      chatId: r.chat_id,
      who: r.who,
      q: r.q,
      status: r.status,
      answer: r.answer ?? undefined,
      error: r.error ?? undefined,
      startedAt: r.started_at,
      endedAt: r.ended_at ?? undefined,
      session: r.session_id ?? undefined,
      reason: r.reason ?? undefined,
      sendError: r.send_error ?? undefined,
    }));
  }

  close(): void {
    this.db.close();
  }
}
