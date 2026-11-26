import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, readTranscript, CONTINUE, Usage, type AgentEvent } from './agent.ts';
import { codexSettings, disconnectCodex, updateCodexSettings, type Steer } from './codex.ts';

test('复用已有 Codex App Server，断线后重新连接', { timeout: 10_000 }, async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lcr-codex-')));
  const service = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(service, 'listening');
  const endpoint = 'ws://127.0.0.1:' + service.address().port;
  const previous = process.env.LCR_CODEX_ENDPOINT;
  process.env.LCR_CODEX_ENDPOINT = endpoint;
  t.after(() => {
    disconnectCodex();
    service.close();
    if (previous === undefined) delete process.env.LCR_CODEX_ENDPOINT; else process.env.LCR_CODEX_ENDPOINT = previous;
  });
  const messages: { id?: number; method: string; params: any }[] = [];
  let configEffort: string | undefined;
  let n = 0;
  service.on('connection', socket => socket.on('message', raw => {
    const m = JSON.parse(raw.toString());
    messages.push(m);
    const { id, method, params: p = {} } = m;
    const threadId = p.threadId || ('s' + ++n), turnId = 'turn-' + threadId;
    const reply = (result: unknown) => socket.send(JSON.stringify({ id, result }));
    const notify = (method: string, data: object) => socket.send(JSON.stringify({ method, params: { threadId, turnId, ...data } }));
    switch (method) {
      case 'initialized': return;
      case 'config/read': return reply({ config: { model: 'm', model_reasoning_effort: configEffort, mcp_servers: { local: { env: { TOKEN: 'private' } } },
        plugins: { 'review@team.local': { enabled: false } } }, layers: [{ name: { type: 'user', file: '/config.toml' }, version: 'v1' }] });
      case 'model/list':
        return reply({ data: [{ model: p.cursor ? 'second' : 'm', displayName: '模型', isDefault: !p.cursor, defaultReasoningEffort: 'medium',
          supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] }], nextCursor: p.cursor ? null : 'page2' });
      case 'config/batchWrite': case 'config/value/write': return reply({ status: 'ok' });
      case 'thread/start': case 'thread/resume': return reply({ thread: { id: threadId }, model: 'router-model' });
      case 'turn/start':
        if (p.input[0].text === 'crash') return socket.terminate();
        reply({ turn: { id: turnId } });
        return notify('item/agentMessage/delta', { itemId: 'a', delta: '先查' });
      case 'turn/steer': {
        assert.equal(p.expectedTurnId, turnId);
        reply({ turnId });
        const item = { id: 'cmd', type: 'commandExecution', command: 'pwd' };
        notify('item/started', { item });
        notify('item/completed', { item: { ...item, exitCode: 0, aggregatedOutput: '/project' } });
        notify('item/completed', { item: { type: 'agentMessage', id: 'a', text: '结论' } });
        return notify('turn/completed', { turn: { id: turnId, status: 'completed' } });
      }
      case 'turn/interrupt':
        assert.equal(p.turnId, turnId);
        reply({});
        return notify('turn/completed', { turn: { id: turnId, status: 'interrupted' } });
      default: return reply({});
    }
  }));
  const codex = { sandbox: 'read-only' as const, model: 'router-model', effort: 'high', images: ['/a b.png'] };
  const o = { project: dir, systemPrompt: '模板要求\n"引用"', prompt: '查一下', claudeArgs: [], codex };
  const events: AgentEvent[] = [];
  const partial = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<Steer>();
  const otherReady = Promise.withResolvers<Steer>();
  const ac = new AbortController();
  const a = runAgent({ ...o, onSteerReady: ready.resolve, onEvent(e) {
    events.push(e);
    if (e.kind === 'text' && e.partial) partial.resolve();
  } });
  const b = runAgent({ ...o, signal: ac.signal, onSteerReady: otherReady.resolve });
  await Promise.all([partial.promise, otherReady.promise]);
  ac.abort();
  assert.equal((await b).ok, false);
  const steer = await ready.promise;
  assert.equal(await steer('再看一下', ['/b.png']), true);
  const result = await a;
  assert.ok(result.ok && result.sessionId?.startsWith('codex:'));
  assert.equal(result.text, '结论');
  assert.deepEqual(events.map(e => e.kind), ['init', 'text', 'tool', 'result', 'text', 'done']);
  assert.deepEqual(events[3], { kind: 'result', id: 'cmd', text: '/project', isError: false });
  assert.equal(await steer('太迟了', []), false);
  const resume = { ...codex, sandbox: 'workspace-write' as const, resume: result.sessionId.slice(6) };
  assert.equal((await runAgent({ ...o, prompt: 'crash', codex: resume })).ok, false);
  const next = Promise.withResolvers<Steer>();
  const resumed = runAgent({ ...o, codex: resume, onSteerReady: next.resolve });
  await (await next.promise)('继续', []);
  assert.equal((await resumed).sessionId, result.sessionId);
  await t.test('设置页只公开名称和开关，并按打开页面时的版本修改已知配置项', async () => {
    const s = await codexSettings();
    assert.deepEqual(s, { file: '/config.toml', version: 'v1', connection: endpoint, model: 'm', effort: '',
      models: ['m','second'].map((model, i) => ({ model, label: '模型', isDefault: !i, defaultEffort: 'medium', efforts: ['medium','high'] })),
      mcp: [{ name: 'local', enabled: true }], plugins: [{ name: 'review@team.local', enabled: false }] });
    await assert.rejects(updateCodexSettings({ version: 'old', kind: 'plugins', name: 'review@team.local', value: true }), /已变化/);
    await assert.rejects(updateCodexSettings({ version: s.version, kind: 'plugins', name: 'unknown', value: true }), /无效/);
    await assert.rejects(updateCodexSettings({ version: s.version, kind: 'model', value: 'second' }), /无效/, '全局模型不归这里改：那是用户自己的 Codex 配置');
    await updateCodexSettings({ version: s.version, kind: 'plugins', name: 'review@team.local', value: true });
    assert.equal(messages.some(m => m.method === 'config/batchWrite'), false);
    const writes = messages.filter(m => m.method === 'config/value/write');
    assert.deepEqual(writes.map(m => m.params), [{ keyPath: 'plugins."review@team.local".enabled', value: true, mergeStrategy: 'replace', expectedVersion: 'v1' }]);
  });
  const params = (method: string) => messages.filter(m => m.method === method).map(m => m.params);
  assert.equal(params('initialize').length, 2, '两个并发作业共享连接，断线后才重新握手');
  assert.equal(params('initialized').length, 2);
  const options = { cwd: dir, approvalPolicy: 'never', sandbox: 'read-only', model: codex.model, developerInstructions: o.systemPrompt };
  assert.deepEqual(params('thread/start')[0], options);
  assert.deepEqual(params('thread/resume')[0], { ...options, threadId: resume.resume, sandbox: 'workspace-write', excludeTurns: true });
  assert.deepEqual(params('turn/start')[0].input, [{ type: 'text', text: o.prompt }, { type: 'localImage', path: '/a b.png' }]);
  assert.deepEqual(params('turn/steer')[0].input, [{ type: 'text', text: '再看一下' }, { type: 'localImage', path: '/b.png' }]);
  assert.ok(params('turn/start').every(p => p.effort === 'high'));
  assert.deepEqual(params('turn/start').map(p => p.sandboxPolicy.type), ['readOnly', 'readOnly', 'workspaceWrite', 'workspaceWrite']);
  const inherited = Promise.withResolvers<Steer>();
  const follow = runAgent({ ...o, codex: { ...resume, model: '', effort: undefined }, onSteerReady: inherited.resolve });
  await (await inherited.promise)('跟随默认值', []);
  assert.ok((await follow).ok);
  const last = params('turn/start').at(-1);
  assert.deepEqual([last.model, last.effort], ['m', 'medium']);
  configEffort = 'ultra';
  const changed = Promise.withResolvers<Steer>();
  const overridden = runAgent({ ...o, codex: { ...codex, model: 'second', effort: undefined }, onSteerReady: changed.resolve });
  await (await changed.promise)('另选模型', []);
  assert.ok((await overridden).ok);
  assert.equal(params('turn/start').at(-1).effort, 'medium', '全局强度超出模板模型的档位时采用模型默认值');
});

test('套接字不可用时只运行连接代理，不拉起服务', { skip: process.platform === 'win32' }, async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'lcr-no-server-')));
  const cli = join(dir, 'codex');
  const log = join(dir, 'argv');
  const prev = { LCR_CODEX: process.env.LCR_CODEX, LCR_CODEX_ENDPOINT: process.env.LCR_CODEX_ENDPOINT };
  process.env.LCR_CODEX = cli;
  process.env.LCR_CODEX_ENDPOINT = 'unix://' + join(dir, 'absent.sock');
  t.after(() => { disconnectCodex(); for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  writeFileSync(cli, `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');process.exit(1);\n`, { mode: 0o755 });
  await assert.rejects(codexSettings(), /无法连接已有 Codex App Server/);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')), ['app-server', 'proxy', '--sock', join(dir, 'absent.sock')]);
});

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

test('session 记录按「一问」切开：子任务回报、换来源续跑、子代理都不算新的一问', () => {
  const root = mkdtempSync(join(tmpdir(), 'lcr-tx-'));
  mkdirSync(join(root, '-proj'));
  const id = '11111111-2222-3333-4444-555555555555';
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const rows = [
    { type: 'queue-operation', content: 'x' },
    { type: 'user', cwd: '/proj', timestamp: at(0), message: { content: '第一问' } },
    { type: 'assistant', timestamp: at(1), message: { content: [{ type: 'thinking', thinking: '想想' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt' }] } },
    { type: 'user', timestamp: at(3), promptSource: 'system', message: { content: '<task-notification>…' } },
    { type: 'user', timestamp: at(3), message: { content: CONTINUE } },
    { type: 'assistant', timestamp: at(4), isSidechain: true, message: { content: [{ type: 'text', text: '子代理的话' }] } },
    { type: 'assistant', timestamp: at(5), message: { id: 'm1', model: 'opus', usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 7 }, content: [{ type: 'thinking', thinking: '再想想' }] } },
    { type: 'assistant', timestamp: at(5), message: { id: 'm1', model: 'opus', usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 7 }, content: [{ type: 'text', text: '结论一' }] } },
    { type: 'assistant', timestamp: at(5), message: { id: 'x', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 }, content: [] } },
    { type: 'user', timestamp: at(6), isMeta: true, message: { content: '元信息' } },
    { type: 'user', timestamp: at(7), message: { content: [{ type: 'text', text: '第二问' }, { type: 'image' }] } },
    { type: 'assistant', timestamp: at(8), message: { content: [{ type: 'text', text: '结论二' }] } },
  ];
  writeFileSync(join(root, '-proj', id + '.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n{坏行');
  const r = readTranscript(id, root)!;
  assert.equal(r.cwd, '/proj');
  assert.deepEqual(r.turns.map((t) => t.prompt), ['第一问', '第二问']);
  // 同一条回复拆成两行，用量只发一次；API 报错补的那条假消息不算
  assert.deepEqual(r.turns[0].events.map((e) => e.kind), ['thinking', 'tool', 'result', 'thinking', 'usage', 'text']);
  assert.equal(r.turns[0].events[5].t, Date.parse(at(5)));
  assert.deepEqual(r.turns[0].events[4], { kind: 'usage', msgId: 'm1', model: 'opus', ctx: 110, out: 7, t: Date.parse(at(5)) });
  assert.ok(!r.turns[1].events.some((e) => e.kind === 'usage'));
  assert.equal(readTranscript('../etc', root), undefined);
  assert.equal(readTranscript('codex:abc', root), undefined);
  assert.equal(readTranscript('nope', root), undefined);
});

test('用量：上下文取最后一次，输出按回复去重求和；流里的半截数被 result 的总数盖过', () => {
  const u = new Usage();
  for (const e of [
    { kind: 'usage', msgId: 'a', ctx: 100, out: 6 }, { kind: 'usage', msgId: 'a', ctx: 100, out: 98 },
    { kind: 'text', text: 'x' }, { kind: 'usage', msgId: 'b', ctx: 300, out: 3 },
  ] as AgentEvent[]) u.add(e);
  assert.deepEqual([u.ctx, u.out], [300, 101]);
  u.add({ kind: 'usage', out: 150, total: true });
  assert.deepEqual([u.ctx, u.out], [300, 150]);
});
