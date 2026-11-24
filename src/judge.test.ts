import { test } from 'node:test';
import assert from 'node:assert/strict';
import { credentials, judgeInput, parseVerdict, DEFAULT_JUDGE_PROMPT } from './judge.ts';

test('判定结果：包了代码块、前面带话都认得出来；不认识的结论不收', () => {
  assert.deepEqual(parseVerdict('\u0060\u0060\u0060json\n{"decision":"skip","reason":"闲聊"}\n\u0060\u0060\u0060'), { decision: 'skip', reason: '闲聊' });
  assert.deepEqual(parseVerdict('好的。{"decision":"ask_me","reason":"问排期"}'), { decision: 'ask_me', reason: '问排期' });
  assert.deepEqual(parseVerdict('\u0060\u0060\u0060json\n{"decision":"skip","reason":"消息内容为"没"，没有实质内容"}\n\u0060\u0060\u0060'),
    { decision: 'skip', reason: '消息内容为"没"，没有实质内容' }, '理由里没转义的引号（实测 136 条里有 4 条）');
  assert.equal(parseVerdict('{"decision":"maybe","reason":"x"}'), undefined);
  assert.equal(parseVerdict('不是 JSON'), undefined);
});

test('给判定的输入：群/私聊、还 @ 了谁、是不是追问都写清楚', () => {
  const s = judgeInput({ meName: '赵六', sender: '张三', p2p: false, others: ['李四', '王五'], followUp: true, content: '大家整理下' });
  assert.match(s, /会话：群聊/);
  assert.match(s, /@ 了：我（赵六），还有 李四、王五/);
  assert.match(s, /是否追问：是/);
  assert.match(s, /大家整理下$/);
});

test('内置判定提示词四种结论都讲到了，还带例子', () => {
  for (const d of ['answer', 'skip', 'ask_me', 'stop']) assert.ok(DEFAULT_JUDGE_PROMPT.includes(d), d);
  assert.ok((DEFAULT_JUDGE_PROMPT.match(/→/g) ?? []).length >= 6, '例子');
});

test('选了网关：打它的地址、带它的 token', () => {
  const c = credentials({ baseUrl: 'http://gw.local/', token: 'tk' });
  assert.equal(c.base, 'http://gw.local');
  assert.equal(c.headers.authorization, 'Bearer tk');
  assert.equal(credentials({ baseUrl: 'http://open' }).headers.authorization, undefined, '没 token 就不带');
  const k = credentials({ baseUrl: 'https://api.anthropic.com', token: 'sk-ant-api03-x' }).headers;
  assert.deepEqual([k['x-api-key'], k.authorization], ['sk-ant-api03-x', undefined], '官方 key 走 x-api-key');
});
