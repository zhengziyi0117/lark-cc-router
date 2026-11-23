import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * 自动更新：读最新 Release 里的 latest.json（CI 发版时生成：版本号 + 每个包的大小、sha256）→
 * 下这个平台的安装包、对上大小和 sha256 → 装上重启。什么时候查、什么时候装由 main.js 定。
 * 不走 api.github.com：不带 token 每个 IP 一小时 60 次，公司里大家一个出口 IP，早就用光了（实测 403）。
 * releases/latest/download/xxx 是普通下载地址，没这个限制；不带 token，所以仓库得是公开的。
 * 没用 electron-updater：mac 上它走 Squirrel.Mac，要正经的开发者签名，我们只有 ad-hoc 签名，装不上。
 */

/** 'v0.2.10' 比 '0.2.9' 新？ */
export function newer(tag, current) {
  const a = tag.replace(/^v/, '').split('.').map(Number), b = current.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

/** 这个平台的安装包：mac 只出 Apple 芯片的 dmg，Windows 是 NSIS 安装程序 */
export function assetFor(assets, platform) {
  const re = { darwin: /-arm64\.dmg$/, win32: /-Setup-[\d.]+\.exe$/ }[platform];
  return re && assets.find((a) => re.test(a.name));
}

/** 有比 current 新、而且有这个平台包的版本就返回 { version, name, url, size, sha256 }，否则 null */
export async function check(repo, current, platform = process.platform) {
  const r = await fetch(`https://github.com/${repo}/releases/latest/download/latest.json`);
  if (!r.ok) throw new Error(`GitHub 返回 ${r.status}${r.status === 404 ? '（仓库不是公开的，或者最新版没带 latest.json）' : ''}`);
  const m = await r.json();
  if (!newer(m.version, current)) return null;
  const a = assetFor(m.files ?? [], platform);
  return a ? { version: m.version, name: a.name, size: a.size, sha256: a.sha256, url: `https://github.com/${repo}/releases/download/v${m.version}/${a.name}` } : null;
}

/** 下到 dir/name，大小、sha256 都对上才落盘（dir 先清空）。一百来 MB 整个读进内存再算，省得边下边算 */
export async function download(u, dir) {
  const r = await fetch(u.url);
  if (!r.ok) throw new Error(`下载失败：${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length !== u.size) throw new Error(`下载不完整：${buf.length} / ${u.size} 字节`);
  if (createHash('sha256').update(buf).digest('hex') !== u.sha256) throw new Error('sha256 对不上，丢掉了');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, u.name);
  writeFileSync(file, buf);
  return file;
}

/**
 * mac 第一步（服务还在跑）：从 dmg 里把新 .app 拷到旧的旁边（xxx.app.new），返回旧 .app 的路径。
 * 装不了就抛错：没在「应用程序」里跑（直接从 dmg / 下载目录打开的会被系统挪到只读的临时位置），或者目录没写权限
 */
export function stageMac(dmg, exe) {
  const app = resolve(exe, '../../..');
  if (!app.endsWith('.app') || app.includes('/AppTranslocation/') || app.startsWith('/Volumes/')) throw new Error(`没装在「应用程序」里（${app}）`);
  const mnt = mkdtempSync(join(dirname(dmg), 'mnt-'));
  execFileSync('hdiutil', ['attach', '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mnt, dmg], { stdio: 'ignore' });
  try {
    const src = readdirSync(mnt).find((n) => n.endsWith('.app'));
    if (!src) throw new Error('dmg 里没有 .app');
    rmSync(app + '.new', { recursive: true, force: true });
    execFileSync('ditto', [join(mnt, src), app + '.new']);
  } finally {
    execFileSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'ignore' });
  }
  return app;
}

/** mac 第二步（服务已停）：新旧对调。正在跑的进程不受影响，文件删了也照样能用到退出 */
export function swapMac(app) {
  renameSync(app, app + '.old');
  try { renameSync(app + '.new', app); } catch (e) { renameSync(app + '.old', app); throw e; }
  rmSync(app + '.old', { recursive: true, force: true });
}

/**
 * Windows（服务已停、马上退出）：静默装，装完把应用拉起来。不管装没装成都拉 —— 没成就还是旧版本，总比没了强。
 * hidden = 回托盘不弹窗口（后台自动更新时）
 */
export function runWinInstaller(file, exe, hidden) {
  const cmd = `start "" /wait "${file}" /S --updated & start "" "${exe}"${hidden ? ' --hidden' : ''}`;
  spawn('cmd.exe', ['/d', '/s', '/c', `"${cmd}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true }).unref();
}
