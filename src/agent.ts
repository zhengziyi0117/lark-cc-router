import { spawn } from 'node:child_process';
import { bin, killTree } from './bins.ts';

/** MCP server 的连接状态，原样取自 claude 的 init 事件（实测 `connected`；别的值不写死，不是 connected 就算有问题） */
export interface McpStatus { name: string; status: string }

/** 归一化后的 CC 事件 —— 卡片和 web UI 直接消费这个流，不用再懂 claude 的原始协议 */
export type AgentEvent =
  | { kind: 'init'; sessionId: string; cwd?: string; model?: string; mcp?: McpStatus[]; plugins?: string[] }
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input?: unknown }
  | { kind: 'result'; id: string; text: string; isError: boolean }
  | { kind: 'done'; ok: boolean; text: string; sessionId?: string };

export interface RunOptions {
  project: string;
  prompt: string;
  claudeArgs: string[];
  systemPrompt: string;
  /** 传了就能拿到实时事件；卡片和 web UI 的接入点 */
  onEvent?: (e: AgentEvent) => void;
  /**
   * 掐掉这次跑。同会话来了新消息时用（见 pipeline 的 InFlight）。
   * **杀进程**，不是"跑完再说"：session 已经落在磁盘上，`--resume` 接着问就行 ——
   * 这也是为什么在 `init` 之后随时都能掐（session id 第一秒就有了）。
   */
  signal?: AbortSignal;
}

export interface RunResult {
  text: string;
  sessionId?: string;
  ok: boolean;
}

/** tool_result 的 content 可能是字符串，也可能是 block 数组 */
function blockText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('');
  return '';
}

/**
 * 跑一次 claude -p，用 stream-json 拿实时事件。
 * sessionId 拿到后可以 --resume 续上下文（同一话题里追问时用）。
 */
export function runAgent(o: RunOptions): Promise<RunResult> {
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

    const child = spawn(bin('claude'), args, { cwd: o.project, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

    o.signal?.addEventListener('abort', () => {
      killTree(child);
      // 不认 SIGTERM 就硬杀：接棒那条在等它收尾，卡住等于新消息也回不了
      setTimeout(() => killTree(child, true), 5_000).unref();
    }, { once: true });

    let buf = '';
    let sessionId: string | undefined;
    const texts: string[] = [];
    let resultText: string | undefined;
    let ok = false;
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }

        if (ev.type === 'system' && ev.subtype === 'init') {
          sessionId = ev.session_id;
          o.onEvent?.({
            kind: 'init', sessionId: ev.session_id, cwd: ev.cwd, model: ev.model,
            // 这次跑实际连上了哪些 MCP、加载了哪些 plugin —— 授权过期 / plugin 被关就看这个
            mcp: Array.isArray(ev.mcp_servers) ? ev.mcp_servers.map((s: any) => ({ name: String(s.name), status: String(s.status) })) : undefined,
            plugins: Array.isArray(ev.plugins) ? ev.plugins.map((p: any) => String(p.name)) : undefined,
          });
        } else if (ev.type === 'assistant') {
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
        }
      }
    });

    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

    // 起不来（ENOENT）时 error 和 close 都会来 —— 只收一次尾，不然时间线上两个「结束」
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      // `||` 不是 `??`：result 可能是空串（模型最后一句是工具调用），那时要用正文块兜底
      const text = (resultText || texts.join('')).trim();
      if (!ok && !text && stderr) process.stderr.write(`[agent] ${stderr.slice(-500)}\n`);
      o.onEvent?.({ kind: 'done', ok, text, sessionId });
      resolve({ text, sessionId, ok });
    };
    child.on('error', (e) => {
      stderr += `${e.message}\n`;
      if (child.pid === undefined) finish(); // 压根没起来，不指望 close
    });
    child.on('close', finish);

    child.stdin.end(o.prompt);
  });
}
