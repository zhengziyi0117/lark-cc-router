import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// HOME_DIR 在 config.ts 加载时就定了，所以先设环境变量再动态 import
const home = mkdtempSync(join(tmpdir(), 'lcr-ws-'));
process.env.LCR_HOME = home;
// 本地仓库当远端：子模块默认不让走 file:// 协议
process.env.GIT_ALLOW_PROTOCOL = 'file';
writeFileSync(join(home, 'config.json'), '{}');
const { routes, sections, ROOT_DIR } = await import('./workspace.ts');
const { subscribe } = await import('../bus.ts');
const { loadConfig } = await import('../config.ts');

const R = (name: string) => routes[`${name.startsWith('list') ? 'GET' : 'POST'} /api/setup/workspace/${name}`];
const cfg = loadConfig();
const ctx = { cfg };

/** 造仓库用的 git：不吃本机的全局配置（签名、默认分支） */
const g = (cwd: string, ...args: string[]) => execFileSync('git', [
  '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'protocol.file.allow=always', ...args,
], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  g(dir, 'init', '-q', '-b', 'main');
  return commit(dir);
}
function commit(dir: string): string {
  writeFileSync(join(dir, 'f.txt'), String(Math.random()));
  g(dir, 'add', '.');
  g(dir, 'commit', '-q', '-m', 'x');
  return g(dir, 'rev-parse', 'HEAD');
}
const url = (dir: string) => pathToFileURL(dir).href;

/** 慢操作结束：收集过程里推的进度 */
function finished(): Promise<{ msgs: string[]; ok: boolean }> {
  const msgs: string[] = [];
  return new Promise((r) => {
    const off = subscribe((m) => {
      if (m.type !== 'setup') return;
      msgs.push(m.msg);
      if (m.done) { off(); r({ msgs, ok: !!m.ok }); }
    });
  });
}
async function slow(name: string, body: unknown) {
  const done = finished();
  assert.deepEqual(await R(name)(body, ctx), { started: true });
  return done;
}
const list = async () => (await R('list')({}, ctx)) as any;
const repos = async (ws: string) => (await list()).workspaces.find((w: any) => w.name === ws).repos as any[];

// 一个带两个子模块的工作区仓库；sub2 的远端事后删掉 = 没权限
const src = join(home, 'src');
repo(join(src, 'sub1'));
repo(join(src, 'sub2'));
repo(join(src, 'top'));
g(join(src, 'top'), 'submodule', 'add', '-q', url(join(src, 'sub1')), 'repos/sub1');
g(join(src, 'top'), 'submodule', 'add', '-q', url(join(src, 'sub2')), 'repos/sub2');
g(join(src, 'top'), 'commit', '-q', '-m', 'subs');
rmSync(join(src, 'sub2'), { recursive: true, force: true });
const ws = join(ROOT_DIR, 'w');

test('名字、地址不合法的直接拒', async () => {
  for (const name of ['../x', 'a/b', 'a\\b', '..', '-x', '.git', 'CON', 'nul.txt', 'x.', '']) {
    await assert.rejects(R('create')({ name }, ctx), /不合法/, name);
  }
  for (const u of ['-uhoh', '--upload-pack=touch x', 'ext::sh -c touch% x', '/abs/path', 'git@h:a b', '']) {
    await assert.rejects(R('clone')({ url: u }, ctx), /不合法/, u);
  }
  await assert.rejects(R('add-existing')({ path: 'relative/dir' }, ctx), /不是一个已有的目录/);
  await assert.rejects(R('add-existing')({ path: join(home, 'nope') }, ctx), /不是一个已有的目录/);
  await assert.rejects(R('git-token')({ host: 'h/../x', token: 't' }, ctx), /不合法/);
  assert.deepEqual(await R('create')({ name: '订单' }, ctx), { ok: true, path: join(ROOT_DIR, '订单') });
});

test('clone：子模块没权限的记 missing，不中断', async () => {
  const { ok, msgs } = await slow('clone', { url: url(join(src, 'top')), name: 'w' });
  assert.ok(ok, msgs.join('\n'));
  assert.ok(msgs.some((m) => /^\d\/2 sub1 ok/.test(m)), msgs.join('\n'));
  const rs = await repos('w');
  assert.deepEqual(rs.map((r) => [r.name, r.state]), [['w', 'ok'], ['sub1', 'ok'], ['sub2', 'missing']]);
  assert.ok(rs[2].error);
  assert.match(rs[1].date, /^\d{4}-\d\d-\d\d$/);
});

test('update：切到远端默认分支最新，拉不下来的保留旧版本标 stale', async () => {
  const head = commit(join(src, 'sub1'));
  const topHead = commit(join(src, 'top'));
  const done = finished();
  await R('update')({ workspace: 'w' }, ctx);
  await assert.rejects(R('update')({ workspace: 'w' }, ctx), /正在忙/);
  assert.ok((await done).ok);
  assert.equal(g(join(ws, 'repos/sub1'), 'rev-parse', 'HEAD'), head);
  assert.equal(g(ws, 'rev-parse', 'HEAD'), topHead); // 顶层停在 main 上，快进过去

  renameSync(join(src, 'sub1'), join(src, 'sub1-gone'));
  const r = await slow('update', { workspace: 'w' });
  renameSync(join(src, 'sub1-gone'), join(src, 'sub1'));
  assert.equal(r.ok, false);
  const sub1 = (await repos('w')).find((x) => x.name === 'sub1');
  assert.equal(sub1.state, 'stale');
  assert.ok(sub1.error && sub1.date);
  assert.equal(g(join(ws, 'repos/sub1'), 'rev-parse', 'HEAD'), head);
});

test('sections 只读存盘的结果；clone 完自动设成默认；use 把默认模板指过去', async () => {
  const checks = async () => (await sections(cfg))[0].checks;
  const c = await checks();
  assert.equal(c.find((x) => x.id === 'ws:w')?.detail?.startsWith('3 个仓库 · 缺 1 个 · 1 个没更新上'), true);
  // 默认模板原来没项目：第一个建出来的工作区（上面那个「订单」）自动成了默认，不用再点「用」；后拉的 w 不抢
  assert.equal(cfg.templates.通用.project, join(ROOT_DIR, '订单'));
  assert.equal(c.find((x) => x.id === 'in-use')?.state, 'ok');

  // 指到一个自己的目录（不是向导拉的）：目录在就算配好了
  cfg.templates.通用.project = home;
  assert.equal((await checks()).find((x) => x.id === 'in-use')?.state, 'ok');
  // 指的目录没了：没配好
  cfg.templates.通用.project = join(home, 'gone');
  assert.equal((await checks()).find((x) => x.id === 'in-use')?.state, 'missing');

  const pushed: any[] = [];
  const off = subscribe((m) => { if (m.type === 'config') pushed.push(m.config); });
  assert.deepEqual(await R('use')({ workspace: 'w' }, ctx), { ok: true });
  off();
  assert.equal(pushed[0]?.templates.通用.project, ws); // 页面上的配置快照跟着换
  assert.equal(cfg.templates.通用.project, ws);
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).templates.通用.project, ws);
  assert.equal((await checks()).find((x) => x.id === 'in-use')?.state, 'ok');
  assert.equal((await list()).workspaces.find((w: any) => w.name === 'w').inUse, true);
});

test('add-repo / remove-repo：只能删 repos/ 下自己加的', async () => {
  repo(join(src, 'extra'));
  assert.ok((await slow('add-repo', { workspace: 'w', url: url(join(src, 'extra')) })).ok);
  assert.equal((await repos('w')).find((r) => r.name === 'extra')?.state, 'ok');
  // 页面靠 removable 决定给不给「删除」按钮：跟下面 remove-repo 的拒绝规则一致
  const listed = (await list()).workspaces.find((w: any) => w.name === 'w').repos;
  assert.deepEqual(Object.fromEntries(listed.map((r: any) => [r.name, r.removable])), { ...Object.fromEntries(listed.map((r: any) => [r.name, false])), extra: true });

  await assert.rejects(R('remove-repo')({ workspace: 'w', repo: '../../w' }, ctx), /不合法/);
  await assert.rejects(R('remove-repo')({ workspace: 'w', repo: 'sub1' }, ctx), /子模块/);
  // repos/ 下一个指到外面的软链：真实路径不在 repos/ 里，不删
  const outside = mkdtempSync(join(tmpdir(), 'lcr-out-'));
  symlinkSync(outside, join(ws, 'repos', 'evil'), 'junction');
  await assert.rejects(R('remove-repo')({ workspace: 'w', repo: 'evil' }, ctx), /外面/);
  assert.ok(existsSync(outside));

  assert.deepEqual(await R('remove-repo')({ workspace: 'w', repo: 'extra' }, ctx), { ok: true });
  assert.ok(!existsSync(join(ws, 'repos', 'extra')));
  assert.ok(!(await repos('w')).some((r) => r.name === 'extra'));
});

test('add-existing：登记已有目录，不联网看一眼', async () => {
  const dir = join(home, 'mine');
  repo(dir);
  assert.deepEqual(await R('add-existing')({ path: dir }, ctx), { ok: true });
  assert.deepEqual((await repos('mine')).map((r) => [r.name, r.state]), [['mine', 'ok']]);
  await assert.rejects(R('add-existing')({ path: dir, name: 'again' }, ctx), /登记过/);
  // 项目下拉里选的 ~/ 路径也能登记
  repo(join(home, 'mine2'));
  const env = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = process.env.USERPROFILE = home;
  try { assert.deepEqual(await R('add-existing')({ path: '~/mine2' }, ctx), { ok: true }); } finally {
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  assert.equal((await repos('mine2'))[0].path, join(home, 'mine2'));
});

test('forget：项目下拉里 × 掉选过的目录，只是不列了、文件不动；向导拉的不让 × ', async () => {
  const dir = join(home, 'picked');
  mkdirSync(dir);
  await R('add-existing')({ path: dir }, ctx);
  const { workspaceList } = await import('./workspace.ts');
  assert.equal(workspaceList().find((w) => w.name === 'picked')?.managed, false);
  assert.deepEqual(await R('forget')({ workspace: 'picked' }, ctx), { ok: true });
  assert.equal(workspaceList().some((w) => w.name === 'picked'), false);
  assert.ok(existsSync(dir));
  await R('create')({ name: 'own' }, ctx);
  assert.equal(workspaceList().find((w) => w.name === 'own')?.managed, true);
  await assert.rejects(R('forget')({ workspace: 'own' }, ctx), /上手向导/);
});

test('老 git 的 submodule update 不认 --filter：退回完整 clone', { skip: process.platform === 'win32' }, async () => {
  const fake = join(home, 'old-git');
  writeFileSync(fake, '#!/bin/sh\ncase " $* " in *" --filter="*" submodule "*|*" submodule "*" --filter="*) echo "usage: git submodule [--quiet] [--cached]" >&2; exit 1;; esac\nexec git "$@"\n', { mode: 0o755 });
  process.env.LCR_GIT = fake;
  try {
    const { ok, msgs } = await slow('clone', { url: url(join(src, 'top')), name: 'w-old' });
    assert.ok(ok, msgs.join('\n'));
    assert.equal((await repos('w-old')).find((x) => x.name === 'sub1').state, 'ok', msgs.join('\n'));
  } finally {
    delete process.env.LCR_GIT;
  }
});
