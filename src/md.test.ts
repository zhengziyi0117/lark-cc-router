import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { marked } from 'marked';

/*
 * 渲染器长在 page.html 里（就一个静态文件，没有构建步骤），所以这里把它那一段抠出来跑。
 * 抠的是 `const TAG_MAP =` 到 SSE 段之间 —— 正好是 TAG_MAP/cardTag/marked.use/mdNode。
 */
const html = readFileSync(resolve(import.meta.dirname, 'page.html'), 'utf8');
const src = html.slice(html.indexOf('const TAG_MAP ='), html.indexOf('/* ---------- SSE ---------- */'));
assert.ok(src.includes('marked.use'), '没从 page.html 里抠到渲染器，锚点是不是变了？');

const fakeEl = (tag: string, cls?: string, text?: string) =>
  ({ tag, className: cls || '', innerHTML: text ?? '' }) as any;

// 页面里 marked 是 /vendor/marked.js 挂上来的全局；这里换成 node 版的同一个库
const { mdNode } = new Function('el', 'marked', `${src}\nreturn { mdNode };`)(fakeEl, marked) as {
  mdNode: (s: string, size?: string) => { innerHTML: string };
};
const render = (md: string) => mdNode(md).innerHTML;

test('块级交给 marked：标题、嵌套列表、表格、围栏代码', () => {
  assert.equal(render('## 判定路径'), '<h2>判定路径</h2>\n');
  assert.match(render('- 甲\n  - 甲一\n- 乙'), /<ul>\n<li>甲<ul>\n<li>甲一<\/li>\n<\/ul>\n<\/li>\n<li>乙<\/li>/);
  assert.match(render('| a | b |\n|---|---|\n| 1 | 2 |'), /<table>[\s\S]*<th>a<\/th>[\s\S]*<td>1<\/td>/);
  assert.match(render('```java\nint a = 1; // **x**\n```'), /<pre><code class="language-java">int a = 1; \/\/ \*\*x\*\*/);
});

test('行内交给 marked：粗体、行内代码、链接', () => {
  assert.equal(render('**粗**').trim(), '<p><strong>粗</strong></p>');
  assert.equal(render('`a**b**`').trim(), '<p><code>a**b**</code></p>');
  assert.match(render('[文档](https://x.com/a)'), /<a href="https:\/\/x\.com\/a">文档<\/a>/);
});

/*
 * 这条是重点：正文是模型输出，模型是被群消息牵着走的。页面背后是 POST /api/config 和
 * /api/run（全权限跑 CC），一句 <img onerror> 就能把"群里随便谁 @ 一下"升级成"改你的配置"。
 */
test('裸 HTML 一律吞掉 —— 别让模型输出在这页面上跑起脚本来', () => {
  for (const payload of [
    '<img src=x onerror="alert(1)">',
    '<script>alert(1)</script>',
    '<iframe src="https://evil.example"></iframe>',
    '正常文字\n\n<div onclick="alert(1)">块级</div>',
  ]) {
    const out = render(payload);
    for (const bad of ['onerror', '<script', '<iframe', 'onclick', '<img', '<div']) {
      assert.ok(!out.includes(bad), `${JSON.stringify(payload)} 漏出了 ${bad}：${out}`);
    }
  }
});

test('链接 / 图片只放行 http(s) / mailto —— javascript: 一点就能调 /api/config', () => {
  for (const payload of ['[看日志](javascript:alert(1))', '[x]( JavaScript:alert(1))', '<javascript:alert(1)>', '![a](javascript:alert(1))']) {
    const out = render(payload);
    assert.ok(!/href=|src=/.test(out), `${payload} 漏出了链接：${out}`);
  }
  assert.match(render('[看日志](javascript:alert(1))'), /看日志/, '文字留着，只是不可点');
  assert.match(render('[mail](mailto:a@b.com)'), /href="mailto:a@b\.com"/);
  assert.match(render('![图](https://x.com/a.png)'), /<img src="https:\/\/x\.com\/a\.png"/);
});

test('卡片自己拼的 font / text_tag 照旧放行 —— 那是我发的，不是用户内容', () => {
  assert.equal(render("<font color='red'>红</font>").trim(), '<p><span style="color:#F54A45">红</span></p>');
  assert.match(render("<text_tag color='red'>紧急</text_tag>"), /<span style="background:#FBE7E5/);
});
