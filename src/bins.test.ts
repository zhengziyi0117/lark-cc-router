import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { larkCliDir } from './bins.ts';

test('桌面版 lark-cli 目录够短：@机器人 的 bus.sock 路径在 macOS 上不能超过 103 个字符', () => {
  // 应用 ID 是 cli_ + 16 位；家目录给一个偏长的用户名（真实踩到的是 Application Support 下正好 104）
  const sock = join(larkCliDir('/Users/zhangsanfeng.longname.test'), 'events', 'cli_0123456789abcdef', 'bus.sock');
  assert.ok(sock.length <= 103, `${sock.length} 字符：${sock}`);
  // 旧位置就是因为这个起不来的
  const old = join('/Users/zhangsan/Library/Application Support/lark-cc-router/lark-cli', 'events', 'cli_0123456789abcdef', 'bus.sock');
  assert.ok(old.length > 103);
});
