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
    // Xingxi Star Map view state
    mapLinksOn: true,
    mapZoom: 1,
    mapPanX: 0,
    mapPanY: 0,
    mapSearch: '',
    isPanningMap: false,
    panMoved: false,
    panStartX: 0,
    panStartY: 0,
    panOriginX: 0,
    panOriginY: 0,
    // Interactive UI states preserved across 1.5s polls
    expandedDiaries: new Set(),
    expandedPersonas: new Set(),
    editingMemId: '',
    renamingPersonaId: '',
    editingPersonaId: '',
    dirty: { mood: false, policy: false, sp: false },
    // Sprite motion triggers strictly on interaction or active conversation
    hasInitialSnap: false,
    seenActivityAt: 0,
    seenLastCareAt: 0,
    seenSpeakUpAt: 0,
    spriteMotionUntil: 0,
    motionAmp: 0,
    motionPhaseStartMs: 0,
  };

  const apiFetch = (url, opts = {}) => {
    if (window.sidecar && typeof window.sidecar.fetch === 'function') {
      return window.sidecar.fetch(url, opts).then((r) => r.json());
    }
    return fetch(url, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    }).then((r) => r.json());
  };

  const $ = (id) => document.getElementById(id);

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
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
      : section === 'sp' ? $('sp-dirty-bar')
      : null;
    if (bar) bar.classList.toggle('hidden', !state.dirty[section]);
  }

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

  function detectDarkTheme() {
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

  function resizeBgCanvas() {
    const stage = $('nest-stage');
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    bgCanvas.width = Math.round(rect.width * dpr);
    bgCanvas.height = Math.round(rect.height * dpr);
  }

  function activateSpriteMotion(durationMs = 2200) {
    const nowMs = performance.now();
    if (state.motionAmp <= 0.05) {
      state.motionPhaseStartMs = nowMs;
    }
    state.spriteMotionUntil = Math.max(state.spriteMotionUntil, nowMs + durationMs);
  }

  function animateStage(nowMs = performance.now()) {
    const w = bgCanvas.width;
    const h = bgCanvas.height;
    const tSec = nowMs / 1000;
    if (w && h) {
      const isDark = detectDarkTheme();
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

  // ---------- 3. Interactive Xingxi Star Map Renderer (Search, Pan, Zoom, Toggle Links) ----------
  const CHAPTER_COLORS = [
    '#f59e0b', // 0: Diary
    '#f472b6', // 1
    '#c084fc', // 2
    '#38bdf8', // 3
    '#34d399', // 4
    '#fb7185', // 5
    '#facc15', // 6
    '#2dd4bf', // 7
    '#a78bfa', // 8
  ];

  function drawStarMap(xingxi) {
    const canvas = $('starmap-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const stars = xingxi?.stars || [];
    const links = xingxi?.links || [];
    if (!stars.length) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('尚無星汐檔案，寫入記憶卡條目或日記即會亮起第一顆星', w / 2, h / 2);
      state.starsLayout = [];
      $('xx-map-hits').textContent = '';
      return;
    }

    const q = state.mapSearch.trim().toLowerCase();
    const cx = w / 2 + state.mapPanX;
    const cy = h / 2 + state.mapPanY;
    const zoom = state.mapZoom;
    const posById = new Map();
    const layout = [];
    let hitsCount = 0;

    stars.forEach((star, idx) => {
      const ch = Number(star.chapter) || 0;
      const baseAngle = ch === 0 ? Math.PI * 0.5 : ((ch - 1) / 8) * Math.PI * 2 - Math.PI / 2;
      const jitterAngle = (((idx * 37) % 13) - 6) * 0.08;
      const radius = ch === 0
        ? 26 + ((idx * 17) % 30)
        : 54 + ((idx * 29) % 36);
      const sx = cx + Math.cos(baseAngle + jitterAngle) * radius * 1.45 * zoom;
      const sy = cy + Math.sin(baseAngle + jitterAngle) * radius * 0.85 * zoom;
      const matched = q
        ? [star.title, star.text, star.chapterName, star.date].some((v) => String(v || '').toLowerCase().includes(q))
        : true;
      if (q && matched) hitsCount++;
      const node = {
        ...star,
        x: sx,
        y: sy,
        r: (3.4 + (star.energy || 0.5) * 3.8) * Math.min(1.5, Math.max(0.75, zoom * 0.9)),
        color: CHAPTER_COLORS[ch] || '#e2e8f0',
        matched,
      };
      posById.set(star.id, node);
      layout.push(node);
    });
    state.starsLayout = layout;
    $('xx-map-hits').textContent = q ? `${hitsCount} 顆` : '';

    if (state.mapLinksOn) {
      const EDGE_COLORS = {
        chapter: 'rgba(167, 139, 250, 0.34)',
        day: 'rgba(251, 191, 36, 0.36)',
        ref: 'rgba(244, 114, 182, 0.36)',
        bridge: 'rgba(45, 212, 191, 0.36)',
        similar: 'rgba(148, 163, 184, 0.25)',
      };
      ctx.lineWidth = 1;
      for (const l of links) {
        const a = posById.get(l.source);
        const b = posById.get(l.target);
        if (!a || !b) continue;
        const dim = q && !a.matched && !b.matched;
        ctx.save();
        ctx.globalAlpha = dim ? 0.14 : 1;
        ctx.strokeStyle = EDGE_COLORS[l.kind] || 'rgba(167, 139, 250, 0.24)';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
      }
    }

    for (const node of layout) {
      const selected = node.id === state.selectedStarId;
      ctx.save();
      ctx.globalAlpha = q && !node.matched ? 0.18 : (0.45 + 0.55 * (node.energy || 0.7));
      ctx.shadowColor = node.color;
      ctx.shadowBlur = selected ? 14 : (q && node.matched ? 10 : 6);
      ctx.fillStyle = node.color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, selected ? node.r + 2.2 : node.r, 0, Math.PI * 2);
      ctx.fill();
      if (selected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.6;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  // Pan, Wheel Zoom & Click Hit-Test on Star Map
  const starmapCanvas = $('starmap-canvas');
  starmapCanvas.addEventListener('pointerdown', (e) => {
    state.isPanningMap = true;
    state.panMoved = false;
    state.panStartX = e.clientX;
    state.panStartY = e.clientY;
    state.panOriginX = state.mapPanX;
    state.panOriginY = state.mapPanY;
    starmapCanvas.setPointerCapture?.(e.pointerId);
  });

  starmapCanvas.addEventListener('pointermove', (e) => {
    if (!state.isPanningMap) return;
    const dx = e.clientX - state.panStartX;
    const dy = e.clientY - state.panStartY;
    if (Math.hypot(dx, dy) > 4) state.panMoved = true;
    const rect = starmapCanvas.getBoundingClientRect();
    const scaleX = starmapCanvas.width / (rect.width || 1);
    const scaleY = starmapCanvas.height / (rect.height || 1);
    state.mapPanX = state.panOriginX + dx * scaleX;
    state.mapPanY = state.panOriginY + dy * scaleY;
    drawStarMap(state.snap?.xingxi);
  });

  starmapCanvas.addEventListener('pointerup', (e) => {
    const moved = state.panMoved;
    state.isPanningMap = false;
    starmapCanvas.releasePointerCapture?.(e.pointerId);
    if (moved) return;

    const rect = starmapCanvas.getBoundingClientRect();
    const scaleX = starmapCanvas.width / (rect.width || 1);
    const scaleY = starmapCanvas.height / (rect.height || 1);
    const mx = (e.clientX - rect.left) * scaleX;
    const my = (e.clientY - rect.top) * scaleY;

    let hit = null;
    let bestDist = 20;
    for (const node of state.starsLayout) {
      const d = Math.hypot(node.x - mx, node.y - my);
      if (d < bestDist) {
        bestDist = d;
        hit = node;
      }
    }
    if (!hit) return;
    state.selectedStarId = hit.id;
    $('star-detail').textContent =
      `【${hit.chapterName || hit.doc}】${hit.title}${hit.date ? `（${hit.date}）` : ''}\n\n${hit.text || '（暫無條目正文）'}`;
    drawStarMap(state.snap?.xingxi);
  });

  starmapCanvas.addEventListener('pointercancel', () => {
    state.isPanningMap = false;
  });

  starmapCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.14 : 0.88;
    state.mapZoom = Math.min(2.6, Math.max(0.5, state.mapZoom * factor));
    drawStarMap(state.snap?.xingxi);
  }, { passive: false });

  $('xx-map-search').addEventListener('input', (e) => {
    state.mapSearch = e.target.value;
    drawStarMap(state.snap?.xingxi);
  });

  $('xx-toggle-links').addEventListener('click', () => {
    state.mapLinksOn = !state.mapLinksOn;
    const btn = $('xx-toggle-links');
    btn.classList.toggle('active', state.mapLinksOn);
    btn.setAttribute('aria-pressed', String(state.mapLinksOn));
    btn.textContent = state.mapLinksOn ? '連線開' : '連線關';
    drawStarMap(state.snap?.xingxi);
  });

  $('xx-zoom-in').addEventListener('click', () => {
    state.mapZoom = Math.min(2.6, state.mapZoom * 1.2);
    drawStarMap(state.snap?.xingxi);
  });

  $('xx-zoom-out').addEventListener('click', () => {
    state.mapZoom = Math.max(0.5, state.mapZoom * 0.82);
    drawStarMap(state.snap?.xingxi);
  });

  $('xx-zoom-reset').addEventListener('click', () => {
    state.mapZoom = 1;
    state.mapPanX = 0;
    state.mapPanY = 0;
    state.mapSearch = '';
    $('xx-map-search').value = '';
    drawStarMap(state.snap?.xingxi);
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

  function updateProjectScopeUI() {
    const scopePill = $('scope-pill');
    const banner = $('standby-banner');
    const sendBtn = $('btn-whisper-send');
    const spSendBtn = $('btn-sp-send');
    const pickupBtn = $('btn-xingxi-pickup');

    if (state.inProject === false) {
      scopePill.textContent = '休眠待機（外部工作區）';
      scopePill.className = 'scope-pill standby';
      banner.classList.remove('hidden');
      sendBtn.disabled = true;
      spSendBtn.disabled = true;
      if (pickupBtn) pickupBtn.disabled = true;
    } else if (state.workspaceUris.length === 0) {
      scopePill.textContent = '本地預覽模式';
      scopePill.className = 'scope-pill active';
      banner.classList.add('hidden');
      sendBtn.disabled = false;
      spSendBtn.disabled = false;
      if (pickupBtn) pickupBtn.disabled = false;
    } else {
      const cid = state.snap?.activeConversationId;
      scopePill.textContent = cid ? `gemini_cat 連線中 (${cid.slice(-6)})` : 'gemini_cat 就緒';
      scopePill.className = 'scope-pill active';
      banner.classList.add('hidden');
      sendBtn.disabled = false;
      spSendBtn.disabled = false;
      if (pickupBtn) pickupBtn.disabled = false;
    }
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
    $('bar-satiety').style.width = `${nest.satiety}%`;
    $('val-satiety').textContent = nest.satiety;
    $('bar-energy').style.width = `${nest.energy}%`;
    $('val-energy').textContent = nest.energy;
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
      const blocked = lim.cooldownLeftSec > 0 || Boolean(lim.blockedReason);
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
    setHtmlStable($('mood-dims-grid'), mood.dims.map((d) => `
      <div class="dim-item">
        <div class="dim-head"><span>${esc(d.label)}</span><strong>${d.value}</strong></div>
        <div class="dim-track"><div class="dim-bar" style="width:${Math.min(100, d.value)}%"></div></div>
      </div>
    `).join(''));

    $('mood-inject-state').textContent = `${mood.injectPreview.state}`;
    $('mood-quota-text').textContent = `今日 ${mood.injectQuota.said} / ${mood.injectQuota.cap}`;
    $('mood-inject-preview').textContent = mood.injectPreview.text || `（狀態：${mood.injectPreview.state}，暫無待注入句子）`;

    setIfClean($('cfg-mood-enabled'), mood.config.enabled !== false, 'mood');
    setIfClean($('cfg-mood-autoJudge'), mood.config.autoJudge !== false, 'mood');
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
    setIfClean($('cfg-mood-conf'), mood.config.injectConfidence, 'mood');
    setIfClean($('cfg-mood-sigMood'), mood.config.sigMood, 'mood');
    setIfClean($('cfg-mood-sigDim'), mood.config.sigDim, 'mood');
    setIfClean($('cfg-mood-perDay'), mood.config.injectPerDay, 'mood');

    setHtmlStable($('mood-timeline'), (mood.timeline || []).map((t) => `
      <div class="row-item">
        <div class="row-top">
          <span>${new Date(t.at).toLocaleTimeString()} · ${esc(t.kind || 'chat')}</span>
          <strong class="tabular">心情 ${t.mood} (${t.delta >= 0 ? `+${t.delta}` : t.delta})</strong>
        </div>
        <div class="row-body">${esc(t.reason || '無說明')}</div>
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
            <span>${tr.at ? new Date(tr.at).toLocaleTimeString() : ''} · 問句：「${esc(tr.query)}」</span>
            <strong>${tr.gateBlocked ? '門檻擋掉' : `命中 ${tr.selectedIds?.length || 0} 條`}</strong>
          </div>
          <div class="row-body">${(tr.rows || []).slice(0, 5).map((r) => `[${r.omission}] P=${r.P} ${r.text}`).join('\n') || '（無候選）'}</div>
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
    $('sp-line-badge').textContent = `命中線 ${spPrev.hitLine}%`;
    const spWindowLabel = !spPrev.usePeakValley
      ? '【全天統一命中率】'
      : spPrev.peak
        ? `【峰時 ${spPrev.peakWindowsText || ''}】`
        : '【谷時（非峰時）】';
    $('sp-preview-text').textContent =
      `${spWindowLabel} 基礎 ${spPrev.baseLine}% × 時機因子 ${spPrev.factor} + 連沒中加成 ${spPrev.bonus}% = 命中線 ${spPrev.hitLine}%`
      + (spPrev.inQuiet ? '（目前在安靜時段內）' : '')
      + (speakUp.config.dryRun ? ' ｜ 試運行模式開啟中' : '');

    setIfClean($('sp-enabled'), speakUp.config.enabled, 'sp');
    setIfClean($('sp-dryRun'), speakUp.config.dryRun, 'sp');
    setIfClean($('sp-followActive'), speakUp.config.followActive !== false, 'sp');
    renderSpeakUpTargets(speakUp, snap.verifiedConversations || []);

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
    setIfClean($('sp-bonus'), speakUp.config.missBonus, 'sp');
    setIfClean($('sp-cap'), speakUp.config.bonusCap, 'sp');
    setIfClean($('sp-qStart'), speakUp.config.quietStartHour, 'sp');
    setIfClean($('sp-qEnd'), speakUp.config.quietEndHour, 'sp');
    updateSpeakUpQuietWarning();
    setIfClean($('sp-nearMin'), speakUp.config.nearThresholdMin, 'sp');
    setIfClean($('sp-nearFactor'), speakUp.config.nearFactor, 'sp');
    setIfClean($('sp-farMin'), speakUp.config.farThresholdMin, 'sp');
    setIfClean($('sp-farFactor'), speakUp.config.farFactor, 'sp');
    setIfClean($('sp-prompt'), speakUp.config.triggerPrompt, 'sp');

    setHtmlStable($('sp-logs'), (speakUp.state.logs || []).map((l) => `
      <div class="row-item">
        <div class="row-top"><span>${esc(l.time)}</span></div>
        <div class="row-body">${esc(l.text)}</div>
      </div>
    `).join('') || '<p class="muted-meta">尚無擲骰記錄。點上方「演練一次」立即試算。</p>');

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
    updateProjectScopeUI();
  }

  async function refreshState() {
    try {
      const qs = new URLSearchParams({
        conversationId: window.sidecar?.conversationId || '',
        workspaceUris: JSON.stringify(state.workspaceUris),
      });
      const res = await apiFetch(`/api/state?${qs.toString()}`, { method: 'GET' });
      if (res && res.ok) {
        if (typeof res.inProject === 'boolean') state.inProject = res.inProject;
        renderSnapshot(res);
      }
    } catch {
      // transient poll errors recover on next tick
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
    btn.addEventListener('click', () => triggerCare(btn.dataset.action));
  });

  $('nest-sync-chat').addEventListener('change', async () => {
    const res = await apiFetch('/api/nest/prefs', {
      method: 'POST',
      body: JSON.stringify({
        syncChatOnCare: $('nest-sync-chat').checked,
        conversationId: activeConversationId(),
      }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  $('btn-nest-clear').addEventListener('click', async () => {
    const res = await apiFetch('/api/nest/clear-pending', {
      method: 'POST',
      body: JSON.stringify({ conversationId: activeConversationId() }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  $('btn-whisper-queue').addEventListener('click', async () => {
    const input = $('whisper-input');
    const note = input.value.trim();
    if (!note) return;
    const res = await triggerCare('whisper', { note, sendToChat: false });
    if (!res?.limited) input.value = '';
  });

  $('btn-whisper-send').addEventListener('click', async () => {
    const input = $('whisper-input');
    const note = input.value.trim();
    if (!note) return;
    const res = await triggerCare('whisper', { note, sendToChat: true });
    if (!res?.limited) input.value = '';
  });

  $('whisper-input').addEventListener('keydown', (e) => {
    if (e.isComposing || e.key !== 'Enter') return;
    e.preventDefault();
    $('btn-whisper-queue').click();
  });

  // ---------- 7. Mood Tab Events ----------
  $('drawer-mood-cfg').addEventListener('input', () => setDirty('mood', true));
  $('drawer-mood-cfg').addEventListener('change', () => setDirty('mood', true));

  $('btn-mood-save').addEventListener('click', async () => {
    const patch = {
      enabled: $('cfg-mood-enabled').checked,
      autoJudge: $('cfg-mood-autoJudge').checked,
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
      injectPerDay: Number($('cfg-mood-perDay').value),
      sigMood: Number($('cfg-mood-sigMood').value),
      sigDim: Number($('cfg-mood-sigDim').value),
      injectConfidence: Number($('cfg-mood-conf').value),
      conversationId: activeConversationId(),
    };
    const res = await apiFetch('/api/mood/config', { method: 'POST', body: JSON.stringify(patch) });
    setDirty('mood', false);
    if (res?.snapshot) renderSnapshot(res.snapshot);
    else await refreshState();
    flashMsg('mood-save-msg', '已儲存心情設定 ✓');
  });

  $('btn-mood-nudge-up').addEventListener('click', async () => {
    const res = await apiFetch('/api/mood/delta', {
      method: 'POST',
      body: JSON.stringify({ moodDelta: 3, dims: { happy: 4 }, reason: '側邊欄手動微調開心 (+3)', source: 'manual', bypassDivisor: true }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  $('btn-mood-nudge-down').addEventListener('click', async () => {
    const res = await apiFetch('/api/mood/delta', {
      method: 'POST',
      body: JSON.stringify({ moodDelta: -3, dims: { sad: 3 }, reason: '側邊欄手動微調低落 (-3)', source: 'manual', bypassDivisor: true }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

  $('btn-mood-reset').addEventListener('click', async () => {
    const res = await apiFetch('/api/mood/reset', { method: 'POST', body: '{}' });
    if (res?.snapshot) renderSnapshot(res.snapshot);
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

  $('btn-mem-add').addEventListener('click', async () => {
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
  });

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
      return;
    }
    const res = await apiFetch('/api/memory/mutate', {
      method: 'POST',
      body: JSON.stringify({ action: act, id }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
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

  $('btn-pol-save').addEventListener('click', async () => {
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
      }),
    });
    setDirty('policy', false);
    if (res?.snapshot) renderSnapshot(res.snapshot);
    flashMsg('pol-save-msg', '已儲存記憶策略 ✓');
  });

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

  $('xingxi-backups-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-xx-restore]');
    if (!btn) return;
    const res = await apiFetch('/api/xingxi/restore', {
      method: 'POST',
      body: JSON.stringify({ backup: btn.dataset.xxRestore }),
    });
    if (res?.snapshot) renderSnapshot(res.snapshot);
    if (res?.ok) {
      $('xingxi-sched-summary').textContent = `已從備份 ${res.restoredFrom} 還原 ${res.file}（原版本已另存備份）。`;
    } else if (res?.error) {
      $('xingxi-sched-summary').textContent = `還原失敗：${res.error}`;
    }
  });

  $('btn-xingxi-save').addEventListener('click', async () => {
    const target = $('xingxi-chapter').value;
    const text = $('xingxi-entry').value.trim();
    if (!text) return;
    const res = target === 'diary'
      ? await apiFetch('/api/xingxi/diary', { method: 'POST', body: JSON.stringify({ entry: text }) })
      : await apiFetch('/api/xingxi/append', { method: 'POST', body: JSON.stringify({ chapter: target, content: text }) });
    $('xingxi-entry').value = '';
    if (res?.snapshot) renderSnapshot(res.snapshot);
  });

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

  $('tab-speakup').addEventListener('input', (e) => {
    if (e.target.id === 'sp-followActive' || e.target.classList.contains('sp-target-cb')) return;
    setDirty('sp', true);
    if (e.target.id === 'sp-qStart' || e.target.id === 'sp-qEnd') updateSpeakUpQuietWarning();
  });

  $('tab-speakup').addEventListener('change', (e) => {
    if (e.target.id === 'sp-followActive' || e.target.classList.contains('sp-target-cb')) return;
    setDirty('sp', true);
  });

  $('btn-sp-save').addEventListener('click', async () => {
    const peakDays = [...document.querySelectorAll('#sp-peakDays input[data-day]:checked')]
      .map((cb) => Number(cb.dataset.day));
    const res = await apiFetch('/api/speak-up/config', {
      method: 'POST',
      body: JSON.stringify({
        enabled: $('sp-enabled').checked,
        dryRun: $('sp-dryRun').checked,
        followActive: $('sp-followActive').checked,
        targetConversations: collectSelectedTargets(),
        usePeakValley: $('sp-usePeakValley').checked,
        peakDays,
        peakWindowsText: $('sp-peakWindows').value,
        peakHitLine: Number($('sp-peak').value),
        valleyHitLine: Number($('sp-valley').value),
        intervalMinutes: Number($('sp-interval').value),
        cooldownMin: Number($('sp-cooldown').value),
        missBonus: Number($('sp-bonus').value),
        bonusCap: Number($('sp-cap').value),
        quietStartHour: Number($('sp-qStart').value),
        quietEndHour: Number($('sp-qEnd').value),
        nearThresholdMin: Number($('sp-nearMin').value),
        nearFactor: Number($('sp-nearFactor').value),
        farThresholdMin: Number($('sp-farMin').value),
        farFactor: Number($('sp-farFactor').value),
        timezone: $('sp-timezone').value.trim(),
        triggerPrompt: $('sp-prompt').value,
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
    if (state.editingPersonaId && act === 'delete' && id === state.editingPersonaId) {
      resetPersonaEditor();
    }
    await postPersonaMutate({ action: act, id });
  });

  // ---------- 12. Initialize Workspace Watcher + Poll Loop ----------
  async function init() {
    resizeBgCanvas();
    window.addEventListener('resize', resizeBgCanvas);
    requestAnimationFrame(animateStage);

    if (window.sidecar && typeof window.sidecar.getWorkspaceUris === 'function') {
      window.sidecar.onWorkspaceChange(async (uris) => {
        state.workspaceUris = Array.isArray(uris) ? uris : [];
        const res = await apiFetch('/api/context', {
          method: 'POST',
          body: JSON.stringify({
            conversationId: window.sidecar.conversationId || '',
            workspaceUris: state.workspaceUris,
          }),
        }).catch(() => null);
        if (res) {
          state.inProject = state.workspaceUris.length === 0 ? null : Boolean(res.inProject);
          if (res.snapshot) renderSnapshot(res.snapshot);
        }
      });
      state.workspaceUris = await window.sidecar.getWorkspaceUris().catch(() => []);
    }

    await refreshState();
    setInterval(refreshState, 1500);
  }

  init();
})();
