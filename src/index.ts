import { start } from './app.ts';
import { log } from './pipeline.ts';

/** 命令行入口。桌面版走 desktop/，同一个 start() */
const app = await start({ strict: true });

let stopping = false;
async function shutdown(sig: string): Promise<void> {
  // 第二次按就是不想等了 —— 一个 CC 跑起来可能几分钟
  if (stopping) { log('再次中断，立刻退出'); process.exit(1); }
  stopping = true;
  log(`${sig} received, finishing current cycle`);
  await app.stop();
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void shutdown(sig));
