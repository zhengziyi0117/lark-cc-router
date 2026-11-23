import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checksumOf, larkAsset, parseVersion, portableGitUrls, verify } from './tools.ts';

test('版本号：三个工具的真实 --version 输出', () => {
  assert.equal(parseVersion('lark-cli version 1.0.100\n'), '1.0.100');
  assert.equal(parseVersion('2.1.328 (Claude Code)\n'), '2.1.328');
  assert.equal(parseVersion('git version 2.39.5 (Apple Git-154)\n'), '2.39.5');
  assert.equal(parseVersion('git version 2.56.1.windows.1\r\n'), '2.56.1.windows.1');
  assert.equal(parseVersion('command not found'), undefined);
});

test('lark-cli 发布包：平台和架构 → 文件名、可执行文件名、下载地址', () => {
  const mac = larkAsset('1.0.100', 'darwin', 'arm64');
  assert.equal(mac.name, 'lark-cli-1.0.100-darwin-arm64.tar.gz');
  assert.equal(mac.exe, 'lark-cli');
  assert.deepEqual(mac.urls, [
    'https://registry.npmmirror.com/-/binary/lark-cli/v1.0.100/lark-cli-1.0.100-darwin-arm64.tar.gz',
    'https://github.com/larksuite/cli/releases/download/v1.0.100/lark-cli-1.0.100-darwin-arm64.tar.gz',
  ]);
  assert.equal(larkAsset('1.0.100', 'darwin', 'x64').name, 'lark-cli-1.0.100-darwin-amd64.tar.gz');
  const win = larkAsset('1.0.100', 'win32', 'x64');
  assert.equal(win.name, 'lark-cli-1.0.100-windows-amd64.zip');
  assert.equal(win.exe, 'lark-cli.exe');
  assert.throws(() => larkAsset('1.0.100', 'win32', 'ia32'), /没有 win32-ia32/);
});

test('checksums.txt：按文件名精确取，不会取到前缀相同的', () => {
  const txt = [
    `${'a'.repeat(64)}  lark-cli-1.0.100-darwin-arm64.tar.gz`,
    `${'b'.repeat(64)}  lark-cli-1.0.100-windows-amd64.zip`,
    `${'c'.repeat(64)}  lark-cli-1.0.100-windows-amd64.zip.sig`,
    '',
  ].join('\n');
  assert.equal(checksumOf(txt, 'lark-cli-1.0.100-windows-amd64.zip'), 'b'.repeat(64));
  assert.throws(() => checksumOf(txt, 'lark-cli-1.0.100-linux-amd64.tar.gz'), /没有/);
  assert.throws(() => checksumOf(`nothex  x.zip`, 'x.zip'), /没有/);
});

test('便携 git：镜像在前、GitHub 兜底，都指向同一个文件', () => {
  const urls = portableGitUrls({ tag: 'v2.56.1.windows.1', name: 'PortableGit-2.56.1-64-bit.7z.exe', sha256: '' });
  assert.deepEqual(urls, [
    'https://registry.npmmirror.com/-/binary/git-for-windows/v2.56.1.windows.1/PortableGit-2.56.1-64-bit.7z.exe',
    'https://github.com/git-for-windows/git/releases/download/v2.56.1.windows.1/PortableGit-2.56.1-64-bit.7z.exe',
  ]);
});

test('校验：对上才过，对不上 / 没给期望值都拒', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'lcr-tools-')), 'a.bin');
  writeFileSync(f, 'hello');
  const hex = createHash('sha256').update('hello').digest('hex');
  verify(f, 'sha256', hex.toUpperCase());
  const b64 = createHash('sha512').update('hello').digest('base64');
  verify(f, 'sha512', b64, 'base64');
  assert.throws(() => verify(f, 'sha512', b64.toLowerCase(), 'base64'), /校验没过/);
  assert.throws(() => verify(f, 'sha256', 'f'.repeat(64)), /校验没过/);
  assert.throws(() => verify(f, 'sha256', ''), /校验没过/);
});
