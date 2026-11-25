/**
 * @fileoverview Frontend controller for `Gemini-chan 貓窩` Sidecar.
 * Connects `window.sidecar` workspace/chat bridge, border-flood-fill chroma cleanup
 * for chibi sprites, theme-adaptive canvas backdrop, interactive Xingxi Star Map,
 * accessible ARIA tablist, and full DSH 5-plugin controls & parity settings.
 */

(function () {
  const state = {
    snap: null,
    inProject: true,
    workspaceUris: [],
    currentSpriteUrl: '',
    starsLayout: [],
    selectedStarId: '',
    hoveredStarId: '',
    // Xingxi 3D Star Universe view & timeline state
    mapLinksOn: true,
    mapLayout: (() => {
      try {
        const saved = localStorage.getItem('gcat.mapLayout');
        if (saved === 'xingxi' || saved === 'cluster' || saved === 'random') return saved;
      } catch { /* ignore */ }
      return 'xingxi';
    })(),
    mapZoom: 0.72,
    mapAutoZoom: true,
    mapRotY: 0.42,
    mapRotX: -0.68,
    mapSearch: '',
    isDraggingMap: false,
    dragMoved: false,
    dragStartX: 0,
    dragStartY: 0,
    dragOriginRotY: 0,
    dragOriginRotX: 0,
    tlPos: 1.0,
    tlPlaying: false,
    tlCutTs: Infinity,
    tlTsList: [],
    starGraphSig: '',
    stars3D: [],
    starLinks3D: [],
    neighborsById: new Map(),
    lastStarFrameMs: 0,
    // Interactive UI states preserved across 1.5s polls
    expandedDiaries: new Set(),
    expandedPersonas: new Set(),
    editingMemId: '',
    renamingPersonaId: '',
    editingPersonaId: '',
    dirty: { mood: false, policy: false, sp: false, tg: false },
    tgChatIdEdited: false,
    // Sprite motion triggers strictly on interaction or active conversation
    hasInitialSnap: false,
    seenActivityAt: 0,
    seenLastCareAt: 0,
    seenSpeakUpAt: 0,
    spriteMotionUntil: 0,
    motionAmp: 0,
    motionPhaseStartMs: 0,
    lastDataVersion: '',
    pollFailures: 0,
    armedConfirm: null,
  };

  let toastTimer = null;
  function showToast(msg, kind = 'error', ms = 3600) {
    const el = $('toast');
    if (!el || !msg) return;
    el.textContent = String(msg);
    el.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    if (ms > 0) {
      toastTimer = setTimeout(() => {
        el.classList.add('hidden');
      }, ms);
    }
  }

  async function apiFetch(url, opts = {}, { silent = false } = {}) {
    const fetcher = (window.sidecar && typeof window.sidecar.fetch === 'function')
      ? (u, o) => window.sidecar.fetch(u, o)
      : (u, o) => fetch(u, {
        ...o,
        headers: { 'content-type': 'application/json', ...(o.headers || {}) },
      });

    let r;
    try {
      r = await fetcher(url, opts);
    } catch (err) {
      const msg = err?.message || '無法連線至貓窩背景服務';
      if (!silent) showToast(`連線失敗：${msg}`, 'error');
      throw err;
    }

    const raw = await r.text();
    let parsed = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        const msg = r.ok ? '伺服器回應格式錯誤' : `HTTP ${r.status} 錯誤`;
        if (!silent) showToast(msg, 'error');
        throw new Error(msg);
      }
    }

    if (!r.ok) {
      const msg = parsed?.error || `請求失敗 (HTTP ${r.status})`;
      if (!silent) showToast(msg, 'error');
      const err = new Error(msg);
      err.status = r.status;
      err.data = parsed;
      throw err;
    }
    return parsed;
  }

  const $ = (id) => document.getElementById(id);

  async function withBusy(btn, fn) {
    if (!btn) {
      try { return await fn(); } catch { return null; }
    }
    if (btn.dataset.busy === '1' || btn.disabled) return null;
    const prevDisabled = btn.disabled;
    btn.dataset.busy = '1';
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    try {
      return await fn();
    } catch {
      return null;
    } finally {
      delete btn.dataset.busy;
      btn.removeAttribute('aria-busy');
      if (btn.dataset.standbyDisabled !== '1' && btn.dataset.capDisabled !== '1') {
        btn.disabled = prevDisabled;
      }
    }
  }

  function disarmConfirm(elOpt = null) {
    if (!state.armedConfirm) return;
    clearTimeout(state.armedConfirm.timer);
    const { origText, btn, selector } = state.armedConfirm;
    const targetBtn = elOpt || (btn?.isConnected ? btn : (selector ? document.querySelector(selector) : null));
    if (targetBtn) {
      targetBtn.textContent = origText;
      targetBtn.classList.remove('btn-confirm-armed');
    }
    state.armedConfirm = null;
  }

  function confirmBtnAction(btn, confirmKey, selector, fn, armedLabel = '確定？') {
    if (!btn || btn.dataset.busy === '1') return null;
    const now = Date.now();
    if (state.armedConfirm && state.armedConfirm.key === confirmKey && state.armedConfirm.expiresAt > now) {
      disarmConfirm(btn);
      return withBusy(btn, fn);
    }
    disarmConfirm();
    const origText = btn.dataset.origLabel || btn.textContent;
    btn.dataset.origLabel = origText;
    btn.textContent = armedLabel;
    btn.classList.add('btn-confirm-armed');
    const timer = setTimeout(() => {
      if (state.armedConfirm && state.armedConfirm.key === confirmKey) {
        disarmConfirm();
      }
    }, 3200);
    state.armedConfirm = { key: confirmKey, origText, btn, selector, timer, expiresAt: now + 3200 };
    return null;
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function flashMsg(id, msg, durationMs = 3200) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg;
    if (durationMs > 0) {
      setTimeout(() => {
        if (el.textContent === msg) el.textContent = '';
      }, durationMs);
    }
  }

  function setDirty(section, flag) {
    state.dirty[section] = Boolean(flag);
    const bar = section === 'mood' ? $('mood-dirty-bar')
      : section === 'policy' ? $('pol-dirty-bar')
      : section === 'sp' ? $('sp-dirty-bar')
      : section === 'tg' ? $('tg-dirty-bar')
      : null;
    if (bar) bar.classList.toggle('hidden', !state.dirty[section]);

    const tabId = section === 'mood' ? 'tabbtn-mood'
      : section === 'policy' ? 'tabbtn-memory'
      : section === 'sp' ? 'tabbtn-speakup'
      : section === 'tg' ? 'tabbtn-telegram'
      : '';
    const tabBtn = tabId ? $(tabId) : null;
    if (tabBtn) tabBtn.classList.toggle('has-dirty', Boolean(state.dirty[section]));
  }

  window.addEventListener('beforeunload', (e) => {
    if (Object.values(state.dirty).some(Boolean)) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  function activeConversationId() {
    return window.sidecar?.conversationId || state.snap?.activeConversationId || '';
  }

  // ---------- 1. Theme-Adaptive Subtle Canvas Backdrop ----------
  const bgCanvas = $('bg-canvas');
  const bgCtx = bgCanvas.getContext('2d');
  const bgStars = Array.from({ length: 28 }, (_, i) => ({
    x: ((i * 97 + 19) % 100) / 100,
    y: ((i * 53 + 11) % 100) / 100,
    r: (i % 3) * 0.6 + 0.7,
    phase: i * 0.7,
    speed: 0.014 + (i % 5) * 0.004,
  }));

  function computeDarkThemeNow() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
      if (m) {
        const lum = 0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3]);
        return lum < 128;
      }
    } catch { /* fallback below */ }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  }

  let cachedIsDark = computeDarkThemeNow();
  const refreshDarkThemeCache = () => { cachedIsDark = computeDarkThemeNow(); };
  window.matchMedia?.('(prefers-color-scheme: dark)')?.addEventListener?.('change', refreshDarkThemeCache);
  if (typeof MutationObserver === 'function') {
    const themeObserver = new MutationObserver(refreshDarkThemeCache);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    if (document.body) {
      themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
    }
  }

  const reducedMotionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let prefersReducedMotion = Boolean(reducedMotionQuery?.matches);
  reducedMotionQuery?.addEventListener?.('change', (e) => { prefersReducedMotion = Boolean(e.matches); });

  function detectDarkTheme() {
    return cachedIsDark;
  }

  function drawStaticBgStars() {
    const w = bgCanvas.width;
    const h = bgCanvas.height;
    if (!w || !h) return;
    const isDark = cachedIsDark;
    bgCtx.clearRect(0, 0, w, h);
    const dpr = window.devicePixelRatio || 1;
    for (const s of bgStars) {
      const alpha = isDark ? 0.28 : 0.14;
      bgCtx.fillStyle = isDark
        ? `rgba(165, 180, 252, ${alpha})`
        : `rgba(79, 70, 184, ${alpha})`;
      bgCtx.beginPath();
      bgCtx.arc(s.x * w, s.y * h, s.r * dpr, 0, Math.PI * 2);
      bgCtx.fill();
    }
  }

  function resizeBgCanvas() {
    const stage = $('nest-stage');
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    bgCanvas.width = Math.round(rect.width * dpr);
    bgCanvas.height = Math.round(rect.height * dpr);
    if (prefersReducedMotion) drawStaticBgStars();
  }

  function activateSpriteMotion(durationMs = 2200) {
    if (prefersReducedMotion) return;
    const nowMs = performance.now();
    if (state.motionAmp <= 0.05) {
      state.motionPhaseStartMs = nowMs;
    }
    state.spriteMotionUntil = Math.max(state.spriteMotionUntil, nowMs + durationMs);
  }

  let bgStaticPainted = false;
  function animateStage(nowMs = performance.now()) {
    if (prefersReducedMotion) {
      if (!bgStaticPainted) {
        drawStaticBgStars();
        bgStaticPainted = true;
      }
      const spriteCanvas = $('sprite-canvas');
      if (spriteCanvas && spriteCanvas.style.transform !== 'none') {
        spriteCanvas.style.transform = 'none';
      }
      return;
    }
    bgStaticPainted = false;

    const w = bgCanvas.width;
    const h = bgCanvas.height;
    const tSec = nowMs / 1000;
    if (w && h && !document.hidden) {
      const isDark = cachedIsDark;
      bgCtx.clearRect(0, 0, w, h);
      const dpr = window.devicePixelRatio || 1;
      for (const s of bgStars) {
        const wave = 0.5 + 0.5 * Math.sin(tSec * (s.speed * 45) + s.phase);
        const alpha = isDark ? (0.14 + 0.34 * wave) : (0.08 + 0.16 * wave);
        bgCtx.fillStyle = isDark
          ? `rgba(165, 180, 252, ${alpha.toFixed(2)})`
          : `rgba(79, 70, 184, ${alpha.toFixed(2)})`;
        bgCtx.beginPath();
        bgCtx.arc(s.x * w, s.y * h, s.r * dpr, 0, Math.PI * 2);
        bgCtx.fill();
      }
    }
    const spriteCanvas = $('sprite-canvas');
    if (spriteCanvas) {
      const phase = state.snap?.nest?.activity?.phase || 'idle';
      const sleeping = Boolean(state.snap?.nest?.sleeping);
      const activeTurn = phase === 'thinking' || phase === 'tool';
      const activeWindow = nowMs < state.spriteMotionUntil;
      const isActive = activeTurn || activeWindow;

      if (isActive && state.motionAmp <= 0.05) {
        state.motionPhaseStartMs = nowMs;
      }

      const maxAmp = sleeping ? 1.0 : (activeTurn ? 2.0 : 2.4);
      const targetAmp = isActive ? maxAmp : 0;
      state.motionAmp += (targetAmp - state.motionAmp) * 0.12;

      if (!isActive && state.motionAmp < 0.04) {
        state.motionAmp = 0;
        if (spriteCanvas.style.transform !== 'translateY(0px)') {
          spriteCanvas.style.transform = 'translateY(0px)';
        }
      } else {
        const sec = Math.max(0, (nowMs - state.motionPhaseStartMs) / 1000);
        const hz = activeWindow && !activeTurn ? 1.05 : (sleeping ? 0.45 : 0.75);
        const offsetY = -Math.sin(sec * Math.PI * 2 * hz) * state.motionAmp;
        spriteCanvas.style.transform = `translateY(${offsetY.toFixed(2)}px)`;
      }
    }
    requestAnimationFrame(animateStage);
  }

  // ---------- 2. Chibi Sprite Loader with Border Flood-Fill Chroma Cleanup ----------
  const cleanedSprites = new Map();

  function drawContained(ctx, img, cw, ch) {
    const iw = img.naturalWidth || img.width || cw;
    const ih = img.naturalHeight || img.height || ch;
    const scale = Math.min(cw / iw, ch / ih);
    const dw = iw * scale;
    const dh = ih * scale;
    const dx = (cw - dw) * 0.5;
    const dy = (ch - dh) * 0.5;
    ctx.drawImage(img, dx, dy, dw, dh);
  }

  function removeOuterWhiteBackground(img) {
    const off = document.createElement('canvas');
    const size = 420;
    off.width = size;
    off.height = size;
    const ctx = off.getContext('2d');
    drawContained(ctx, img, size, size);

    const imgData = ctx.getImageData(0, 0, size, size);
    const data = imgData.data;
    const visited = new Uint8Array(size * size);
    const queue = new Int32Array(size * size);
    let head = 0;
    let tail = 0;

    const isWhiteBg = (idx) => {
      const p = idx * 4;
      const r = data[p];
      const g = data[p + 1];
      const b = data[p + 2];
      const a = data[p + 3];
      if (a < 15) return true;
      const min = Math.min(r, g, b);
      const max = Math.max(r, g, b);
      return min >= 232 && (max - min) <= 24;
    };

    const enqueue = (x, y) => {
      if (x < 0 || x >= size || y < 0 || y >= size) return;
      const idx = y * size + x;
      if (visited[idx] || !isWhiteBg(idx)) return;
      visited[idx] = 1;
      queue[tail++] = idx;
    };

    for (let x = 0; x < size; x++) {
      enqueue(x, 0);
      enqueue(x, size - 1);
    }
    for (let y = 0; y < size; y++) {
      enqueue(0, y);
      enqueue(size - 1, y);
    }

    while (head < tail) {
      const idx = queue[head++];
      data[idx * 4 + 3] = 0;
      const x = idx % size;
      const y = (idx / size) | 0;
      enqueue(x + 1, y);
      enqueue(x - 1, y);
      enqueue(x, y + 1);
      enqueue(x, y - 1);
    }

    ctx.putImageData(imgData, 0, 0);
    return off;
  }

  function hasTransparentBorder(img) {
    try {
      const probe = document.createElement('canvas');
      probe.width = 32;
      probe.height = 32;
      const pCtx = probe.getContext('2d');
      pCtx.drawImage(img, 0, 0, 32, 32);
      const d = pCtx.getImageData(0, 0, 32, 32).data;
      const corners = [0, 31, 31 * 32, 31 * 32 + 31];
      return corners.some((idx) => d[idx * 4 + 3] < 200);
    } catch {
      return false;
    }
  }

  function renderSprite(file, spriteUrl = '') {
    const resolvedUrl = spriteUrl || (file ? `/assets/${file}` : '');
    if (!resolvedUrl || state.currentSpriteUrl === resolvedUrl) return;
    state.currentSpriteUrl = resolvedUrl;
    const targetCanvas = $('sprite-canvas');
    const tCtx = targetCanvas.getContext('2d');
    const draw = (source) => {
      tCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
      drawContained(tCtx, source, targetCanvas.width, targetCanvas.height);
    };

    if (cleanedSprites.has(resolvedUrl)) {
      draw(cleanedSprites.get(resolvedUrl));
      return;
    }

    const img = new Image();
    img.onload = () => {
      const processed = hasTransparentBorder(img) ? img : removeOuterWhiteBackground(img);
      cleanedSprites.set(resolvedUrl, processed);
      if (state.currentSpriteUrl === resolvedUrl) draw(processed);
    };
    img.src = resolvedUrl;
  }

  function spawnParticles(text) {
    const layer = $('particle-layer');
    for (let i = 0; i < 4; i++) {
      const el = document.createElement('span');
      el.className = 'float-particle';
      el.textContent = text;
      el.style.color = 'var(--accent)';
      el.style.left = `${24 + Math.random() * 110}px`;
      el.style.top = `${16 + Math.random() * 72}px`;
      layer.appendChild(el);
      setTimeout(() => el.remove(), 1000);
    }
  }

  // ---------- 3. Interactive Xingxi 3D Star Universe & Timeline (年輪) Renderer ----------
  // Faithfully ported from upstream Yuuyuko-uu/dsh-xingxi (volume-uniform r³ sphere, focal=2400, jewel pearl sprites)
  const STAR_PALETTE_HEX = [
    '#4f9eff', '#1d72d8', '#8ccaff',
    '#26c7a4', '#087f78', '#80e4c9',
    '#9d70ff', '#6847dc', '#c5a6ff',
    '#ff8548', '#d94c32', '#ffc05b',
    '#ef5b98', '#c93673', '#ff9cbe',
    '#a9ce32', '#708d20', '#d8e87d',
  ];
  const CHAPTER_HEX = {
    1: '#74aaff', 2: '#54cbb9', 3: '#b28aff', 4: '#ff9777',
    5: '#ef78a7', 6: '#e4ba62', 7: '#9acb62', 8: '#67bfdf',
  };
  const MONTH_HEX = {
    1: '#58a6ff', 2: '#35d0a1', 3: '#b0d847', 4: '#ffc247',
    5: '#ff7b4f', 6: '#f15d76', 7: '#dd66c7', 8: '#ab78ff',
    9: '#686cf2', 10: '#45c6dc', 11: '#168f8a', 12: '#cc4365',
  };

  function hexAlpha(hex, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return `rgba(200,220,255,${a})`;
    const v = parseInt(m[1], 16);
    return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
  }

  function makePearlSprite(hex) {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, hexAlpha(hex, 1));
    grad.addColorStop(0.055, hexAlpha(hex, 0.98));
    grad.addColorStop(0.16, hexAlpha(hex, 0.78));
    grad.addColorStop(0.38, hexAlpha(hex, 0.32));
    grad.addColorStop(0.68, hexAlpha(hex, 0.085));
    grad.addColorStop(1, hexAlpha(hex, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const core = g.createRadialGradient(32, 32, 0, 32, 32, 7);
    core.addColorStop(0, 'rgba(255,255,255,0.84)');
    core.addColorStop(0.28, 'rgba(255,255,255,0.34)');
    core.addColorStop(1, 'rgba(255,255,255,0)');
    g.globalCompositeOperation = 'screen';
    g.fillStyle = core;
    g.beginPath();
    g.arc(32, 32, 7, 0, Math.PI * 2);
    g.fill();
    return c;
  }

  const pearlPaletteSprites = STAR_PALETTE_HEX.map(makePearlSprite);
  const pearlMonthSprites = Object.fromEntries(Object.entries(MONTH_HEX).map(([k, v]) => [k, makePearlSprite(v)]));
  const pearlDefaultSprite = makePearlSprite('#eaf0ff');
  const pearlCoreSprite = makePearlSprite('#ffe6a1');

  function makeSeededRand(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashStr(str) {
    let h = 2166136261 >>> 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function randomSphereVec(seedStr) {
    const rand = makeSeededRand(hashStr(seedStr));
    const y = rand() * 2 - 1;
    const angle = rand() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    return [r * Math.cos(angle), y, r * Math.sin(angle)];
  }

  const universeDust = (() => {
    const rand = makeSeededRand(911);
    const tints = ['#b9d4ff', '#9de6e0', '#f1c4ff', '#ffe0aa'];
    const dust = [];
    for (let i = 0; i < 360; i++) {
      const bright = i < 12;
      dust.push({
        u: rand(),
        v: rand(),
        r: bright ? 0.7 + rand() * 0.9 : 0.3 + rand() * 0.65,
        alpha: bright ? 0.11 + rand() * 0.13 : 0.008 + Math.pow(rand(), 2) * 0.07,
        bright,
        color: tints[Math.floor(rand() * tints.length)],
        phase: rand() * Math.PI * 2,
      });
    }
    return dust;
  })();

  const nebulaBands = [
    { u: 0.23, v: 0.28, radius: 0.5, color: '#415fae', strength: 0.055 },
    { u: 0.78, v: 0.72, radius: 0.42, color: '#824b91', strength: 0.047 },
    { u: 0.75, v: 0.23, radius: 0.32, color: '#277f83', strength: 0.04 },
    { u: 0.42, v: 0.82, radius: 0.3, color: '#a55c46', strength: 0.026 },
  ];

  function starPaletteIdx(s) {
    return hashStr(String(s.id || s.title || '')) % STAR_PALETTE_HEX.length;
  }

  function pickStarColorAndSprite(s) {
    if (s.isCore) return { hex: '#ffe6a1', sprite: pearlCoreSprite };
    if (s.kind === 'diary') {
      const m = Number(String(s.date || '').slice(5, 7));
      return {
        hex: MONTH_HEX[m] || '#35c7ad',
        sprite: pearlMonthSprites[m] || pearlDefaultSprite,
      };
    }
    const idx = starPaletteIdx(s);
    return {
      hex: STAR_PALETTE_HEX[idx] || '#b9c6e8',
      sprite: pearlPaletteSprites[idx] || pearlDefaultSprite,
    };
  }

  function parseStarDateMs(s) {
    const raw = String((s && (s.eventDate || (s.kind === 'diary' ? s.date : ''))) || '');
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (!m) return null;
    const yr = Number(m[1]);
    const mo = Number(m[2]);
    const dy = Number(m[3]);
    if (mo < 1 || mo > 12 || dy < 1 || dy > 31) return null;
    const ms = Date.UTC(yr, mo - 1, dy);
    const check = new Date(ms);
    return (check.getUTCFullYear() === yr && check.getUTCMonth() === mo - 1 && check.getUTCDate() === dy) ? ms : null;
  }

  function cmpUndatedCard(a, b) {
    const ca = Number(a.chapter) || 0;
    const cb = Number(b.chapter) || 0;
    if (ca > 0 && cb > 0 && ca !== cb) return ca - cb;
    if (ca > 0 && !cb) return -1;
    if (!ca && cb > 0) return 1;
    if (ca > 0 && ca === cb) {
      const od = (Number(a.order) || 0) - (Number(b.order) || 0);
      if (od) return od;
      return String(a.id).localeCompare(String(b.id));
    }
    return String(a.title || '').localeCompare(String(b.title || '')) || String(a.id).localeCompare(String(b.id));
  }

  function fmtDateTs(ts) {
    if (!ts || !Number.isFinite(ts)) return '--';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function fibonacciSpherePoint(index, total) {
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const y = total <= 1 ? 0 : 1 - (index / (total - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * index;
    return [Math.cos(theta) * r, y, Math.sin(theta) * r];
  }

  const STAR_FOCAL = 2400;

  function computeAutoZoom(stars, w, h) {
    if (!stars.length || !w || !h) return 0.72;
    const cosY = Math.cos(state.mapRotY);
    const sinY = Math.sin(state.mapRotY);
    const cosX = Math.cos(state.mapRotX);
    const sinX = Math.sin(state.mapRotX);
    let edgeX = 1;
    let edgeY = 1;
    for (const s of stars) {
      const x1 = s.x * cosY + s.z * sinY;
      const z1 = -s.x * sinY + s.z * cosY;
      const y2 = s.y * cosX - z1 * sinX;
      const z2 = s.y * sinX + z1 * cosX;
      const k = STAR_FOCAL / (STAR_FOCAL + z2);
      edgeX = Math.max(edgeX, Math.abs(x1 * k));
      edgeY = Math.max(edgeY, Math.abs(y2 * k));
    }
    // Upstream dsh-xingxi reference radius: keeps few stars gently proportioned without over-zooming
    const refEdge = 340;
    return Math.min((0.42 * w) / Math.max(edgeX, refEdge), (0.42 * h) / Math.max(edgeY, refEdge)) * 1.35;
  }

  function rebuildUniverse3D(xingxi) {
    const rawStars = Array.isArray(xingxi?.stars) ? xingxi.stars : [];
    const rawLinks = Array.isArray(xingxi?.links) ? xingxi.links : [];
    const layout = state.mapLayout || 'xingxi';

    const cloned = rawStars.map((s, idx) => ({
      ...s,
      ts: Number(s.ts) || (1704067200000 + idx * 86400000),
      isCore: false,
    }));

    const core = cloned.find((s) =>
      s.kind === 'card' && (String(s.title || '').trim() === '我是誰' || String(s.chapterName || '').trim() === '我是誰'),
    ) || cloned.find((s) => s.kind === 'card' && Number(s.chapter) === 1) || null;

    const firstByChapter = new Map();
    for (const s of cloned) {
      s.bodySize = (s.kind === 'diary' ? 7 : 8.5)
        + Math.min(10, Math.log10(1 + String(s.text || '').length) * 4.4) * 0.76;
      if (s.kind === 'card' && Number(s.chapter) > 0 && !firstByChapter.has(Number(s.chapter))) {
        firstByChapter.set(Number(s.chapter), s);
      }
    }
    if (core) {
      core.isCore = true;
      core.x = 0;
      core.y = 0;
      core.z = 0;
      core.bodySize = 40;
    }
    for (const [, chFirst] of firstByChapter) {
      if (chFirst !== core) chFirst.bodySize = Math.max(chFirst.bodySize, 22);
    }

    const dated = [];
    const undated = [];
    for (const s of cloned) {
      if (s === core) continue;
      const dms = parseStarDateMs(s);
      if (dms !== null) dated.push({ s, dms });
      else undated.push(s);
    }

    const innerCards = undated.filter((s) => s.kind === 'card').sort(cmpUndatedCard);
    const innerOther = undated.filter((s) => s.kind !== 'card').sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const innerList = [...innerCards, ...innerOther];

    const n = cloned.length;
    const innerMinR = 72;
    const innerMaxR = innerList.length ? Math.min(300, 100 + Math.log2(innerList.length + 1) * 22) : 0;
    const datedMinR = innerMaxR ? Math.max(105, innerMaxR * 0.72) : 72;
    const datedMaxR = Math.max(datedMinR + 40, Math.min(460, 170 + Math.sqrt(n) * 7));

    if (layout === 'random') {
      const nonCore = cloned.filter((s) => s !== core);
      const maxR = Math.max(220, datedMaxR);
      nonCore.forEach((s) => {
        const rand = makeSeededRand(hashStr(`${s.id}|rand`));
        const u = rand() * 2 - 1;
        const theta = rand() * Math.PI * 2;
        const sr = Math.sqrt(Math.max(0, 1 - u * u));
        const r = Math.cbrt(innerMinR ** 3 + (maxR ** 3 - innerMinR ** 3) * rand());
        s.x = sr * Math.cos(theta) * r;
        s.y = u * r;
        s.z = sr * Math.sin(theta) * r;
      });
    } else if (layout === 'cluster') {
      const nonCore = cloned.filter((s) => s !== core);
      const groups = new Map();
      for (const s of nonCore) {
        const gKey = s.kind === 'diary'
          ? `diary:${String(s.date || '').slice(0, 7) || 'all'}`
          : `ch:${Number(s.chapter) || 0}`;
        if (!groups.has(gKey)) groups.set(gKey, []);
        groups.get(gKey).push(s);
      }
      const entries = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const gTotal = Math.max(1, entries.length);
      entries.forEach(([gKey, list], gIdx) => {
        const [cx, cy, cz] = fibonacciSpherePoint(gIdx, gTotal);
        const anchorDist = 140 + (hashStr(`grp|${gKey}`) % 70);
        const spread = 56 + Math.min(54, Math.sqrt(list.length) * 14);
        list.forEach((s, idx) => {
          const [ox, oy, oz] = randomSphereVec(`${s.id}|cl|${idx}`);
          const rand = makeSeededRand(hashStr(`${s.id}|cld`));
          const localR = spread * Math.cbrt(rand());
          s.x = cx * anchorDist + ox * localR;
          s.y = cy * anchorDist + oy * localR;
          s.z = cz * anchorDist + oz * localR;
        });
      });
    } else {
      // Upstream dsh-xingxi volume-uniform r³ spherical expansion with overlapping undated/dated shells
      innerList.forEach((s, k) => {
        const t = innerList.length <= 1 ? 0 : k / (innerList.length - 1);
        const r = Math.cbrt(innerMinR ** 3 + (innerMaxR ** 3 - innerMinR ** 3) * t);
        const [dx, dy, dz] = randomSphereVec(String(s.id || s.title || ''));
        s.x = dx * r;
        s.y = dy * r;
        s.z = dz * r;
      });
      dated.sort((a, b) => a.dms - b.dms || String(a.s.id).localeCompare(String(b.s.id)));
      dated.forEach(({ s }, k) => {
        const t = dated.length <= 1 ? 0 : k / (dated.length - 1);
        const r = Math.cbrt(datedMinR ** 3 + (datedMaxR ** 3 - datedMinR ** 3) * t);
        const [dx, dy, dz] = randomSphereVec(String(s.id || s.title || ''));
        s.x = dx * r;
        s.y = dy * r;
        s.z = dz * r;
      });
    }

    for (const s of cloned) {
      const { hex, sprite } = pickStarColorAndSprite(s);
      s.hex = hex;
      s.sprite = sprite;
      s.paletteIdx = starPaletteIdx(s);
    }

    // Build spatial 2-nearest-neighbor same-chapter constellation lines (upstream dsh-xingxi rule) + shared bridges
    const byId = new Map(cloned.map((s) => [s.id, s]));
    const neighbors = new Map();
    const resolvedLinks = [];
    const seenEdge = new Set();
    const pushLink = (a, b, kind, extra = {}) => {
      if (!a || !b || a.id === b.id) return;
      const key = a.id < b.id ? `${a.id}|${b.id}|${kind}` : `${b.id}|${a.id}|${kind}`;
      if (seenEdge.has(key)) return;
      seenEdge.add(key);
      resolvedLinks.push({ a, b, kind, ...extra });
      if (!neighbors.has(a.id)) neighbors.set(a.id, new Set());
      if (!neighbors.has(b.id)) neighbors.set(b.id, new Set());
      neighbors.get(a.id).add(b.id);
      neighbors.get(b.id).add(a.id);
    };

    const byChapter = new Map();
    for (const s of cloned) {
      if (s.kind !== 'card' || !Number(s.chapter)) continue;
      const ch = Number(s.chapter);
      if (!byChapter.has(ch)) byChapter.set(ch, []);
      byChapter.get(ch).push(s);
    }
    for (const [ch, list] of byChapter) {
      for (const a of list) {
        const dists = [];
        for (const b of list) {
          if (b === a) continue;
          dists.push([Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), b]);
        }
        dists.sort((u, v) => u[0] - v[0]);
        for (let k = 0; k < Math.min(2, dists.length); k++) {
          if (dists[k][0] > 210) continue;
          pushLink(a, dists[k][1], 'chapter', { chapter: ch });
        }
      }
    }

    for (const l of rawLinks) {
      if (l.kind === 'chapter') continue;
      const a = byId.get(l.source);
      const b = byId.get(l.target);
      if (!a || !b) continue;
      pushLink(a, b, l.kind, { label: l.label, weight: l.weight });
    }

    const tsList = [...new Set(cloned.map((s) => s.ts).filter((t) => t > 0))].sort((a, b) => a - b);
    state.stars3D = cloned;
    state.starLinks3D = resolvedLinks;
    state.neighborsById = neighbors;
    state.tlTsList = tsList;
    state.mapAutoZoom = true;

    const firstEl = $('xx-tl-first');
    const lastEl = $('xx-tl-last');
    if (firstEl) firstEl.textContent = tsList.length ? fmtDateTs(tsList[0]).slice(5) : '--';
    if (lastEl) lastEl.textContent = tsList.length ? fmtDateTs(tsList[tsList.length - 1]).slice(5) : '--';
    syncTimelineCut();
  }

  function syncTimelineCut() {
    const tsList = state.tlTsList;
    const curEl = $('xx-tl-cur');
    const rangeEl = $('xx-tl-range');
    if (rangeEl && document.activeElement !== rangeEl) {
      rangeEl.value = String(Math.round(state.tlPos * 1000));
    }
    if (!tsList.length || (state.tlPos >= 0.999 && !state.tlPlaying)) {
      state.tlCutTs = Infinity;
      if (curEl) curEl.textContent = '全部記憶';
      return;
    }
    const idx = Math.min(tsList.length - 1, Math.max(0, Math.floor(state.tlPos * tsList.length)));
    state.tlCutTs = tsList[idx];
    if (curEl) {
      curEl.textContent = `${fmtDateTs(state.tlCutTs)} · ${Math.round(state.tlPos * 100)}%`;
    }
  }

  function isStarInTimeline(s) {
    if (s.isCore) return true;
    if (state.tlCutTs === Infinity) return true;
    return (s.ts || 0) <= state.tlCutTs;
  }

  function projectStar3D(x, y, z, w, h) {
    const cosY = Math.cos(state.mapRotY);
    const sinY = Math.sin(state.mapRotY);
    const cosX = Math.cos(state.mapRotX);
    const sinX = Math.sin(state.mapRotX);
    const x1 = x * cosY + z * sinY;
    const z1 = -x * sinY + z * cosY;
    const y2 = y * cosX - z1 * sinX;
    const z2 = y * sinX + z1 * cosX;
    const dist = STAR_FOCAL + z2;
    if (dist < 120) return null;
    const depth = STAR_FOCAL / dist;
    const k = depth * state.mapZoom;
    return {
      sx: w / 2 + x1 * k,
      sy: h / 2 + y2 * k,
      z: z2,
      depth,
      k,
    };
  }

  function renderSelectedStarDetail(star) {
    const detail = $('star-detail');
    if (!detail) return;
    if (!star) {
      detail.textContent = '點選任一星點檢視關聯星座與全文。';
      return;
    }
    const bridgeLabels = [];
    for (const l of state.starLinks3D) {
      if (l.kind === 'bridge' && l.label && (l.a.id === star.id || l.b.id === star.id)) {
        const other = l.a.id === star.id ? l.b : l.a;
        bridgeLabels.push(`「${l.label}」→ ${other.title}`);
      }
    }
    const kindTag = star.isCore
      ? '核心星｜第一章・我是誰'
      : star.kind === 'diary'
        ? `星曆日記｜${star.date || star.doc}`
        : `八章記憶卡｜${star.chapterName || star.doc}${star.eventDate ? `（事件日 ${star.eventDate}）` : ''}`;
    const bridgeLine = bridgeLabels.length
      ? `\n✦ 共詞橋連線：${bridgeLabels.slice(0, 6).join('、')}`
      : '';
    detail.textContent = `【${kindTag}】${star.title}${bridgeLine}\n\n${star.text || '（暫無條目正文）'}`;
  }

  function drawStarMap(xingxi, nowMs = performance.now()) {
    const canvas = $('starmap-canvas');
    if (!canvas) return;
    if (xingxi) {
      const stars = xingxi.stars || [];
      const links = xingxi.links || [];
      const sig = `${state.mapLayout}:${stars.length}:${links.length}:${stars.map((s) => `${s.id}:${s.title}:${s.ts || 0}`).join('|')}`;
      if (sig !== state.starGraphSig) {
        state.starGraphSig = sig;
        rebuildUniverse3D(xingxi);
      }
      const hudStats = $('xx-hud-stats');
      if (hudStats) {
        const diariesCount = xingxi.stats?.diaries ?? stars.filter((s) => s.kind === 'diary').length;
        const bridgesCount = xingxi.bridges?.length ?? links.filter((l) => l.kind === 'bridge').length;
        hudStats.textContent = `${stars.length} 顆星 · ${diariesCount} 篇日記 · ${bridgesCount} 座共詞橋`;
      }
    }

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(300, Math.round(rect.width || 520));
    const h = Math.max(220, Math.round(rect.height || 300));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      if (state.mapAutoZoom && state.stars3D.length) {
        state.mapZoom = computeAutoZoom(state.stars3D, w, h);
      }
    } else if (state.mapAutoZoom && state.stars3D.length) {
      state.mapZoom = computeAutoZoom(state.stars3D, w, h);
      state.mapAutoZoom = false;
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Deep night sky + delicate diagonal Milky Way band + soft low-contrast nebulae + sparse dust
    ctx.fillStyle = '#050814';
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-0.34);
    const mw = ctx.createLinearGradient(0, -h * 0.12, 0, h * 0.12);
    mw.addColorStop(0, 'rgba(120,160,230,0)');
    mw.addColorStop(0.28, 'rgba(132,166,226,0.018)');
    mw.addColorStop(0.5, 'rgba(172,195,244,0.058)');
    mw.addColorStop(0.72, 'rgba(132,166,226,0.018)');
    mw.addColorStop(1, 'rgba(120,160,230,0)');
    ctx.fillStyle = mw;
    ctx.fillRect(-w, -h, w * 2, h * 2);
    ctx.restore();

    const tSec = nowMs * 0.001;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let ci = 0; ci < nebulaBands.length; ci++) {
      const nb = nebulaBands[ci];
      const cx = (((nb.u + Math.sin(tSec * 0.035 + ci) * 0.018) % 1) + 1) % 1 * w;
      const cy = (((nb.v + Math.cos(tSec * 0.03 + ci * 1.7) * 0.014) % 1) + 1) % 1 * h;
      const r = nb.radius * Math.min(w, h);
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-0.34 + ci * 0.08);
      ctx.scale(1.65, 0.48);
      const ng = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      const breath = 0.97 + 0.03 * Math.sin(tSec * 0.12 + ci * 1.3);
      ng.addColorStop(0, hexAlpha(nb.color, nb.strength * breath));
      ng.addColorStop(0.55, hexAlpha(nb.color, nb.strength * 0.34));
      ng.addColorStop(1, hexAlpha(nb.color, 0));
      ctx.fillStyle = ng;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < universeDust.length; k++) {
      const d = universeDust[k];
      const px = (((d.u + state.mapRotY * 0.015 + tSec * 0.0035) % 1) + 1) % 1;
      const py = (((d.v + state.mapRotX * 0.02 + tSec * 0.0025 + 1) % 1) + 1) % 1;
      const twinkle = d.bright
        ? 0.72 + 0.28 * Math.sin(tSec * 0.42 + d.phase)
        : 0.7 + 0.3 * Math.sin(tSec * (0.22 + (k % 9) * 0.025) + d.phase);
      ctx.fillStyle = d.color;
      ctx.globalAlpha = Math.min(d.bright ? 0.5 : 0.22, d.alpha * (0.58 + 0.6 * twinkle));
      if (d.bright) {
        ctx.beginPath();
        ctx.arc(px * w, py * h, d.r * (0.7 + 0.35 * twinkle), 0, Math.PI * 2);
        ctx.fill();
      } else {
        const sz = d.r * (0.8 + 0.25 * twinkle);
        ctx.fillRect(px * w, py * h, sz, sz);
      }
    }
    ctx.restore();

    const stars = state.stars3D;
    if (!stars.length) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('尚無星汐檔案，寫入記憶卡條目或日記即會亮起第一顆星', w / 2, h / 2);
      state.starsLayout = [];
      $('xx-map-hits').textContent = '';
      ctx.restore();
      return;
    }

    // 2. Search filter & 3D projection (telephoto focal=2400)
    const q = state.mapSearch.trim().toLowerCase();
    let hitsCount = 0;
    const projected = [];
    for (const s of stars) {
      if (!isStarInTimeline(s)) {
        s._proj = null;
        continue;
      }
      const matched = q
        ? [s.title, s.text, s.chapterName, s.date, s.eventDate].some((v) => String(v || '').toLowerCase().includes(q))
        : true;
      s.matched = matched;
      if (q && matched) hitsCount++;
      const pr = projectStar3D(s.x, s.y, s.z, w, h);
      s._proj = pr;
      if (pr) projected.push({ s, pr });
    }
    projected.sort((a, b) => b.pr.z - a.pr.z);
    state.starsLayout = projected.map(({ s, pr }) => ({
      ...s,
      x: pr.sx,
      y: pr.sy,
      r: Math.max(5, (s.bodySize || 12) * 0.45),
    }));
    $('xx-map-hits').textContent = q ? `${hitsCount} 顆` : '';

    // Ambient warm backdrop halo behind Core Star (upstream dsh-xingxi screen glow)
    const coreStar = stars.find((s) => s.isCore && s._proj);
    if (coreStar) {
      const cp = coreStar._proj;
      const pulse = 0.97 + 0.03 * Math.sin(tSec * 0.55);
      const auraR = Math.max(82, 138 * state.mapZoom * pulse);
      const aura = ctx.createRadialGradient(cp.sx, cp.sy, 0, cp.sx, cp.sy, auraR);
      aura.addColorStop(0, 'rgba(255,238,199,0.24)');
      aura.addColorStop(0.24, 'rgba(255,213,145,0.13)');
      aura.addColorStop(0.58, 'rgba(176,151,255,0.04)');
      aura.addColorStop(1, 'rgba(60,100,180,0)');
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(cp.sx, cp.sy, auraR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const focusId = state.selectedStarId || state.hoveredStarId;
    const focusNeighbors = (focusId && state.mapLinksOn) ? state.neighborsById.get(focusId) : null;

    // 3. Spatial same-chapter lines & Shared-word Bridges (upstream dsh-xingxi subtle styling)
    if (state.mapLinksOn) {
      const bridgeMidpoints = [];
      for (const l of state.starLinks3D) {
        const pa = l.a._proj;
        const pb = l.b._proj;
        if (!pa || !pb) continue;
        if (q && !l.a.matched && !l.b.matched) continue;
        const isFocusEdge = Boolean(focusId && (l.a.id === focusId || l.b.id === focusId));

        if (l.kind === 'chapter') {
          const chHex = CHAPTER_HEX[l.chapter] || '#b5c4e8';
          ctx.strokeStyle = hexAlpha(chHex, isFocusEdge ? 0.92 : focusId ? 0.07 : 0.22);
          ctx.lineWidth = isFocusEdge ? 1.6 : 0.85;
          ctx.beginPath();
          ctx.moveTo(pa.sx, pa.sy);
          ctx.lineTo(pb.sx, pb.sy);
          ctx.stroke();
          continue;
        }

        if (l.kind === 'bridge') {
          ctx.strokeStyle = isFocusEdge
            ? 'rgba(255,198,130,0.78)'
            : focusId ? 'rgba(255,190,120,0.025)' : 'rgba(255,190,120,0.09)';
          ctx.lineWidth = isFocusEdge ? 1.35 : 0.6;
          ctx.beginPath();
          ctx.moveTo(pa.sx, pa.sy);
          ctx.lineTo(pb.sx, pb.sy);
          ctx.stroke();
          if (isFocusEdge && l.label) {
            bridgeMidpoints.push({ x: (pa.sx + pb.sx) * 0.5, y: (pa.sy + pb.sy) * 0.5, text: l.label });
          }
          continue;
        }

        if (isFocusEdge && (l.kind === 'ref' || l.kind === 'similar')) {
          ctx.save();
          ctx.strokeStyle = l.kind === 'ref' ? 'rgba(255,200,130,0.45)' : 'rgba(255,255,255,0.3)';
          ctx.lineWidth = 1.1;
          ctx.setLineDash(l.kind === 'ref' ? [2, 4] : []);
          ctx.beginPath();
          ctx.moveTo(pa.sx, pa.sy);
          ctx.lineTo(pb.sx, pb.sy);
          ctx.stroke();
          ctx.restore();
        }
      }

      if (bridgeMidpoints.length) {
        ctx.save();
        ctx.font = '10.5px "Microsoft JhengHei UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const m of bridgeMidpoints.slice(0, 8)) {
          const tw = ctx.measureText(m.text).width;
          const pw = tw + 10;
          const ph = 15;
          ctx.fillStyle = 'rgba(10, 14, 28, 0.85)';
          ctx.strokeStyle = 'rgba(255, 214, 150, 0.42)';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.roundRect(m.x - pw / 2, m.y - ph / 2, pw, ph, 7);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = 'rgba(255, 228, 176, 0.96)';
          ctx.fillText(m.text, m.x, m.y + 0.5);
        }
        ctx.restore();
      }
    }

    // 4. Render unified circular pearl stars (upstream dsh-xingxi source-over + warm golden core halo)
    const nowWall = Date.now();
    for (const { s, pr } of projected) {
      const isSelected = state.selectedStarId === s.id;
      const isHovered = state.hoveredStarId === s.id;
      const isNeighbor = Boolean(focusNeighbors && focusNeighbors.has(s.id));
      const daysOld = s.ts ? Math.max(0, (nowWall - s.ts) / 86400000) : 120;
      const energy = 0.42 + 0.58 * Math.exp(-daysOld / 110);
      const phase = (s.paletteIdx || 0) * 2.399;
      const breath = 0.965 + 0.035 * Math.sin(tSec * (0.42 + ((s.paletteIdx || 0) % 7) * 0.025) + phase);

      let sz = Math.max(7, (s.bodySize || 12) * (0.8 + 0.5 * state.mapZoom) * pr.depth * breath);
      if (q && !s.matched) sz *= 0.55;
      if (s.kind !== 'card') sz *= 0.85;
      if (isNeighbor && s.id !== focusId) sz *= 1.12;
      if (s.isCore) sz *= 1.15;
      if (isSelected) sz *= 1.6;
      else if (isHovered) sz *= 1.28;

      const alpha = Math.min(1, (0.84 + pr.depth * 0.22) * breath * energy)
        * (q && !s.matched ? 0.22 : 1)
        * (focusNeighbors ? ((isNeighbor || s.id === focusId) ? 1 : 0.32) : 1);

      if (isSelected || isHovered) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = alpha * (isSelected ? 0.28 : 0.17);
        const haloR = sz * (isSelected ? 1.85 : 1.45);
        const halo = ctx.createRadialGradient(pr.sx, pr.sy, 0, pr.sx, pr.sy, haloR);
        halo.addColorStop(0, hexAlpha(s.hex, 0.65));
        halo.addColorStop(0.4, hexAlpha(s.hex, 0.2));
        halo.addColorStop(1, hexAlpha(s.hex, 0));
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(pr.sx, pr.sy, haloR, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = alpha;
      ctx.drawImage(s.sprite, pr.sx - sz / 2, pr.sy - sz / 2, sz, sz);

      if (s.isCore) {
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        const ringR = Math.max(15, sz * 1.95);
        const p2 = 0.96 + 0.04 * Math.sin(tSec * 0.72);
        ctx.globalAlpha = alpha * 0.32 * p2;
        const ring = ctx.createRadialGradient(pr.sx, pr.sy, sz * 0.08, pr.sx, pr.sy, ringR);
        ring.addColorStop(0, 'rgba(255,247,220,0.88)');
        ring.addColorStop(0.18, 'rgba(255,226,164,0.44)');
        ring.addColorStop(0.48, 'rgba(255,197,108,0.16)');
        ring.addColorStop(1, 'rgba(255,190,110,0)');
        ctx.fillStyle = ring;
        ctx.beginPath();
        ctx.arc(pr.sx, pr.sy, ringR, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // 5. Crisp selection ring & label ONLY when selected (hover uses floating tooltip card)
    if (state.selectedStarId) {
      const st = stars.find((x) => x.id === state.selectedStarId && x._proj);
      if (st) {
        const { sx, sy, depth } = st._proj;
        const selR = Math.max(10, (st.bodySize || 12) * (0.8 + 0.5 * state.mapZoom) * depth * 0.65);
        ctx.save();
        ctx.strokeStyle = hexAlpha(st.hex, 0.9);
        ctx.lineWidth = 1.15;
        ctx.beginPath();
        ctx.arc(sx, sy, selR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(236,242,255,0.34)';
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.arc(sx, sy, selR + 3, 0, Math.PI * 2);
        ctx.stroke();
        if (state.hoveredStarId !== st.id) {
          ctx.font = '500 11.5px "Microsoft JhengHei UI", system-ui, sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = st.isCore ? 'rgba(255, 244, 214, 0.96)' : 'rgba(245, 247, 255, 0.95)';
          ctx.fillText((st.title || '').slice(0, 18), sx + selR + 6, sy);
        }
        ctx.restore();
      }
    }
    ctx.restore();
  }

  function animateStarMapLoop(nowMs = performance.now()) {
    const dt = state.lastStarFrameMs ? Math.min(0.08, (nowMs - state.lastStarFrameMs) / 1000) : 0.016;
    state.lastStarFrameMs = nowMs;
    const xingxiPanel = $('tab-xingxi');
    if (xingxiPanel && !xingxiPanel.hidden && !document.hidden) {
      if (!prefersReducedMotion && !state.isDraggingMap && !state.hoveredStarId) {
        state.mapRotY += dt * 0.01;
      }
      if (state.tlPlaying) {
        state.tlPos += dt / 9.0;
        if (state.tlPos >= 1) {
          state.tlPos = 1;
          state.tlPlaying = false;
          const playBtn = $('xx-tl-play');
          if (playBtn) playBtn.textContent = '▶';
        }
        syncTimelineCut();
      }
      if (!prefersReducedMotion || state.isDraggingMap || state.tlPlaying) {
        drawStarMap(null, nowMs);
      }
    }
    requestAnimationFrame(animateStarMapLoop);
  }
  requestAnimationFrame(animateStarMapLoop);

  // Orbit Drag, Hover Tooltip, Wheel Zoom & Click Hit-Test on 3D Star Map
  const starmapCanvas = $('starmap-canvas');
  const starTip = $('xx-star-tip');

  function findHitStarAtClientPos(clientX, clientY) {
    const rect = starmapCanvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    let best = null;
    let bestDist = 18;
    for (const s of state.stars3D) {
      if (!s._proj) continue;
      if (state.mapSearch && !s.matched) continue;
      const d = Math.hypot(s._proj.sx - mx, s._proj.sy - my);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return { hit: best, mx, my, rect };
  }

  function updateHoverTooltip(hit, mx, my, rect) {
    if (!starTip) return;
    if (!hit || state.isDraggingMap) {
      starTip.classList.add('hidden');
      return;
    }
    const meta = hit.isCore
      ? '核心星 · 第一章｜我是誰'
      : hit.kind === 'diary'
        ? `日記 · ${hit.date || hit.doc}`
        : `記憶卡 · ${hit.chapterName || hit.doc}${hit.eventDate ? ` · ${hit.eventDate}` : ''}`;
    const snippet = String(hit.text || '').replace(/\s+/g, ' ').slice(0, 72);
    starTip.innerHTML =
      `<div class="tip-meta">${esc(meta)}</div>` +
      `<div class="tip-title">${esc(hit.title || '')}</div>` +
      (snippet ? `<div class="tip-body">${esc(snippet)}${hit.text && hit.text.length > 72 ? '…' : ''}</div>` : '');
    starTip.classList.remove('hidden');
    const left = Math.min(Math.max(8, mx + 14), Math.max(8, (rect.width || 520) - 248));
    const top = Math.min(Math.max(8, my - 10), Math.max(8, (rect.height || 320) - 96));
    starTip.style.left = `${left}px`;
    starTip.style.top = `${top}px`;
  }

  starmapCanvas.addEventListener('pointerdown', (e) => {
    state.isDraggingMap = true;
    state.dragMoved = false;
    state.dragStartX = e.clientX;
    state.dragStartY = e.clientY;
    state.dragOriginRotY = state.mapRotY;
    state.dragOriginRotX = state.mapRotX;
    if (starTip) starTip.classList.add('hidden');
    starmapCanvas.setPointerCapture?.(e.pointerId);
  });

  starmapCanvas.addEventListener('pointermove', (e) => {
    if (state.isDraggingMap) {
      const dx = e.clientX - state.dragStartX;
      const dy = e.clientY - state.dragStartY;
      if (Math.hypot(dx, dy) > 4) state.dragMoved = true;
      state.mapRotY = state.dragOriginRotY + dx * 0.0065;
      state.mapRotX = Math.max(-1.25, Math.min(1.25, state.dragOriginRotX + dy * 0.0065));
      drawStarMap(null);
      return;
    }
    const { hit, mx, my, rect } = findHitStarAtClientPos(e.clientX, e.clientY);
    state.hoveredStarId = hit ? hit.id : '';
    starmapCanvas.style.cursor = hit ? 'pointer' : 'grab';
    updateHoverTooltip(hit, mx, my, rect);
  });

  starmapCanvas.addEventListener('pointerleave', () => {
    state.hoveredStarId = '';
    if (starTip) starTip.classList.add('hidden');
  });

  starmapCanvas.addEventListener('pointerup', (e) => {
    const moved = state.dragMoved;
    state.isDraggingMap = false;
    starmapCanvas.releasePointerCapture?.(e.pointerId);
    if (moved) return;

    const { hit } = findHitStarAtClientPos(e.clientX, e.clientY);
    if (!hit) {
      state.selectedStarId = '';
      renderSelectedStarDetail(null);
      drawStarMap(null);
      return;
    }
    state.selectedStarId = hit.id;
    renderSelectedStarDetail(hit);
    drawStarMap(null);
  });

  starmapCanvas.addEventListener('pointercancel', () => {
    state.isDraggingMap = false;
  });

  starmapCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.mapAutoZoom = false;
    const factor = Math.exp(-e.deltaY * 0.0012);
    state.mapZoom = Math.min(3.4, Math.max(0.2, state.mapZoom * factor));
    drawStarMap(null);
  }, { passive: false });

  $('xx-map-search').addEventListener('input', (e) => {
    state.mapSearch = e.target.value;
    drawStarMap(null);
  });

  const layoutSel = $('xx-layout-mode');
  if (layoutSel) {
    layoutSel.value = state.mapLayout;
    layoutSel.addEventListener('change', (e) => {
      const next = e.target.value;
      if (next !== 'xingxi' && next !== 'cluster' && next !== 'random') return;
      state.mapLayout = next;
      try { localStorage.setItem('gcat.mapLayout', next); } catch { /* ignore */ }
      state.starGraphSig = '';
      if (state.snap?.xingxi) drawStarMap(state.snap.xingxi);
    });
  }

  $('xx-toggle-links').addEventListener('click', () => {
    state.mapLinksOn = !state.mapLinksOn;
    const btn = $('xx-toggle-links');
    btn.classList.toggle('active', state.mapLinksOn);
    btn.setAttribute('aria-pressed', String(state.mapLinksOn));
    btn.textContent = state.mapLinksOn ? '連線開' : '連線關';
    drawStarMap(null);
  });

  $('xx-zoom-in').addEventListener('click', () => {
    state.mapAutoZoom = false;
    state.mapZoom = Math.min(3.4, state.mapZoom * 1.22);
    drawStarMap(null);
  });

  $('xx-zoom-out').addEventListener('click', () => {
    state.mapAutoZoom = false;
    state.mapZoom = Math.max(0.2, state.mapZoom * 0.82);
    drawStarMap(null);
  });

  $('xx-zoom-reset').addEventListener('click', () => {
    state.mapAutoZoom = true;
    state.mapRotY = 0.42;
    state.mapRotX = -0.68;
    state.mapSearch = '';
    state.selectedStarId = '';
    state.tlPlaying = false;
    state.tlPos = 1;
    if ($('xx-tl-play')) $('xx-tl-play').textContent = '▶';
    $('xx-map-search').value = '';
    syncTimelineCut();
    renderSelectedStarDetail(null);
    drawStarMap(null);
  });

  // Timeline (年輪) Scrubber & Playback Controls
  $('xx-tl-range')?.addEventListener('input', (e) => {
    state.tlPlaying = false;
    if ($('xx-tl-play')) $('xx-tl-play').textContent = '▶';
    state.tlPos = Math.max(0, Math.min(1, Number(e.target.value) / 1000));
    syncTimelineCut();
    drawStarMap(null);
  });

  $('xx-tl-play')?.addEventListener('click', () => {
    state.tlPlaying = !state.tlPlaying;
    if (state.tlPlaying && state.tlPos >= 0.995) {
      state.tlPos = 0;
    }
    if ($('xx-tl-play')) $('xx-tl-play').textContent = state.tlPlaying ? 'Ⅱ' : '▶';
    syncTimelineCut();
    drawStarMap(null);
  });

  $('xx-tl-reset')?.addEventListener('click', () => {
    state.tlPlaying = false;
    state.tlPos = 1;
    if ($('xx-tl-play')) $('xx-tl-play').textContent = '▶';
    syncTimelineCut();
    drawStarMap(null);
  });

  // ---------- 4. Form Sync Without Clobbering Active Typing or Unsaved Changes ----------
  function setIfClean(el, val, dirtyKey) {
    if (!el || document.activeElement === el) return;
    if (dirtyKey && state.dirty[dirtyKey]) return;
    if (el.type === 'checkbox') el.checked = Boolean(val);
    else el.value = val == null ? '' : String(val);
  }

  function updateWeightSumDisplay() {
    const base = Number($('pol-w-baseline').value) || 0;
    const act = Number($('pol-w-activation').value) || 0;
    const imp = Number($('pol-w-importance').value) || 0;
    const emo = Number($('pol-w-emotion').value) || 0;
    const sum = Math.round((base + act + imp + emo) * 10) / 10;
    const badge = $('pol-w-sum');
    if (badge) {
      badge.textContent = sum === 100 ? '100%' : `${sum}%（儲存時自動調平）`;
    }
  }

  function updateSpeakUpQuietWarning() {
    const qStart = Number($('sp-qStart')?.value);
    const qEnd = Number($('sp-qEnd')?.value);
    const warn = $('sp-quiet-warn');
    if (warn) warn.classList.toggle('hidden', qStart !== qEnd);
  }

  const STANDBY_ALLOW_IDS = new Set([
    'mem-search',
    'mem-show-archived',
    'mem-test-query',
    'btn-mem-test',
    'btn-mem-export',
    'xx-map-search',
    'xx-layout-mode',
    'xx-raw-select',
    'btn-xx-raw-view',
    'xx-tl-play',
    'xx-tl-range',
  ]);

  function updateProjectScopeUI() {
    const scopePill = $('scope-pill');
    const banner = $('standby-banner');
    const sendBtn = $('btn-whisper-send');
    const spSendBtn = $('btn-sp-send');
    const pickupBtn = $('btn-xingxi-pickup');
    const appEl = $('app');

    const isOffline = state.pollFailures >= 3;
    const isStandby = state.inProject === false;

    if (appEl) appEl.classList.toggle('is-standby', isStandby);

    if (isOffline) {
      if (scopePill) {
        scopePill.textContent = '連線中斷';
        scopePill.className = 'scope-pill offline';
      }
      banner.classList.toggle('hidden', !isStandby);
    } else if (isStandby) {
      if (scopePill) {
        scopePill.textContent = '外部工作區待機';
        scopePill.className = 'scope-pill standby';
      }
      banner.classList.remove('hidden');
    } else {
      if (scopePill) {
        scopePill.textContent = '';
        scopePill.className = 'scope-pill hidden';
      }
      banner.classList.add('hidden');
    }

    const controls = document.querySelectorAll(
      '#nest-stage button, #nest-stage input, #nest-stage select, #nest-stage textarea, '
      + '.panels-wrap button, .panels-wrap input, .panels-wrap select, .panels-wrap textarea',
    );
    controls.forEach((el) => {
      if (STANDBY_ALLOW_IDS.has(el.id)) return;
      const perAct = el.dataset?.perAct;
      if (perAct === 'toggleFull' || perAct === 'export') return;
      if (isStandby) {
        if (!el.disabled) {
          el.dataset.standbyDisabled = '1';
          el.disabled = true;
        }
      } else if (el.dataset.standbyDisabled === '1') {
        delete el.dataset.standbyDisabled;
        if (el.dataset.capDisabled !== '1' && el.dataset.busy !== '1') {
          el.disabled = false;
        }
      }
    });

    if (sendBtn && !isStandby && sendBtn.dataset.busy !== '1') sendBtn.disabled = false;
    if (spSendBtn && !isStandby && spSendBtn.dataset.busy !== '1') spSendBtn.disabled = false;
    if (pickupBtn && !isStandby && pickupBtn.dataset.busy !== '1') pickupBtn.disabled = false;
  }

  const lastRenderedHtml = new WeakMap();
  const lastRenderedText = new WeakMap();

  function setHtmlStable(el, html, { preserveSelectors = [] } = {}) {
    if (!el) return false;
    const next = String(html ?? '');
    if (lastRenderedHtml.get(el) === next) return false;

    const parentScrollTop = el.scrollTop || 0;
    const nestedScrolls = [];
    for (const sel of preserveSelectors) {
      el.querySelectorAll(sel).forEach((node) => {
        const key = node.dataset?.previewId || node.dataset?.scrollId || '';
        if (key && node.scrollTop) nestedScrolls.push([sel, key, node.scrollTop]);
      });
    }

    el.innerHTML = next;
    lastRenderedHtml.set(el, next);
    if (parentScrollTop) el.scrollTop = parentScrollTop;

    for (const [sel, key, top] of nestedScrolls) {
      const match = [...el.querySelectorAll(sel)].find(
        (node) => (node.dataset?.previewId || node.dataset?.scrollId || '') === key,
      );
      if (match) match.scrollTop = top;
    }
    if (typeof state !== 'undefined' && state.armedConfirm && state.armedConfirm.expiresAt > Date.now() && state.armedConfirm.selector && typeof el.querySelector === 'function') {
      const armedEl = el.querySelector(state.armedConfirm.selector);
      if (armedEl) {
        armedEl.dataset.origLabel = state.armedConfirm.origText;
        armedEl.textContent = '確定？';
        armedEl.classList.add('btn-confirm-armed');
        state.armedConfirm.btn = armedEl;
      }
    }
    return true;
  }

  function setTextStable(el, text) {
    if (!el) return false;
    const next = String(text ?? '');
    if (lastRenderedText.get(el) === next && el.textContent === next) return false;
    const prevTop = el.scrollTop || 0;
    el.textContent = next;
    lastRenderedText.set(el, next);
    if (prevTop) el.scrollTop = prevTop;
    return true;
  }

  function renderMemoryList(memory) {
    const listWrap = $('mem-list');
    if (!listWrap) return;
    if (state.editingMemId && listWrap.contains(document.activeElement)) return;

    const showArch = Boolean($('mem-show-archived')?.checked);
    const query = String($('mem-search')?.value || '').trim().toLowerCase();
    let memList = showArch ? [...memory.active, ...memory.archived] : memory.active;
    if (query) {
      memList = memList.filter((m) =>
        [m.text, m.factKey, ...(m.tags || [])].some((v) => String(v || '').toLowerCase().includes(query)),
      );
    }

    const nextHtml = memList.map((m) => {
      const isEditing = state.editingMemId === m.id;
      return `
        <div class="row-item">
          <div class="row-top">
            <span>鮮活 ${(m.freshness * 100).toFixed(0)}% · 重要 ${m.importance}${m.factKey ? ` · 鍵:${esc(m.factKey)}` : ''}${m.category === 'stable_profile' ? ' · 常駐' : ''}${m.superseded ? ' · 【已收起】' : ''}</span>
            <div class="row-actions">
              ${!m.superseded
                ? `<button type="button" class="btn-mini" data-mem-act="reinforce" data-mem-id="${esc(m.id)}">強化</button>
                   <button type="button" class="btn-mini" data-mem-act="toggleEdit" data-mem-id="${esc(m.id)}">${isEditing ? '收合' : '編輯'}</button>
                   <button type="button" class="btn-mini" data-mem-act="supersede" data-mem-id="${esc(m.id)}">收起</button>`
                : `<button type="button" class="btn-mini" data-mem-act="restore" data-mem-id="${esc(m.id)}">復原</button>`}
              <button type="button" class="btn-mini danger" data-mem-act="delete" data-mem-id="${esc(m.id)}">刪除</button>
            </div>
          </div>
          <div class="row-body">${esc(m.text)}</div>
          ${isEditing ? `
            <div class="inline-editor" data-edit-box="${esc(m.id)}">
              <textarea rows="2" class="mem-edit-text">${esc(m.text)}</textarea>
              <div class="field-grid-2">
                <input type="text" class="mem-edit-key" value="${esc(m.factKey || '')}" placeholder="事實鍵（如 主人.飲食）" />
                <input type="number" step="0.05" min="0" max="1" class="mem-edit-imp" value="${esc(m.importance ?? 0.5)}" />
              </div>
              <div class="action-row-end">
                <button type="button" class="btn-mini" data-mem-act="cancelEdit" data-mem-id="${esc(m.id)}">取消</button>
                <button type="button" class="btn-primary" data-mem-act="saveEdit" data-mem-id="${esc(m.id)}">儲存修改</button>
              </div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('') || '<p class="muted-meta">沒有符合條件的記憶條目。</p>';
    setHtmlStable(listWrap, nextHtml);
  }

  function renderPersonaCatalog(persona) {
    const wrap = $('per-catalog');
    if (!wrap) return;
    if (state.renamingPersonaId && wrap.contains(document.activeElement)) return;

    const nextHtml = (persona.catalog || []).map((p) => {
      const isExpanded = state.expandedPersonas.has(p.id);
      const isRenaming = state.renamingPersonaId === p.id;
      const isEffective = p.id === persona.resolvedId;
      return `
        <div class="row-item">
          <div class="row-top">
            <strong>${esc(p.name)}${isEffective ? '（生效中）' : ''}${p.enabled === false ? '（已停用）' : ''}</strong>
            <div class="row-actions">
              <button type="button" class="btn-mini" data-per-act="selectProject" data-per-id="${esc(p.id)}">設為本專案</button>
              <button type="button" class="btn-mini" data-per-act="selectSession" data-per-id="${esc(p.id)}">僅此對話</button>
              <button type="button" class="btn-mini" data-per-act="toggleEnabled" data-per-id="${esc(p.id)}" data-enabled="${p.enabled !== false ? '1' : '0'}">${p.enabled !== false ? '停用' : '啟用'}</button>
              <button type="button" class="btn-mini" data-per-act="toggleFull" data-per-id="${esc(p.id)}">${isExpanded ? '收起全文' : '查看全文'}</button>
              ${!p.builtin ? `<button type="button" class="btn-mini" data-per-act="startRename" data-per-id="${esc(p.id)}">重命名</button>` : ''}
              <button type="button" class="btn-mini" data-per-act="edit" data-per-id="${esc(p.id)}">編輯</button>
              <button type="button" class="btn-mini" data-per-act="export" data-per-id="${esc(p.id)}">匯出</button>
              ${!p.builtin ? `<button type="button" class="btn-mini danger" data-per-act="delete" data-per-id="${esc(p.id)}">刪除</button>` : ''}
            </div>
          </div>
          ${p.note ? `<p class="muted-meta">${esc(p.note)}</p>` : ''}
          ${isRenaming ? `
            <div class="inline-search compact-top" data-rename-box="${esc(p.id)}">
              <input type="text" class="per-rename-input" value="${esc(p.name)}" maxlength="60" />
              <button type="button" class="btn-mini" data-per-act="cancelRename" data-per-id="${esc(p.id)}">取消</button>
              <button type="button" class="btn-primary" data-per-act="saveRename" data-per-id="${esc(p.id)}">儲存名稱</button>
            </div>
          ` : ''}
          ${isExpanded
            ? `<pre class="preview-box" data-preview-id="${esc(p.id)}">${esc(p.text || '（空白正文）')}</pre>`
            : `<div class="row-body row-body-clamped">${esc(p.text || '（空白正文）')}</div>`}
        </div>
      `;
    }).join('');
    setHtmlStable(wrap, nextHtml, { preserveSelectors: ['.preview-box[data-preview-id]'] });
  }

  function renderSpritesGrid(sprites) {
    const wrap = $('per-sprites-grid');
    if (!wrap) return;
    const list = Array.isArray(sprites) ? sprites : [];
    const anyCustom = list.some((s) => s.isCustom);
    const resetAllBtn = $('btn-per-sprites-reset-all');
    if (resetAllBtn) resetAllBtn.classList.toggle('hidden', !anyCustom);

    const nextHtml = list.map((s) => `
      <div class="sprite-slot" data-sprite-slot="${esc(s.key)}">
        <img class="sprite-thumb" src="${esc(s.url)}" alt="${esc(s.label)}立繪" loading="lazy" />
        <span class="sprite-slot-title">${esc(s.label)}</span>
        <div class="sprite-slot-actions">
          <label class="btn-mini file-btn">
            更換
            <input type="file" accept="image/png,image/jpeg,image/webp" class="sr-only" data-sprite-upload="${esc(s.key)}" />
          </label>
          ${s.isCustom ? `<button type="button" class="btn-mini" data-sprite-reset="${esc(s.key)}">恢復</button>` : ''}
        </div>
      </div>
    `).join('');
    setHtmlStable(wrap, nextHtml);
  }

  function renderSpeakUpTargets(speakUp, verifiedConversations) {
    const follow = Boolean($('sp-followActive')?.checked ?? speakUp.config.followActive);
    const wrap = $('sp-targets-wrap');
    if (wrap) wrap.classList.toggle('hidden', follow);

    const listEl = $('sp-targets-list');
    if (!listEl) return;
    const selectedSet = new Set(speakUp.config.targetConversations || []);
    const verifiedIds = new Set((verifiedConversations || []).map((c) => c.conversationId));

    const itemsHtml = (verifiedConversations || []).map((c) => {
      const id = c.conversationId;
      const checked = selectedSet.has(id);
      const seenLabel = c.lastUserSpeechAt ? new Date(c.lastUserSpeechAt).toLocaleTimeString() : '尚無發言時間';
      return `
        <label class="check-row row-item" style="flex-direction:row;align-items:center;justify-content:space-between;">
          <span style="display:flex;align-items:center;gap:7px;min-width:0;">
            <input type="checkbox" class="sp-target-cb" data-conv-id="${esc(id)}" ${checked ? 'checked' : ''} />
            <span class="tabular">對話 …${esc(id.slice(-10))}</span>
          </span>
          <span class="muted-meta">${esc(seenLabel)}</span>
        </label>
      `;
    }).join('');

    setHtmlStable(
      listEl,
      itemsHtml || '<p class="muted-meta">目前尚未偵測到其他已登記的 gemini_cat 對話（在本專案發一則訊息即可自動登記）。</p>',
    );

    const manualIds = [...selectedSet].filter((id) => !verifiedIds.has(id));
    setIfClean($('sp-manual-targets'), manualIds.join(', '), 'sp');
  }

  function renderSnapshot(snap, opts = {}) {
    state.snap = snap;
    if (!snap) return;

    const { nest, mood, memory, xingxi, speakUp, persona } = snap;
    const actAt = Number(nest.activity?.updatedAt || 0);
    const careAt = Number(nest.lastCareAt || 0);
    const spAt = Number(speakUp?.lastTriggeredAt || 0);

    if (!state.hasInitialSnap) {
      state.hasInitialSnap = true;
      state.seenActivityAt = actAt;
      state.seenLastCareAt = careAt;
      state.seenSpeakUpAt = spAt;
      if (actAt && (Date.now() - actAt) < 2500 && (nest.activity?.phase === 'thinking' || nest.activity?.phase === 'tool')) {
        activateSpriteMotion(2000);
      }
    } else {
      const activityAdvanced = actAt > state.seenActivityAt;
      const careAdvanced = careAt > state.seenLastCareAt;
      const speakUpAdvanced = spAt > state.seenSpeakUpAt;
      const spriteChanged = Boolean(state.currentSpriteUrl && nest.sprite && nest.sprite !== state.currentSpriteUrl);
      state.seenActivityAt = Math.max(state.seenActivityAt, actAt);
      state.seenLastCareAt = Math.max(state.seenLastCareAt, careAt);
      state.seenSpeakUpAt = Math.max(state.seenSpeakUpAt, spAt);

      if (!opts.suppressMotion && (activityAdvanced || careAdvanced || speakUpAdvanced || spriteChanged)) {
        activateSpriteMotion(2200);
      }
    }

    // Stage Hero (Single deduplicated mood readout)
    if ($('hdr-persona-pill')) $('hdr-persona-pill').textContent = persona.resolvedName || '人設待選';
    if ($('hdr-emoji')) $('hdr-emoji').textContent = mood.emoji;
    if ($('hdr-mood-text')) $('hdr-mood-text').textContent = mood.moodLabel || '';
    if ($('val-mood')) $('val-mood').textContent = mood.mood;
    if ($('val-mood-mirror')) $('val-mood-mirror').textContent = mood.mood;
    $('activity-text').textContent = nest.activity?.label || '在貓窩裡等你回來…';

    const dot = $('activity-badge');
    dot.className = 'activity-dot' + (
      nest.sleeping ? ' sleep'
      : (nest.activity?.phase === 'thinking' || nest.activity?.phase === 'tool') ? ' busy'
      : ''
    );

    renderSprite(nest.sprite, nest.spriteUrl);

    if ($('bar-mood')) $('bar-mood').style.width = `${mood.mood}%`;
    const bondInLevel = nest.bondInLevel ?? ((nest.bond || 0) % 50);
    const bondProgress = nest.bondProgress ?? Math.round(bondInLevel * 2);
    const todayCareCount = nest.todayCareCount ?? 0;
    const todayWarmth = nest.todayWarmth ?? Math.min(100, todayCareCount * 14);
    $('bar-satiety').style.width = `${bondProgress}%`;
    $('val-satiety').textContent = `${bondInLevel}/50`;
    $('bar-energy').style.width = `${todayWarmth}%`;
    $('val-energy').textContent = `${todayCareCount} 次`;
    $('val-bond').textContent = `Lv.${nest.bondLevel}`;

    const napBtn = $('btn-nap');
    const napLabel = napBtn.querySelector('.btn-label');
    if (napLabel) napLabel.textContent = nest.sleeping ? '叫醒她' : '打盹';
    napBtn.classList.toggle('active', Boolean(nest.sleeping));

    const limits = nest.limits || {};
    document.querySelectorAll('.care-btn[data-action]').forEach((btn) => {
      const act = btn.dataset.action;
      const lim = limits[act];
      const badge = btn.querySelector('.care-badge');
      if (!lim) return;
      const dailyCap = Number(lim.dailyCap || 0);
      const dailyUsed = Number(lim.dailyUsed || 0);
      const dailyCapped = dailyCap > 0 && dailyUsed >= dailyCap;
      btn.dataset.capDisabled = dailyCapped ? '1' : '';
      if (btn.dataset.busy !== '1' && btn.dataset.standbyDisabled !== '1') {
        btn.disabled = dailyCapped;
      }
      const blocked = dailyCapped || lim.cooldownLeftSec > 0 || Boolean(lim.blockedReason);
      btn.classList.toggle('on-cooldown', blocked);
      btn.title = lim.blockedReason
        || (lim.cooldownLeftSec > 0 ? `冷卻中，還需 ${lim.cooldownLeftSec} 秒` : `今日已互動 ${lim.dailyUsed}/${lim.dailyCap} 次`);
      if (badge) {
        badge.textContent = lim.cooldownLeftSec > 0
          ? `${lim.cooldownLeftSec}s`
          : `${lim.dailyUsed}/${lim.dailyCap}`;
      }
    });

    if (document.activeElement !== $('nest-sync-chat')) {
      $('nest-sync-chat').checked = Boolean(nest.syncChatOnCare);
    }
    const pendingCount = Number(nest.pendingCount || 0);
    $('nest-pending-text').textContent = `待帶入：${pendingCount} 則`;
    $('btn-nest-clear').classList.toggle('hidden', pendingCount <= 0);

    // Tab 1: Mood
    if ($('mood-engine-badge')) $('mood-engine-badge').textContent = mood.judgeLabel || '對話內 AI ＋ 本地兜底';
    const thoughtCard = $('mood-inner-thought-card');
    if (thoughtCard) {
      const thoughtEnabled = mood.config.innerThoughtEnabled !== false;
      const thoughtText = String(mood.lastInnerThought || '').trim();
      if (!thoughtEnabled) {
        $('mood-thought-meta').textContent = '已關閉';
        $('mood-inner-thought').textContent = '已關閉內心獨白記錄。';
      } else if (thoughtText) {
        const tsStr = mood.lastInnerThoughtAt ? new Date(mood.lastInnerThoughtAt).toLocaleTimeString() : '剛才';
        $('mood-thought-meta').textContent = `${tsStr}`;
        $('mood-inner-thought').textContent = thoughtText;
      } else {
        $('mood-thought-meta').textContent = '等待寫下';
        $('mood-inner-thought').textContent = '本輪尚無內心獨白。';
      }
    }

    setHtmlStable($('mood-dims-grid'), mood.dims.map((d) => `
      <div class="dim-item">
        <div class="dim-head"><span>${esc(d.label)}</span><strong>${d.value}</strong></div>
        <div class="dim-track"><div class="dim-bar" style="width:${Math.min(100, d.value)}%"></div></div>
      </div>
    `).join(''));

    const injectStateLabels = {
      pending: '待注入',
      ready: '就緒',
      idle: '待命',
      none: '待命',
      off: '不注入',
      disabled: '已停用',
      exhausted: '已達上限',
      capped: '已達上限',
      cooldown: '冷卻中',
    };
    const rawInjState = String(mood.injectPreview.state || '').trim();
    const injStateLabel = injectStateLabels[rawInjState.toLowerCase()] || rawInjState || '待命';
    $('mood-inject-state').textContent = injStateLabel;
    const injLimitText = mood.injectQuota.unlimited ? '不限' : String(mood.injectQuota.cap);
    const chQuota = mood.changeQuota || { count: 0, cap: 0, unlimited: true };
    const chLimitText = chQuota.unlimited || chQuota.cap === 0 ? '不限' : String(chQuota.cap);
    $('mood-quota-text').textContent = `提醒 ${mood.injectQuota.said}/${injLimitText} · 變化 ${chQuota.count}/${chLimitText}`;
    $('mood-inject-preview').textContent = mood.injectPreview.text || `（${injStateLabel}，暫無待注入內容）`;

    setIfClean($('cfg-mood-enabled'), mood.config.enabled !== false, 'mood');
    setIfClean($('cfg-mood-autoJudge'), mood.config.autoJudge !== false, 'mood');
    setIfClean($('cfg-mood-innerThoughtEnabled'), mood.config.innerThoughtEnabled !== false, 'mood');
    setIfClean($('cfg-mood-judgeMode'), mood.config.judgeMode, 'mood');
    setIfClean($('cfg-mood-injectMode'), mood.config.injectMode, 'mood');
    setIfClean($('cfg-mood-ownerName'), mood.config.ownerName, 'mood');
    setIfClean($('cfg-mood-selfName'), mood.config.selfName, 'mood');
    setIfClean($('cfg-mood-selfPronoun'), mood.config.selfPronoun || '我', 'mood');
    setIfClean($('cfg-mood-selfAliases'), mood.config.selfAliases || '', 'mood');
    setIfClean($('cfg-mood-ownerAliases'), mood.config.ownerAliases || '', 'mood');
    setIfClean($('cfg-mood-base'), mood.config.moodBase, 'mood');
    setIfClean($('cfg-mood-floor'), mood.config.moodFloor, 'mood');
    setIfClean($('cfg-mood-halfHours'), mood.config.decayHalfHours, 'mood');
    setIfClean($('cfg-mood-stepDivisor'), mood.config.stepDivisor ?? 3, 'mood');
    setIfClean($('cfg-mood-conf'), mood.config.injectConfidence, 'mood');
    setIfClean($('cfg-mood-sigMood'), mood.config.sigMood, 'mood');
    setIfClean($('cfg-mood-sigDim'), mood.config.sigDim, 'mood');
    setIfClean($('cfg-mood-changesPerDay'), mood.config.changesPerDay ?? 0, 'mood');
    setIfClean($('cfg-mood-perDay'), mood.config.injectPerDay, 'mood');
    setIfClean($('cfg-mood-injectUnlimited'), Boolean(mood.config.injectUnlimited), 'mood');
    if ($('cfg-mood-perDay')) $('cfg-mood-perDay').disabled = Boolean($('cfg-mood-injectUnlimited')?.checked);
    setIfClean($('cfg-mood-rulePrompt'), mood.config.inChatRulePrompt || mood.defaultRulePrompt || '', 'mood');

    setHtmlStable($('mood-timeline'), (mood.timeline || []).map((t) => `
      <div class="row-item">
        <div class="row-top">
          <span>${new Date(t.at).toLocaleTimeString()} · ${esc(t.kind || 'chat')}</span>
          <strong class="tabular">心情 ${t.mood} (${t.delta >= 0 ? `+${t.delta}` : t.delta})</strong>
        </div>
        <div class="row-body">${esc(t.reason || '無說明')}${t.innerThought ? `<div class="thought-note">「${esc(t.innerThought)}」</div>` : ''}</div>
      </div>
    `).join('') || '<p class="muted-meta">還沒有心情變化記錄，在對話裡聊幾句自然會記錄下來。</p>');

    // Tab 2: Memory
    $('mem-counts-badge').textContent = `${memory.activeCount} 活躍 / ${memory.archivedCount} 收起`;
    $('mem-ruler-badge').textContent = `說話尺樣本 ${memory.rulerSamples || 0}`;
    renderMemoryList(memory);

    const traceBox = $('mem-traces-list');
    if (traceBox) {
      setHtmlStable(traceBox, (memory.traces || []).map((tr) => `
        <div class="row-item">
          <div class="row-top">
            <span>${tr.at ? esc(new Date(tr.at).toLocaleTimeString()) : ''} · 問句：「${esc(tr.query)}」</span>
            <strong>${tr.gateBlocked ? '門檻擋掉' : `命中 ${Number(tr.selectedIds?.length || 0)} 條`}</strong>
          </div>
          <div class="row-body">${(tr.rows || []).slice(0, 5).map((r) => `[${esc(r.omission)}] P=${esc(r.P)} ${esc(r.text)}`).join('\n') || '（無候選）'}</div>
        </div>
      `).join('') || '<p class="muted-meta">尚無召回追溯記錄。</p>');
    }

    setIfClean($('pol-enabled'), memory.policy.enabled !== false, 'policy');
    setIfClean($('pol-ownerPronoun'), memory.policy.ownerPronoun || 'ta', 'policy');
    setIfClean($('pol-selfPronoun'), memory.policy.selfPronoun || '我', 'policy');
    setIfClean($('pol-w-baseline'), Math.round((memory.policy.baselineWeight ?? 0.55) * 1000) / 10, 'policy');
    setIfClean($('pol-w-activation'), Math.round((memory.policy.activationWeight ?? 0.25) * 1000) / 10, 'policy');
    setIfClean($('pol-w-importance'), Math.round((memory.policy.importanceWeight ?? 0.15) * 1000) / 10, 'policy');
    setIfClean($('pol-w-emotion'), Math.round((memory.policy.emotionWeight ?? 0.05) * 1000) / 10, 'policy');
    if (!state.dirty.policy) updateWeightSumDisplay();
    setIfClean($('pol-threshold'), memory.policy.threshold, 'policy');
    setIfClean($('pol-rarityK'), memory.policy.rarityK, 'policy');
    setIfClean($('pol-maxItems'), memory.policy.maxItems, 'policy');
    setIfClean($('pol-maxChars'), memory.policy.maxChars, 'policy');
    setIfClean($('pol-queryGate'), memory.policy.queryGate, 'policy');
    setIfClean($('pol-unknownAct'), memory.policy.unknownActivation, 'policy');
    setIfClean($('pol-halfLife'), memory.policy.baseHalfLifeDays, 'policy');
    setIfClean($('pol-emotionHalfLife'), memory.policy.emotionHalfLifeDays, 'policy');
    setIfClean($('pol-dailyQuota'), memory.policy.dailyQuota, 'policy');
    setIfClean($('pol-repeatWindow'), memory.policy.repeatWindow ?? 15, 'policy');
    setIfClean($('pol-factCap'), memory.policy.factCap ?? 1, 'policy');
    setIfClean($('pol-rulePrompt'), memory.policy.inChatRulePrompt || memory.defaultRuleTemplate || '', 'policy');

    // Tab 3: Xingxi
    $('xingxi-stats-badge').textContent = `${xingxi.stars.length} 顆星 · ${xingxi.fileCount} 檔案`;
    setTextStable($('xingxi-card-raw'), xingxi.cardText || '');
    drawStarMap(xingxi);

    const backups = xingxi.backups || [];
    $('xingxi-backup-badge').textContent = `${backups.length} 份`;
    setHtmlStable($('xingxi-backups-list'), backups.map((b) => `
      <div class="row-item">
        <div class="row-top">
          <span>${esc(b.file)} · ${esc(b.time)} (${b.size} B)</span>
          <button type="button" class="btn-mini" data-xx-restore="${esc(b.backup)}">還原</button>
        </div>
      </div>
    `).join('') || '<p class="muted-meta">尚未產生記憶卡備份（修改或合併章節時會自動建立，最多保留 20 份）。</p>');

    const rawSel = $('xx-raw-select');
    if (rawSel && document.activeElement !== rawSel) {
      const prevRaw = rawSel.value;
      const rawLogs = xingxi.rawLogs || [];
      const rawHtml = rawLogs.length
        ? rawLogs.map((r) => `<option value="${esc(r.name)}">${esc(r.name)} (${r.chars} 字)</option>`).join('')
        : '<option value="">尚無切存原始對話</option>';
      setHtmlStable(rawSel, rawHtml);
      if (prevRaw && rawLogs.some((r) => r.name === prevRaw) && rawSel.value !== prevRaw) {
        rawSel.value = prevRaw;
      }
    }

    const sc = xingxi.scheduleConfig || {};
    const pad2 = (n) => String(Math.max(0, Number(n) || 0)).padStart(2, '0');
    const schedTime = `${pad2(sc.scheduleHour ?? 23)}:${pad2(sc.scheduleMinute ?? 30)}`;
    $('xingxi-sched-badge').textContent = sc.autoScheduleEnabled ? `每日 ${schedTime}` : '定時已停用';
    setIfClean($('xingxi-sched-enabled'), Boolean(sc.autoScheduleEnabled));
    setIfClean($('xingxi-sched-time'), schedTime);
    setIfClean($('xingxi-sched-mode'), sc.scheduleMode || 'both');
    const lastRunText = sc.lastScheduledDate ? `上次定時：${sc.lastScheduledDate}` : '尚未觸發定時';
    $('xingxi-sched-summary').textContent =
      `今日切存素材 ${xingxi.todayMaterialChars || 0} 字 · ${lastRunText}${sc.lastStatus ? ` · ${sc.lastStatus}` : ''}`;
    setHtmlStable($('xingxi-sched-logs'), (sc.logs || []).slice(0, 6).map((l) => `
      <div class="row-item">
        <div class="row-top"><span>${esc(l.time || '')}</span></div>
        <div class="row-body">${esc(l.text || '')}</div>
      </div>
    `).join('') || '<p class="muted-meta">尚無拾星排程紀錄。</p>');

    setHtmlStable($('xingxi-diary-list'), (xingxi.diaries || []).map((d) => {
      const open = state.expandedDiaries.has(d.name);
      return `
        <div class="row-item diary-card" data-diary-name="${esc(d.name)}">
          <div class="row-top">
            <strong>${esc(d.name)}</strong>
            <span class="tabular">${d.chars} 字 · ${open ? '收起' : '展開全文'}</span>
          </div>
          <div class="row-body">${esc(open ? (d.text || d.preview || '') : (d.preview || ''))}</div>
        </div>
      `;
    }).join('') || '<p class="muted-meta">尚無日記檔案；每日拾星或手動寫日記後會於開新對話自動帶入最近 3 天。</p>');

    // Tab 4: Speak-Up
    const spPrev = speakUp.preview;
    const plans = speakUp.state?.plans || [];
    const routines = speakUp.state?.routines || [];
    const aiOn = speakUp.config.aiPlanEnabled !== false;
    const diceOn = speakUp.config.diceEnabled !== false;
    const modeChip = !speakUp.config.enabled
      ? '總開關關閉'
      : aiOn && diceOn
        ? `AI排程 + 擲骰 ${spPrev.hitLine}%`
        : aiOn
          ? `純AI排程 (${plans.length + routines.filter((r) => r.enabled).length}項)`
          : diceOn
            ? `純擲骰 ${spPrev.hitLine}%`
            : '雙模式皆關';
    $('sp-line-badge').textContent = modeChip;

    const spWindowLabel = !spPrev.usePeakValley
      ? '【全天統一命中率】'
      : spPrev.peak
        ? `【峰時 ${spPrev.peakWindowsText || ''}】`
        : '【谷時（非峰時）】';
    const nextPlanAt = plans[0]?.triggerAt || routines.filter((r) => r.enabled && r.nextTriggerAt > 0).map((r) => r.nextTriggerAt).sort((a, b) => a - b)[0] || 0;
    const nextStr = nextPlanAt ? ` ｜ 下個預約：${new Date(nextPlanAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '';
    const maxUnans = Number(speakUp.config.maxUnansweredSpontaneous ?? 2);
    const curUnans = Number(spPrev.unansweredCount ?? speakUp.state?.unansweredCount ?? 0);
    const unansTag = maxUnans > 0 ? ` ｜ 未回 ${curUnans}/${maxUnans}` : (curUnans > 0 ? ` ｜ 未回 ${curUnans}` : '');

    const silenceBar = $('sp-silence-bar');
    if (silenceBar) {
      if (spPrev.isSilenced && spPrev.silentUntil > 0) {
        silenceBar.classList.remove('hidden');
        const untilStr = new Date(spPrev.silentUntil).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        $('sp-silence-text').textContent = `自主勿擾至 ${untilStr}${spPrev.silentReason ? `（${spPrev.silentReason}）` : ''}，明確提醒仍會準點通知`;
      } else {
        silenceBar.classList.add('hidden');
      }
    }

    $('sp-preview-text').textContent =
      (diceOn
        ? `${spWindowLabel} 基礎 ${spPrev.baseLine}% × 時機因子 ${spPrev.factor} + 連沒中加成 ${spPrev.bonus}% = 命中線 ${spPrev.hitLine}%`
        : '傳統隨機擲骰已關閉，僅依 AI 預約時刻表與固定節律執行')
      + nextStr
      + unansTag
      + (spPrev.inQuiet ? '（目前在安靜時段內）' : '')
      + (speakUp.config.dryRun ? ' ｜ 試運行模式開啟中' : '');

    setIfClean($('sp-enabled'), speakUp.config.enabled, 'sp');
    setIfClean($('sp-aiPlanEnabled'), aiOn, 'sp');
    setIfClean($('sp-diceEnabled'), diceOn, 'sp');
    setIfClean($('sp-dryRun'), speakUp.config.dryRun, 'sp');
    setIfClean($('sp-followActive'), speakUp.config.followActive !== false, 'sp');
    setIfClean($('sp-diceBlockActiveChat'), speakUp.config.diceBlockActiveChat !== false, 'sp');
    setIfClean($('sp-suppressBeforeReminder'), speakUp.config.suppressDiceBeforeReminder !== false, 'sp');
    setIfClean($('sp-proactiveCueEnabled'), speakUp.config.proactiveCueEnabled !== false, 'sp');
    setIfClean($('sp-scheduleTendency'), speakUp.config.scheduleTendency || 'high', 'sp');
    renderSpeakUpTargets(speakUp, snap.verifiedConversations || []);

    const fmtClock = (ms) => new Date(ms).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    const dayLabels = ['日', '一', '二', '三', '四', '五', '六'];
    setHtmlStable($('sp-plans-list'), plans.map((p) => {
      const kindBadge = p.kind === 'reminder' ? '明確提醒' : '自主決定';
      const jitterTag = p.jitterMin ? `（原約 ${fmtClock(p.baseAt)} ±${p.jitterMin}m）` : '';
      return `
        <div class="row-item">
          <div class="row-top">
            <span><span class="pill-kind">${kindBadge}</span> <strong>${esc(fmtClock(p.triggerAt))}</strong> ${esc(jitterTag)}</span>
            <button type="button" class="btn-mini btn-danger" data-sp-del-plan="${esc(p.id)}">刪除</button>
          </div>
          <div class="row-body">${esc(p.label || '預約搭話')}${p.thought ? `<div class="thought-note">「${esc(p.thought)}」</div>` : ''}</div>
        </div>
      `;
    }).join('') || '<p class="muted-meta">目前沒有預約時間；直接在對話裡告訴她「幾分鐘後叫我」或讓她自己安排。</p>');

    $('sp-routines-count').textContent = `${routines.length} 條`;
    setHtmlStable($('sp-routines-list'), routines.map((r) => {
      const daysText = (r.days && r.days.length < 7)
        ? r.days.map((d) => `週${dayLabels[d] ?? d}`).join('、')
        : '每天';
      const nextTime = r.nextTriggerAt ? fmtClock(r.nextTriggerAt) : '待排程';
      return `
        <div class="row-item">
          <div class="row-top">
            <span><strong>${esc(r.timeHHMM)} ±${r.jitterMin}m</strong> · ${esc(daysText)} · 下次 ${esc(nextTime)}</span>
            <div class="btn-group-compact">
              <button type="button" class="btn-mini" data-sp-toggle-rt="${esc(r.id)}">${r.enabled ? '停用' : '啟用'}</button>
              <button type="button" class="btn-mini" data-sp-reroll-rt="${esc(r.id)}" title="在隨機波動範圍內重抽下次時間">重抽</button>
              <button type="button" class="btn-mini btn-danger" data-sp-del-rt="${esc(r.id)}">刪除</button>
            </div>
          </div>
          <div class="row-body">${esc(r.label || r.timeHHMM)}${r.enabled ? '' : '（已停用）'}${r.thought ? `<div class="thought-note">「${esc(r.thought)}」</div>` : ''}</div>
        </div>
      `;
    }).join('') || '<p class="muted-meta">尚未設定固定波動節律；可用自然語言或點下方新增（如「每天 12:30 ±20 分」）。</p>');

    setIfClean($('sp-usePeakValley'), speakUp.config.usePeakValley !== false, 'sp');
    setIfClean($('sp-peakWindows'), speakUp.config.peakWindowsText || '09:00-12:00, 14:00-18:00', 'sp');
    const peakDaysSet = new Set(Array.isArray(speakUp.config.peakDays) ? speakUp.config.peakDays : [1, 2, 3, 4, 5]);
    const daysWrap = $('sp-peakDays');
    if (daysWrap && !daysWrap.contains(document.activeElement) && !state.dirty.sp) {
      daysWrap.querySelectorAll('input[data-day]').forEach((cb) => {
        cb.checked = peakDaysSet.has(Number(cb.dataset.day));
      });
    }
    setIfClean($('sp-peak'), speakUp.config.peakHitLine, 'sp');
    setIfClean($('sp-valley'), speakUp.config.valleyHitLine, 'sp');
    setIfClean($('sp-timezone'), speakUp.config.timezone, 'sp');
    setIfClean($('sp-interval'), speakUp.config.intervalMinutes, 'sp');
    setIfClean($('sp-cooldown'), speakUp.config.cooldownMin, 'sp');
    setIfClean($('sp-activeGap'), speakUp.config.respectActiveChatGapMin ?? 8, 'sp');
    setIfClean($('sp-maxUnanswered'), speakUp.config.maxUnansweredSpontaneous ?? 2, 'sp');
    setIfClean($('sp-reminderSuppressMin'), speakUp.config.suppressBeforeReminderMin ?? 120, 'sp');
    setIfClean($('sp-bonus'), speakUp.config.missBonus, 'sp');
    setIfClean($('sp-cap'), speakUp.config.bonusCap, 'sp');
    setIfClean($('sp-qStart'), speakUp.config.quietStartHour, 'sp');
    setIfClean($('sp-qEnd'), speakUp.config.quietEndHour, 'sp');
    updateSpeakUpQuietWarning();
    setIfClean($('sp-nearMin'), speakUp.config.nearThresholdMin, 'sp');
    setIfClean($('sp-nearFactor'), speakUp.config.nearFactor, 'sp');
    setIfClean($('sp-farMin'), speakUp.config.farThresholdMin, 'sp');
    setIfClean($('sp-farFactor'), speakUp.config.farFactor, 'sp');
    setIfClean($('sp-rulePrompt'), speakUp.config.inChatRulePrompt || speakUp.defaultInChatRulePrompt || '', 'sp');
    setIfClean($('sp-prompt'), speakUp.config.triggerPrompt, 'sp');
    setIfClean($('sp-followUpPrompt'), speakUp.config.followUpHintPrompt || speakUp.defaultFollowUpHintPrompt || '', 'sp');

    const fb = speakUp.freshBrowse || {};
    const fbCfg = fb.config || {};
    const fbStat = fb.status || {};
    const fbItems = Array.isArray(fb.items) ? fb.items : [];
    const fbShared = Array.isArray(fb.recentShared) ? fb.recentShared : [];
    const fbCustomFeeds = Array.isArray(fbCfg.customFeeds) ? fbCfg.customFeeds : [];
    const fbBadge = $('sp-fresh-badge');
    if (fbBadge) {
      fbBadge.textContent = fbCfg.enabled
        ? `已啟用 · 今日分享 ${fbStat.todayShareCount || 0}/${fbCfg.dailyShareLimit ?? 2}`
        : '已關閉';
    }
    setIfClean($('sp-freshEnabled'), Boolean(fbCfg.enabled), 'sp');
    const fbPresetSet = new Set(Array.isArray(fbCfg.presets) ? fbCfg.presets : []);
    const fbPresetsWrap = $('sp-freshPresets');
    if (fbPresetsWrap && !fbPresetsWrap.contains(document.activeElement) && !state.dirty.sp) {
      fbPresetsWrap.querySelectorAll('input[data-fresh-preset]').forEach((cb) => {
        cb.checked = fbPresetSet.has(cb.dataset.freshPreset);
      });
    }
    setIfClean($('sp-freshWeatherCity'), fbCfg.weatherCity || '', 'sp');
    setIfClean($('sp-freshDailyLimit'), fbCfg.dailyShareLimit ?? 2, 'sp');
    setIfClean($('sp-freshMaxAgeHours'), fbCfg.maxAgeHours ?? 72, 'sp');
    const fbTimes = Array.isArray(fbCfg.fetchTimes) ? fbCfg.fetchTimes : ['10:00', '17:00'];
    setIfClean($('sp-freshTime1'), fbTimes[0] || '', 'sp');
    setIfClean($('sp-freshTime2'), fbTimes[1] || '', 'sp');
    if ($('sp-freshWeatherResolved')) {
      $('sp-freshWeatherResolved').textContent = fbCfg.weatherResolvedLabel
        ? `目前天氣定位：${fbCfg.weatherResolvedLabel}`
        : (fbCfg.weatherCity
            ? `城市「${fbCfg.weatherCity}」尚未定位（按「儲存搭話設定」或「立即逛一逛」驗證）`
            : '未設定城市（勾選「異常天氣」時可填高雄、台北、Taipei 等）');
    }
    if ($('sp-fresh-feeds-count')) {
      $('sp-fresh-feeds-count').textContent = `${fbCustomFeeds.length} 個`;
    }
    setHtmlStable($('sp-freshFeedsList'), fbCustomFeeds.map((f) => `
      <div class="row-item">
        <div class="row-top">
          <span><strong>${esc(f.label)}</strong>${f.enabled === false ? '（停用中）' : ''}</span>
          <div class="btn-group-compact">
            <button type="button" class="btn-mini" data-sp-toggle-feed="${esc(f.id)}">${f.enabled === false ? '啟用' : '停用'}</button>
            <button type="button" class="btn-mini btn-danger" data-sp-del-feed="${esc(f.id)}">移除</button>
          </div>
        </div>
        <div class="row-body muted-meta">${esc(f.url)}</div>
      </div>
    `).join('') || '<p class="muted-meta">尚未加入自訂 RSS 或 YouTube 頻道；可直接沿用上方精選分類。</p>');

    if ($('sp-fresh-status-line')) {
      const checkTime = fbStat.lastCheckedAt ? fmtClock(fbStat.lastCheckedAt) : '尚未檢查';
      const errNote = fbStat.lastError ? ` ｜ 注意：${fbStat.lastError}` : '';
      $('sp-fresh-status-line').textContent = `最近檢查：${checkTime} ｜ 今日抓取 ${fbStat.todayFetchCount || 0} 次 ｜ 待挑選 ${fbItems.length} 則${errNote}`;
    }

    const renderFreshItemRow = (item, isShared = false) => {
      const safeHref = /^https:\/\//i.test(String(item.url || '')) ? item.url : '';
      const titleHtml = safeHref
        ? `<a href="${esc(safeHref)}" target="_blank" rel="noopener noreferrer">${esc(item.title)}</a>`
        : esc(item.title);
      const timeRef = isShared ? item.sharedAt : (item.publishedAt || item.fetchedAt);
      const tag = isShared ? '<span class="pill-kind">已提供參考</span> ' : '';
      return `
        <div class="row-item">
          <div class="row-top">
            <span>${tag}<strong>${esc(item.source || '外部見聞')}</strong></span>
            <span class="muted-meta tabular">${timeRef ? esc(fmtClock(timeRef)) : ''}</span>
          </div>
          <div class="row-body">${titleHtml}${item.summary ? `<div class="thought-note">${esc(item.summary)}</div>` : ''}</div>
        </div>
      `;
    };
    const combinedFreshHtml = [
      ...fbItems.map((it) => renderFreshItemRow(it, false)),
      ...fbShared.slice(0, 3).map((it) => renderFreshItemRow(it, true)),
    ].join('');
    setHtmlStable($('sp-freshItemsList'), combinedFreshHtml || '<p class="muted-meta">目前見聞籃是空的；啟用後會依設定時段自動各逛一次，也可按右上「立即逛一逛」試抓。</p>');

    setHtmlStable($('sp-logs'), (speakUp.state.logs || []).map((l) => `
      <div class="row-item">
        <div class="row-top"><span>${esc(l.time)}</span></div>
        <div class="row-body">${esc(l.text)}</div>
      </div>
    `).join('') || '<p class="muted-meta">尚無排程與擲骰記錄。點上方「演練擲骰一次」立即試算。</p>');

    // Tab 5: Persona (Strictly gemini_cat project-scoped; zero global tier)
    const sourceLabels = {
      session: '此對話覆寫',
      project: '本專案共用',
      none: '尚未選定',
      project_disabled: '專案已停用',
      session_disabled: '此對話暫停',
    };
    $('per-source-badge').textContent = `${persona.resolvedName}（${sourceLabels[persona.resolvedSource] || persona.resolvedSource}）`;
    if (persona.scopeNotice) $('per-scope-notice').textContent = persona.scopeNotice;
    if (document.activeElement !== $('per-project-enabled')) {
      $('per-project-enabled').checked = Boolean(persona.enabled);
    }
    if (document.activeElement !== $('per-session-disabled')) {
      $('per-session-disabled').checked = Boolean(persona.sessionDisabled);
    }

    const optionsHtml = '<option value="">（不選定／保持空白）</option>' + persona.catalog.map((p) =>
      `<option value="${esc(p.id)}">${esc(p.name)}${p.enabled ? '' : '（停用中）'}</option>`,
    ).join('');

    const selProj = $('per-select-project');
    const selSess = $('per-select-session');
    if (document.activeElement !== selProj) {
      setHtmlStable(selProj, optionsHtml);
      const targetProj = persona.projectDefaultId || '';
      if (selProj.value !== targetProj) selProj.value = targetProj;
    }
    if (document.activeElement !== selSess) {
      setHtmlStable(selSess, optionsHtml);
      const targetSess = persona.sessionPickId || '';
      if (selSess.value !== targetSess) selSess.value = targetSess;
    }

    renderPersonaCatalog(persona);
    renderSpritesGrid(nest.sprites || []);

    // Tab 6: Telegram Bridge
    const tg = snap.telegram;
    if (tg) {
      const tgCfg = tg.config || {};
      const tgSt = tg.status || {};
      const badgeText = !tgCfg.enabled
        ? '未啟用'
        : !tgCfg.hasBotToken
          ? '缺 Token'
          : !tgSt.configured
            ? '待綁定 Chat ID'
            : tgSt.lastPollError
              ? '連線異常'
              : tgSt.botUsername
                ? `已連接 @${tgSt.botUsername}`
                : '運行中';
      if ($('tg-status-badge')) $('tg-status-badge').textContent = badgeText;
      if ($('tg-token-hint')) {
        $('tg-token-hint').textContent = tgCfg.hasBotToken
          ? `已儲存 Bot Token（${tgCfg.botTokenMasked || '***'}）${tgSt.botUsername ? ` · @${tgSt.botUsername}` : ''}`
          : '尚未設定 Token；請向 Telegram @BotFather 建立 Bot 後貼上';
      }
      const pairBox = $('tg-pair-box');
      if (pairBox) {
        if (tgCfg.pairCode && tgCfg.pairCodeExpiresAt > Date.now()) {
          const minsLeft = Math.max(1, Math.ceil((tgCfg.pairCodeExpiresAt - Date.now()) / 60_000));
          pairBox.classList.remove('hidden');
          pairBox.textContent = `臨時配對碼：${tgCfg.pairCode}（剩 ${minsLeft} 分鐘），請在 Telegram 私訊 Bot 傳送：/bind ${tgCfg.pairCode}`;
        } else {
          pairBox.classList.add('hidden');
        }
      }

      if (!state.tgChatIdEdited && document.activeElement !== $('tg-allowedChatId')) {
        $('tg-allowedChatId').value = tgCfg.allowedChatId || '';
      }
      setIfClean($('tg-lockSingleChat'), tgCfg.lockSingleChat !== false, 'tg');
      setIfClean($('tg-enabled'), tgCfg.enabled, 'tg');
      setIfClean($('tg-receiveEnabled'), tgCfg.receiveEnabled !== false, 'tg');
      setIfClean($('tg-forwardTelegramReplies'), tgCfg.forwardTelegramReplies !== false, 'tg');
      setIfClean($('tg-forwardDesktopReplies'), Boolean(tgCfg.forwardDesktopReplies), 'tg');
      setIfClean($('tg-forwardDesktopUserMessages'), tgCfg.forwardDesktopUserMessages !== false, 'tg');
      setIfClean($('tg-forwardSpeakUp'), tgCfg.forwardSpeakUp !== false, 'tg');
      setIfClean($('tg-forwardXingxi'), Boolean(tgCfg.forwardXingxi), 'tg');
      setIfClean($('tg-downloadFiles'), tgCfg.downloadFiles !== false, 'tg');
      setIfClean($('tg-autoSendReplyFiles'), tgCfg.autoSendReplyFiles !== false, 'tg');
      setIfClean($('tg-muteWhenDesktopActive'), tgCfg.muteWhenDesktopActive !== false, 'tg');
      setIfClean($('tg-desktopActiveMuteMin'), tgCfg.desktopActiveMuteMin ?? 15, 'tg');
      setIfClean($('tg-desktopMuteMode'), tgCfg.desktopMuteMode || 'skip', 'tg');
      if ($('tg-mute-status-line')) {
        $('tg-mute-status-line').textContent = tgSt.desktopMuteActive
          ? `目前電腦對話活躍：Telegram 主動推播暫時${tgCfg.desktopMuteMode === 'silent' ? '靜音送達' : '安靜不打擾'}（剩約 ${tgSt.desktopMuteMinsLeft} 分，或在 Telegram 回覆立即解除）`
          : (tgCfg.muteWhenDesktopActive === false ? '自動靜音未啟用' : '目前無電腦端靜音鎖定（會正常推播通知）');
      }
      setIfClean($('tg-followActive'), tgCfg.followActive !== false, 'tg');
      setIfClean($('tg-targetConvId'), tgCfg.targetConversationId || '', 'tg');
      setIfClean($('tg-maxUploadMb'), tgCfg.maxUploadMb ?? 20, 'tg');
      setIfClean($('tg-extraSendDirs'), Array.isArray(tgCfg.extraSendDirs) ? tgCfg.extraSendDirs.join('\n') : '', 'tg');

      setHtmlStable($('tg-chat-history'), (tg.chatHistory || []).slice().reverse().map((h) => {
        const who = h.dir === 'out'
          ? `Gemini 貓貓${h.mode === 'speak-up' ? '（主動）' : ''}${h.silent ? ' 🔕' : ''}`
          : `${h.sender || '你（Telegram）'}${h.silent ? ' 🔕' : ''}`;
        const fileTag = Array.isArray(h.files) && h.files.length ? ` [附件: ${h.files.join(', ')}]` : '';
        return `
          <div class="row-item">
            <div class="row-top"><strong>${esc(who)}</strong><span>${esc(h.time)}</span></div>
            <div class="row-body">${esc(h.text || '')}${esc(fileTag)}</div>
          </div>
        `;
      }).join('') || '<p class="muted-meta">尚無 Telegram 來回對話紀錄；點右上角「從目前對話補同步」可抓回既有紀錄。</p>');

      setHtmlStable($('tg-logs'), (tg.logs || []).map((l) => `
        <div class="row-item">
          <div class="row-top"><span>${esc(l.time)}</span></div>
          <div class="row-body">${esc(l.text)}</div>
        </div>
      `).join('') || '<p class="muted-meta">尚無 Telegram 傳訊或傳檔紀錄。</p>');
    }

    updateProjectScopeUI();
  }

  async function refreshState({ force = false } = {}) {
    try {
      const qs = new URLSearchParams({
        conversationId: window.sidecar?.conversationId || '',
        workspaceUris: JSON.stringify(state.workspaceUris),
      });
      let verToken = '';
      if (!force && state.hasInitialSnap) {
        const ver = await apiFetch(`/api/version?${qs.toString()}`, { method: 'GET' }, { silent: true });
        if (!ver || !ver.ok) throw new Error('version check failed');
        verToken = String(ver.version || '');
        const wasOffline = state.pollFailures >= 3;
        state.pollFailures = 0;
        const scopeChanged = typeof ver.inProject === 'boolean' && ver.inProject !== state.inProject;
        if (scopeChanged) state.inProject = ver.inProject;
        if (verToken && verToken === state.lastDataVersion) {
          if (wasOffline || scopeChanged) updateProjectScopeUI();
          return;
        }
      }

      const res = await apiFetch(`/api/state?${qs.toString()}`, { method: 'GET' }, { silent: true });
      if (res && res.ok) {
        state.pollFailures = 0;
        if (verToken) {
          state.lastDataVersion = verToken;
        } else {
          // Force poll fetches full snapshot; let next version check sync token cleanly
          const ver = await apiFetch(`/api/version?${qs.toString()}`, { method: 'GET' }, { silent: true }).catch(() => null);
          state.lastDataVersion = String(ver?.version || '');
        }
        if (typeof res.inProject === 'boolean') state.inProject = res.inProject;
        renderSnapshot(res);
      }
    } catch {
      state.pollFailures += 1;
      if (state.pollFailures >= 3) {
        updateProjectScopeUI();
      }
    }
  }

  // ---------- 5. Accessible ARIA Tabs & Keyboard Navigation ----------
  const tabButtons = [...document.querySelectorAll('.tab-btn[role="tab"]')];
  const tabPanels = [...document.querySelectorAll('.tab-panel[role="tabpanel"]')];

  function activateTab(btn, moveFocus = false) {
    tabButtons.forEach((b) => {
      const selected = b === btn;
      b.classList.toggle('active', selected);
      b.setAttribute('aria-selected', String(selected));
      b.setAttribute('tabindex', selected ? '0' : '-1');
    });
    tabPanels.forEach((p) => {
      p.hidden = p.id !== `tab-${btn.dataset.tab}`;
    });
    if (btn.dataset.tab === 'xingxi') {
      requestAnimationFrame(() => drawStarMap(null));
    }
    if (moveFocus) btn.focus();
  }

  tabButtons.forEach((btn, idx) => {
    btn.addEventListener('click', () => activateTab(btn, false));
    btn.addEventListener('keydown', (e) => {
      let nextIdx = -1;
      if (e.key === 'ArrowRight') nextIdx = (idx + 1) % tabButtons.length;
      else if (e.key === 'ArrowLeft') nextIdx = (idx - 1 + tabButtons.length) % tabButtons.length;
      else if (e.key === 'Home') nextIdx = 0;
      else if (e.key === 'End') nextIdx = tabButtons.length - 1;
      if (nextIdx >= 0) {
        e.preventDefault();
        activateTab(tabButtons[nextIdx], true);
      }
    });
  });

  // ---------- 6. Cat Nest Stage Actions & Whisper ----------
  async function triggerCare(action, extra = {}) {
    const syncChecked = Boolean($('nest-sync-chat')?.checked);
    const sendToChat = extra.sendToChat !== undefined
      ? extra.sendToChat
      : (action !== 'whisper' && syncChecked);
    const res = await apiFetch('/api/nest/action', {
      method: 'POST',
      body: JSON.stringify({
        action,
        conversationId: activeConversationId(),
        workspaceUris: state.workspaceUris,
        ...extra,
        sendToChat,
      }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot, { suppressMotion: Boolean(res?.limited) });
    if (res?.limited) {
      $('activity-text').textContent = res.reaction || res.dispatchError || '這個互動目前冷卻或達到今日上限囉～';
      return res;
    }
    const stillSleeping = Boolean(res?.snapshot?.nest?.sleeping);
    activateSpriteMotion(stillSleeping ? 1100 : 2000);
    if (!stillSleeping) {
      const wrap = $('character-wrap');
      wrap.classList.add('bounce');
      setTimeout(() => wrap.classList.remove('bounce'), 240);
    }
    const glyphs = stillSleeping
      ? { pet: 'zzZ', comfort: 'zzZ', nap: 'zzZ', whisper: 'zzZ' }
      : { pet: '♡', feed: '✦', play: '✧', comfort: '♡', nap: '✦', whisper: '✓' };
    spawnParticles(glyphs[action] || '✦');
    if (res?.dispatchError) $('activity-text').textContent = res.dispatchError;
    return res;
  }

  document.querySelectorAll('.care-btn[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => withBusy(btn, () => triggerCare(btn.dataset.action)));
  });

  $('nest-sync-chat').addEventListener('change', async () => {
    const res = await apiFetch('/api/nest/prefs', {
      method: 'POST',
      body: JSON.stringify({
        syncChatOnCare: $('nest-sync-chat').checked,
        conversationId: activeConversationId(),
      }),
    }).catch(() => null);
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  $('btn-nest-clear').addEventListener('click', () => withBusy($('btn-nest-clear'), async () => {
    const res = await apiFetch('/api/nest/clear-pending', {
      method: 'POST',
      body: JSON.stringify({ conversationId: activeConversationId() }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  }));

  $('btn-whisper-queue').addEventListener('click', async () => {
    const btn = $('btn-whisper-queue');
    const input = $('whisper-input');
    const note = input.value.trim();
    if (!note || btn?.dataset.busy === '1') return;
    input.value = '';
    const res = await withBusy(btn, () => triggerCare('whisper', { note, sendToChat: false }));
    if (!res || res.limited || res.ok === false) {
      if (!input.value) input.value = note;
    }
  });

  $('btn-whisper-send').addEventListener('click', async () => {
    const btn = $('btn-whisper-send');
    const input = $('whisper-input');
    const note = input.value.trim();
    if (!note || btn?.dataset.busy === '1') return;
    input.value = '';
    const res = await withBusy(btn, () => triggerCare('whisper', { note, sendToChat: true }));
    if (!res || res.limited || res.ok === false) {
      if (!input.value) input.value = note;
    }
  });

  $('whisper-input').addEventListener('keydown', (e) => {
    if (e.isComposing || e.key !== 'Enter') return;
    e.preventDefault();
    $('btn-whisper-queue').click();
  });

  function bindPromptReset(btnId, { apiUrl, payloadFn, textareaId, getDefaultFn, msgId }) {
    const btn = $(btnId);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      const res = await apiFetch(apiUrl, { method: 'POST', body: JSON.stringify(payloadFn()) });
      const def = getDefaultFn(res?.snapshot || state.snap);
      const ta = $(textareaId);
      if (ta && typeof def === 'string') ta.value = def;
      if (res?.snapshot) renderSnapshot(res.snapshot);
      if (msgId) flashMsg(msgId, '已恢復預設提示詞 ✓');
    });
  }

  // ---------- 7. Mood Tab Events ----------
  $('drawer-mood-cfg').addEventListener('input', () => setDirty('mood', true));
  $('drawer-mood-cfg').addEventListener('change', () => setDirty('mood', true));

  bindPromptReset('btn-mood-reset-prompt', {
    apiUrl: '/api/mood/config',
    payloadFn: () => ({ inChatRulePrompt: '', conversationId: activeConversationId() }),
    textareaId: 'cfg-mood-rulePrompt',
    getDefaultFn: (s) => s?.mood?.defaultRulePrompt || '',
    msgId: 'mood-save-msg',
  });

  $('cfg-mood-injectUnlimited')?.addEventListener('change', () => {
    if ($('cfg-mood-perDay')) $('cfg-mood-perDay').disabled = Boolean($('cfg-mood-injectUnlimited').checked);
  });

  $('btn-mood-save').addEventListener('click', () => withBusy($('btn-mood-save'), async () => {
    const patch = {
      enabled: $('cfg-mood-enabled').checked,
      autoJudge: $('cfg-mood-autoJudge').checked,
      innerThoughtEnabled: $('cfg-mood-innerThoughtEnabled').checked,
      judgeMode: $('cfg-mood-judgeMode').value,
      injectMode: $('cfg-mood-injectMode').value,
      selfName: $('cfg-mood-selfName').value,
      ownerName: $('cfg-mood-ownerName').value,
      selfPronoun: $('cfg-mood-selfPronoun').value,
      selfAliases: $('cfg-mood-selfAliases').value,
      ownerAliases: $('cfg-mood-ownerAliases').value,
      moodBase: Number($('cfg-mood-base').value),
      moodFloor: Number($('cfg-mood-floor').value),
      decayHalfHours: Number($('cfg-mood-halfHours').value),
      stepDivisor: Number($('cfg-mood-stepDivisor').value),
      injectPerDay: Number($('cfg-mood-perDay').value),
      injectUnlimited: Boolean($('cfg-mood-injectUnlimited').checked),
      changesPerDay: Number($('cfg-mood-changesPerDay').value),
      sigMood: Number($('cfg-mood-sigMood').value),
      sigDim: Number($('cfg-mood-sigDim').value),
      injectConfidence: Number($('cfg-mood-conf').value),
      inChatRulePrompt: $('cfg-mood-rulePrompt').value,
      conversationId: activeConversationId(),
    };
    const res = await apiFetch('/api/mood/config', { method: 'POST', body: JSON.stringify(patch) });
    setDirty('mood', false);
    if (res?.snapshot) renderSnapshot(res.snapshot);
    else await refreshState({ force: true });
    flashMsg('mood-save-msg', '已儲存心情設定 ✓');
  }));

  $('btn-mood-nudge-up').addEventListener('click', () => withBusy($('btn-mood-nudge-up'), async () => {
    const res = await apiFetch('/api/mood/delta', {
      method: 'POST',
      body: JSON.stringify({ moodDelta: 3, dims: { happy: 4 }, reason: '側邊欄手動微調開心 (+3)', source: 'manual', bypassDivisor: true }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  }));

  $('btn-mood-nudge-down').addEventListener('click', () => withBusy($('btn-mood-nudge-down'), async () => {
    const res = await apiFetch('/api/mood/delta', {
      method: 'POST',
      body: JSON.stringify({ moodDelta: -3, dims: { sad: 3 }, reason: '側邊欄手動微調低落 (-3)', source: 'manual', bypassDivisor: true }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  }));

  $('btn-mood-reset').addEventListener('click', () => {
    const btn = $('btn-mood-reset');
    confirmBtnAction(btn, 'mood-reset', '#btn-mood-reset', async () => {
      const res = await apiFetch('/api/mood/reset', { method: 'POST', body: '{}' });
      if (res?.snapshot) renderSnapshot(res.snapshot);
      showToast('已將心情歸零回穩至基準值', 'ok', 2200);
    });
  });

  // ---------- 8. Memory Tab Events ----------
  $('mem-test-query').addEventListener('keydown', (e) => {
    if (e.isComposing || e.key !== 'Enter') return;
    e.preventDefault();
    $('btn-mem-test').click();
  });

  $('btn-mem-test').addEventListener('click', async () => {
    const q = $('mem-test-query').value.trim();
    if (!q) return;
    const res = await apiFetch('/api/memory/test-recall', { method: 'POST', body: JSON.stringify({ query: q }) });
    const box = $('mem-test-result');
    if (!res?.ok) {
      box.textContent = res?.error || '測試失敗';
      return;
    }
    const header = res.gate?.blocked
      ? `<p class="muted-meta">問句資訊門檻擋掉：${Number(res.gate.infoScore).toFixed(2)} &lt; ${res.gate.threshold}</p>`
      : `<p class="muted-meta">挑中 ${res.selectedCount} 條（顯示前 15 條評分明細）：</p>`;
    box.innerHTML = header + (res.rows || []).map((r) => `
      <div class="row-item">
        <div class="row-top">
          <span class="tabular">C=${r.C} · 鮮活=${r.A} · P=${r.P}</span>
          <strong>${esc(r.omission)}</strong>
        </div>
        <div class="row-body">${esc(r.text)}</div>
      </div>
    `).join('');
  });

  $('btn-mem-add').addEventListener('click', () => withBusy($('btn-mem-add'), async () => {
    const text = $('mem-add-text').value.trim();
    if (!text) return;
    const res = await apiFetch('/api/memory/remember', {
      method: 'POST',
      body: JSON.stringify({
        text,
        factKey: $('mem-add-key').value.trim(),
        importance: Number($('mem-add-imp').value),
        category: $('mem-add-cat').value,
        bypassQuota: true,
      }),
    });
    $('mem-add-text').value = '';
    $('mem-add-key').value = '';
    if (res?.snapshot) renderSnapshot(res.snapshot);
  }));

  $('mem-search').addEventListener('input', () => {
    if (state.snap?.memory) renderMemoryList(state.snap.memory);
  });

  $('mem-show-archived').addEventListener('change', () => {
    if (state.snap?.memory) renderMemoryList(state.snap.memory);
  });

  $('mem-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-mem-act]');
    if (!btn) return;
    const act = btn.dataset.memAct;
    const id = btn.dataset.memId;
    if (act === 'toggleEdit') {
      state.editingMemId = state.editingMemId === id ? '' : id;
      if (state.snap?.memory) renderMemoryList(state.snap.memory);
      return;
    }
    if (act === 'cancelEdit') {
      state.editingMemId = '';
      if (state.snap?.memory) renderMemoryList(state.snap.memory);
      return;
    }
    if (act === 'saveEdit') {
      await withBusy(btn, async () => {
        const box = btn.closest('[data-edit-box]');
        if (!box) return;
        const text = box.querySelector('.mem-edit-text').value.trim();
        const factKey = box.querySelector('.mem-edit-key').value.trim();
        const importance = Number(box.querySelector('.mem-edit-imp').value);
        const res = await apiFetch('/api/memory/mutate', {
          method: 'POST',
          body: JSON.stringify({ action: 'edit', id, text, factKey, importance }),
        });
        if (res?.ok) state.editingMemId = '';
        if (res?.snapshot) renderSnapshot(res.snapshot);
      });
      return;
    }
    if (act === 'delete') {
      const sel = `[data-mem-act="delete"][data-mem-id="${CSS.escape(id)}"]`;
      confirmBtnAction(btn, `mem-del:${id}`, sel, async () => {
        const res = await apiFetch('/api/memory/mutate', {
          method: 'POST',
          body: JSON.stringify({ action: 'delete', id }),
        });
        if (res?.snapshot) renderSnapshot(res.snapshot);
      });
      return;
    }
    await withBusy(btn, async () => {
      const res = await apiFetch('/api/memory/mutate', {
        method: 'POST',
        body: JSON.stringify({ action: act, id }),
      });
      if (res?.snapshot) renderSnapshot(res.snapshot);
    });
  });

  $('btn-mem-export').addEventListener('click', () => {
    const mem = state.snap?.memory;
    if (!mem) return;
    const payload = JSON.stringify({ exportedAt: new Date().toISOString(), active: mem.active, archived: mem.archived }, null, 2);
    const blob = new Blob([payload], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gemini-cat-memories-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('mem-import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const raw = await file.text();
      let items = [];
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : (parsed.memories || parsed.active || []);
        items = arr.map((x) => (typeof x === 'string' ? { text: x } : { text: x.text, factKey: x.factKey, importance: x.importance, category: x.category }));
      } else {
        items = raw.split(/\r?\n/)
          .map((l) => l.replace(/^\s*[-*•\d.]+\s*/, '').trim())
          .filter((l) => l.length >= 6 && !l.startsWith('#') && !l.startsWith('>'))
          .slice(0, 50)
          .map((text) => ({ text, importance: 0.5 }));
      }
      if (!items.length) return;
      const res = await apiFetch('/api/memory/import', {
        method: 'POST',
        body: JSON.stringify({ items, bypassQuota: true }),
      });
      if (res?.snapshot) renderSnapshot(res.snapshot);
      flashMsg('pol-save-msg', `已匯入 ${res?.added || 0} 條（強化 ${res?.reinforced || 0} 條）`, 4000);
    } finally {
      e.target.value = '';
    }
  });

  $('drawer-mem-policy').addEventListener('input', () => {
    setDirty('policy', true);
    updateWeightSumDisplay();
  });
  $('drawer-mem-policy').addEventListener('change', () => setDirty('policy', true));

  bindPromptReset('btn-mem-reset-prompt', {
    apiUrl: '/api/memory/policy',
    payloadFn: () => ({ inChatRulePrompt: '' }),
    textareaId: 'pol-rulePrompt',
    getDefaultFn: (s) => s?.memory?.defaultRuleTemplate || '',
    msgId: 'pol-save-msg',
  });

  $('btn-pol-save').addEventListener('click', () => withBusy($('btn-pol-save'), async () => {
    const res = await apiFetch('/api/memory/policy', {
      method: 'POST',
      body: JSON.stringify({
        enabled: $('pol-enabled').checked,
        ownerPronoun: $('pol-ownerPronoun').value.trim() || 'ta',
        selfPronoun: $('pol-selfPronoun').value.trim() || '我',
        baselineWeight: Number($('pol-w-baseline').value) / 100,
        activationWeight: Number($('pol-w-activation').value) / 100,
        importanceWeight: Number($('pol-w-importance').value) / 100,
        emotionWeight: Number($('pol-w-emotion').value) / 100,
        threshold: Number($('pol-threshold').value),
        rarityK: Number($('pol-rarityK').value),
        maxItems: Number($('pol-maxItems').value),
        maxChars: Number($('pol-maxChars').value),
        queryGate: Number($('pol-queryGate').value),
        unknownActivation: Number($('pol-unknownAct').value),
        baseHalfLifeDays: Number($('pol-halfLife').value),
        emotionHalfLifeDays: Number($('pol-emotionHalfLife').value),
        dailyQuota: Number($('pol-dailyQuota').value),
        repeatWindow: Number($('pol-repeatWindow')?.value ?? 15),
        factCap: Number($('pol-factCap')?.value ?? 1),
        inChatRulePrompt: $('pol-rulePrompt').value,
      }),
    });
    setDirty('policy', false);
    if (res?.snapshot) renderSnapshot(res.snapshot);
    flashMsg('pol-save-msg', '已儲存記憶策略 ✓');
  }));

  $('btn-pol-reset').addEventListener('click', () => withBusy($('btn-pol-reset'), async () => {
    const res = await apiFetch('/api/memory/mutate', {
      method: 'POST',
      body: JSON.stringify({ action: 'resetPolicy' }),
    });
    setDirty('policy', false);
    if (res?.snapshot) renderSnapshot(res.snapshot);
    flashMsg('pol-save-msg', '已恢復預設參數 ✓');
  }));

  // ---------- 9. Xingxi Tab Events ----------
  $('xingxi-diary-list').addEventListener('click', (e) => {
    const card = e.target.closest('.diary-card[data-diary-name]');
    if (!card) return;
    const name = card.dataset.diaryName;
    if (state.expandedDiaries.has(name)) state.expandedDiaries.delete(name);
    else state.expandedDiaries.add(name);
    if (state.snap) renderSnapshot(state.snap);
  });

  $('btn-xx-raw-view').addEventListener('click', async () => {
    const name = $('xx-raw-select').value;
    const box = $('xx-raw-viewer');
    if (!name) {
      box.classList.add('hidden');
      return;
    }
    const res = await apiFetch(`/api/xingxi/file?name=${encodeURIComponent(name)}`, { method: 'GET' });
    box.classList.remove('hidden');
    box.textContent = res?.ok ? res.text : (res?.error || '讀取失敗');
  });

  $('xingxi-backups-list').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-xx-restore]');
    if (!btn) return;
    const backup = btn.dataset.xxRestore;
    const sel = `[data-xx-restore="${CSS.escape(backup)}"]`;
    confirmBtnAction(btn, `xx-restore:${backup}`, sel, async () => {
      const res = await apiFetch('/api/xingxi/restore', {
        method: 'POST',
        body: JSON.stringify({ backup }),
      });
      if (res?.snapshot) renderSnapshot(res.snapshot);
      if (res?.ok) {
        $('xingxi-sched-summary').textContent = `已從備份 ${res.restoredFrom} 還原 ${res.file}（原版本已另存備份）。`;
        showToast(`已從備份還原 ${res.file}`, 'ok', 2400);
      } else if (res?.error) {
        $('xingxi-sched-summary').textContent = `還原失敗：${res.error}`;
      }
    }, '確定還原？');
  });

  $('btn-xingxi-save').addEventListener('click', () => withBusy($('btn-xingxi-save'), async () => {
    const target = $('xingxi-chapter').value;
    const text = $('xingxi-entry').value.trim();
    if (!text) return;
    const res = target === 'diary'
      ? await apiFetch('/api/xingxi/diary', { method: 'POST', body: JSON.stringify({ entry: text }) })
      : await apiFetch('/api/xingxi/append', { method: 'POST', body: JSON.stringify({ chapter: target, content: text }) });
    $('xingxi-entry').value = '';
    if (res?.snapshot) renderSnapshot(res.snapshot);
  }));

  $('btn-xingxi-sched-save').addEventListener('click', () => withBusy($('btn-xingxi-sched-save'), async () => {
    const [hh, mm] = String($('xingxi-sched-time').value || '23:30').split(':').map((n) => Number(n));
    const res = await apiFetch('/api/xingxi/schedule', {
      method: 'POST',
      body: JSON.stringify({
        autoScheduleEnabled: $('xingxi-sched-enabled').checked,
        scheduleHour: Number.isFinite(hh) ? hh : 23,
        scheduleMinute: Number.isFinite(mm) ? mm : 30,
        scheduleMode: $('xingxi-sched-mode').value,
        conversationId: activeConversationId(),
      }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
    showToast('已儲存定時拾星設定', 'ok', 2200);
  }));

  $('btn-xingxi-pickup').addEventListener('click', () => withBusy($('btn-xingxi-pickup'), async () => {
    const res = await apiFetch('/api/xingxi/pickup', {
      method: 'POST',
      body: JSON.stringify({
        mode: $('xingxi-sched-mode').value,
        conversationId: activeConversationId(),
        workspaceUris: state.workspaceUris,
        force: true,
      }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
    if (res?.action === 'dispatched') {
      $('xingxi-sched-summary').textContent = `已派發給對話整理 ${res.date} 記憶卡與日記（切存 ${res.material?.turnCount || 0} 段）！`;
    } else if (res?.action === 'no_target') {
      $('xingxi-sched-summary').textContent = `已切存 ${res.date} 素材（${res.material?.turnCount || 0} 段），但目前無在線 gemini_cat 對話可派發。`;
    }
  }));

  // ---------- 10. Speak-Up Tab Events ----------
  function collectSelectedTargets() {
    const checked = [...document.querySelectorAll('.sp-target-cb:checked')].map((cb) => cb.dataset.convId);
    const manual = String($('sp-manual-targets')?.value || '')
      .split(/[\s,，]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return [...new Set([...checked, ...manual])];
  }

  const INSTANT_SP_SWITCHES = {
    'sp-enabled': 'enabled',
    'sp-aiPlanEnabled': 'aiPlanEnabled',
    'sp-diceEnabled': 'diceEnabled',
    'sp-dryRun': 'dryRun',
    'sp-diceBlockActiveChat': 'diceBlockActiveChat',
    'sp-suppressBeforeReminder': 'suppressDiceBeforeReminder',
    'sp-proactiveCueEnabled': 'proactiveCueEnabled',
  };
  for (const [elId, cfgKey] of Object.entries(INSTANT_SP_SWITCHES)) {
    $(elId)?.addEventListener('change', async () => {
      const res = await apiFetch('/api/speak-up/config', {
        method: 'POST',
        body: JSON.stringify({ [cfgKey]: $(elId).checked }),
      });
      if (res?.snapshot) renderSnapshot(res.snapshot);
    });
  }

  $('sp-scheduleTendency')?.addEventListener('change', async () => {
    const res = await apiFetch('/api/speak-up/config', {
      method: 'POST',
      body: JSON.stringify({ scheduleTendency: $('sp-scheduleTendency').value }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  $('btn-sp-clear-silence')?.addEventListener('click', () => postSpeakUpPlan({ action: 'clear_silence' }));

  $('sp-followActive').addEventListener('change', async () => {
    const followActive = $('sp-followActive').checked;
    $('sp-targets-wrap').classList.toggle('hidden', followActive);
    const res = await apiFetch('/api/speak-up/config', {
      method: 'POST',
      body: JSON.stringify({ followActive }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  $('sp-targets-list').addEventListener('change', async (e) => {
    if (!e.target.classList.contains('sp-target-cb')) return;
    const res = await apiFetch('/api/speak-up/config', {
      method: 'POST',
      body: JSON.stringify({ targetConversations: collectSelectedTargets() }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  async function postSpeakUpPlan(body) {
    const res = await apiFetch('/api/speak-up/plan', {
      method: 'POST',
      body: JSON.stringify({ ...body, conversationId: activeConversationId() }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
    return res;
  }

  $('btn-sp-clear-plans')?.addEventListener('click', () => {
    const btn = $('btn-sp-clear-plans');
    confirmBtnAction(btn, 'sp-clear-plans', '#btn-sp-clear-plans', () => postSpeakUpPlan({ action: 'clear_plans' }));
  });

  $('sp-plans-list')?.addEventListener('click', (e) => {
    const delBtn = e.target.closest('button[data-sp-del-plan]');
    if (!delBtn) return;
    const id = delBtn.dataset.spDelPlan;
    const sel = `[data-sp-del-plan="${CSS.escape(id)}"]`;
    confirmBtnAction(delBtn, `sp-del-plan:${id}`, sel, () => postSpeakUpPlan({ action: 'remove', id }));
  });

  $('sp-routines-list')?.addEventListener('click', (e) => {
    const tog = e.target.closest('button[data-sp-toggle-rt]');
    if (tog) return withBusy(tog, () => postSpeakUpPlan({ action: 'toggle_routine', id: tog.dataset.spToggleRt }));
    const reroll = e.target.closest('button[data-sp-reroll-rt]');
    if (reroll) return withBusy(reroll, () => postSpeakUpPlan({ action: 'reroll_routine', id: reroll.dataset.spRerollRt }));
    const del = e.target.closest('button[data-sp-del-rt]');
    if (del) {
      const id = del.dataset.spDelRt;
      const sel = `[data-sp-del-rt="${CSS.escape(id)}"]`;
      return confirmBtnAction(del, `sp-del-rt:${id}`, sel, () => postSpeakUpPlan({ action: 'remove', id }));
    }
  });

  $('btn-sp-add-routine')?.addEventListener('click', () => withBusy($('btn-sp-add-routine'), async () => {
    const timeHHMM = $('sp-new-rt-time')?.value || '12:30';
    const jitterMin = Number($('sp-new-rt-jitter')?.value ?? 20);
    const label = $('sp-new-rt-label')?.value.trim() || '';
    const thought = $('sp-new-rt-thought')?.value.trim() || '';
    const days = [...document.querySelectorAll('#sp-new-rt-days input[data-day]:checked')].map((cb) => Number(cb.dataset.day));
    const res = await postSpeakUpPlan({
      action: 'add_routine',
      timeHHMM,
      jitterMin,
      label: label || `每日 ${timeHHMM} 左右`,
      thought,
      days,
    });
    if (res?.ok) {
      if ($('sp-new-rt-label')) $('sp-new-rt-label').value = '';
      if ($('sp-new-rt-thought')) $('sp-new-rt-thought').value = '';
      flashMsg('sp-save-msg', '已新增固定波動節律 ✓');
    }
  }));

  function isInstantSpeakUpTarget(el) {
    if (!el) return true;
    if (
      Object.hasOwn(INSTANT_SP_SWITCHES, el.id)
      || el.id === 'sp-followActive'
      || el.id === 'sp-scheduleTendency'
      || el.id === 'sp-freshEnabled'
      || el.id === 'sp-freshCustomUrl'
      || el.id === 'sp-freshCustomLabel'
    ) return true;
    if (el.classList?.contains('sp-target-cb') || $('sp-freshPresets')?.contains(el)) return true;
    return Boolean($('drawer-sp-add-routine')?.contains(el));
  }

  function collectFreshPresets() {
    return [...document.querySelectorAll('#sp-freshPresets input[data-fresh-preset]:checked')]
      .map((cb) => cb.dataset.freshPreset)
      .filter(Boolean);
  }

  $('sp-freshEnabled')?.addEventListener('change', async () => {
    const res = await apiFetch('/api/speak-up/config', {
      method: 'POST',
      body: JSON.stringify({ freshBrowse: { enabled: $('sp-freshEnabled').checked } }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  $('sp-freshPresets')?.addEventListener('change', async () => {
    const res = await apiFetch('/api/speak-up/config', {
      method: 'POST',
      body: JSON.stringify({ freshBrowse: { presets: collectFreshPresets() } }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  $('btn-sp-add-feed')?.addEventListener('click', () => {
    const btn = $('btn-sp-add-feed');
    const url = $('sp-freshCustomUrl')?.value.trim() || '';
    const label = $('sp-freshCustomLabel')?.value.trim() || '';
    if (!url) {
      flashMsg('sp-fresh-feed-msg', '請先貼上 HTTPS RSS 或 YouTube 頻道網址');
      return;
    }
    withBusy(btn, async () => {
      const res = await apiFetch('/api/speak-up/fresh/test-feed', {
        method: 'POST',
        body: JSON.stringify({ url, label, add: true }),
      });
      if (res?.ok) {
        if ($('sp-freshCustomUrl')) $('sp-freshCustomUrl').value = '';
        if ($('sp-freshCustomLabel')) $('sp-freshCustomLabel').value = '';
        if (res.snapshot) renderSnapshot(res.snapshot);
        flashMsg('sp-fresh-feed-msg', `已加入「${res.preview?.label || '來源'}」 ✓`);
      } else if (res?.error) {
        flashMsg('sp-fresh-feed-msg', res.error, 5000);
      }
    });
  });

  $('sp-freshFeedsList')?.addEventListener('click', (e) => {
    const togBtn = e.target.closest('button[data-sp-toggle-feed]');
    if (togBtn) {
      const fid = togBtn.dataset.spToggleFeed;
      const curList = state.snap?.speakUp?.freshBrowse?.config?.customFeeds || [];
      const nextList = curList.map((f) => (f.id === fid ? { ...f, enabled: f.enabled === false } : f));
      return withBusy(togBtn, async () => {
        const res = await apiFetch('/api/speak-up/config', {
          method: 'POST',
          body: JSON.stringify({ freshBrowse: { customFeeds: nextList } }),
        });
        if (res?.snapshot) renderSnapshot(res.snapshot);
      });
    }
    const delBtn = e.target.closest('button[data-sp-del-feed]');
    if (delBtn) {
      const fid = delBtn.dataset.spDelFeed;
      const sel = `[data-sp-del-feed="${CSS.escape(fid)}"]`;
      return confirmBtnAction(delBtn, `sp-del-feed:${fid}`, sel, async () => {
        const curList = state.snap?.speakUp?.freshBrowse?.config?.customFeeds || [];
        const nextList = curList.filter((f) => f.id !== fid);
        const res = await apiFetch('/api/speak-up/config', {
          method: 'POST',
          body: JSON.stringify({ freshBrowse: { customFeeds: nextList } }),
        });
        if (res?.snapshot) renderSnapshot(res.snapshot);
      });
    }
  });

  $('btn-sp-fresh-refresh')?.addEventListener('click', () => {
    const btn = $('btn-sp-fresh-refresh');
    withBusy(btn, async () => {
      const res = await apiFetch('/api/speak-up/fresh/refresh', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (res?.snapshot) renderSnapshot(res.snapshot);
      if (res?.ok) {
        flashMsg('sp-fresh-feed-msg', `逛完回來了（見聞籃現有 ${res.itemsCount || 0} 則） ✓`);
      } else if (res?.error) {
        flashMsg('sp-fresh-feed-msg', res.error, 5000);
      }
    });
  });

  $('btn-sp-fresh-clear')?.addEventListener('click', () => {
    const btn = $('btn-sp-fresh-clear');
    confirmBtnAction(btn, 'sp-fresh-clear', '#btn-sp-fresh-clear', async () => {
      const res = await apiFetch('/api/speak-up/fresh/clear', {
        method: 'POST',
        body: JSON.stringify({ clearSeen: false }),
      });
      if (res?.snapshot) renderSnapshot(res.snapshot);
      flashMsg('sp-fresh-feed-msg', '已清空目前待選見聞籃 ✓');
    });
  });

  $('tab-speakup').addEventListener('input', (e) => {
    if (isInstantSpeakUpTarget(e.target)) return;
    setDirty('sp', true);
    if (e.target.id === 'sp-qStart' || e.target.id === 'sp-qEnd') updateSpeakUpQuietWarning();
  });

  $('tab-speakup').addEventListener('change', (e) => {
    if (isInstantSpeakUpTarget(e.target)) return;
    setDirty('sp', true);
  });

  bindPromptReset('btn-sp-reset-rule', {
    apiUrl: '/api/speak-up/config',
    payloadFn: () => ({ inChatRulePrompt: '' }),
    textareaId: 'sp-rulePrompt',
    getDefaultFn: (s) => s?.speakUp?.defaultInChatRulePrompt || '',
    msgId: 'sp-save-msg',
  });
  bindPromptReset('btn-sp-reset-prompt', {
    apiUrl: '/api/speak-up/config',
    payloadFn: () => ({ triggerPrompt: state.snap?.speakUp?.defaultTriggerPrompt || '晃過來瞄一眼。想到什麼好玩的、想吐槽的事，或單純冒個泡就隨手丟一兩句。' }),
    textareaId: 'sp-prompt',
    getDefaultFn: (s) => s?.speakUp?.defaultTriggerPrompt || '晃過來瞄一眼。想到什麼好玩的、想吐槽的事，或單純冒個泡就隨手丟一兩句。',
    msgId: 'sp-save-msg',
  });
  bindPromptReset('btn-sp-reset-followup', {
    apiUrl: '/api/speak-up/config',
    payloadFn: () => ({ followUpHintPrompt: '' }),
    textareaId: 'sp-followUpPrompt',
    getDefaultFn: (s) => s?.speakUp?.defaultFollowUpHintPrompt || '',
    msgId: 'sp-save-msg',
  });

  $('btn-sp-save').addEventListener('click', () => withBusy($('btn-sp-save'), async () => {
    const peakDays = [...document.querySelectorAll('#sp-peakDays input[data-day]:checked')]
      .map((cb) => Number(cb.dataset.day));
    const res = await apiFetch('/api/speak-up/config', {
      method: 'POST',
      body: JSON.stringify({
        enabled: $('sp-enabled').checked,
        aiPlanEnabled: $('sp-aiPlanEnabled').checked,
        diceEnabled: $('sp-diceEnabled').checked,
        dryRun: $('sp-dryRun').checked,
        followActive: $('sp-followActive').checked,
        diceBlockActiveChat: $('sp-diceBlockActiveChat').checked,
        suppressDiceBeforeReminder: $('sp-suppressBeforeReminder').checked,
        proactiveCueEnabled: $('sp-proactiveCueEnabled').checked,
        scheduleTendency: $('sp-scheduleTendency').value,
        targetConversations: collectSelectedTargets(),
        usePeakValley: $('sp-usePeakValley').checked,
        peakDays,
        peakWindowsText: $('sp-peakWindows').value,
        peakHitLine: Number($('sp-peak').value),
        valleyHitLine: Number($('sp-valley').value),
        intervalMinutes: Number($('sp-interval').value),
        cooldownMin: Number($('sp-cooldown').value),
        respectActiveChatGapMin: Number($('sp-activeGap').value),
        maxUnansweredSpontaneous: Number($('sp-maxUnanswered').value),
        suppressBeforeReminderMin: Number($('sp-reminderSuppressMin').value),
        missBonus: Number($('sp-bonus').value),
        bonusCap: Number($('sp-cap').value),
        quietStartHour: Number($('sp-qStart').value),
        quietEndHour: Number($('sp-qEnd').value),
        nearThresholdMin: Number($('sp-nearMin').value),
        nearFactor: Number($('sp-nearFactor').value),
        farThresholdMin: Number($('sp-farMin').value),
        farFactor: Number($('sp-farFactor').value),
        timezone: $('sp-timezone').value.trim(),
        inChatRulePrompt: $('sp-rulePrompt').value,
        triggerPrompt: $('sp-prompt').value,
        followUpHintPrompt: $('sp-followUpPrompt').value,
        freshBrowse: {
          enabled: $('sp-freshEnabled')?.checked || false,
          presets: collectFreshPresets(),
          fetchTimes: [$('sp-freshTime1')?.value, $('sp-freshTime2')?.value]
            .map((v) => String(v || '').trim())
            .filter(Boolean),
          weatherCity: $('sp-freshWeatherCity')?.value.trim() || '',
          dailyShareLimit: Number($('sp-freshDailyLimit')?.value ?? 2),
          maxAgeHours: Number($('sp-freshMaxAgeHours')?.value ?? 72),
        },
      }),
    });
    setDirty('sp', false);
    if (res?.snapshot) renderSnapshot(res.snapshot);
    flashMsg('sp-save-msg', res?.weatherError ? `已儲存（天氣提示：${res.weatherError}）` : '已儲存搭話設定 ✓', res?.weatherError ? 5200 : 3200);
  }));

  $('btn-sp-dry').addEventListener('click', () => withBusy($('btn-sp-dry'), async () => {
    const res = await apiFetch('/api/speak-up/roll', {
      method: 'POST',
      body: JSON.stringify({ mode: 'dry', conversationId: activeConversationId() }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  }));

  $('btn-sp-send').addEventListener('click', () => withBusy($('btn-sp-send'), async () => {
    const res = await apiFetch('/api/speak-up/roll', {
      method: 'POST',
      body: JSON.stringify({ mode: 'send', conversationId: activeConversationId() }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  }));

  $('btn-sp-reset-streak').addEventListener('click', async () => {
    const res = await apiFetch('/api/speak-up/reset-streak', { method: 'POST', body: '{}' });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  $('btn-sp-reset-unanswered')?.addEventListener('click', async () => {
    const res = await apiFetch('/api/speak-up/reset-unanswered', { method: 'POST', body: '{}' });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  // ---------- 11. Persona Tab Events (Strict project-scoped) ----------
  function resetPersonaEditor() {
    state.editingPersonaId = '';
    $('per-new-name').value = '';
    $('per-new-text').value = '';
    $('per-edit-badge').classList.add('hidden');
    $('btn-per-cancel-edit').classList.add('hidden');
    $('btn-per-create').textContent = '新增並套用到本專案';
  }

  async function postPersonaMutate(body) {
    const res = await apiFetch('/api/persona/mutate', {
      method: 'POST',
      body: JSON.stringify({ ...body, sessionId: activeConversationId() }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
    if (res && res.ok === false && res.error) {
      if ($('per-scope-notice')) $('per-scope-notice').textContent = res.error;
      showToast(res.error, 'error');
    }
    return res;
  }

  $('per-project-enabled').addEventListener('change', async () => {
    await postPersonaMutate({ action: 'toggleProject', enabled: $('per-project-enabled').checked });
  });

  $('per-session-disabled').addEventListener('change', async () => {
    await postPersonaMutate({ action: 'setSessionDisabled', disabled: $('per-session-disabled').checked });
  });

  $('per-select-project').addEventListener('change', async () => {
    await postPersonaMutate({ action: 'selectProject', id: $('per-select-project').value });
  });

  $('per-select-session').addEventListener('change', async () => {
    await postPersonaMutate({ action: 'selectSession', id: $('per-select-session').value });
  });

  $('btn-per-cancel-edit').addEventListener('click', resetPersonaEditor);

  $('btn-per-create').addEventListener('click', () => withBusy($('btn-per-create'), async () => {
    const name = $('per-new-name').value.trim();
    const text = $('per-new-text').value;
    if (!name) return;
    const res = state.editingPersonaId
      ? await postPersonaMutate({ action: 'update', id: state.editingPersonaId, name, text })
      : await postPersonaMutate({ action: 'create', name, text, activate: true });
    if (res?.ok) resetPersonaEditor();
  }));

  $('per-import-file').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const baseName = file.name.replace(/\.[^.]+$/, '').trim().slice(0, 60) || '匯入人設';
      await postPersonaMutate({ action: 'create', name: baseName, text, activate: false });
    } finally {
      e.target.value = '';
    }
  });

  $('per-catalog').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-per-act]');
    if (!btn) return;
    const act = btn.dataset.perAct;
    const id = btn.dataset.perId;
    const target = (state.snap?.persona?.catalog || []).find((p) => p.id === id);

    if (act === 'toggleFull') {
      if (state.expandedPersonas.has(id)) state.expandedPersonas.delete(id);
      else state.expandedPersonas.add(id);
      if (state.snap?.persona) renderPersonaCatalog(state.snap.persona);
      return;
    }
    if (act === 'startRename') {
      state.renamingPersonaId = state.renamingPersonaId === id ? '' : id;
      if (state.snap?.persona) renderPersonaCatalog(state.snap.persona);
      return;
    }
    if (act === 'cancelRename') {
      state.renamingPersonaId = '';
      if (state.snap?.persona) renderPersonaCatalog(state.snap.persona);
      return;
    }
    if (act === 'saveRename') {
      const box = btn.closest('[data-rename-box]');
      const newName = box?.querySelector('.per-rename-input')?.value.trim();
      if (!newName) return;
      const res = await postPersonaMutate({ action: 'rename', id, name: newName });
      if (res?.ok) state.renamingPersonaId = '';
      return;
    }
    if (act === 'toggleEnabled') {
      const currentlyOn = btn.dataset.enabled === '1';
      await postPersonaMutate({ action: 'toggleEnabled', id, enabled: !currentlyOn });
      return;
    }
    if (act === 'export') {
      if (!target) return;
      const blob = new Blob([String(target.text || '')], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(target.name || target.id).replace(/[\\/:*?"<>|]/g, '_')}.md`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    if (act === 'edit') {
      if (!target) return;
      state.editingPersonaId = target.id;
      $('per-new-name').value = target.name || '';
      $('per-new-text').value = target.text || '';
      $('per-edit-badge').classList.remove('hidden');
      $('btn-per-cancel-edit').classList.remove('hidden');
      $('btn-per-create').textContent = '儲存人設修改';
      $('per-new-name').focus();
      return;
    }
    if (act === 'delete') {
      const sel = `[data-per-act="delete"][data-per-id="${CSS.escape(id)}"]`;
      confirmBtnAction(btn, `per-del:${id}`, sel, async () => {
        if (state.editingPersonaId && id === state.editingPersonaId) {
          resetPersonaEditor();
        }
        await postPersonaMutate({ action: 'delete', id });
      });
      return;
    }
    await withBusy(btn, () => postPersonaMutate({ action: act, id }));
  });

  // Custom Nest Sprites (inside Persona drawer)
  $('per-sprites-grid')?.addEventListener('change', async (e) => {
    const input = e.target.closest('input[data-sprite-upload]');
    if (!input) return;
    const slot = input.dataset.spriteUpload;
    const file = input.files?.[0];
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) {
        flashMsg('per-sprite-msg', '圖片不可超過 5 MB', 4000);
        return;
      }
      const dataUrl = await new Promise((resolveFn, rejectFn) => {
        const reader = new FileReader();
        reader.onload = () => resolveFn(String(reader.result || ''));
        reader.onerror = () => rejectFn(new Error('讀取圖片失敗'));
        reader.readAsDataURL(file);
      });
      const res = await apiFetch('/api/nest/sprite', {
        method: 'POST',
        body: JSON.stringify({ slot, dataUrl, conversationId: activeConversationId() }),
      });
      if (res?.ok) {
        cleanedSprites.clear();
        state.currentSpriteUrl = '';
        if (res.snapshot) renderSnapshot(res.snapshot);
        flashMsg('per-sprite-msg', '已更新立繪 ✓');
      } else if (res?.error) {
        flashMsg('per-sprite-msg', res.error, 4000);
      }
    } finally {
      input.value = '';
    }
  });

  $('per-sprites-grid')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-sprite-reset]');
    if (!btn) return;
    const slot = btn.dataset.spriteReset;
    withBusy(btn, async () => {
      const res = await apiFetch('/api/nest/sprite/reset', {
        method: 'POST',
        body: JSON.stringify({ slot, conversationId: activeConversationId() }),
      });
      cleanedSprites.clear();
      state.currentSpriteUrl = '';
      if (res?.snapshot) renderSnapshot(res.snapshot);
      flashMsg('per-sprite-msg', '已恢復預設立繪 ✓');
    });
  });

  $('btn-per-sprites-reset-all')?.addEventListener('click', () => {
    const btn = $('btn-per-sprites-reset-all');
    confirmBtnAction(btn, 'per-sprites-reset-all', '#btn-per-sprites-reset-all', async () => {
      const res = await apiFetch('/api/nest/sprite/reset', {
        method: 'POST',
        body: JSON.stringify({ slot: 'all', conversationId: activeConversationId() }),
      });
      cleanedSprites.clear();
      state.currentSpriteUrl = '';
      if (res?.snapshot) renderSnapshot(res.snapshot);
      flashMsg('per-sprite-msg', '已全部恢復預設立繪 ✓');
    }, '確定恢復？');
  });

  // ---------- 11b. Telegram Tab Events ----------
  const INSTANT_TG_SWITCHES = {
    'tg-lockSingleChat': 'lockSingleChat',
    'tg-enabled': 'enabled',
    'tg-receiveEnabled': 'receiveEnabled',
    'tg-forwardTelegramReplies': 'forwardTelegramReplies',
    'tg-forwardDesktopReplies': 'forwardDesktopReplies',
    'tg-forwardDesktopUserMessages': 'forwardDesktopUserMessages',
    'tg-forwardSpeakUp': 'forwardSpeakUp',
    'tg-forwardXingxi': 'forwardXingxi',
    'tg-downloadFiles': 'downloadFiles',
    'tg-autoSendReplyFiles': 'autoSendReplyFiles',
    'tg-muteWhenDesktopActive': 'muteWhenDesktopActive',
    'tg-followActive': 'followActive',
  };
  for (const [elId, cfgKey] of Object.entries(INSTANT_TG_SWITCHES)) {
    $(elId)?.addEventListener('change', async () => {
      const res = await apiFetch('/api/telegram/config', {
        method: 'POST',
        body: JSON.stringify({ [cfgKey]: $(elId).checked }),
      });
      if (res?.snapshot) renderSnapshot(res.snapshot);
    });
  }

  $('tg-desktopMuteMode')?.addEventListener('change', async () => {
    const res = await apiFetch('/api/telegram/config', {
      method: 'POST',
      body: JSON.stringify({ desktopMuteMode: $('tg-desktopMuteMode').value }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  $('btn-tg-sync-history')?.addEventListener('click', () => withBusy($('btn-tg-sync-history'), async () => {
    const res = await apiFetch('/api/telegram/sync-history', {
      method: 'POST',
      body: JSON.stringify({ conversationId: activeConversationId() }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
    flashMsg('tg-save-msg', res?.ok ? `已同步補抓 ${res.imported || 0} 則對話 ✓` : (res?.error || '同步失敗'));
  }));

  $('tg-allowedChatId')?.addEventListener('input', () => {
    state.tgChatIdEdited = true;
  });

  $('tab-telegram')?.addEventListener('input', (e) => {
    if (e.target && (Object.hasOwn(INSTANT_TG_SWITCHES, e.target.id) || e.target.id === 'tg-desktopMuteMode')) return;
    setDirty('tg', true);
  });

  $('btn-tg-clear-token')?.addEventListener('click', () => {
    const btn = $('btn-tg-clear-token');
    confirmBtnAction(btn, 'tg-clear-token', '#btn-tg-clear-token', async () => {
      const res = await apiFetch('/api/telegram/config', {
        method: 'POST',
        body: JSON.stringify({ clearToken: true }),
      });
      if ($('tg-botToken')) $('tg-botToken').value = '';
      setDirty('tg', false);
      if (res?.snapshot) renderSnapshot(res.snapshot);
      flashMsg('tg-save-msg', '已清除 Bot Token');
    }, '確定清除？');
  });

  $('btn-tg-gen-pair')?.addEventListener('click', () => withBusy($('btn-tg-gen-pair'), async () => {
    const res = await apiFetch('/api/telegram/pair-code', { method: 'POST', body: '{}' });
    if (res?.snapshot) renderSnapshot(res.snapshot);
    if (res?.pairCode) flashMsg('tg-test-msg', `配對碼 ${res.pairCode} 已產生（10 分鐘內有效）`);
    else if (res?.error) flashMsg('tg-test-msg', res.error);
  }));

  $('btn-tg-test-me')?.addEventListener('click', () => withBusy($('btn-tg-test-me'), async () => {
    const typedToken = $('tg-botToken')?.value.trim() || '';
    const res = await apiFetch('/api/telegram/test', {
      method: 'POST',
      body: JSON.stringify({ botToken: typedToken, sendTest: false }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
    flashMsg('tg-test-msg', res?.ok ? `驗證成功 @${res.bot?.username || 'Bot'}` : `失敗：${res?.error || '未知錯誤'}`);
  }));

  $('btn-tg-send-test')?.addEventListener('click', () => withBusy($('btn-tg-send-test'), async () => {
    const typedToken = $('tg-botToken')?.value.trim() || '';
    const chatId = $('tg-allowedChatId')?.value.trim() || '';
    const res = await apiFetch('/api/telegram/test', {
      method: 'POST',
      body: JSON.stringify({ botToken: typedToken, chatId, sendTest: true }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
    flashMsg('tg-test-msg', res?.sent ? '測試訊息已送達 Telegram ✓' : `失敗：${res?.error || '無法發送'}`);
  }));

  $('btn-tg-save')?.addEventListener('click', () => withBusy($('btn-tg-save'), async () => {
    const tokenInput = $('tg-botToken')?.value.trim() || '';
    const chatIdInput = $('tg-allowedChatId')?.value.trim() || '';
    const payload = {
      followActive: $('tg-followActive')?.checked !== false,
      targetConversationId: $('tg-targetConvId')?.value.trim() || '',
      maxUploadMb: Number($('tg-maxUploadMb')?.value ?? 20),
      extraSendDirs: $('tg-extraSendDirs')?.value || '',
      enabled: Boolean($('tg-enabled')?.checked),
      lockSingleChat: $('tg-lockSingleChat')?.checked !== false,
      receiveEnabled: $('tg-receiveEnabled')?.checked !== false,
      forwardTelegramReplies: $('tg-forwardTelegramReplies')?.checked !== false,
      forwardDesktopReplies: Boolean($('tg-forwardDesktopReplies')?.checked),
      forwardDesktopUserMessages: $('tg-forwardDesktopUserMessages')?.checked !== false,
      forwardSpeakUp: $('tg-forwardSpeakUp')?.checked !== false,
      forwardXingxi: Boolean($('tg-forwardXingxi')?.checked),
      downloadFiles: $('tg-downloadFiles')?.checked !== false,
      autoSendReplyFiles: $('tg-autoSendReplyFiles')?.checked !== false,
      muteWhenDesktopActive: $('tg-muteWhenDesktopActive')?.checked !== false,
      desktopActiveMuteMin: Number($('tg-desktopActiveMuteMin')?.value ?? 15),
      desktopMuteMode: $('tg-desktopMuteMode')?.value || 'skip',
    };
    if (state.tgChatIdEdited || chatIdInput) {
      payload.allowedChatId = chatIdInput;
    }
    if (tokenInput) payload.botToken = tokenInput;
    const res = await apiFetch('/api/telegram/config', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if ($('tg-botToken')) $('tg-botToken').value = '';
    state.tgChatIdEdited = false;
    setDirty('tg', false);
    if (res?.snapshot) renderSnapshot(res.snapshot);
    flashMsg('tg-save-msg', '已儲存 Telegram 設定 ✓');
  }));

  // ---------- 11c. Accessible Title Hints (interestfor + popover="hint" + offline fallback) ----------
  function initTitleHints() {
    const triggers = [...document.querySelectorAll('[interestfor]')];
    if (!triggers.length) return;

    const ownedExpanded = new WeakSet();
    const supportsPopover = Object.hasOwn(HTMLElement.prototype, 'popover');
    const supportsInterest = 'interestForElement' in HTMLButtonElement.prototype;
    const supportsAnchorArea = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
      && CSS.supports('position-area', 'block-end');

    let supportsHintPopover = false;
    if (supportsPopover) {
      const probe = document.createElement('div');
      probe.setAttribute('popover', 'hint');
      supportsHintPopover = probe.popover === 'hint';
    }

    const isPopoverOpen = (el) => {
      if (!el) return false;
      try {
        if (el.matches(':popover-open')) return true;
      } catch { /* fallback below */ }
      return el.classList.contains(':popover-open');
    };

    const placeHintFallback = (trigger, tip) => {
      if ((supportsAnchorArea && supportsInterest) || !trigger || !tip) return;
      tip.classList.add('js-placed');
      const rect = trigger.getBoundingClientRect();
      const pad = 10;
      const vw = window.innerWidth || 360;
      const vh = window.innerHeight || 640;
      const tipW = Math.min(300, vw - pad * 2);
      const tipH = tip.offsetHeight || 68;
      let left = rect.left;
      if (left + tipW > vw - pad) left = vw - pad - tipW;
      if (left < pad) left = pad;
      let top = rect.bottom + 6;
      if (top + tipH > vh - pad && rect.top - tipH - 6 > pad) {
        top = rect.top - tipH - 6;
      }
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(top)}px`;
    };

    // Upfront ARIA wiring for browse-mode screen readers
    for (const trig of triggers) {
      const targetId = trig.getAttribute('interestfor');
      const tip = targetId ? document.getElementById(targetId) : null;
      if (!tip || tip.getAttribute('popover') !== 'hint') continue;
      if (!tip.hasAttribute('role')) tip.setAttribute('role', 'tooltip');
      const opensOnActivate = trig.getAttribute('popovertarget') === targetId
        || trig.getAttribute('commandfor') === targetId;
      if (opensOnActivate) {
        if (!trig.hasAttribute('aria-expanded')) {
          trig.setAttribute('aria-expanded', String(isPopoverOpen(tip)));
          ownedExpanded.add(trig);
        }
      } else if (!trig.hasAttribute('aria-describedby')) {
        trig.setAttribute('aria-describedby', targetId);
      }
    }

    // Sync aria-expanded from popover toggle events (capturing because toggle does not bubble)
    document.addEventListener('toggle', (e) => {
      const tip = e.target;
      if (!tip || !tip.id) return;
      const open = e.newState === 'open';
      document.querySelectorAll(`[interestfor="${CSS.escape(tip.id)}"]`).forEach((trig) => {
        if (ownedExpanded.has(trig)) {
          trig.setAttribute('aria-expanded', String(open));
        }
        trig.classList.toggle('interest-source', open);
        if (open) placeHintFallback(trig, tip);
      });
      tip.classList.toggle('interest-target', open);
    }, true);

    // Switch toggletips from unsupported popover="hint" to popover="auto" before opening
    if (supportsPopover && !supportsHintPopover) {
      document.addEventListener('beforetoggle', (e) => {
        const target = e.target;
        if (!target || !target.id) return;
        const isToggletip = target.getAttribute('popover') === 'hint'
          && document.querySelector(`[popovertarget="${CSS.escape(target.id)}"]`);
        if (e.newState === 'open' && isToggletip) {
          target.setAttribute('popover', 'auto');
        }
      }, true);
    }

    // Native hover/focus fallback when browser lacks interestfor (WCAG 1.4.13 compliant)
    if (!supportsInterest) {
      let activeTip = null;
      let activeTrigger = null;
      let closeTimer = null;

      const openTip = (trig, tip) => {
        clearTimeout(closeTimer);
        if (activeTip && activeTip !== tip) closeTip(activeTip, activeTrigger);
        activeTip = tip;
        activeTrigger = trig;
        if (supportsPopover) {
          if (!isPopoverOpen(tip)) {
            try { tip.showPopover({ source: trig }); } catch {
              try { tip.showPopover(); } catch { /* ignore */ }
            }
          }
          placeHintFallback(trig, tip);
        } else {
          tip.classList.add(':popover-open');
          placeHintFallback(trig, tip);
          if (ownedExpanded.has(trig)) trig.setAttribute('aria-expanded', 'true');
          trig.classList.add('interest-source');
        }
      };

      const closeTip = (tip, trig) => {
        clearTimeout(closeTimer);
        if (!tip) return;
        if (supportsPopover) {
          if (isPopoverOpen(tip)) {
            try { tip.hidePopover(); } catch { /* ignore */ }
          }
        } else {
          tip.classList.remove(':popover-open');
          if (trig && ownedExpanded.has(trig)) trig.setAttribute('aria-expanded', 'false');
          trig?.classList.remove('interest-source');
        }
        if (activeTip === tip) {
          activeTip = null;
          activeTrigger = null;
        }
      };

      const scheduleClose = (tip, trig) => {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => closeTip(tip, trig), 130);
      };

      for (const trig of triggers) {
        const targetId = trig.getAttribute('interestfor');
        const tip = targetId ? document.getElementById(targetId) : null;
        if (!tip) continue;

        trig.addEventListener('pointerenter', () => openTip(trig, tip));
        trig.addEventListener('pointerleave', () => scheduleClose(tip, trig));
        trig.addEventListener('focus', () => openTip(trig, tip));
        trig.addEventListener('blur', () => scheduleClose(tip, trig));
        tip.addEventListener('pointerenter', () => clearTimeout(closeTimer));
        tip.addEventListener('pointerleave', () => scheduleClose(tip, trig));
      }

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && activeTip) {
          closeTip(activeTip, activeTrigger);
        }
      });
    }
  }

  // ---------- 12. Initialize Workspace Watcher + Poll Loop ----------
  async function init() {
    initTitleHints();
    resizeBgCanvas();
    window.addEventListener('resize', resizeBgCanvas);
    requestAnimationFrame(animateStage);

    if (window.sidecar && typeof window.sidecar.getWorkspaceUris === 'function') {
      window.sidecar.onWorkspaceChange(async (uris) => {
        state.workspaceUris = Array.isArray(uris) ? uris : [];
        state.lastDataVersion = '';
        const res = await apiFetch('/api/context', {
          method: 'POST',
          body: JSON.stringify({
            conversationId: window.sidecar.conversationId || '',
            workspaceUris: state.workspaceUris,
          }),
        }, { silent: true }).catch(() => null);
        if (res) {
          state.inProject = state.workspaceUris.length === 0 ? null : Boolean(res.inProject);
          if (res.snapshot) renderSnapshot(res.snapshot);
        }
      });
      state.workspaceUris = await window.sidecar.getWorkspaceUris().catch(() => []);
    }

    await refreshState({ force: true });

    let pollTimer = null;
    const scheduleNextPoll = () => {
      clearTimeout(pollTimer);
      const delayMs = document.hidden ? 10_000 : 1500;
      pollTimer = setTimeout(async () => {
        await refreshState();
        scheduleNextPoll();
      }, delayMs);
    };
    scheduleNextPoll();

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refreshState().then(scheduleNextPoll);
      } else {
        scheduleNextPoll();
      }
    });
  }

  init();
})();
