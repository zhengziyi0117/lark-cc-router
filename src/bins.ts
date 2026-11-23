import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { HOME_DIR } from './config.ts';

/**
 * 外部命令在哪。从 Finder / 开始菜单起的桌面应用拿不到 shell 的 PATH，按名字起 claude 会 ENOENT；
 * Windows 上 npm 装出来的是 .cmd 包装脚本，不经 shell 的 spawn 根本找不到它。所以先翻已知位置，翻不到再交给 PATH。
 */
export type Tool = 'claude' | 'lark-cli' | 'git';

export const WIN = process.platform === 'win32';

/** 应用自己装的工具放这儿：向导下载的 lark-cli 是 bin/lark-cli(.exe)，Windows 便携 git 是 bin/git/cmd/git.exe */
export const BIN_DIR = join(HOME_DIR, 'bin');

function candidates(t: Tool): string[] {
  const dirs = [BIN_DIR];
  if (t === 'git') dirs.push(join(BIN_DIR, 'git', 'cmd'));
  // claude 官方安装器在 mac / Windows 上都装到 ~/.local/bin
  dirs.push(join(homedir(), '.local', 'bin'));
  if (!WIN) dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  return dirs;
}

/**
 * 桌面版 lark-cli 的配置目录。不能放进应用数据目录（~/Library/Application Support/…）：@机器人 的长连接要在
 * <这里>/events/<应用 ID>/bus.sock 建一个 unix socket，macOS 上这个路径超过 103 个字符 lark-cli（Go）就起不来，
 * 报「bus did not become ready」。Application Support 那个位置正好 104，实测踩到了。放家目录下一个短路径，
 * 仍然跟命令行版的 ~/.lark-cli 分开
 */
export const larkCliDir = (home = homedir()) => join(home, '.lark-cc-router', 'lark-cli');

/** claude 的配置目录：桌面版用 CLAUDE_CONFIG_DIR 隔离到应用数据目录里，命令行就是 ~/.claude */
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

/** 顺序：环境变量 LCR_CLAUDE / LCR_LARK_CLI / LCR_GIT → 已知位置 → 名字本身（交给 PATH）。每次现找：向导装完立刻生效 */
export function bin(t: Tool): string {
  const env = process.env[`LCR_${t.replace('-', '_').toUpperCase()}`];
  if (env) return env;
  const file = WIN ? `${t}.exe` : t;
  for (const d of candidates(t)) {
    const p = join(d, file);
    if (existsSync(p)) return p;
  }
  return t;
}

/**
 * 掐掉一个子进程连同它起的子进程。Windows 没有信号：kill() 只杀 claude 本身，它起的 bash、MCP 会留下来，
 * taskkill 不带 /F 对控制台程序又不管用，所以那边一律 /T /F。mac / Linux 照旧发信号，claude 自己会收拾子进程。
 */
export function killTree(c: ChildProcess, force = false): void {
  if (c.exitCode !== null || c.signalCode !== null || c.pid === undefined) return;
  if (WIN) {
    spawn('taskkill', ['/pid', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => c.kill());
  } else {
    c.kill(force ? 'SIGKILL' : 'SIGTERM');
  }
}
