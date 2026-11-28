import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  apiHealth,
  anchorOf, claudeArgsFor, drain, stopJob, imageKeys, investigate, isForMe, isSkip, shouldOpenThread, sinceFor, onBotMessage, rerunMessage, closeOrphans,
  type Deps,
} from './pipeline.ts';
import { readFileSync, statSync, existsSync } from 'node:fs';
import type { Message } from './lark.ts';
import type { AgentEvent, RunOptions, RunResult } from './agent.ts';
import type { Verdict } from './judge.ts';
import type { Config, Scope } from './config.ts';
import { Db } from './db.ts';
import { Pool } from './store.ts';

const ME = 'ou_me';
const cfg = { me: ME, self: false };

const msg = (o: Partial<Message> = {}): Message => ({
  message_id: 'om_1',
  chat_id: 'oc_1',
  message_position: '10',
  content: 'hi',
  sender: { id: 'ou_other', sender_type: 'user' },
  mentions: [{ id: ME }],
  ...o,
});

test('@我的真人消息算数', () => {
  assert.equal(isForMe(msg(), ME, false), true);
});

test('没@我不算', () => {
  assert.equal(isForMe(msg({ mentions: [] }), ME, false), false);
});

test('我自己发的不算（防自环）', () => {
  assert.equal(isForMe(msg({ sender: { id: ME, sender_type: 'user' } }), ME, false), false);
});

test('self=1 时我自己的也算（调试）', () => {
  assert.equal(isForMe(msg({ sender: { id: ME, sender_type: 'user' } }), ME, true), true);
});

test('机器人发的不算', () => {
  assert.equal(isForMe(msg({ sender: { id: 'ou_bot', sender_type: 'bot' } }), ME, false), false);
});

test('@别人不算', () => {
  assert.equal(isForMe(msg({ mentions: [{ id: 'ou_someone' }] }), ME, false), false);
});

test('单聊跟群一个规矩：都得 @ 我', () => {
  // 不能因为"是私聊所以每条都算" —— 那意味着每句"厉害""666"都要起一次全权限 CC
  const dm = msg({ chat_id: 'oc_dm', mentions: [] });
  assert.equal(isForMe(dm, ME, false), false);
  assert.equal(isForMe({ ...dm, mentions: [{ id: ME }] }, ME, false), true, '飞书私聊是支持 @ 的，实测 mentions 会带我的 open_id');
  assert.equal(isForMe({ ...dm, mentions: [{ id: ME }], sender: { id: ME, sender_type: 'user' } }, ME, false), false, '自己发的不算');
  assert.equal(isForMe({ ...dm, mentions: [{ id: 'ou_bot' }], sender: { id: 'ou_bot', sender_type: 'bot' } }, ME, false), false, '机器人不算');
});

test('SKIP 判定容忍前后空白', () => {
  assert.equal(isSkip('SKIP'), true);
  assert.equal(isSkip('\n SKIP \n'), true);
  assert.equal(isSkip('SKIP，这条不用回'), true);
  assert.equal(isSkip('skip'), false, '大小写不认，免得把正常回答误判成跳过');
  assert.equal(isSkip('结论是 SKIP 开关没开'), false, '只有开头才算');
  assert.equal(isSkip('SKIP LOCKED 是 PG 的行锁选项'), false, '以 SKIP 开头的正经回答不是哨兵');
  assert.equal(isSkip('SKIP.'), true);
});

test('开话题的时机：动了工具、或者开口说了句不是 SKIP 的正文', () => {
  assert.equal(shouldOpenThread({ kind: 'tool', id: 't1', name: 'Bash' }), true);
  assert.equal(shouldOpenThread({ kind: 'text', text: '卡在初始化调度' }), true);
  assert.equal(shouldOpenThread({ kind: 'result', id: 't1', text: 'x', isError: false }), false);
  assert.equal(shouldOpenThread({ kind: 'init', sessionId: 's' }), false);
  assert.equal(shouldOpenThread({ kind: 'text', text: 'SKIP' }), false, 'SKIP 就别开话题了');
  assert.equal(shouldOpenThread({ kind: 'text', text: 'SK', partial: true }), false);
  assert.equal(shouldOpenThread({ kind: 'text', text: '  SKIP  ' }), false);
  assert.equal(shouldOpenThread({ kind: 'text', text: '   ' }), false, '空正文不算开口');
});

test('思考不算开闸 —— "想一下发现是闲聊" 是最常见的路径', () => {
  assert.equal(shouldOpenThread({ kind: 'thinking', text: '这条好像是寒暄，我该输出 SKIP' }), false);
});

test('每轮查哪一段：第一次从"现在"开始，之后带一段重叠', () => {
  const now = 1_000_000_000_000;
  assert.equal(sinceFor(undefined, now), now - 30 * 60_000,
    '第一次跑没有游标 = 从"现在"往前一个重叠窗口，不回放历史');

  // 重叠是必须的：游标推到 T 时，T 之前发出但还没进索引的消息，下次查 [T,...] 就永远丢了
  assert.equal(sinceFor(now - 60_000, now), now - 60_000 - 30 * 60_000, '正常轮询：带 30 分钟重叠');

  assert.equal(sinceFor(now - 7 * 24 * 3600_000, now), now - 60 * 60_000,
    '停机一周后重新起来，最多回看 1 小时 —— 别把一周前的 @ 全翻出来回一遍');
});

test('追问接哪次 session：群里认话题，私聊认引用的那张卡片', () => {
  assert.equal(anchorOf(msg({ thread_id: 'omt_1' })), 'omt_1', '群里的追问走话题');
  assert.equal(anchorOf(msg({ reply_to: 'om_card' })), 'om_card',
    '私聊没有话题（实测 thread_id 恒为空），引用回复的 reply_to 指向我发的那张卡片');
  assert.equal(anchorOf(msg({ thread_id: 'omt_1', reply_to: 'om_card' })), 'omt_1', '话题优先');
  assert.equal(anchorOf(msg()), undefined, '既没话题也没引用 = 全新的一次问答');
});

test('搜索是全量的，没勾进白名单的会话要滤掉', () => {
  const inList = msg({ message_id: 'om_a', chat_id: 'oc_on' });
  const notInList = msg({ message_id: 'om_b', chat_id: 'oc_off' });
  const chats = { oc_on: {} } as Record<string, unknown>;
  const hits = [inList, notInList].filter((m) => chats[m.chat_id] && isForMe(m, ME, false));
  assert.deepEqual(hits.map((m) => m.message_id), ['om_a']);
});

/* ---------- investigate：编排逻辑，飞书和 claude 都换成假的 ---------- */

const tmpDb = () => new Db(mkdtempSync(join(tmpdir(), 'lcr-pipe-')));
/** 服务级 + 两个入口；chat 在 @我 的白名单里，@机器人 开着 */
const fullCfg = (chat: string): Config => ({
  me: ME, port: 0, pollMs: 0, maxJobs: 3, stateDir: '',
  templates: { t: { project: tmpdir() } },
  user: { on: true, defaultTemplate: 't', chats: { [chat]: '' }, allP2p: false, allGroups: false },
  bot: { on: true, defaultTemplate: 't', chats: {}, allP2p: true, allGroups: true },
});
/** investigate 吃的是一个入口眼里的配置（scopeOf(cfg, 'user') 的样子） */
const testCfg = (chat: string): Scope => ({ ...fullCfg(chat), ...fullCfg(chat).user });

/** 每次 runAgent 调用交给 script 决定怎么跑；记下所有调用和发卡 */
function fake(script: (o: RunOptions, n: number) => Promise<RunResult>) {
  const calls: RunOptions[] = [];
  const replies: string[] = [];
  const threaded: (boolean | undefined)[] = [];
  const deletes: string[] = [];
  const dms: string[] = [];
  let judged = 0;
  let verdict: Verdict = { decision: 'answer', reason: '问代码' };
  let updates = 0;
  /** 机器人那条路建出来的流式卡片 */
  const created: unknown[] = [];
  const deps: Deps = {
    runAgent: (o) => { calls.push(o); return script(o, calls.length); },
    replyCard: async (msgId, _card, inThread) => { replies.push(msgId); threaded.push(inThread); return `card-${msgId}`; },
    updateCard: async () => { updates++; },
    deleteMessage: async (id) => { deletes.push(id); },
    threadIdOf: async () => undefined,
    downloadImage: async (_id, key, out) => `${out}.jpg`,
    sendText: async (_to, text) => { dms.push(text); },
    getMessage: async (id) => msg({ message_id: id, sender: { id: 'ou_x', name: '张三', sender_type: 'user' } }),
    judge: async () => { judged++; return verdict; },
    kit: {
      create: async (card) => { created.push(card); return `kc${created.length}`; },
      text: async () => {}, update: async () => {}, streaming: async () => {},
    },
    topic: { list: async () => [], image: async (_id, key, out) => `${out}.jpg` },
  };
  return { deps, calls, replies, threaded, deletes, dms, created, updates: () => updates, judged: () => judged, judge: (v: Verdict) => { verdict = v; } };
}
const emit = (o: RunOptions, ...evs: AgentEvent[]) => evs.forEach((e) => o.onEvent?.(e));
const resumeOf = (o: RunOptions) => { const i = o.claudeArgs.indexOf('--resume'); return i < 0 ? undefined : o.claudeArgs[i + 1]; };
/** 这次交给 claude 的那份 --settings（没有 = {}） */
const settingsOf = (o: RunOptions) => { const i = o.claudeArgs.indexOf('--settings'); return i < 0 ? {} : JSON.parse(readFileSync(o.claudeArgs[i + 1], 'utf8')); };
/** 开判定：判定只打网关，所以得配一个（配了网关 claude 就会写 --settings 文件，stateDir 指到临时目录） */
const withJudge = <T extends Config>(c: T): T => {
  c.templates.t.judge = '判一下';
  c.apis = [{ name: 'gw', kind: 'gateway', baseUrl: 'http://gw.local', token: 'tk' }];
  c.stateDir = mkdtempSync(join(tmpdir(), 'lcr-judge-'));
  return c;
};
/** 跑到被 abort 为止 */
const untilAborted = (o: RunOptions) => new Promise<RunResult>((r) =>
  o.signal!.addEventListener('abort', () => r({ text: '', ok: false }), { once: true }));
const tick = () => new Promise((r) => setTimeout(r, 5));

test('判了 SKIP：群里一个字节都不发，库里记 skipped', async () => {
  const db = tmpDb();
  const f = fake(async (o) => {
    emit(o, { kind: 'init', sessionId: 's1' }, { kind: 'text', text: 'SKIP' });
    return { text: 'SKIP', ok: true, sessionId: 's1' };
  });
  await investigate(testCfg('oc_skip'), new Pool(3), db, msg({ message_id: 'om_s', chat_id: 'oc_skip' }), f.deps);
  assert.deepEqual(f.replies, []);
  assert.equal(db.recent(1)[0].status, 'skipped');
});

test('话题里追问：掐掉还在跑的那次，接着它的 session 问', async () => {
  const db = tmpDb();
  const f = fake(async (o, n) => {
    if (n === 1) { emit(o, { kind: 'init', sessionId: 's1' }, { kind: 'tool', id: 't', name: 'Bash' }); return untilAborted(o); }
    emit(o, { kind: 'init', sessionId: 's1' }, { kind: 'text', text: '结论' });
    return { text: '结论', ok: true, sessionId: 's1' };
  });
  f.deps.threadIdOf = async () => 'omt_1';
  const cfg = testCfg('oc_take');
  const first = investigate(cfg, new Pool(3), db, msg({ message_id: 'om_1', chat_id: 'oc_take' }), f.deps);
  await tick();
  assert.equal(db.sessionFor('omt_1'), 's1', '卡片一开出来就记映射，不等跑完');

  await investigate(cfg, new Pool(3), db, msg({ message_id: 'om_2', chat_id: 'oc_take', thread_id: 'omt_1' }), f.deps);
  await first;

  assert.equal(f.calls.length, 2);
  assert.equal(resumeOf(f.calls[1]), 's1', '接着被掐那次的 session 问');
  const rows = Object.fromEntries(db.recent(10).map((r) => [r.msgId, r]));
  assert.equal(rows.om_1.error, '被追问打断');
  assert.equal(rows.om_2.status, 'done');
});

test('Codex 在跑时接收话题补充，两条消息共用一个并发名额和一张卡片', { timeout: 3000 }, async () => {
  const db = tmpDb(), cfg = testCfg('oc_codex'), pool = new Pool(1);
  cfg.templates.t.agent = 'codex';
  const finish = Promise.withResolvers<void>();
  const received: string[] = [];
  const f = fake(async o => {
    o.onSteerReady!(async prompt => { received.push(prompt); return true; });
    emit(o, { kind: 'init', sessionId: 'codex:s1' }, { kind: 'text', text: '正在查' });
    await finish.promise;
    assert.equal(o.signal!.aborted, false);
    emit(o, { kind: 'text', text: '查到了' });
    return { ok: true, text: '查到了', sessionId: 'codex:s1' };
  });
  f.deps.threadIdOf = async () => 'omt_codex';
  const first = investigate(cfg, pool, db, msg({ message_id: 'om_first', chat_id: 'oc_codex' }), f.deps);
  try {
    await tick();
    assert.equal(db.sessionFor('omt_codex'), 'codex:s1');
    await investigate(cfg, pool, db, msg({ message_id: 'om_more', chat_id: 'oc_codex', thread_id: 'omt_codex', content: '只查昨天' }), f.deps);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.replies, ['om_first']);
    assert.equal(received.length, 1);
    assert.match(received[0], /只查昨天/);
    assert.equal(db.sessionFor('om_more'), 'codex:s1');
    assert.match(db.recent(2).find(r => r.msgId === 'om_more')!.reason!, /原卡片/);
  } finally { finish.resolve(); await first; }
  assert.deepEqual(db.recent(2).map(r => r.status), ['done', 'done']);
});

test('群里直接 @我 是新问题：不掐同群在跑的，也不接它的 session', async () => {
  const db = tmpDb();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const f = fake(async (o, n) => {
    emit(o, { kind: 'init', sessionId: `s${n}` }, { kind: 'tool', id: 't', name: 'Bash' });
    if (n === 1) await gate;
    emit(o, { kind: 'text', text: `答案${n}` });
    return { text: `答案${n}`, ok: true, sessionId: `s${n}` };
  });
  const cfg = testCfg('oc_par');
  const first = investigate(cfg, new Pool(3), db, msg({ message_id: 'om_p1', chat_id: 'oc_par' }), f.deps);
  await tick();
  await investigate(cfg, new Pool(3), db, msg({ message_id: 'om_p2', chat_id: 'oc_par' }), f.deps);
  release();
  await first;

  assert.equal(resumeOf(f.calls[1]), undefined, '新 session');
  assert.deepEqual(db.recent(10).map((r) => r.status).sort(), ['done', 'done'], '两条都跑完，谁也没被掐');
});

test('私聊：引用上次那张卡片接着问，不引用就是新的', async () => {
  const db = tmpDb();
  const f = fake(async (o, n) => {
    const sid = resumeOf(o) ?? `s${n}`;
    emit(o, { kind: 'init', sessionId: sid }, { kind: 'text', text: '好' });
    return { text: '好', ok: true, sessionId: sid };
  });
  const cfg = testCfg('oc_dm');
  const dm = (o: Partial<Message>) => msg({ chat_id: 'oc_dm', chat_type: 'p2p', ...o });
  await investigate(cfg, new Pool(3), db, dm({ message_id: 'om_d1' }), f.deps);
  await investigate(cfg, new Pool(3), db, dm({ message_id: 'om_d2', reply_to: 'card-om_d1' }), f.deps);
  await investigate(cfg, new Pool(3), db, dm({ message_id: 'om_d3' }), f.deps);

  assert.deepEqual(f.calls.map(resumeOf), [undefined, 's1', undefined]);
  assert.deepEqual(f.threaded, [false, false, false], '单聊（搜索结果的 chat_type）回复不带话题');
});

test('session 不在了：删掉映射、从零重跑，新 session 记回话题', async () => {
  const db = tmpDb();
  db.setSession('omt_1', 'gone');
  const f = fake(async (o, n) => {
    if (n === 1) return { text: '', ok: false }; // claude 连 init 都不发
    emit(o, { kind: 'init', sessionId: 'fresh' }, { kind: 'text', text: '答案' });
    return { text: '答案', ok: true, sessionId: 'fresh' };
  });
  f.deps.threadIdOf = async () => 'omt_1';
  await investigate(testCfg('oc_stale'), new Pool(3), db, msg({ message_id: 'om_t', chat_id: 'oc_stale', thread_id: 'omt_1' }), f.deps);

  assert.deepEqual(f.calls.map(resumeOf), ['gone', undefined]);
  assert.equal(db.sessionFor('omt_1'), 'fresh');
});

test('图片占位符认得出来，重复的只下一次', () => {
  assert.deepEqual(imageKeys('看下 ![Image](img_v3_0216f_0ad9-8e65g) 和 ![Image](img_v3_b) 再 ![Image](img_v3_0216f_0ad9-8e65g)'),
    ['img_v3_0216f_0ad9-8e65g', 'img_v3_b']);
  assert.deepEqual(imageKeys('[文档](https://x.com) 没图'), []);
});

test('截图下下来，路径拼进 prompt，目录用 --add-dir 放行；下失败的跳过', async () => {
  const db = tmpDb();
  const f = fake(async (o) => { emit(o, { kind: 'text', text: '看到了' }); return { text: '看到了', ok: true }; });
  f.deps.downloadImage = async (_id, key, out) => { if (key === 'img_bad') throw new Error('403'); return `${out}.png`; };
  const q = '这里报错是啥 ![Image](img_ok) ![Image](img_bad)';
  await investigate(testCfg('oc_img'), new Pool(3), db, msg({ message_id: 'om_i', chat_id: 'oc_img', content: q }), f.deps);

  const [call] = f.calls;
  assert.ok(call.prompt.startsWith(q), '原问题原样保留');
  assert.match(call.prompt, /\/tmp\/lark-cc-router\/om_i\/img_ok\.png/);
  assert.doesNotMatch(call.prompt, /img_bad\.png/);
  assert.deepEqual(call.claudeArgs.slice(call.claudeArgs.indexOf('--add-dir'), call.claudeArgs.indexOf('--add-dir') + 2),
    ['--add-dir', '/tmp/lark-cc-router/om_i']);
  assert.equal(db.recent(1)[0].q, q, '库里和卡片上还是原问题');
});

/* ---------- 判定：CC 起来之前先判要不要回 ---------- */

test('同一张卡片切执行器就新开，Codex 追问续原线程，Claude 的设置和来源只交给 Claude', async () => {
  const db = tmpDb();
  const cfg = testCfg('oc_switch');
  Object.assign(cfg.templates.t, { agent: 'codex', model: 'local-model', claudeArgs: ['--verbose'], permissionMode: 'bypassPermissions' });
  cfg.stateDir = mkdtempSync(join(tmpdir(), 'lcr-switch-'));
  cfg.apis = [{ name: '订阅', kind: 'subscription', models: { opus: 'claude-only' } }];
  db.setSession('topic', 'old-claude');
  const f = fake(async (o) => {
    emit(o, { kind: 'init', sessionId: o.codex ? 'codex:new' : 'new-claude' }, { kind: 'text', text: '答复' });
    return { ok: true, text: '答复' };
  });
  f.deps.threadIdOf = async () => 'topic';
  const ask = (id: string) => investigate(cfg, new Pool(1), db, msg({ message_id: id, chat_id: 'oc_switch', thread_id: 'topic', content: '看 ![图](img_a)' }), f.deps);
  await ask('om_first');
  assert.deepEqual(f.calls[0].codex, { model: 'local-model', sandbox: 'read-only', images: ['/tmp/lark-cc-router/om_first/img_a.jpg'], resume: undefined });
  assert.deepEqual(f.calls[0].claudeArgs, []);
  assert.equal(db.sessionFor('topic'), 'codex:new');
  await ask('om_resume');
  assert.equal(f.calls[1].codex?.resume, 'new');
  cfg.templates.t.project = join(tmpdir(), 'other-project');
  await ask('om_other_project');
  assert.equal(f.calls[2].codex?.resume, undefined);
  cfg.templates.t.agent = 'claude';
  await ask('om_other');
  assert.equal(f.calls[3].codex, undefined);
  assert.equal(resumeOf(f.calls[3]), undefined);
  assert.equal(settingsOf(f.calls[3]).env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'claude-only');
  cfg.templates.t.agent = 'codex';
  cfg.templates.t.prompt = '改用新的回答格式';
  db.setSession('topic', 'codex:new');
  await ask('om_changed_prompt');
  assert.equal(f.calls[4].systemPrompt, '改用新的回答格式');
  assert.equal(f.calls[4].codex?.resume, undefined, 'Codex 在旧线程上会保留旧的模板指令');
});

const judgedCfg = (chat: string): Scope => withJudge(testCfg(chat));

test('模板没选判定 = 直接回：不判，全交给 CC', async () => {
  const f = fake(async (o) => { emit(o, { kind: 'text', text: '答' }); return { text: '答', ok: true }; });
  await investigate(testCfg('oc_nj'), new Pool(3), tmpDb(), msg({ message_id: 'om_nj', chat_id: 'oc_nj' }), f.deps);
  assert.equal(f.judged(), 0);
  assert.equal(f.calls.length, 1);
});

test('判了不用回：CC 都不起，库里留理由', async () => {
  const db = tmpDb();
  const f = fake(async () => { throw new Error('不该跑'); });
  f.judge({ decision: 'skip', reason: 'MR 通知' });
  await investigate(judgedCfg('oc_j1'), new Pool(3), db, msg({ message_id: 'om_j1', chat_id: 'oc_j1' }), f.deps);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.replies, []);
  const [row] = db.recent(1);
  assert.equal(row.status, 'skipped');
  assert.equal(row.reason, '不用回：MR 通知');
});

test('判了要回：理由也落库，然后照常跑 CC', async () => {
  const db = tmpDb();
  const f = fake(async (o) => { emit(o, { kind: 'text', text: '答' }); return { text: '答', ok: true }; });
  await investigate(judgedCfg('oc_j2'), new Pool(3), db, msg({ message_id: 'om_j2', chat_id: 'oc_j2' }), f.deps);
  assert.equal(f.calls.length, 1);
  assert.equal(db.recent(1)[0].reason, '要回：问代码');
});

test('转给我：私聊我一条（谁、在哪、原话、为什么），群里什么都不发', async () => {
  const f = fake(async () => { throw new Error('不该跑'); });
  f.judge({ decision: 'ask_me', reason: '问排期' });
  const m = msg({ message_id: 'om_j3', chat_id: 'oc_j3', content: '啥时候能好', chat_name: '修改小组', sender: { id: 'ou_x', name: '张三', sender_type: 'user' } });
  await investigate(judgedCfg('oc_j3'), new Pool(3), tmpDb(), m, f.deps);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.replies, []);
  assert.equal(f.dms.length, 1);
  assert.match(f.dms[0], /张三 在群「修改小组」 @你/);
  assert.match(f.dms[0], /啥时候能好/);
  assert.match(f.dms[0], /问排期/);
});

test('叫停：掐掉这个会话里在跑的', async () => {
  const db = tmpDb();
  const f = fake(async (o) => { emit(o, { kind: 'init', sessionId: 's9' }, { kind: 'tool', id: 't', name: 'Bash' }); return untilAborted(o); });
  const cfg = judgedCfg('oc_j4');
  const busy = investigate(cfg, new Pool(3), db, msg({ message_id: 'om_busy', chat_id: 'oc_j4' }), f.deps);
  await tick();
  f.judge({ decision: 'stop', reason: '叫停' });
  await investigate(cfg, new Pool(3), db, msg({ message_id: 'om_stop', chat_id: 'oc_j4', content: '停止处理' }), f.deps);
  await busy;
  const rows = Object.fromEntries(db.recent(10).map((r) => [r.msgId, r]));
  assert.equal(rows.om_busy.error, '被叫停');
  assert.equal(rows.om_stop.status, 'skipped');
});

test('话题里的追问判了不用回：不掐那个 session 上在跑的', async () => {
  const db = tmpDb();
  const f = fake(async (o) => { emit(o, { kind: 'init', sessionId: 's8' }, { kind: 'tool', id: 't', name: 'Bash' }); return untilAborted(o); });
  f.deps.threadIdOf = async () => 'omt_8';
  const cfg = judgedCfg('oc_j5');
  const busy = investigate(cfg, new Pool(3), db, msg({ message_id: 'om_b8', chat_id: 'oc_j5' }), f.deps);
  await tick();
  let sawFollowUp = false;
  f.deps.judge = async (_m, _p, input) => { sawFollowUp = /是否追问：是/.test(input); return { decision: 'skip', reason: '谢谢' }; };
  await investigate(cfg, new Pool(3), db, msg({ message_id: 'om_t8', chat_id: 'oc_j5', thread_id: 'omt_8', content: '谢谢' }), f.deps);
  assert.ok(sawFollowUp, '判定知道这是追问');
  assert.equal(f.calls.length, 1, '没接棒');
  // 收尾：叫停它（drain 会把整个 pipeline 置成停机，后面的测试就跑不了了）
  f.deps.judge = async () => ({ decision: 'stop', reason: '收尾' });
  await investigate(cfg, new Pool(3), db, msg({ message_id: 'om_s8', chat_id: 'oc_j5' }), f.deps);
  await busy;
});

test('判定挂了：按要回处理，别悄悄吞掉别人的 @', async () => {
  const db = tmpDb();
  const f = fake(async (o) => { emit(o, { kind: 'text', text: '答' }); return { text: '答', ok: true }; });
  f.deps.judge = async () => { throw new Error('网关 502'); };
  await investigate(judgedCfg('oc_j6'), new Pool(3), db, msg({ message_id: 'om_j6', chat_id: 'oc_j6' }), f.deps);
  assert.equal(f.calls.length, 1);
  assert.match(db.recent(1)[0].reason ?? '', /判定失败.*网关 502/);
});

test('网关 / CC settings 写成 0600 文件传路径，token 不进 argv；没配就不传', () => {
  const cfg = testCfg('oc_gw');
  cfg.stateDir = mkdtempSync(join(tmpdir(), 'lcr-gw-'));
  assert.equal(claudeArgsFor(cfg, 'oc_gw').includes('--settings'), false);
  assert.equal(existsSync(join(cfg.stateDir, 'claude-settings')), false, '没配就别写文件');

  const gw = { name: 'gw', kind: 'gateway', baseUrl: 'http://gw.local', token: 'secret-tk' } as const;
  const a = claudeArgsFor(cfg, 'oc_gw', gw);
  assert.ok(!a.join(' ').includes('secret-tk'), 'token 不能出现在 argv 里');
  const p = a[a.indexOf('--settings') + 1];
  assert.equal(statSync(p).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(p, 'utf8')).env.ANTHROPIC_AUTH_TOKEN, 'secret-tk');
  assert.equal(claudeArgsFor(cfg, 'oc_gw', gw)[a.indexOf('--settings') + 1], p, '同一份配置同一个文件');
});

test('判定走 API 来源里的网关', async () => {
  const f = fake(async (o) => { emit(o, { kind: 'text', text: '答' }); return { text: '答', ok: true }; });
  let gw: any;
  f.deps.judge = async (_m, _p, _i, g) => { gw = g; return { decision: 'answer', reason: 'x' }; };
  let model = '';
  f.deps.judge = async (m, _p, _i, g) => { gw = g; model = m; return { decision: 'answer', reason: 'x' }; };
  const cfg = judgedCfg('oc_jgw');
  await investigate(cfg, new Pool(3), tmpDb(), msg({ message_id: 'om_jgw', chat_id: 'oc_jgw' }), f.deps);
  assert.deepEqual(gw, { baseUrl: 'http://gw.local', token: 'tk' });
  assert.equal(model, 'claude-haiku-4-5', '网关没给 haiku 那档起名就用原名');
  cfg.apis[0].models = { haiku: 'claude-auto' };
  await investigate(cfg, new Pool(3), tmpDb(), msg({ message_id: 'om_jgw2', chat_id: 'oc_jgw' }), f.deps);
  assert.equal(model, 'claude-auto', '判定用 haiku 那档在这个网关上的名字');
});

test('判定没处可打（只有订阅、claude 自己也没配令牌）：不白打一次，直接按要回，理由里说清楚', async () => {
  const f = fake(async (o) => { emit(o, { kind: 'text', text: '答' }); return { text: '答', ok: true }; });
  const cfg = judgedCfg('oc_jsub');
  cfg.apis = [{ name: 'sub', kind: 'subscription' }];
  const env = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'lcr-nocc-'));   // 空的 claude 配置：settings.json 里没令牌
  const saved = [process.env.ANTHROPIC_AUTH_TOKEN, process.env.ANTHROPIC_API_KEY];
  delete process.env.ANTHROPIC_AUTH_TOKEN; delete process.env.ANTHROPIC_API_KEY;
  try {
    const db = tmpDb();
    await investigate(cfg, new Pool(3), db, msg({ message_id: 'om_jsub', chat_id: 'oc_jsub' }), f.deps);
    assert.equal(f.judged(), 0);
    assert.equal(f.calls.length, 1, '照常交给 CC');
    assert.match(db.recent(1)[0].reason ?? '', /没有能判定的网关/);
  } finally {
    if (env === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = env;
    if (saved[0] !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = saved[0];
    if (saved[1] !== undefined) process.env.ANTHROPIC_API_KEY = saved[1];
  }
});

test('开了 Google Decisions API：优先走它（纯订阅也能判，多维结果落库），失败再回退到 Anthropic 网关', async () => {
  const f = fake(async (o) => { emit(o, { kind: 'text', text: '答' }); return { text: '答', ok: true }; });
  let usedDecision = 0;
  const meta = { decision: 'skip' as const, confidence: 0.95, probabilities: { skip: 0.95, answer: 0.05 }, injection: 0.01, needsCodeLookup: 0.02, urgency: { score: 0.1, level: '低' } };
  f.deps.decisionJudge = async () => { usedDecision++; return { decision: 'skip', reason: '置信度 95%（Decisions API）', meta }; };
  const cfg = judgedCfg('oc_jdec');
  cfg.apis = [{ name: 'sub', kind: 'subscription' }];
  cfg.decisionApi = { on: true, apiKey: 'AIza-test' };

  const db = tmpDb();
  await investigate(cfg, new Pool(3), db, msg({ message_id: 'om_jdec1', chat_id: 'oc_jdec' }), f.deps);
  assert.equal(usedDecision, 1);
  assert.equal(f.judged(), 0, '走了 Decisions API 就不打 Anthropic 网关');
  assert.equal(f.calls.length, 0, 'skip 不起 CC');
  assert.match(db.recent(1)[0].reason ?? '', /不用回：置信度 95%/);
  assert.deepEqual(db.get('om_jdec1')?.judgeMeta, meta, '结构化多维判定结果落库，重启后后台也能看概率');

  // Decisions API 失败时回退到网关
  f.deps.decisionJudge = async () => { throw new Error('503'); };
  f.deps.judge = async () => ({ decision: 'skip', reason: '网关兜底' });
  cfg.apis = [{ name: 'gw', kind: 'gateway', baseUrl: 'http://gw.local', token: 'tk' }];
  await investigate(cfg, new Pool(3), db, msg({ message_id: 'om_jdec2', chat_id: 'oc_jdec' }), f.deps);
  assert.equal(f.calls.length, 0);
  assert.match(db.get('om_jdec2')?.reason ?? '', /网关兜底/);
});


/* ---------- 多个 API 来源：按顺序用，出问题换下一个 ---------- */

const modelOf = (o: RunOptions) => settingsOf(o).env.ANTHROPIC_DEFAULT_OPUS_MODEL;
/** 每个来源的 opus 档就叫它的名字 —— 从 --settings 里的映射看得出这次打的是哪个 */
const apiCfg = (chat: string, names: string[]): Scope => {
  const c = testCfg(chat);
  c.stateDir = mkdtempSync(join(tmpdir(), 'lcr-api-'));
  c.templates.t.model = 'opus';
  c.apis = names.map((n) => ({ name: n, kind: 'gateway', baseUrl: `http://${n}`, token: 't', models: { opus: n } }));
  return c;
};

test('API 来源：第一个额度用完（403 直接报错）换下一个原样重来；卡片上没有那句 API 报错，过程里说一声换了', async () => {
  const db = tmpDb();
  const f = fake(async (o) => {
    if (modelOf(o) === 'q1') { emit(o, { kind: 'init', sessionId: 's1' }); return { text: 'API Error: 403 额度用完', ok: false, apiStatus: 403, sessionId: 's1' }; }
    emit(o, { kind: 'init', sessionId: 's2' }, { kind: 'text', text: '结论' });
    return { text: '结论', ok: true, sessionId: 's2' };
  });
  let card = '';
  f.deps.updateCard = async (_id, c) => { card = JSON.stringify(c); };
  await investigate(apiCfg('oc_q', ['q1', 'q2']), new Pool(3), db, msg({ message_id: 'om_q', chat_id: 'oc_q' }), f.deps);
  assert.deepEqual(f.calls.map(modelOf), ['q1', 'q2']);
  assert.equal(resumeOf(f.calls[1]), undefined, '第一个没动过手：原样重来，不接它那个空 session');
  assert.equal(f.calls[1].prompt, f.calls[0].prompt);
  assert.deepEqual([db.recent(1)[0].status, db.recent(1)[0].answer], ['done', '结论']);
  assert.doesNotMatch(card, /API Error/);
  assert.match(card, /q1.*换.*q2/);
  assert.deepEqual([apiHealth('q1')?.ok, apiHealth('q1')?.note, !!apiHealth('q1')?.restingUntil], [false, '没权限或额度用完', true], '设置页看得到它出了什么事、在歇');
  assert.equal(apiHealth('q2')?.ok, true);
});

test('API 来源：跑到一半开始限流（claude 在重试）就换下一个，接着刚才那个 session 做完；出过事的歇一会儿，下一条先用别的', async () => {
  const f = fake(async (o) => {
    if (modelOf(o) === 'r1') {
      emit(o, { kind: 'init', sessionId: 's1' }, { kind: 'tool', id: 't', name: 'Bash' }, { kind: 'retry', status: 429, attempt: 1 });
      assert.equal(o.signal!.aborted, false, '429 头一次先让 claude 自己重试');
      emit(o, { kind: 'retry', status: 429, attempt: 2 });
      assert.equal(o.signal!.aborted, true, '再来就不等了');
      return { text: '', ok: false, sessionId: 's1' };
    }
    emit(o, { kind: 'init', sessionId: 's1' }, { kind: 'text', text: '结论' });
    return { text: '结论', ok: true, sessionId: 's1' };
  });
  const cfg = apiCfg('oc_r', ['r1', 'r2']);
  await investigate(cfg, new Pool(3), tmpDb(), msg({ message_id: 'om_r', chat_id: 'oc_r' }), f.deps);
  assert.deepEqual(f.calls.map(modelOf), ['r1', 'r2']);
  assert.equal(resumeOf(f.calls[1]), 's1', '动过手了：接着那个 session');
  assert.match(f.calls[1].prompt, /接着/);

  await investigate(cfg, new Pool(3), tmpDb(), msg({ message_id: 'om_r2', chat_id: 'oc_r' }), f.deps);
  assert.equal(modelOf(f.calls[2]), 'r2', 'r1 刚出过事，排到后面');
});

test('API 来源：鉴权失败（401）头一次重试就换；最后一个来源不换，交给 claude 自己重试，报错照常收尾', async () => {
  const db = tmpDb();
  const f = fake(async (o) => {
    emit(o, { kind: 'init', sessionId: 's' }, { kind: 'retry', status: 401, attempt: 1 });
    if (modelOf(o) === 'a1') { assert.equal(o.signal!.aborted, true); return { text: '', ok: false }; }
    emit(o, { kind: 'retry', status: 401, attempt: 2 });
    assert.equal(o.signal!.aborted, false, '没得换了');
    return { text: 'API Error: 401 令牌不对', ok: false, apiStatus: 401 };
  });
  await investigate(apiCfg('oc_a', ['a1', 'a2']), new Pool(3), db, msg({ message_id: 'om_a', chat_id: 'oc_a' }), f.deps);
  assert.deepEqual(f.calls.map(modelOf), ['a1', 'a2']);
  assert.equal(db.recent(1)[0].status, 'failed');
});

test('判定也按来源顺序：第一个网关挂了换下一个；订阅不能直接调 API，跳过', async () => {
  const f = fake(async (o) => { emit(o, { kind: 'text', text: '答' }); return { text: '答', ok: true }; });
  const seen: (string | undefined)[] = [];
  f.deps.judge = async (_m, _p, _i, g) => {
    seen.push(g?.baseUrl);
    if (g?.baseUrl === 'http://j1') throw new Error('网关 502');
    return { decision: 'answer', reason: 'x' };
  };
  const cfg = judgedCfg('oc_j2');
  cfg.apis = [{ name: 'sub', kind: 'subscription' }, { name: 'j1', kind: 'gateway', baseUrl: 'http://j1', token: 't' }, { name: 'j2', kind: 'gateway', baseUrl: 'http://j2', token: 't' }];
  await investigate(cfg, new Pool(3), tmpDb(), msg({ message_id: 'om_j2', chat_id: 'oc_j2' }), f.deps);
  assert.deepEqual(seen, ['http://j1', 'http://j2']);
});

// 放最后：drain 之后 pipeline 就是停机状态了
test('后台终止：只掐点的那个，卡片收成「已手动停止」；没在跑的返回 false', async () => {
  const db = tmpDb();
  const f = fake(async (o) => { emit(o, { kind: 'tool', id: 't', name: 'Bash' }); return untilAborted(o); });
  const cfg = testCfg('oc_web');
  const job = investigate(cfg, new Pool(3), db, msg({ message_id: 'om_w', chat_id: 'oc_web' }), f.deps);
  await tick();
  assert.equal(stopJob('om_nope'), false);
  assert.equal(stopJob('om_w'), true);
  await job;
  assert.equal(db.recent(1)[0].error, '后台终止');
  assert.equal(stopJob('om_w'), false, '收完尾就不在了');
});

/* ---------- @机器人 ---------- */

const BOT = { name: 'zzy测试', ids: ['cli_app', 'ou_bot_open'] };
/** 长连接推过来的事件长这样（lark-cli 的 im.message.receive_v1） */
const botEv = (o: Record<string, unknown> = {}) => ({
  message_id: 'om_b', chat_id: 'oc_bg', chat_type: 'group', content: '@zzy测试 看下这个 trace',
  mentions: [{ id: 'cli_app', name: 'zzy测试' }], sender_id: 'ou_x', sender_type: 'user', ...o,
});

test('@机器人：一收到就发卡片（不等模型开口），init 之后记上 session', async () => {
  const db = tmpDb();
  const cards: unknown[] = [];
  const f = fake(async (o) => {
    await tick();
    assert.equal(cards.length, 1, '一个事件都还没有，卡片已经发了');
    assert.deepEqual(cards[0], { type: 'card', data: { card_id: 'kc1' } }, '发的是 CardKit 卡片实体');
    emit(o, { kind: 'init', sessionId: 'sb' }, { kind: 'text', text: '结论' });
    return { text: '结论', ok: true, sessionId: 'sb' };
  });
  f.deps.replyCard = async (id, card) => { cards.push(card); return `card-${id}`; };
  await onBotMessage(fullCfg('oc_x'), new Pool(3), db, botEv({ message_id: 'om_b1' }), BOT, f.deps);
  assert.equal(f.calls.length, 1);
  assert.doesNotMatch(JSON.stringify(f.created[0]), /"tag":"button"/, '不放按钮：按钮要另外订阅卡片回调');
  assert.match(JSON.stringify(f.created[0]), /"streaming_mode":true/, '机器人的卡片是流式的');
  assert.equal(db.sessionFor('card-om_b1'), 'sb', '卡片先发、session 后到，也要记上');
  assert.equal(db.recent(1)[0].who, '张三', '事件里没名字，mget 补上');
});

test('@机器人：群里只认 @它的（@所有人 / @别人 不算），私聊每条都算，别的机器人不算，关着就不收', async () => {
  const runs = async (ev: object, cfg = fullCfg('oc_x')) => {
    const f = fake(async (o) => { emit(o, { kind: 'init', sessionId: 's' }); return { text: '好', ok: true }; });
    await onBotMessage(cfg, new Pool(3), tmpDb(), ev, BOT, f.deps);
    return f.calls.length;
  };
  assert.equal(await runs(botEv()), 1);
  assert.equal(await runs(botEv({ mentions: [{ id: 'ou_bot_open' }] })), 1, 'open_id 写法也认');
  assert.equal(await runs(botEv({ mentions: [] })), 0, '@所有人 在 mentions 里没有它');
  assert.equal(await runs(botEv({ mentions: [{ id: 'ou_someone' }] })), 0);
  assert.equal(await runs(botEv({ chat_type: 'p2p', mentions: [] })), 1, '私聊找它就是要它回');
  assert.equal(await runs(botEv({ sender_type: 'bot' })), 0);
  const off = fullCfg('oc_x'); off.bot.on = false;
  assert.equal(await runs(botEv(), off), 0);

  // 只在某个群里用：群不整类放开，只回勾了的那个；私聊关掉
  const one = fullCfg('oc_x'); one.bot.allGroups = false; one.bot.allP2p = false; one.bot.chats = { oc_mine: '' };
  assert.equal(await runs(botEv({ chat_id: 'oc_mine' }), one), 1);
  assert.equal(await runs(botEv({ chat_id: 'oc_other' }), one), 0);
  assert.equal(await runs(botEv({ chat_type: 'p2p', mentions: [] }), one), 0);
});

test('@机器人：追问不用按钮 —— 群里话题里再 @它、私聊引用它的卡片，都接着同一个 session', async () => {
  const db = tmpDb();
  const f = fake(async (o) => { emit(o, { kind: 'init', sessionId: 's1' }, { kind: 'text', text: '结论' }); return { text: '结论', ok: true, sessionId: 's1' }; });
  f.deps.replyCard = async (id) => `card-${id}`;
  f.deps.threadIdOf = async () => 'omt_b';
  const cfg = fullCfg('oc_x');
  await onBotMessage(cfg, new Pool(3), db, botEv({ message_id: 'om_q1' }), BOT, f.deps);
  await onBotMessage(cfg, new Pool(3), db, botEv({ message_id: 'om_q2', thread_id: 'omt_b' }), BOT, f.deps);
  await onBotMessage(cfg, new Pool(3), db, botEv({ message_id: 'om_q3', chat_type: 'p2p', mentions: [], reply_to: 'card-om_q1' }), BOT, f.deps);
  assert.deepEqual(f.calls.map(resumeOf), [undefined, 's1', 's1']);
});

test('话题里 @：第一次带上整个话题（根消息起），追问只补上次之后的新消息，自己的卡片不带', async () => {
  const db = tmpDb();
  const f = fake(async (o) => { emit(o, { kind: 'init', sessionId: 's1' }, { kind: 'text', text: '结论' }); return { text: '结论', ok: true, sessionId: 's1' }; });
  f.deps.replyCard = async (id) => `card-${id}`;
  f.deps.threadIdOf = async () => 'omt_t';
  const say = (id: string, pos: number, name: string, content: string) =>
    msg({ message_id: id, thread_id: 'omt_t', thread_message_position: String(pos), content, sender: { id: 'ou_' + id, name, sender_type: 'user' } });
  let topic = [
    say('om_root', -1, '告警', '订单 123 改价失败'),
    say('om_r0', 0, '李四', '日志：![Image](img_log)'),
    say('om_t1', 1, '张三', '@zzy测试 看下'),
  ];
  f.deps.topic.list = async () => topic;
  const cfg = fullCfg('oc_x');

  await onBotMessage(cfg, new Pool(3), db, botEv({ message_id: 'om_t1', thread_id: 'omt_t' }), BOT, f.deps);
  const p1 = f.calls[0].prompt;
  assert.match(p1, /之前的讨论[\s\S]*订单 123 改价失败[\s\S]*李四：日志[\s\S]*这次 @你 的消息：\n@zzy测试 看下/);
  assert.match(p1, /img_log\.jpg/, '话题里的截图也下下来');
  assert.ok(f.calls[0].claudeArgs.includes('--add-dir'));

  topic = [...topic,
    say('card-om_t1', 2, 'zzy测试', '<card>上次的回答</card>'),
    say('om_r3', 3, '王五', '又报了个 NPE'),
    say('om_t2', 4, '张三', '@zzy测试 这个呢'),
  ];
  await onBotMessage(cfg, new Pool(3), db, botEv({ message_id: 'om_t2', thread_id: 'omt_t', content: '@zzy测试 这个呢' }), BOT, f.deps);
  const p2 = f.calls[1].prompt;
  assert.equal(resumeOf(f.calls[1]), 's1');
  assert.match(p2, /上次回复之后[\s\S]*王五：又报了个 NPE/);
  assert.doesNotMatch(p2, /订单 123|李四|上次的回答/, '看过的、自己的卡片都不再塞');
});

test('不在话题里不读话题；读话题挂了照样回', async () => {
  const f = fake(async (o) => { emit(o, { kind: 'init', sessionId: 's' }); return { text: '好', ok: true }; });
  let reads = 0;
  f.deps.topic.list = async () => { reads++; throw new Error('230002'); };
  await onBotMessage(fullCfg('oc_x'), new Pool(3), tmpDb(), botEv({ message_id: 'om_n1' }), BOT, f.deps);
  assert.equal(reads, 0);
  await onBotMessage(fullCfg('oc_x'), new Pool(3), tmpDb(), botEv({ message_id: 'om_n2', thread_id: 'omt_z' }), BOT, f.deps);
  assert.equal(reads, 1);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].prompt, '@zzy测试 看下这个 trace');
});

test('@机器人：转给我的私聊说清楚是找的机器人', async () => {
  const f = fake(async () => { throw new Error('不该跑'); });
  f.judge({ decision: 'ask_me', reason: '问排期' });
  const cfg = withJudge(fullCfg('oc_x'));
  await onBotMessage(cfg, new Pool(3), tmpDb(), botEv({ message_id: 'om_ba', chat_type: 'p2p' }), BOT, f.deps);
  assert.match(f.dms[0], /张三 在私聊找机器人，它没回/);
});

test('再跑一次：回原消息再跑一遍、不再判定；还在跑的不让重跑', async () => {
  const db = tmpDb();
  const fc = withJudge(fullCfg('oc_r'));
  const m = msg({ message_id: 'om_r', chat_id: 'oc_r' });
  let release!: () => void;
  const f = fake(async (o, n) => {
    if (n === 2) await new Promise<void>((r) => { release = r; });
    emit(o, { kind: 'init', sessionId: `s${n}` }, { kind: 'text', text: '答' });
    return { text: '答', ok: true, sessionId: `s${n}` };
  });
  f.deps.fetchMessage = async (id) => (id === 'om_r' ? m : undefined);
  await investigate({ ...fc, ...fc.user }, new Pool(3), db, m, f.deps);
  await investigate({ ...fc, ...fc.user }, new Pool(3), db, m, f.deps);
  assert.equal(f.calls.length, 1, '正常路径：认领过的不再回');

  await rerunMessage(fc, new Pool(3), db, 'om_r', 'user', f.deps);
  while (f.calls.length < 2) await tick();
  await assert.rejects(rerunMessage(fc, new Pool(3), db, 'om_r', 'user', f.deps), /还在跑/);
  release();
  while (db.recent(1)[0].status === 'running') await tick();
  assert.deepEqual(f.replies, ['om_r', 'om_r'], '两次都回在原消息下面');
  assert.equal(f.judged(), 1, '重跑不判定');
  assert.equal(db.recent(1)[0].status, 'done');
  await assert.rejects(rerunMessage(fc, new Pool(3), db, 'om_gone', 'user', f.deps), /取不到/);
});

test('进程死在半路（没走停机）：下次开库认出卡片还挂着的作业，启动时把卡片补成「已中断」', async () => {
  for (const mode of ['bot', 'user'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'lcr-orphan-'));
    const db = new Db(dir);
    const f = fake(async (o) => { emit(o, { kind: 'init', sessionId: 's1' }, { kind: 'tool', id: 't', name: 'Bash' }); return untilAborted(o); });
    const finals: string[] = [];
    f.deps.kit.update = async (_id, card) => { finals.push(JSON.stringify(card)); };
    f.deps.updateCard = async (_id, card) => { finals.push(JSON.stringify(card)); };
    const id = `om_dead_${mode}`;
    const job = investigate(testCfg('oc_o'), new Pool(3), db, msg({ message_id: id, chat_id: 'oc_o' }), f.deps, mode);
    while (!f.replies.length) await tick();
    await tick();

    // 「重启」：不 drain，直接重新开库
    const after = new Db(dir);
    assert.deepEqual(after.orphans.map((o) => [o.msgId, o.card, o.entity]), [[id, `card-${id}`, mode === 'bot' ? 'kc1' : undefined]]);
    assert.equal(after.recent(1)[0].status, 'failed');
    finals.length = 0;
    await closeOrphans(after, mode, f.deps);
    assert.equal(finals.length, 1, mode);
    assert.match(finals[0], /服务重启了，这次没跑完/);

    stopJob(id);
    await job;
  }
});

test('卡片收尾那帧没改上：不算成功，记下原因，结论留着（「重发到飞书」用）', async () => {
  const db = tmpDb();
  const f = fake(async (o) => {
    emit(o, { kind: 'init', sessionId: 's1' }, { kind: 'tool', id: 't', name: 'Bash' }, { kind: 'text', text: '结论在这' });
    return { text: '结论在这', ok: true, sessionId: 's1' };
  });
  f.deps.updateCard = async (_id, card) => { if (JSON.stringify(card).includes('已完成')) throw new Error('网络抖了'); };
  await investigate(testCfg('oc_send'), new Pool(3), db, msg({ message_id: 'om_send', chat_id: 'oc_send' }), f.deps);
  const row = db.get('om_send')!;
  assert.deepEqual([row.status, row.sendError, row.answer], ['failed', '网络抖了', '结论在这']);
  assert.match(row.error ?? '', /飞书卡片没改上/);

  // 卡片根本没发出去（开话题就挂了）也一样，结论照样留着
  f.deps.replyCard = async () => { throw new Error('没权限'); };
  await investigate(testCfg('oc_send'), new Pool(3), db, msg({ message_id: 'om_send2', chat_id: 'oc_send' }), f.deps);
  const r2 = db.get('om_send2')!;
  assert.deepEqual([r2.status, r2.sendError, r2.answer], ['failed', '没权限', '结论在这']);
});

test('停机：在跑的作业被掐掉，卡片收成「已中断」；重跑那次被掐也不多发空卡', async () => {
  const db = tmpDb();
  db.setSession('omt_9', 'gone');
  const f = fake(async (o, n) => {
    if (o.claudeArgs.includes('gone')) return { text: '', ok: false }; // 旧 session 不在了
    if (n === 2) return untilAborted(o); // 重跑，还没出声
    emit(o, { kind: 'tool', id: 't', name: 'Bash' });
    return untilAborted(o);
  });
  const cfg = testCfg('oc_stop');
  const rerun = investigate(cfg, new Pool(3), db, msg({ message_id: 'om_r', chat_id: 'oc_stop', thread_id: 'omt_9' }), f.deps);
  await tick();
  const busy = investigate(cfg, new Pool(3), db, msg({ message_id: 'om_x', chat_id: 'oc_stop' }), f.deps);
  await tick();
  await drain(2_000);
  await Promise.all([rerun, busy]);

  assert.deepEqual(f.replies, ['om_x'], '重跑那条一张卡都没开');
  assert.ok(f.updates() >= 1, '收尾帧写出去了');
  const rows = Object.fromEntries(db.recent(10).map((r) => [r.msgId, r]));
  assert.equal(rows.om_x.error, '服务停止');
  assert.equal(rows.om_r.error, '服务停止');
});
