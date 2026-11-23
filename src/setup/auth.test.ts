import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authUrl, front, mcpState, parseMcpList, routes, searchAvailable, skillsIn, terminalScript, why } from './auth.ts';

/** 真机上 `claude mcp list` 的样子（插件的 + claude.ai 连接器 + 几种状态，Windows 是 \r\n） */
const SAMPLE = [
  'Checking MCP server health…',
  '',
  'claude.ai Slack: https://mcp.slack.com/mcp - ! Needs authentication',
  'plugin:my-skills:DOT: http://dot.example.com/mcp (HTTP) - ! Needs authentication',
  'plugin:my-skills:CK: http://ck.example.com/mcp (HTTP) - ✔ Connected',
  'plugin:my-skills:QMQ: http://qmq - x.example.com/mcp (HTTP) - ✘ Failed to connect',
  'local: npx -y some-server --flag - ⏸ Pending approval',
].join('\r\n');

test('mcp list：名字带冒号也切得对，状态取最后一个 " - " 后面、去掉图标', () => {
  const m = parseMcpList(SAMPLE);
  assert.deepEqual([...m], [
    ['claude.ai Slack', 'Needs authentication'],
    ['plugin:my-skills:DOT', 'Needs authentication'],
    ['plugin:my-skills:CK', 'Connected'],
    ['plugin:my-skills:QMQ', 'Failed to connect'],
    ['local', 'Pending approval'],
  ]);
  assert.equal(parseMcpList('No MCP servers configured. Use `claude mcp add` to add a server.').size, 0);
});

test('mcp 状态 → check：没结果 running，要授权 missing，连不上 error', () => {
  assert.equal(mcpState(undefined), 'running');
  assert.equal(mcpState('Connected'), 'ok');
  assert.equal(mcpState('Needs authentication'), 'missing');
  assert.equal(mcpState('Failed to connect'), 'error');
  assert.equal(mcpState('Pending approval'), 'error');
});

test('报错取人话：lark-cli 的 JSON、没装、claude 的最后一行', () => {
  assert.equal(why({ code: 3, out: '', err: '{"ok":false,"error":{"message":"not configured"}}' }), 'not configured');
  // config init：先存了再验，stderr 前面垫一行 OK
  const init = 'OK: Configuration saved to /x/config.json\n{\n  "ok": false,\n  "error": {\n    "message": "The specified \\"app\\" does not exist."\n  }\n}';
  assert.equal(why({ code: 3, out: '{\n  "appId": "cli_x"\n}', err: init }), 'The specified "app" does not exist.');
  assert.equal(why({ code: -1, out: '', err: 'spawn lark-cli ENOENT' }), '还没装（见第一步）');
  assert.equal(why({ code: 1, out: 'Installing…✘ Failed: not found\n\n', err: '' }), 'Installing…✘ Failed: not found');
});

test('mac 终端脚本：路径里有空格和单引号，真用 sh 跑一遍，参数和环境变量原样到 claude', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'lcr auth '));
  const cwd = join(root, "it's a dir");
  const cfgDir = join(root, 'cfg $HOME `x`');
  mkdirSync(cwd);
  const claude = join(root, 'fake claude');
  writeFileSync(claude, '#!/bin/sh\nprintf "%s|%s|%s|%s" "$CLAUDE_CONFIG_DIR" "$PWD" "$1 $2" "$3"\n', { mode: 0o755 });

  const s = terminalScript(false, { claude, name: 'plugin:my-skills:BAT', configDir: cfgDir, cwd });
  assert.equal(s.ext, '.command');
  const file = join(root, `x${s.ext}`);
  writeFileSync(file, s.content, { mode: 0o700 });
  const out = execFileSync('/bin/sh', [file], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const [dir, pwd, sub, name] = out.split('\n')[0].split('|');
  assert.equal(dir, cfgDir);
  assert.equal(execFileSync('/bin/sh', ['-c', 'cd "$0" && pwd -P', pwd], { encoding: 'utf8' }).trim(),
    execFileSync('/bin/sh', ['-c', 'cd "$0" && pwd -P', cwd], { encoding: 'utf8' }).trim());
  assert.equal(sub, 'mcp login');
  assert.equal(name, 'plugin:my-skills:BAT');
  assert.ok(!existsSync(file), '跑完自己删掉');

  // 没设 CLAUDE_CONFIG_DIR 就不 export：显式设成 ~/.claude 跟不设，claude 存凭证的地方可能不一样
  assert.ok(!terminalScript(false, { claude, name: 'x', cwd }).content.includes('CLAUDE_CONFIG_DIR'));
});

test('Windows 终端脚本：路径和名字不进脚本（代码页会弄乱中文路径），走环境变量', () => {
  const o = { claude: 'C:\\Users\\张 三\\.local\\bin\\claude.exe', name: 'plugin:my-skills:BAT', configDir: 'C:\\x', cwd: 'C:\\y' };
  const s = terminalScript(true, o);
  assert.equal(s.ext, '.cmd');
  assert.ok(/^[\x00-\x7f]*$/.test(s.content), '脚本只有 ASCII');
  assert.ok(s.content.includes('\r\n'));
  assert.ok(s.content.includes('"%LCR_TERM_CLAUDE%" mcp login "%LCR_TERM_NAME%"'));
  assert.equal(s.env.LCR_TERM_CLAUDE, o.claude);
  assert.equal(s.env.LCR_TERM_NAME, o.name);
  assert.ok(!/[&|<>^%]/.test(s.env.LCR_TERM_TIP), '提示语是 echo %VAR% 展开的，不能带 cmd 的特殊字符');
});

test('授权链接从 claude 的终端输出里抠：剥掉终端超链接和颜色码，只留一份完整链接', () => {
  const u = 'https://cas.example.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A56879%2Fcallback&state=abc';
  // 真实输出长这样（OSC 8 超链接里夹着一份链接，BEL 结尾；伪终端换行是 \r\n）
  const out = `\x1b[0mStarting authentication…\r\nVisit this URL to authorize:\r\n  \x1b]8;;${u}\x07${u}\x1b]8;;\x07\r\nWaiting for authorization…`;
  assert.equal(authUrl(out), u);
  assert.equal(authUrl(`\x1b]8;;${u}\x1b\\${u}\x1b]8;;\x1b\\`), u); // ST 结尾的写法
  assert.equal(authUrl('Starting authentication…'), undefined); // 链接还没打出来
});

test('SKILL.md 头：取字段、去引号；没有头就是空', () => {
  const md = '---\nname: "doc-writing"\ndescription: 写飞书文档时用: 提测、方案\n---\n# x\nname: 不算\n';
  assert.equal(front(md, 'name'), 'doc-writing');
  assert.equal(front(md, 'description'), '写飞书文档时用: 提测、方案');
  assert.equal(front('# 没有头\nname: x', 'name'), '');
});

test('skill 目录：带 SKILL.md 的子目录才算，名字缺了用目录名；目录不在就是空', () => {
  const d = mkdtempSync(join(tmpdir(), 'lcr-sk-'));
  mkdirSync(join(d, 'a')); writeFileSync(join(d, 'a', 'SKILL.md'), '---\nname: alpha\ndescription: d\n---\n');
  mkdirSync(join(d, 'b')); writeFileSync(join(d, 'b', 'SKILL.md'), '没头');
  mkdirSync(join(d, 'c'));
  assert.deepEqual(skillsIn(d).sort((x, y) => x.dir.localeCompare(y.dir)), [
    { name: 'alpha', description: 'd', dir: 'a' }, { name: 'b', description: '', dir: 'b' }]);
  assert.deepEqual(skillsIn(join(d, 'nope')), []);
});

test('能装的插件：已装的不出现，自己加的市场排前面，名字命中排在只有描述命中前面', () => {
  const a = (id: string, description = '') => ({ pluginId: id, name: id.split('@')[0], description, marketplaceName: id.split('@')[1] });
  const list = [a('x-doc@official', '写 sql'), a('sql-helper@official'), a('sql-team@team'), a('have@team', 'sql'), a('other@official', '无关')];
  const r = searchAvailable(list, new Set(['have@team']), new Set(['team']), 'SQL');
  assert.deepEqual(r.map((x) => x.id), ['sql-team@team', 'sql-helper@official', 'x-doc@official']);
  assert.equal(searchAvailable(list, new Set(), new Set(), '').length, 5);
});

test('自己加 skill：拷进配置目录的 skills，重名、没 SKILL.md、选 skills 目录本身都拒；删只删这里面的', async () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'lcr-cc-'));
  const src = mkdtempSync(join(tmpdir(), 'lcr-src-'));
  writeFileSync(join(src, 'SKILL.md'), '---\nname: my-skill\n---\n');
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  try {
    const skill = routes['POST /api/setup/cc/skill'];
    const ctx = { cfg: {} as any };
    assert.deepEqual(await skill({ action: 'add', path: src }, ctx), { ok: true, name: 'my-skill' });
    assert.ok(existsSync(join(cfgDir, 'skills', 'my-skill', 'SKILL.md')));
    assert.match((await skill({ action: 'add', path: src }, ctx) as any).error, /已经有/);
    assert.match((await skill({ action: 'add', path: tmpdir() }, ctx) as any).error, /没有 SKILL.md/);
    assert.match((await skill({ action: 'add', path: 'relative/dir' }, ctx) as any).error, /完整路径/);
    assert.match((await skill({ action: 'add', path: join(cfgDir, 'skills', 'my-skill') }, ctx) as any).error, /不能选/);
    assert.match((await skill({ action: 'remove', name: '../x' }, ctx) as any).error, /没有这个/);
    assert.deepEqual(await skill({ action: 'remove', name: 'my-skill' }, ctx), { ok: true });
    assert.ok(!existsSync(join(cfgDir, 'skills', 'my-skill')));
    assert.ok(existsSync(join(src, 'SKILL.md')), '原文件夹不能动');
  } finally {
    if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old;
  }
});

test('插件 / 市场操作：名字带奇怪字符、- 开头的地址、没装的插件都在跑 claude 之前拒掉', async () => {
  const ctx = { cfg: {} as any };
  const plugin = routes['POST /api/setup/cc/plugin'], market = routes['POST /api/setup/cc/marketplace'];
  assert.match((await plugin({ action: 'install', plugin: '--help' }, ctx) as any).error, /插件名不对/);
  assert.match((await plugin({ action: 'install', plugin: 'a b@c' }, ctx) as any).error, /插件名不对/);
  assert.match((await plugin({ action: 'rm -rf', plugin: 'a@b' }, ctx) as any).error, /不认识的操作/);
  assert.match((await plugin({ action: 'uninstall', plugin: 'not-installed@x' }, ctx) as any).error, /没装/);
  assert.match((await market({ action: 'add', source: '--config=x' }, ctx) as any).error, /地址不对/);
  assert.match((await market({ action: 'add', source: 'a b' }, ctx) as any).error, /地址不对/);
  assert.match((await market({ action: 'remove', name: 'nope' }, ctx) as any).error, /没有这个插件市场/);
  assert.match((await routes['POST /api/setup/mcp/logout']({ name: 'x' }, ctx) as any).error, /不认识的 MCP/);
});
