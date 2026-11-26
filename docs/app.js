(() => {
  const REPO = 'zhengziyi0117/lark-cc-router';
  const FALLBACK_VERSION = 'v0.2.13';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Theme Toggle ---------- */
  const root = document.documentElement;
  const themeBtn = document.getElementById('themeToggle');
  const themeIcon = document.getElementById('themeIcon');

  function effectiveTheme() {
    const saved = localStorage.getItem('lcr_site_theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(mode, persist = false) {
    root.setAttribute('data-theme', mode);
    if (persist) localStorage.setItem('lcr_site_theme', mode);
    if (!themeIcon) return;
    themeIcon.innerHTML = mode === 'dark'
      ? '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>'
      : '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path>';
  }

  applyTheme(effectiveTheme(), false);
  themeBtn?.addEventListener('click', () => {
    applyTheme(effectiveTheme() === 'dark' ? 'light' : 'dark', true);
  });

  /* ---------- Header Scroll Separation + Reading Progress ---------- */
  const siteNav = document.getElementById('siteNav');
  const scrollProgress = document.getElementById('scrollProgress');

  function onScroll() {
    const y = window.scrollY;
    siteNav?.setAttribute('data-scrolled', String(y > 12));
    if (scrollProgress) {
      const h = document.documentElement.scrollHeight - window.innerHeight;
      const pct = h > 0 ? Math.min(100, Math.max(0, (y / h) * 100)) : 0;
      scrollProgress.style.width = `${pct}%`;
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- Interactive Hero Workbench (Scenario + Claude/Codex Switch) ---------- */
  let currentScene = 'answer';
  let currentEngine = 'claude';
  let timers = [];
  let streamInterval = null;

  const simFeishu = document.getElementById('simFeishu');
  const simTrace = document.getElementById('simTrace');
  const wbEngineMeta = document.getElementById('wbEngineMeta');
  const wbStatusMeta = document.getElementById('wbStatusMeta');

  function engineInfo() {
    return currentEngine === 'codex'
      ? { name: 'Codex CLI', model: 'codex-app-server · 只读模式', tool: 'shell_exec', toolArg: 'rg "callbackIdempotency" src/order/' }
      : { name: 'Claude Code', model: 'claude-opus · 只读模式', tool: 'Grep', toolArg: '"callbackIdempotency" src/order/' };
  }

  function buildScene(key) {
    const eng = engineInfo();

    if (key === 'answer') {
      return {
        sender: '林舟',
        avatar: '林',
        avatarBg: '#4C647A',
        time: '14:22',
        message: '<span class="mention">@你</span> 帮我看下订单回调为什么没更新状态，测试单号 <code>TEST-1001</code>，是不是幂等校验拦掉了？',
        steps: [
          {
            delay: 100,
            progress: 18,
            status: '正在判定',
            trace: { at: '0.0s', cls: 'judge', verb: 'judge', arg: 'mode=plan', desc: '判定：要回，包含明确单号与代码查询诉求。' },
            feishu: '<div class="lark-thread"><div class="silent-note"><strong>尚未建话题</strong>先做轻量判定，确认需要回复后再发出第一张卡片。</div></div>'
          },
          {
            delay: 680,
            progress: 48,
            status: `调用本机 ${eng.name}`,
            trace: { at: '1.1s', cls: 'think', verb: 'thinking', arg: eng.model, desc: '复用本机仓库与已授权 MCP 工具定位回调逻辑。' },
            feishu: `
              <div class="lark-thread">
                <div class="lark-card">
                  <div class="lark-card-head">
                    <strong>正在查询</strong>
                    <span>${eng.name} · 本人身份</span>
                  </div>
                  <div class="lark-card-body">
                    <div class="lark-card-quote">正在检索订单回调处理逻辑与幂等校验...</div>
                    <p>已定位相关模块，正在核对代码路径<span class="stream-cursor"></span></p>
                  </div>
                </div>
              </div>`
          },
          {
            delay: 1380,
            progress: 78,
            status: '读取代码与日志',
            trace: { at: '2.4s', cls: 'tool', verb: eng.tool, arg: eng.toolArg, desc: '命中 src/order/callback.ts:84 与 src/order/store.ts:41。' },
            feishu: `
              <div class="lark-thread">
                <div class="lark-card">
                  <div class="lark-card-head">
                    <strong>正在查询</strong>
                    <span>已调用 ${eng.tool} · MCP 日志</span>
                  </div>
                  <div class="lark-card-body">
                    <div class="lark-card-quote">已读取 <code>src/order/callback.ts:84</code> 与单号记录</div>
                    <p id="streamDraft"></p>
                  </div>
                </div>
              </div>`,
            streamText: '确认和幂等校验有关：首次回调写入锁后下游超时回滚，但幂等键未清理，导致重试请求全部被直接忽略。'
          },
          {
            delay: 2420,
            progress: 100,
            status: '已完成 · Session 已绑定',
            trace: { at: '5.8s', cls: 'ok', verb: 'done', arg: 'session=9a4f2c', desc: '已绑定话题锚点，点击左侧「继续追问」可直接续接上下文。' },
            feishu: `
              <div class="lark-thread">
                <div class="lark-card">
                  <div class="lark-card-head ok">
                    <strong>已完成</strong>
                    <span>${eng.name} · 5.8s</span>
                  </div>
                  <div class="lark-card-body">
                    <p><strong>结论：</strong><code>TEST-1001</code> 卡在 <code>src/order/callback.ts:84</code> 的幂等拦截。首次回调写入锁后下游超时回滚，幂等键未清理（TTL 30m），重试返回 <code>200 ignored</code>。</p>
                    <p><strong>建议：</strong>事务提交后再写幂等键，或允许 <code>PENDING</code> 状态重入。</p>
                  </div>
                  <div class="lark-card-foot">
                    <span>话题已绑定 session=9a4f2c</span>
                    <button type="button" class="followup-btn" id="triggerFollowup">在话题里继续追问</button>
                  </div>
                </div>
              </div>`
          }
        ]
      };
    }

    if (key === 'skip') {
      return {
        sender: '周明',
        avatar: '周',
        avatarBg: '#5B7058',
        time: '18:05',
        message: '<span class="mention">@你</span> <span class="mention">@所有人</span> 大家辛苦了，今天的发布窗口已经全部结束，谢谢配合。',
        steps: [
          {
            delay: 120,
            progress: 40,
            status: '正在判定',
            trace: { at: '0.0s', cls: 'judge', verb: 'judge', arg: '无工具轻量判定', desc: '识别为常规结束通知，无需查询也无需回复。' },
            feishu: '<div class="lark-thread"><div class="silent-note"><strong>尚未建话题</strong>正在判断是否需要回复...</div></div>'
          },
          {
            delay: 900,
            progress: 100,
            status: '判断不用回 · 群里零痕迹',
            trace: { at: '0.7s', cls: 'ok', verb: 'skip', arg: '未启动代理 · 未发卡片', desc: '跳过理由仅记录在本机控制台，群里不留任何消息。' },
            feishu: '<div class="lark-thread"><div class="silent-note"><strong>判断不用回</strong>群里保持安静，不发卡片也不打扰大家。</div></div>'
          }
        ]
      };
    }

    if (key === 'ask_me') {
      return {
        sender: '陈可',
        avatar: '陈',
        avatarBg: '#83644B',
        time: '15:40',
        message: '<span class="mention">@你</span> 下个迭代的支付重构方案，你预计周五前能评审完吗？',
        steps: [
          {
            delay: 120,
            progress: 40,
            status: '正在判定',
            trace: { at: '0.0s', cls: 'judge', verb: 'judge', arg: '无工具轻量判定', desc: '涉及个人排期与主观承诺，不应在群里代答。' },
            feishu: '<div class="lark-thread"><div class="silent-note"><strong>尚未建话题</strong>正在判断是否需要本人介入...</div></div>'
          },
          {
            delay: 940,
            progress: 100,
            status: '已私聊转交本人',
            trace: { at: '0.9s', cls: 'judge', verb: 'ask_me', arg: '私聊通知本人', desc: '已私聊发提醒给你本人并附原消息链接，群里保持静默。' },
            feishu: `
              <div class="lark-thread">
                <div class="lark-card">
                  <div class="lark-card-head dm">
                    <strong>已私聊转交给你本人</strong>
                    <span>仅你可见</span>
                  </div>
                  <div class="lark-card-body">
                    <p>陈可在「项目研发群」询问评审排期。需要你本人拍板的事不会在群里代答。</p>
                  </div>
                  <div class="lark-card-foot">
                    <span>判定：ask_me · 群里零回复</span>
                    <span>直达原消息</span>
                  </div>
                </div>
              </div>`
          }
        ]
      };
    }

    return {
      sender: '林舟',
      avatar: '林',
      avatarBg: '#4C647A',
      time: '14:26',
      message: '<span class="mention">@你</span> 不用查了，停止处理，刚确认是测试环境配置漏配了。',
      steps: [
        {
          delay: 100,
          progress: 30,
          status: '任务运行中',
          trace: { at: '0.0s', cls: 'tool', verb: 'Bash', arg: 'git log -n 20 --oneline', desc: `本机 ${eng.name} 正在执行（session=9a4f2c）。` },
          feishu: `
            <div class="lark-thread">
              <div class="lark-card">
                <div class="lark-card-head">
                  <strong>正在查询</strong>
                  <span>${eng.name} 运行中</span>
                </div>
                <div class="lark-card-body">
                  <p>正在比对最近 20 次提交记录与测试环境配置<span class="stream-cursor"></span></p>
                </div>
              </div>
            </div>`
        },
        {
          delay: 860,
          progress: 70,
          status: '收到叫停指令',
          trace: { at: '0.8s', cls: 'judge', verb: 'stop', arg: '命中锚点 session=9a4f2c', desc: '立即向本地代理发送中止信号并更新原卡片。' },
          feishu: `
            <div class="lark-thread">
              <div class="lark-card dim">
                <div class="lark-card-head stop">
                  <strong>已中断</strong>
                  <span>收到叫停指令</span>
                </div>
                <div class="lark-card-body">
                  <p>已终止本次任务并释放并发名额，不再继续消耗 token。</p>
                </div>
              </div>
            </div>`
        },
        {
          delay: 1400,
          progress: 100,
          status: '已中断',
          trace: { at: '1.1s', cls: 'bad', verb: 'aborted', arg: 'pool 释放 1/3', desc: '原卡片已收尾为「已中断」。' }
        }
      ]
    };
  }

  function clearTimers() {
    timers.forEach((id) => clearTimeout(id));
    timers = [];
    if (streamInterval) {
      clearInterval(streamInterval);
      streamInterval = null;
    }
  }

  function renderFeishuBase(scene, extraHtml = '') {
    simFeishu.innerHTML = `
      <div class="lark-msg">
        <div class="avatar" style="background:${scene.avatarBg}">${scene.avatar}</div>
        <div class="msg-body">
          <div class="msg-meta"><strong>${scene.sender}</strong><span>${scene.time}</span></div>
          <div class="bubble">${scene.message}</div>
        </div>
      </div>
      ${extraHtml}
    `;
    document.getElementById('triggerFollowup')?.addEventListener('click', playFollowup);
  }

  function typeStreamText(el, fullText) {
    if (!el) return;
    if (reducedMotion) {
      el.textContent = fullText;
      return;
    }
    let idx = 0;
    const step = () => {
      idx += 3;
      el.innerHTML = `${fullText.slice(0, idx)}<span class="stream-cursor"></span>`;
      if (idx >= fullText.length) {
        clearInterval(streamInterval);
        streamInterval = null;
      }
    };
    step();
    streamInterval = setInterval(step, 38);
  }

  function appendTrace(t) {
    const el = document.createElement('div');
    el.className = `trace-ev ${t.cls}`;
    el.innerHTML = `
      <span class="trace-at">${t.at}</span>
      <div class="trace-head">
        <span class="trace-verb">${t.verb}</span>
        <span class="trace-arg">${t.arg}</span>
      </div>
      <div class="trace-desc">${t.desc}</div>
    `;
    simTrace.appendChild(el);
    requestAnimationFrame(() => el.classList.add('show'));
  }

  function playFollowup() {
    clearTimers();
    document.getElementById('triggerFollowup')?.remove();
    const eng = engineInfo();
    const thread = simFeishu.querySelector('.lark-thread');
    if (!thread) return;

    wbStatusMeta.textContent = '续上 session=9a4f2c';
    const followMsg = document.createElement('div');
    followMsg.className = 'lark-msg';
    followMsg.innerHTML = `
      <div class="avatar" style="background:#4C647A">林</div>
      <div class="msg-body">
        <div class="msg-meta"><strong>林舟</strong><span>14:24</span></div>
        <div class="bubble"><span class="mention">@你</span> 需要同步补单测吗？帮我看下测试文件。</div>
      </div>
    `;
    thread.appendChild(followMsg);

    appendTrace({ at: '0.0s', cls: 'judge', verb: 'resume', arg: '--resume 9a4f2c', desc: '命中原话题锚点，直接续接上轮上下文。' });

    const replyCard = document.createElement('div');
    replyCard.className = 'lark-card';
    replyCard.innerHTML = `
      <div class="lark-card-head"><strong>正在续问</strong><span>${eng.name}</span></div>
      <div class="lark-card-body"><p id="followupStream"></p></div>
    `;
    thread.appendChild(replyCard);
    typeStreamText(document.getElementById('followupStream'), '已查看 src/order/callback.test.ts，补充一条回滚后允许重入的用例即可。');

    timers.push(setTimeout(() => {
      wbStatusMeta.textContent = '追问已完成 · 2 轮对话';
      appendTrace({ at: '1.9s', cls: 'ok', verb: 'done', arg: 'src/order/callback.test.ts', desc: '两轮对话已在控制台按同一 Session 聚合。' });
      replyCard.innerHTML = `
        <div class="lark-card-head ok"><strong>已完成</strong><span>续接 session=9a4f2c · 1.9s</span></div>
        <div class="lark-card-body"><p>在 <code>src/order/callback.test.ts:112</code> 已有幂等跳过用例，新增一条「事务回滚后 <code>PENDING</code> 重试成功」即可覆盖。</p></div>
      `;
    }, 1300));
  }

  function playScene(key) {
    clearTimers();
    currentScene = key;
    const scene = buildScene(key);

    document.querySelectorAll('[data-scene]').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.scene === key));
    });
    document.querySelectorAll('[data-engine]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.engine === currentEngine));
    });

    wbEngineMeta.textContent = `执行器：本机 ${engineInfo().name}`;
    simTrace.innerHTML = '<div class="trace-progress" id="traceProgress" aria-hidden="true"></div>';
    const traceProgress = document.getElementById('traceProgress');
    renderFeishuBase(scene);

    scene.steps.forEach((step) => {
      timers.push(setTimeout(() => {
        if (step.status) wbStatusMeta.textContent = step.status;
        if (traceProgress && typeof step.progress === 'number') {
          traceProgress.style.height = `calc(${step.progress}% - 16px)`;
        }
        if (step.feishu) {
          renderFeishuBase(scene, step.feishu);
          if (step.streamText) {
            typeStreamText(document.getElementById('streamDraft'), step.streamText);
          }
        }
        if (step.trace) appendTrace(step.trace);
      }, step.delay));
    });
  }

  document.querySelectorAll('[data-scene]').forEach((btn) => {
    btn.addEventListener('click', () => playScene(btn.dataset.scene));
  });
  document.querySelectorAll('[data-engine]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentEngine = btn.dataset.engine;
      playScene(currentScene);
    });
  });
  document.getElementById('simReplay')?.addEventListener('click', () => playScene(currentScene));
  playScene('answer');

  /* ---------- Band 1: Local Reuse Visual Switcher (Claude Code / Codex CLI) ---------- */
  const REUSE_DATA = {
    claude: {
      srcTitle: '你本机的 Claude Code',
      srcPath: '~/.claude',
      bridge: '一键同步',
      dstTitle: 'lark-cc-router',
      dstPath: '飞书自动答复',
      items: [
        ['MCP 服务器', '直接复用本机已接好的数据库、日志与文档工具，掉线自动私聊提醒'],
        ['Plugins 与 Skills', '一键同步已装插件市场、Skills、子代理与自定义命令'],
        ['CLAUDE.md 与 Hooks', '原样继承你写好的项目约定、提示词与 hooks 配置'],
        ['多 API 来源容灾', '同时配公司网关与个人订阅，遇限流或额度耗尽自动切换']
      ]
    },
    codex: {
      srcTitle: '你本机的 Codex CLI',
      srcPath: 'codex app-server',
      bridge: '直接连接',
      dstTitle: 'lark-cc-router',
      dstPath: '飞书自动答复',
      items: [
        ['沿用本机登录态', '直接连已运行的 Codex App Server，无需重新登录或导密钥'],
        ['MCP 与插件状态', '沿用本机 Codex 里的 MCP 与插件开关，改完即时生效'],
        ['按模板选模型强度', '不同群可独立指定 Codex 模型与推理强度，互不干扰'],
        ['统一三档权限', '与 Claude Code 相同的只读 / 可改 / 全放开边界，默认只读']
      ]
    }
  };

  const reuseVisual = document.getElementById('reuseVisual');
  function renderReuse(key) {
    const d = REUSE_DATA[key];
    if (!d || !reuseVisual) return;
    document.querySelectorAll('[data-reuse]').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.reuse === key));
    });
    reuseVisual.innerHTML = `
      <div class="bridge-top">
        <div class="bridge-node"><strong>${d.srcTitle}</strong><span>${d.srcPath}</span></div>
        <div class="bridge-arrow">${d.bridge}</div>
        <div class="bridge-node" style="text-align:right"><strong>${d.dstTitle}</strong><span>${d.dstPath}</span></div>
      </div>
      <ul class="bridge-items">
        ${d.items.map(([k, v]) => `<li><span class="bridge-k">${k}</span><span class="bridge-v">${v}</span></li>`).join('')}
      </ul>
    `;
  }

  document.querySelectorAll('[data-reuse]').forEach((btn) => {
    btn.addEventListener('click', () => renderReuse(btn.dataset.reuse));
  });
  renderReuse('claude');

  /* ---------- Band 2: Interactive Dark-Ink Visual Mechanism Stage ---------- */
  const SHOWCASE = {
    judge: `
      <div class="vis-list">
        <div class="vis-row">
          <span class="vis-in">「帮我查一下订单 TEST-1001 为什么没更新」</span>
          <span class="vis-arr">→</span>
          <span class="vis-out ok">要回 · 启动本机代理</span>
        </div>
        <div class="vis-row">
          <span class="vis-in">「大家辛苦了，今天发布已全部结束」</span>
          <span class="vis-arr">→</span>
          <span class="vis-out skip">不用回 · 群里零痕迹</span>
        </div>
        <div class="vis-row">
          <span class="vis-in">「这个重构方案你预计周五能评审吗」</span>
          <span class="vis-arr">→</span>
          <span class="vis-out run">转给我 · 私聊提醒本人</span>
        </div>
        <div class="vis-row">
          <span class="vis-in">「不用查了，停止处理」</span>
          <span class="vis-arr">→</span>
          <span class="vis-out bad">叫停 · 立即中止任务</span>
        </div>
      </div>`,

    session: `
      <div class="vis-thread">
        <div class="vis-turn">
          <div class="vis-turn-head"><strong>第 1 轮 · 群里原消息</strong><span>自动绑定 session=9a4f2c</span></div>
          <p>「@你 看下这个报错页面为什么一直转圈？」</p>
          <span class="vis-img-chip">附件已下载 · error-screenshot.png → 送给模型查看</span>
        </div>
        <div class="vis-turn">
          <div class="vis-turn-head"><strong>第 2 轮 · 原话题继续 @ 或私聊引用卡片</strong><span>自动 --resume 接棒</span></div>
          <p>「那帮我顺便看下重试次数是在哪配的？」</p>
          <span class="vis-img-chip">若上一轮还在跑，自动中断旧轮次再无缝往下查</span>
        </div>
      </div>`,

    entry: `
      <div class="vis-compare">
        <div class="vis-col is-default">
          <h3>@我（默认开启）</h3>
          <dl class="vis-kv">
            <div><dt>是否拉机器人</dt><dd>不需要，零侵入</dd></div>
            <div><dt>回复身份</dt><dd>你本人</dd></div>
            <div><dt>响应速度</dt><dd>分钟级（索引搜索）</dd></div>
            <div><dt>卡片方式</dt><dd>1.2s 原地整卡刷新</dd></div>
          </dl>
        </div>
        <div class="vis-col">
          <h3>@机器人（按需开启）</h3>
          <dl class="vis-kv">
            <div><dt>接入方式</dt><dd>事件长连接推送</dd></div>
            <div><dt>回复身份</dt><dd>机器人</dd></div>
            <div><dt>响应速度</dt><dd>秒级直达</dd></div>
            <div><dt>卡片方式</dt><dd>CardKit 打字机流式</dd></div>
          </dl>
        </div>
      </div>`,

    guard: `
      <div class="vis-guards">
        <div class="vis-guard">
          <strong>白名单默认全关</strong>
          <span>只有在控制台主动打开「自动回」的群或私聊才会响应。</span>
        </div>
        <div class="vis-guard">
          <strong>新建模板默认只读</strong>
          <span>默认使用 <code>plan</code> 模式，只查代码和工具，不改本机文件。</span>
        </div>
        <div class="vis-guard">
          <strong>控制台仅监听 127.0.0.1</strong>
          <span>校验 Host 与 Origin，防跨站请求与 DNS Rebinding。</span>
        </div>
        <div class="vis-guard">
          <strong>凭据不下发前端</strong>
          <span>配置文件 <code>0600</code> 权限，网关 Token 永不暴露到网页。</span>
        </div>
      </div>`
  };

  const showcaseCanvas = document.getElementById('showcaseCanvas');
  function renderShowcase(key) {
    if (!SHOWCASE[key] || !showcaseCanvas) return;
    document.querySelectorAll('[data-sc]').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.sc === key));
    });
    showcaseCanvas.innerHTML = SHOWCASE[key];
  }

  document.querySelectorAll('[data-sc]').forEach((btn) => {
    btn.addEventListener('click', () => renderShowcase(btn.dataset.sc));
  });
  renderShowcase('judge');

  /* ---------- Lightbox Preview ---------- */
  const shotTrigger = document.getElementById('shotTrigger');
  const lightbox = document.getElementById('lightbox');
  const lightboxClose = document.getElementById('lightboxClose');

  function openLightbox() {
    if (!lightbox) return;
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeLightbox() {
    if (!lightbox) return;
    lightbox.hidden = true;
    document.body.style.overflow = '';
  }

  shotTrigger?.addEventListener('click', openLightbox);
  lightboxClose?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeLightbox();
  });
  lightbox?.addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox && !lightbox.hidden) closeLightbox();
  });

  /* ---------- Quick Start Tabs & Copy ---------- */
  document.querySelectorAll('[data-qs]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.qs;
      document.querySelectorAll('[data-qs]').forEach((b) => {
        b.setAttribute('aria-selected', String(b === btn));
      });
      document.getElementById('qs-desktop').hidden = target !== 'desktop';
      document.getElementById('qs-cli').hidden = target !== 'cli';
    });
  });

  document.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const pre = document.getElementById(btn.dataset.copy);
      if (!pre) return;
      try {
        await navigator.clipboard.writeText(pre.innerText.trim());
        const orig = btn.textContent;
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = orig; }, 1600);
      } catch {
        btn.textContent = '请手动复制';
      }
    });
  });

  /* ---------- OS Detection & Latest GitHub Release ---------- */
  const ua = navigator.userAgent || '';
  const isWin = /Windows/i.test(ua);
  const isMac = /Mac OS X|Macintosh/i.test(ua) && !/iPhone|iPad/i.test(ua);

  const heroBtn = document.getElementById('heroDownloadBtn');
  const heroLabel = document.getElementById('heroDownloadLabel');
  const macLink = document.getElementById('dlMacLink');
  const winLink = document.getElementById('dlWinLink');
  const macFile = document.getElementById('dlMacFile');
  const winFile = document.getElementById('dlWinFile');

  if (isWin) {
    winLink?.classList.replace('btn-outline', 'btn-primary');
    macLink?.classList.replace('btn-primary', 'btn-outline');
    if (heroLabel) heroLabel.textContent = '下载 Windows 桌面版';
  } else if (isMac) {
    if (heroLabel) heroLabel.textContent = '下载 macOS 桌面版';
  }

  function setVersionLabels(tag) {
    document.querySelectorAll('[data-version]').forEach((el) => {
      el.textContent = tag;
    });
  }

  async function hydrateLatestRelease() {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!res.ok) return;
      const data = await res.json();
      const tag = data.tag_name || FALLBACK_VERSION;
      setVersionLabels(tag);

      const assets = Array.isArray(data.assets) ? data.assets : [];
      const dmg = assets.find((a) => /-arm64\.dmg$/i.test(a.name));
      const exe = assets.find((a) => /-Setup-[\d.]+\.exe$/i.test(a.name) || /\.exe$/i.test(a.name));

      if (dmg && macLink) {
        macLink.href = dmg.browser_download_url;
        if (macFile) macFile.textContent = `${dmg.name} · ${(dmg.size / 1048576).toFixed(1)} MB · 菜单栏常驻与后台静默更新`;
        if (isMac && heroBtn) heroBtn.href = dmg.browser_download_url;
      }
      if (exe && winLink) {
        winLink.href = exe.browser_download_url;
        if (winFile) winFile.textContent = `${exe.name} · ${(exe.size / 1048576).toFixed(1)} MB · 免管理员一键安装`;
        if (isWin && heroBtn) heroBtn.href = exe.browser_download_url;
      }
    } catch {
      // Fallback links point directly to /releases/latest
    }
  }

  hydrateLatestRelease();

  /* ---------- Calibrated Scroll Reveal ---------- */
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reducedMotion) {
    reveals.forEach((el) => {
      if (el.getBoundingClientRect().top < window.innerHeight * 0.98) {
        el.classList.add('in');
      }
    });
    document.documentElement.classList.add('reveal-ready');
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.05, rootMargin: '0px 0px -12px 0px' });
    reveals.forEach((el) => {
      if (!el.classList.contains('in')) io.observe(el);
    });
  } else {
    reveals.forEach((el) => el.classList.add('in'));
  }
})();
