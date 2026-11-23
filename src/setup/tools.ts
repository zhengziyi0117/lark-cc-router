import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { promisify, stripVTControlCharacters } from 'node:util';
import type { Config } from '../config.ts';
import { bin, BIN_DIR, WIN, type Tool } from '../bins.ts';
import { progress, type Check, type Handler, type Section } from './types.ts';

/**
 * 「环境」一段：lark-cli、claude、git 在不在、什么版本，缺的一键装。
 * 装的东西都进 BIN_DIR（claude 除外：官方安装器固定装 ~/.local/bin），bin() 下次就找得到，不用改 PATH。
 * 下载是信任边界：每个文件都对上官方给的 sha256 / sha512 才用，对不上直接丢。
 */

const exec = promisify(execFile);
const TOOLS: Tool[] = ['lark-cli', 'claude', 'git'];
const MAC = process.platform === 'darwin';
// Windows 上 PATH 里可能先有 Git 自带的 GNU tar：解不了 zip，还把 C: 当成远程主机。用系统自带的 bsdtar
const TAR = WIN ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
const POWERSHELL = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

/** `--version` 里的版本号：`lark-cli version 1.0.100` / `2.1.328 (Claude Code)` / `git version 2.47.1.windows.1` */
export function parseVersion(out: string): string | undefined {
  return out.match(/\d+\.\d+\.\d+[^\s()]*/)?.[0];
}

/* ------------------------------ 检测 ------------------------------ */

const installing = new Set<Tool>();

const HINT: Record<Tool, string> = {
  'lark-cli': '飞书命令行：读消息、回卡片都靠它',
  claude: 'Claude Code：真正干活排查的',
  git: MAC ? '在 Xcode 命令行工具里，装的时候会弹系统对话框' : '拉代码用，claude 跑命令也要它的 Git Bash',
};

async function detect(t: Tool): Promise<Check> {
  const base = { id: t, label: t };
  if (installing.has(t)) return { ...base, state: 'running', detail: '安装中…' };
  const missing: Check = { ...base, state: 'missing', detail: HINT[t], action: { label: '安装', route: '/api/setup/tools/install', body: { tool: t } } };
  const path = bin(t);
  try {
    // mac 没装命令行工具时 /usr/bin/git 是个桩，一跑就弹安装框 —— 检测不能弹框，先问 xcode-select。
    // 目录还要真在：「删掉 CommandLineTools 重装」是常见的修法，删完 xcode-select -p 照样打印旧路径
    if (t === 'git' && MAC && (path === 'git' || path === '/usr/bin/git')) {
      const dev = await exec('/usr/bin/xcode-select', ['-p'], { timeout: 5000 }).then((r) => r.stdout.trim(), () => '');
      if (!dev || !existsSync(dev)) return missing;
    }
    // 第一次跑可能慢（mac 的 xcrun 缓存、Windows Defender 扫新 exe），给 10 秒；三个并发，平时总共一两百毫秒
    const { stdout } = await exec(path, ['--version'], { timeout: 10_000, windowsHide: true });
    const v = parseVersion(stdout);
    return v ? { ...base, state: 'ok', detail: v } : { ...base, state: 'error', detail: `看不懂版本输出：${stdout.trim().slice(0, 80)}` };
  } catch (e: any) {
    if (e.code === 'ENOENT') return missing;
    return { ...base, state: 'error', detail: e.killed ? `${path} --version 10 秒没反应` : String(e.stderr || e.message).trim().split('\n')[0] };
  }
}

/**
 * Windows 上 claude 的 Bash 工具要 Git Bash，没有就退回 PowerShell。便携 git 不在 PATH 里 claude 找不到，
 * 用官方文档的 CLAUDE_CODE_GIT_BASH_PATH 指过去；之后起的 claude 子进程都继承 process.env。用户自己设了就不动
 */
function gitBashEnv(): void {
  const bash = join(BIN_DIR, 'git', 'bin', 'bash.exe');
  if (WIN && !process.env.CLAUDE_CODE_GIT_BASH_PATH && existsSync(bash)) process.env.CLAUDE_CODE_GIT_BASH_PATH = bash;
}
// 模块一加载就设一次：重启后不开向导直接进主页，也得有
gitBashEnv();

export async function sections(_cfg: Config): Promise<Section[]> {
  gitBashEnv();
  return [{ id: 'tools', title: '工具', checks: await Promise.all(TOOLS.map(detect)) }];
}

/* ------------------------------ 下载与校验 ------------------------------ */

/** 按顺序试几个源，第一个成功的写到 dest。大文件每 10% 报一次进度 */
async function download(urls: string[], dest: string, who: string): Promise<void> {
  let err: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      // 压缩传输时 content-length 是压缩后的大小，算出来的百分比不对，干脆不报
      const total = res.headers.get('content-encoding') ? 0 : Number(res.headers.get('content-length')) || 0;
      let got = 0, shown = 0;
      await pipeline(res.body, async function* (src) {
        for await (const c of src) {
          got += c.length;
          const pct = total > 5e6 ? Math.floor((got / total) * 10) * 10 : 0;
          if (pct > shown) progress('tools', `${who}：已下载 ${(shown = pct)}%`);
          yield c;
        }
      }, createWriteStream(dest));
      return;
    } catch (e: any) {
      err = e;
      progress('tools', `${who}：${new URL(url).host} 下载失败（${e.message}）${url === urls.at(-1) ? '' : '，换下一个源'}`);
    }
  }
  throw err;
}

export function verify(file: string, algo: 'sha256' | 'sha512', expected: string, enc: 'hex' | 'base64' = 'hex'): void {
  const got = createHash(algo).update(readFileSync(file)).digest(enc);
  // hex 不分大小写（digest 出来是小写）；base64 分
  if (!expected || got !== (enc === 'hex' ? expected.toLowerCase() : expected)) {
    throw new Error(`${basename(file)} 校验没过（${algo} 对不上，下载不完整或被篡改），已丢弃`);
  }
}

/** 跑一个命令，输出逐行推到向导；非 0 退出时带上最后几行输出 */
function run(cmd: string, args: string[], who: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20 * 60_000 });
    const tail: string[] = [];
    const line = (l: string) => {
      l = stripVTControlCharacters(l).trim();
      if (!l) return;
      tail.push(l);
      if (tail.length > 3) tail.shift();
      progress('tools', `${who}：${l}`);
    };
    createInterface({ input: c.stdout }).on('line', line);
    createInterface({ input: c.stderr }).on('line', line);
    c.on('error', reject);
    c.on('close', (code, sig) => code === 0 ? resolve() : reject(new Error(`${basename(cmd)} ${sig ? `被 ${sig} 终止` : `退出码 ${code}`}${tail.length ? `：${tail.join(' / ')}` : ''}`)));
  });
}

/** BIN_DIR 下的临时目录：跟目标同一个盘，最后一步 rename 是原子的，装一半不会留下坏文件 */
async function inTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  mkdirSync(BIN_DIR, { recursive: true });
  const dir = mkdtempSync(join(BIN_DIR, '.tmp-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ------------------------------ lark-cli ------------------------------ */

// npmmirror 在前：公司网络下比 npmjs / GitHub 快得多。完整性不靠源，靠下面的校验链
const REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org'];

/** lark-cli 某版本在当前平台的发布包。命名和来源照抄 @larksuite/cli 的 scripts/install.js（resolveReleaseAsset / resolveMirrorUrls） */
export function larkAsset(version: string, platform: string = process.platform, arch: string = process.arch) {
  const os = ({ darwin: 'darwin', win32: 'windows', linux: 'linux' } as Record<string, string>)[platform];
  const cpu = ({ x64: 'amd64', arm64: 'arm64' } as Record<string, string>)[arch];
  if (!os || !cpu) throw new Error(`lark-cli 没有 ${platform}-${arch} 的版本`);
  const name = `lark-cli-${version}-${os}-${cpu}${os === 'windows' ? '.zip' : '.tar.gz'}`;
  return {
    name,
    exe: os === 'windows' ? 'lark-cli.exe' : 'lark-cli',
    urls: [`https://registry.npmmirror.com/-/binary/lark-cli/v${version}/${name}`, `https://github.com/larksuite/cli/releases/download/v${version}/${name}`],
  };
}

/** checksums.txt（sha256sum 格式：`<hex>  <文件名>`）里某个文件的 sha256 */
export function checksumOf(txt: string, name: string): string {
  const hash = txt.split('\n').map((l) => l.trim().split(/\s+\*?/)).find(([, f]) => f === name)?.[0];
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`checksums.txt 里没有 ${name}`);
  return hash;
}

async function latestLarkCli(): Promise<{ version: string; tarball: string; integrity: string }> {
  let err: unknown;
  for (const r of REGISTRIES) {
    try {
      const res = await fetch(`${r}/@larksuite/cli/latest`, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const m: any = await res.json();
      // version 要拼进文件名和 URL，只认纯版本号
      if (!/^\d+\.\d+\.\d+[\w.-]*$/.test(m.version) || !/^sha512-/.test(m.dist?.integrity)) throw new Error('registry 返回的版本信息不对');
      return { version: m.version, tarball: m.dist.tarball, integrity: m.dist.integrity };
    } catch (e) { err = e; }
  }
  throw err;
}

/**
 * 校验链跟 npm 包自己的 postinstall 一样：registry 给 npm 包的 sha512 → npm 包里的 checksums.txt → 二进制的 sha256。
 * 只是不经 npm（产品同学的机器上没有 Node），二进制直接放 BIN_DIR。
 */
async function installLarkCli(): Promise<string> {
  progress('tools', 'lark-cli：查最新版本…');
  const meta = await latestLarkCli();
  const asset = larkAsset(meta.version);
  await inTmp(async (tmp) => {
    const tgz = join(tmp, 'package.tgz');
    await download([meta.tarball], tgz, 'lark-cli');
    verify(tgz, 'sha512', meta.integrity.slice('sha512-'.length), 'base64');
    await run(TAR, ['-xzf', tgz, '-C', tmp, 'package/checksums.txt'], 'lark-cli');
    const sha = checksumOf(readFileSync(join(tmp, 'package', 'checksums.txt'), 'utf8'), asset.name);

    progress('tools', `lark-cli：下载 v${meta.version}…`);
    const archive = join(tmp, asset.name);
    await download(asset.urls, archive, 'lark-cli');
    verify(archive, 'sha256', sha);
    const out = join(tmp, 'x');
    mkdirSync(out);
    await run(TAR, ['-xf', archive, '-C', out], 'lark-cli');
    chmodSync(join(out, asset.exe), 0o755);
    // ponytail: Windows 上 lark-cli.exe 正在跑（轮询中）时覆盖会 EPERM；向导只在「缺」的时候给装，碰不到。要做升级再加 rename 成 .old 那一套
    renameSync(join(out, asset.exe), join(BIN_DIR, asset.exe));
  });
  return `lark-cli v${meta.version} 装好了`;
}

/* ------------------------------ claude ------------------------------ */

/** 官方原生安装器（https://code.claude.com/docs/en/setup）：自己校验 sha256，装到 ~/.local/bin */
async function installClaude(): Promise<string> {
  progress('tools', 'claude：运行官方安装器，下载期间没有进度，可能要几分钟…');
  if (WIN) {
    // 官方 PowerShell 命令原样照搬，参数写死，不拼任何外部输入
    await run(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://claude.ai/install.ps1 | iex'], 'claude');
  } else {
    // = curl -fsSL https://claude.ai/install.sh | bash，拆成两步就不用经 shell 拼管道
    await inTmp(async (tmp) => {
      const script = join(tmp, 'install.sh');
      await download(['https://claude.ai/install.sh'], script, 'claude');
      await run('/bin/bash', [script], 'claude');
    });
  }
  return 'claude 装好了';
}

/* ------------------------------ git ------------------------------ */

/**
 * Windows 便携版 git。sha256 抄自官方发布页（github.com/git-for-windows/git/releases 的 Filename | SHA-256 表），
 * 跟 GitHub API 给的 asset digest 一致。只要 x64：ARM 的 Windows 能跑 x64。
 * ponytail: 版本写死，不追最新 —— 校验值有出处、不用多查一次 GitHub API。升级 = 改这三行
 */
const PORTABLE_GIT = {
  tag: 'v2.56.1.windows.1',
  name: 'PortableGit-2.56.1-64-bit.7z.exe',
  sha256: '9dd04a608ceb5f6ab32a73709e0ecb159d211da71b697c45ff81f6dd0c6b49c7',
};

export function portableGitUrls(g = PORTABLE_GIT): string[] {
  return [
    `https://registry.npmmirror.com/-/binary/git-for-windows/${g.tag}/${g.name}`,
    `https://github.com/git-for-windows/git/releases/download/${g.tag}/${g.name}`,
  ];
}

async function installGit(): Promise<string> {
  if (MAC) {
    // 只是弹出系统对话框就返回了，下载安装是系统自己做的，我们等不到它结束
    await run('/usr/bin/xcode-select', ['--install'], 'git');
    return 'git：已弹出系统对话框，点「安装」，等它装完再点「重新检测」';
  }
  if (!WIN) throw new Error('这个系统请自己用包管理器装 git');
  const dir = join(BIN_DIR, 'git');
  await inTmp(async (tmp) => {
    const sfx = join(tmp, PORTABLE_GIT.name);
    await download(portableGitUrls(), sfx, 'git');
    verify(sfx, 'sha256', PORTABLE_GIT.sha256);
    progress('tools', 'git：解压中…');
    // 7z 自解压包：-o 目标目录、-y 不问。解完它自己跑 post-install。装一半失败就整个删掉，免得 bin() 找到个坏的
    rmSync(dir, { recursive: true, force: true });
    try {
      await run(sfx, [`-o${dir}`, '-y'], 'git');
      if (!existsSync(join(dir, 'cmd', 'git.exe'))) throw new Error('解压完没找到 cmd\\git.exe');
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  });
  gitBashEnv();
  return 'git 装好了';
}

/* ------------------------------ 路由 ------------------------------ */

const INSTALL: Record<Tool, () => Promise<string>> = { 'lark-cli': installLarkCli, claude: installClaude, git: installGit };

export const routes: Record<string, Handler> = {
  /** 立刻返回，过程走 SSE。同一个工具正在装就不再起第二份 */
  'POST /api/setup/tools/install': async ({ tool }) => {
    if (!TOOLS.includes(tool)) throw new Error(`不认识的工具：${tool}`);
    if (installing.has(tool)) return { started: true };
    installing.add(tool);
    // 先摘掉「安装中」再推 done：页面收到 done 就刷新状态，晚一步摘会看到它还在装
    const end = (ok: boolean, msg: string) => { installing.delete(tool); progress('tools', msg, { ok }); };
    INSTALL[tool as Tool]().then((m) => end(true, m), (e) => end(false, `${tool} 安装失败：${e.message}`));
    return { started: true };
  },
};
