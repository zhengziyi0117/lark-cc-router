import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { apiEnv, expandProject, HOME_DIR, JUDGE_MODEL, loadConfig, migrate, publicApi, rawConfig, resolveChat, routingTemplates, sanitizeApis, sanitizeDecisionApi, saveConfig, type Api, type Config, type Template } from '../config.ts';
import { bin, killTree, WIN } from '../bins.ts';
import { codexConnection, codexSettings, updateCodexSettings } from '../codex.ts';
import { broadcast } from '../bus.ts';
import { decisionTarget, judgeTargets, pingDecisionApi, pingGateway } from '../judge.ts';
import { apiHealth } from '../pipeline.ts';
import { NEED } from '../app.ts';
import { userAuth } from '../lark.ts';
import { gitEnv } from './git.ts';
import { git } from './workspace.ts';
import { preset } from './preset.ts';
import { progress, type Check, type Handler, type Section } from './types.ts';

/**
 * 向导的「模型」「飞书」「插件」三段。都是包一层外部命令：lark-cli 管应用和登录，claude 管插件和 MCP。
 * 慢的（测网关、claude mcp list 的健康检查）后台跑、记结果，sections() 只读缓存 + 一次 lark-cli auth status（~0.1s）。
 */

/* ---------- 子进程 ---------- */

export interface Run { code: number; out: string; err: string }

/** 跑完拿输出，不抛：没装、超时、退出码非 0 都落在 code 上。stdin 一律关掉 —— 万一它想问点什么，别挂在那儿等 */
function run(file: string, args: string[], o: { input?: string; cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const c = execFile(file, args, { cwd: o.cwd, env: o.env, timeout: o.timeout ?? 60_000, maxBuffer: 16 << 20, windowsHide: true },
      (e: any, out, err) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : -1) : 0, out: String(out ?? ''), err: String(err || e?.message || '') }));
    c.stdin?.on('error', () => {}).end(o.input ?? '');
  });
}

/**
 * 出错时最像人话的那句。lark-cli 吐 JSON 的 error.message，但前面可能还垫着一行字（config init 是先
 * "OK: Configuration saved" 再报 app 不存在），所以按字段抠，不 parse 整段；claude 吐的是一行字，取最后一行
 */
export function why(r: Run): string {
  if (/ENOENT/.test(r.err)) return '还没装（见第一步）';
  const m = /"message"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(r.err + r.out);
  if (m) try { return JSON.parse(m[1]); } catch { /* 转义坏了就按普通文字取 */ }
  return (r.err.trim() || r.out.trim()).split('\n').filter((l) => l.trim()).pop()?.slice(0, 300) || `退出码 ${r.code}`;
}

/* ---------- 模型 ---------- */

const keyOf = (a: Api) => JSON.stringify([a.kind, a.baseUrl, a.token, a.models]);

/**
 * 网关上要测的模型名 → 哪几档用它。opus / sonnet 只测填了映射的（没填的用 Claude Code 自己的名字，
 * 具体叫什么随版本变，测不了）；haiku 那档判定和 claude 的后台小任务都要用，没填也测原名
 */
export function probeNames(a: Api): [string, string[]][] {
  const m = new Map<string, string[]>();
  const add = (name: string, tier: string) => m.set(name, [...(m.get(name) ?? []), tier]);
  if (a.models?.opus) add(a.models.opus, 'opus');
  if (a.models?.sonnet) add(a.models.sonnet, 'sonnet');
  add(a.models?.haiku || JUDGE_MODEL, 'haiku');
  return [...m];
}

/** 把网关上要用到的名字都打一遍。一个不认就算没通：说清是哪档、在「快」「强」哪格改 */
async function probeGateway(a: Api): Promise<{ ok: boolean; detail: string; ms: number }> {
  const names = probeNames(a);
  const rs = await Promise.all(names.map(([n]) => pingGateway(n, { baseUrl: a.baseUrl!, token: a.token })));
  const ok = rs.every((r) => r.ok);
  const detail = names.map(([n, tiers], i) => `${tiers.join(' / ')} → ${n} ${rs[i].ok ? '✓' : `✗ ${rs[i].detail}`}`).join('；')
    + (ok ? '' : '。不认的那档在这个来源上填它认的模型名');
  return { ok, detail, ms: Math.max(...rs.map((r) => r.ms)) };
}

/** 上次测的结果。向导每次刷新都调 sections()，不能每次真打一遍 —— 配置变了（key 对不上）才重测 */
let tested: { key: string; ok: boolean; detail: string } | undefined;
let testing = '';

/** 向导只看第一个来源（平时用的就是它），后面的是备用 */
function modelSection(cfg: Config): Section {
  const check = (state: Check['state'], detail: string): Section =>
    ({ id: 'model', title: '模型', checks: [{ id: 'gateway', label: 'API 来源', state, detail }] });
  const a = cfg.apis[0];
  if (!a) return check('missing', '还没配：网关或 Claude 订阅，至少一个');
  const more = cfg.apis.length > 1 ? `；另有 ${cfg.apis.length - 1} 个备用，出问题自动换` : '';
  if (a.kind === 'subscription') return check('ok', `「${a.name}」Claude 订阅${more}`);
  if (!a.token) return check('missing', `「${a.name}」还没填令牌`);
  const key = keyOf(a);
  if (tested?.key === key) return check(tested.ok ? 'ok' : 'error', `「${a.name}」${tested.detail}${more}`);
  if (testing !== key) {
    testing = key;
    void probeGateway(a).then((r) => {
      tested = { key, ok: r.ok, detail: r.detail };
      if (testing === key) testing = '';
      progress('model', r.detail, { ok: r.ok });
    });
  }
  return check('running', '正在测网关…');
}

/** 测一个来源通不通。网关把要用到的模型名都打一下；订阅不能直接调 API（令牌只认 Claude Code），让 claude 自己答一句 */
async function testApi(a: Api): Promise<{ ok: boolean; detail: string; ms?: number }> {
  if (a.kind === 'gateway') return probeGateway(a);
  const t0 = Date.now();
  const env = { ...process.env, ...apiEnv(a) };
  const r = await run(bin('claude'), ['-p', '只回一个字：好'], { env, timeout: 90_000 });
  return r.code === 0 ? { ok: true, detail: `通了：${r.out.trim().slice(0, 40)}`, ms: Date.now() - t0 } : { ok: false, detail: why(r) };
}

/**
 * 落盘之后跟 web.ts 的 commit 一样：热更新全进程共享的那个 cfg，再推给所有页面 ——
 * 不推的话主页设置抽屉拿旧快照一保存，就把这里改的模型盖回去（见 bus.broadcast）。
 * editorConfig 要 web.ts 导出；动态 import 是因为 web.ts → setup/index.ts → 这里，静态引会绕成环
 */
async function publish(cfg: Config): Promise<void> {
  Object.assign(cfg, loadConfig(), { me: cfg.me }); // me 不在文件里，是启动时从 lark-cli 认的
  const web: any = await import('../web.ts');
  if (typeof web.editorConfig === 'function') broadcast({ type: 'config', config: web.editorConfig(cfg) });
}

/**
 * 存 API 来源表。改了名的，固定用它的模板跟着改名；删掉的，固定用它的模板就不固定了。
 * 判定用哪个模型跟着来源的 haiku 那档走，网关认不认在「测一下」和向导里看得到，这里不替人改
 */
const saveApis: Handler = async (body, { cfg }) => {
  const { apis, errors } = sanitizeApis(body?.apis, cfg.apis);
  if (errors.length) return { ok: false, error: errors.join('；') };
  const renamed = new Map<string, string>();
  for (const o of Array.isArray(body?.apis) ? body.apis : []) if (o?.from && o.from !== String(o.name ?? '').trim()) renamed.set(String(o.from), String(o.name).trim());
  // 模板从文件读，不拿内存里的 cfg：那份被 SELF=1 之类的调试开关改过，写回去就落盘了
  const raw = migrate(rawConfig());
  const templates = Object.fromEntries(Object.entries<any>(raw.templates ?? {}).map(([k, t]) => {
    const { api, ...rest } = t ?? {};
    const n = renamed.get(api) ?? api;
    return [k, apis.some((a) => a.name === n) ? { ...rest, api: n } : rest];
  }));
  saveConfig({ apis, templates });
  await publish(cfg);
  return { ok: true };
};

/** 测表里的一条（可能刚改、还没存）。令牌没传就用存着的那个（改过名的按 from 找） */
const testOne: Handler = async (body, { cfg }) => {
  const { apis, errors } = sanitizeApis([body], cfg.apis);
  if (!apis[0]) return { ok: false, error: errors[0] ?? '填得不对' };
  // 包一层：测不通不算接口出错（ok:false 页面会当成异常抛）
  return { result: await testApi(apis[0]) };
};

/** 测 Google Decisions API 通不通（可能刚改、还没存）。apiKey 没传沿用已存的或环境变量 GEMINI_API_KEY */
const testDecisionApi: Handler = async (body, { cfg }) => {
  const { decisionApi, error } = sanitizeDecisionApi(body, cfg.decisionApi);
  if (error) return { ok: false, error };
  const apiKey = (decisionApi?.apiKey || process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return { ok: false, error: '先填一个 Google AI Studio API Key' };
  return { result: await pingDecisionApi({ apiKey, baseUrl: decisionApi?.baseUrl, model: decisionApi?.model }) };
};

/* ---------- 飞书 ---------- */

/** 一次 auth status 同时看两件事：配没配应用（没配它直接报 not configured）、用户登没登录 + 有没有 @我 必需的 scope */
async function larkSection(): Promise<Section> {
  const r = await run(bin('lark-cli'), ['auth', 'status', '--json'], { timeout: 10_000 });
  const { appId, appSecret } = preset().larkApp;
  const login = { label: '扫码登录', route: '/api/setup/lark/login', body: {} };
  const sec = (...checks: Check[]): Section => ({ id: 'lark', title: '飞书', checks });

  let s: any;
  try { s = r.code === 0 ? JSON.parse(r.out) : undefined; } catch { /* 下面按没配处理 */ }
  if (!s?.appId) {
    const detail = /not.configured/.test(r.err + r.out) ? '还没配飞书应用' : why(r);
    return sec(
      { id: 'app', label: '飞书应用', state: 'missing', detail,
        action: appId && appSecret ? { label: '用团队的应用', route: '/api/setup/lark/app', body: {} } : undefined },
      { id: 'login', label: '登录飞书', state: 'missing', detail: '先配好应用' },
    );
  }
  const u = s.identities?.user ?? {};
  const scopes = String(u.scope ?? '').split(/\s+/);
  const lack = NEED.filter((x) => !scopes.includes(x));
  const user: Check = !u.openId ? { id: 'login', label: '登录飞书', state: 'missing', detail: '还没登录', action: login }
    : lack.length ? { id: 'login', label: '登录飞书', state: 'missing', detail: `缺权限 ${lack.join(' ')}，重新扫一次码`, action: login }
    : { id: 'login', label: '登录飞书', state: 'ok', detail: u.userName || u.openId };
  return sec({ id: 'app', label: '飞书应用', state: 'ok', detail: s.appId }, user);
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** 绑定已有应用（换应用也走这儿）。都不填 = 团队预置的那个；secret 走 stdin，不进命令行（ps 看得到） */
const larkApp: Handler = async (body, { cfg }) => {
  const p = preset().larkApp;
  const appId = str(body?.appId) || p.appId;
  const secret = str(body?.appSecret) || (appId === p.appId ? p.appSecret : '');
  if (!/^cli_\w+$/.test(appId) || !secret) return { ok: false, error: '要填 App ID（cli_ 开头）和 App Secret' };
  const r = await run(bin('lark-cli'), ['config', 'init', '--app-id', appId, '--app-secret-stdin'], { input: `${secret}\n` });
  if (r.code !== 0) return { ok: false, error: why(r) };
  // 换应用会清掉登录：「我」也清了，轮询就会停下来等重新扫码，而不是拿着旧身份一轮轮报错
  cfg.me = '';
  return { ok: true };
};

/** lark-cli 只肯往 cwd、/tmp、~/files 底下写 PNG（Windows 没有 /tmp）：cwd 设成临时目录、给相对路径 */
async function qrcode(url: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'lcr-qr-'));
  try {
    const r = await run(bin('lark-cli'), ['auth', 'qrcode', url, '--output', 'qr.png'], { cwd: dir });
    if (r.code !== 0) throw new Error(why(r));
    return `data:image/png;base64,${readFileSync(join(dir, 'qr.png')).toString('base64')}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 在等扫码的那个 `--device-code`。只等最新的一个：点了两次「扫码」，旧码作废 */
let waiting: ChildProcess | undefined;

const larkLogin: Handler = async (_b, { cfg }) => {
  const scope = [...new Set([...NEED, ...preset().larkScopes.split(/\s+/)])].filter(Boolean).join(' ');
  const r = await run(bin('lark-cli'), ['auth', 'login', '--no-wait', '--json', '--scope', scope]);
  let j: any = {};
  try { j = JSON.parse(r.out); } catch { /* 下面报错 */ }
  if (r.code !== 0 || !j.device_code) return { ok: false, error: why(r) };

  if (waiting) killTree(waiting);
  // --device-code 一直阻塞到扫完（或者码过期），结果推 SSE
  const c = spawn(bin('lark-cli'), ['auth', 'login', '--device-code', j.device_code, '--json'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  waiting = c;
  const res: Run = { code: -1, out: '', err: '' };
  c.stdout!.on('data', (d) => { res.out += d; });
  c.stderr!.on('data', (d) => { res.err += d; });
  const done = (code: number) => {
    if (waiting !== c) return; // 被新的一次顶掉了，或者 error 之后又来了 close
    waiting = undefined;
    // 重新扫码可能换了个人（lark-cli 登录是替换不是追加）：「我」马上跟着换，不用重启
    if (code === 0) void userAuth().then((u) => { cfg.me = u.openId; }).catch(() => {});
    progress('lark', code === 0 ? '飞书登录好了' : `登录没成：${why({ ...res, code })}`, { ok: code === 0 });
  };
  c.on('error', (e) => { res.err += e.message; done(-1); });
  c.on('close', (code) => done(code ?? -1));

  return { url: j.verification_url, qr: await qrcode(j.verification_url).catch(() => ''), expiresIn: j.expires_in };
};

/* ---------- 插件 + MCP ---------- */

/** `claude plugin list --available --json` 的 installed 一项。mcpServers 里可能带 token（请求头），只在服务端用、不下发 */
interface Installed { id: string; version?: string; enabled?: boolean; installPath?: string; mcpServers?: Record<string, unknown> }
/** 同上的 available 一项：加过的市场里能装的 */
interface Available { pluginId: string; name: string; description?: string; marketplaceName: string; version?: string }

/** `claude mcp list` → 名字 → 状态。一行一个：`<名字>: <地址或命令> - <图标> <状态>`，名字里自己带冒号（plugin:x:BAT） */
export function parseMcpList(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of out.split('\n')) {
    const r = /^(\S.*?): .* - (?:[^\w\s]+ )?(.+)$/.exec(l.trim());
    if (r) m.set(r[1], r[2].trim());
  }
  return m;
}

/** 状态 → check。没出结果 = running；要授权 = 能点「授权」修；其它（连不上之类）用户修不了 */
export function mcpState(s: string | undefined): Check['state'] {
  if (s === undefined) return 'running';
  return /^Connected/i.test(s) ? 'ok' : /auth/i.test(s) ? 'missing' : 'error';
}

/** 插件和 MCP 的缓存。mcp list 要做健康检查（几秒），不能在 sections() 里现跑。undefined = 还没扫完 */
let installed: Installed[] | undefined;
let available: Available[] = [];
let markets: { name: string; url?: string; source?: string; path?: string }[] = [];
let mcp: Map<string, string> | undefined;
let scanErr = '';
let scanning: Promise<void> | undefined;
let rescan = false;
const installing = new Set<string>();

/**
 * 偶尔（刚起服务、几个 claude 同时起的时候）读钥匙串会失败，报「Couldn't read the stored credentials… keychain is locked」，
 * 隔一会儿再查就好了。实测过一次：不重试的话向导会一直挂着这个吓人的报错，直到手动点「重新检测」
 */
async function mcpList(): Promise<Map<string, string>> {
  let m = parseMcpList((await run(bin('claude'), ['mcp', 'list'])).out);
  if ([...m.values()].some((v) => /keychain/i.test(v))) {
    await new Promise((r) => setTimeout(r, 2000));
    m = parseMcpList((await run(bin('claude'), ['mcp', 'list'])).out);
  }
  return m;
}

/** 后台重扫。扫的时候又要扫（刚装完插件）就扫完再来一遍，免得拿到装之前的结果 */
function refresh(): Promise<void> {
  if (scanning) { rescan = true; return scanning; }
  return scanning = (async () => {
    try {
      do {
        rescan = false;
        await Promise.all([
          // --available 顺带拿到能装的（读本地市场缓存，不联网，一秒内）。老版本 claude 没这个参数会吐数组，照样认
          run(bin('claude'), ['plugin', 'list', '--available', '--json']).then((r) => {
            try {
              const d = r.code === 0 ? JSON.parse(r.out) : [];
              installed = Array.isArray(d) ? d : d.installed ?? [];
              available = Array.isArray(d) ? [] : d.available ?? [];
              scanErr = r.code === 0 ? '' : why(r);
            } catch { installed = []; scanErr = '插件列表认不出来'; }
          }),
          run(bin('claude'), ['plugin', 'marketplace', 'list', '--json']).then((r) => {
            try { markets = r.code === 0 ? JSON.parse(r.out) : markets; } catch { /* 认不出来就留着上次的 */ }
          }),
          mcpList().then((m) => { mcp = m; }),
        ]);
      } while (rescan);
    } finally {
      scanning = undefined;
    }
  })();
}

const short = (plugin: string) => plugin.split('@')[0];

/** 预置插件实际带的 MCP（全名，跟 claude mcp list 里一样）。授权只认这些 —— 名字要拼进终端脚本 */
function mcpNames(id: string): string[] {
  return Object.keys(installed?.find((x) => x.id === id)?.mcpServers ?? {}).map((k) => `plugin:${short(id)}:${k}`);
}

function pluginSection(): Section {
  const plugins = preset().plugins;
  if (plugins.length && !installed && !scanning) void refresh().then(() => progress('plugin', '插件状态查好了', { ok: !scanErr }));
  const checks: Check[] = [];
  for (const p of plugins) {
    const id = `plugin:${p.plugin}`;
    const label = short(p.plugin);
    if (installing.has(p.plugin) || !installed) {
      checks.push({ id, label, state: 'running', detail: installing.has(p.plugin) ? '安装中…' : '检查中…' });
      continue;
    }
    if (!installed.some((x) => x.id === p.plugin)) {
      checks.push({ id, label, state: scanErr ? 'error' : 'missing', detail: scanErr || p.note,
        action: { label: '安装', route: '/api/setup/plugin/install', body: { plugin: p.plugin } } });
      continue;
    }
    checks.push({ id, label, state: 'ok', detail: p.note });
    for (const name of mcpNames(p.plugin)) {
      const s = mcp?.get(name);
      const state = logins.has(name) ? 'running' : mcp && s === undefined ? 'error' : mcpState(s);
      checks.push({
        id: `mcp:${name}`, label: name.split(':').pop()!, state,
        detail: logins.has(name) ? '等你在浏览器里登录、同意授权…' : s ?? (mcp ? 'claude mcp list 里没有它' : '检查中…'),
        // 都不拦整体就绪：没授权只是少一类取证工具，查代码照样能答；连不上也不是用户能修的（服务挂了、没连内网）
        optional: true,
        // 等授权的时候给个「重新打开」：浏览器没弹出来、或者不小心关了授权页，点它重来一遍
        action: state === 'missing' || logins.has(name) ? { label: logins.has(name) ? '重新打开' : '授权', route: '/api/setup/mcp/login', body: { name } } : undefined,
      });
    }
  }
  return { id: 'plugin', title: '插件', checks };
}

/**
 * Windows 上 `claude plugin marketplace add <git 地址>` 先 clone 到临时目录再改名，杀毒软件在扫刚写下的文件就会把改名卡住
 * （EBUSY / EPERM，私有仓库几乎回回撞上，Claude Code 的已知 bug）。退路：我们自己 clone 到这儿（工作区就是这么拉的，没事），
 * 把本地目录登记成市场 —— claude 直接读，不改名。代价是 claude 不再自己更新它，「更新」时我们先 pull（见 ccMarket）
 */
const MIRRORS = join(HOME_DIR, 'marketplaces');
async function mirror(url: string): Promise<string> {
  const dir = join(MIRRORS, basename(url).replace(/\.git$/, ''));
  if (existsSync(join(dir, '.git'))) await git(['pull', '-q', '--ff-only'], dir);
  else { mkdirSync(MIRRORS, { recursive: true }); await git(['clone', '-q', '--', url, dir], MIRRORS); }
  return dir;
}
const isMirror = (path?: string) => !!path && !relative(MIRRORS, path).startsWith('..') && !isAbsolute(relative(MIRRORS, path));

/** 加 marketplace + 装插件。marketplace 是 SSH 地址，产品同学没 key：带上 gitEnv，有 GitLab token 就改走 HTTPS */
const installPlugin: Handler = async (body) => {
  const p = preset().plugins.find((x) => x.plugin === body?.plugin);
  if (!p) return { ok: false, error: '不是预置的插件' };
  if (installing.has(p.plugin)) return { started: true };
  installing.add(p.plugin);
  void (async () => {
    const env = { ...process.env, ...gitEnv() };
    progress('plugin', `拉插件市场 ${p.marketplace}`);
    let r = await run(bin('claude'), ['plugin', 'marketplace', 'add', p.marketplace], { env, timeout: 300_000 });
    if (r.code !== 0 && /EBUSY|EPERM/.test(r.err + r.out)) {
      progress('plugin', '目录被占住改不了名（多半是杀毒软件在扫），改成先拉到本地再登记');
      r = await mirror(p.marketplace).then(
        (dir) => run(bin('claude'), ['plugin', 'marketplace', 'add', dir], { env, timeout: 300_000 }),
        (e: any): Run => ({ code: 1, out: '', err: e.message }));
    }
    if (r.code === 0) {
      progress('plugin', `安装 ${p.plugin}`);
      r = await run(bin('claude'), ['plugin', 'install', p.plugin], { env, timeout: 300_000 });
    }
    installing.delete(p.plugin);
    await refresh();
    progress('plugin', r.code === 0 ? `${short(p.plugin)} 装好了` : `安装失败：${why(r)}`, { ok: r.code === 0 });
  })();
  return { started: true };
};

const TIP = '浏览器里授权完，这个窗口可以关了，向导会自己打勾。';

/**
 * Windows 才用：开系统终端窗口用的脚本（mac 走伪终端，见 loginInBackground）。`claude mcp login` 没有 TTY 不干，
 * Windows 上又没有现成的伪终端，只能让它在真终端里跑。
 * CLAUDE_CONFIG_DIR 只在设了的时候带：claude 按它区分凭证存哪，显式设成 ~/.claude 跟不设可能不是一回事
 */
export function terminalScript(win: boolean, o: { claude: string; name: string; configDir?: string; cwd: string }): { ext: string; content: string; env: Record<string, string> } {
  if (win) return {
    ext: '.cmd',
    // 值一律不写进脚本，走环境变量（start 开的新窗口继承它们，CLAUDE_CONFIG_DIR 本来就在里面）：cmd 按系统代码页
    // （中文 Windows 是 GBK）读 .cmd，用户名是中文的话 UTF-8 写进去的路径就乱了；也省得操心 % ^ & 怎么转义
    content: ['@echo off', '"%LCR_TERM_CLAUDE%" mcp login "%LCR_TERM_NAME%"', 'echo.', 'echo %LCR_TERM_TIP%', 'pause', ''].join('\r\n'),
    env: { LCR_TERM_CLAUDE: o.claude, LCR_TERM_NAME: o.name, LCR_TERM_TIP: TIP },
  };
  // Terminal 开的是新的登录 shell，不继承我们的环境变量，只能写死在脚本里。单引号里什么都不转义，单引号本身写成 '\''
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return {
    ext: '.command',
    content: [
      '#!/bin/sh',
      ...(o.configDir ? [`export CLAUDE_CONFIG_DIR=${q(o.configDir)}`] : []),
      `cd ${q(o.cwd)} || exit 1`,
      `${q(o.claude)} mcp login ${q(o.name)}`,
      `echo; echo ${q(TIP)}`,
      'rm -f "$0"', // 临时脚本，跑完自己删
      '',
    ].join('\n'),
    env: {},
  };
}

function openTerminal(name: string): void {
  const s = terminalScript(WIN, { claude: bin('claude'), name, configDir: process.env.CLAUDE_CONFIG_DIR, cwd: HOME_DIR });
  const file = join(tmpdir(), `lcr-mcp-login-${Date.now()}${s.ext}`);
  writeFileSync(file, s.content, { mode: 0o700 });
  if (WIN) {
    // start 才会给它开一个新的控制台窗口。/s：去掉最外层那对引号，剩下 start "" "<路径>" 原样交给 cmd（路径里有空格、括号都行）
    spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"start "" "${file}""`],
      { windowsVerbatimArguments: true, env: { ...process.env, ...s.env }, cwd: HOME_DIR, stdio: 'ignore', windowsHide: true }).unref();
  } else {
    spawn('open', [file], { stdio: 'ignore', windowsHide: true }).unref();
  }
}

/** 正在授权的 MCP（名字 → 子进程）。还在等的时候向导上显示转圈，不让重复起 */
const logins = new Map<string, ChildProcess>();
const LOGIN_TIMEOUT = 10 * 60_000;
// 应用退出时还在等授权的一并掐掉，别留一个占着本机端口的 claude（杀 script 它会带着 claude 一起退）
process.on('exit', () => { for (const c of logins.values()) c.kill(); });
const mcpShort = (name: string) => name.split(':').pop()!;

/** 授权链接从 claude 的输出里抠。它带终端超链接（OSC 8，里面也夹着一份链接）和颜色码，先整段剥掉再找 */
export function authUrl(out: string): string | undefined {
  const plain = out.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  return /https?:\/\/[^\s"'<>]+/.exec(plain)?.[0];
}

/**
 * mac：不弹终端，后台跑授权。`claude mcp login` 要 TTY，就借系统自带的 script 给它一个伪终端；
 * 加 --no-browser 让它把链接打出来、由我们来开浏览器（页面上还能放一个「没弹出来就点这里」）。
 * 它照样在本机起回调端口，浏览器里同意完自己就收到了，不用粘贴。进程一退出就重查状态推给向导 —— 不用手动点刷新。
 */
function loginInBackground(name: string): Promise<string> {
  logins.get(name)?.kill(); // 再点一次 = 重来：旧链接里的 state 已经作废了
  const c = spawn('/usr/bin/script', ['-q', '/dev/null', bin('claude'), 'mcp', 'login', '--no-browser', name],
    { cwd: HOME_DIR, stdio: ['ignore', 'pipe', 'pipe'] }); // stdin 必须是 ignore：script 要对 stdin 做 tcgetattr，管道（socket）上会直接报错
  logins.set(name, c);
  let out = '';
  const timer = setTimeout(() => c.kill(), LOGIN_TIMEOUT);
  return new Promise((resolve, reject) => {
    const fail = setTimeout(() => reject(new Error(`没拿到授权链接：${lastLine(out)}`)), 30_000);
    const onData = (d: Buffer) => { out += d; const u = authUrl(out); if (u) { clearTimeout(fail); resolve(u); } };
    c.stdout!.on('data', onData);
    c.stderr!.on('data', onData);
    c.on('error', (e) => { clearTimeout(fail); reject(e); });
    c.on('exit', (code) => {
      clearTimeout(timer);
      clearTimeout(fail);
      reject(new Error(lastLine(out))); // 链接出来之前就退出了（已经授权过、名字不对…）；已经 resolve 过的话这句不起作用
      if (logins.get(name) !== c) return; // 被新的一次顶掉了，结果归新的那次报
      logins.delete(name);
      const ok = code === 0;
      void refresh().then(() => progress('plugin', ok ? `${mcpShort(name)} 授权好了` : `${mcpShort(name)} 没授权成功：${code === null ? '超时或取消了' : lastLine(out)}`, { ok }));
    });
  });
}

/** 输出最后一行有字的，剥掉控制码 —— 出错时给人看 */
const lastLine = (out: string) => out.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|[\x00-\x08]/g, '').split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean).pop()?.slice(0, 200) ?? '没有输出';

/** Windows 弹终端那条路不知道用户什么时候授权完：每 5 秒查一次，这个 MCP 连上了、或者到点了就停 */
function watchLogin(name: string): void {
  const until = Date.now() + LOGIN_TIMEOUT;
  const tick = async () => {
    await refresh();
    if (mcpState(mcp?.get(name)) === 'ok') return progress('plugin', `${mcpShort(name)} 授权好了`, { ok: true });
    if (Date.now() > until) return progress('plugin', `${mcpShort(name)} 还没授权上：授权完点「重新检测」`, { ok: false });
    setTimeout(tick, 5000);
  };
  setTimeout(tick, 5000);
}

function openUrl(url: string): void {
  // 链接是 claude 打出来的，只放 http(s)；Windows 不走这里
  if (/^https?:\/\//.test(url)) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' }).on('error', () => {}).unref();
}

const mcpLogin: Handler = async (body) => {
  const name = String(body?.name ?? '');
  // 只认 claude mcp list 里有的（还没扫完就只认预置插件的）—— 名字要交给 claude / 拼进终端脚本
  if (!(mcp?.has(name) || preset().plugins.some((p) => mcpNames(p.plugin).includes(name)))) return { ok: false, error: `不认识的 MCP：${name}` };
  if (WIN) {
    openTerminal(name);
    watchLogin(name);
    return { opened: true, terminal: true };
  }
  try {
    const url = await loginInBackground(name);
    openUrl(url);
    return { opened: true, url };
  } catch (e: any) {
    return { ok: false, error: `${mcpShort(name)} 授权没起来：${e.message}` };
  }
};

/* ---------- 设置页：日常管 Claude Code（插件 / 市场 / MCP / skill） ---------- */
/*
 * 向导只管第一次装好；这里是之后的事：MCP 授权过期了重新授权、加别的插件和 skill。都是包 claude 自己的命令，
 * 作用在这套 Claude Code 的配置目录上（桌面版是独立的那份，不碰用户自己的 ~/.claude）。
 */

const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const skillsDir = () => join(configDir(), 'skills');

/** SKILL.md 开头 --- 之间的一个字段 */
export function front(md: string, key: string): string {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? '';
  return new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(head)?.[1].trim().replace(/^(["'])(.*)\1$/, '$2') ?? '';
}

/** 目录下每个带 SKILL.md 的子目录 = 一个 skill */
export function skillsIn(dir: string): { name: string; description: string; dir: string }[] {
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.flatMap((n) => {
    try {
      const md = readFileSync(join(dir, n, 'SKILL.md'), 'utf8');
      return [{ name: front(md, 'name') || n, description: front(md, 'description'), dir: n }];
    } catch { return []; }
  });
}

/** 正在跑的操作：'plugin:<id>' / 'market:<名字或地址>' → 页面上替代按钮显示的字 */
const ops = new Map<string, string>();

/** 跑一条 claude 命令，前后推进度、跑完重扫。带 gitEnv：私有市场是 SSH 地址，有 GitLab token 就改走 HTTPS */
async function op(key: string, busy: string, args: string[], what: string): Promise<void> {
  ops.set(key, busy);
  progress('plugin', `${what}…`);
  const r = await run(bin('claude'), args, { env: { ...process.env, ...gitEnv() }, timeout: 300_000 });
  ops.delete(key);
  await refresh();
  progress('plugin', r.code === 0 ? `${what}：好了` : `${what}失败：${why(r)}`, { ok: r.code === 0 });
}

const ccStatus: Handler = async (body) => {
  if (body?.fresh || (!installed && !scanning)) void refresh().then(() => progress('plugin', 'Claude Code 状态查好了', { ok: !scanErr }));
  const pre = preset().plugins;
  const owner = new Map<string, string>(); // MCP 全名 → 插件 id
  const plugins = (installed ?? []).map((p) => {
    const names = mcpNames(p.id);
    for (const n of names) owner.set(n, p.id);
    return {
      id: p.id, name: short(p.id), marketplace: p.id.split('@')[1] ?? '', version: p.version ?? '', enabled: p.enabled !== false,
      preset: pre.some((x) => x.plugin === p.id), busy: ops.get(`plugin:${p.id}`) ?? '', mcp: names,
      skills: p.installPath ? skillsIn(join(p.installPath, 'skills')).map((s) => s.name) : [],
    };
  });
  // 装到一半的还不在列表里，也给它一行，别让人以为没点上
  for (const [k, busy] of ops) {
    const id = k.slice('plugin:'.length);
    if (k.startsWith('plugin:') && !plugins.some((p) => p.id === id)) {
      plugins.push({ id, name: short(id), marketplace: id.split('@')[1] ?? '', version: '', enabled: false, preset: pre.some((x) => x.plugin === id), busy, mcp: [], skills: [] });
    }
  }
  const mcpRows = mcp
    ? [...mcp].map(([name, status]) => ({ name, label: mcpShort(name), plugin: owner.get(name), status, state: logins.has(name) ? 'running' : mcpState(status), loggingIn: logins.has(name) }))
    : [...owner].map(([name, plugin]) => ({ name, label: mcpShort(name), plugin, status: undefined, state: 'running', loggingIn: logins.has(name) }));
  const skills = [
    ...(installed ?? []).flatMap((p) => (p.installPath ? skillsIn(join(p.installPath, 'skills')) : []).map((s) => ({ name: s.name, description: s.description, plugin: p.id, personal: false }))),
    ...skillsIn(skillsDir()).map((s) => ({ name: s.name, description: s.description, personal: true })),
  ];
  return {
    scanning: !!scanning, error: scanErr, configDir: configDir(), plugins,
    marketplaces: markets.map((m) => ({ name: m.name, url: m.url ?? '', preset: pre.some((x) => x.marketplace === m.url), busy: ops.get(`market:${m.name}`) ?? '' })),
    mcp: mcpRows, skills, needsAuth: mcpRows.filter((m) => m.state === 'missing').length,
  };
};

/** 能装的插件，按关键词筛。官方目录几千个：自己加的市场排前面，名字命中排在只有描述命中前面 */
export function searchAvailable(list: Available[], have: Set<string>, mine: Set<string>, q: string) {
  const k = q.trim().toLowerCase();
  const score = (a: Available) => (mine.has(a.marketplaceName) ? 0 : 2) + (!k || a.name.toLowerCase().includes(k) ? 0 : 1);
  return list
    .filter((a) => !have.has(a.pluginId) && (!k || `${a.name}\n${a.description ?? ''}`.toLowerCase().includes(k)))
    .sort((a, b) => score(a) - score(b))
    .slice(0, 50)
    .map((a) => ({ id: a.pluginId, name: a.name, description: a.description ?? '', marketplace: a.marketplaceName, version: a.version ?? '' }));
}

const ccAvailable: Handler = async (body) => {
  if (!installed && !scanning) void refresh();
  return { plugins: searchAvailable(available, new Set((installed ?? []).map((p) => p.id)), new Set(markets.map((m) => m.name)), str(body?.q)) };
};

/** 插件 id（name@marketplace）、市场名、skill 名：只放这些字符 —— 要当参数交给 claude、拼路径 */
const ID = /^\w[\w.-]*(@\w[\w.-]*)?$/;
const NAME = /^\w[\w.-]*$/;
const VERB: Record<string, string> = { install: '安装', uninstall: '卸载', update: '更新', enable: '启用', disable: '停用' };

const ccPlugin: Handler = async (body) => {
  const action = String(body?.action ?? ''), id = str(body?.plugin);
  if (!VERB[action]) return { ok: false, error: `不认识的操作：${action}` };
  if (!ID.test(id)) return { ok: false, error: `插件名不对：${id}` };
  if (action !== 'install' && !installed?.some((p) => p.id === id)) return { ok: false, error: `没装 ${id}` };
  if (!ops.has(`plugin:${id}`)) void op(`plugin:${id}`, `${VERB[action]}中…`, ['plugin', action, id], `${VERB[action]} ${short(id)}`);
  return { started: true };
};

const ccMarket: Handler = async (body) => {
  const action = String(body?.action ?? '');
  if (action === 'add') {
    const src = str(body?.source);
    // 不能 - 开头（会被当成参数），不能有空白和控制字符
    if (!/^[^\s-]\S{0,499}$/.test(src)) return { ok: false, error: '地址不对：填 git 地址、GitHub 的 owner/repo 或 https 链接' };
    if (!ops.has(`market:${src}`)) void op(`market:${src}`, '添加中…', ['plugin', 'marketplace', 'add', src], `添加插件市场 ${src}`);
    return { started: true };
  }
  if (action !== 'remove' && action !== 'update') return { ok: false, error: `不认识的操作：${action}` };
  const name = str(body?.name);
  const m = NAME.test(name) ? markets.find((x) => x.name === name) : undefined;
  if (!m) return { ok: false, error: `没有这个插件市场：${name}` };
  if (ops.has(`market:${name}`)) return { started: true };
  void (async () => {
    // 我们替它 clone 的（见 mirror）claude 只会重读本地目录，不会去拉，所以先 pull
    if (action === 'update' && m.source === 'directory' && isMirror(m.path)) {
      await git(['pull', '-q', '--ff-only'], m.path!).catch((e: any) => progress('plugin', `拉 ${name} 的新版本失败：${e.message}`));
    }
    await op(`market:${name}`, action === 'update' ? '更新中…' : '移除中…', ['plugin', 'marketplace', action, name], `${action === 'update' ? '更新' : '移除'}插件市场 ${name}`);
  })();
  return { started: true };
};

/** 自己加的 skill：把一个带 SKILL.md 的文件夹拷进 <配置目录>/skills/<名字>；删也只删这里面的 */
const ccSkill: Handler = async (body) => {
  const dir = skillsDir();
  if (body?.action === 'remove') {
    const s = skillsIn(dir).find((x) => x.name === str(body?.name));
    if (!s) return { ok: false, error: `没有这个 skill：${str(body?.name)}` };
    rmSync(join(dir, s.dir), { recursive: true, force: true });
    return { ok: true };
  }
  if (body?.action !== 'add') return { ok: false, error: '不认识的操作' };
  const raw = str(body?.path);
  if (!raw || !(isAbsolute(raw) || raw.startsWith('~/'))) return { ok: false, error: '填文件夹的完整路径' };
  const from = expandProject(raw);
  let md: string;
  try { md = readFileSync(join(from, 'SKILL.md'), 'utf8'); } catch { return { ok: false, error: '这个文件夹里没有 SKILL.md' }; }
  const name = front(md, 'name') || basename(from);
  if (!NAME.test(name)) return { ok: false, error: `skill 名字只能是字母数字和 - _ .：${name}` };
  const to = join(dir, name);
  // 拷进自己里面会没完没了：它在 skills 目录里、或者 skills 目录在它里面，都不行（relative 跨盘符时给的是绝对路径，也算不在里面）
  const inside = (parent: string, child: string) => { const r = relative(resolve(parent), resolve(child)); return !r.startsWith('..') && !isAbsolute(r); };
  if (inside(dir, from) || inside(from, dir)) return { ok: false, error: '不能选 skills 目录本身或它的上级' };
  if (existsSync(to)) return { ok: false, error: `已经有叫 ${name} 的 skill 了，先删掉旧的` };
  mkdirSync(dir, { recursive: true });
  cpSync(from, to, { recursive: true });
  return { ok: true, name };
};

const mcpLogout: Handler = async (body) => {
  const name = str(body?.name);
  if (!mcp?.has(name)) return { ok: false, error: `不认识的 MCP：${name}` };
  const r = await run(bin('claude'), ['mcp', 'logout', name]);
  void refresh().then(() => progress('plugin', r.code === 0 ? `${mcpShort(name)} 已退出登录` : `${mcpShort(name)} 退出失败：${why(r)}`, { ok: r.code === 0 }));
  return r.code === 0 ? { ok: true } : { ok: false, error: why(r) };
};

/* ---------- 从本机 Claude Code 同步（桌面版） ---------- */

/**
 * 桌面版的 claude 配置是隔离的（desktop/main.js 设的 CLAUDE_CONFIG_DIR）。这里把自己终端里那份 ~/.claude 搬过来：
 * 同名的以本机为准，这边多出来的不删。模型、API、登录不搬 —— 那些归「API 来源」管。
 * 插件和 MCP 走 claude 自己的命令装（缓存路径它自己管）；MCP 的授权在钥匙串里搬不了，过来重新点「授权」
 */
const MINE = join(homedir(), '.claude');
const mineEnv = () => { const { CLAUDE_CONFIG_DIR: _, ...e } = process.env; return e; };
const isolated = () => resolve(configDir()) !== resolve(MINE);
/** settings.json 里跟模型、API、登录有关的不搬；插件那两项由「插件」那步用 claude 命令装 */
const NOT_SYNCED = new Set(['model', 'effortLevel', 'modelSettings', 'availableModels', 'alwaysThinkingEnabled', 'apiKeyHelper',
  'awsAuthRefresh', 'awsCredentialExport', 'forceLoginMethod', 'forceLoginOrgUUID', 'enabledPlugins', 'extraKnownMarketplaces']);
const MODEL_ENV = /^(ANTHROPIC_|CLAUDE_CODE_(OAUTH_TOKEN|USE_|SUBAGENT_MODEL)|AWS_|VERTEX_|CLOUD_ML_)/;
const SYNC_DIRS = ['skills', 'agents', 'commands'];
const readJson = (f: string): Record<string, any> => { try { return JSON.parse(readFileSync(f, 'utf8')) ?? {}; } catch { return {}; } };
const lsNames = (d: string) => { try { return readdirSync(d).filter((n) => !n.startsWith('.')); } catch { return []; } };

/** settings.json 里要搬的部分 */
export function syncableSettings(s: Record<string, any>): Record<string, any> {
  const out = Object.fromEntries(Object.entries(s).filter(([k]) => !NOT_SYNCED.has(k)));
  const env = Object.fromEntries(Object.entries(s.env ?? {}).filter(([k]) => !MODEL_ENV.test(k)));
  if (Object.keys(env).length) out.env = env; else delete out.env;
  return out;
}

/** 本机那份：用户级插件（id → 启用没）、插件市场（名字 → add 用的地址）、用户级 MCP */
async function mineState() {
  const env = mineEnv();
  const [pl, mk] = await Promise.all([run(bin('claude'), ['plugin', 'list', '--json'], { env }), run(bin('claude'), ['plugin', 'marketplace', 'list', '--json'], { env })]);
  const parse = (r: Run) => { try { return r.code === 0 ? JSON.parse(r.out) : undefined; } catch { return undefined; } };
  const list = parse(pl), mks = parse(mk);
  const all: any[] = Array.isArray(list) ? list : list?.installed ?? [];
  return {
    error: !list ? `读不到本机的插件列表：${why(pl)}` : '',
    plugins: new Map(all.filter((p) => p.scope === 'user').map((p) => [String(p.id), p.enabled !== false])),
    otherScope: all.filter((p) => p.scope !== 'user').length,
    markets: new Map<string, string>((Array.isArray(mks) ? mks : []).map((m: any) => [String(m.name), String(m.repo ?? m.url ?? m.path ?? '')])),
    mcp: (readJson(join(homedir(), '.claude.json')).mcpServers ?? {}) as Record<string, unknown>,
  };
}

const names = (xs: string[]) => xs.length > 6 ? xs.slice(0, 6).join('、') + ` 等 ${xs.length} 个` : xs.join('、');

/** 每一项：本机有什么、这边差多少。todo = 0 就是已经一样 */
const ccSyncPlan: Handler = async () => {
  if (!isolated()) return { available: false };
  if (!installed || !mcp) await (scanning ?? refresh());
  const m = await mineState();
  const have = new Set((installed ?? []).map((p) => p.id));
  const pMiss = [...m.plugins.keys()].filter((id) => !have.has(id));
  const pDiff = (installed ?? []).filter((p) => m.plugins.has(p.id) && m.plugins.get(p.id) !== (p.enabled !== false)).length;
  const mMiss = Object.keys(m.mcp).filter((n) => !mcp?.has(n));
  const fMiss = SYNC_DIRS.flatMap((d) => { const there = new Set(lsNames(join(configDir(), d))); return lsNames(join(MINE, d)).filter((n) => !there.has(n)).map((n) => `${d}/${n}`); });
  const fAll = SYNC_DIRS.reduce((n, d) => n + lsNames(join(MINE, d)).length, 0);
  const memMine = existsSync(join(MINE, 'CLAUDE.md')) ? readFileSync(join(MINE, 'CLAUDE.md'), 'utf8') : undefined;
  const memHere = existsSync(join(configDir(), 'CLAUDE.md')) ? readFileSync(join(configDir(), 'CLAUDE.md'), 'utf8') : undefined;
  const sMine = syncableSettings(readJson(join(MINE, 'settings.json')));
  const sHere = readJson(join(configDir(), 'settings.json'));
  const sDiff = Object.keys(sMine).filter((k) => k === 'env' ? Object.entries(sMine.env).some(([a, v]) => sHere.env?.[a] !== v) : JSON.stringify(sMine[k]) !== JSON.stringify(sHere[k]));
  return {
    available: true, busy: ops.get('sync') ?? '', error: m.error,
    items: [
      { key: 'plugins', label: '插件和插件市场', todo: pMiss.length + pDiff,
        detail: `本机 ${m.plugins.size} 个用户级插件` + (pMiss.length ? `，这边少 ${names(pMiss.map(short))}` : '，这边都有') + (pDiff ? `，${pDiff} 个启用状态不一样` : '')
          + (m.otherScope ? `。项目级等其它范围的 ${m.otherScope} 个不搬` : '') },
      { key: 'mcp', label: '用户级 MCP', todo: mMiss.length,
        detail: Object.keys(m.mcp).length ? `本机 ${Object.keys(m.mcp).length} 个` + (mMiss.length ? `，这边少 ${names(mMiss)}。授权搬不过来，同步完要重新点「授权」` : '，这边都有') : '本机没有（插件带的 MCP 跟着插件走）' },
      { key: 'files', label: 'skills、子代理、自定义命令', todo: fMiss.length,
        detail: fAll ? `本机 ${fAll} 个` + (fMiss.length ? `，这边少 ${names(fMiss)}` : '，这边都有') + '。同名的会被本机的盖掉' : '本机没有' },
      { key: 'memory', label: 'CLAUDE.md', todo: memMine !== undefined && memMine !== memHere ? 1 : 0,
        detail: memMine === undefined ? '本机没有' : memMine === memHere ? '一样' : memHere === undefined ? '这边还没有' : '两边不一样，会用本机的盖掉这边的' },
      { key: 'settings', label: '其它设置', todo: sDiff.length,
        detail: Object.keys(sMine).length ? `本机有 ${Object.keys(sMine).join('、')}` + (sDiff.length ? `，要改 ${sDiff.join('、')}` : '，一样') + (sMine.hooks ? '。hooks 搬过来后，飞书来的每次运行也会触发' : '') + '。模型、API、登录相关的不搬' : '除了模型和 API，本机没配别的' },
    ],
  };
};

/** 按勾的项搬。一项失败不拦后面的，最后一起报 */
async function doSync(items: Set<string>): Promise<string[]> {
  const bad: string[] = [];
  const claude = async (args: string[], what: string) => {
    progress('plugin', what + '…');
    const r = await run(bin('claude'), args, { env: { ...process.env, ...gitEnv() }, timeout: 300_000 });
    if (r.code !== 0) bad.push(`${what}：${why(r)}`);
    return r.code === 0;
  };
  const m = items.has('plugins') || items.has('mcp') ? await mineState() : undefined;
  if (m && items.has('plugins')) {
    if (m.error) bad.push(m.error);
    const known = new Set(markets.map((x) => x.name));
    for (const [name, src] of m.markets) if (!known.has(name) && src) await claude(['plugin', 'marketplace', 'add', src], `添加插件市场 ${name}`);
    const have = new Map((installed ?? []).map((p) => [p.id, p.enabled !== false]));
    for (const [id, on] of m.plugins) {
      if (!have.has(id) && !(await claude(['plugin', 'install', id], `安装 ${short(id)}`))) continue;
      if ((have.get(id) ?? true) !== on) await claude(['plugin', on ? 'enable' : 'disable', id], `${on ? '启用' : '停用'} ${short(id)}`);
    }
  }
  if (m && items.has('mcp')) {
    for (const [name, def] of Object.entries(m.mcp)) {
      if (mcp?.has(name)) continue;
      if (!NAME.test(name)) { bad.push(`MCP ${name}：名字不认识，跳过`); continue; }
      await claude(['mcp', 'add-json', '-s', 'user', name, JSON.stringify(def)], `添加 MCP ${name}`);
    }
  }
  try {
    mkdirSync(configDir(), { recursive: true });
    if (items.has('files')) for (const d of SYNC_DIRS) if (existsSync(join(MINE, d))) cpSync(join(MINE, d), join(configDir(), d), { recursive: true, force: true });
    if (items.has('memory') && existsSync(join(MINE, 'CLAUDE.md'))) cpSync(join(MINE, 'CLAUDE.md'), join(configDir(), 'CLAUDE.md'));
    if (items.has('settings')) {
      const mine = syncableSettings(readJson(join(MINE, 'settings.json')));
      const file = join(configDir(), 'settings.json'), here = readJson(file);
      const next = { ...here, ...mine, ...(mine.env && { env: { ...here.env, ...mine.env } }) };
      writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
    }
  } catch (e: any) { bad.push(`拷文件：${e.message}`); }
  return bad;
}

const ccSync: Handler = async (body) => {
  if (!isolated()) return { ok: false, error: '这里用的就是本机的 ~/.claude，不用同步' };
  const items = new Set<string>((Array.isArray(body?.items) ? body.items : []).map(String));
  if (!items.size) return { ok: false, error: '先勾要同步的' };
  if (ops.has('sync')) return { started: true };
  ops.set('sync', '同步中…');
  void doSync(items).then(async (bad) => {
    ops.delete('sync');
    await refresh();
    progress('plugin', bad.length ? `同步完了，${bad.length} 处没成：${bad.join('；')}` : '同步好了', { ok: !bad.length });
  });
  return { started: true };
};

/* ---------- 汇总 ---------- */

/** 开了「先判定」却没处可打的模板（没开 Google Decisions API，也只有订阅、settings.json 里没令牌）：每条都会按要回处理，等于白开 */
export function judgeless(cfg: Pick<Config, 'templates' | 'apis' | 'decisionApi'>, templates: Template[]): string[] {
  if (decisionTarget(cfg.decisionApi)) return [];
  const names = Object.entries(cfg.templates).filter(([, t]) => templates.includes(t) && t.judge).map(([n]) => n);
  return names.filter((n) => !judgeTargets(resolveChat({ chats: {}, templates: cfg.templates, defaultTemplate: n, apis: cfg.apis }, '').apis).length);
}

export async function sections(cfg: Config): Promise<Section[]> {
  const templates = routingTemplates(cfg);
  const claude = templates.some((t) => t.agent !== 'codex');
  const model: Section = claude || (templates.some((t) => t.judge) && !decisionTarget(cfg.decisionApi)) ? modelSection(cfg) : {
    id: 'model', title: '模型', checks: [],
  };
  const lost = judgeless(cfg, templates);
  if (lost.length) model.checks.push({ id: 'judge', label: '判定', state: 'missing',
    detail: `模板「${lost.join('」「')}」开了先判定，但没有可用的判定接口（订阅不能直接调 API）：每条都会按要回处理。可以在设置 → 常规里开 Google Decisions API、加一个网关，或者在模板里关掉判定`,
    optional: true });
  if (templates.some(t => t.agent === 'codex')) {
    const check: Check = { id: 'codex', label: 'Codex App Server', state: 'ok' };
    try { check.detail = await codexConnection(); }
    catch (e: any) { check.state = 'error'; check.detail = e.message; }
    model.checks.push(check);
  }
  return [model, await larkSection(), ...(claude && preset().plugins.length ? [pluginSection()] : [])];
}

export const routes: Record<string, Handler> = {
  'GET /api/setup/model': async (_b, { cfg }) => ({
    apis: cfg.apis.map(publicApi),
    health: Object.fromEntries(cfg.apis.flatMap((a) => { const h = apiHealth(a.name); return h ? [[a.name, h]] : []; })),
  }),
  'POST /api/setup/apis': saveApis,
  'POST /api/setup/apis/test': testOne,
  'POST /api/setup/decision-api/test': testDecisionApi,
  'POST /api/setup/lark/app': larkApp,
  'POST /api/setup/lark/login': larkLogin,
  'POST /api/setup/plugin/install': installPlugin,
  'POST /api/setup/mcp/login': mcpLogin,
  'POST /api/setup/mcp/logout': mcpLogout,
  'GET /api/setup/cc': ccStatus,
  'GET /api/setup/codex': codexSettings,
  'POST /api/setup/codex': updateCodexSettings,
  'GET /api/setup/codex/settings': codexSettings,
  'POST /api/setup/codex/settings': updateCodexSettings,
  'GET /api/setup/cc/available': ccAvailable,
  'POST /api/setup/cc/plugin': ccPlugin,
  'POST /api/setup/cc/marketplace': ccMarket,
  'POST /api/setup/cc/skill': ccSkill,
  'GET /api/setup/cc/sync': ccSyncPlan,
  'POST /api/setup/cc/sync': ccSync,
  'POST /api/setup/mcp/refresh': async () => {
    void refresh().then(() => progress('plugin', 'MCP 状态刷新好了', { ok: !scanErr }));
    return { started: true };
  },
};
