import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig, sanitizeConfig, projectFor, promptFor, argsFor, resolveChat, routingTemplates, claudeSettingsFor, migrate, isOn, scopeOf, apiEnv, sanitizeApis } from './config.ts';

const ME = 'ou_me';
/** 解会话要的是一个入口眼里的配置（chats / defaultTemplate 摊在顶上）。这些测试测的都是 @我 那份 */
const loadUser = (p: string) => scopeOf(loadConfig(p), 'user');
/** 只有 @我 一个入口时的写法：会话绑定在顶层。现在由 migrate 挪进 user */
/** 默认写一份"新格式"配置：场景字段都在模板上，顶层只有服务级参数 */
const tmp = (chats: unknown = { oc_a: '' }, extra: Record<string, unknown> = {}) => {
  const p = join(mkdtempSync(join(tmpdir(), 'lcr-')), 'config.json');
  writeFileSync(p, JSON.stringify({
    me: ME,
    chats,
    templates: { 通用: { project: '~/proj' } },
    defaultTemplate: '通用',
    ...extra,
  }));
  return p;
};

test('会话就是选模板：空串 = 默认模板，选了不存在的也落回默认', () => {
  const cfg = loadUser(tmp({ oc_a: '', oc_b: '野', oc_c: '没了' }, {
    templates: { 通用: { project: '~/proj' }, 野: { project: '/srv/other' } },
  }));
  assert.equal(projectFor(cfg, 'oc_a'), join(homedir(), 'proj'));
  assert.equal(projectFor(cfg, 'oc_b'), '/srv/other');
  assert.equal(resolveChat(cfg, 'oc_c').template, '通用');
  assert.equal(projectFor(cfg, 'oc_unknown'), join(homedir(), 'proj'), '没见过的会话也解得出来');
  assert.equal(isOn(cfg, 'oc_a'), true, '值是空串也算启用');
  assert.equal(isOn(cfg, 'oc_unknown'), false);
});

test('模板没配项目就是空串 —— 不能拿仓库根目录当 cwd 蒙混过去', () => {
  const cfg = loadUser(tmp({ oc_a: '' }, { templates: { 通用: {} } }));
  assert.equal(projectFor(cfg, 'oc_a'), '');
  assert.equal(resolveChat(cfg, 'oc_a').project, '');
});

test('老格式 chats 是数组也能认', () => {
  const cfg = loadConfig(tmp(['oc_a', 'oc_b']));
  assert.deepEqual(cfg.user.chats, { oc_a: '', oc_b: '' });
});

test('迁移：判定 / 网关从按名字引用内联进模板，只读并进权限，会话只留模板名', () => {
  const raw = migrate({
    judges: { 排障: '判一下' },
    gateways: { 内网: { baseUrl: 'http://gw', token: 'tk' } },
    judgeGateway: '内网',
    templates: {
      a: { judge: '排障', gateway: '内网', readonly: true, permissionMode: 'bypassPermissions' },
      b: { judge: '没了', gateway: '没了', readonly: false },
      c: {},
    },
    chats: { oc_1: {}, oc_2: { p2p: true, template: 'b' }, oc_3: { project: '/x', readonly: true } },
  });
  assert.deepEqual(raw.templates.a, { judge: '判一下', api: 'a', permissionMode: 'plan' }, '只读 = plan，盖过原来的权限；自己的网关进来源表、固定用它');
  assert.deepEqual(raw.apis, [{ name: 'a', kind: 'gateway', baseUrl: 'http://gw', token: 'tk' }]);
  assert.deepEqual(raw.templates.b, {}, '指向不存在的判定 / 网关就丢掉；readonly:false 就是没配');
  assert.deepEqual(raw.user.chats, { oc_1: '', oc_2: 'b', oc_3: '' }, 'p2p 不用记了，会话覆盖丢掉；顶层的会话绑定就是 @我 的');
  assert.ok(!('chats' in raw) && !('defaultTemplate' in raw));
  assert.ok(!('judges' in raw) && !('gateways' in raw) && !('judgeGateway' in raw));
  // 幂等：新格式再迁一次不变（judge 已经是提示词了，没有 judges 表就不当名字查）
  assert.deepEqual(migrate(structuredClone(raw)), raw);
});

test('老格式：顶层那些场景字段全部提到模板上', () => {
  const cfg = loadUser(tmp({ oc_a: '' }, {
    templates: { 通用: {} },          // 老格式里模板上什么都没有，场景字段全在顶层
    project: '~/legacy',
    permissionMode: 'plan',
    self: true,
    claudeArgs: ['--model', 'opus'],
    systemPrompt: '老的那段提示词',
  }));
  const t = cfg.templates['通用'];
  assert.equal(t.project, '~/legacy');
  assert.equal(t.permissionMode, 'plan');
  assert.equal(t.self, true);
  assert.deepEqual(t.claudeArgs, ['--model', 'opus']);
  assert.equal(t.prompt, '老的那段提示词', '老格式的顶层提示词是"完整那段"，直接落到模板上');

  const r = resolveChat(cfg, 'oc_a');
  assert.equal(r.project, '~/legacy');
  assert.equal(r.permissionMode, 'plan');
  assert.equal(r.self, true);
  assert.deepEqual(r.claudeArgs, ['--model', 'opus']);
});

test('老格式：模板的"追加提示词"跟顶层那段拼回去，语义不变', () => {
  const cfg = loadUser(tmp({ oc_a: '' }, {
    systemPrompt: '底线',
    templates: { 通用: { project: '~/proj', prompt: '只答订单域' } },
  }));
  assert.equal(cfg.templates['通用'].prompt, '底线\n\n只答订单域');
});

test('老格式：两份一模一样的只留一份（以前会原样发两遍）', () => {
  // web UI 预填的锅：模板的 prompt 常常就是把顶层那段又抄了一遍，
  // 而 promptFor 是"顶层 + 模板追加"拼的 —— 实际发出去就是同一段送两遍
  const same = '你在飞书里代我回答问题。\n不需要回答就输出 SKIP。';
  const cfg = loadUser(tmp({ oc_a: '' }, {
    systemPrompt: same,
    templates: { 通用: { project: '~/proj', prompt: same } },
  }));
  assert.equal(cfg.templates['通用'].prompt, same, '一样就别拼，不然发两遍');
  assert.equal(promptFor(cfg, 'oc_a'), same);
});

test('迁移是幂等的：反复 load 不会越拼越长', () => {
  const p = tmp({ oc_a: '' }, { systemPrompt: '底线', templates: { 通用: { prompt: '追加' } } });
  const once = promptFor(loadUser(p), 'oc_a');
  const twice = promptFor(loadUser(p), 'oc_a');
  assert.equal(once, twice);
  assert.equal(once, '底线\n\n追加');
});

test('迁移过的老键会在保存时从文件里抹掉', () => {
  const p = tmp({ oc_a: '' }, { systemPrompt: '底线' });
  assert.ok('systemPrompt' in JSON.parse(readFileSync(p, 'utf8')), '保存前还在文件里');
  saveConfig({ user: { on: true, chats: { oc_a: '' }, defaultTemplate: '通用', allP2p: false, allGroups: false }, templates: loadConfig(p).templates, pollMs: 60000, maxJobs: 3 }, p);
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  assert.ok(!('systemPrompt' in raw), '保存后老键清掉');
  assert.ok(!('project' in raw), '顶层不再有 project —— 场景字段全在模板上');
  assert.equal(raw.templates['通用'].prompt, '底线');
});

test('没写模板就是「通用」', () => {
  const cfg = loadUser(tmp({ oc_a: '' }));
  assert.deepEqual(Object.keys(cfg.templates), ['通用']);
  assert.deepEqual(resolveChat(cfg, 'oc_a'), {
    template: '通用', agent: 'claude', codexSandbox: 'read-only', project: '~/proj', model: '', permissionMode: 'auto', prompt: '',
    judge: '', apis: [], claudeSettings: {}, claudeArgs: [], self: false,
  });
});

test('模板生效：会话没写的字段跟着模板走', () => {
  const cfg = loadUser(tmp({ oc_a: '订单排障', oc_b: '' }, {
    templates: {
      通用: { project: '~/proj' },
      订单排障: { project: '~/IdeaProjects/order', prompt: '只答订单域', permissionMode: 'plan', self: true },
    },
    defaultTemplate: '通用',
  }));
  const a = resolveChat(cfg, 'oc_a');
  assert.equal(a.template, '订单排障');
  assert.equal(a.project, '~/IdeaProjects/order');
  assert.equal(a.permissionMode, 'plan');
  assert.equal(a.self, true, 'self 也是按模板配的');
  assert.equal(projectFor(cfg, 'oc_a'), join(homedir(), 'IdeaProjects/order'));
  assert.equal(promptFor(cfg, 'oc_a'), '只答订单域');
  assert.deepEqual(argsFor(cfg, 'oc_a').slice(-2), ['--permission-mode', 'plan']);

  const b = resolveChat(cfg, 'oc_b');
  assert.equal(b.template, '通用');
  assert.equal(b.project, '~/proj');
  assert.equal(b.self, false);
});

test('提示词是模板上一个完整字段：填了就整个换掉，没填就真的不加', () => {
  const cfg = loadUser(tmp({ oc_a: '', oc_b: '野' }, {
    templates: { 通用: { project: '~/proj' }, 野: { prompt: '只答这个场景的事，不要回答别的' } },
  }));
  // 以前这里会兜到 DEFAULT_SYSTEM_PROMPT —— 于是"清空了怎么还 SKIP"没人说得清：
  // 空是空，模型手里没有 SKIP 规则，才会回每一条
  assert.equal(promptFor(cfg, 'oc_a'), '', '没写就是空，不塞默认那段');
  assert.equal(promptFor(cfg, 'oc_b'), '只答这个场景的事，不要回答别的', '写了就是整个替换，不拼接');
});

test('模板指定模型 → --model，盖过额外参数里写的；坏值不收', () => {
  const cfg = { chats: { oc: '' }, defaultTemplate: 't', templates: { t: { model: 'opus', claudeArgs: ['--model', 'haiku'] } } } as any;
  const a = argsFor(cfg, 'oc');
  assert.equal(a[a.lastIndexOf('--model') + 1], 'opus', '专门的字段在后面，以它为准');
  assert.equal(argsFor({ ...cfg, templates: { t: {} } }, 'oc').includes('--model'), false, '不填就不传');

  const base = { templates: {}, user: { on: true, chats: {}, defaultTemplate: '通用' }, bot: { on: false, chats: {}, defaultTemplate: '通用' }, pollMs: 60_000, maxJobs: 3 } as any;
  const s = sanitizeConfig({ templates: { a: { model: ' claude-opus-4-1[1m] ' }, b: { model: 'opus --dangerously-skip-permissions' } } }, base);
  assert.equal(s.templates.a.model, 'claude-opus-4-1[1m]');
  assert.equal(s.templates.b.model, undefined, '带空格的不收，别把参数拼进 argv');
});

test('API 来源的地址 / 令牌 / 档位映射盖在 env 上，模板只管档位；都没配就不传 --settings', () => {
  const gw = { name: 'gw', kind: 'gateway', baseUrl: 'http://gw.local', token: 'tk', models: { opus: 'claude-auto', haiku: 'fast' } } as const;
  const cfg = {
    chats: { a: 'gw', b: 'plain', c: 'only' }, defaultTemplate: 'plain', apis: [],
    templates: {
      gw: { model: 'opus', claudeSettings: { env: { ANTHROPIC_MODEL: 'm1', ANTHROPIC_BASE_URL: '会被盖掉' }, includeCoAuthoredBy: false } },
      plain: { judge: '判一下' },
      only: { claudeSettings: { env: { ANTHROPIC_MODEL: 'm2' } } },
    },
  } as any;
  assert.deepEqual(claudeSettingsFor(cfg, 'a', gw), {
    env: { ANTHROPIC_MODEL: 'm1', ANTHROPIC_BASE_URL: 'http://gw.local', ANTHROPIC_AUTH_TOKEN: 'tk',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-auto', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fast' }, includeCoAuthoredBy: false,
  });
  assert.equal(claudeSettingsFor(cfg, 'b'), undefined, '什么都没配 = 完全跟 ~/.claude/settings.json 走');
  assert.deepEqual(claudeSettingsFor(cfg, 'c'), { env: { ANTHROPIC_MODEL: 'm2' } });
  assert.equal(resolveChat(cfg, 'b').judge, '判一下');
  assert.equal(resolveChat(cfg, 'a').judge, '', '没写判定 = 直接回');
  const a = argsFor(cfg, 'a', '/x/s.json');
  assert.equal(a[a.indexOf('--settings') + 1], '/x/s.json');
  assert.equal(a[a.indexOf('--model') + 1], 'opus', '--model 只放模板选的档位，各家叫什么走 env 里的映射');
  assert.equal(argsFor(cfg, 'b').includes('--settings'), false);

  assert.deepEqual(apiEnv({ name: 's', kind: 'subscription', token: 'sk-ant-oat01-x', models: { sonnet: 'x' } }),
    { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-x', ANTHROPIC_DEFAULT_SONNET_MODEL: 'x' });
  assert.deepEqual(apiEnv({ name: 's', kind: 'subscription' }), {}, '订阅没填令牌 = 用 claude 自己登录的');
  assert.deepEqual(apiEnv({ name: 'k', kind: 'gateway', baseUrl: 'https://api.anthropic.com', token: 'sk-ant-api03-x' }),
    { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: 'sk-ant-api03-x' }, '官方 key 走 x-api-key，不能当 Bearer 发');
});

test('API 来源表过 sanitize：令牌没传沿用已存的（改名按 from 找回），传空串才清；坏的整条不收；模板只能固定到表里有的', () => {
  const cur = [{ name: '旧名', kind: 'gateway', baseUrl: 'http://a', token: 'secret' }, { name: '清掉', kind: 'gateway', baseUrl: 'http://c', token: 't' }] as any;
  const { apis, errors } = sanitizeApis([
    { name: '新名', kind: 'gateway', baseUrl: ' http://a/ ', from: '旧名' },
    { name: '清掉', kind: 'gateway', baseUrl: 'http://c', token: '' },
    { name: '坏的', kind: 'gateway', baseUrl: 'ftp://x' },
    { name: '订阅', kind: 'subscription', models: { opus: ' claude-opus-4-1 ', sonnet: '' }, baseUrl: 'http://忽略' },
    { name: '订阅', kind: 'subscription' },
    { name: '坏模型', kind: 'subscription', models: { haiku: 'a b' } },
  ], cur);
  assert.deepEqual(apis, [
    { name: '新名', kind: 'gateway', baseUrl: 'http://a', token: 'secret' },
    { name: '清掉', kind: 'gateway', baseUrl: 'http://c' },
    { name: '订阅', kind: 'subscription', models: { opus: 'claude-opus-4-1' } },
  ]);
  assert.equal(errors.length, 3, '坏地址、重名、坏模型名各报一条');

  const base = { user: { on: true, chats: {}, defaultTemplate: 'a' }, bot: { on: false, chats: {}, defaultTemplate: 'a' }, pollMs: 60_000, maxJobs: 3, templates: {}, apis };
  const s = sanitizeConfig({ templates: { a: { api: '订阅' }, b: { api: '没这个' }, 带判定: { judge: '  判一下  ', claudeSettings: { env: { X: '1' } } }, 坏的: { claudeSettings: [1] } } }, base as any);
  assert.deepEqual(s.templates.a, { api: '订阅' });
  assert.deepEqual(s.templates.b, {}, '固定到不存在的来源 = 不固定');
  assert.deepEqual(s.templates.带判定, { judge: '判一下', claudeSettings: { env: { X: '1' } } });
  assert.deepEqual(s.templates.坏的, {}, '不是对象的 settings 不收');
});

test('模板的额外参数会带上', () => {
  const cfg = loadUser(tmp({ oc_a: '' }, { templates: { 通用: { project: '~/proj', claudeArgs: ['--model', 'opus'] } } }));
  assert.deepEqual(argsFor(cfg, 'oc_a'), ['--model', 'opus', '--permission-mode', 'auto']);
});

test('保存只动传进去的键，原文的 ~ 和别的键都留着', () => {
  const p = tmp(undefined, { stateDir: 'st' });
  saveConfig({ user: { on: true, chats: { oc_a: '', oc_b: '别的' }, defaultTemplate: '通用', allP2p: false, allGroups: false }, templates: { 通用: { project: '~/proj' }, 别的: { project: '~/other' } }, pollMs: 60000, maxJobs: 3 }, p);

  const raw = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(raw.templates['别的'].project, '~/other');    // 不能写成解析后的绝对路径
  assert.equal(raw.stateDir, 'st');                           // 没传的键不能被抹掉
  assert.equal(raw.me, undefined, 'me 跟 lark-cli 登录的用户走，老文件里的顺手抹掉');

  const cfg = loadUser(p);
  assert.equal(projectFor(cfg, 'oc_b'), join(homedir(), 'other'));
});

test('前端传来的配置一律过一遍：越界夹回去，坏值落回当前值', () => {
  const cfg = loadConfig(tmp({ oc_a: '' }, { pollMs: 60000, maxJobs: 3 }));
  const next = sanitizeConfig({
    user: {
      chats: { oc_a: '订单排障', oc_b: '不存在的模板', oc_c: { template: '订单排障' }, '': '订单排障' },
      defaultTemplate: '不存在',
    },
    templates: {
      订单排障: { project: ' /srv/t ', 乱入: 1, permissionMode: 'rm -rf /', self: true, claudeArgs: ['--model', '', '  ', 42] },
      别的: { self: 'yes' },
      '': {},
    },
    pollMs: 1,                       // 比下限还小
    maxJobs: 999,                    // 比上限还大
  }, cfg);

  assert.deepEqual(next.templates, {
    订单排障: { project: '/srv/t', self: true, claudeArgs: ['--model'] },
    别的: {},
  }, '枚举外的权限模式、不认识的键不能进模板；空串和非字符串参数滤掉');
  assert.equal(next.user.defaultTemplate, '订单排障', '指向不存在的模板就落回第一个');
  assert.deepEqual(next.user.chats, { oc_a: '', oc_b: '', oc_c: '' }, '指向默认 / 不存在的模板 / 不是字符串的，都记成跟默认走');
  assert.equal(next.bot.on, false, '没传的入口沿用现在的');
  assert.equal(next.bot.defaultTemplate, '订单排障', '它原来的默认模板（通用）没了，也落回第一个');
  assert.equal(next.pollMs, 3_000, '太小会打爆接口，夹到下限');
  assert.equal(next.maxJobs, 10);
});

test('一个模板都不剩就兜一个空的 —— 不然会话没东西可绑', () => {
  const cfg = loadConfig(tmp({ oc_a: '' }));
  const next = sanitizeConfig({ user: { chats: { oc_a: '' } }, templates: {} }, cfg);
  assert.deepEqual(next.templates, { 通用: {} });
  assert.equal(next.user.defaultTemplate, '通用');
});

test('Codex 模板能从 Web 保存并重新加载，未知沙箱值落回只读', () => {
  const path = tmp({ oc_a: '' });
  const cfg = loadConfig(path);
  const next = sanitizeConfig({ templates: { 通用: { agent: 'codex', codexSandbox: 'workspace-write', model: 'team/gpt-5', codexEffort: 'high' },
    错误: { agent: 'codex', codexSandbox: 'yolo' }, 全放开: { agent: 'codex', codexSandbox: 'danger-full-access' } } }, cfg);
  saveConfig(next, path);
  const r = resolveChat(loadUser(path), 'oc_a');
  assert.deepEqual([r.agent, r.codexSandbox, r.model, r.codexEffort], ['codex', 'workspace-write', 'team/gpt-5', 'high']);
  assert.deepEqual(next.templates.错误, { agent: 'codex' });
  assert.equal(next.templates.全放开.codexSandbox, 'danger-full-access', '三档权限的「全放开」：显式选了才有');
});

test('只绑定 Codex 的白名单用不到 Claude，打开所有群时才需要默认模板的执行器', () => {
  const cfg = loadConfig(tmp({ oc_a: '排障' }, { templates: { 通用: {}, 排障: { agent: 'codex' } }, defaultTemplate: '通用' }));
  assert.deepEqual(routingTemplates(cfg), [cfg.templates.排障]);
  cfg.user.allGroups = true;
  assert.deepEqual(routingTemplates(cfg), [cfg.templates.排障, cfg.templates.通用]);
});

test('DEFAULTS 不能被改脏：连着 load 两次，第二次不能带上第一次的污染', () => {
  const empty = join(mkdtempSync(join(tmpdir(), 'lcr-')), 'config.json');
  writeFileSync(empty, JSON.stringify({ me: ME }));           // 连 templates 都没有
  const a = loadConfig(empty);
  a.templates['通用'].self = true;                            // 模拟 SELF=1 那种全局改写
  const b = loadConfig(empty);
  assert.equal(b.templates['通用'].self, undefined, '第二次读到的是干净的默认值');
});

test('API 来源：模板没固定就是整张表（按顺序）；固定了只用那一个；老的顶层 gateway 迁成表里第一个', () => {
  const apis = [{ name: '默认网关', kind: 'gateway', baseUrl: 'http://def', token: 'd' }, { name: '订阅', kind: 'subscription' }];
  const cfg = { chats: { a: 'own', b: '' }, defaultTemplate: 'none', apis, templates: { own: { api: '订阅' }, none: {} } } as any;
  assert.deepEqual(resolveChat(cfg, 'a').apis.map((a) => a.name), ['订阅']);
  assert.deepEqual(resolveChat(cfg, 'b').apis.map((a) => a.name), ['默认网关', '订阅']);

  const raw = migrate({ gateway: { baseUrl: 'http://def', token: 'd' }, templates: { own: { gateway: { baseUrl: 'http://own' } }, same: { gateway: { baseUrl: 'http://def', token: 'd' } }, none: {} } });
  assert.deepEqual(raw.apis, [
    { name: '默认网关', kind: 'gateway', baseUrl: 'http://def', token: 'd' },
    { name: 'own', kind: 'gateway', baseUrl: 'http://own' },
  ], '一样的网关不重复进表');
  assert.deepEqual(raw.templates, { own: { api: 'own' }, same: { api: '默认网关' }, none: {} });
  assert.ok(!('gateway' in raw));
  assert.deepEqual(migrate(structuredClone(raw)), raw, '幂等');
});

test('迁移：来源的一个模型 → 档位映射；haiku 那档接过以前的全局判定模型；填的是档位别名的丢掉', () => {
  const raw = migrate({ judgeModel: 'claude-auto', templates: {}, apis: [
    { name: 'gw', kind: 'gateway', baseUrl: 'http://gw', model: 'claude-auto' },
    { name: 'sub', kind: 'subscription', model: 'opus' },
    { name: 'sub2', kind: 'subscription', model: 'claude-opus-4-1' },
  ] });
  assert.deepEqual(raw.apis, [
    { name: 'gw', kind: 'gateway', baseUrl: 'http://gw', models: { opus: 'claude-auto', sonnet: 'claude-auto', haiku: 'claude-auto' } },
    { name: 'sub', kind: 'subscription' },
    { name: 'sub2', kind: 'subscription', models: { opus: 'claude-opus-4-1', sonnet: 'claude-opus-4-1' } },
  ]);
  assert.ok(!('judgeModel' in raw));
  assert.deepEqual(migrate(structuredClone(raw)), raw, '幂等');
  const def = migrate({ judgeModel: 'claude-haiku-4-5', apis: [{ name: 'gw', kind: 'gateway', baseUrl: 'http://gw', model: 'x' }] });
  assert.deepEqual(def.apis[0].models, { opus: 'x', sonnet: 'x' }, '判定模型还是默认的：haiku 那档不用映射');
  const bare = migrate({ judgeModel: 'claude-auto[1M]', apis: [{ name: 'gw', kind: 'gateway', baseUrl: 'http://gw' }, { name: 's', kind: 'subscription' }] });
  assert.deepEqual(bare.apis, [{ name: 'gw', kind: 'gateway', baseUrl: 'http://gw', models: { haiku: 'claude-auto[1M]' } }, { name: 's', kind: 'subscription' }],
    '网关没配模型也接过判定模型：以前判定对每个网关都用它');
});

test('两个入口：老格式的会话绑定归 @我；@机器人 默认关；各自的默认模板落不到不存在的模板上', () => {
  const cfg = loadConfig(tmp({ oc_a: '野' }, { templates: { 通用: { project: '~/p' }, 野: { project: '~/q' } } }));
  assert.deepEqual(cfg.user, { on: true, defaultTemplate: '通用', chats: { oc_a: '野' }, allP2p: false, allGroups: false }, '@我 照旧只认白名单');
  assert.deepEqual(cfg.bot, { on: false, defaultTemplate: '通用', chats: {}, allP2p: true, allGroups: true }, '机器人谁都能找，得自己开；开了默认整类放开');

  const p = tmp(undefined, {});
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  delete raw.chats; delete raw.defaultTemplate;
  raw.bot = { on: true, defaultTemplate: '没有这个', chats: { oc_x: '通用' } };
  writeFileSync(p, JSON.stringify(raw));
  const c2 = loadConfig(p);
  assert.equal(c2.bot.on, true);
  assert.equal(c2.bot.defaultTemplate, '通用');
  assert.equal(resolveChat(scopeOf(c2, 'bot'), 'oc_x').template, '通用');
  assert.equal(c2.user.on, true, '只写了 bot 的话 @我 走默认（开）');
});

test('同一个会话两个入口可以用不同的模板', () => {
  const p = tmp(undefined, {});
  writeFileSync(p, JSON.stringify({
    me: ME,
    templates: { 排障: { project: '~/a', permissionMode: 'bypassPermissions' }, 只读: { project: '~/a', permissionMode: 'plan' } },
    user: { on: true, defaultTemplate: '排障', chats: { oc_g: '' } },
    bot: { on: true, defaultTemplate: '只读', chats: {} },
  }));
  const cfg = loadConfig(p);
  assert.equal(resolveChat(scopeOf(cfg, 'user'), 'oc_g').permissionMode, 'bypassPermissions');
  assert.equal(resolveChat(scopeOf(cfg, 'bot'), 'oc_g').permissionMode, 'plan');
  assert.equal(isOn(scopeOf(cfg, 'user'), 'oc_g'), true);
});

test('所有私聊 / 所有群：开了那一类就不看白名单；白名单里的照样只决定模板', () => {
  const m = { chats: { oc_g1: '' }, allP2p: true, allGroups: false };
  assert.equal(isOn(m, 'oc_dm', 'p2p'), true, '私聊整类放开');
  assert.equal(isOn(m, 'oc_g2', 'group'), false, '群没放开，没勾就不回');
  assert.equal(isOn(m, 'oc_g1', 'group'), true, '勾了的群照样回');
  assert.equal(isOn(m, 'oc_x'), false, '不知道是什么会话的，只看白名单');
  assert.equal(isOn({ ...m, allGroups: true }, 'oc_g2', 'group'), true);

  const base = loadConfig(tmp({ oc_a: '' }));
  const next = sanitizeConfig({ user: { allP2p: true, allGroups: 'yes' } }, base);
  assert.equal(next.user.allP2p, true);
  assert.equal(next.user.allGroups, false, '不是布尔的落回当前值');
  assert.equal(next.bot.allGroups, true, '没传的入口原样留着');
});
