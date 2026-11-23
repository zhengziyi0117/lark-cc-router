import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drain, runTest } from './pipeline.ts';
import { Db } from './db.ts';
import { Pool } from './store.ts';
import type { Scope } from './config.ts';

// 单独一个文件：drain 会把整个进程标成「停机了」，跟别的测试放一起会把它们一起带走

test('Ctrl+C 时只有试跑在跑：也要掐掉、等它把卡片收成「已中断」再退出', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcr-stop-'));
  const log = join(dir, 'lark.log');
  writeFileSync(log, '');
  // 假 lark-cli：发卡 / 改卡记一行（带卡片标题）
  writeFileSync(join(dir, 'lark-cli'), `#!/bin/sh
t=$(printf '%s' "$*" | grep -o '处理中\\|已完成\\|已中断' | head -1)
case "$*" in
  *"+messages-send"*) echo "send $t" >> "${log}"; echo '{"ok":true,"data":{"message_id":"om_card"}}' ;;
  *"api PATCH"*) echo "patch $t" >> "${log}"; echo '{"ok":true,"data":{}}' ;;
  *) echo '{"ok":true,"data":{}}' ;;
esac
`, { mode: 0o755 });
  // 假 claude：开个头，然后一直跑到被掐
  writeFileSync(join(dir, 'claude'), `#!/bin/sh
cat >/dev/null
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"查到一半"}]}}'
trap 'exit 130' INT TERM
while :; do sleep 1; done
`, { mode: 0o755 });
  process.env.LCR_LARK_CLI = join(dir, 'lark-cli');
  process.env.LCR_CLAUDE = join(dir, 'claude');

  const cfg = {
    me: 'ou_me', port: 0, pollMs: 0, maxJobs: 3, stateDir: '', judgeModel: 'm', templates: { t: { project: dir } },
    on: true, defaultTemplate: 't', chats: {}, allP2p: false, allGroups: false,
  } as unknown as Scope;
  runTest(cfg, new Pool(3), new Db(dir), { chatId: '', project: dir, prompt: '试跑一下' });
  while (!readFileSync(log, 'utf8').includes('patch')) await new Promise((r) => setTimeout(r, 50));

  await drain(5_000);
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(calls.at(-1), 'patch 已中断', calls.join(' / '));
});

test('npm start 下按一次 Ctrl+C：npm 会把 SIGINT 再转发一遍，这第二下不能当成「再按一次、立刻退出」', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcr-sig-'));
  const log = join(dir, 'lark.log');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'lark-cli'), `#!/bin/sh
t=$(printf '%s' "$*" | grep -o '处理中\\|已完成\\|已中断' | head -1)
case "$*" in
  "auth status"*) echo '{"identities":{"user":{"openId":"ou_me","scope":"x"}}}' ;;
  *"+messages-send"*) echo "send $t" >> "${log}"; echo '{"ok":true,"data":{"message_id":"om_card"}}' ;;
  *"api PATCH"*) sleep 0.5; echo "patch $t" >> "${log}"; echo '{"ok":true,"data":{}}' ;;
  *) echo '{"ok":true,"data":{}}' ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(dir, 'claude'), `#!/bin/sh
cat >/dev/null
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"查到一半"}]}}'
trap 'exit 130' INT TERM
while :; do sleep 1; done
`, { mode: 0o755 });
  const port = await new Promise<number>((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => r(p)); }); });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ port, user: { on: false }, bot: { on: false }, templates: { t: { project: dir } } }));

  const srv = spawn(process.execPath, ['src/index.ts'], {
    cwd: join(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LCR_HOME: dir, LCR_LARK_CLI: join(dir, 'lark-cli'), LCR_CLAUDE: join(dir, 'claude') },
  });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  while (!out.includes('web ui')) await new Promise((r) => setTimeout(r, 50));
  await fetch(`http://127.0.0.1:${port}/api/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '试跑一下', project: dir }) });
  while (!readFileSync(log, 'utf8').includes('patch')) await new Promise((r) => setTimeout(r, 50));

  srv.kill('SIGINT'); // 终端给的
  srv.kill('SIGINT'); // npm 转发的
  const [code] = await once(srv, 'exit');
  assert.equal(code, 0, out);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').at(-1), 'patch 已中断', out);
});
