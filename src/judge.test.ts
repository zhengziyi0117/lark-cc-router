import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callDecisionApi, credentials, decisionTarget, judgeInput, parseDecisionAnswer, parseVerdict, pingDecisionApi, DEFAULT_JUDGE_PROMPT } from './judge.ts';

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

test('Google Decisions API：开关 + Key 才启用，解析 choice + 置信度与次选概率', () => {
  const prev = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    assert.equal(decisionTarget(undefined), undefined);
    assert.equal(decisionTarget({ on: false, apiKey: 'k' }), undefined, '没开就不用');
    assert.equal(decisionTarget({ on: true }), undefined, '没 Key 就不用');
    assert.deepEqual(decisionTarget({ on: true, apiKey: 'k', baseUrl: 'https://proxy.local/', model: 'gemini-decision-1' }), {
      apiKey: 'k', baseUrl: 'https://proxy.local', model: 'gemini-decision-1',
    });
    process.env.GEMINI_API_KEY = 'env-k';
    assert.equal(decisionTarget({ on: true })?.apiKey, 'env-k', '开启后没填 Key 可读环境变量');
  } finally {
    if (prev === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prev;
  }

  const v1 = parseDecisionAnswer({
    answers: {
      decision: { choice: 'answer', confidence: 0.996, probabilities: { answer: 0.996, skip: 0.002, ask_me: 0.002, stop: 0 } },
      is_injection: { noul: 0.02, confidence: 0.98 },
      needs_code_lookup: { noul: 0.95, confidence: 0.95 },
      urgency: { score: 2.95, probabilities: { '0': 0.01, '1': 0.01, '2': 0.03, '3': 0.95 } },
    },
  });
  assert.equal(v1?.decision, 'answer');
  assert.equal(v1?.reason, '置信度 100% · 需查代码/日志 · 紧急度 线上故障（Decisions API）');
  assert.deepEqual(v1?.meta, {
    decision: 'answer',
    confidence: 0.996,
    probabilities: { answer: 0.996, skip: 0.002, ask_me: 0.002, stop: 0 },
    injection: 0.02,
    needsCodeLookup: 0.95,
    urgency: { score: 2.95, level: '线上故障' },
  });

  const v2 = parseDecisionAnswer({
    answers: {
      decision: { choice: 'ask_me', confidence: 0.68, probabilities: { ask_me: 0.68, answer: 0.29, skip: 0.03, stop: 0 } },
      is_injection: { noul: 0.82 },
    },
  });
  assert.equal(v2?.decision, 'ask_me');
  assert.equal(v2?.reason, '置信度 68%，次选「要回」29% · ⚠ 疑似注入 82%（Decisions API）');
  assert.equal(v2?.meta?.injection, 0.82);

  assert.equal(parseDecisionAnswer({ answers: { decision: { choice: 'unknown' } } }), undefined);
});

test('Google Decisions API：单次请求并发发 4 题并带 x-goog-api-key', async () => {
  const orig = globalThis.fetch;
  const seen: { url: string; headers: any; body: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    seen.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      answers: {
        decision: { choice: 'skip', confidence: 0.94, probabilities: { skip: 0.94, answer: 0.04, ask_me: 0.02, stop: 0 } },
        is_injection: { noul: 0.01 },
        needs_code_lookup: { noul: 0.05 },
        urgency: { score: 0.02, probabilities: { '0': 0.98, '1': 0.02, '2': 0, '3': 0 } },
        ping: { choice: 'ok', confidence: 0.99 },
      },
      usage: { total_input_tokens: 50, total_output_tokens: 0 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  try {
    const v = await callDecisionApi('规则', '消息正文', { apiKey: 'AIza-test', baseUrl: 'https://proxy.example/' });
    assert.equal(v.decision, 'skip');
    assert.equal(v.reason, '置信度 94%（Decisions API）');
    assert.equal(v.meta?.urgency?.level, '低');
    assert.equal(seen[0].url, 'https://proxy.example/v1beta/decisions');
    assert.equal(seen[0].headers['x-goog-api-key'], 'AIza-test');
    assert.equal(seen[0].body.model, 'gemini-decision-1');
    assert.deepEqual(Object.keys(seen[0].body.questions).sort(), ['decision', 'is_injection', 'needs_code_lookup', 'urgency']);
    assert.equal(seen[0].body.questions.decision.type, 'choice');
    assert.equal(seen[0].body.questions.is_injection.type, 'noul');
    assert.equal(seen[0].body.questions.needs_code_lookup.type, 'noul');
    assert.equal(seen[0].body.questions.urgency.type, 'score');
    assert.equal(seen[0].body.questions.decision.instructions, '规则');

    const ping = await pingDecisionApi({ apiKey: 'AIza-test' });
    assert.equal(ping.ok, true);
    assert.match(ping.detail, /gemini-decision-1.*0 tokens/);
  } finally {
    globalThis.fetch = orig;
  }
});
