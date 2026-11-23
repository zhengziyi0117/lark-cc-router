import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replyCard } from './lark.ts';

test('同一条消息回两次是两张卡片 —— 幂等键按消息 id 固定的话，飞书直接返回第一次那条，「再跑一次」的新卡片发不出去', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcr-lark-'));
  // 假 lark-cli，照飞书的规矩：同一个 idempotency key 只发一次，再来就返回第一次那条消息的 id
  const fake = join(dir, 'lark-cli');
  writeFileSync(fake, `#!/bin/sh
prev=""; key=""
for a in "$@"; do [ "$prev" = "--idempotency-key" ] && key="$a"; prev="$a"; done
f="${dir}/k-$key"
[ -f "$f" ] || echo "om_$(ls "${dir}" | wc -l | tr -d ' ')" > "$f"
printf '{"ok":true,"data":{"message_id":"%s"}}' "$(cat "$f")"
`, { mode: 0o755 });
  const prev = process.env.LCR_LARK_CLI;
  process.env.LCR_LARK_CLI = fake;
  try {
    const a = await replyCard('om_q', { card: 1 }, true, 'bot');
    const b = await replyCard('om_q', { card: 2 }, true, 'bot');
    assert.notEqual(a, b);
  } finally {
    if (prev === undefined) delete process.env.LCR_LARK_CLI; else process.env.LCR_LARK_CLI = prev;
  }
});
