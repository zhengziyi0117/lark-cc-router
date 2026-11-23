import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { healthDiff, healthOf, withPending, type Health } from './health.ts';
import { checkHealth } from './pipeline.ts';
import { Db } from './db.ts';
import type { Scope } from './config.ts';

const H = (mcp: Record<string, string>, plugins: string[] = []): Health => ({ mcp, plugins });

test('第一次跑没有基线：只报坏着的，不把全部当"新增"刷一遍', () => {
  assert.deepEqual(healthDiff(undefined, H({ a: 'connected', b: 'needs-auth' })), ['⚠️ MCP b：needs-auth']);
  assert.deepEqual(healthDiff(undefined, H({ a: 'connected' })), []);
});

test('授权过期 / 掉线 / 恢复都报，没变就不报', () => {
  const prev = H({ a: 'connected', b: 'failed' });
  assert.deepEqual(healthDiff(prev, H({ a: 'needs-auth', b: 'connected' })),
    ['⚠️ MCP a：connected → needs-auth', '✅ MCP b：恢复（failed → connected）']);
  assert.deepEqual(healthDiff(prev, prev), []);
});

test('plugin 被关：只报 plugin 那一条，它带的 MCP 不重复刷', () => {
  const prev = H({ 'plugin:hm:DOT': 'connected', 'plugin:hm:Bat': 'connected', solo: 'connected' }, ['hm', 'ponytail']);
  assert.deepEqual(healthDiff(prev, H({ solo: 'connected' }, ['ponytail'])), ['⚠️ plugin hm：不见了（被关了 / 卸了？）']);
  assert.deepEqual(healthDiff(H({ solo: 'connected' }, ['ponytail']), prev), ['✅ plugin hm：新加载'], '加回来也一样');
  assert.deepEqual(healthDiff(prev, H({ 'plugin:hm:DOT': 'connected', 'plugin:hm:Bat': 'connected' }, ['hm', 'ponytail'])), ['⚠️ MCP solo：不见了']);
});

test('pending 是 init 那一刻还在连：不报，基线沿用上次的', () => {
  const prev = H({ a: 'connected', b: 'connected' });
  const cur = H({ a: 'pending', b: 'connected' });
  assert.deepEqual(healthDiff(prev, cur), [], '赛跑，不是坏了');
  assert.deepEqual(withPending(prev, cur).mcp, { a: 'connected', b: 'connected' }, '基线不被洗成 pending');
  assert.deepEqual(healthDiff(undefined, H({ a: 'pending' })), [], '第一次跑就 pending 也不报');
  assert.deepEqual(healthDiff(H({ a: 'pending' }), H({ a: 'needs-auth' })), ['⚠️ MCP a：needs-auth'], '之前一直不知道，现在确定坏了');
  assert.deepEqual(healthDiff(H({ a: 'pending' }), H({ a: 'connected' })), [], '之前不知道，现在好的 —— 不用说');
});

test('老版本 claude 不报这些字段：不算"全没了"', () => {
  assert.equal(healthOf({ kind: 'init', sessionId: 's' }), undefined);
});

test('变了才私聊我一次，基线按模板 + 项目分开', () => {
  const db = new Db(mkdtempSync(join(tmpdir(), 'lcr-health-')));
  const cfg = { me: 'ou_me', chats: {}, templates: { t: {} }, defaultTemplate: 't' } as unknown as Scope;
  const sent: string[] = [];
  const send = async (to: string, text: string) => { assert.equal(to, 'ou_me'); sent.push(text); };
  const init = (status: string) => ({ kind: 'init' as const, sessionId: 's', mcp: [{ name: 'qconfig', status }], plugins: ['hm'] });

  checkHealth(cfg, db, 'oc', '/p1', init('connected'), 'om_1', send);
  checkHealth(cfg, db, 'oc', '/p1', init('connected'), 'om_2', send);
  assert.equal(sent.length, 0, '第一次是基线，没变化不打扰');

  checkHealth(cfg, db, 'oc', '/p1', init('needs-auth'), 'om_3', send);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /qconfig：connected → needs-auth/);
  assert.match(sent[0], /om_3/);

  checkHealth(cfg, db, 'oc', '/p1', init('needs-auth'), 'om_4', send);
  assert.equal(sent.length, 1, '还坏着，但没新变化 —— 不重复提醒');

  checkHealth(cfg, db, 'oc', '/p2', init('connected'), 'om_5', send);
  assert.equal(sent.length, 1, '另一个项目自己一份基线');
  db.close();
});
