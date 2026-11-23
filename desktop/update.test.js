import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assetFor, download, newer } from './update.js';

test('newer：按数字比，不按字符串', () => {
  assert.equal(newer('v0.2.10', '0.2.9'), true);
  assert.equal(newer('v0.3.0', '0.2.9'), true);
  assert.equal(newer('v0.2.6', '0.2.6'), false);
  assert.equal(newer('v0.2.5', '0.2.6'), false);
});

test('assetFor：按平台挑包，没有就 undefined', () => {
  const assets = [{ name: 'lark-cc-router-0.2.7-arm64.dmg' }, { name: 'lark-cc-router-Setup-0.2.7.exe' }, { name: 'x.exe.blockmap' }];
  assert.equal(assetFor(assets, 'darwin').name, 'lark-cc-router-0.2.7-arm64.dmg');
  assert.equal(assetFor(assets, 'win32').name, 'lark-cc-router-Setup-0.2.7.exe');
  assert.equal(assetFor(assets, 'linux'), undefined);
});

test('download：大小、sha256 都对上才落盘', async () => {
  const body = Buffer.from('new version');
  const srv = createServer((_q, r) => r.end(body)).listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const url = `http://127.0.0.1:${srv.address().port}/pkg`;
  const dir = join(mkdtempSync(join(tmpdir(), 'lcr-upd-')), 'dl');
  const sha256 = createHash('sha256').update(body).digest('hex');
  try {
    await assert.rejects(download({ url, name: 'a.dmg', size: body.length, sha256: '00' }, dir), /sha256/);
    await assert.rejects(download({ url, name: 'a.dmg', size: body.length + 1, sha256 }, dir), /不完整/);
    assert.equal(readFileSync(await download({ url, name: 'a.dmg', size: body.length, sha256 }, dir), 'utf8'), 'new version');
  } finally {
    srv.close();
  }
});
