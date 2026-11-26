import { EventEmitter } from 'node:events';
import type { AgentEvent } from './agent.ts';

/** 带上到达时刻的事件 —— web UI 的时间轴要靠它算「第几秒发生了什么」 */
export type StampedEvent = AgentEvent & { t: number };

/** 一次「群里 @我 → CC 排查」的作业。web UI 看的就是它。 */
export interface Job {
  id: string; // 群消息 id
  chatId: string;
  who: string;
  q: string;
  project: string;
  status: 'running' | 'done' | 'skipped' | 'failed';
  answer?: string;
  error?: string;
  events: StampedEvent[];
  startedAt: number;
  endedAt?: number;
  /** 从 web UI 手动试跑的，不是群消息 —— 卡片发给我自己，别去群里找 */
  test?: boolean;
  /** 从哪个入口进来的：@我（以我的身份回）/ @机器人（以机器人身份回）。试跑没有 */
  mode?: 'user' | 'bot';
  /** CC session。实时作业从 init 事件里取；重启后的历史作业只剩这个 */
  session?: string;
  /** 判定的结论 + 理由（见 judge.ts） */
  reason?: string;
  /** 群里那个话题开了没有。判明"确实要排查"之前是 false —— 见 pipeline 的 shouldOpenThread */
  posted?: boolean;
  /** 飞书卡片没发出去 / 收尾那帧没改上的原因。有它就不算成功：web UI 上那个按钮变成「重发到飞书」 */
  sendError?: string;
  /** 网页上接着问、卡片回到了飞书原消息底下（不是发给我自己） */
  reply?: boolean;
  /** 用量（token）。实时作业页面从事件里自己算；重启后的历史作业只剩库里这两个数 */
  ctx?: number;
  out?: number;
}

export type Msg =
  | { type: 'job'; job: Omit<Job, 'events'> }
  | { type: 'ev'; id: string; ev: StampedEvent }
  | { type: 'config'; config: unknown }
  /** 上手向导的进度（见 setup/types.ts 的 progress） */
  | { type: 'setup'; section: string; msg: string; done?: boolean; ok?: boolean };

// ponytail: 内存上限，长跑的工具流会被截断；要完整记录看 ~/.claude/projects 里的 jsonl
const MAX_JOBS = 50;
const MAX_EVENTS = 400;

const jobs = new Map<string, Job>();
const emitter = new EventEmitter();

/** 订阅作业变更，返回退订函数（每个 SSE 连接一个） */
export function subscribe(fn: (m: Msg) => void): () => void {
  emitter.on('m', fn);
  return () => { emitter.off('m', fn); };
}

/**
 * 推给所有连着页面。配置存盘之后必须调它 —— 页面上的 cfg 是打开连接那一刻的快照，
 * 不推的话下次开设置抽屉会拿旧快照当草稿，一保存就把这中间加的东西抹掉（真丢过一次私聊）。
 */
export function broadcast(m: Msg): void {
  emitter.emit('m', m);
}

export function snapshot(): Job[] {
  return [...jobs.values()];
}

/** session 接着问的时候一开始就知道（页面按 session 把同一串追问聚在一起），新开的等 init 事件 */
export function startJob(o: Pick<Job, 'id' | 'chatId' | 'who' | 'q' | 'project' | 'test' | 'mode' | 'session' | 'reply'>): Job {
  const job: Job = { ...o, status: 'running', events: [], startedAt: Date.now() };
  jobs.set(job.id, job);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value!);
  emitJob(job);
  return job;
}

export function pushEvent(id: string, ev: AgentEvent): void {
  const job = jobs.get(id);
  if (!job) return;
  const stamped: StampedEvent = { ...ev, t: Date.now() };
  const previous = ev.kind === 'text' && ev.itemId ? job.events.findIndex((e) => e.kind === 'text' && e.itemId === ev.itemId) : -1;
  if (previous < 0) job.events.push(stamped);
  else job.events[previous] = stamped;
  if (job.events.length > MAX_EVENTS) job.events.shift();
  emitter.emit('m', { type: 'ev', id, ev: stamped } satisfies Msg);
  if (ev.kind === 'init' && job.session !== ev.sessionId) { job.session = ev.sessionId; emitJob(job); }
}

export function finishJob(id: string, patch: Partial<Pick<Job, "status" | "answer" | "error" | "sendError" | "posted">>): void {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { endedAt: Date.now() });
  emitJob(job);
}

/** 判定结论出来了（作业还在跑）。web UI 上马上能看到"为什么要回" */
export function setReason(id: string, reason: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.reason = reason;
  emitJob(job);
}

/** 群里的卡片真发出去了。web UI 靠它区分"还在攒"和"群里已经有了" */
export function markPosted(id: string): void {
  const job = jobs.get(id);
  if (!job || job.posted) return;
  job.posted = true;
  emitJob(job);
}

function emitJob(job: Job): void {
  const { events, ...meta } = job;
  emitter.emit('m', { type: 'job', job: meta } satisfies Msg);
}
