import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, scopeOf, type Config } from './config.ts';
import { userAuth } from './lark.ts';
import { Pool } from './store.ts';
import { Db } from './db.ts';
import { pollGroups, drain, log, startBot, closeOrphans, backfillUsage } from './pipeline.ts';
import { startWeb } from './web.ts';
import { subscribe } from './bus.ts';

/**
 * @我 那条路少了就跑不起来的 scope：以我本人身份读群消息（轮询的地基）、发 / 改卡片、搜 @我 的消息。
 * reactions:read 看着跟搜索无关，但 `+messages-search` 带了 --no-reactions 照样要它 —— 少了每轮都 search failed、
 * 页面上什么都看不到（同事装完 @ 了没反应就是这个）。向导登录时也按这份申请，见 setup/auth.ts
 */
export const NEED = ['im:message.group_msg:get_as_user', 'im:message.send_as_user', 'search:message', 'im:message.reactions:read'];

/**
 * 认出"我"是谁（lark-cli 登录的用户），再查 @我 那条路缺哪些 scope。返回缺的 scope，空数组 = 能跑。
 * 只开机器人的话不拦：没登录也能跑，只是私聊通知我、读话题上下文这些以我身份做的事做不了。
 */
async function preflight(cfg: Config): Promise<string[]> {
  const { openId, scopes } = await userAuth().catch(() => ({ openId: '', scopes: [] as string[] }));
  cfg.me = openId;
  if (!cfg.user.on) return [];
  if (!openId) return NEED;
  return NEED.filter((s) => !scopes.includes(s));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } // EPERM = 在跑，只是不归我管
}

/**
 * 一份数据目录同时只能有一个在跑。命令行版和桌面版（开发态）共用仓库里那份配置，两边一起开就会一起轮询、
 * 同一条 @ 回两遍。进程崩了留下的锁不算数（pid 已经没了）。返回解锁函数
 */
export function lock(dir: string): () => void {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, 'run.pid');
  const pid = existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0;
  if (pid && pid !== process.pid && alive(pid)) {
    throw new Error(`这份配置已经有一个在跑了（pid ${pid}，${dir}）：命令行版和桌面版别同时开，先关掉那个`);
  }
  writeFileSync(f, String(process.pid));
  return () => { try { if (readFileSync(f, 'utf8') === String(process.pid)) rmSync(f); } catch { /* 已经没了 */ } };
}

export interface App {
  cfg: Config;
  /** web UI 实际监听的端口；起不来是 0（路由照常跑，只是没有 UI） */
  port: number;
  /** 把在跑的作业收尾（群里的卡片变成「已中断」，最多等 10 秒），关长连接、关 web、关库 */
  stop(): Promise<void>;
}

/**
 * strict（命令行）：@我 缺 scope 直接退出，跟以前一样。
 * 非 strict（桌面版）：照样起 web —— 上手向导就在里面，用户扫完码下一轮自己就跑起来了，不用重启。
 */
export async function start(o: { strict?: boolean; port?: number } = {}): Promise<App> {
  const cfg = loadConfig();
  const unlock = lock(cfg.stateDir);
  // 桌面版直接传端口，不走 PORT 环境变量：环境变量会一路传给 claude 和它起的命令
  if (o.port !== undefined) cfg.port = o.port;
  // 两个入口各一个库：去重、话题 → session、历史各管各的（见 Db）
  const dbs = { user: new Db(cfg.stateDir), bot: new Db(cfg.stateDir, 'bot.db') };
  // 并发上限是共用的：两边跑的是同一台机器上的 CC
  const pool = new Pool(cfg.maxJobs);
  // 上回没走正常停机就没了的作业：卡片补成「已中断」。不等它，飞书慢也别拖住启动
  void closeOrphans(dbs.user, 'user');
  void closeOrphans(dbs.bot, 'bot');
  void backfillUsage(dbs.user).then(() => backfillUsage(dbs.bot)).catch((e) => log(`补用量失败（不影响运行）: ${e.message}`));

  let missing = await preflight(cfg);
  if (missing.length) {
    log(`!! 缺 scope: ${missing.join(' ')}`);
    log(`!! 修：lark-cli auth login --scope "${missing.join(' ')}" 然后扫码`);
    if (o.strict) process.exit(1);
  }

  log(`@我：${cfg.user.on ? `每 ${cfg.pollMs}ms 搜一轮，${Object.keys(cfg.user.chats).length} 个会话` : '关'}`);

  const server = startWeb(cfg, dbs, pool);
  const port = await new Promise<number>((r) => {
    server.once('listening', () => r((server.address() as any)?.port ?? cfg.port));
    server.once('error', () => r(0));
  });

  /**
   * @机器人 跟着配置开关：web UI 上一切就起 / 停长连接，不用重启。
   * 串成一条链 —— 连着保存两次不能起两份连接。
   */
  let stopping = false;
  let stopBot: (() => void) | null = null;
  let botSync: Promise<void> = Promise.resolve();
  const syncBot = () => {
    botSync = botSync.then(async () => {
      if (cfg.bot.on && !stopBot && !stopping) stopBot = await startBot(cfg, pool, dbs.bot);
      else if ((!cfg.bot.on || stopping) && stopBot) { stopBot(); stopBot = null; }
    }).catch((e: any) => log(`@机器人 开关失败: ${e.message}`));
  };
  const offConfig = subscribe((m) => { if (m.type === 'config') syncBot(); });
  syncBot();

  /** 睡到一半被叫醒用 —— 不然停机后要干等一整个 pollMs */
  let nap: (() => void) | null = null;
  const sleep = (ms: number) => new Promise<void>((r) => {
    const t = setTimeout(() => { nap = null; r(); }, ms);
    nap = () => { clearTimeout(t); nap = null; r(); };
  });

  const loop = (async () => {
    while (!stopping) {
      try {
        // 每轮现取：web UI 上关了 @我 就不搜，模板 / 会话改了下一轮就是新的
        if (cfg.user.on) {
          // 还没就绪（桌面版第一次打开、还没扫码）就每轮重查一次，就绪了就不再查
          if (missing.length || !cfg.me) missing = await preflight(cfg);
          if (!missing.length) await pollGroups(scopeOf(cfg, 'user'), pool, dbs.user);
        }
      } catch (e: any) {
        log(`cycle error: ${e.message}`);
      }
      if (stopping) break;
      await sleep(cfg.pollMs);
    }
  })();

  let stopped: Promise<void> | null = null;
  const stop = () => stopped ??= (async () => {
    stopping = true;
    const draining = drain(); // 同步掐，见 drain 的注释
    syncBot();                // 关长连接
    nap?.();
    await loop;
    await draining;           // 等在跑的作业把卡片收成「已中断」，最多 10 秒
    await botSync;
    offConfig();
    // 必须显式关：listen 的 handle 和浏览器那几条 SSE 长连接会把事件循环一直撑住
    server.closeAllConnections();
    server.close();
    dbs.user.close();
    dbs.bot.close();
    unlock();
    log('stopped');
  })();

  return { cfg, port, stop };
}
