import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lock } from './app.ts';

test('同一份数据目录只能有一个在跑；崩了留下的锁不算数', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lcr-lock-'));
  // 别的进程拿着锁：拒
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
  writeFileSync(join(dir, 'run.pid'), String(other.pid));
  assert.throws(() => lock(dir), /已经有一个在跑了/);
  // 它死了（崩溃留下的锁）：接管，解锁后文件删掉
  other.kill('SIGKILL');
  await new Promise((r) => other.once('exit', r));
  const unlock = lock(dir);
  assert.ok(existsSync(join(dir, 'run.pid')));
  unlock();
  assert.ok(!existsSync(join(dir, 'run.pid')));
});
