import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { bin } from './bins.ts';
import { expandProject, type Agent, type CodexSandbox } from './config.ts';
import type { AgentEvent, RunOptions, RunResult } from './agent.ts';

export interface CodexOptions {
  model: string;
  effort?: string;
  sandbox: CodexSandbox;
  resume?: string;
  images: string[];
}
export type Steer = (prompt: string, images: string[]) => Promise<boolean>;

const SANDBOX_POLICY: Record<CodexSandbox, string> = { 'read-only': 'readOnly', 'workspace-write': 'workspaceWrite', 'danger-full-access': 'dangerFullAccess' };
export const sessionAgent = (session: string): Agent => session.startsWith('codex:') ? 'codex' : 'claude';
const input = (prompt: string, images: string[]) => [
  { type: 'text', text: prompt }, ...images.map((path) => ({ type: 'localImage', path })),
];

let server: AppServer | undefined;
export function disconnectCodex(): void { server?.close(new Error('已断开 Codex App Server 连接')); }
process.on('exit', disconnectCodex);

/** 同一条 WebSocket 上按请求 ID、线程和轮次分发。proxy 只转发字节，服务由 Codex 管理。 */
class AppServer {
  readonly connection: string;
  private proxy?: ChildProcessWithoutNullStreams;
  private socket: WebSocket;
  private opened = Promise.withResolvers<void>();
  events = new EventEmitter().setMaxListeners(0);
  busy = new Set<string>();
  pending = new Map<number, ReturnType<typeof Promise.withResolvers<any>>>();
  ready: Promise<void>;
  private id = 0;
  private failure?: Error;

  constructor() {
    const endpoint = process.env.LCR_CODEX_ENDPOINT || 'unix://';
    let stderr = '';
    if (endpoint.startsWith('unix://')) {
      const path = endpoint.slice('unix://'.length);
      this.connection = path || '本机 Codex 控制套接字';
      const proxy = this.proxy = spawn(bin('codex'), ['app-server', 'proxy', ...(path ? ['--sock', path] : [])],
        { cwd: homedir(), stdio: 'pipe', windowsHide: true });
      proxy.stderr.setEncoding('utf8').on('data', (s) => { stderr = (stderr + s).slice(-1000); });
      proxy.on('error', e => this.close(e));
      proxy.on('close', () => this.close(new Error(stderr.trim() || 'Codex 连接代理已退出')));
      const stream = Duplex.from({ readable: proxy.stdout, writable: proxy.stdin });
      stream.on('error', e => this.close(e));
      this.socket = new WebSocket('ws://localhost/', { createConnection: () => stream, handshakeTimeout: 5000 });
    } else {
      if (!/^wss?:\/\//.test(endpoint)) throw new Error('LCR_CODEX_ENDPOINT 需要 unix://、ws:// 或 wss:// 地址');
      this.connection = new URL(endpoint).origin;
      this.socket = new WebSocket(endpoint, { handshakeTimeout: 5000 });
    }
    this.socket.once('open', () => this.opened.resolve());
    this.socket.on('error', e => this.close(e));
    this.socket.on('close', () => this.close(new Error('Codex App Server 连接已关闭')));
    this.socket.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m?.method && m.id != null) {
        if (m.params?.threadId && !this.busy.has(m.params.threadId)) return;
        // 飞书后台没有交互式授权人。显式拒绝审批，未知的服务端请求也必须回包。
        const approval = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(m.method);
        this.send(approval ? { id: m.id, result: { decision: 'decline' } }
          : { id: m.id, error: { code: -32601, message: 'Unsupported client request: ' + m.method } });
      } else if (m?.method && m.params?.threadId) {
        this.events.emit('thread:' + m.params.threadId, m.method, m.params);
      } else if (m?.id != null) {
        const wait = this.pending.get(m.id);
        if (m.error) wait?.reject(new Error(m.error.message));
        else wait?.resolve(m.result);
      }
    });
    this.ready = this.opened.promise.catch(e => { throw new Error('无法连接已有 Codex App Server：' + (stderr.trim() || e.message)); })
      .then(() => this.call('initialize', { clientInfo: { name: 'lark_cc_router', title: 'lark-cc-router', version: '1' } }))
      .then(() => this.send({ method: 'initialized' })).catch((e) => { this.close(e); throw e; });
  }

  private send(message: unknown): void {
    if (!this.failure) this.socket.send(JSON.stringify(message));
  }

  async call(method: string, params: unknown): Promise<any> {
    if (this.failure) throw this.failure;
    const id = ++this.id;
    const wait = Promise.withResolvers<any>();
    this.pending.set(id, wait);
    const timer = setTimeout(() => wait.reject(new Error('Codex 请求超时：' + method)), 60_000);
    try {
      this.send({ id, method, params });
      return await wait.promise;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }

  close(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.opened.reject(error);
    if (server === this) server = undefined;
    for (const wait of this.pending.values()) wait.reject(error);
    this.events.emit('closed', error);
    this.socket.terminate();
    this.proxy?.kill();
  }
}

async function appServer(): Promise<AppServer> {
  const client = server ??= new AppServer();
  await client.ready;
  return client;
}

export async function codexConnection(): Promise<string> {
  return (await appServer()).connection;
}

interface CodexModel { model: string; label: string; efforts: string[]; defaultEffort: string; isDefault: boolean }
async function listModels(client: AppServer): Promise<CodexModel[]> {
  const models: CodexModel[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.call('model/list', { cursor, limit: 100, includeHidden: false });
    for (const m of page.data) models.push({ model: m.model, label: m.displayName || m.model, isDefault: m.isDefault,
      efforts: m.supportedReasoningEfforts.map((e: { reasoningEffort: string }) => e.reasoningEffort), defaultEffort: m.defaultReasoningEffort });
    cursor = page.nextCursor;
  } while (cursor);
  return models;
}

// 只把名称和开关交给设置页。MCP 配置可能带环境变量、请求头和令牌。
export async function codexSettings() {
  const client = await appServer();
  const [{ config, layers }, models] = await Promise.all([client.call('config/read', { includeLayers: true }), listModels(client)]);
  const user = layers?.find((layer: any) => layer.name.type === 'user' && !layer.name.profile);
  const entries = (values: Record<string, { enabled?: boolean }> = {}) =>
    Object.entries(values).map(([name, v]) => ({ name, enabled: v.enabled !== false })).sort((a, b) => a.name.localeCompare(b.name));
  return { file: user?.name.file, version: user?.version, connection: client.connection, models, model: config.model ?? '', effort: config.model_reasoning_effort ?? '',
    mcp: entries(config.mcp_servers), plugins: entries(config.plugins) };
}

/**
 * 设置页只开关 MCP / 插件。全局的模型和推理强度不在这里改：那是你自己 Codex 的配置，改了连终端里的 codex 也跟着变；
 * 每个模板本来就能单独选模型和强度
 */
export async function updateCodexSettings(body: any) {
  const settings = await codexSettings();
  if (!settings.version || body?.version !== settings.version) throw new Error('Codex 配置已变化，请刷新后再保存');
  const client = await appServer();
  if ((body.kind === 'mcp' || body.kind === 'plugins') && typeof body.value === 'boolean'
    && settings[body.kind as 'mcp' | 'plugins'].some(e => e.name === body.name)) {
    const keyPath = (body.kind === 'mcp' ? 'mcp_servers.' : 'plugins.') + JSON.stringify(body.name) + '.enabled';
    const result = await client.call('config/value/write', { keyPath, value: body.value, mergeStrategy: 'replace', expectedVersion: settings.version });
    return { overridden: result.status === 'okOverridden' };
  }
  throw new Error('无效的 Codex 配置项');
}

function toolItem(i: any): { name: string; input: unknown; output: string } | undefined {
  switch (i.type) {
    case 'commandExecution': return { name: 'Shell', input: i.command, output: i.aggregatedOutput ?? '' };
    case 'mcpToolCall': return { name: i.server + '/' + i.tool, input: i.arguments,
      output: i.error?.message || (i.result?.content ?? []).map((b: any) => b?.text ?? '').join('\n') };
    case 'fileChange': return { name: '文件修改', input: i.changes, output: i.status };
    case 'webSearch': return { name: '网页搜索', input: i.query, output: '' };
  }
}

export async function runCodex(o: RunOptions, opts: CodexOptions): Promise<RunResult> {
  const emit = (e: AgentEvent) => o.onEvent?.(e);
  const cwd = expandProject(o.project);
  let thread = opts.resume;
  let turn: string | undefined;
  let sessionId: string | undefined;
  let client: AppServer | undefined;
  let owned = false, subscribed = false, ended = false;
  let text = '', error: string | undefined, ok = false;
  let partial = '', itemId = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let interruptTimer: ReturnType<typeof setTimeout> | undefined;
  const tools = new Set<string>();
  const completion = Promise.withResolvers<void>();
  const finish = (success: boolean, why?: string) => {
    if (ended) return;
    ended = true;
    ok = success;
    error = why;
    completion.resolve();
  };
  const closed = (e: Error) => finish(false, e.message);
  const interrupt = () => {
    if (!turn || ended || interruptTimer) return;
    // 正常等 turn/completed；异常时 finally 解除这个线程的订阅，其他线程继续跑。
    interruptTimer = setTimeout(() => finish(false, '等待 Codex 停止超时'), 5_000);
    void client!.call('turn/interrupt', { threadId: thread, turnId: turn }).catch(closed);
  };
  const receive = (method: string, p: any) => {
    if (ended || (p.turnId ?? p.turn?.id) !== turn) return;
    if (method === 'item/agentMessage/delta') {
      if (itemId !== p.itemId) { itemId = p.itemId; partial = ''; }
      partial += p.delta;
      flushTimer ??= setTimeout(() => {
        flushTimer = undefined;
        emit({ kind: 'text', text: partial, itemId, partial: true });
      }, 80);
    } else if (method === 'item/started' || method === 'item/completed') {
      const i = p.item;
      const end = method === 'item/completed';
      if (end && i.type === 'agentMessage') {
        clearTimeout(flushTimer); flushTimer = undefined;
        text = i.text; partial = '';
        emit({ kind: 'text', text, itemId: i.id });
      } else if (end && i.type === 'reasoning' && i.summary?.length) {
        emit({ kind: 'thinking', text: i.summary.join('\n') });
      } else {
        const tool = toolItem(i);
        if (!tool) return;
        if (!tools.has(i.id)) {
          tools.add(i.id);
          emit({ kind: 'tool', id: i.id, name: tool.name, input: tool.input });
        }
        if (end) emit({ kind: 'result', id: i.id, text: tool.output, isError: ['failed', 'declined'].includes(i.status) || !!i.error || !!i.exitCode });
      }
    } else if (method === 'turn/completed') {
      finish(p.turn.status === 'completed', p.turn.error?.message ?? error);
    } else if (method === 'error' && !p.willRetry) {
      error = p.error?.message;
    }
  };
  // readline 可以在同一个 I/O 回调里读到 RPC 响应和通知，先缓存到 turn/start 返回确切 id。
  const early: [string, any][] = [];
  const notify = (method: string, p: any) => turn ? receive(method, p) : early.push([method, p]);
  try {
    o.signal?.throwIfAborted();
    client = await appServer();
    o.signal?.throwIfAborted();
    let { model, effort } = opts;
    // 恢复线程时覆盖上一轮的选项。模板只换模型时，继承的强度也要适用于新模型。
    if ((thread || model) && (!model || !effort)) {
      const { config } = await client.call('config/read', { cwd, includeLayers: false });
      model ||= config.model;
      effort ||= config.model_reasoning_effort;
      if (!model || !effort || (!opts.effort && opts.model && opts.model !== config.model)) {
        const choice = (await listModels(client)).find(m => model ? m.model === model : m.isDefault);
        if (choice) {
          model ||= choice.model;
          if (!opts.effort && !choice.efforts.includes(effort ?? '')) effort = choice.defaultEffort;
        }
      }
      o.signal?.throwIfAborted();
    }
    const options = { cwd, approvalPolicy: 'never', sandbox: opts.sandbox,
      ...(model && { model }), ...(o.systemPrompt.trim() && { developerInstructions: o.systemPrompt }) };
    if (thread) {
      if (client.busy.has(thread)) throw new Error('这个 Codex 线程正在运行');
      client.busy.add(thread); owned = true;
    }
    const res = thread ? await client.call('thread/resume', { ...options, threadId: thread, excludeTurns: true })
      : await client.call('thread/start', options);
    thread = res.thread.id;
    client.busy.add(thread); owned = true; subscribed = true;
    sessionId = 'codex:' + thread;
    o.signal?.throwIfAborted();
    client.events.on('thread:' + thread, notify).on('closed', closed);
    const start = await client.call('turn/start', { threadId: thread, input: input(o.prompt, opts.images), ...(model && { model }), ...(effort && { effort }),
      approvalPolicy: 'never', sandboxPolicy: { type: SANDBOX_POLICY[opts.sandbox] } });
    turn = start.turn.id;
    o.onSteerReady?.(async (prompt, images) => {
      if (ended || o.signal?.aborted) return false;
      try {
        await client!.call('turn/steer', { threadId: thread, expectedTurnId: turn, input: input(prompt, images) });
        return true;
      } catch (e: any) {
        if (/no active turn|not (?:an? )?active|turn.*(?:mismatch|already (?:completed|finished))/i.test(e.message)) return false;
        throw e;
      }
    });
    emit({ kind: 'init', sessionId, cwd, model: res.model });
    for (const [method, params] of early) receive(method, params);
    o.signal?.addEventListener('abort', interrupt, { once: true });
    if (o.signal?.aborted) interrupt();
    await completion.promise;
  } catch (e: any) {
    finish(false, e?.message || 'Codex 已中断');
  } finally {
    ended = true;
    clearTimeout(interruptTimer); clearTimeout(flushTimer);
    o.signal?.removeEventListener('abort', interrupt);
    client?.events.off('thread:' + thread, notify).off('closed', closed);
    if (subscribed) await client!.call('thread/unsubscribe', { threadId: thread }).catch(() => {});
    if (owned) client!.busy.delete(thread!);
  }
  ok = ok && !o.signal?.aborted;
  text = partial || text;
  emit({ kind: 'done', ok, text, sessionId });
  return { ok, text, sessionId, error: ok ? undefined : error };
}
