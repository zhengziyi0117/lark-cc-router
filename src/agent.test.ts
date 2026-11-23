import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from './agent.ts';

test('项目写成 ~/ 开头：cwd 要展开再交给 spawn —— spawn 不认 ~，目录不存在报的是「spawn claude ENOENT」', { skip: process.platform === 'win32' }, async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'lcr-agent-')));
  mkdirSync(join(home, 'proj'));
  // 假 claude：吃掉 prompt，把自己的工作目录当成回答吐出来
  const fake = join(home, 'claude');
  writeFileSync(fake, `#!/bin/sh\ncat >/dev/null\nprintf '{"type":"result","is_error":false,"result":"%s"}\\n' "$(pwd -P)"\n`, { mode: 0o755 });
  const env = { HOME: process.env.HOME, LCR_CLAUDE: process.env.LCR_CLAUDE };
  process.env.HOME = home;
  process.env.LCR_CLAUDE = fake;
  try {
    const r = await runAgent({ project: '~/proj', prompt: 'hi', claudeArgs: [], systemPrompt: '' });
    assert.deepEqual({ ok: r.ok, text: r.text }, { ok: true, text: join(home, 'proj') });
    // 真起不来的时候，报错要带回去给作业详情，不能只剩「中断」
    const bad = await runAgent({ project: '~/nope', prompt: 'hi', claudeArgs: [], systemPrompt: '' });
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? '', /ENOENT/);
  } finally {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});
