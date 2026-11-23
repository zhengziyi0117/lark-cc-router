import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitEnv, gitTokens, setGitToken } from './git.ts';

test('没 token 就只关掉交互提示，SSH 原样走', () => {
  assert.deepEqual(gitEnv({}, false), { GIT_TERMINAL_PROMPT: '0' });
});

test('Windows：git 改用系统证书库（内网 GitLab 是公司自签的根证书）', () => {
  const env = { ...process.env, ...gitEnv({}, true) };
  assert.equal(execFileSync('git', ['config', '--get', 'http.sslBackend'], { env, encoding: 'utf8' }).trim(), 'schannel');
});

test('有 token：真 git 看得到 SSH → HTTPS 改写和认证头', () => {
  const env = { ...process.env, ...gitEnv({ 'git.example.com': 'tok' }, false) };
  const rewrites = execFileSync('git', ['config', '--get-all', 'url.https://git.example.com/.insteadOf'], { env, encoding: 'utf8' });
  assert.deepEqual(rewrites.trim().split('\n'), ['git@git.example.com:', 'ssh://git@git.example.com/']);
  const header = execFileSync('git', ['config', '--get', 'http.https://git.example.com/.extraHeader'], { env, encoding: 'utf8' });
  assert.equal(header.trim(), `Authorization: Basic ${Buffer.from('oauth2:tok').toString('base64')}`);
});

test('token 落盘是 0600，空 token = 删掉', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'lcr-git-')), 'cred.json');
  setGitToken('h', 't', p);
  assert.deepEqual(gitTokens(p), { h: 't' });
  if (process.platform !== 'win32') assert.equal(statSync(p).mode & 0o777, 0o600);
  setGitToken('h', '', p);
  assert.deepEqual(gitTokens(p), {});
});
