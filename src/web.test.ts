import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allowed, apisFrom, decisionApiFrom, explainTemplate } from './web.ts';
import { publicApi, type Config } from './config.ts';

const H = 'http://127.0.0.1:8787';
const host = { host: '127.0.0.1:8787' };

test('本机页面自己的请求放行', () => {
  assert.equal(allowed('GET', host), true, '同源 GET 可能不带 Origin');
  assert.equal(allowed('GET', { host: 'localhost:8787' }), true);
  assert.equal(allowed('POST', { ...host, origin: H, 'content-type': 'application/json' }), true);
  assert.equal(allowed('POST', { ...host, 'content-type': 'application/json' }), true, 'curl 不带 Origin');
});

test('别的网页打过来一律拒 —— 不然随便一个页面就能跑 CC、改权限', () => {
  assert.equal(allowed('POST', { ...host, origin: 'https://evil.example', 'content-type': 'application/json' }), false);
  assert.equal(allowed('POST', { ...host, 'content-type': 'text/plain' }), false, 'text/plain 不触发预检，是跨站的标准姿势');
  assert.equal(allowed('POST', { ...host, origin: 'null', 'content-type': 'application/json' }), false, 'sandbox iframe');
  assert.equal(allowed('GET', { host: 'evil.example:8787' }), false, 'DNS rebinding');
  assert.equal(allowed('GET', { ...host, origin: 'http://localhost:8787' }), false, '跟 Host 不同源');
});

test('API 来源下发到页面时不带令牌，只说有没有', () => {
  const p = publicApi({ name: 'gw', kind: 'gateway', baseUrl: 'http://a', token: 'secret', models: { opus: 'm' } });
  assert.deepEqual(p, { name: 'gw', kind: 'gateway', baseUrl: 'http://a', models: { opus: 'm' }, hasToken: true });
  assert.ok(!JSON.stringify(p).includes('secret'));
});

test('实际生效：档位在每个来源上叫什么、高级参数跟正式字段打架、判定打不到，都摆出来', () => {
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lcr-cc-'));   // 空的 claude 配置，不读本机的
  delete process.env.ANTHROPIC_AUTH_TOKEN; delete process.env.ANTHROPIC_API_KEY;
  const cfg = { templates: {}, user: { on: true, chats: {}, defaultTemplate: 'x' }, bot: { on: false, chats: {}, defaultTemplate: 'x' },
    apis: [{ name: '网关', kind: 'gateway', baseUrl: 'http://gw', token: 't', models: { opus: 'claude-auto' } }, { name: '订阅', kind: 'subscription' }] } as unknown as Config;
  const v = (lines: ReturnType<typeof explainTemplate>, k: string) => lines.filter((l) => l.k === k);

  const a = explainTemplate(cfg, { project: tmpdir(), model: 'opus', judge: '判', claudeArgs: ['--model', 'haiku', '--dangerously-skip-permissions'],
    claudeSettings: { env: { ANTHROPIC_BASE_URL: 'x' } } });
  assert.equal(v(a, '模型')[0].v, 'opus 档：「网关」上叫 claude-auto，「订阅」上用 Claude Code 自己的名字');
  assert.equal(v(a, '冲突').length, 3, '--model 被盖、--dangerously-skip-permissions 全放开、settings 的地址被来源盖');
  assert.match(v(a, '判定')[0].v, /「网关」上的 claude-haiku-4-5/);
  assert.match(v(a, '命令行')[0].v, /--model opus --permission-mode auto$/);

  const b = explainTemplate({ ...cfg, apis: [cfg.apis[1]] }, { project: tmpdir(), judge: '判' });
  assert.equal(v(b, '判定')[0].bad, true, '只有订阅：判定打不到');
  assert.equal(v(explainTemplate(cfg, {}), '项目')[0].bad, true, '没选项目');
  assert.match(v(explainTemplate(cfg, { agent: 'codex', project: tmpdir() }), '执行器')[0].v, /不走「API 来源」/);
});

test('设置里存 API 来源：改名按 from 认（令牌找回来、模板跟着改），坏的整份不收；没传就不动', () => {
  const cur = { apis: [{ name: '旧', kind: 'gateway', baseUrl: 'http://a', token: 'secret' }] } as unknown as Config;
  const a = apisFrom({ apis: [{ name: '新', from: '旧', kind: 'gateway', baseUrl: 'http://a', models: { haiku: 'fast' } }] }, cur)!;
  assert.deepEqual(a.apis, [{ name: '新', kind: 'gateway', baseUrl: 'http://a', token: 'secret', models: { haiku: 'fast' } }]);
  assert.deepEqual([...a.renamed], [['旧', '新']]);
  assert.equal(apisFrom({ apis: [{ name: 'x', kind: 'gateway', baseUrl: 'ftp://x' }] }, cur)!.errors.length, 1);
  assert.equal(apisFrom({}, cur), undefined);
});

test('实际生效：开启 Google Decisions API 后纯订阅也能判定；没填 Key 时标红提醒', () => {
  const prev = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const base = { templates: {}, user: { on: true, chats: {}, defaultTemplate: 'x' }, bot: { on: false, chats: {}, defaultTemplate: 'x' },
      apis: [{ name: '订阅', kind: 'subscription' }] } as unknown as Config;
    const ok = explainTemplate({ ...base, decisionApi: { on: true, apiKey: 'AIza-x' } }, { project: tmpdir(), judge: '判' });
    const j1 = ok.find((l) => l.k === '判定')!;
    assert.equal(j1.bad, undefined);
    assert.match(j1.v, /Google Decisions API（gemini-decision-1）/);

    const nokey = explainTemplate({ ...base, decisionApi: { on: true } }, { project: tmpdir(), judge: '判' });
    const j2 = nokey.find((l) => l.k === '判定')!;
    assert.equal(j2.bad, true);
    assert.match(j2.v, /还没填 API Key/);

    assert.equal(decisionApiFrom({}, base), undefined);
    assert.deepEqual(decisionApiFrom({ decisionApi: { on: true } }, { decisionApi: { on: true, apiKey: 'old' } }),
      { decisionApi: { on: true, apiKey: 'old' } });
  } finally {
    if (prev === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prev;
  }
});
