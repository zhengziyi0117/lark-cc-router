import { createServer, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { claudeDir } from './bins.ts';
import { resolve } from 'node:path';
import { listChats, chatActivity, fetchMessage, replyCard, sendCard, type Chat } from './lark.ts';
import { snapshot, subscribe, broadcast, finishJob, type Job } from './bus.ts';
import { CardBuilder, buildCard, type CardStatus } from './card.ts';
import type { Db, Handled } from './db.ts';
import { runTest, rerunMessage, judgeFor, stopJob, log, botInfo } from './pipeline.ts';
import { DEFAULT_JUDGE_PROMPT, DECISION_CN, pingGateway } from './judge.ts';
import type { Pool } from './store.ts';
import { status as setupStatus, route as setupRoute } from './setup/index.ts';
import { workspaceList } from './setup/workspace.ts';
import {
  DEFAULT_SYSTEM_PROMPT, PERMISSION_MODES, ROOT, expandProject, loadConfig, resolveChat, sanitizeConfig, scopeOf,
  saveConfig, type Config, type EditableConfig, type Mode, type ModeName, type Template,
} from './config.ts';

/** 两个入口各一个库，见 Db */
export type Dbs = Record<ModeName, Db>;

const PAGE_PATH = resolve(ROOT, 'src/page.html');
const SETUP_PATH = resolve(ROOT, 'src/setup.html');

/**
 * 只监听回环：这是个全权限 CC 的操作台，不给局域网开门。要远程就自己 ssh -L。
 * 返回 server 是为了能关掉 —— listen 的 handle 会一直把事件循环撑住，不关进程退不出去。
 */
export function startWeb(cfg: Config, db: Dbs, pool: Pool): Server {
  const server = createServer((req, res) => {
    handle(req, res, cfg, db, pool).catch((e: any) => json(res, 500, { error: e.message }));
  });

  server.on('error', (e: any) => {
    log(`web 起不来（${e.message}）—— 路由照常跑，只是没有 UI`);
    if (e.code === 'EADDRINUSE') log(`   多半是上一个进程没退干净：lsof -ti:${cfg.port} | xargs kill`);
  });
  server.listen(cfg.port, '127.0.0.1', () => log(`web ui: http://127.0.0.1:${cfg.port}`));
  return server;
}

/**
 * 只认本机页面自己发来的请求。只监听回环挡不住浏览器：任何网页都能往 127.0.0.1 发
 * text/plain 的 POST（不触发预检），readBody 照样当 JSON 解析 —— 等于随便哪个页面都能
 * 跑 CC、改权限。所以：
 *   - Host 必须是回环名：挡 DNS rebinding（别人的域名解析到 127.0.0.1 来读 SSE）
 *   - 带了 Origin 就必须跟 Host 同源：挡跨站请求（同源 GET 浏览器可能不带 Origin，curl 也不带）
 *   - POST 必须是 application/json：跨站发这个会触发预检，而这里从不回 CORS 头
 */
export function allowed(method: string | undefined, h: Record<string, string | string[] | undefined>): boolean {
  const host = String(h.host ?? '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  if (h.origin !== undefined && h.origin !== `http://${host}`) return false;
  if (method === 'POST' && !String(h['content-type'] ?? '').startsWith('application/json')) return false;
  return true;
}

async function handle(req: any, res: ServerResponse, cfg: Config, db: Dbs, pool: Pool): Promise<void> {
  if (!allowed(req.method, req.headers)) return void json(res, 403, { error: 'forbidden' });
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const post = req.method === 'POST';

  if (path === '/' || path === '/index.html') return void page(res);
  if (path === '/setup') return void page(res, SETUP_PATH);
  if (path === '/api/setup/status') return void json(res, 200, await setupStatus(cfg));
  const setup = path.startsWith('/api/setup/') ? setupRoute(req.method ?? 'GET', path) : undefined;
  if (setup) return void json(res, 200, await setup(post ? await readBody(req) : Object.fromEntries(url.searchParams), { cfg }));
  if (path === '/vendor/marked.js') return void vendor(res);
  if (path === '/api/events') return sse(res, cfg, db);
  if (path === '/api/chats') return void json(res, 200, { chats: await chats() });
  if (path === '/api/activity') return void json(res, 200, { activity: await activity() });
  if (path === '/api/projects') return void json(res, 200, { workspaces: workspaceList(), canPick: !!pickFolder });
  if (path === '/api/pick-folder' && post && pickFolder) return void json(res, 200, { path: await pickFolder() });
  if (path.startsWith('/api/card/')) return void card(url, res, db);
  if (path === '/api/config' && post) return void save(await readBody(req), res, cfg, pool);
  if (path === '/api/chat' && post) return void setChat(await readBody(req), res, cfg, pool);
  if (path === '/api/run' && post) return void run(await readBody(req), res, cfg, pool, db);
  if (path === '/api/stop' && post) return void stop(await readBody(req), res);
  if (path === '/api/rerun' && post) return void rerun(await readBody(req), res, cfg, pool, db);
  if (path === '/api/resend' && post) return void resend(await readBody(req), res, cfg, db);
  if (path === '/api/judge' && post) return void judge(await readBody(req), res, cfg);
  if (path === '/api/gateway-test' && post) return void gatewayTest(await readBody(req), res, cfg);

  json(res, 404, { error: 'not found' });
}

function page(res: ServerResponse, file = PAGE_PATH): void {
  let html: string;
  try {
    html = readFileSync(file, 'utf8');
  } catch (e: any) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return void res.end(`读不到 ${file}: ${e.message}`);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

/**
 * 页面里要的第三方库直接发 node_modules 里的浏览器构建，不上打包器。
 * marked 零依赖，自带 lib/marked.umd.js，挂个 <script src> 就有全局 marked 了。
 */
const MARKED_JS = resolve(ROOT, 'node_modules/marked/lib/marked.umd.js');
function vendor(res: ServerResponse): void {
  let js: string;
  try {
    js = readFileSync(MARKED_JS, 'utf8');
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return void res.end(`读不到 ${MARKED_JS} —— 先 npm i`);
  }
  res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
  res.end(js);
}

/* ---------- 群 ---------- */

/** 群列表要起 lark-cli —— 缓存住，别让每次刷新页面都去拉一遍 */
let chatCache: { at: number; list: Chat[] } | null = null;
async function chats(): Promise<Chat[]> {
  if (chatCache && Date.now() - chatCache.at < 300_000) return chatCache.list;
  const list = await listChats();
  chatCache = { at: Date.now(), list };
  return list;
}

/**
 * "最近有回话"的具体时间。接口不返回，只能一个群查一次（~1s），所以：
 * 只问最近活跃的前 24 个（够覆盖你真正会勾的群），全并发，结果缓存。
 * ponytail: 想给全部群都标上时间，就得翻页 + 分批并发，先看这 24 个够不够用
 */
const ACTIVITY_N = 24;
let actCache: { at: number; map: Record<string, string> } | null = null;
async function activity(): Promise<Record<string, string>> {
  if (actCache && Date.now() - actCache.at < 300_000) return actCache.map;
  const map = await chatActivity((await chats()).slice(0, ACTIVITY_N).map((c) => c.chatId));
  actCache = { at: Date.now(), map };
  return map;
}

/** 桌面版塞进来的系统「选择文件夹」框（Electron 的 dialog）；命令行版没有，页面就不显示那个按钮 */
let pickFolder: (() => Promise<string | null>) | null = null;
export function setPickFolder(f: () => Promise<string | null>): void { pickFolder = f; }

/**
 * 模型下拉的候选：三个别名 + ~/.claude/settings.json 里 env 配的那几个模型名（网关环境下别名会被
 * 映射成别的，比如 sonnet → 网关自己的模型名，光给别名会误导）。只取 *MODEL 的值，token 之类不碰。
 */
function modelChoices(): string[] {
  const out = new Set(['opus', 'sonnet', 'haiku']);
  try {
    const env = JSON.parse(readFileSync(resolve(claudeDir(), 'settings.json'), 'utf8')).env ?? {};
    for (const [k, v] of Object.entries(env)) if (/MODEL$/.test(k) && typeof v === 'string' && v) out.add(v);
  } catch { /* 没有就只给别名 */ }
  return [...out];
}

/** ~/.claude/settings.json 里的网关地址（只读地址，不碰 token）。没配 = claude 登录的账号（订阅） */
function defaultBaseUrl(): string {
  try {
    return JSON.parse(readFileSync(resolve(claudeDir(), 'settings.json'), 'utf8')).env?.ANTHROPIC_BASE_URL || '订阅（claude 登录的账号）';
  } catch { return '订阅（claude 登录的账号）'; }
}

/* ---------- SSE ---------- */

/** SSE：先订阅再发快照，中间不会漏事件（单线程，同步写完快照才让出） */
function sse(res: ServerResponse, cfg: Config, db: Dbs): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (m: unknown) => res.write(`data: ${JSON.stringify(m)}\n\n`);

  const off = subscribe(send);
  send({ type: 'snapshot', jobs: withHistory(db) });
  send({ type: 'config', config: editorConfig(cfg) });
  res.on('close', off);
}

/**
 * 内存里的实时作业 + 落盘的历史。重启后历史还在，只是没有逐条事件了。
 * ponytail: 快照把每个作业的事件也带上（最多 50×400 条），本机跑无所谓；哪天觉得慢就只带最近几条，其余按需拉
 */
function withHistory(db: Dbs): Job[] {
  const live = snapshot();
  const seen = new Set(live.map((j) => j.id));
  const past = [...db.user.recent(50).map((h) => jobFromRow(h, 'user')), ...db.bot.recent(50).map((h) => jobFromRow(h, 'bot'))]
    .filter((j) => !seen.has(j.id));
  return [...past, ...live];
}

/** 库里的一行 → 作业。没有逐条事件；posted 库里没存 —— "判了不用回"就等于没往群里发过，其余都发过 */
function jobFromRow(h: Handled, mode: ModeName): Job {
  return {
    id: h.msgId, chatId: h.chatId, who: h.who, q: h.q, project: '', mode,
    status: h.status, answer: h.answer, error: h.error,
    events: [], startedAt: h.startedAt, endedAt: h.endedAt, session: h.session, reason: h.reason,
    posted: h.status !== 'skipped', sendError: h.sendError,
  };
}

/* ---------- 卡片预览 ---------- */

/** 把作业的事件流重新折成卡片 —— 跟群里真实发的走同一个 buildCard，预览不会漂移 */
function cardForJob(job: Job, status: CardStatus): unknown {
  const b = new CardBuilder();
  b.chrono = job.mode === 'bot';
  for (const ev of job.events) b.push(ev);
  if (!b.text.trim() && job.answer) b.text = job.answer;
  return buildCard({
    who: job.who, q: job.q, status,
    text: b.text, process: b.process, tools: b.tools, session: b.session, chrono: b.chrono,
  });
}

function card(url: URL, res: ServerResponse, db: Dbs): void {
  const id = decodeURIComponent(url.pathname.slice('/api/card/'.length));
  const live = snapshot().find((j) => j.id === id);
  const past = live ? undefined : (['user', 'bot'] as const)
    .map((m) => { const h = db[m].recent(200).find((x) => x.msgId === id); return h && jobFromRow(h, m); })
    .find(Boolean);
  const job = live ?? past;
  if (!job) return void json(res, 404, { error: '没有这个作业' });

  // ?as=running|done|failed 可以强看某一态 —— 跑完的作业也能看它当时长什么样
  const as = url.searchParams.get('as') as CardStatus | null;
  const status = as && ['running', 'done', 'failed', 'skipped'].includes(as) ? as : (job.status as CardStatus);
  // 没开过话题的作业，卡片只是"攒着的样子"，群里其实什么都没有
  const posted = !!job.posted;
  json(res, 200, { card: cardForJob(job, status), status, live: !!live, posted, events: job.events.length });
}

/* ---------- 配置 ---------- */

/** 网关下发到页面时**去掉 token**，只说有没有 —— 页面上看得到的东西别带密钥 */
export function publicTemplate(t: Template): Omit<Template, 'gateway'> & { gateway?: { baseUrl: string; hasToken: boolean } } {
  const { gateway, ...rest } = t;
  return gateway ? { ...rest, gateway: { baseUrl: gateway.baseUrl, hasToken: !!gateway.token } } : rest;
}

/**
 * 一个入口的那份，外加每个绑过的会话实际用的模板（去掉 token），前端直接拿去显示。
 * `fallback` = 没单独绑的会话用的那套 —— 机器人谁找都回，多数会话走它。
 */
function modeView(cfg: Config, mode: ModeName) {
  const sc = scopeOf(cfg, mode);
  // 网关取叠完的（模板没配就是默认网关），页面上显示的才是真打到哪
  const pub = (id: string) => {
    const r = resolveChat(sc, id);
    return { ...publicTemplate({ ...cfg.templates[r.template], gateway: r.gateway }), template: r.template };
  };
  return {
    on: sc.on, defaultTemplate: sc.defaultTemplate, chats: sc.chats, allP2p: sc.allP2p, allGroups: sc.allGroups,
    resolved: Object.fromEntries(Object.keys(sc.chats).map((id) => [id, pub(id)])),
    fallback: pub(''),
  };
}

/** 配置面板读的东西。模板一律用 loadConfig 迁移 / 归一化后的值 */
export function editorConfig(cfg: Config) {
  return {
    templates: Object.fromEntries(Object.entries(cfg.templates).map(([k, t]) => [k, publicTemplate(t)])),
    user: modeView(cfg, 'user'),
    /** name：认出来的机器人叫什么（没开 / 还没认出来 = 空） */
    bot: { ...modeView(cfg, 'bot'), name: botInfo()?.name ?? '' },
    pollMs: cfg.pollMs,
    maxJobs: cfg.maxJobs,
    judgeModel: cfg.judgeModel,
    defaultBaseUrl: cfg.gateway ? `${cfg.gateway.baseUrl}（config.json 的 gateway）` : `${defaultBaseUrl()}（~/.claude/settings.json）`,
    me: cfg.me,
    port: cfg.port,
    defaultPrompt: DEFAULT_SYSTEM_PROMPT,
    defaultJudge: DEFAULT_JUDGE_PROMPT,
    modes: PERMISSION_MODES,
    models: modelChoices(),
  };
}

/**
 * 真会跑起来的那些「会话 → 模板」：每个开着的入口的白名单；开了「所有私聊 / 所有群」的话，
 * 没勾的会话走默认模板，默认模板也算在用。@我 关着也照算它的白名单 —— 关只是暂停，配置得是好的
 */
function inUse(c: Pick<Config, 'templates' | 'user' | 'bot'>) {
  return (['user', 'bot'] as const).filter((k) => k === 'user' || c.bot.on).flatMap((k) => {
    const m = c[k];
    const ids = [...Object.keys(m.chats), ...(m.allP2p || m.allGroups ? [''] : [])];
    return ids.map((id) => resolveChat({ templates: c.templates, ...m }, id));
  });
}

/** 落盘 + 热更新 + 推给所有页面。返回用到的项目里不存在的路径 */
function commit(patch: Partial<EditableConfig>, cfg: Config, pool: Pool): string[] {
  saveConfig(patch);
  // 热更新：轮询循环每轮读 cfg.pollMs（当前这一觉睡完就换），并发上限直接改 Pool
  Object.assign(cfg, loadConfig(), { me: cfg.me }); // me 不在文件里，是启动时从 lark-cli 认的
  pool.resize(cfg.maxJobs);
  broadcast({ type: 'config', config: editorConfig(cfg) });
  return [...new Set(inUse(cfg).map((r) => r.project))]
    .filter((p) => p && !existsSync(expandProject(p)))
    .map((p) => `路径不存在：${p}`);
}

/** 真会跑的会话里有没有落到"没配项目"的模板上 —— 挡在这儿，别让空 cwd 起 claude */
function noProjectError(next: Pick<Config, 'templates' | 'user' | 'bot'>): string | undefined {
  const names = [...new Set(inUse(next).filter((r) => !r.project).map((r) => r.template))];
  if (!names.length) return;
  return `模板「${names.join('」「')}」没配项目，先去设置里填上`;
}

/** 设置面板保存：模板 + 通用 + 白名单整份。前端传来的东西一律不信 */
async function save(body: any, res: ServerResponse, cfg: Config, pool: Pool): Promise<void> {
  const next = sanitizeConfig(body, cfg);
  const err = noProjectError(next);
  if (err) return void json(res, 400, { error: err });
  const warnings = commit(next, cfg, pool);
  log(`config saved: @我 ${next.user.on ? `${Object.keys(next.user.chats).length} 个会话` : '关'}, @机器人 ${next.bot.on ? '开' : '关'}, ${Object.keys(next.templates).length} 个模板`);
  json(res, 200, { ok: true, warnings });
}

/**
 * 会话头上那个开关 / 模板下拉：只改这一个会话的这一个入口，立刻生效。on=false = 移出白名单。
 * 不走整份保存 —— 设置面板里可能还有没保存的改动，这里不该把它们带出去。
 */
async function setChat(body: any, res: ServerResponse, cfg: Config, pool: Pool): Promise<void> {
  const id = String(body?.chatId ?? '').trim();
  if (!id) return void json(res, 400, { error: '缺 chatId' });
  const mode: ModeName = body?.mode === 'bot' ? 'bot' : 'user';
  const chats = { ...cfg[mode].chats };
  const off = body?.on === false;
  if (off) delete chats[id];
  else chats[id] = typeof body?.template === 'string' ? body.template : (chats[id] ?? '');
  const next = sanitizeConfig({ ...cfg, [mode]: { ...cfg[mode], chats } }, cfg);
  const m: Mode = next[mode];
  if (!off && !resolveChat({ templates: next.templates, ...m }, id).project) {
    return void json(res, 400, { error: `模板「${resolveChat({ templates: next.templates, ...m }, id).template}」没配项目，先去设置里填上` });
  }
  const warnings = commit({ [mode]: m }, cfg, pool);
  log(`chat ${id} ${mode === 'bot' ? '@机器人' : '@我'}: ${off ? '关' : `开（${resolveChat(scopeOf(cfg, mode), id).template}）`}`);
  json(res, 200, { ok: true, warnings });
}

/* ---------- 试跑 ---------- */

function run(body: any, res: ServerResponse, cfg: Config, pool: Pool, db: Dbs): void {
  const prompt = String(body?.prompt ?? '').trim();
  const chatId = String(body?.chatId ?? '').trim();
  // 试跑按 @我 那套解析会话（选的会话就是我的会话列表）；模板是共用的，项目也能手填覆盖
  const sc = scopeOf(cfg, 'user');
  const project = String(body?.project ?? '').trim() || resolveChat(sc, chatId).project;
  const resume = String(body?.resume ?? '').trim();
  if (!prompt) return void json(res, 400, { error: '先写一句要问的话' });
  if (!project) return void json(res, 400, { error: '这个会话的模板没配项目，去「模板」里填上' });
  if (!existsSync(expandProject(project))) return void json(res, 400, { error: `项目路径不存在：${project}` });

  json(res, 200, { id: runTest(sc, pool, db.user, { chatId, project, prompt, resume: resume || undefined }) });
}

/** 真消息的「再跑一次」：回原会话、用原身份重新处理（见 rerunMessage）。试跑的没有原会话，还是走 /api/run */
async function rerun(body: any, res: ServerResponse, cfg: Config, pool: Pool, db: Dbs): Promise<void> {
  const id = String(body?.id ?? '');
  const mode: ModeName = body?.mode === 'bot' ? 'bot' : 'user';
  if (!/^om_[\w-]+$/.test(id)) return void json(res, 400, { error: '只有飞书里来的作业能回原会话重跑' });
  try {
    await rerunMessage(cfg, pool, db[mode], id, mode);
    json(res, 200, { ok: true });
  } catch (e: any) {
    json(res, 409, { error: e.message });
  }
}

/**
 * 「重发到飞书」：CC 跑完了，只是卡片没发出去 / 收尾那帧没改上。不重跑，把结论重新发成一张新卡片 ——
 * 飞书来的回到原会话（原身份），试跑的发给自己。发出去了这条才算成功
 */
async function resend(body: any, res: ServerResponse, cfg: Config, db: Dbs): Promise<void> {
  const id = String(body?.id ?? '');
  const mode: ModeName = body?.mode === 'bot' ? 'bot' : 'user';
  const live = snapshot().find((j) => j.id === id);
  const row = live ? undefined : db[mode].get(id);
  const job = live ?? (row && jobFromRow(row, mode));
  if (!job) return void json(res, 404, { error: '找不到这条作业' });
  if (job.status === 'running') return void json(res, 409, { error: '还在跑，等它跑完' });
  if (!job.answer) return void json(res, 409, { error: '没有结论可发，用「再跑一次」' });
  // 只是卡片的问题（CC 本身跑成了）就是「已完成」；CC 也没跑完就照实发「已中断」
  const card = cardForJob(job, !job.error || job.error.startsWith('飞书卡片') ? 'done' : 'failed');
  try {
    if (job.test) {
      if (!cfg.me) throw new Error('飞书还没登录（lark-cli），认不出你是谁');
      await sendCard(cfg.me, card);
    } else {
      if (!/^om_[\w-]+$/.test(id)) throw new Error('消息 id 不对');
      const m = await fetchMessage(id, mode);
      if (!m) throw new Error('原消息取不到了：被撤回了，或者没权限');
      db[mode].delivered(id, await replyCard(id, card, m.chat_type !== 'p2p', mode));
    }
  } catch (e: any) {
    return void json(res, 502, { error: `还是没发出去：${e.message}` });
  }
  log(`web 重发 ${id}`);
  const patch = { status: 'done' as const, error: undefined, sendError: undefined, posted: true };
  if (live) finishJob(id, patch);
  else { const { events, ...meta } = { ...job, ...patch }; broadcast({ type: 'job', job: meta }); } // 历史作业不在内存里，直接推给页面
  json(res, 200, { ok: true });
}

/** 后台终止一个在跑的作业（群里 @ 的或试跑的） */
function stop(body: any, res: ServerResponse): void {
  const id = String(body?.id ?? '');
  if (!stopJob(id)) return void json(res, 409, { error: '没在跑（跑完了，或者还在判定那一两秒，稍后再点）' });
  log(`web 终止 ${id}`);
  json(res, 200, { ok: true });
}

/**
 * 只看判定：这句话丢进这个会话会被判成什么。调提示词时用，不起 CC、不发飞书。
 * 当成"新问题"判（不是追问）；@ 只算 @ 了我。
 */
async function judge(body: any, res: ServerResponse, cfg: Config): Promise<void> {
  const prompt = String(body?.prompt ?? '').trim();
  const chatId = String(body?.chatId ?? '').trim();
  if (!prompt) return void json(res, 400, { error: '先写一句要问的话' });
  const m = {
    message_id: 'judge-preview', chat_id: chatId, message_position: '', content: prompt,
    chat_type: body?.p2p === true ? 'p2p' : 'group',
    sender: { id: 'ou_preview', name: '试跑', sender_type: 'user' }, mentions: [{ id: cfg.me }],
  };
  const v = await judgeFor(scopeOf(cfg, 'user'), m, false);
  if (!v) return void json(res, 200, { none: true });
  json(res, 200, { decision: v.decision, label: DECISION_CN[v.decision], reason: v.reason });
}

/**
 * 测网关通不通。页面上没有已存的 token，所以：传了 token 就用传的（刚填还没保存），
 * 没传就用这个模板（改过名的按 from）已存的那个。地址也不传 = 测 ~/.claude/settings.json 那套。
 */
async function gatewayTest(body: any, res: ServerResponse, cfg: Config): Promise<void> {
  const name = String(body?.from || body?.template || '');
  const baseUrl = String(body?.baseUrl ?? '').trim();
  const saved = cfg.templates[name]?.gateway;
  if (baseUrl && !/^https?:\/\/\S+$/.test(baseUrl)) return void json(res, 400, { error: '地址要是 http(s)://…' });
  const gw = baseUrl ? { baseUrl, token: typeof body?.token === 'string' && body.token ? body.token : saved?.token } : cfg.gateway;
  json(res, 200, await pingGateway(String(body?.model || cfg.judgeModel), gw));
}

/* ---------- 杂 ---------- */

async function readBody(req: any): Promise<any> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
}

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
