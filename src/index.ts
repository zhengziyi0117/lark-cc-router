import { start } from './app.ts';
import { log } from './pipeline.ts';

/** 命令行入口。桌面版走 desktop/，同一个 start() */
const app = await start({ strict: true });

let stoppingAt = 0;
async function shutdown(sig: string): Promise<void> {
  if (stoppingAt) {
    // npm start 会把 Ctrl+C 再转发一遍（终端给整个进程组一次、npm 又转一次，前后差几毫秒）。
    // 以前把这下当成「再按一次」直接退了，卡片来不及改成「已中断」。一秒内的第二下不算
    // ponytail: 1 秒是拍的，人手连按两下一般也要过半秒；真有误判再加大
    if (Date.now() - stoppingAt < 1000) return;
    // 真的又按了一次：不想等了 —— 一个 CC 跑起来可能几分钟
    log('再次中断，立刻退出');
    process.exit(1);
  }
  stoppingAt = Date.now();
  log(`${sig} received, finishing current cycle`);
  await app.stop();
  process.exit(0);
}
// SIGHUP：直接关掉终端窗口。不接的话进程当场没了，群里的卡片停在「处理中」（下次启动 closeOrphans 也会补）
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void shutdown(sig));
