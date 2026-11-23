import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { bin } from '../bins.ts';
import { broadcast } from '../bus.ts';
import { HOME_DIR, expandProject, saveConfig, type Config } from '../config.ts';
import { gitEnv, gitTokens, setGitToken } from './git.ts';
import { preset } from './preset.ts';
import { progress, type Check, type Handler, type Section } from './types.ts';

/**
 * 工作区 = CC 跑的那个目录。里面的仓库 = 顶层仓库本身（是 git 仓库的话）+ 它的子模块 + repos/ 下自己加的 clone。
 * 默认放在 HOME_DIR/workspaces/<name>，也能登记已有目录。每次操作的结果记进 workspaces.json，
 * 向导刷新只读它 —— 现场跑 git 太慢。
 * 「更新」= 每个仓库切到默认分支最新（origin/HEAD，线上代码）；拉不下来的保留旧版本标 stale，不拖累别的。
 */
export const ROOT_DIR = join(HOME_DIR, 'workspaces');
const STORE = join(HOME_DIR, 'workspaces.json');
const JOBS = 8;

export interface Repo {
  name: string;
  path: string;
  url: string;
  state: 'ok' | 'missing' | 'stale' | 'error';
  /** 当前提交的日期 */
  date?: string;
  error?: string;
}
/** 存盘的那份。at = 上次跑完更新的时间 */
interface Saved { path: string; at?: number; repos: Repo[] }
/** 扫出来还没看状态的仓库。sub = 子模块在 .gitmodules 里的 path，没 clone 的靠它补 */
interface Ref { name: string; path: string; url: string; sub?: string }

const load = (): Record<string, Saved> => { try { return JSON.parse(readFileSync(STORE, 'utf8')); } catch { return {}; } };
function save(name: string, s: Saved): void {
  writeFileSync(STORE, JSON.stringify({ ...load(), [name]: s }, null, 2));
}

/** 全部工作区：ROOT_DIR 下的目录 + 登记过的外部目录。目录被手动删了的不列 */
function all(): Record<string, Saved> {
  const saved = load();
  const out: Record<string, Saved> = {};
  let dirs: string[] = [];
  try { dirs = readdirSync(ROOT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && okName(d.name)).map((d) => d.name); } catch {}
  for (const n of dirs) out[n] = { repos: [], ...saved[n], path: join(ROOT_DIR, n) };
  for (const [n, s] of Object.entries(saved)) if (!out[n] && existsSync(s.path)) out[n] = s;
  return out;
}

/* ---------- 不可信输入：工作区名、仓库名、地址都要拼进路径 / 命令行 ---------- */

/** 只留安全字符：没有 / \ ..，不以 - 开头。Windows 的保留名（CON、NUL…）和结尾的点（会被吞掉）也挡掉 */
const okName = (s: string) =>
  /^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,63}$/u.test(s) && !s.includes('..') && !s.endsWith('.') && !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(s);

function checkName(v: unknown, what: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!okName(s)) throw new Error(`${what}不合法：「${s}」（只能用字母、数字、中文、_ - .）`);
  return s;
}

/** 只认这几种地址。ext:: 这类能执行命令的协议、以 - 开头会被 git 当成参数的，一律不收 */
function checkUrl(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length > 500 || !/^((https?|ssh|git|file):\/\/|[\w.-]+@[\w.-]+:)\S+$/.test(s)) throw new Error(`仓库地址不合法：「${s}」`);
  return s;
}

/** git@h:g/foo.git、https://h/g/foo、file:///x/foo → foo */
const nameOf = (url: string) => url.replace(/[/\\]+$/, '').split(/[/\\:]/).pop()!.replace(/\.git$/, '');
const hostOf = (url: string) => (/^[\w.-]+@([\w.-]+):/.exec(url) ?? /^\w+:\/\/(?:[^@/]*@)?([^/:]+)/.exec(url))?.[1].toLowerCase();

/** relative 在 Windows 上不分大小写、跨盘符给绝对路径，比自己比字符串靠谱 */
const same = (a: string, b: string) => relative(a, b) === '';
/** 页面只给这种仓库显示「删除」：repos/ 下自己 clone 的。子模块（.git 是文件）和顶层仓库 remove-repo 会拒 */
const removable = (ws: string, p: string) => same(dirname(p), join(ws, 'repos')) && !!statSync(join(p, '.git'), { throwIfNoEntry: false })?.isDirectory();
const inside = (parent: string, child: string) => {
  const r = relative(parent, child);
  return !!r && r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r);
};

/* ---------- git ---------- */

const exec = promisify(execFile);

/**
 * 所有 git 都走这儿：找得到的那个 git、带上 token 改写（gitEnv）、不弹黑框、不经 shell。
 * core.longpaths：Windows 上 Java 仓库的路径叠在 AppData 下面很容易过 260，不开 checkout 直接失败；
 * -c 会经环境变量传给子模块 clone 这些子进程。别的平台忽略它。
 */
export async function git(args: string[], cwd: string, env = gitEnv(), timeout = 600_000): Promise<string> {
  try {
    const { stdout } = await exec(bin('git'), ['-c', 'core.longpaths=true', ...args], {
      cwd, timeout, env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 64 << 20,
    });
    return stdout.trim();
  } catch (e: any) {
    throw new Error(e.killed ? `git ${args[0]} 超时` : brief(e.stderr) || e.message);
  }
}

/** git 的报错挑一句人看得懂的：GitLab 说的原因（remote: …）优先，其次 fatal / error */
function brief(stderr: unknown): string {
  const lines = String(stderr ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const said = lines.find((l) => /^(remote|ERROR):\s*[^\s=]/.test(l) && !/^remote: (Enumerating|Counting|Compressing|Total)/.test(l));
  return (said ?? lines.find((l) => /^(fatal|error):/i.test(l)) ?? lines[0] ?? '').slice(0, 300);
}

const origin = (dir: string) => git(['config', '--get', 'remote.origin.url'], dir).catch(() => '');

/** 顶层目录本身是 git 仓库的话，它也算一个 */
async function top(name: string, dir: string): Promise<Ref[]> {
  return existsSync(join(dir, '.git')) ? [{ name, path: dir, url: await origin(dir) }] : [];
}

/** 子模块 + repos/ 下自己 clone 的。不联网 */
async function scan(dir: string): Promise<Ref[]> {
  const refs: Ref[] = [];
  const out = await git(['config', '-f', '.gitmodules', '--get-regexp', '^submodule\\..*\\.(path|url)$'], dir).catch(() => '');
  const subs: Record<string, { path?: string; url?: string }> = {};
  for (const m of out.matchAll(/^submodule\.(.+)\.(path|url) ([^\r\n]*)$/gm)) (subs[m[1]] ??= {})[m[2] as 'path' | 'url'] = m[3];
  for (const s of Object.values(subs)) {
    const p = s.path ? resolve(dir, s.path) : '';
    // .gitmodules 是远端给的：路径跑出工作区的不认，不然「更新」会去动别处的仓库
    if (p && inside(dir, p)) refs.push({ name: basename(p), path: p, url: s.url ?? '', sub: s.path });
  }
  let own: string[] = [];
  try { own = readdirSync(join(dir, 'repos')); } catch {}
  for (const d of own) {
    const p = join(dir, 'repos', d);
    if (!refs.some((r) => same(r.path, p)) && existsSync(join(p, '.git'))) refs.push({ name: d, path: p, url: await origin(p) });
  }
  return refs;
}

/** 本地看一眼：clone 了没、当前提交是哪天的 */
async function look(dir: string): Promise<Pick<Repo, 'state' | 'date' | 'error'>> {
  // 没 clone 的子模块是个空目录，在里面跑 git log 会读到顶层仓库去，所以先看 .git
  if (!existsSync(join(dir, '.git'))) return { state: 'missing' };
  try { return { state: 'ok', date: await git(['log', '-1', '--format=%cs'], dir) }; } catch (e: any) { return { state: 'error', error: e.message }; }
}

/** 一个仓库切到线上最新。没 clone 的子模块先补（没权限 → missing）；拉不下来 / 切不过去的保留旧版本，标 stale */
async function sync(dir: string, r: Ref): Promise<Repo> {
  const base = { name: r.name, path: r.path, url: r.url };
  if (!existsSync(join(r.path, '.git'))) {
    if (!r.sub) return { ...base, state: 'missing' };
    try {
      // 只拉提交和目录树，文件内容按需下载：clone 快，git log 照样能用（--filter 只能跟着 --init）。
      // 老 git（同事机器上自带的 Git for Windows）的 submodule update 不认 --filter，只打一行用法 —— 退回完整 clone，慢点但能用
      const init = (...filter: string[]) => git(['submodule', 'update', '--init', ...filter, '--', r.sub], dir);
      await init('--filter=blob:none').catch((e) => { if (/^usage: git submodule/.test(e.message)) return init(); throw e; });
    } catch (e: any) {
      return { ...base, state: 'missing', error: e.message };
    }
  }
  try {
    await git(['fetch', '-q', 'origin'], r.path);
    // clone 时没带上远端默认分支的，问一下远端
    if (!(await git(['rev-parse', '-q', '--verify', 'refs/remotes/origin/HEAD'], r.path).catch(() => ''))) {
      await git(['remote', 'set-head', 'origin', '--auto'], r.path);
    }
    // 游离的（子模块）直接切过去。停在分支上的（自己 clone 的顶层、登记进来的已有目录）只快进：
    // 那可能是开发同学自己的工作目录，有自己提交的不碰它，标 stale
    const onBranch = await git(['symbolic-ref', '-q', 'HEAD'], r.path).then(() => true, () => false);
    await git(onBranch ? ['merge', '--ff-only', '-q', 'origin/HEAD'] : ['checkout', '-q', '--detach', 'origin/HEAD'], r.path);
  } catch (e: any) {
    return { ...base, ...(await look(r.path)), state: 'stale', error: e.message };
  }
  return { ...base, ...(await look(r.path)) };
}

/** 最多 n 个一起跑，结果按原顺序 */
async function pool<T, R>(items: T[], fn: (x: T) => Promise<R>, n = JOBS): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const label = (r: Repo) => ({
  ok: `ok ${r.date ?? ''}`,
  missing: `缺${r.error ? `：${r.error}` : ''}`,
  stale: `没更新上，用旧版本：${r.error}`,
  error: `出错：${r.error}`,
})[r.state];

/** 整个工作区更新一遍 */
async function update(name: string, dir: string): Promise<{ ok: boolean; msg: string }> {
  const repos: Repo[] = [];
  for (const t of await top(name, dir)) {
    // 顶层先切：新加的子模块要等 .gitmodules 更新了才扫得到
    repos.push(await sync(dir, t));
    progress('workspace', `${name} ${label(repos[0])}`);
    // 把 .gitmodules 里的地址登记进 .git/config。串行先做掉：后面并发的 submodule update --init 就不用抢着写它
    await git(['submodule', 'init'], dir).catch(() => {});
  }
  const refs = await scan(dir);
  let done = 0;
  repos.push(...await pool(refs, async (r) => {
    const x = await sync(dir, r);
    progress('workspace', `${++done}/${refs.length} ${r.name} ${label(x)}`);
    return x;
  }));
  save(name, { path: dir, at: Date.now(), repos });
  const n = (...s: Repo['state'][]) => repos.filter((r) => s.includes(r.state)).length;
  const msg = `${name}：${repos.length} 个仓库，${n('ok')} 个最新` +
    (n('missing') ? `，${n('missing')} 个缺（多半没权限）` : '') + (n('stale', 'error') ? `，${n('stale', 'error')} 个没更新上` : '');
  return { ok: !n('stale', 'error'), msg };
}

/* ---------- 路由 ---------- */

/** 同一个工作区同时只跑一个慢操作 */
const busy = new Set<string>();

/** 慢操作：立即返回，过程推 SSE，结束推 done */
function start(name: string, fn: () => Promise<{ ok: boolean; msg: string }>): { started: true } {
  if (busy.has(name)) throw new Error(`${name} 正在忙，等它弄完`);
  busy.add(name);
  fn().catch((e: any) => ({ ok: false, msg: `${name}：${e.message}` })).then(({ ok, msg }) => {
    busy.delete(name); // 先放锁再推 done：页面收到 done 就刷新，别让它看到还在跑
    progress('workspace', msg, { ok });
  });
  return { started: true };
}

function workspace(v: unknown): Saved & { name: string } {
  const name = checkName(v, '工作区名');
  const w = all()[name];
  if (!w) throw new Error(`没有工作区 ${name}`);
  return { name, ...w };
}

function taken(name: string): void {
  if (all()[name] || busy.has(name) || existsSync(join(ROOT_DIR, name))) throw new Error(`已经有叫 ${name} 的工作区了`);
}

/** 默认模板的 project 指向的就是这个目录 */
function inUse(cfg: Config, path: string): boolean {
  const p = cfg.templates[cfg.user.defaultTemplate]?.project;
  return !!p && same(expandProject(p), path);
}

/** 把默认模板的 project 指到这个目录 */
async function use(cfg: Config, path: string): Promise<void> {
  const t = cfg.user.defaultTemplate;
  const templates = { ...cfg.templates, [t]: { ...cfg.templates[t], project: path } };
  saveConfig({ templates });
  cfg.templates = templates;
  // 页面上的配置是快照，不推的话下次保存设置会把这里改的 project 抹掉（见 bus.ts 的 broadcast）
  // 动态 import：web.ts 经 setup/index.ts 引到这里，静态引会成环
  const { editorConfig } = await import('../web.ts');
  broadcast({ type: 'config', config: editorConfig(cfg) });
}

/** 新拉 / 新建 / 登记的工作区：默认模板还没项目（或者指的目录没了）就直接用它，不用再去点一下「用」 */
async function useIfUnset(cfg: Config, path: string): Promise<void> {
  const p = cfg.templates[cfg.user.defaultTemplate]?.project;
  if (!p || !existsSync(expandProject(p))) await use(cfg, path);
}

/**
 * 启动时补一刀：默认模板还没项目、但已经拉过工作区（比如拉完之前应用重启了、或者是旧版本拉的），直接接上，
 * 免得用户以为配置没存住、又得去手动选。优先预置推荐的那个
 */
export async function adoptWorkspace(cfg: Config): Promise<void> {
  const list = workspaceList();
  const w = list.find((x) => x.name === preset().workspaces[0]?.name) ?? list[0];
  if (w) await useIfUnset(cfg, w.path);
}

/** 设置页「项目」下拉的候选 */
export const workspaceList = () => Object.entries(all()).map(([name, w]) => ({ name, path: w.path }));

export const routes: Record<string, Handler> = {
  'GET /api/setup/workspace/list': async (_b, { cfg }) => ({
    root: ROOT_DIR,
    workspaces: Object.entries(all()).map(([name, w]) => ({
      name, path: w.path, inUse: inUse(cfg, w.path), at: w.at, busy: busy.has(name),
      repos: w.repos.map((r) => ({ ...r, removable: removable(w.path, r.path) })),
    })),
  }),

  /** 先拿这个 token 真访问一次该 host 上的仓库，通了才存。空 token = 删掉 */
  'POST /api/setup/workspace/git-token': async (b) => {
    const host = typeof b?.host === 'string' ? b.host.trim().toLowerCase() : '';
    if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) throw new Error(`host 不合法：「${host}」`);
    const token = typeof b?.token === 'string' ? b.token.trim() : '';
    if (!token) { setGitToken(host, ''); return { ok: true }; }
    if (!/^[\x21-\x7e]+$/.test(token)) return { ok: false, error: 'token 里有空格或别的怪字符，重新复制一下' };
    const urls = [...preset().workspaces.map((w) => w.url), ...Object.values(all()).flatMap((w) => w.repos.map((r) => r.url))];
    const url = urls.find((u) => hostOf(u) === host);
    if (!url) return { ok: false, error: `没有 ${host} 上的仓库地址可以拿来验证` };
    try {
      // 关掉 credential helper：不然钥匙串里存着的别的密码会让一个错的 token 也验证通过
      await git(['-c', 'credential.helper=', 'ls-remote', '--', url, 'HEAD'], HOME_DIR, gitEnv({ ...gitTokens(), [host]: token }), 30_000);
    } catch (e: any) {
      // token 不对时 git 报的是「could not read Username」（想问密码但不让问），人看不懂
      const auth = /Username|Authentication failed|Access denied|40[13]/.test(e.message);
      return { ok: false, error: auth ? `token 不对、过期了，或者没勾 read_repository（${e.message}）` : `用这个 token 访问 ${url} 失败：${e.message}` };
    }
    setGitToken(host, token);
    return { ok: true };
  },

  'POST /api/setup/workspace/clone': async (b, { cfg }) => {
    const url = checkUrl(b?.url);
    const name = checkName(b?.name || nameOf(url), '工作区名');
    taken(name);
    const dir = join(ROOT_DIR, name);
    return start(name, async () => {
      progress('workspace', `clone ${url} …`);
      mkdirSync(ROOT_DIR, { recursive: true });
      await git(['clone', '-q', '--filter=blob:none', '--', url, dir], ROOT_DIR);
      await useIfUnset(cfg, dir); // clone 下来就能用了，子模块缺几个不影响
      return update(name, dir);
    });
  },

  'POST /api/setup/workspace/create': async (b, { cfg }) => {
    const name = checkName(b?.name, '工作区名');
    taken(name);
    const dir = join(ROOT_DIR, name);
    mkdirSync(join(dir, 'repos'), { recursive: true });
    await useIfUnset(cfg, dir);
    return { ok: true, path: dir };
  },

  /** 登记一个已有目录。不联网，只在本地看一眼有哪些仓库；要线上最新再点「更新」 */
  'POST /api/setup/workspace/add-existing': async (b, { cfg }) => {
    const raw = typeof b?.path === 'string' ? b.path.trim() : '';
    const p = raw.startsWith('~/') ? expandProject(raw) : raw;   // 项目下拉里的「常用目录」是 ~/ 开头的
    if (!isAbsolute(p) || !statSync(p, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`不是一个已有的目录：「${p}」`);
    const dir = resolve(p);
    const name = checkName(b?.name || basename(dir), '工作区名');
    taken(name);
    if (Object.values(all()).some((w) => same(w.path, dir))) throw new Error(`${dir} 已经登记过了`);
    const refs = [...await top(name, dir), ...await scan(dir)];
    const repos = await pool(refs, async (r): Promise<Repo> => ({ name: r.name, path: r.path, url: r.url, ...await look(r.path) }));
    save(name, { path: dir, repos });
    await useIfUnset(cfg, dir);
    return { ok: true };
  },

  'POST /api/setup/workspace/add-repo': async (b) => {
    const w = workspace(b?.workspace);
    const url = checkUrl(b?.url);
    const name = checkName(b?.name || nameOf(url), '仓库名');
    const dir = join(w.path, 'repos', name);
    if (existsSync(dir)) throw new Error(`${w.name} 里已经有 repos/${name} 了`);
    return start(w.name, async () => {
      progress('workspace', `clone ${url} → ${w.name}/repos/${name} …`);
      mkdirSync(join(w.path, 'repos'), { recursive: true });
      await git(['clone', '-q', '--filter=blob:none', '--', url, dir], w.path);
      const cur = all()[w.name] ?? w;
      const repos = [...cur.repos.filter((r) => !same(r.path, dir)), { name, path: dir, url, ...await look(dir) }];
      save(w.name, { path: cur.path, at: cur.at, repos });
      return { ok: true, msg: `${w.name}：加好了 ${name}` };
    });
  },

  'POST /api/setup/workspace/update': async (b) => {
    const w = workspace(b?.workspace);
    return start(w.name, () => update(w.name, w.path));
  },

  /** 只删 <工作区>/repos/ 下自己加的仓库 */
  'POST /api/setup/workspace/remove-repo': async (b) => {
    const w = workspace(b?.workspace);
    const name = checkName(b?.repo, '仓库名');
    if (busy.has(w.name)) throw new Error(`${w.name} 正在忙，等它弄完`);
    const dir = join(w.path, 'repos', name);
    let real: string;
    try { real = realpathSync(dir); } catch { throw new Error(`${w.name} 里没有 repos/${name}`); }
    // 名字里已经不可能有 / 和 ..，这里再按真实路径确认一遍：repos/ 或它下面是软链指到别处的，不删
    if (relative(join(realpathSync(w.path), 'repos'), real) !== name) throw new Error(`repos/${name} 指到工作区外面去了，不删`);
    // 子模块的 .git 是个文件：它归顶层仓库管，删了下次更新又会回来
    if (statSync(join(real, '.git'), { throwIfNoEntry: false })?.isFile()) throw new Error(`${name} 是 ${w.name} 自带的子模块，不能单独删`);
    rmSync(real, { recursive: true, force: true, maxRetries: 3 });
    save(w.name, { path: w.path, at: w.at, repos: w.repos.filter((r) => !same(r.path, dir)) });
    return { ok: true };
  },

  /** 默认模板改到这个工作区里跑 */
  'POST /api/setup/workspace/use': async (b, { cfg }) => {
    await use(cfg, workspace(b?.workspace).path);
    return { ok: true };
  },
};

/* ---------- 向导的状态：只读存盘的结果，不跑 git ---------- */

const when = (t: number) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

function detail(w: Saved): string {
  const n = (...s: Repo['state'][]) => w.repos.filter((r) => s.includes(r.state)).length;
  return [
    `${w.repos.length} 个仓库`,
    n('missing') && `缺 ${n('missing')} 个`,
    n('stale', 'error') && `${n('stale', 'error')} 个没更新上`,
    w.at ? `${when(w.at)} 更新` : '还没更新过',
  ].filter(Boolean).join(' · ');
}

export async function sections(cfg: Config): Promise<Section[]> {
  const p = preset();
  const tokens = gitTokens();
  const list = Object.entries(all());
  const checks: Check[] = p.gitHosts.map((h) => ({
    id: `git-token:${h}`,
    label: `GitLab token（${h}）`,
    state: tokens[h] ? 'ok' : 'missing',
    optional: true,
    detail: tokens[h] ? '已填：这里的代码走 HTTPS' : `没配 SSH key 就要填：到 ${p.gitTokenUrl || h} 新建一个（勾 read_repository），贴进来`,
    action: { label: tokens[h] ? '换一个' : '填写', route: '/api/setup/workspace/git-token', body: { host: h } },
  }));

  for (const [name, w] of list) {
    checks.push({
      id: `ws:${name}`, label: name, optional: true,
      state: busy.has(name) ? 'running' : 'ok',
      detail: busy.has(name) ? '正在拉代码…' : detail(w),
      action: { label: '更新', route: '/api/setup/workspace/update', body: { workspace: name } },
    });
  }
  const rec = p.workspaces[0];
  const t = cfg.user.defaultTemplate;
  const project = cfg.templates[t]?.project;
  const used = list.find(([, w]) => inUse(cfg, w.path));
  // 模板指着一个自己的目录（比如命令行版一直在用的 ~/code/my-workspace），目录在就算配好了，不非得是向导拉的
  const own = !used && !!project && existsSync(expandProject(project));
  if (!list.length) {
    checks.push({
      id: 'ws', label: '工作区', state: 'missing', optional: own || undefined,
      detail: rec ? `还没有工作区：拉推荐的 ${rec.name}${rec.note ? `（${rec.note}）` : ''}，或者新建一个空的` : '还没有工作区：新建一个，再往里加仓库',
      ...(rec && { action: { label: `拉取 ${rec.name}`, route: '/api/setup/workspace/clone', body: { url: rec.url, name: rec.name } } }),
    });
  }

  const pick = list.find(([n]) => n === rec?.name) ?? list[0];
  checks.push({
    id: 'in-use', label: '在哪个工作区里排查',
    state: used || own ? 'ok' : 'missing',
    detail: used ? `默认模板「${t}」在 ${used[0]} 里跑`
      : own ? `默认模板「${t}」在 ${project} 里跑（你自己的目录，代码要自己 git pull 保持最新）`
      : project ? `默认模板「${t}」指的 ${project} 不存在了` : `默认模板「${t}」还没指定代码目录`,
    ...(!used && !own && pick && { action: { label: `用 ${pick[0]}`, route: '/api/setup/workspace/use', body: { workspace: pick[0] } } }),
  });
  return [{ id: 'workspace', title: '代码', checks }];
}
