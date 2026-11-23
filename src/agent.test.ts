import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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

test('服务退出（哪怕是连按两下 Ctrl+C 的硬退出）：claude 和它起的命令都不能留着接着跑', { skip: process.platform === 'win32' }, async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lcr-orphan-')));
  // 假 claude，照真的来：Bash 命令起在**自己的进程组**里（杀 claude 那一组够不着它），而且这会儿卡住、不理 SIGTERM
  writeFileSync(join(dir, 'claude'), `#!/bin/sh
cat >/dev/null
trap '' TERM INT
set -m
sleep 300 &
echo $! > "${dir}/tool.pid"
echo $$ > "${dir}/claude.pid"
while :; do sleep 1; done
`, { mode: 0o755 });
  // 服务：起一个 claude，等它把命令跑起来，然后直接 process.exit —— 不等 drain
  writeFileSync(join(dir, 'svc.mjs'), `
import { existsSync } from 'node:fs';
import { runAgent } from ${JSON.stringify(join(import.meta.dirname, 'agent.ts'))};
runAgent({ project: ${JSON.stringify(dir)}, prompt: 'hi', claudeArgs: [], systemPrompt: '' });
while (!existsSync(${JSON.stringify(join(dir, 'claude.pid'))})) await new Promise((r) => setTimeout(r, 20));
process.exit(1);
`);
  const svc = spawn(process.execPath, [join(dir, 'svc.mjs')], { env: { ...process.env, LCR_CLAUDE: join(dir, 'claude') }, stdio: 'inherit' });
  await once(svc, 'exit');
  const alive = (f: string) => { try { process.kill(+readFileSync(join(dir, f), 'utf8'), 0); return true; } catch { return false; } };
  // 被杀的进程要等 launchd / init 收尸，给一点时间
  for (let i = 0; i < 50 && (alive('claude.pid') || alive('tool.pid')); i++) await new Promise((r) => setTimeout(r, 20));
  const left = { claude: alive('claude.pid'), tool: alive('tool.pid') };
  for (const f of ['claude.pid', 'tool.pid']) try { process.kill(+readFileSync(join(dir, f), 'utf8'), 'SIGKILL'); } catch {}
  assert.deepEqual(left, { claude: false, tool: false });
});
