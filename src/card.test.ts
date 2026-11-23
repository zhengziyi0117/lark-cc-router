import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCard, summarize, thinkingCard, CardBuilder, CardStream, KitStream, titleFor, type CardInput, type Kit } from './card.ts';
import { Db } from './db.ts';
import { Pool } from './store.ts';
import { DatabaseSync } from 'node:sqlite';

const state = (o: Partial<CardInput> = {}): CardInput => ({
  who: '张三', q: '这个订单为什么改不了',
  status: 'running', text: '', process: '', tools: 0, ...o,
});

test('工具入参挑最能说明问题的那个字段', () => {
  assert.equal(summarize({ command: 'grep -rn x', description: '搜索' }), 'grep -rn x');
  assert.equal(summarize({ file_path: '/a/b.java' }), '/a/b.java');
  assert.equal(summarize({ pattern: 'initSchedule' }), 'initSchedule');
  assert.equal(summarize('裸字符串'), '裸字符串');
  assert.equal(summarize(null), '');
  assert.equal(summarize({ 别的: 1 }), '{"别的":1}');
  assert.equal(summarize({ command: 'a\n  b' }), 'a b', '换行要压成一行');
});

test('先发出去的那张卡带着问题和提问人', () => {
  const c = JSON.stringify(thinkingCard('张三', '这个订单为什么改不了'));
  assert.ok(c.includes('处理中') && c.includes('张三') && c.includes('这个订单为什么改不了'));
  assert.ok(c.includes('"schema":"2.0"'), '卡片 2.0 必须显式带 schema');
});

test('状态决定头部颜色，群里扫一眼就知道结果', () => {
  assert.deepEqual(titleFor('running'), { title: '⏳ 处理中…', template: 'blue' });
  assert.equal(titleFor('done').template, 'green');
  assert.equal(titleFor('failed').template, 'orange');
});

test('排查过程收进折叠面板，跑的时候展开、收尾收起', () => {
  const running = JSON.stringify(buildCard(state({ process: "<text_tag color='neutral'>Bash</text_tag> `ls`", tools: 3 })));
  assert.ok(running.includes('collapsible_panel'));
  assert.ok(running.includes('3 次工具调用'));
  assert.ok(running.includes('"expanded":true'), '跑的时候要展开，群里才看得到进度');

  const done = JSON.stringify(buildCard(state({ process: "<text_tag color='neutral'>Bash</text_tag> `ls`", tools: 3, status: 'done', text: '结论' })));
  assert.ok(done.includes('"expanded":false'), '收尾要收起，只留结论');
});

test('没有过程就不放折叠面板（避免空壳）', () => {
  assert.ok(!JSON.stringify(buildCard(state())).includes('collapsible_panel'));
});

test('正文截断方向跟着状态走：跑的时候留尾部，收尾留结论（结论在前）', () => {
  const long = '结'.repeat(20000) + '尾巴';
  assert.ok(JSON.stringify(buildCard(state({ text: long }))).includes('尾巴'), '跑的时候要看最新');
  const fin = JSON.stringify(buildCard(state({ text: long, status: 'done' })));
  assert.ok(fin.includes('结'.repeat(50)));
  assert.ok(!fin.includes('尾巴'), '收尾要留头部');
});

test('正文太长时过程让位，正文优先 —— 别让工具输出把结论挤没', () => {
  const card = JSON.stringify(buildCard(state({ text: '结'.repeat(20000), process: '工具输出', tools: 7, status: 'done' })));
  assert.ok(card.includes('过程已省略'), '过程撤掉，但留一句说明它调过工具');
  assert.ok(card.includes('7 次工具调用'), '次数还在面板标题里');
  assert.ok(card.includes('结'.repeat(100)), '正文必须还在');
});

test('塞得下的时候正文一个字都不能少 —— 要裁先裁过程', () => {
  const body = '结'.repeat(7000);          // 21KB，自己就占了大半张卡
  const card = JSON.stringify(buildCard(state({ text: body, process: '想'.repeat(50000), tools: 9, status: 'done' })));
  assert.ok(card.includes(body), '正文完整，一个不少');
  assert.ok(card.includes('9 次工具调用'), '过程让位但还在（没小到要整个撤掉）');
  assert.ok(card.includes('…'), '过程被裁了，正文没裁');
});

test('整卡不超飞书的 30KB 上限 —— 超了接口直接拒收', () => {
  const big = buildCard(state({
    text: '汉'.repeat(50000), process: '> ' + '思'.repeat(50000),
    tools: 99, session: 'x'.repeat(36), status: 'done',
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(big)) <= 30 * 1024, `实际 ${Buffer.byteLength(JSON.stringify(big))} 字节`);
});

test('按字节裁不会把汉字切成半个', () => {
  const card = JSON.stringify(buildCard(state({ text: '汉'.repeat(20000), status: 'done' })));
  assert.ok(!card.includes('�'), '半个 UTF-8 字符解码出来就是替换符');
});

test('事件流分两块：正文 / 排查过程，互不串味', () => {
  const b = new CardBuilder();
  b.push({ kind: 'init', sessionId: 's1' });
  b.push({ kind: 'thinking', text: '先看看调度初始化' });
  b.push({ kind: 'tool', id: 't1', name: 'Bash', input: { command: 'grep -rn initSchedule src/' } });
  b.push({ kind: 'result', id: 't1', text: 'src/A.java:12: initSchedule();', isError: false });
  b.push({ kind: 'text', text: '卡在初始化调度。' });
  b.push({ kind: 'done', ok: true, text: '卡在初始化调度。' });

  assert.equal(b.tools, 1, 'init/done 不算工具调用');
  assert.ok(b.text.includes('卡在初始化调度'));
  assert.ok(!b.text.includes('grep') && !b.text.includes('先看看调度初始化'), '思考和工具都不能混进正文');
  assert.ok(b.process.includes('Bash') && b.process.includes('grep -rn initSchedule'));
  assert.ok(b.process.includes('src/A.java:12'), '工具返回原文要留着 —— 以前整类事件都被丢了');

  const card = JSON.stringify(buildCard(state({ text: b.text, process: b.process, tools: b.tools })));
  assert.ok(card.includes('initSchedule'));
});

test('思考和工具调用在**同一条时间线**上，顺序不能丢', () => {
  // 拆成两个框的话，"看到报错 → 想到查 X → 调 Bash → 想到 Y" 这条因果链就得让读的人
  // 自己在脑子里 zip 回去。工具返回的原始输出本来也在这一块里，拆出思考并不是"信号 vs 噪声"
  const b = new CardBuilder();
  b.push({ kind: 'thinking', text: '先看调度' });
  b.push({ kind: 'tool', id: 't1', name: 'Bash', input: { command: 'grep -rn initSchedule src/' } });
  b.push({ kind: 'result', id: 't1', text: 'src/A.java:12', isError: false });
  b.push({ kind: 'thinking', text: '嗯，看这个文件' });
  b.push({ kind: 'tool', id: 't2', name: 'Read', input: { file_path: 'src/B.java' } });

  const i = (s) => b.process.indexOf(s);
  assert.ok(i('先看调度') < i('grep -rn initSchedule'), '思考在它引出的那次调用之前');
  assert.ok(i('grep -rn initSchedule') < i('src/A.java:12'), '返回跟在调用之后');
  assert.ok(i('src/A.java:12') < i('嗯，看这个文件'), '第二段思考在第一次返回之后');
  assert.ok(i('嗯，看这个文件') < i('src/B.java'), '第二次调用在第二段思考之后');
  assert.ok(b.process.includes("<font color='grey'>"), '思考渲染成灰字旁白，跟工具标签区分得开');
});

test('光想不调工具时，面板标题不写"0 次工具调用"', () => {
  const card = buildCard(state({ process: '> 想了想，这题不用查代码', tools: 0, text: '答：…' }));
  const [proc] = card.body.elements.filter((e) => e.tag === 'collapsible_panel');
  assert.equal(proc.header.title.content, '过程');
});

test('过程只有一个折叠框，收尾后收起', () => {
  const card = buildCard(state({ status: 'done', text: '结论', process: 'x', tools: 1 }));
  const panels = card.body.elements.filter((e) => e.tag === 'collapsible_panel');
  assert.equal(panels.length, 1, '思考并进排查过程了，不再各占一个框');
  const [proc] = panels;
  assert.equal(proc.expanded, false, '结论才是焦点，过程收尾后收起');
  assert.equal(proc.elements[0].text_size, 'notation', '次要信息用小一号');
  assert.equal(proc.header.title.content, '过程 · 1 次工具调用');
});

test('排查过程的截断方向也跟状态走 —— 思考并进来之后这块长多了', () => {
  const long = '想'.repeat(4000) + '刚查到这里';
  assert.ok(JSON.stringify(buildCard(state({ process: long }))).includes('刚查到这里'), '跑的时候看它正在干嘛');
  const fin = JSON.stringify(buildCard(state({ process: long, status: 'done' })));
  assert.ok(!fin.includes('刚查到这里'), '收尾留头部：这次排查从哪儿查起的');
});

test('内容里的 markdown 特殊字符要转义，不然会把卡片格式搞乱', () => {
  // 飞书卡片 markdown 真的会解析这些：`a_b_c` 变斜体、`---` 变分割线、`<T>` 直接消失
  const b = new CardBuilder();
  b.push({ kind: 'tool', id: 't1', name: 'Bash', input: { command: 'echo "---FILE TYPE---" && cat a_b_c.txt' } });
  b.push({ kind: 'thinking', text: '用 <T> 泛型，注意 * 号和 _下划线_' });
  const card = JSON.stringify(buildCard(state({ process: b.process, tools: b.tools })));
  assert.ok(card.includes('&#42;') && card.includes('&#60;'), '思考里的 * 和 < 要转成数字实体');
  assert.ok(!card.includes('注意 * 号'), '不能原样出去');
  assert.ok(card.includes('&#95;'), '下划线也要转，不然 a_b_c 会变斜体');
  // 工具名/入参走的是 inline code 和 text_tag，也在正文层，一样要转
  assert.ok(card.includes('&#45;') || !card.includes('---FILE TYPE---'), '入参里的 --- 不能原样出去');
});

test('工具返回带 ``` 不会把外层代码块提前闭合', () => {
  const b = new CardBuilder();
  b.push({ kind: 'result', id: 't1', text: '```js\nx\n```' });
  const inner = b.process.split('```');
  assert.equal(inner.length % 2, 1, '成对的 ``` 才不会被截断');
});

test('没开话题之前一个字节都不发，开的时候把攒下的一次性推出去', async () => {
  const sent: unknown[] = [];
  let opens = 0;
  const s = new CardStream(async () => { opens++; return 'om_card'; }, '张三', 'q', async (_id, card) => { sent.push(card); });

  s.push({ kind: 'init', sessionId: 's1' });
  s.push({ kind: 'thinking', text: '这条好像是寒暄' });
  s.push({ kind: 'tool', id: 't1', name: 'Bash', input: { command: 'grep -rn initSchedule src/' } });
  assert.equal(sent.length, 0, '群里这时候什么都不该有');
  assert.equal(s.opened, false);
  assert.equal(opens, 0, '连话题都不该开');

  await s.open();
  assert.equal(opens, 1);
  assert.equal(s.opened, true);
  assert.equal(sent.length, 1, '开话题时把攒下的一次性推出去');
  const card = JSON.stringify(sent[0]);
  assert.ok(card.includes('grep -rn initSchedule'), '开话题前攒的事件不能丢');
  assert.ok(card.includes('这条好像是寒暄'), '思考也要在 —— 它现在排在工具调用前面，同一条时间线');

  await s.open();
  assert.equal(opens, 1, '重复开是空操作');

  await s.finish('卡在初始化调度', true);
  assert.equal(sent.length, 2);
  assert.ok(JSON.stringify(sent[1]).includes('已完成'));
});

test('上一帧还在飞的时候收尾，收尾那一帧不能被吞掉', async () => {
  // 线上就是这么中的：一次 36 次工具调用的长跑，卡片大、PATCH 慢。上一帧还没回来，
  // 这次就跑完了 —— flush('done') 撞上 busy 就 return schedule()，而 schedule() 看见
  // done 已经置上又直接返回，于是**收尾那一帧被丢掉**：群里那张卡片永远停在"处理中…"，
  // 而 web UI 走 SSE 不经过飞书，早就显示完成了。
  const sent: unknown[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let first = true;
  const s = new CardStream(async () => 'om_card', '张三', 'q', async (_id, card) => {
    sent.push(card);
    if (first) { first = false; await gate; }   // 第一帧卡在网络上
  });

  s.push({ kind: 'init', sessionId: 's1' });
  void s.open();                                 // 不能 await：这一帧要卡住
  await new Promise((r) => setTimeout(r, 0));    // 让 flush 进到 busy
  s.push({ kind: 'tool', id: 't1', name: 'Bash', input: { command: 'ls' } });

  const fin = s.finish('结论', true);            // 上一帧还在飞
  release();
  await fin;

  const last = JSON.stringify(sent[sent.length - 1]);
  assert.ok(last.includes('已完成'), `最后一帧必须是完成态，实际只收到 ${sent.length} 帧`);
  assert.ok(last.includes('结论'), '收尾帧要带上正文');
});

test('从没开过话题的流，finish 是空操作（闲聊不撤回，因为压根没发过）', async () => {
  const sent: unknown[] = [];
  const s = new CardStream(async () => 'om_card', '张三', 'q', async (_id, card) => { sent.push(card); });
  s.push({ kind: 'text', text: 'SKIP' });
  await s.finish('SKIP', true);
  assert.equal(sent.length, 0);
  assert.equal(s.opened, false);
});

test('去重：同一条消息只认领一次', () => {
  const db = new Db(mkdtempSync(join(tmpdir(), 'lcr-db-')));
  const m = { msgId: 'om_1', chatId: 'oc_1', who: '张三', q: '为什么改不了' };
  assert.equal(db.claim(m), true, '第一次见到');
  assert.equal(db.claim(m), false, '再来一次要被挡住');
  assert.equal(db.claim({ ...m, msgId: 'om_2' }), true, '别的消息不受影响');

  db.settle('om_1', 'done', '卡在初始化调度');
  const [row] = db.recent(10);
  assert.equal(row.msgId, 'om_2', 'recent 按时间倒序，最新那条在前');

  db.settle('om_2', 'failed', undefined, '炸了');
  const rows = db.recent(10);
  assert.deepEqual(rows.map((r) => r.msgId).sort(), ['om_1', 'om_2']);
  assert.equal(rows.find((r) => r.msgId === 'om_1')?.answer, '卡在初始化调度');
  assert.equal(rows.find((r) => r.msgId === 'om_2')?.error, '炸了');
  db.close();
});

test('去重记录跨进程存活（重开同一个库还认得）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcr-db2-'));
  const m = { msgId: 'om_x', chatId: 'oc_1', who: 'a', q: 'q' };
  const a = new Db(dir);
  a.claim(m);
  a.close();

  const b = new Db(dir);
  assert.equal(b.claim(m), false, '重启后不能重复回');
  b.close();
});

test('启动时把上次死在半路的 running 收尾成 failed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcr-db3-'));
  const a = new Db(dir);
  a.claim({ msgId: 'om_half', chatId: 'oc_1', who: 'a', q: 'q' });   // 认领了但没 settle
  a.close();

  const b = new Db(dir);
  const [row] = b.recent(10);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, '进程中断');
  b.close();
});

test('话题 → session 的映射要落盘（同一话题里追问要接着上次那个 session）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcr-thr-'));
  const a = new Db(dir);
  assert.equal(a.sessionFor('omt_1'), undefined, '没记过就是没有');
  a.setSession('omt_1', 'sess-a');
  assert.equal(a.sessionFor('omt_1'), 'sess-a');
  a.setSession('omt_1', 'sess-b');
  assert.equal(a.sessionFor('omt_1'), 'sess-b', '同一个话题里再跑一次要覆盖，不能攒一堆');
  a.close();

  const b = new Db(dir);
  assert.equal(b.sessionFor('omt_1'), 'sess-b', '重启后追问还得认得出上次那个 session');
  b.dropSession('omt_1');
  assert.equal(b.sessionFor('omt_1'), undefined, 'session 没了要能忘掉，否则每次追问都撞同一堵墙');
  b.close();
});

test('一个事件都没有的流 = resume 到了不存在的 session（claude 连 init 都不发）', async () => {
  const s = new CardStream(async () => 'om_card', '张三', 'q', async () => {});
  assert.equal(s.silent, true);
  s.push({ kind: 'init', sessionId: 's1' });
  assert.equal(s.silent, false, '发了 init 就说明 session 是活的');
  assert.equal(s.session, 's1');

  const t = new CardStream(async () => 'om_card', '张三', 'q', async () => {});
  t.push({ kind: 'thinking', text: '嗯' });
  assert.equal(t.silent, false, '只思考也算跑起来了');
});

test('session 跟着作业落盘，老库自动补列 —— 重启后历史作业还能「接着问」', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcr-db-sess-'));
  const raw = new DatabaseSync(join(dir, 'history.db'));
  raw.exec(`CREATE TABLE handled (msg_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, who TEXT NOT NULL, q TEXT NOT NULL,
    status TEXT NOT NULL, answer TEXT, error TEXT, started_at INTEGER NOT NULL, ended_at INTEGER)`);
  raw.close();

  const db = new Db(dir);
  db.claim({ msgId: 'om_s', chatId: 'oc', who: 'a', q: 'q' });
  db.settle('om_s', 'done', '答', undefined, 'sess-1');
  assert.equal(db.recent(1)[0].session, 'sess-1');
  db.close();
});

test('游标：查到哪了要落盘，重启接着查', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcr-cur-'));
  const a = new Db(dir);
  assert.equal(a.cursor(), undefined, '第一次跑没有游标 = 从"现在"开始，不回放历史');
  a.setCursor(1791791334924);
  assert.equal(a.cursor(), 1791791334924);
  a.setCursor(1791791400000);
  assert.equal(a.cursor(), 1791791400000, '要覆盖，不是攒一堆');
  a.close();

  const b = new Db(dir);
  assert.equal(b.cursor(), 1791791400000, '重启后不能从头再捞一遍');
  b.close();
});

test('并发上限热更新：调大马上放排队的进来，调小不掐在跑的', async () => {
  const p = new Pool(1);
  const order: string[] = [];
  await p.acquire();
  const b = p.acquire().then(() => order.push('b'));
  const c = p.acquire().then(() => order.push('c'));
  await Promise.resolve();
  assert.deepEqual(order, [], '上限 1，b、c 排队');

  p.resize(2);
  await b;
  assert.deepEqual(order, ['b'], '调到 2，放进来一个');

  p.resize(1);
  p.release(); // 2 个在跑、上限 1：先降下来，不交给 c
  await Promise.resolve();
  assert.deepEqual(order, ['b']);
  p.release(); // 1 个在跑、上限 1：交给 c
  await c;
  assert.deepEqual(order, ['b', 'c']);
});

/* ---------- 流式卡片（机器人） ---------- */

test('按时间顺序（机器人）：过场话挪进过程、排在它引出的工具前面，正文只留最后一段；过程在上结论在下', () => {
  const b = new CardBuilder();
  b.chrono = true;
  b.push({ kind: 'text', text: '我先看下日志' });
  assert.equal(b.text.trim(), '我先看下日志', '跑的时候分不清是不是最后一段，先放正文');
  b.push({ kind: 'tool', id: 't', name: 'Bash', input: { command: 'grep x' } });
  b.push({ kind: 'result', id: 't', text: 'hit', isError: false });
  b.push({ kind: 'text', text: '结论：是 Y' });
  assert.equal(b.text.trim(), '结论：是 Y');
  assert.ok(b.process.indexOf('我先看下日志') < b.process.indexOf('Bash'), '过场话在工具前面');

  const els = (buildCard({ who: '张三', q: '问', status: 'done', text: b.text, process: b.process, tools: 1, chrono: true }) as any).body.elements;
  assert.deepEqual(els.map((e: any) => e.tag), ['markdown', 'collapsible_panel', 'markdown']);
  assert.match(els[2].content, /结论/);
  const old = (buildCard({ who: '张三', q: '问', status: 'done', text: '结论', process: 'p', tools: 1 }) as any).body.elements;
  assert.equal(old[2].tag, 'collapsible_panel', '@我 的卡片不变：正文在上');
});

test('机器人的卡片：思考只留开头、不放工具输出；超了丢最老的步骤，跑完也留着最后几步和结论', () => {
  const b = new CardBuilder();
  b.chrono = true;
  for (let i = 0; i < 200; i++) {
    b.push({ kind: 'thinking', text: `第${i}轮想法 ` + '很长的推理'.repeat(400) });
    b.push({ kind: 'tool', id: `t${i}`, name: 'Bash', input: { command: `grep step${i}` } });
    b.push({ kind: 'result', id: `t${i}`, text: 'RAW_OUTPUT '.repeat(50), isError: false });
  }
  b.push({ kind: 'text', text: '结论：是 Y' });
  assert.doesNotMatch(b.process, /RAW_OUTPUT/);
  assert.ok(b.process.length < 200 * 250, '每段思考只剩开头一行');

  const card = buildCard({ who: '张三', q: '问', status: 'done', text: b.text, process: b.process, tools: 200, chrono: true });
  const json = JSON.stringify(card);
  assert.ok(Buffer.byteLength(json) <= 24 * 1024);
  assert.match(json, /grep step199/, '最后一步在');
  assert.doesNotMatch(json, /grep step0`/, '最老的丢了');
  assert.match(json, /结论：是 Y/);
  assert.doesNotMatch(json, /text_tag[^>]*$|^[^<]*\/text_tag>/m, '不从一行中间切');
});

/** 记下 CardKit 上的每一步；closeOnce() 让下一次打字报「流式模式已关」（开 10 分钟会自己关） */
function fakeKit() {
  const ops: any[] = [];
  let closed = 0;
  const kit: Kit = {
    create: async (card) => { ops.push(['create', card]); return 'c1'; },
    text: async (_id, el, content, seq) => {
      if (closed) { closed--; throw Object.assign(new Error('streaming mode is closed'), { code: 300309 }); }
      ops.push(['text', el, content, seq]);
    },
    update: async (_id, card, seq) => { ops.push(['update', card, seq]); },
    streaming: async (_id, on, seq) => { ops.push(['streaming', on, seq]); },
  };
  return { kit, ops, closeOnce: () => { closed = 1; } };
}
const settle = () => new Promise((r) => setTimeout(r, 450)); // 流式卡片节流 400ms

test('流式卡片：建实体按 card_id 发；骨架不变只打字（正文接着上次的往后打）；收尾先关流式再整卡写', async () => {
  const k = fakeKit();
  const sent: unknown[] = [];
  const plain: unknown[] = [];
  const s = new KitStream(k.kit, async (c) => { sent.push(c); return 'om_card'; }, '张三', '问', async (_id, c) => { plain.push(c); });
  s.push({ kind: 'init', sessionId: 's1' });
  await s.open();
  assert.deepEqual(sent, [{ type: 'card', data: { card_id: 'c1' } }]);
  assert.equal(s.cardId, 'om_card', '锚点记的是消息 id，引用回复指的是它');
  assert.match(JSON.stringify(k.ops[0][1]), /"streaming_mode":true/);

  s.push({ kind: 'text', text: '第一段' });
  await settle();
  s.push({ kind: 'text', text: '第二段' });
  await settle();
  const texts = k.ops.filter((o) => o[0] === 'text');
  assert.deepEqual(texts.map((o) => [o[1], o[2]]), [['body', '第一段'], ['body', '第一段\n\n第二段']], '旧文本是新文本的前缀 —— 打字机接着打');

  k.closeOnce();
  s.push({ kind: 'text', text: '第三段' });
  await settle();
  const reopen = k.ops.findIndex((o) => o[0] === 'streaming' && o[1] === true);
  assert.ok(reopen > 0 && k.ops[reopen + 1][0] === 'text', '流式模式自己关了：重新打开接着打');

  s.push({ kind: 'tool', id: 't', name: 'Bash', input: { command: 'ls' } });
  await settle();
  assert.equal(k.ops.at(-1)[0], 'update', '多出过程面板 = 骨架变了，整卡替换');
  assert.doesNotMatch(JSON.stringify(k.ops.at(-1)[1]), /次工具调用/, '跑的时候面板标题不写次数，不然每次工具调用都得整卡重写');

  await s.finish('', true);
  const [off, last] = k.ops.slice(-2);
  assert.deepEqual(off.slice(0, 2), ['streaming', false]);
  assert.equal(last[0], 'update');
  assert.match(JSON.stringify(last[1]), /已完成/);
  assert.match(JSON.stringify(last[1]), /1 次工具调用/);
  assert.doesNotMatch(JSON.stringify(last[1]), /streaming_mode/, '收尾帧不流式');
  const seqs = k.ops.filter((o) => o[0] !== 'create').map((o) => o.at(-1));
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'sequence 严格递增');
  assert.equal(new Set(seqs).size, seqs.length);
  assert.deepEqual(plain, [], '没走普通卡片那条路');
});

test('流式卡片：CardKit 建不出来就退回普通卡片，别让机器人不吭声', async () => {
  const k = fakeKit();
  k.kit.create = async () => { throw new Error('no permission'); };
  const sent: unknown[] = [];
  const plain: unknown[] = [];
  const s = new KitStream(k.kit, async (c) => { sent.push(c); return 'om_card'; }, '张三', '问', async (_id, c) => { plain.push(c); });
  await s.open();
  s.push({ kind: 'text', text: '结论' });
  await s.finish('', true);
  assert.match(JSON.stringify(sent[0]), /"schema":"2.0"/, '发的是普通卡片 JSON');
  assert.doesNotMatch(JSON.stringify(sent[0]), /streaming_mode/);
  assert.match(JSON.stringify(plain.at(-1)), /已完成/, '收尾走原地 PATCH');
});

test('流式卡片：收尾那帧写失败会重试（丢了卡片就永远停在处理中）', async () => {
  const k = fakeKit();
  let fails = 1;
  const update = k.kit.update;
  k.kit.update = async (id, card, seq) => {
    if (/已完成|已中断/.test(JSON.stringify(card)) && fails-- > 0) throw Object.assign(new Error('interacting'), { code: 200810 });
    return update(id, card, seq);
  };
  const s = new KitStream(k.kit, async () => 'om_card', '张三', '问', async () => {});
  await s.open();
  await s.finish('被叫停', false);
  assert.match(JSON.stringify(k.ops.at(-1)[1]), /已中断/);
});
