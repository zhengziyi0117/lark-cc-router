import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowed, publicTemplate } from './web.ts';

const H = 'http://127.0.0.1:8787';
const host = { host: '127.0.0.1:8787' };

test('本机页面自己的请求放行', () => {
  assert.equal(allowed('GET', host), true, '同源 GET 可能不带 Origin');
  assert.equal(allowed('GET', { host: 'localhost:8787' }), true);
  assert.equal(allowed('POST', { ...host, origin: H, 'content-type': 'application/json' }), true);
  assert.equal(allowed('POST', { ...host, 'content-type': 'application/json' }), true, 'curl 不带 Origin');
});

test('别的网页打过来一律拒 —— 不然随便一个页面就能跑 CC、改权限', () => {
  assert.equal(allowed('POST', { ...host, origin: 'https://evil.example', 'content-type': 'application/json' }), false);
  assert.equal(allowed('POST', { ...host, 'content-type': 'text/plain' }), false, 'text/plain 不触发预检，是跨站的标准姿势');
  assert.equal(allowed('POST', { ...host, origin: 'null', 'content-type': 'application/json' }), false, 'sandbox iframe');
  assert.equal(allowed('GET', { host: 'evil.example:8787' }), false, 'DNS rebinding');
  assert.equal(allowed('GET', { ...host, origin: 'http://localhost:8787' }), false, '跟 Host 不同源');
});

test('模板下发到页面时网关不带 token，只说有没有', () => {
  const p = publicTemplate({ project: '~/p', gateway: { baseUrl: 'http://a', token: 'secret' } });
  assert.deepEqual(p, { project: '~/p', gateway: { baseUrl: 'http://a', hasToken: true } });
  assert.ok(!JSON.stringify(p).includes('secret'));
  assert.deepEqual(publicTemplate({ project: '~/p' }), { project: '~/p' }, '没网关就别凭空多一个键');
});
