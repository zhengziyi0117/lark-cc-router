import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { runCodex, type CodexOptions, type Steer } from './codex.ts';
import { bin, killTree } from './bins.ts';
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
  | { kind: 'retry'; status?: number; attempt: number };

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
      } else if (ev.type === 'assistant') {
        // API 报错时 claude 补一条假的助手消息（「API Error: 403 …」）。不当正文：换个来源接着跑的话它就不该出现在卡片上；
        // 不换的话 result 里有同样的话，收尾照样看得到
        if (ev.is_api_error_message) return;
        for (const block of ev.message?.content ?? []) {
          if (block.type === 'text' && block.text) {
            texts.push(block.text);
            o.onEvent?.({ kind: 'text', text: block.text });
          } else if (block.type === 'thinking' && (block.thinking || block.text)) {
            o.onEvent?.({ kind: 'thinking', text: block.thinking ?? block.text });
          } else if (block.type === 'tool_use') {
            o.onEvent?.({ kind: 'tool', id: block.id, name: block.name, input: block.input });
          }
        }
      } else if (ev.type === 'user') {
        // 工具的返回值走的是 user 消息里的 tool_result，靠 tool_use_id 跟上面那次调用配对
        for (const block of ev.message?.content ?? []) {
          if (block.type !== 'tool_result') continue;
          o.onEvent?.({
            kind: 'result',
            id: block.tool_use_id,
            text: blockText(block.content),
            isError: !!block.is_error,
          });
        }
      } else if (ev.type === 'result') {
        resultText = typeof ev.result === 'string' ? ev.result : undefined;
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
