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

  /* ---------- Top Reading Progress Bar ---------- */
  const scrollProgress = document.getElementById('scrollProgress');
  function updateScrollBar() {
    if (!scrollProgress) return;
    const h = document.documentElement.scrollHeight - window.innerHeight;
    const pct = h > 0 ? Math.min(100, Math.max(0, (window.scrollY / h) * 100)) : 0;
    scrollProgress.style.width = `${pct}%`;
  }
  window.addEventListener('scroll', updateScrollBar, { passive: true });
  updateScrollBar();

  /* ---------- Mouse-Tracking Spotlight Glow ---------- */
  if (!reducedMotion) {
    document.querySelectorAll('.spotlight').forEach((card) => {
      card.addEventListener('pointermove', (e) => {
        const rect = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${e.clientX - rect.left}px`);
        card.style.setProperty('--my', `${e.clientY - rect.top}px`);
      });
    });

    /* Subtle 3D Tilt on Screenshot Frame */
    const tiltCard = document.querySelector('.tilt-card');
    if (tiltCard) {
      tiltCard.addEventListener('pointermove', (e) => {
        const rect = tiltCard.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width - 0.5;
        const py = (e.clientY - rect.top) / rect.height - 0.5;
        tiltCard.style.transform = `perspective(900px) rotateX(${(-py * 5).toFixed(2)}deg) rotateY(${(px * 5).toFixed(2)}deg) translateY(-3px)`;
      });
      tiltCard.addEventListener('pointerleave', () => {
        tiltCard.style.transform = '';
      });
    }
  }

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
  shotTrigger?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openLightbox();
    }
  });
  lightboxClose?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeLightbox();
  });
  lightbox?.addEventListener('click', closeLightbox);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && lightbox && !lightbox.hidden) closeLightbox();
  });

  /* ---------- Interactive Simulator with Streaming Card ---------- */
  const SCENES = {
    answer: {
      entryPill: '@我 · 本人身份',
      entryClass: 'accent',
      sender: '林舟',
      avatar: '林',
      avatarBg: '#5C7388',
      time: '14:22',
      message: '<span class="mention">@你</span> 帮我看下订单回调为什么没更新状态，测试单号 <code>TEST-1001</code>，是不是幂等校验拦掉了？',
      steps: [
        {
          delay: 120,
          progress: 18,
          status: { cls: 'run', text: '判定中', pulse: true },
          trace: { at: '0.0s', cls: 'judge', chip: 'judge', arg: 'mode=plan · haiku', desc: '判定结果：要回（明确的代码与单号查询请求）' },
          feishu: `
            <div class="lark-thread">
              <div class="silent-note">
                <span class="pill run"><span class="pulse-dot"></span> 还没建话题 · 正在判定要不要回</span>
              </div>
            </div>`
        },
        {
          delay: 720,
          progress: 48,
          status: { cls: 'run', text: '分析中', pulse: true },
          trace: { at: '1.1s', cls: 'think', chip: 'thinking', arg: 'claude-opus · 只读模式', desc: '先在项目里定位订单回调入口与幂等锁实现逻辑。' },
          feishu: `
            <div class="lark-thread">
              <div class="lark-card">
                <div class="lark-card-head">
                  <strong>🔵 正在查询…</strong>
                  <small>以你本人身份 · 1.2s 流式刷新</small>
                </div>
                <div class="lark-card-body">
                  <div class="lark-card-quote">正在检索订单回调处理逻辑与幂等校验…</div>
                  <p style="color:var(--ink-3)">正在读取仓库代码与相关日志工具<span class="stream-cursor"></span></p>
                </div>
              </div>
            </div>`
        },
        {
          delay: 1450,
          progress: 78,
          status: { cls: 'run', text: '调用工具', pulse: true },
          trace: { at: '2.4s', cls: 'tool', chip: 'Grep', arg: '"callbackIdempotency" src/order/', desc: '命中 2 处：src/order/callback.ts:84、src/order/store.ts:41' },
          feishu: `
            <div class="lark-thread">
              <div class="lark-card">
                <div class="lark-card-head">
                  <strong>🔵 正在查询…</strong>
                  <small>已调用 Grep · Read</small>
                </div>
                <div class="lark-card-body">
                  <div class="lark-card-quote">已定位到 <code>src/order/callback.ts:84</code>，正在核对 <code>TEST-1001</code> 状态流转…</div>
                  <p id="streamDraft"></p>
                </div>
              </div>
            </div>`,
          streamText: '确认和幂等校验有关：首次回调写入锁后下游超时回滚，但幂等 key 未清理，导致重试被直接拦截…'
        },
        {
          delay: 2550,
          progress: 100,
          status: { cls: 'ok', text: '已完成 · 话题已建', pulse: false },
          trace: { at: '5.8s', cls: 'ok', chip: 'done', arg: 'session=9a4f2c · 卡片已收尾', desc: '已落库线程锚点，原话题继续 @ 可直接续问同一个 Session。' },
          feishu: `
            <div class="lark-thread">
              <div class="lark-card">
                <div class="lark-card-head ok">
                  <strong>✅ 已完成</strong>
                  <small>以你本人身份 · 5.8s</small>
                </div>
                <div class="lark-card-body">
                  <p><strong>结论：</strong><code>TEST-1001</code> 卡在 <code>src/order/callback.ts:84</code> 的幂等拦截。首次回调写入锁后因下游超时回滚，但幂等 key 未清理（TTL 30m），导致重试全部返回 <code>200 ignored</code>。</p>
                  <p><strong>建议：</strong>仅在事务提交后写幂等键，或对 <code>PENDING</code> 状态允许重入。</p>
                </div>
                <div class="lark-card-foot">
                  <span>话题已绑定 Session · 在此话题继续 @ 可追问</span>
                  <span>完整过程 ▾</span>
                </div>
              </div>
            </div>`
        }
      ]
    },

    skip: {
      entryPill: '@我 · 本人身份',
      entryClass: 'accent',
      sender: '周明',
      avatar: '周',
      avatarBg: '#6B7D65',
      time: '18:05',
      message: '<span class="mention">@你</span> <span class="mention">@所有人</span> 大家辛苦了，今天的发布窗口已经全部结束，谢谢配合！',
      steps: [
        {
          delay: 140,
          progress: 40,
          status: { cls: 'run', text: '判定中', pulse: true },
          trace: { at: '0.0s', cls: 'judge', chip: 'judge', arg: '无工具轻量判定', desc: '分析语义：发布完成致谢通知，无需查资料，也无需本人行动。' },
          feishu: `
            <div class="lark-thread">
              <div class="silent-note">
                <span class="pill run"><span class="pulse-dot"></span> 还没建话题 · 正在判定要不要回</span>
              </div>
            </div>`
        },
        {
          delay: 980,
          progress: 100,
          status: { cls: 'skip', text: '不用回 · 群里零痕迹', pulse: false },
          trace: { at: '0.7s', cls: 'ok', chip: 'skip', arg: '未启动代理 · 未发卡片', desc: '判定理由：日常感谢/结束通知。已记入本地去重表，群里什么都不留。' },
          feishu: `
            <div class="lark-thread">
              <div class="silent-note">
                <span class="pill">没建话题 · 判断不用回</span>
                <div style="margin-top:6px">群里保持安静，不发任何卡片也不插嘴；完整跳过理由保存在本机控制台里可供随时查看。</div>
              </div>
            </div>`
        }
      ]
    },

    ask_me: {
      entryPill: '@我 · 本人身份',
      entryClass: 'accent',
      sender: '陈可',
      avatar: '陈',
      avatarBg: '#8A6B52',
      time: '15:40',
      message: '<span class="mention">@你</span> 下个迭代的支付重构需求，你预计周五前能评审完吗？',
      steps: [
        {
          delay: 140,
          progress: 40,
          status: { cls: 'run', text: '判定中', pulse: true },
          trace: { at: '0.0s', cls: 'judge', chip: 'judge', arg: '无工具轻量判定', desc: '分析语义：涉及个人排期与主观承诺，不能由代理在群里替你拍板。' },
          feishu: `
            <div class="lark-thread">
              <div class="silent-note">
                <span class="pill run"><span class="pulse-dot"></span> 还没建话题 · 正在判定要不要回</span>
              </div>
            </div>`
        },
        {
          delay: 1020,
          progress: 100,
          status: { cls: 'run', text: '已私聊转交给你', pulse: false },
          trace: { at: '0.9s', cls: 'judge', chip: 'ask_me', arg: '私聊提醒本人 · 群里不代答', desc: '已向你本人发送一条私聊提醒卡片，附原消息跳转链接与摘要。' },
          feishu: `
            <div class="lark-thread">
              <div class="lark-card">
                <div class="lark-card-head dm">
                  <strong>📩 已私聊转给你本人（群里未代答）</strong>
                  <small>仅你可见</small>
                </div>
                <div class="lark-card-body">
                  <p>陈可在「项目研发群」@了你，询问排期与评审时间——这类需要你本人表态的问题不会自动在群里回复，请亲自处理。</p>
                </div>
                <div class="lark-card-foot">
                  <span>判定：ask_me · 群里无任何消息</span>
                  <span>直达原消息 ↗</span>
                </div>
              </div>
            </div>`
        }
      ]
    },

    stop: {
      entryPill: '@机器人 · 长连接',
      entryClass: 'think',
      sender: '林舟',
      avatar: '林',
      avatarBg: '#5C7388',
      time: '14:26',
      message: '<span class="mention">@代码助手</span> 不用查了，停止处理，刚发现是测试环境配置漏配了。',
      steps: [
        {
          delay: 120,
          progress: 30,
          status: { cls: 'run', text: '正在执行中', pulse: true },
          trace: { at: '0.0s', cls: 'tool', chip: 'Bash', arg: 'git log -n 20 --oneline', desc: '上一轮查询正在执行中（session=9a4f2c）…' },
          feishu: `
            <div class="lark-thread">
              <div class="lark-card">
                <div class="lark-card-head">
                  <strong>🔵 正在查询…</strong>
                  <small>CardKit 流式更新中</small>
                </div>
                <div class="lark-card-body">
                  <p>正在比对最近 20 次提交记录与测试环境配置差异<span class="stream-cursor"></span></p>
                </div>
              </div>
            </div>`
        },
        {
          delay: 900,
          progress: 70,
          status: { cls: 'bad', text: '收到叫停指令', pulse: true },
          trace: { at: '0.8s', cls: 'judge', chip: 'stop', arg: '命中锚点 session=9a4f2c', desc: '判定结果：叫停。向对应子进程发送中止信号并更新原卡片。' },
          feishu: `
            <div class="lark-thread">
              <div class="lark-card dim">
                <div class="lark-card-head stop">
                  <strong>⚠️ 已中断</strong>
                  <small>收到叫停指令</small>
                </div>
                <div class="lark-card-body">
                  <p>已根据话题中的「停止处理」指令终止本次任务，释放本机并发名额。</p>
                </div>
                <div class="lark-card-foot">
                  <span>子进程已退出 · 控制台亦可一键终止</span>
                  <span>可再跑一次</span>
                </div>
              </div>
            </div>`
        },
        {
          delay: 1520,
          progress: 100,
          status: { cls: 'bad', text: '已中断', pulse: false },
          trace: { at: '1.1s', cls: 'bad', chip: 'aborted', arg: 'pool 释放 1/3 名额', desc: '卡片最终帧已收尾为「⚠️ 已中断」，不继续消耗 token。' }
        }
      ]
    }
  };

  let currentScene = 'answer';
  let timers = [];
  let streamInterval = null;

  const simFeishu = document.getElementById('simFeishu');
  const simTrace = document.getElementById('simTrace');
  const simStatusPill = document.getElementById('simStatusPill');
  const simEntryPill = document.getElementById('simEntryPill');

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
  }

  function setStatus(status) {
    simStatusPill.className = `pill ${status.cls}`;
    simStatusPill.innerHTML = `${status.pulse ? '<span class="pulse-dot"></span> ' : ''}${status.text}`;
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
      const slice = fullText.slice(0, idx);
      el.innerHTML = `${slice}<span class="stream-cursor"></span>`;
      if (idx >= fullText.length) {
        clearInterval(streamInterval);
        streamInterval = null;
      }
    };
    step();
    streamInterval = setInterval(step, 42);
  }

  function playScene(key) {
    clearTimers();
    currentScene = key;
    const scene = SCENES[key];
    if (!scene) return;

    document.querySelectorAll('.sim-tab').forEach((btn) => {
      btn.setAttribute('aria-selected', String(btn.dataset.scene === key));
    });

    simEntryPill.className = `pill ${scene.entryClass}`;
    simEntryPill.textContent = scene.entryPill;
    simTrace.innerHTML = '<div class="trace-progress" id="traceProgress" aria-hidden="true"></div>';
    const traceProgress = document.getElementById('traceProgress');
    renderFeishuBase(scene);

    scene.steps.forEach((step) => {
      const id = setTimeout(() => {
        if (step.status) setStatus(step.status);
        if (traceProgress && typeof step.progress === 'number') {
          traceProgress.style.height = `calc(${step.progress}% - 16px)`;
        }
        if (step.feishu) {
          renderFeishuBase(scene, step.feishu);
          if (step.streamText) {
            typeStreamText(document.getElementById('streamDraft'), step.streamText);
          }
        }
        if (step.trace) {
          const el = document.createElement('div');
          el.className = `trace-ev ${step.trace.cls}`;
          el.innerHTML = `
            <span class="trace-at">${step.trace.at}</span>
            <div class="trace-head">
              <span class="trace-chip">${step.trace.chip}</span>
              <span class="trace-arg">${step.trace.arg}</span>
            </div>
            <div class="trace-desc">${step.trace.desc}</div>
          `;
          simTrace.appendChild(el);
          requestAnimationFrame(() => el.classList.add('show'));
        }
      }, step.delay);
      timers.push(id);
    });
  }

  document.querySelectorAll('.sim-tab').forEach((btn) => {
    btn.addEventListener('click', () => playScene(btn.dataset.scene));
  });

  document.getElementById('simReplay')?.addEventListener('click', () => playScene(currentScene));
  playScene('answer');

  /* ---------- Quick Start Tabs & Copy ---------- */
  document.querySelectorAll('.qs-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.qs;
      document.querySelectorAll('.qs-tab').forEach((b) => {
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
      const text = pre.innerText.trim();
      try {
        await navigator.clipboard.writeText(text);
        const orig = btn.textContent;
        btn.textContent = '已复制 ✓';
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
  const macCard = document.getElementById('dlMacCard');
  const winCard = document.getElementById('dlWinCard');
  const macBadge = document.getElementById('dlMacBadge');
  const winBadge = document.getElementById('dlWinBadge');
  const macLink = document.getElementById('dlMacLink');
  const winLink = document.getElementById('dlWinLink');
  const macFile = document.getElementById('dlMacFile');
  const winFile = document.getElementById('dlWinFile');

  if (isWin) {
    winCard?.classList.add('recommended');
    if (winBadge) winBadge.hidden = false;
    winLink?.classList.add('primary');
    macLink?.classList.remove('primary');
    if (heroLabel) heroLabel.textContent = '下载 Windows 桌面版';
  } else if (isMac) {
    macCard?.classList.add('recommended');
    if (macBadge) macBadge.hidden = false;
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
      // Offline or API rate-limited: fallback URLs already point to /releases/latest
    }
  }

  hydrateLatestRelease();

  /* ---------- Staggered Scroll Reveal ---------- */
  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reducedMotion) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -20px 0px' });
    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('in'));
  }
})();
