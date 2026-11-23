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
    mapZoom: 1,
    mapRotY: 0.42,
    mapRotX: -0.18,
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
        ? `rgba(186, 230, 253, ${alpha})`
        : `rgba(14, 116, 144, ${alpha})`;
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
          ? `rgba(186, 230, 253, ${alpha.toFixed(2)})`
          : `rgba(14, 116, 144, ${alpha.toFixed(2)})`;
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

  function removeOuterWhiteBackground(img) {
    const off = document.createElement('canvas');
    const size = 420;
    off.width = size;
    off.height = size;
    const ctx = off.getContext('2d');
    ctx.drawImage(img, 0, 0, size, size);

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

  function renderSprite(file) {
    if (!file || state.currentSpriteUrl === file) return;
    state.currentSpriteUrl = file;
    const targetCanvas = $('sprite-canvas');
    const tCtx = targetCanvas.getContext('2d');
    const draw = (sourceCanvas) => {
      tCtx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
      tCtx.drawImage(sourceCanvas, 0, 0, targetCanvas.width, targetCanvas.height);
    };

    if (cleanedSprites.has(file)) {
      draw(cleanedSprites.get(file));
      return;
    }

    const img = new Image();
    img.onload = () => {
      const processed = file.endsWith('.png') ? img : removeOuterWhiteBackground(img);
      cleanedSprites.set(file, processed);
      if (state.currentSpriteUrl === file) draw(processed);
    };
    img.src = `/assets/${file}`;
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
  const STAR_PALETTE = [
    [255, 140, 176], [255, 168, 142], [255, 196, 120], [255, 222, 128],
    [244, 236, 142], [198, 238, 150], [150, 236, 178], [126, 232, 210],
    [122, 222, 242], [134, 202, 255], [154, 180, 255], [178, 162, 255],
    [204, 152, 255], [232, 148, 242], [250, 146, 214], [255, 156, 192],
    [255, 182, 212], [186, 226, 255], [176, 244, 226], [255, 214, 168],
    [218, 188, 255], [255, 168, 168], [168, 236, 255], [236, 214, 255],
  ];
  const CHAPTER_RGB = [
    null,
    [255, 152, 188], [255, 204, 132], [132, 226, 212], [148, 196, 255],
    [198, 168, 255], [255, 176, 148], [162, 232, 172], [242, 164, 228],
  ];
  const MONTH_RGB = [
    [142, 202, 255], [176, 184, 255], [156, 234, 196], [194, 238, 156],
    [242, 232, 142], [255, 210, 132], [255, 176, 142], [255, 152, 176],
    [238, 158, 226], [202, 166, 255], [164, 186, 255], [142, 222, 242],
  ];

  function makeStarSprite(rgb) {
    const [r, g, b] = rgb;
    const size = 64;
    const half = size / 2;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const gCtx = c.getContext('2d');
    const mix = (a, d, k) => Math.round(a * (1 - k) + d * k);
    const grad = gCtx.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0.0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.1, `rgba(${mix(255, r, 0.45)},${mix(255, g, 0.45)},${mix(255, b, 0.45)},0.96)`);
    grad.addColorStop(0.24, `rgba(${r},${g},${b},0.55)`);
    grad.addColorStop(0.52, `rgba(${r},${g},${b},0.16)`);
    grad.addColorStop(1.0, `rgba(${r},${g},${b},0)`);
    gCtx.fillStyle = grad;
    gCtx.fillRect(0, 0, size, size);
    return c;
  }

  const paletteSprites = STAR_PALETTE.map(makeStarSprite);
  const chapterSprites = CHAPTER_RGB.map((c) => (c ? makeStarSprite(c) : null));
  const monthSprites = MONTH_RGB.map(makeStarSprite);
  const coreSprite = makeStarSprite([255, 244, 214]);

  function hashStr(str) {
    let h = 2166136261 >>> 0;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function randomSphereVec(seedStr) {
    const h = hashStr(seedStr);
    const u = ((h & 0xffff) / 0xffff) * 2 - 1;
    const theta = (((h >>> 16) & 0xffff) / 0xffff) * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    return [r * Math.cos(theta), u * 0.86, r * Math.sin(theta)];
  }

  const universeDust = (() => {
    let seed = 20260417;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const tints = [
      [220, 232, 255], [255, 228, 214], [210, 244, 255],
      [238, 218, 255], [255, 244, 222], [198, 222, 255],
    ];
    const dust = [];
    for (let i = 0; i < 360; i++) {
      const k = rand();
      dust.push({
        u: rand(),
        v: rand(),
        r: k < 0.78 ? 0.45 + rand() * 0.65 : k < 0.96 ? 1.0 + rand() * 0.75 : 1.7 + rand() * 0.9,
        alpha: 0.16 + rand() * 0.66,
        freq: 0.35 + rand() * 1.4,
        phase: rand() * Math.PI * 2,
        tint: tints[Math.floor(rand() * tints.length)],
        parallax: 0.1 + rand() * 0.45,
      });
    }
    return dust;
  })();

  const nebulaBands = [
    { u: 0.34, v: 0.42, rx: 0.44, ry: 0.2, rot: -0.32, c1: [86, 118, 214, 0.085], c2: [148, 98, 198, 0.038], phase: 0.4 },
    { u: 0.68, v: 0.58, rx: 0.4, ry: 0.18, rot: 0.28, c1: [72, 156, 196, 0.068], c2: [188, 118, 168, 0.03], phase: 2.1 },
  ];

  function pickStarColorAndSprite(s) {
    if (s.isCore) return { rgb: [255, 244, 214], sprite: coreSprite };
    const idx = hashStr(`${s.id}|c`) % STAR_PALETTE.length;
    if (s.kind === 'diary' && s.date) {
      const m = Math.max(0, Math.min(11, (parseInt(s.date.slice(5, 7), 10) || 1) - 1));
      if ((hashStr(s.id) & 3) === 0) return { rgb: MONTH_RGB[m], sprite: monthSprites[m] };
    } else if (s.chapter && CHAPTER_RGB[s.chapter]) {
      if ((hashStr(s.id) & 3) === 0) return { rgb: CHAPTER_RGB[s.chapter], sprite: chapterSprites[s.chapter] };
    }
    return { rgb: STAR_PALETTE[idx], sprite: paletteSprites[idx] };
  }

  function fmtDateTs(ts) {
    if (!ts || !Number.isFinite(ts)) return '--';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function rebuildUniverse3D(xingxi) {
    const rawStars = Array.isArray(xingxi?.stars) ? xingxi.stars : [];
    const rawLinks = Array.isArray(xingxi?.links) ? xingxi.links : [];
    const R = 210;

    const cloned = rawStars.map((s, idx) => ({
      ...s,
      ts: Number(s.ts) || (1704067200000 + idx * 86400000),
      isCore: false,
    }));

    const core = cloned.find((s) => Number(s.chapter) === 1) || cloned[0];
    if (core) {
      core.isCore = true;
      core.x = 0;
      core.y = 0;
      core.z = 0;
    }

    const outer = cloned
      .filter((s) => !s.isCore && (s.kind === 'diary' || s.eventDate))
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const outerLen = outer.length || 1;
    outer.forEach((s, i) => {
      const rank = outerLen === 1 ? 0.5 : i / (outerLen - 1);
      const [vx, vy, vz] = randomSphereVec(`${s.id}|d`);
      const h = hashStr(`${s.id}|dr`);
      const jitter = (((h % 200) - 100) / 1000) * 0.08;
      const dist = R * Math.max(0.54, Math.min(1.14, 0.56 + rank * 0.54 + jitter));
      s.x = vx * dist;
      s.y = vy * dist;
      s.z = vz * dist;
      s.ringRank = rank;
    });

    const inner = cloned.filter((s) => !s.isCore && s.kind === 'card' && !s.eventDate);
    for (const s of inner) {
      const [vx, vy, vz] = randomSphereVec(`${s.id}|c`);
      const h = hashStr(`${s.id}|r`);
      const dist = R * (0.16 + ((h % 1000) / 1000) * 0.44);
      s.x = vx * dist;
      s.y = vy * dist;
      s.z = vz * dist;
    }

    for (const s of cloned) {
      const { rgb, sprite } = pickStarColorAndSprite(s);
      s.rgb = rgb;
      s.sprite = sprite;
      s.baseSize = s.isCore
        ? 4.6
        : (s.kind === 'diary' ? 2.1 : 1.55) + (s.energy || 0.5) * (s.kind === 'diary' ? 2.1 : 1.65);
    }

    const byId = new Map(cloned.map((s) => [s.id, s]));
    const neighbors = new Map();
    const resolvedLinks = [];
    for (const l of rawLinks) {
      const a = byId.get(l.source);
      const b = byId.get(l.target);
      if (!a || !b) continue;
      resolvedLinks.push({ ...l, a, b });
      if (!neighbors.has(a.id)) neighbors.set(a.id, new Set());
      if (!neighbors.has(b.id)) neighbors.set(b.id, new Set());
      neighbors.get(a.id).add(b.id);
      neighbors.get(b.id).add(a.id);
    }

    const tsList = [...new Set(cloned.map((s) => s.ts).filter((t) => t > 0))].sort((a, b) => a - b);
    state.stars3D = cloned;
    state.starLinks3D = resolvedLinks;
    state.neighborsById = neighbors;
    state.tlTsList = tsList;

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
    const focal = 680;
    const dist = z2 + focal;
    if (dist < 80) return null;
    const k = (focal / dist) * state.mapZoom;
    return {
      sx: w / 2 + x1 * k,
      sy: h / 2 + y2 * k,
      z: z2,
      k,
    };
  }

  function renderSelectedStarDetail(star) {
    const detail = $('star-detail');
    if (!detail) return;
    if (!star) {
      detail.textContent = '點擊上方任一星點，即可高亮關聯星座並閱讀該章條目或當日日記正文。';
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
      const sig = `${stars.length}:${links.length}:${stars.map((s) => `${s.id}:${s.title}:${s.ts || 0}`).join('|')}`;
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
    const h = Math.max(220, Math.round(rect.height || 320));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // 1. Deep space gradient + breathing nebula + 360 parallax star-dust
    const bgGrad = ctx.createRadialGradient(w * 0.5, h * 0.45, 10, w * 0.5, h * 0.5, Math.max(w, h) * 0.78);
    bgGrad.addColorStop(0, '#0b132c');
    bgGrad.addColorStop(0.55, '#050816');
    bgGrad.addColorStop(1, '#02030a');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    const tSec = nowMs * 0.001;
    const span = Math.max(w, h);
    for (const nb of nebulaBands) {
      const cx = (nb.u + Math.sin(tSec * 0.05 + nb.phase) * 0.02) * w;
      const cy = (nb.v + Math.cos(tSec * 0.04 + nb.phase) * 0.02) * h;
      const r = span * nb.rx;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(nb.rot);
      ctx.scale(1, nb.ry / nb.rx);
      const ng = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      const [r1, g1, b1, a1] = nb.c1;
      const [r2, g2, b2, a2] = nb.c2;
      ng.addColorStop(0, `rgba(${r1},${g1},${b1},${a1})`);
      ng.addColorStop(0.5, `rgba(${r2},${g2},${b2},${a2})`);
      ng.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = ng;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    for (const p of universeDust) {
      const ox = ((p.u * w + state.mapRotY * 55 * p.parallax) % w + w) % w;
      const oy = ((p.v * h + state.mapRotX * 38 * p.parallax) % h + h) % h;
      const breath = 0.58 + 0.42 * Math.sin(tSec * p.freq + p.phase);
      const a = p.alpha * breath;
      const [r, g, b] = p.tint;
      ctx.fillStyle = `rgba(${r},${g},${b},${a.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(ox, oy, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

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

    // 2. Search filter & 3D projection
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
    projected.sort((a, b) => a.pr.z - b.pr.z);
    state.starsLayout = projected.map(({ s, pr }) => ({
      ...s,
      x: pr.sx,
      y: pr.sy,
      r: Math.max(4, s.baseSize * pr.k * 2.1),
    }));
    $('xx-map-hits').textContent = q ? `${hitsCount} 顆` : '';

    const focusId = state.hoveredStarId || state.selectedStarId;
    const focusNeighbors = focusId ? state.neighborsById.get(focusId) : null;

    // 3. Constellation lines & Shared-word Bridges
    if (state.mapLinksOn) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const bridgeMidpoints = [];
      for (const l of state.starLinks3D) {
        const pa = l.a._proj;
        const pb = l.b._proj;
        if (!pa || !pb) continue;
        if (q && !l.a.matched && !l.b.matched) continue;
        const isFocusEdge = Boolean(focusId && (l.a.id === focusId || l.b.id === focusId));
        if (focusId && !isFocusEdge) continue;

        if (l.kind === 'bridge') {
          if (!isFocusEdge && (l.weight || 0) < 0.56) continue;
          const alpha = isFocusEdge ? 0.62 : 0.13 * (l.weight || 0.5);
          ctx.strokeStyle = `rgba(255, 214, 150, ${alpha})`;
          ctx.lineWidth = isFocusEdge ? 1.35 : 0.75;
          ctx.beginPath();
          ctx.moveTo(pa.sx, pa.sy);
          ctx.lineTo(pb.sx, pb.sy);
          ctx.stroke();
          if (isFocusEdge && l.label) {
            bridgeMidpoints.push({
              x: (pa.sx + pb.sx) * 0.5,
              y: (pa.sy + pb.sy) * 0.5,
              text: l.label,
            });
          }
          continue;
        }

        const [r, g, b] = l.a.rgb || [180, 200, 255];
        const alpha = isFocusEdge ? 0.55 : 0.14 * (l.weight || 0.5);
        ctx.strokeStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.lineWidth = isFocusEdge ? 1.3 : 0.75;
        ctx.beginPath();
        ctx.moveTo(pa.sx, pa.sy);
        ctx.lineTo(pb.sx, pb.sy);
        ctx.stroke();
      }
      ctx.restore();

      if (bridgeMidpoints.length) {
        ctx.save();
        ctx.font = '10.5px "Microsoft JhengHei UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (const m of bridgeMidpoints.slice(0, 10)) {
          const tw = ctx.measureText(m.text).width;
          const pw = tw + 10;
          const ph = 15;
          ctx.fillStyle = 'rgba(10, 14, 28, 0.82)';
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

    // 4. Render 3D Pearl Stars & Core Star ("我是誰")
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const { s, pr } of projected) {
      if (q && !s.matched) continue;
      if (s.isCore) {
        const pulse = 0.92 + 0.14 * Math.sin(tSec * 1.6);
        const coreR = Math.max(4.5, 9.5 * pr.k * pulse);
        const [cr, cg, cb] = s.rgb;
        for (const [mult, al] of [[6.8, 0.07], [4.0, 0.16], [2.3, 0.34]]) {
          const rad = coreR * mult;
          const g = ctx.createRadialGradient(pr.sx, pr.sy, 0, pr.sx, pr.sy, rad);
          g.addColorStop(0, `rgba(255,252,240,${al * 1.4})`);
          g.addColorStop(0.45, `rgba(${cr},${cg},${cb},${al})`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(pr.sx, pr.sy, rad, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(255,255,255,0.98)';
        ctx.beginPath();
        ctx.arc(pr.sx, pr.sy, coreR * 0.55, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }

      const isFocused = s.id === focusId;
      const isNeighbor = Boolean(focusNeighbors && focusNeighbors.has(s.id));
      const twinkle = 0.84 + 0.16 * Math.sin(tSec * 1.8 + (hashStr(s.id) % 100) * 0.06);
      let alpha = Math.min(1, (0.38 + (s.energy || 0.5) * 0.62) * twinkle);
      if (focusId && !isFocused && !isNeighbor) alpha *= 0.28;
      if (isFocused || isNeighbor) alpha = 1;

      const rad = Math.max(0.9, s.baseSize * pr.k * (isFocused ? 1.55 : isNeighbor ? 1.25 : 1));
      const drawW = Math.max(6, rad * 6.4);
      ctx.globalAlpha = alpha;
      ctx.drawImage(s.sprite, pr.sx - drawW / 2, pr.sy - drawW / 2, drawW, drawW);
      if (rad > 1.5 || isFocused) {
        ctx.globalAlpha = Math.min(1, alpha * 1.12);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(pr.sx, pr.sy, Math.max(0.7, rad * 0.36), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // 5. Labels for Core Star, Focused Star, and Selected Star
    ctx.save();
    ctx.textBaseline = 'middle';
    const coreStar = stars.find((s) => s.isCore);
    if (coreStar && coreStar._proj && (!q || coreStar.matched)) {
      const cp = coreStar._proj;
      ctx.font = '600 11.5px "Microsoft JhengHei UI", system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255, 248, 228, 0.94)';
      ctx.fillText('我是誰', cp.sx + 12, cp.sy);
    }

    for (const targetId of new Set([state.selectedStarId, state.hoveredStarId].filter(Boolean))) {
      const st = stars.find((x) => x.id === targetId);
      if (!st || !st._proj) continue;
      const { sx, sy } = st._proj;
      ctx.strokeStyle = targetId === state.selectedStarId
        ? 'rgba(255, 232, 178, 0.92)'
        : 'rgba(255, 255, 255, 0.72)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.arc(sx, sy, 10, 0, Math.PI * 2);
      ctx.stroke();
      if (!st.isCore) {
        ctx.font = '500 11px "Microsoft JhengHei UI", system-ui, sans-serif';
        ctx.fillStyle = 'rgba(245, 247, 255, 0.95)';
        ctx.fillText((st.title || '').slice(0, 18), sx + 13, sy);
      }
    }
    ctx.restore();
    ctx.restore();
  }

  function animateStarMapLoop(nowMs = performance.now()) {
    const dt = state.lastStarFrameMs ? Math.min(0.08, (nowMs - state.lastStarFrameMs) / 1000) : 0.016;
    state.lastStarFrameMs = nowMs;
    const xingxiPanel = $('tab-xingxi');
    if (xingxiPanel && !xingxiPanel.hidden && !document.hidden) {
      if (!prefersReducedMotion && !state.isDraggingMap && !state.hoveredStarId) {
        state.mapRotY += dt * 0.018;
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
    const factor = Math.exp(-e.deltaY * 0.0012);
    state.mapZoom = Math.min(3.4, Math.max(0.25, state.mapZoom * factor));
    drawStarMap(null);
  }, { passive: false });

  $('xx-map-search').addEventListener('input', (e) => {
    state.mapSearch = e.target.value;
    drawStarMap(null);
  });

  $('xx-toggle-links').addEventListener('click', () => {
    state.mapLinksOn = !state.mapLinksOn;
    const btn = $('xx-toggle-links');
    btn.classList.toggle('active', state.mapLinksOn);
    btn.setAttribute('aria-pressed', String(state.mapLinksOn));
    btn.textContent = state.mapLinksOn ? '連線開' : '連線關';
    drawStarMap(null);
  });

  $('xx-zoom-in').addEventListener('click', () => {
    state.mapZoom = Math.min(3.4, state.mapZoom * 1.22);
    drawStarMap(null);
  });

  $('xx-zoom-out').addEventListener('click', () => {
    state.mapZoom = Math.max(0.25, state.mapZoom * 0.82);
    drawStarMap(null);
  });

  $('xx-zoom-reset').addEventListener('click', () => {
    state.mapZoom = 1;
    state.mapRotY = 0.42;
    state.mapRotX = -0.18;
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
      scopePill.textContent = '連線中斷（重試中）';
      scopePill.className = 'scope-pill offline';
      banner.classList.toggle('hidden', !isStandby);
    } else if (isStandby) {
      scopePill.textContent = '休眠待機（外部工作區）';
      scopePill.className = 'scope-pill standby';
      banner.classList.remove('hidden');
    } else if (state.workspaceUris.length === 0) {
      scopePill.textContent = '本地預覽模式';
      scopePill.className = 'scope-pill active';
      banner.classList.add('hidden');
    } else {
      const cid = state.snap?.activeConversationId;
      scopePill.textContent = cid ? `gemini_cat 連線中 (${cid.slice(-6)})` : 'gemini_cat 就緒';
      scopePill.className = 'scope-pill active';
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

    // Header & Stage Hero
    $('hdr-persona-pill').textContent = persona.resolvedName || '人設待選';
    $('hdr-emoji').textContent = mood.emoji;
    $('hdr-mood-text').textContent = `${mood.moodLabel} ${mood.mood}`;
    $('val-mood').textContent = mood.mood;
    if ($('val-mood-mirror')) $('val-mood-mirror').textContent = mood.mood;
    $('activity-text').textContent = nest.activity?.label || '在貓窩裡等你回來～';

    const dot = $('activity-badge');
    dot.className = 'activity-dot' + (
      nest.sleeping ? ' sleep'
      : (nest.activity?.phase === 'thinking' || nest.activity?.phase === 'tool') ? ' busy'
      : ''
    );

    renderSprite(nest.sprite);

    $('bar-mood').style.width = `${mood.mood}%`;
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
    $('nest-pending-text').textContent = `待帶入下一輪：${pendingCount} 則`;
    $('btn-nest-clear').classList.toggle('hidden', pendingCount <= 0);

    // Tab 1: Mood
    $('mood-engine-badge').textContent = mood.judgeLabel || '對話內 AI ＋ 本地兜底';
    const thoughtCard = $('mood-inner-thought-card');
    if (thoughtCard) {
      const thoughtEnabled = mood.config.innerThoughtEnabled !== false;
      const thoughtText = String(mood.lastInnerThought || '').trim();
      if (!thoughtEnabled) {
        $('mood-thought-meta').textContent = '已關閉';
        $('mood-inner-thought').textContent = '目前已關閉「第一人稱內心獨白」記錄開關（可於下方設定抽屜開啟）。';
      } else if (thoughtText) {
        const tsStr = mood.lastInnerThoughtAt ? new Date(mood.lastInnerThoughtAt).toLocaleTimeString() : '剛才';
        $('mood-thought-meta').textContent = `${tsStr} · 真實心聲`;
        $('mood-inner-thought').textContent = thoughtText;
      } else {
        $('mood-thought-meta').textContent = '等待寫下';
        $('mood-inner-thought').textContent = '這輪還沒寫下第一人稱內心獨白；當她有真實情緒觸動或感觸時，會把心裡沒說出口的話記在這裡。';
      }
    }

    setHtmlStable($('mood-dims-grid'), mood.dims.map((d) => `
      <div class="dim-item">
        <div class="dim-head"><span>${esc(d.label)}</span><strong>${d.value}</strong></div>
        <div class="dim-track"><div class="dim-bar" style="width:${Math.min(100, d.value)}%"></div></div>
      </div>
    `).join(''));

    $('mood-inject-state').textContent = `${mood.injectPreview.state}`;
    const injLimitText = mood.injectQuota.unlimited ? '不限' : String(mood.injectQuota.cap);
    const chQuota = mood.changeQuota || { count: 0, cap: 0, unlimited: true };
    const chLimitText = chQuota.unlimited || chQuota.cap === 0 ? '不限' : String(chQuota.cap);
    $('mood-quota-text').textContent = `提醒 ${mood.injectQuota.said}/${injLimitText} · 變化 ${chQuota.count}/${chLimitText}`;
    $('mood-inject-preview').textContent = mood.injectPreview.text || `（狀態：${mood.injectPreview.state}，暫無待注入句子）`;

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
        $('sp-silence-text').textContent = `自主勿擾中至 ${untilStr}${spPrev.silentReason ? `（${spPrev.silentReason}）` : ''} — 明確提醒仍會準點通知`;
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
    setHtmlStable($('sp-freshItemsList'), combinedFreshHtml || '<p class="muted-meta">目前見聞籃是空的；啟用後每天會在早晚自動各逛一次，也可按右上「立即逛一逛」試抓。</p>');

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
          pairBox.textContent = `臨時配對碼：${tgCfg.pairCode}（剩 ${minsLeft} 分鐘）— 請直接在 Telegram 私訊你的 Bot 傳送：/bind ${tgCfg.pairCode}`;
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

  $('btn-pol-reset').addEventListener('click', async () => {
    const res = await apiFetch('/api/memory/mutate', {
      method: 'POST',
      body: JSON.stringify({ action: 'resetPolicy' }),
    });
    setDirty('policy', false);
    if (res?.snapshot) renderSnapshot(res.snapshot);
    flashMsg('pol-save-msg', '已恢復預設參數 ✓');
  });

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

  $('btn-xingxi-sched-save').addEventListener('click', async () => {
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
  });

  $('btn-xingxi-pickup').addEventListener('click', async () => {
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
  });

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

  $('btn-sp-add-routine')?.addEventListener('click', async () => {
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
  });

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

  $('btn-sp-save').addEventListener('click', async () => {
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
          weatherCity: $('sp-freshWeatherCity')?.value.trim() || '',
          dailyShareLimit: Number($('sp-freshDailyLimit')?.value ?? 2),
          maxAgeHours: Number($('sp-freshMaxAgeHours')?.value ?? 72),
        },
      }),
    });
    setDirty('sp', false);
    if (res?.snapshot) renderSnapshot(res.snapshot);
    flashMsg('sp-save-msg', '已儲存搭話設定 ✓');
  });

  $('btn-sp-dry').addEventListener('click', async () => {
    const res = await apiFetch('/api/speak-up/roll', {
      method: 'POST',
      body: JSON.stringify({ mode: 'dry', conversationId: activeConversationId() }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  $('btn-sp-send').addEventListener('click', async () => {
    const res = await apiFetch('/api/speak-up/roll', {
      method: 'POST',
      body: JSON.stringify({ mode: 'send', conversationId: activeConversationId() }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

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
      $('per-scope-notice').textContent = res.error;
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

  $('btn-per-create').addEventListener('click', async () => {
    const name = $('per-new-name').value.trim();
    const text = $('per-new-text').value;
    if (!name) return;
    const res = state.editingPersonaId
      ? await postPersonaMutate({ action: 'update', id: state.editingPersonaId, name, text })
      : await postPersonaMutate({ action: 'create', name, text, activate: true });
    if (res?.ok) resetPersonaEditor();
  });

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

  // ---------- 12. Initialize Workspace Watcher + Poll Loop ----------
  async function init() {
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
