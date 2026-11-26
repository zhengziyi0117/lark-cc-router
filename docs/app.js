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
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
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

  /* ---------- Interactive Workbench Simulator ---------- */
  let currentScene = 'answer';
  let currentEntry = 'user';
  let timers = [];
  let streamInterval = null;

  const simFeishu = document.getElementById('simFeishu');
  const simTrace = document.getElementById('simTrace');
  const wbEntryMeta = document.getElementById('wbEntryMeta');
  const wbStatusMeta = document.getElementById('wbStatusMeta');

  function entryMention() {
    return currentEntry === 'bot' ? '@代码助手' : '@你';
  }

  function entryIdentityLabel() {
    return currentEntry === 'bot' ? '以机器人身份 · CardKit 流式' : '以你本人身份 · 1.2s 刷新';
  }

  function buildScene(key) {
    const who = entryMention();
    const idLabel = entryIdentityLabel();

    if (key === 'answer') {
      return {
        sender: '林舟',
        avatar: '林',
        avatarBg: '#4C647A',
        time: '14:22',
        message: `<span class="mention">${who}</span> 帮我看下订单回调为什么没更新状态，测试单号 <code>TEST-1001</code>，是不是幂等校验拦掉了？`,
        steps: [
          {
            delay: 100,
            progress: 18,
            status: '正在判定要不要回',
            trace: { at: '0.0s', cls: 'judge', verb: 'judge', arg: 'mode=plan · haiku', desc: '判定结果：要回，包含明确单号与代码查询诉求。' },
            feishu: currentEntry === 'bot'
              ? `<div class="lark-thread"><div class="lark-card"><div class="lark-card-head"><strong>正在查询</strong><span>${idLabel}</span></div><div class="lark-card-body"><p>已收到问题，正在检索仓库代码<span class="stream-cursor"></span></p></div></div></div>`
              : `<div class="lark-thread"><div class="silent-note"><strong>尚未建话题</strong>先做轻量判定，确认需要排查后再发出第一张卡片。</div></div>`
          },
          {
            delay: 680,
            progress: 48,
            status: '正在读取仓库',
            trace: { at: '1.1s', cls: 'think', verb: 'thinking', arg: 'claude-opus · 只读模式', desc: '定位订单回调入口与幂等键写入时机。' },
            feishu: `
              <div class="lark-thread">
                <div class="lark-card">
                  <div class="lark-card-head">
                    <strong>正在查询</strong>
                    <span>${idLabel}</span>
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
            status: '调用本地工具',
            trace: { at: '2.4s', cls: 'tool', verb: 'Grep', arg: '"callbackIdempotency" src/order/', desc: '命中 src/order/callback.ts:84 与 src/order/store.ts:41。' },
            feishu: `
              <div class="lark-thread">
                <div class="lark-card">
                  <div class="lark-card-head">
                    <strong>正在查询</strong>
                    <span>已调用 Grep · Read</span>
                  </div>
                  <div class="lark-card-body">
                    <div class="lark-card-quote">已读取 <code>src/order/callback.ts:84</code> 与单号状态记录</div>
                    <p id="streamDraft"></p>
                  </div>
                </div>
              </div>`,
            streamText: '确认和幂等校验有关：首次回调写入锁后下游超时回滚，但幂等 key 未清理，导致重试请求全部被直接忽略。'
          },
          {
            delay: 2450,
            progress: 100,
            status: '已完成 · Session 已绑定',
            trace: { at: '5.8s', cls: 'ok', verb: 'done', arg: 'session=9a4f2c', desc: '已写入话题锚点，点击左侧「继续追问」体验续上同一 Session。' },
            feishu: `
              <div class="lark-thread">
                <div class="lark-card">
                  <div class="lark-card-head ok">
                    <strong>已完成</strong>
                    <span>${idLabel}</span>
                  </div>
                  <div class="lark-card-body">
                    <p><strong>结论：</strong><code>TEST-1001</code> 卡在 <code>src/order/callback.ts:84</code> 的幂等拦截。首次回调写入锁后因下游超时回滚，但幂等键未清理（TTL 30m），重试返回 <code>200 ignored</code>。</p>
                    <p><strong>建议：</strong>改为事务提交后写入幂等键，或允许 <code>PENDING</code> 状态重入。</p>
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
        message: `<span class="mention">${who}</span> <span class="mention">@所有人</span> 大家辛苦了，今天的发布窗口已经全部结束，谢谢配合。`,
        steps: [
          {
            delay: 120,
            progress: 40,
            status: '正在判定',
            trace: { at: '0.0s', cls: 'judge', verb: 'judge', arg: '无工具轻量判定', desc: '语义识别为常规发布结束致谢，无需查询也无需回复。' },
            feishu: `<div class="lark-thread"><div class="silent-note"><strong>尚未建话题</strong>正在判断是否需要回复...</div></div>`
          },
          {
            delay: 920,
            progress: 100,
            status: '判断不用回 · 群里零痕迹',
            trace: { at: '0.7s', cls: 'ok', verb: 'skip', arg: '未启动代理 · 未发卡片', desc: '已记入本地去重库并保留跳过理由，群里不留任何消息。' },
            feishu: `<div class="lark-thread"><div class="silent-note"><strong>判断不用回</strong>群里保持安静，不发卡片也不打扰大家，跳过理由仅记录在本机控制台。</div></div>`
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
        message: `<span class="mention">${who}</span> 下个迭代的支付重构方案，你预计周五前能评审完吗？`,
        steps: [
          {
            delay: 120,
            progress: 40,
            status: '正在判定',
            trace: { at: '0.0s', cls: 'judge', verb: 'judge', arg: '无工具轻量判定', desc: '涉及个人排期与主观承诺，不能由代理在群里代答。' },
            feishu: `<div class="lark-thread"><div class="silent-note"><strong>尚未建话题</strong>正在判断是否需要本人介入...</div></div>`
          },
          {
            delay: 960,
            progress: 100,
            status: '已私聊转交本人',
            trace: { at: '0.9s', cls: 'judge', verb: 'ask_me', arg: '私聊通知本人', desc: '已向你本人发送一条私聊提醒卡片，附原消息直达链接，群里未回复。' },
            feishu: `
              <div class="lark-thread">
                <div class="lark-card">
                  <div class="lark-card-head dm">
                    <strong>已私聊转交给你本人</strong>
                    <span>仅你可见</span>
                  </div>
                  <div class="lark-card-body">
                    <p>陈可在「项目研发群」询问评审排期。这类需要你本人拍板的问题不会在群里代答，请直接回复对方。</p>
                  </div>
                  <div class="lark-card-foot">
                    <span>判定：ask_me · 群里保持静默</span>
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
      message: `<span class="mention">${who}</span> 不用查了，停止处理，刚确认是测试环境配置漏配了。`,
      steps: [
        {
          delay: 100,
          progress: 30,
          status: '任务运行中',
          trace: { at: '0.0s', cls: 'tool', verb: 'Bash', arg: 'git log -n 20 --oneline', desc: '上一轮查询正在执行（session=9a4f2c）。' },
          feishu: `
            <div class="lark-thread">
              <div class="lark-card">
                <div class="lark-card-head">
                  <strong>正在查询</strong>
                  <span>${idLabel}</span>
                </div>
                <div class="lark-card-body">
                  <p>正在比对最近 20 次提交记录与测试环境配置差异<span class="stream-cursor"></span></p>
                </div>
              </div>
            </div>`
        },
        {
          delay: 860,
          progress: 70,
          status: '收到叫停指令',
          trace: { at: '0.8s', cls: 'judge', verb: 'stop', arg: '命中锚点 session=9a4f2c', desc: '向运行中的本地代理发送终止信号，立即收尾原卡片。' },
          feishu: `
            <div class="lark-thread">
              <div class="lark-card dim">
                <div class="lark-card-head stop">
                  <strong>已中断</strong>
                  <span>收到叫停指令</span>
                </div>
                <div class="lark-card-body">
                  <p>已根据话题中的「停止处理」指令终止本次任务，不再继续消耗 token。</p>
                </div>
                <div class="lark-card-foot">
                  <span>子进程已退出 · 并发名额已释放</span>
                  <span>支持随时重跑</span>
                </div>
              </div>
            </div>`
        },
        {
          delay: 1420,
          progress: 100,
          status: '已中断',
          trace: { at: '1.1s', cls: 'bad', verb: 'aborted', arg: 'pool 释放 1/3', desc: '原卡片已更新为「已中断」最终帧。' }
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
    const btn = document.getElementById('triggerFollowup');
    if (btn) btn.remove();

    const who = entryMention();
    const idLabel = entryIdentityLabel();
    const thread = simFeishu.querySelector('.lark-thread');
    if (!thread) return;

    wbStatusMeta.textContent = '续上 session=9a4f2c';
    const followMsg = document.createElement('div');
    followMsg.className = 'lark-msg';
    followMsg.innerHTML = `
      <div class="avatar" style="background:#4C647A">林</div>
      <div class="msg-body">
        <div class="msg-meta"><strong>林舟</strong><span>14:24</span></div>
        <div class="bubble"><span class="mention">${who}</span> 这个改动需要同步改单测吗？帮我看下相关测试文件。</div>
      </div>
    `;
    thread.appendChild(followMsg);

    appendTrace({ at: '0.0s', cls: 'judge', verb: 'resume', arg: '--resume 9a4f2c', desc: '命中原话题锚点，直接延续上一次上下文，无需重新扫描仓库。' });

    const replyCard = document.createElement('div');
    replyCard.className = 'lark-card';
    replyCard.innerHTML = `
      <div class="lark-card-head">
        <strong>正在续问</strong>
        <span>${idLabel}</span>
      </div>
      <div class="lark-card-body">
        <p id="followupStream"></p>
      </div>
    `;
    thread.appendChild(replyCard);
    typeStreamText(document.getElementById('followupStream'), '已检查 src/order/callback.test.ts，补充一条「下游超时回滚后允许重入」的用例即可覆盖。');

    const id = setTimeout(() => {
      wbStatusMeta.textContent = '追问已完成 · 2 轮对话';
      appendTrace({ at: '1.9s', cls: 'ok', verb: 'done', arg: 'src/order/callback.test.ts', desc: '追问卡片已收尾，完整两轮对话在控制台按同一 Session 聚合展示。' });
      replyCard.innerHTML = `
        <div class="lark-card-head ok">
          <strong>已完成</strong>
          <span>续接 session=9a4f2c · 1.9s</span>
        </div>
        <div class="lark-card-body">
          <p>需要补充 1 条测试。在 <code>src/order/callback.test.ts:112</code> 已有幂等跳过用例，新增一条「事务回滚后 <code>PENDING</code> 重试成功」即可完整覆盖。</p>
        </div>
      `;
    }, 1350);
    timers.push(id);
  }

  function playScene(key) {
    clearTimers();
    currentScene = key;
    const scene = buildScene(key);

    document.querySelectorAll('[data-scene]').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.scene === key));
    });
    document.querySelectorAll('[data-entry]').forEach((btn) => {
      btn.setAttribute('aria-pressed', String(btn.dataset.entry === currentEntry));
    });

    wbEntryMeta.textContent = currentEntry === 'bot' ? '@机器人 · 长连接秒级回复' : '@我 · 以本人身份回复';
    simTrace.innerHTML = '<div class="trace-progress" id="traceProgress" aria-hidden="true"></div>';
    const traceProgress = document.getElementById('traceProgress');
    renderFeishuBase(scene);

    scene.steps.forEach((step) => {
      const id = setTimeout(() => {
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
      }, step.delay);
      timers.push(id);
    });
  }

  document.querySelectorAll('[data-scene]').forEach((btn) => {
    btn.addEventListener('click', () => playScene(btn.dataset.scene));
  });

  document.querySelectorAll('[data-entry]').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentEntry = btn.dataset.entry;
      playScene(currentScene);
    });
  });

  document.getElementById('simReplay')?.addEventListener('click', () => playScene(currentScene));
  playScene('answer');

  /* ---------- Interactive 6-Step Lifecycle Inspector ---------- */
  const PIPE_STEPS = [
    {
      title: '1. 两个入口独立收消息，先过白名单与真人过滤',
      desc: '@我 通道通过 lark-cli 轮询搜索带重叠窗口的 @消息；@机器人 通道通过 im.message.receive_v1 长连接实时接收。未开启「自动回」的会话、非真人消息与默认关闭时的自发消息在这里直接拦掉。',
      module: 'src/pipeline.ts · src/lark.ts',
      guarantee: '白名单默认关闭，所有飞书调用经 execFile 传参不经 shell',
      storage: '搜索游标持久化在 state/history.db'
    },
    {
      title: '2. SQLite 原子去重，跨通道同时 @ 不重复回复',
      desc: '每条消息通过 INSERT OR IGNORE 写入 handled 表认领。同一条消息同时 @ 了你本人和机器人时，只要机器人入口开启，@我 通道自动让路，确保群里永远只回一张卡片。',
      module: 'src/db.ts · botTakes()',
      guarantee: '进程重启后去重记录依然有效，不重复回复历史消息',
      storage: 'history.db 与 bot.db 物理分库隔离'
    },
    {
      title: '3. 可选无工具轻量判定，挡掉闲聊与主观决策',
      desc: '模板配置了 judge 提示词时，先发一次无工具调用的轻量判定，输出 answer、skip、ask_me 或 stop。闲聊不发卡片不留痕，需要你拍板的事私聊转交，叫停指令直接中断在跑任务。',
      module: 'src/judge.ts',
      guarantee: '判定本身不挂载任何文件或命令工具，隔离提示词风险',
      storage: '跳过理由写入历史，控制台可查可「只看判定」试跑'
    },
    {
      title: '4. 匹配话题或引用卡片锚点，无缝续上同一 Session',
      desc: '查询 threads 表定位话题 id 或被引用的卡片 message_id，命中即 --resume 对应 Session，并自动补齐期间的群聊上下文与消息截图。上一轮还在跑时，新追问先优雅中断旧轮次再接棒。',
      module: 'src/pipeline.ts · threads 表',
      guarantee: '话题水位增量追踪，不重复喂给模型看过的聊天记录',
      storage: '锚点与 session_id 持久化落盘，重启照样续问'
    },
    {
      title: '5. 进程内并发闸调度本机 Claude Code 或 Codex',
      desc: '两个入口共用 maxJobs 并发池，在模板指定的工作区目录拉起本机 Claude Code 或连接 Codex App Server，按模板权限模式与模型档位流式产出统一的 AgentEvent，多 API 来源失败自动切换。',
      module: 'src/agent.ts · src/codex.ts · src/store.ts',
      guarantee: '新建模板默认只读 plan 模式，是防误改代码的硬边界',
      storage: 'settings 合成文件落盘 0600，不把密钥暴露到命令行参数'
    },
    {
      title: '6. 飞书流式卡片与本机控制台双路同步输出',
      desc: '@我 懒开话题并每 1.2 秒整卡刷新，@机器人 通过 CardKit 打字机流式更新，内置 30KB 字节预算裁剪避免超限拒收。同时经 SSE 实时直播到本机控制台，并监控本机 MCP 与插件状态变化。',
      module: 'src/card.ts · src/bus.ts · src/health.ts',
      guarantee: '卡片收尾失败可一键重发，Ctrl+C 退出前自动把在跑卡片收成已中断',
      storage: '控制台与飞书复用同一份卡片渲染逻辑'
    }
  ];

  const pipeDetail = document.getElementById('pipeDetail');
  function renderPipeStep(idx) {
    const item = PIPE_STEPS[idx];
    if (!item || !pipeDetail) return;
    document.querySelectorAll('[data-step]').forEach((btn) => {
      btn.setAttribute('aria-selected', String(Number(btn.dataset.step) === idx));
    });
    pipeDetail.innerHTML = `
      <div>
        <h3>${item.title}</h3>
        <p>${item.desc}</p>
      </div>
      <dl class="pipe-meta">
        <div><dt>核心模块</dt><dd><code>${item.module}</code></dd></div>
        <div><dt>可靠保障</dt><dd>${item.guarantee}</dd></div>
        <div><dt>状态管理</dt><dd>${item.storage}</dd></div>
      </dl>
    `;
  }

  document.querySelectorAll('[data-step]').forEach((btn) => {
    btn.addEventListener('click', () => renderPipeStep(Number(btn.dataset.step)));
  });
  renderPipeStep(0);

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
        if (macFile) macFile.textContent = `${dmg.name} · ${(dmg.size / 1048576).toFixed(1)} MB`;
        if (isMac && heroBtn) heroBtn.href = dmg.browser_download_url;
      }
      if (exe && winLink) {
        winLink.href = exe.browser_download_url;
        if (winFile) winFile.textContent = `${exe.name} · ${(exe.size / 1048576).toFixed(1)} MB`;
        if (isWin && heroBtn) heroBtn.href = exe.browser_download_url;
      }
    } catch {
      // Fallback links already point directly to /releases/latest
    }
  }

  hydrateLatestRelease();

  /* ---------- Calibrated Scroll Reveal ---------- */
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reducedMotion) {
    // Only animate elements that start below the initial viewport so above-the-fold or hash-targeted sections never flash invisible
    reveals.forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.98) {
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
