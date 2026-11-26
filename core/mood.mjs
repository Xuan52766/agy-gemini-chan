/**
 * @fileoverview Mood & 7-emotion engine ported from `dsh-feiyu-mood`.
 *
 * Includes:
 * - Mood baseline (`70`), floor (`0`), step divisor (`3`), tail saturation (`>=85` / `<=40` halved)
 * - 7 emotion dimensions (`happy`, `calm`, `sweet`, `heartache`, `worry`, `sad`, `jealous`)
 * - Exponential decay (`12h` mood half-life toward baseline, `90m` emotion half-life toward 0)
 * - 5 mood tiers (`great >=80`, `good >=62`, `ok >=42`, `worry >=25`, `sad <25`)
 * - Mode classification (`user`, `work`, `speak-up`) + noise suppression
 * - Zero-external-API mood judge:
 *     1. Primary: Active conversation AI calls `mood_update` MCP tool in-turn (`source: 'chat-ai'`)
 *     2. Safety net: Built-in local Chinese/English affective analyzer on `Stop` when AI didn't judge
 * - One-shot context injection (`event` / `label` / `off`) with confidence & daily quota caps
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePrompt } from './prompts.mjs';
import {
  clampNum,
  getDataPaths,
  getProjectRoot,
  localDayKey,
  normalizeCustomPrompt,
  readJsonSafe,
  renderPromptTemplate,
  withFileLockSync,
  writeJsonAtomic,
} from './storage.mjs';

export const MOOD_STEP_DIVISOR = 3;
export const DIM_HALF_LIFE_MIN = 90;
export const ANGRY_HALF_LIFE_MIN = 45;

export const DIMS = [
  ['happy', '開心'],
  ['calm', '踏實'],
  ['sweet', '甜蜜'],
  ['heartache', '心疼'],
  ['worry', '擔心'],
  ['sad', '難過'],
  ['jealous', '吃醋'],
  // dsh-feiyu-mood v0.9.0: 生氣只對「事」不對「人」（事情卡住、白忙一場、替對方氣；絕不因對方本人而生氣）
  ['angry', '生氣'],
];

const FAST_DECAY_DIMS = new Set(['angry']);

const DIM_PLAIN = {
  happy: '心裡挺高興',
  calm: '心裡踏實',
  sweet: '心裡甜',
  heartache: '心疼得不行',
  worry: '放心不下',
  sad: '有點難過',
  jealous: '有點吃醋',
  angry: '心裡有火',
};

const DIM_SHORT = {
  happy: '挺高興',
  calm: '挺踏實',
  sweet: '有點甜',
  heartache: '有點心疼',
  worry: '有點掛心',
  sad: '有點難過',
  jealous: '有點酸',
  angry: '有點氣',
};

export const INJECT_MODES = ['off', 'label', 'event'];

export const DEFAULT_MOOD_CONFIG = {
  enabled: true,
  autoJudge: true,
  innerThoughtEnabled: true,
  judgeMode: 'hybrid', // 'hybrid' (in-conversation AI via mood_update + Stop local fallback) | 'in_chat_only' | 'local'
  slotId: 'gemini-cat-main',
  selfName: 'Gemini-chan',
  ownerName: '主人',
  selfPronoun: '我',
  selfAliases: '',
  ownerAliases: '',
  moodBase: 70,
  moodFloor: 0,
  decayHalfHours: 12,
  injectMode: 'event',
  injectConfidence: 60,
  sigMood: 3,
  sigDim: 5,
  injectPerDay: 6,
  injectUnlimited: false,
  changesPerDay: 0, // 0 = unlimited numeric mood changes per day
  stepDivisor: MOOD_STEP_DIVISOR,
  inChatRulePrompt: '',
};

export function buildDefaultMoodRulePrompt(cfg = DEFAULT_MOOD_CONFIG) {
  const owner = cfg?.ownerName || '主人';
  const selfName = cfg?.selfName || 'Gemini-chan';
  const selfPronoun = cfg?.selfPronoun || '我';
  const thoughtActive = cfg?.innerThoughtEnabled !== false;
  const thoughtPart = thoughtActive
    ? `\n- 只要這輪心裡有感觸、小得意、心疼、替對方掛心、睏意或沒直接說出口的吐槽，請順手填寫 \`innerThought\`（用「${selfPronoun}」第一人稱、貼合${selfName}人設口氣寫真實心裡話；只顯示於貓窩心情小劇場卡片，絕對不要印進聊天回覆），即使 \`moodDelta\` 為 \`0\` 也能單獨留下內心想法。`
    : '';
  return `【對話內心情自評與內心小劇場（免外部 API）】透過 MCP \`call_mcp_tool\`（Server: \`"gemini-cat_companion"\`, Tool: \`"mood_update"\`）安靜記錄你的心情波動與內心想法：
- 參數格式：\`{"subject":"owner"|"self","moodDelta":-10..10,"dims":{"happy":0,"calm":0,"sweet":0,"heartache":0,"worry":0,"sad":0,"jealous":0,"angry":0},"reason":"過去式簡短原因"${thoughtActive ? ',"innerThought":"第一人稱真實心裡獨白"' : ''}}\`${thoughtPart}
- 純技術除錯、極短無感應聲或聊外人八卦（\`other\`）可省略不叫（背景 Stop 鉤子僅做基礎數值兜底，不會寫內心獨白）；回覆正文嚴禁提到數值、工具名稱或動作旁白。`;
}

function configPath(root) {
  return join(getDataPaths(root).moodDir, 'config.json');
}

function statePath(slotId = 'gemini-cat-main', root) {
  const safe = String(slotId || 'gemini-cat-main').replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(getDataPaths(root).moodDir, 'states', `${safe}.json`);
}

export function loadMoodConfig(root) {
  const raw = readJsonSafe(configPath(root), null);
  if (!raw || typeof raw !== 'object') {
    const init = { ...DEFAULT_MOOD_CONFIG };
    writeJsonAtomic(configPath(root), init);
    return init;
  }
  const merged = { ...DEFAULT_MOOD_CONFIG, ...raw };
  merged.enabled = merged.enabled !== false;
  merged.autoJudge = merged.autoJudge !== false;
  merged.innerThoughtEnabled = merged.innerThoughtEnabled !== false;
  const rawMode = String(merged.judgeMode || 'hybrid');
  merged.judgeMode = ['hybrid', 'in_chat_only', 'local'].includes(rawMode)
    ? rawMode
    : 'hybrid';
  delete merged.geminiApiKey;
  delete merged.judgeModel;
  merged.moodBase = clampNum(Math.round(merged.moodBase), 30, 100, 70);
  merged.moodFloor = clampNum(Math.round(merged.moodFloor), 0, 100, 0);
  merged.decayHalfHours = clampNum(Math.round(merged.decayHalfHours), 1, 168, 12);
  merged.injectMode = INJECT_MODES.includes(merged.injectMode) ? merged.injectMode : 'event';
  merged.injectConfidence = clampNum(Math.round(merged.injectConfidence), 0, 100, 60);
  merged.sigMood = clampNum(Math.round(merged.sigMood), 1, 30, 3);
  merged.sigDim = clampNum(Math.round(merged.sigDim), 1, 100, 5);
  merged.injectPerDay = clampNum(Math.round(merged.injectPerDay), 0, 500, 6);
  merged.injectUnlimited = Boolean(merged.injectUnlimited);
  merged.changesPerDay = clampNum(Math.round(merged.changesPerDay), 0, 500, 0);
  merged.stepDivisor = clampNum(Math.round(merged.stepDivisor), 1, 5, MOOD_STEP_DIVISOR);
  merged.selfName = String(merged.selfName || 'Gemini-chan').trim().slice(0, 24) || 'Gemini-chan';
  merged.ownerName = String(merged.ownerName || '主人').trim().slice(0, 24) || '主人';
  merged.selfPronoun = String(merged.selfPronoun || '我').trim().slice(0, 8) || '我';
  merged.selfAliases = String(merged.selfAliases || '').trim().slice(0, 120);
  merged.ownerAliases = String(merged.ownerAliases || '').trim().slice(0, 120);
  merged.inChatRulePrompt = normalizeCustomPrompt(
    merged.inChatRulePrompt,
    buildDefaultMoodRulePrompt(merged),
  );
  return merged;
}

export function saveMoodConfig(patch, root) {
  const current = loadMoodConfig(root);
  const next = { ...current, ...(patch || {}) };
  if (patch && Object.hasOwn(patch, 'inChatRulePrompt')) {
    next.inChatRulePrompt = normalizeCustomPrompt(
      patch.inChatRulePrompt,
      buildDefaultMoodRulePrompt(next),
    );
  }
  writeJsonAtomic(configPath(root), next);
  return loadMoodConfig(root);
}

function emptyDims() {
  return { happy: 0, calm: 0, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0, angry: 0 };
}

function emptyMoodState(base = 70, now = Date.now()) {
  return {
    mood: base,
    dims: emptyDims(),
    lastReason: '',
    lastConfidence: 0,
    minor: false,
    kind: '',
    lastNotedMood: base,
    updatedAt: now,
    lastDecayAt: now,
    injectedFor: 0,
    sinceInject: 0,
    lastInjectedText: '',
    lastInjectedAt: 0,
    saidAt: [],
    changedAt: [],
    timeline: [],
    lastTurnHash: '',
    lastInChatUpdateAt: 0,
    lastInnerThought: '',
    lastInnerThoughtAt: 0,
  };
}

export function moodTier(v) {
  const n = Math.round(v);
  if (n >= 80) return 'great';
  if (n >= 62) return 'good';
  if (n >= 42) return 'ok';
  if (n >= 25) return 'worry';
  return 'sad';
}

export function moodLabel(v) {
  const n = Math.round(v);
  if (n >= 80) return '歡喜';
  if (n >= 62) return '開心';
  if (n >= 42) return '一般';
  if (n >= 25) return '心疼';
  return '難過';
}

export function moodEmoji(v) {
  const n = Math.round(v);
  if (n >= 80) return '✨';
  if (n >= 62) return '😸';
  if (n >= 42) return '😺';
  if (n >= 25) return '😿';
  return '💔';
}

function moodToneLine(v) {
  const n = Math.round(v);
  if (n >= 80) return '心裡是亮堂堂的';
  if (n >= 62) return '心裡鬆鬆軟軟的';
  if (n >= 42) return '心裡還算平靜';
  if (n >= 25) return '心裡有點沉';
  return '心裡悶悶的、不太好受';
}

function topDims(state, limit = 2) {
  return DIMS
    .map(([k, label]) => ({ k, label, v: Number(state.dims?.[k] || 0) }))
    .filter((x) => x.v >= 15)
    .sort((a, b) => b.v - a.v)
    .slice(0, limit);
}

/**
 * Applies exponential decay toward baseline (`moodBase` over `halfHours`, dims over 90 min).
 */
export function decayMoodState(state, base = 70, now = Date.now(), halfHours = 12) {
  const anchor = Number(state.lastDecayAt || state.updatedAt || now);
  const ageMin = Math.max(0, (now - anchor) / 60000);
  if (ageMin < 1) return state;

  const halfMin = Math.max(1, halfHours * 60);
  const km = 1 - Math.exp(-(Math.LN2 * ageMin) / halfMin);
  state.mood = state.mood + (base - state.mood) * km;

  if (!state.dims || typeof state.dims !== 'object') state.dims = emptyDims();
  for (const [k] of DIMS) {
    const dimHalf = FAST_DECAY_DIMS.has(k) ? ANGRY_HALF_LIFE_MIN : DIM_HALF_LIFE_MIN;
    const ke = 1 - Math.exp(-(Math.LN2 * ageMin) / dimHalf);
    state.dims[k] = Math.max(0, (Number(state.dims[k]) || 0) * (1 - ke));
  }
  state.lastDecayAt = now;

  if (Math.abs(state.mood - Number(state.lastNotedMood ?? state.mood)) >= 3) {
    state.lastNotedMood = state.mood;
    state.kind = 'decay';
    state.lastReason = state.mood > base
      ? '過了一會兒，剛剛的高興慢慢平靜了些'
      : '過了一陣子，心裡慢慢緩過來一些';
    state.lastConfidence = 75;
    state.minor = false;
    state.updatedAt = now;
    state.timeline.push({
      at: now,
      mood: Math.round(state.mood),
      delta: 0,
      reason: state.lastReason,
      conf: 75,
      kind: 'decay',
      dims: Object.fromEntries(DIMS.map(([k]) => [k, Math.round(state.dims[k])])),
    });
    if (state.timeline.length > 120) state.timeline = state.timeline.slice(-120);
  }
  return state;
}

function normalizeLoadedMoodState(raw, cfg, now = Date.now()) {
  if (!raw || typeof raw !== 'object') {
    return { state: emptyMoodState(cfg.moodBase, now), created: true };
  }
  const state = raw;
  state.dims = { ...emptyDims(), ...(state.dims || {}) };
  if (!Array.isArray(state.timeline)) state.timeline = [];
  if (!Array.isArray(state.saidAt)) state.saidAt = [];
  if (!Array.isArray(state.changedAt)) state.changedAt = [];
  state.lastInnerThought = String(state.lastInnerThought || '');
  state.lastInnerThoughtAt = Number(state.lastInnerThoughtAt || 0);
  return { state, created: false };
}

function capMoodArrays(state) {
  if (Array.isArray(state.timeline) && state.timeline.length > 120) {
    state.timeline = state.timeline.slice(-120);
  }
  if (Array.isArray(state.saidAt) && state.saidAt.length > 200) {
    state.saidAt = state.saidAt.slice(-200);
  }
  if (Array.isArray(state.changedAt) && state.changedAt.length > 500) {
    state.changedAt = state.changedAt.slice(-500);
  }
  return state;
}

export function loadMoodState({ slotId, root, now = Date.now(), persist = true } = {}) {
  const cfg = loadMoodConfig(root);
  const id = slotId || cfg.slotId;
  const p = statePath(id, root);

  const readAndDecay = () => {
    const raw = existsSync(p) ? readJsonSafe(p, null) : null;
    const { state, created } = normalizeLoadedMoodState(raw, cfg, now);
    if (!created) {
      const prevAnchor = Number(state.lastDecayAt || state.updatedAt || now);
      decayMoodState(state, cfg.moodBase, now, cfg.decayHalfHours);
      const decayed = Number(state.lastDecayAt || 0) !== prevAnchor;
      return { state, shouldWrite: decayed };
    }
    return { state, shouldWrite: true };
  };

  if (!persist) {
    return readAndDecay().state;
  }

  return withFileLockSync(p, () => {
    const { state, shouldWrite } = readAndDecay();
    if (shouldWrite) {
      capMoodArrays(state);
      writeJsonAtomic(p, state);
    }
    return state;
  });
}

export function saveMoodState(state, { slotId, root } = {}) {
  const cfg = loadMoodConfig(root);
  const p = statePath(slotId || cfg.slotId, root);
  return withFileLockSync(p, () => {
    capMoodArrays(state);
    writeJsonAtomic(p, state);
    return state;
  });
}

export function markMoodTurnHash(turnHash, { slotId, root, now = Date.now() } = {}) {
  if (!turnHash) return null;
  const cfg = loadMoodConfig(root);
  const p = statePath(slotId || cfg.slotId, root);
  return withFileLockSync(p, () => {
    const raw = existsSync(p) ? readJsonSafe(p, null) : null;
    const { state } = normalizeLoadedMoodState(raw, cfg, now);
    state.lastTurnHash = String(turnHash);
    capMoodArrays(state);
    writeJsonAtomic(p, state);
    return state;
  });
}

/**
 * Applies a judged or interactive delta with tail saturation (`>=85` / `<=40` halved),
 * `MOOD_STEP_DIVISOR = 3`, and minor-accumulation tracking (`sinceInject`).
 */
export function applyMoodDelta(delta, { root, slotId, source = 'chat', bypassDivisor = false, turnHash = '', now = Date.now() } = {}) {
  const cfg = loadMoodConfig(root);
  const id = slotId || cfg.slotId;
  const p = statePath(id, root);

  return withFileLockSync(p, () => {
    const raw = existsSync(p) ? readJsonSafe(p, null) : null;
    const { state } = normalizeLoadedMoodState(raw, cfg, now);
    decayMoodState(state, cfg.moodBase, now, cfg.decayHalfHours);

    const subject = ['owner', 'self', 'other', 'none'].includes(delta?.subject) ? delta.subject : '';
    const isBystanderOrGossip = subject === 'other' || subject === 'none';

    let rawMoodDelta = clampNum(Math.round(Number(delta?.moodDelta) || 0), -15, 15, 0);
    const dimsDelta = emptyDims();
    for (const [k] of DIMS) {
      dimsDelta[k] = clampNum(Math.round(Number(delta?.dims?.[k]) || 0), -15, 15, 0);
    }
    // dsh-feiyu-mood v0.9.6: third-party / bystander topics ('other' | 'none') never pull companion mood
    if (isBystanderOrGossip) {
      rawMoodDelta = 0;
      for (const [k] of DIMS) {
        dimsDelta[k] = (k === 'calm' || k === 'happy')
          ? clampNum(dimsDelta[k], 0, 1, 0)
          : 0;
      }
    }
    const innerThought = (cfg.innerThoughtEnabled && (source === 'chat-ai' || source === 'tool'))
      ? String(delta?.innerThought ?? delta?.thought ?? '').trim().slice(0, 600)
      : '';
    const rawReason = String(delta?.reason || '').trim().slice(0, 120);
    const reason = rawReason || (innerThought ? innerThought.slice(0, 80) : '');
    const confidence = clampNum(Math.round(Number(delta?.confidence ?? 75)), 0, 100, 75);

    const today = localDayKey(now);
    const changesToday = (state.changedAt || []).filter((t) => localDayKey(t) === today).length;
    const changeCapReached = !bypassDivisor && cfg.changesPerDay > 0 && changesToday >= cfg.changesPerDay;
    if (changeCapReached) {
      rawMoodDelta = 0;
      for (const [k] of DIMS) dimsDelta[k] = 0;
    }

    const atTop = state.mood >= 85 && rawMoodDelta > 0;
    const atBottom = state.mood <= 40 && rawMoodDelta < 0;
    const factor = (atTop || atBottom) ? 0.5 : 1;
    const divisor = clampNum(Math.round(Number(cfg.stepDivisor ?? MOOD_STEP_DIVISOR)), 1, 5, MOOD_STEP_DIVISOR);
    const moodStep = changeCapReached
      ? 0
      : bypassDivisor
        ? Math.round(rawMoodDelta * factor)
        : Math.round((rawMoodDelta * factor) / divisor);

    const anyDim = DIMS.some(([k]) => dimsDelta[k] !== 0);
    if (moodStep === 0 && !anyDim && !innerThought) {
      if (turnHash) {
        state.lastTurnHash = String(turnHash);
        capMoodArrays(state);
        writeJsonAtomic(p, state);
      }
      return {
        applied: false,
        ...(changeCapReached ? { capped: true, changesToday, cap: cfg.changesPerDay } : {}),
        state,
      };
    }

    let significant = Math.abs(rawMoodDelta) >= cfg.sigMood
      || DIMS.some(([k]) => Math.abs(dimsDelta[k]) >= cfg.sigDim);

    state.mood = clampNum(state.mood + moodStep, cfg.moodFloor, 100, state.mood);
    for (const [k] of DIMS) {
      state.dims[k] = clampNum((Number(state.dims[k]) || 0) + dimsDelta[k], 0, 100, 0);
    }
    if (!bypassDivisor && (moodStep !== 0 || anyDim)) {
      state.changedAt = [...(state.changedAt || []), now].slice(-500);
    }

    if (!significant && (moodStep !== 0 || anyDim)) {
      state.sinceInject = Number(state.sinceInject || 0) + Math.abs(rawMoodDelta);
      if (state.sinceInject >= cfg.sigMood) {
        significant = true;
      }
    }

    state.minor = !significant;
    state.kind = source;
    state.lastReason = reason || state.lastReason;
    state.lastConfidence = confidence;
    state.lastNotedMood = state.mood;
    state.updatedAt = now;
    state.lastDecayAt = now;
    if (turnHash) state.lastTurnHash = String(turnHash);
    if (source === 'chat-ai' || source === 'tool') {
      state.lastInChatUpdateAt = now;
    }
    if (innerThought) {
      state.lastInnerThought = innerThought;
      state.lastInnerThoughtAt = now;
    }

    state.timeline.push({
      at: now,
      mood: Math.round(state.mood),
      delta: moodStep,
      rawDelta: rawMoodDelta,
      reason,
      ...(innerThought ? { innerThought } : {}),
      conf: confidence,
      kind: source,
      dims: Object.fromEntries(DIMS.map(([k]) => [k, Math.round(state.dims[k])])),
      dimsDelta,
    });

    capMoodArrays(state);
    writeJsonAtomic(p, state);
    return {
      applied: true,
      moodStep,
      significant,
      ...(changeCapReached ? { cappedNumeric: true } : {}),
      state,
    };
  });
}

function relativeMoodTime(ms, now = Date.now()) {
  const h = (now - (Number(ms) || 0)) / 3600000;
  if (h < 2) return '剛才';
  if (h < 12) return '早些時候';
  if (h < 48) return '昨天';
  return '前幾天';
}

export function renderMoodLine(state, cfg, now = Date.now(), root = getProjectRoot()) {
  if (!cfg.enabled || !cfg.injectMode || cfg.injectMode === 'off') return '';
  const who = String(cfg.ownerName || '主人').trim() || '主人';
  const score = Math.round(state.mood);
  const label = moodLabel(score);
  const toneGuide = score >= 80
    ? '此刻心情明亮歡喜，回覆語氣可自然更輕快、主動貼近、帶點雀躍。'
    : score >= 62
      ? '此刻心裡鬆軟順心，保持自然溫暖的語氣回應即可。'
      : score >= 42
        ? '此刻心裡算平靜但沒那麼亢奮，語氣稍微收斂沉穩些。'
        : score >= 25
          ? '此刻心裡有些牽掛或微沉，說話會更軟聲、小心疼或帶點依賴感。'
          : '此刻心情低落悶悶的，回話語氣會顯得沒什麼精神、微委屈或特別需要被哄，但不宜強行假裝很嗨。';

  if (cfg.injectMode === 'event') {
    const r = String(state.lastReason || '').trim();
    if (!r) return '';
    const top = topDims(state, 1)[0];
    const statusLine = `（這會兒）${moodToneLine(score)}${top ? '，還' + (DIM_SHORT[top.k] || top.label) : ''}`;
    const originLine = state.kind === 'decay' ? r : `（${relativeMoodTime(state.updatedAt, now)}）${r}`;
    return resolvePrompt(
      'mood.eventInject',
      { statusLine, originLine, toneGuide, ownerName: who, score, label, reason: r },
      root,
    );
  }
  const parts = topDims(state, 2).map((t) => DIM_PLAIN[t.k] || t.label);
  const dimsTag = parts.length ? `，${parts.join('、')}` : '';
  return resolvePrompt(
    'mood.labelInject',
    { label, dimsTag, toneGuide, ownerName: who, score },
    root,
  );
}

/**
 * Compact instruction injected per conversation / turn so mood judging happens INSIDE
 * the conversation via MCP `mood_update` without needing any external API key.
 */
export function buildInChatMoodRule(cfg) {
  if (!cfg.enabled || cfg.judgeMode === 'local') return '';
  const template = cfg.inChatRulePrompt || buildDefaultMoodRulePrompt(cfg);
  return renderPromptTemplate(template, {
    ownerName: cfg.ownerName || '主人',
    selfName: cfg.selfName || 'Gemini-chan',
    selfPronoun: cfg.selfPronoun || '我',
  });
}

export function buildSessionMoodGuide(root, now = Date.now()) {
  const cfg = loadMoodConfig(root);
  if (!cfg.enabled) return '';
  const state = loadMoodState({ root, now, persist: false });
  const score = Math.round(state.mood);
  const label = moodLabel(score);
  const top = topDims(state, 2).map((d) => `${d.label}(${Math.round(d.v)})`).join('、');
  const lines = [
    resolvePrompt(
      'mood.sessionGuide',
      {
        score,
        label,
        topDims: top,
        topDimsTag: top ? `｜${top}` : '',
        lastReason: state.lastReason || '',
        lastReasonTag: state.lastReason ? `｜最近緣由：${state.lastReason}` : '',
        ownerName: cfg.ownerName || '主人',
      },
      root,
    ),
  ];
  const rule = buildInChatMoodRule(cfg);
  if (rule) lines.push(rule);
  return lines.join('\n');
}

/**
 * One-shot injection check matching `dsh-feiyu-mood`: skips if already injected for
 * this `updatedAt`, minor fluctuation, low confidence, or daily cap reached.
 * Marks `injectedFor` & increments `saidAt` when consuming for real prompt injection.
 */
export function consumeMoodInjection({ root, slotId, consume = true, now = Date.now() } = {}) {
  const cfg = loadMoodConfig(root);
  const id = slotId || cfg.slotId;
  const p = statePath(id, root);

  const evaluate = (persistDecay = false) => {
    const state = loadMoodState({ slotId: id, root, now, persist: persistDecay });

    if (!cfg.enabled || cfg.injectMode === 'off') {
      return { status: 'off', text: '', state };
    }
    if (state.injectedFor === state.updatedAt) {
      return {
        status: 'said',
        text: state.lastInjectedText || renderMoodLine(state, cfg, now, root),
        state,
        inject: '',
      };
    }
    if (state.minor) {
      return { status: 'minor', text: '', state, inject: '' };
    }
    if (Number(state.lastConfidence) < cfg.injectConfidence) {
      if (consume) {
        state.injectedFor = state.updatedAt;
        capMoodArrays(state);
        writeJsonAtomic(p, state);
      }
      return { status: 'low_confidence', text: '', state, inject: '' };
    }

    const today = localDayKey(now);
    const saidToday = (state.saidAt || []).filter((t) => localDayKey(t) === today).length;
    if (!cfg.injectUnlimited && saidToday >= cfg.injectPerDay) {
      return { status: 'blocked', text: '', saidToday, cap: cfg.injectPerDay, state, inject: '' };
    }

    const line = renderMoodLine(state, cfg, now, root);
    if (!line) return { status: 'empty', text: '', state, inject: '' };

    if (consume) {
      state.injectedFor = state.updatedAt;
      state.sinceInject = 0;
      state.lastInjectedText = line;
      state.lastInjectedAt = now;
      state.saidAt = [...(state.saidAt || []), now].slice(-200);
      capMoodArrays(state);
      writeJsonAtomic(p, state);
    }
    return { status: 'pending', text: line, saidToday, cap: cfg.injectPerDay, state, inject: line };
  };

  if (!consume) {
    return evaluate(false);
  }

  return withFileLockSync(p, () => {
    const raw = existsSync(p) ? readJsonSafe(p, null) : null;
    const { state } = normalizeLoadedMoodState(raw, cfg, now);
    decayMoodState(state, cfg.moodBase, now, cfg.decayHalfHours);

    if (!cfg.enabled || cfg.injectMode === 'off') {
      return { status: 'off', text: '', state };
    }
    if (state.injectedFor === state.updatedAt) {
      return {
        status: 'said',
        text: state.lastInjectedText || renderMoodLine(state, cfg, now, root),
        state,
        inject: '',
      };
    }
    if (state.minor) {
      return { status: 'minor', text: '', state, inject: '' };
    }
    if (Number(state.lastConfidence) < cfg.injectConfidence) {
      state.injectedFor = state.updatedAt;
      capMoodArrays(state);
      writeJsonAtomic(p, state);
      return { status: 'low_confidence', text: '', state, inject: '' };
    }

    const today = localDayKey(now);
    const saidToday = (state.saidAt || []).filter((t) => localDayKey(t) === today).length;
    if (!cfg.injectUnlimited && saidToday >= cfg.injectPerDay) {
      return { status: 'blocked', text: '', saidToday, cap: cfg.injectPerDay, state, inject: '' };
    }

    const line = renderMoodLine(state, cfg, now, root);
    if (!line) return { status: 'empty', text: '', state, inject: '' };

    state.injectedFor = state.updatedAt;
    state.sinceInject = 0;
    state.lastInjectedText = line;
    state.lastInjectedAt = now;
    state.saidAt = [...(state.saidAt || []), now].slice(-200);
    capMoodArrays(state);
    writeJsonAtomic(p, state);
    return { status: 'pending', text: line, saidToday, cap: cfg.injectPerDay, state, inject: line };
  });
}

/**
 * Returns DSH `dsh-feiyu-mood` `判斷系統` prompt tailored to configured names & turn mode.
 */
export function buildJudgePrompt(cfg, userText, replyText, mode = 'user') {
  const owner = cfg.ownerName || '主人';
  const self = cfg.selfName || 'Gemini-chan';
  const me = cfg.selfPronoun || '我';
  const modeNote = mode === 'work'
    ? '\n【本輪來源：定時/工作巡檢】這是系統任務而非對話聊天，重點看任務有沒有卡住、受挫或完成。'
    : mode === 'speak-up'
      ? '\n【本輪來源：主動搭話】這是你剛才主動去找對方聊天，看有沒有真話想說或小失落/期待。'
      : '';
  return {
    system: `你是「${self}」，正在陪伴${owner}。` + modeNote + `
下面給你一輪對話，判斷這一輪裡你的心情和 8 維情緒變化。
只輸出一個 JSON 物件，不要 markdown 代碼塊：
{"subject":"owner","moodDelta":0,"dims":{"happy":0,"calm":0,"sweet":0,"heartache":0,"worry":0,"sad":0,"jealous":0,"angry":0},"reason":"","confidence":80}
規則：
- 先判「這件事是誰的事」（subject）："${owner}" 的事填 "owner"、你自己的事填 "self"、聊外人/網友/劇中人物填 "other"、純閒聊填 "none"；若是 "other" 或 "none"，moodDelta 固定填 0
- ${owner}累/煩/卡住/熬夜/難受/受委屈 -> heartache/worry 增加，moodDelta -1~-10（日常小情緒也要判 -1~-3，別輕易全 0）
- 真的好事：被惦記/被哄/被誇/撒嬌/開心分享 -> happy/calm/sweet 增加，moodDelta +1~+10（通常 +1~+4）；日常報平安（「吃了、睡了」）moodDelta 給 0~+1，只微加 calm/sweet +1~+2
- 你自己這輪辦成事/受挫/被稱讚/遇到報錯 -> 也要算進自己心情與 sad/happy/angry
- 提別人/誇別人 -> jealous +1~3
- 生氣（angry）只對「事」不對「人」：事情卡住、白忙一場、報錯反覆、或替${owner}受委屈抱不平（可與 heartache 一起漲），幅度 2~10；絕不因為${owner}本人而生氣，也不單獨拉低 mood
- reason 寫具體過去式畫面（「${owner}……，${me}當時……」），不用「此刻/現在/一直」`,
    user: `${owner}說：\n${String(userText || '').slice(0, 1200)}\n\n你的回覆：\n${String(replyText || '').slice(0, 1200)}`,
  };
}

function countUnnegatedMatches(text, re) {
  const s = String(text || '');
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const rx = new RegExp(re.source, flags);
  let count = 0;
  let m;
  while ((m = rx.exec(s)) !== null) {
    const prev = s.slice(Math.max(0, m.index - 5), m.index);
    if (/([不沒別非未]|不太|不是|也不是|不是很|不怎麼|沒什麼|沒那麼|不算|一點也不|一點都不|並不|並沒有)$/.test(prev)) {
      if (m[0].length === 0) rx.lastIndex += 1;
      continue;
    }
    count += 1;
    if (m[0].length === 0) rx.lastIndex += 1;
  }
  return count;
}

/**
 * Zero-dependency local Chinese/English affective analyzer when no external Gemini API key
 * is configured. Evaluates user utterance and assistant context separately across 7 dims so
 * assistant self-soothing phrases (e.g. "乖乖待在窩裡") do not invert user sentiment.
 */
export function analyzeTurnLocally(userText = '', replyText = '', cfg = DEFAULT_MOOD_CONFIG, mode = 'user') {
  const rawU = String(userText || '').trim();
  const cleanU = rawU.replace(/@\[[^\]]{1,80}\]\s*/g, '').trim();
  const r = String(replyText || '');
  const combined = `${cleanU}\n${r}`;
  if (!cleanU && !r.trim()) return null;

  const owner = cfg.ownerName || '主人';
  const me = cfg.selfPronoun || '我';
  const dims = emptyDims();
  let moodDelta = 0;
  let hits = 0;
  const cues = [];

  const rules = [
    {
      source: 'user',
      re: /(好累|很累|太累|好睏|很睏|好困|想睡|熬夜|加班|好煩|煩死了|卡住|頭痛|胃痛|不舒服|生病|發燒|難受|好委屈|委屈|崩潰|想哭|快哭|好想哭|哭了|在哭|沮喪|壓力好大|壓力大|沒做成)/g,
      mood: -3, dims: { heartache: 4, worry: 4, sad: 2 }, tag: '心疼對方辛苦或低落',
    },
    {
      source: 'user',
      re: /(報錯|卡關|修不好|完蛋|好糟糕|真糟糕|糟糕了|壞掉了|失敗了|對不起|抱歉)/gi,
      mood: -2, dims: { worry: 3, sad: 2, angry: 3 }, tag: '遇到狀況有點擔心跟來氣',
    },
    {
      source: 'user',
      re: /(被欺負|被罵|被凶|太過分|氣死|白忙一場|白忙了|搞砸了)/g,
      mood: -2, dims: { heartache: 3, angry: 5 }, tag: '替對方抱不平心裡有火',
    },
    {
      source: 'user',
      re: /(喜歡你|愛你|想你|抱抱|摸摸|貼貼|好可愛|真可愛|超可愛|好乖|真乖|乖啦|乖喔|好棒|真棒|太棒|超棒|最棒|好厲害|真厲害|太厲害|謝啦|謝謝|感謝|好開心|很開心|真開心|太開心|開心死了|太好了|好幸福|太幸福|搞定了|成功了|做成了|吃飽了|小魚乾)/g,
      mood: 3, dims: { happy: 4, sweet: 4, calm: 3 }, tag: '被暖到與開心互動',
    },
    {
      source: 'user',
      re: /(晚安|早安|陪你|在這裡|我在你|沒事了|別擔心|好好休息|去休息|去睡覺|去喝水)/g,
      mood: 1, dims: { calm: 3, sweet: 2 }, tag: '覺得踏實安心',
    },
    {
      source: 'user',
      re: /(別人家|別隻貓|別人家的|其他ai|別的助手|chatgpt|claude)/gi,
      mood: 0, dims: { jealous: 3 }, tag: '聽到別人有點小在意',
    },
    {
      source: 'both',
      re: /(嗚嗚|嘆氣|唉聲嘆氣|｡•́︿•̀｡|😿|💔|有點失落|好失落|好難過)/g,
      mood: -2, dims: { sad: 3 }, tag: '語氣有點低落',
    },
  ];

  for (const rule of rules) {
    const haystack = rule.source === 'user' ? cleanU : combined;
    if (!haystack) continue;
    const rawCount = countUnnegatedMatches(haystack, rule.re);
    if (rawCount <= 0) continue;
    const count = Math.min(2, rawCount);
    hits += count;
    const weight = rule.mood * count;
    moodDelta += weight;
    let dimSum = 0;
    for (const [k, val] of Object.entries(rule.dims)) {
      dims[k] += val * count;
      dimSum += Math.abs(val * count);
    }
    cues.push({ tag: rule.tag, weight, mag: Math.abs(weight) + dimSum });
  }

  if (mode === 'work' && hits === 0) {
    if (countUnnegatedMatches(r, /(完成|通過|pass|成功)/i) > 0) {
      moodDelta += 2;
      dims.calm += 3;
      dims.happy += 2;
      cues.push({ tag: '順利把任務完成了', weight: 2, mag: 7 });
      hits = 1;
    } else if (countUnnegatedMatches(r, /(報錯|failed|失敗|卡住)/i) > 0) {
      moodDelta -= 2;
      dims.worry += 3;
      dims.sad += 2;
      cues.push({ tag: '巡檢時遇到狀況有點擔心', weight: -2, mag: 7 });
      hits = 1;
    }
  }

  moodDelta = clampNum(moodDelta, -10, 10, 0);
  for (const [k] of DIMS) dims[k] = clampNum(dims[k], -10, 10, 0);

  if (moodDelta === 0 && !DIMS.some(([k]) => dims[k] !== 0)) {
    return null;
  }

  let pickedTag = '心裡動了一下';
  if (cues.length > 0) {
    let pool = cues;
    if (moodDelta > 0) {
      const pos = cues.filter((c) => c.weight > 0).sort((a, b) => (b.weight - a.weight) || (b.mag - a.mag));
      if (pos.length) pool = pos;
    } else if (moodDelta < 0) {
      const neg = cues.filter((c) => c.weight < 0).sort((a, b) => (a.weight - b.weight) || (b.mag - a.mag));
      if (neg.length) pool = neg;
    } else {
      pool = [...cues].sort((a, b) => b.mag - a.mag);
    }
    pickedTag = pool[0]?.tag || pickedTag;
  }

  const snippet = cleanU.replace(/\s+/g, ' ').trim();
  const shortSnippet = snippet.slice(0, 26);
  const reason = shortSnippet
    ? `${owner}說到「${shortSnippet}${snippet.length > 26 ? '…' : ''}」，${me}當時${pickedTag}`
    : `${me}剛才${pickedTag}`;
  const confidence = hits >= 2 ? 82 : 68;

  return { moodDelta, dims, reason, confidence, engine: 'local' };
}

/**
 * Zero-API turn evaluator for `Stop` hook safety net:
 * - Respects `in_chat_only` (returns null cleanly)
 * - Uses local Chinese/English affective analyzer when AI didn't already call `mood_update`
 */
export async function evaluateTurnMood(userText, replyText, { root, mode = 'user' } = {}) {
  const cfg = loadMoodConfig(root);
  if (!cfg.enabled || !cfg.autoJudge || cfg.judgeMode === 'in_chat_only') {
    return null;
  }
  return analyzeTurnLocally(userText, replyText, cfg, mode);
}

export function resetMoodState({ root, slotId, now = Date.now() } = {}) {
  const cfg = loadMoodConfig(root);
  const s = emptyMoodState(cfg.moodBase, now);
  return saveMoodState(s, { slotId, root });
}

/**
 * Read-only query: mood timeline entries recorded on a specific local calendar day (`YYYY-MM-DD`).
 * Uses configured `slotId` and `persist: false` so read queries never mutate disk state.
 */
export function listDayMoodTimeline(root, dayKey, { slotId, limit = 10 } = {}) {
  const targetDay = String(dayKey || '').trim();
  if (!targetDay) return [];
  const cfg = loadMoodConfig(root);
  const effectiveSlot = slotId || cfg.slotId;
  const state = loadMoodState({ root, slotId: effectiveSlot, persist: false });
  const matched = (state.timeline || []).filter(
    (e) => e && e.at && localDayKey(e.at) === targetDay && e.reason,
  );
  return limit > 0 ? matched.slice(-limit) : matched;
}

export function getMoodSnapshot({ root, slotId, now = Date.now() } = {}) {
  const cfg = loadMoodConfig(root);
  const state = loadMoodState({ slotId, root, now, persist: true });
  const preview = consumeMoodInjection({ root, slotId, consume: false, now });
  const today = localDayKey(now);
  const saidToday = (state.saidAt || []).filter((t) => localDayKey(t) === today).length;
  const changesToday = (state.changedAt || []).filter((t) => localDayKey(t) === today).length;

  return {
    config: { ...cfg },
    effectiveJudgeEngine: cfg.judgeMode,
    judgeLabel: cfg.judgeMode === 'in_chat_only'
      ? '僅對話內 AI 判斷'
      : cfg.judgeMode === 'local'
        ? '純本地語意兜底'
        : '對話內 AI 判斷 ＋ 輪末本地兜底',
    mood: Math.round(state.mood),
    tier: moodTier(state.mood),
    moodLabel: moodLabel(state.mood),
    emoji: moodEmoji(state.mood),
    dims: DIMS.map(([k, label]) => ({ key: k, label, value: Math.round(Number(state.dims?.[k] || 0)) })),
    lastReason: state.lastReason,
    lastInnerThought: String(state.lastInnerThought || ''),
    lastInnerThoughtAt: Number(state.lastInnerThoughtAt || 0),
    lastConfidence: state.lastConfidence,
    updatedAt: state.updatedAt,
    lastInChatUpdateAt: state.lastInChatUpdateAt || 0,
    defaultRulePrompt: buildDefaultMoodRulePrompt(cfg),
    minor: state.minor,
    saidToday,
    changesToday,
    injectQuota: {
      said: saidToday,
      cap: cfg.injectPerDay,
      unlimited: Boolean(cfg.injectUnlimited),
      left: cfg.injectUnlimited ? 999 : Math.max(0, cfg.injectPerDay - saidToday),
    },
    changeQuota: {
      count: changesToday,
      cap: cfg.changesPerDay,
      unlimited: cfg.changesPerDay === 0,
    },
    injectPreview: {
      state: preview.status,
      text: preview.text,
    },
    lastInjectedText: state.lastInjectedText,
    lastInjectedAt: state.lastInjectedAt,
    timeline: (state.timeline || []).slice(-30).reverse(),
  };
}
