import { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } from 'electron';
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import tls from 'node:tls';
import { check, download, runWinInstaller, stageMac, swapMac } from './update.js';

/**
 * 桌面版入口：设好数据目录和 PATH，起跟命令行同一个 start()，再开窗口指向它的 web UI。
 * 规划和各模块的契约见 doc/desktop-plan.md。
 */

// 第二次双击 = 把已有窗口拉出来，不能起第二份：两份会一起轮询、一起回同一条消息
if (!app.requestSingleInstanceLock()) app.exit(0);

// 必须在 import src/ 之前设：config.ts 一 import 就读 LCR_HOME 定数据目录。开发态、打包后都是应用数据目录；
// LCR_HOME 显式设了就听它的（测试时指到临时目录）
const explicitHome = !!process.env.LCR_HOME;
const HOME = process.env.LCR_HOME || app.getPath('userData');
process.env.LCR_HOME = HOME;
mkdirSync(HOME, { recursive: true });
// lark-cli 和 claude 的配置也单独放：跟命令行版、自己平时用的 Claude Code 分开，不会搞混。子进程继承 env 自然吃到
process.env.CLAUDE_CONFIG_DIR = join(HOME, 'claude');
process.env.LARKSUITE_CLI_CONFIG_DIR = explicitHome ? join(HOME, 'lark-cli') : await larkDir();

/** lark-cli 放家目录下的短路径（原因见 bins.ts 的 larkCliDir）。0.2.0 及以前放在应用数据目录里，搬过来，登录不丢 */
async function larkDir() {
  const { larkCliDir } = await import('../src/bins.ts'); // 必须在设好 LCR_HOME 之后 import：bins.ts 会带出 config.ts
  const dir = larkCliDir();
  const old = join(HOME, 'lark-cli');
  if (!existsSync(dir) && existsSync(old)) {
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(old, dir);
  }
  return dir;
}

// 打包后 stdout 没人看：日志写进数据目录，出问题让用户把这个文件发过来（托盘菜单「打开日志」）。
// 上一次的留一份 app.prev.log：出了问题人家第一反应是重启，不留的话现场就没了
// ponytail: 每次启动覆盖，常驻几周会一直长；真嫌大再按大小轮转
const LOG = join(HOME, 'app.log');
if (app.isPackaged) {
  try { renameSync(LOG, join(HOME, 'app.prev.log')); } catch { /* 第一次启动没有 */ }
  const f = createWriteStream(LOG, { flags: 'w' });
  process.stdout.write = process.stderr.write = f.write.bind(f);
}

fixEnv();

/**
 * 子进程（claude、lark-cli、git）都继承这份 env，在这儿一次配好：
 *   - PATH：从 Finder / 程序坞起的 mac 应用只有 /usr/bin:/bin:/usr/sbin:/sbin，claude、brew 的 git 都找不到。
 *     向导自己装的工具（lark-cli、Windows 便携 git）放最前面 —— claude 装插件时是按名字找 git 的
 *   - 代理：mac 上 .zshrc 里 export 的代理同样拿不到，一起从登录 shell 取回来
 */
function fixEnv() {
  const sh = shellEnv();
  const dirs = [join(HOME, 'bin'), join(HOME, 'bin', 'git', 'cmd'),
    ...(sh.PATH ?? '').split(delimiter), ...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin')];
  if (process.platform !== 'win32') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  process.env.PATH = [...new Set(dirs.filter(Boolean))].join(delimiter);

  for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) {
    if (sh[k] && !process.env[k]) process.env[k] = sh[k];
  }
  // 本机页面不能走代理：不然主进程自己 fetch 127.0.0.1 也会被转去代理
  process.env.NO_PROXY = [process.env.NO_PROXY ?? process.env.no_proxy, '127.0.0.1', 'localhost'].filter(Boolean).join(',');

  // 公司代理 / HTTPS 检查：Node 的 fetch 默认不认环境变量里的代理、不认系统证书库。
  // 这两个环境变量 Node 只在进程启动时读 —— 管得了 node 子进程（MCP 之类），管不了已经在跑的主进程，
  // 主进程（判定、网关测试都在这儿发请求）用运行时 API 补上
  process.env.NODE_USE_ENV_PROXY = '1';
  process.env.NODE_USE_SYSTEM_CA = '1';
  try {
    http.setGlobalProxyFromEnv();
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), ...tls.getCACertificates('system')]);
  } catch (e) {
    console.error(`代理 / 系统证书没配上：${e.message}`);
  }
}

/** mac：起一次登录 + 交互 shell（才会读 .zprofile / .zshrc）把 env 取回来。Windows 开始菜单起的程序本来就带用户环境变量 */
function shellEnv() {
  if (process.platform === 'win32') return {};
  try {
    // rc 里可能打印别的东西，加个记号只取记号后面那段
    const out = execFileSync(process.env.SHELL || '/bin/zsh', ['-ilc', 'echo __LCR_ENV__; env'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Object.fromEntries(out.split('__LCR_ENV__\n').pop().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  } catch {
    return {}; // rc 写坏了、超时：算了，PATH 兜底的几个目录也够用
  }
}

/** 第一次打开：给一份能用的配置 —— 只开 @我，一个「通用」模板。project 留空，向导里选工作区时填 */
const CONFIG = join(HOME, 'config.json');
if (!existsSync(CONFIG)) {
  const { DEFAULT_SYSTEM_PROMPT } = await import('../src/config.ts');
  const { DEFAULT_JUDGE_PROMPT } = await import('../src/judge.ts');
  writeFileSync(CONFIG, JSON.stringify({
    user: { on: true },
    // @机器人 不进桌面版：同一个飞书应用多台机器连长连接会抢消息
    bot: { on: false },
    templates: { 通用: { permissionMode: 'auto', prompt: DEFAULT_SYSTEM_PROMPT, judge: DEFAULT_JUDGE_PROMPT } },
  }, null, 2) + '\n', { mode: 0o600 });
}

/** 8787 被占（比如命令行版也开着）就随便挑一个空的。直接传给 start()，不写 PORT：环境变量会传给 claude 子进程 */
const tryPort = (p) => new Promise((r) => {
  const s = createServer().once('error', () => r(0));
  s.listen(p, '127.0.0.1', () => { const got = s.address().port; s.close(() => r(got)); });
});
const PORT = (await tryPort(8787)) || (await tryPort(0));

const { start } = await import('../src/app.ts');
const { setPickFolder } = await import('../src/web.ts');
const { adoptWorkspace } = await import('../src/setup/workspace.ts');
const { busy } = await import('../src/pipeline.ts');

// 不能在顶层 await whenReady()：ESM 入口的顶层 await 不结束，Electron 就不发 ready，会互相等死
app.whenReady().then(main).catch((e) => {
  dialog.showErrorBox('启动失败', `${e.message}\n\n日志：${LOG}`);
  app.exit(1);
});

let svc, base, win = null, tray = null;
let quitting = false;

async function main() {
  svc = await start({ strict: false, port: PORT });
  if (!svc.port) throw new Error(`本地页面起不来（端口 ${PORT} 被占？）`);
  base = `http://127.0.0.1:${svc.port}`;
  await adoptWorkspace(svc.cfg).catch((e) => console.error(`接上工作区失败：${e.message}`));
  // 设置页「项目」那里的「选择文件夹…」：网页自己弹不了系统框，借主进程的
  setPickFolder(async () => {
    const r = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0] ?? null;
  });
  // 打包后程序坞用 .app 里的图标；开发态跑的是 Electron 本体，得自己换
  if (process.platform === 'darwin' && !app.isPackaged) app.dock.setIcon(ICON);
  tray = createTray(); // 留着引用：被 GC 掉的话托盘图标就没了
  menu();
  const visible = !process.argv.includes('--hidden');
  if (!visible) app.dock?.hide();
  await createWindow(visible);
  setTimeout(tick, 60_000);
  setInterval(tick, 10 * 60_000);
}

/* ---------- 窗口 ---------- */

async function createWindow(visible = true) {
  win = new BrowserWindow({ width: 1200, height: 820, title: 'lark-cc-router', show: visible, icon: ICON });
  // 页面里的外链（飞书消息、文档、GitLab）交给系统浏览器；只放 http(s)，别让页面里的内容拉起 file:// 之类
  const external = (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(base + '/')) return;
    e.preventDefault();
    external(url);
  });
  // 关窗口 = 收进托盘：服务要一直跑着才能回消息。真退出走托盘菜单 / Cmd+Q。
  // mac 顺手把程序坞图标也藏了，只剩菜单栏那个，像个后台程序；Windows 窗口一藏任务栏就没了，本来就是这样
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); app.dock?.hide(); } });
  // 只有真缺东西才进向导；还在检测的（网关、MCP 每次启动都要重测几秒）不拦，配过一次就直接进主页
  const { todo } = await fetch(`${base}/api/setup/status`).then((r) => r.json()).catch(() => ({ todo: true }));
  win.loadURL(base + (todo ? '/setup' : '/'));
}

function show() {
  if (!base) return; // 服务还没起来，起来了会自己开窗口
  app.dock?.show();
  // 页面自己 window.close() 会绕过上面的 close 拦截直接销毁窗口，那就重开一个
  if (!win || win.isDestroyed()) return void createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

app.on('second-instance', show);
app.on('activate', show); // mac 点程序坞图标
// 托盘应用：窗口没了也接着跑（不监听的话 Electron 默认直接退出）
app.on('window-all-closed', () => {});

/* ---------- 托盘 ---------- */

/** 图标源文件是 desktop/icon.svg、tray.svg，改了重新导出 PNG（见 doc/desktop.md） */
const ICON = join(import.meta.dirname, process.platform === 'win32' ? 'icon-win.png' : 'icon.png');

/** mac：文件名带 Template = 模板图，菜单栏深浅色自己适配，@2x 自动挑。Windows：彩色应用图标缩到 32 */
function trayIcon() {
  if (process.platform === 'darwin') return nativeImage.createFromPath(join(import.meta.dirname, 'trayTemplate.png'));
  return nativeImage.createFromPath(ICON).resize({ width: 32, height: 32, quality: 'best' });
}

/**
 * Windows 开机起的时候带 --hidden，别每次开机都弹窗口；mac 13+ 认不出是不是开机起的，照常弹。
 * 查的时候也要带同样的 args：Windows 按 args 比对，不带的话勾上了重启后显示成没勾
 */
const LOGIN = { args: ['--hidden'] };

function createTray() {
  const t = new Tray(trayIcon());
  t.setToolTip(`lark-cc-router ${app.getVersion()}`); // 托盘上悬停就能看到是哪个版本，排查时先问这个
  t.on('click', show); // Windows 左键单击托盘图标 = 打开；mac 单击弹菜单
  return t;
}

/** 托盘菜单。更新那一项跟着状态变，状态一变就重建 */
function menu() {
  const u = {
    idle: { label: '检查更新', click: () => findUpdate(true) },
    checking: { label: '正在检查更新…', enabled: false },
    downloading: { label: `正在下载 ${upd.version}…`, enabled: false },
    ready: { label: `重启并更新到 ${upd.version}`, click: () => applyUpdate(false) },
    manual: { label: `安装 ${upd.version}（打开安装包，拖进「应用程序」）`, click: () => shell.openPath(upd.file) },
  }[upd.state];
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: '打开', click: show },
    {
      label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings(LOGIN).openAtLogin,
      click: (i) => app.setLoginItemSettings({ ...LOGIN, openAtLogin: i.checked }),
    },
    { label: '打开日志', click: () => shell.showItemInFolder(LOG) },
    { type: 'separator' },
    ...(UPDATES ? [u, { type: 'separator' }] : []),
    { label: '退出', click: () => app.quit() },
  ]));
}

/* ---------- 自动更新（实现在 update.js） ---------- */

// 仓库来自 package.json 的 repository（github:用户/仓库），打包后才查。开发态跑的是源码，没得更新
const REPO = String(JSON.parse(readFileSync(join(import.meta.dirname, '../package.json'), 'utf8')).repository ?? '').replace(/^github:/, '');
const UPDATES = app.isPackaged && /^[\w.-]+\/[\w.-]+$/.test(REPO);
const upd = { state: 'idle', version: '', file: '', app: '', checkedAt: 0 };

/**
 * 每 10 分钟看一眼：离上次查过了 6 小时就再查，有新版就下好；下好了等到「窗口收着、没有作业在跑」自己装上重启，
 * 重启后回托盘、不弹窗口。窗口一直开着就不动它，托盘菜单里也能手动点
 */
function tick() {
  if (!UPDATES) return;
  if (upd.state === 'idle' && Date.now() - upd.checkedAt > 6 * 3600_000) findUpdate(false);
  if (upd.state === 'ready' && !(win && !win.isDestroyed() && win.isVisible()) && !busy()) applyUpdate(true);
}

async function findUpdate(manual) {
  if (upd.state !== 'idle') return;
  upd.checkedAt = Date.now(); // 失败了也等 6 小时再查：GitHub 不带 token 一小时只给 60 次
  upd.state = 'checking'; menu();
  let file = '';
  try {
    const u = await check(REPO, app.getVersion());
    if (!u) {
      upd.state = 'idle';
      if (manual) dialog.showMessageBox({ message: `已经是最新版本（${app.getVersion()}）` });
      return;
    }
    upd.state = 'downloading'; upd.version = u.version; menu();
    file = await download(u, join(app.getPath('temp'), 'lark-cc-router-update'));
    upd.app = process.platform === 'darwin' ? stageMac(file, app.getPath('exe')) : '';
    Object.assign(upd, { state: 'ready', file });
    console.log(`新版本 ${u.version} 已下好，空闲时装上`);
    tick();
  } catch (e) {
    console.error(`自动更新：${e.message}`);
    // 下好了但 mac 上换不了（没装在「应用程序」里、没写权限）：让用户自己拖。别的失败等下次再查
    if (file) Object.assign(upd, { state: 'manual', file });
    else upd.state = 'idle';
    if (manual) dialog.showMessageBox({ type: 'warning', message: '更新失败', detail: e.message });
  } finally {
    menu();
  }
}

/** 停服务（作业收尾）→ 换新版 → 重启。hidden = 重启后回托盘。换失败了就重启旧版本，服务不能就这么停了 */
async function applyUpdate(hidden) {
  if (upd.state !== 'ready' || quitting) return;
  quitting = true;
  if (win && !win.isDestroyed()) win.hide();
  await Promise.race([svc?.stop(), new Promise((r) => setTimeout(r, 15_000))]);
  const args = [...process.argv.slice(1).filter((a) => a !== '--hidden'), ...(hidden ? ['--hidden'] : [])];
  try {
    if (process.platform === 'darwin') { swapMac(upd.app); app.relaunch({ args }); }
    else runWinInstaller(upd.file, process.execPath, hidden);
  } catch (e) {
    console.error(`装新版本失败：${e.message}`);
    app.relaunch({ args });
  }
  app.exit(0);
}

/* ---------- 退出 ---------- */

// 退出要先把在跑的作业收尾（群里的卡片改成「已中断」），stop() 自己最多等 10 秒，这里再兜一个上限
app.on('before-quit', (e) => {
  if (quitting) return e.preventDefault();
  quitting = true;
  e.preventDefault();
  if (win && !win.isDestroyed()) win.hide();
  Promise.race([svc?.stop(), new Promise((r) => setTimeout(r, 15_000))]).finally(() => app.exit(0));
});
// 开发态在终端里 Ctrl+C：走同一条收尾
for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => app.quit());
