import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
