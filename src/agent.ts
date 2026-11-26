import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCodex, type CodexOptions, type Steer } from './codex.ts';
import { bin, claudeDir, killTree } from './bins.ts';
import { expandProject } from './config.ts';

/** MCP server 的连接状态，原样取自 claude 的 init 事件（实测 `connected`；别的值不写死，不是 connected 就算有问题） */
export interface McpStatus { name: string; status: string }

/** 归一化后的 CC 事件 —— 卡片和 web UI 直接消费这个流，不用再懂 claude 的原始协议 */
export type AgentEvent =
  | { kind: 'init'; sessionId: string; cwd?: string; model?: string; mcp?: McpStatus[]; plugins?: string[] }
  | { kind: 'text'; text: string; itemId?: string; partial?: boolean }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input?: unknown }
  | { kind: 'result'; id: string; text: string; isError: boolean }
  | { kind: 'done'; ok: boolean; text: string; sessionId?: string }
  /** claude 打 API 失败、正在自己重试（它默认要试 10 次，401 也试，几分钟）。status 是 HTTP 状态码，连不上的时候没有 */
  | { kind: 'retry'; status?: number; attempt: number }
  /**
   * 用量。每条模型回复一个：ctx = 这次喂进去的上下文（输入 + 缓存读写），out = 这条输出了多少。
   * 实时流里的 out 是半截数（回复刚开头时的），跑完 result 给这一次跑的总输出（total）；session 记录里的 out 是准的。
   * 合起来怎么算见 Usage
   */
  | { kind: 'usage'; msgId?: string; model?: string; ctx?: number; out: number; total?: boolean };

/** 一次作业 / 一问的用量：上下文取最后一次调模型的，输出按回复去重求和，跟 result 的总数比取大的 */
export class Usage {
  ctx = 0;
  private outs = new Map<string, number>();
  private totals = 0;
  add(e: AgentEvent): boolean {
    if (e.kind !== 'usage') return false;
    if (e.total) this.totals += e.out;
    else {
      if (e.ctx) this.ctx = e.ctx;
      this.outs.set(e.msgId ?? '', Math.max(this.outs.get(e.msgId ?? '') ?? 0, e.out));
    }
    return true;
  }
  get out(): number { return Math.max([...this.outs.values()].reduce((a, b) => a + b, 0), this.totals); }
}

/** 同一条模型回复按内容块拆成几行，每行带同一份 usage：跟上一份一样的不再发（不然事件数翻倍） */
export function dedupeUsage(): (e: AgentEvent) => boolean {
  let last = '';
  return (e) => {
    if (e.kind !== 'usage') return true;
    const k = `${e.msgId}:${e.ctx}:${e.out}`;
    if (k === last) return false;
    last = k;
    return true;
  };
}

export interface RunOptions {
  project: string;
  prompt: string;
  claudeArgs: string[];
  codex?: CodexOptions;
  onSteerReady?: (steer: Steer) => void;
  systemPrompt: string;
  /** 传了就能拿到实时事件；卡片和 web UI 的接入点 */
  onEvent?: (e: AgentEvent) => void;
  /** 停止这次作业。Claude 终止子进程，Codex 只中断当前 turn。 */
  signal?: AbortSignal;
}

export interface RunResult {
  text: string;
  sessionId?: string;
  ok: boolean;
  /** 没跑成时 claude 的报错（stderr 最后一行），给作业详情看。不然界面上只有「中断 / 没有输出」，猜不到为什么 */
  error?: string;
  /** 是 API 报错结束的（额度用完 / 限流 / 鉴权失败……）：HTTP 状态码。换个 API 来源也许就好了 */
  apiStatus?: number;
}

/** tool_result 的 content 可能是字符串，也可能是 block 数组 */
function blockText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('');
  return '';
}

/**
 * claude 的一条 assistant / user 记录 → 事件。stream-json 的输出和 session 落盘的 jsonl 是同一个形状，两边共用
 */
export function eventsOf(ev: any): AgentEvent[] {
  const out: AgentEvent[] = [];
  // API 报错时 claude 补一条假的助手消息（「API Error: 403 …」）。不当正文：换个来源接着跑的话它就不该出现在卡片上；
  // 不换的话 result 里有同样的话，收尾照样看得到
  if (ev.type === 'assistant' && !ev.is_api_error_message) {
    for (const block of ev.message?.content ?? []) {
      if (block.type === 'text' && block.text) out.push({ kind: 'text', text: block.text });
      else if (block.type === 'thinking' && (block.thinking || block.text)) out.push({ kind: 'thinking', text: block.thinking ?? block.text });
      else if (block.type === 'tool_use') out.push({ kind: 'tool', id: block.id, name: block.name, input: block.input });
    }
    const u = ev.message?.usage;
    if (u && ev.message.model !== '<synthetic>') out.push({
      kind: 'usage', msgId: ev.message.id, model: ev.message.model,
      ctx: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), out: u.output_tokens ?? 0,
    });
  } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    // 工具的返回值走的是 user 消息里的 tool_result，靠 tool_use_id 跟上面那次调用配对
    for (const block of ev.message.content) {
      if (block.type === 'tool_result') out.push({ kind: 'result', id: block.tool_use_id, text: blockText(block.content), isError: !!block.is_error });
    }
  }
  return out;
}

/** 换了 API 来源接着跑时发的那句（见 pipeline 的 runOnApis）。读 session 记录时它不算新的一问 */
export const CONTINUE = '（刚才调模型的 API 出了问题，换了一个接着来：把没做完的做完，结论照原来的要求给）';

/** session 记录里的一问：发给 claude 的原话（可能带话题上下文）+ 这一问底下的事件（含用量） */
export interface Turn { prompt: string; t: number; events: (AgentEvent & { t: number })[] }

/**
 * 本机 claude 落盘的 session（<claude 配置目录>/projects/<项目>/<id>.jsonl）→ 一问一答。
 * 内存里的逐条事件重启就没了，过程从这里找回来；试跑不落库，也只能从这里找回来。
 * ponytail: 只认 Claude。Codex 的线程在 ~/.codex/sessions 里，格式不一样，用的人多了再接
 */
export function readTranscript(session: string, root = join(claudeDir(), 'projects')): { cwd?: string; turns: Turn[] } | undefined {
  if (!/^[\w-]+$/.test(session)) return;   // 拼进路径的，只放行 uuid 这种
  let file: string | undefined;
  try { file = readdirSync(root).map((d) => join(root, d, `${session}.jsonl`)).find((f) => existsSync(f)); } catch { return; }
  if (!file) return;
  let cwd: string | undefined;
  const turns: Turn[] = [];
  const fresh = dedupeUsage();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if ((ev?.type !== 'user' && ev?.type !== 'assistant') || ev.isSidechain) continue;
    cwd ??= ev.cwd;
    const t = Date.parse(ev.timestamp) || 0;
    const c = ev.message?.content;
    // 后台子任务的回报（task-notification）也是一条 user 消息，但它不是新的一问：后面的事件还算这一问的
    const prompt = ev.type === 'user' && !ev.isMeta && ev.promptSource !== 'system'
      ? typeof c === 'string' ? c : Array.isArray(c) && !c.some((b: any) => b.type === 'tool_result') ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') : ''
      : '';
    if (prompt && prompt !== CONTINUE && !prompt.startsWith('<task-notification>')) { turns.push({ prompt, t, events: [] }); continue; }
    const cur = turns.at(-1);
    // 工具的返回可能很长（整个文件），页面上也只显示前 2 万字
    for (const e of eventsOf(ev).filter(fresh)) cur?.events.push({ ...(e.kind === 'result' ? { ...e, text: e.text.slice(0, 20_000) } : e), t });
  }
  return { cwd, turns };
}

/**
 * 还在跑的 claude。服务不管怎么退 —— 连按两下 Ctrl+C、停机收尾超时、桌面版到点硬退 —— 都不能把它们
 * 留下接着跑（它们手里有 Bash，没人看着还在改东西）。exit 里只能同步，所以直接整棵树 SIGKILL
 */
const live = new Set<ChildProcess>();
process.on('exit', () => { for (const c of live) killTree(c, true); });

/**
 * 启动模板选择的 CLI，把 JSONL 折成卡片和 Web 共用的事件流。
 */
export function runAgent(o: RunOptions): Promise<RunResult> {
  if (o.codex) return runCodex(o, o.codex);
  return new Promise((resolve) => {
    // 还没轮到跑就被掐了（排队期间被同会话的新消息顶掉）—— 连进程都别起
    if (o.signal?.aborted) {
      o.onEvent?.({ kind: 'done', ok: false, text: '' });
      resolve({ text: '', ok: false });
      return;
    }

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      ...o.claudeArgs,
      // 提示词是空的时候**不加这个参数** —— `--append-system-prompt ''` 到底算不算"空"是 claude 的事，
      // 干脆别问它。空就是没有
      ...(o.systemPrompt.trim() ? ['--append-system-prompt', o.systemPrompt] : []),
    ];

    // 项目可能写成 ~/xxx（模板里、试跑框里都是原样）：spawn 不认 ~，目录不存在报的是「spawn claude ENOENT」，看着像 claude 没装
    const cwd = expandProject(o.project);
    const child = spawn(bin('claude'), args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    live.add(child);

    const abort = () => {
      killTree(child);
      // 不认 SIGTERM 就硬杀：接棒那条在等它收尾，卡住等于新消息也回不了
      setTimeout(() => killTree(child, true), 5_000).unref();
    };
    o.signal?.addEventListener('abort', abort, { once: true });

    let sessionId: string | undefined;
    const fresh = dedupeUsage();
    const texts: string[] = [];
    let resultText: string | undefined;
    let ok = false;
    let apiStatus: number | undefined;
    let stderr = '';

    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      let ev: any;
      try { ev = JSON.parse(line); } catch { return; }
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'system' && ev.subtype === 'init') {
        sessionId = ev.session_id;
        o.onEvent?.({
          kind: 'init', sessionId: ev.session_id, cwd: ev.cwd, model: ev.model,
          // 这次跑实际连上了哪些 MCP、加载了哪些 plugin —— 授权过期 / plugin 被关就看这个
          mcp: Array.isArray(ev.mcp_servers) ? ev.mcp_servers.map((s: any) => ({ name: String(s.name), status: String(s.status) })) : undefined,
          plugins: Array.isArray(ev.plugins) ? ev.plugins.map((p: any) => String(p.name)) : undefined,
        });
      } else if (ev.type === 'system' && ev.subtype === 'api_retry') {
        o.onEvent?.({ kind: 'retry', status: typeof ev.error_status === 'number' ? ev.error_status : undefined, attempt: Number(ev.attempt) || 1 });
      } else if (ev.type === 'assistant' || ev.type === 'user') {
        for (const e of eventsOf(ev).filter(fresh)) {
          if (e.kind === 'text') texts.push(e.text);
          o.onEvent?.(e);
        }
      } else if (ev.type === 'result') {
        resultText = typeof ev.result === 'string' ? ev.result : undefined;
        // 流里每条回复的输出数是半截的，这次跑一共输出多少以这里为准
        if (typeof ev.usage?.output_tokens === 'number') o.onEvent?.({ kind: 'usage', out: ev.usage.output_tokens, total: true });
        sessionId ??= ev.session_id;
        ok = !ev.is_error;
        if (typeof ev.api_error_status === 'number') apiStatus = ev.api_error_status;
      }
    });

    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

    // 起不来（ENOENT）时 error 和 close 都会来 —— 只收一次尾，不然时间线上两个「结束」
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      o.signal?.removeEventListener('abort', abort);
      live.delete(child);
      // `||` 不是 `??`：result 可能是空串（模型最后一句是工具调用），那时要用正文块兜底
      const text = (resultText || texts.join('')).trim();
      if (!ok && !text && stderr) process.stderr.write(`[agent] ${stderr.slice(-500)}\n`);
      o.onEvent?.({ kind: 'done', ok, text, sessionId });
      resolve({ text, sessionId, ok, apiStatus: ok ? undefined : apiStatus, error: ok ? undefined : stderr.trim().split('\n').pop() || undefined });
    };
    child.on('error', (e) => {
      stderr += `${e.message}\n`;
      if (child.pid === undefined) finish(); // 压根没起来，不指望 close
    });
    child.on('close', finish);

    child.stdin.on('error', (e) => { stderr += e.message + '\n'; });
    child.stdin.end(o.prompt);
  });
}
