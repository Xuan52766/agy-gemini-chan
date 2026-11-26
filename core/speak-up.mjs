/**
 * @fileoverview Proactive initiation scheduler ported from `dsh-speak-up`.
 *
 * Configurable peak/valley schedule (customizable from Sidecar UI):
 * - Defaults: Mon-Fri 09:00-12:00 & 14:00-18:00 (user can edit days, HH:MM-HH:MM windows, or turn off peak/valley split)
 * - Formula: `hitLine = clamp(baseLine * timingFactor + min(bonusCap, missStreak * missBonus), 0, 100)`
 *   (multiply timing factor FIRST, then add accumulated miss-streak bonus)
 * - Timing factor: `< nearMin` -> `nearFactor` (0.15); `> farMin` -> `farFactor` (1.5); else `1`
 * - Cooldown after self-initiated message + cross-midnight quiet hours (`start === end` disables)
 * - Dry-run (`試運行`) defaults to `true` for safety; auto rolls update `missStreak` (manual buttons do not)
 * - Antigravity dispatch is STRICTLY locked to verified `gemini_cat` conversations.
 */

import { join } from 'node:path';
import {
  loadNestState,
  MIN_SLEEP_FOR_SPEAKUP_WAKE_MS,
  restoreSleepState,
  wakeFromSleep,
} from './nest.mjs';
import {
  commitFreshBrowsePicks,
  DEFAULT_FRESH_BROWSE_CONFIG,
  formatFreshBrowsePromptBlock,
  getFreshBrowseSnapshot,
  mergeFreshBrowseConfig,
  normalizeFreshBrowseConfig,
  peekFreshBrowsePicks,
} from './fresh-browse.mjs';
import { SPEAK_UP_MARKER } from './markers.mjs';
import { resolvePrompt } from './prompts.mjs';
import {
  clampNum,
  getDataPaths,
  localClockDisplay,
  normalizeCustomPrompt,
  readJsonSafe,
  renderPromptTemplate,
  writeJsonAtomic,
} from './storage.mjs';

export { SPEAK_UP_MARKER };

const DEFAULT_PEAK_WINDOWS_TEXT = '09:00-12:00, 14:00-18:00';
const DEFAULT_PEAK_DAYS = [1, 2, 3, 4, 5];

function parseClockMinutes(token) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(token || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  if (h === 24 && min === 0) return 24 * 60;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

function fmtMinutes(m) {
  if (m === 24 * 60) return '24:00';
  const hh = String(Math.floor(m / 60) % 24).padStart(2, '0');
  const mm = String(m % 60).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function parsePeakWindows(input) {
  if (Array.isArray(input)) {
    const out = [];
    for (const pair of input) {
      if (Array.isArray(pair) && pair.length >= 2) {
        const a = Math.round(Number(pair[0]));
        const b = Math.round(Number(pair[1]));
        if (Number.isFinite(a) && Number.isFinite(b) && a !== b && a >= 0 && a <= 1440 && b >= 0 && b <= 1440) {
          out.push([a, b]);
        }
      }
    }
    return out;
  }
  const str = String(input || '').trim();
  if (!str) return [];
  const parts = str.split(/[,，;；\n]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const seg = part.split(/[-–—~～]+/).map((s) => s.trim());
    if (seg.length !== 2) continue;
    const start = parseClockMinutes(seg[0]);
    const end = parseClockMinutes(seg[1]);
    if (start === null || end === null || start === end) continue;
    out.push([start, end]);
  }
  return out;
}

export function formatPeakWindows(windows) {
  return (windows || []).map(([a, b]) => `${fmtMinutes(a)}-${fmtMinutes(b)}`).join(', ');
}

export function normalizePeakDays(days) {
  if (!Array.isArray(days)) return [...DEFAULT_PEAK_DAYS];
  const set = new Set();
  for (const d of days) {
    const n = Number(d);
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

export const DEFAULT_SPEAK_UP_CONFIG = {
  enabled: true,
  aiPlanEnabled: true,
  diceEnabled: true,
  dryRun: true,
  followActive: true,
  targetConversations: [],
  intervalMinutes: 30,
  respectActiveChatGapMin: 8,
  diceBlockActiveChat: true,
  suppressDiceBeforeReminder: true,
  suppressBeforeReminderMin: 120,
  maxUnansweredSpontaneous: 2,
  scheduleTendency: 'high',
  proactiveCueEnabled: true,
  usePeakValley: true,
  peakDays: DEFAULT_PEAK_DAYS,
  peakWindowsText: DEFAULT_PEAK_WINDOWS_TEXT,
  peakHitLine: 20,
  valleyHitLine: 60,
  timezone: '',
  missBonus: 10,
  bonusCap: 40,
  quietStartHour: 1,
  quietEndHour: 8,
  nearThresholdMin: 20,
  nearFactor: 0.15,
  farThresholdMin: 360,
  farFactor: 1.5,
  cooldownMin: 20,
  triggerPrompt:
    '晃過來瞄一眼。想到什麼好玩的、想吐槽的事，或單純冒個泡就隨手丟一兩句。',
  inChatRulePrompt: '',
  followUpHintPrompt: '',
  freshBrowse: { ...DEFAULT_FRESH_BROWSE_CONFIG },
};

export function buildDefaultSpeakUpRulePrompt(cfg = DEFAULT_SPEAK_UP_CONFIG) {
  const tendency = ['high', 'normal', 'low'].includes(cfg?.scheduleTendency) ? cfg.scheduleTendency : 'high';
  const tendencyBlock = tendency === 'high'
    ? [
        '- **積極使用時刻表**：對方準備去吃飯、洗澡、出門、忙別的事或聊到稍後有後續時，順手呼叫 `speak_up_plan` 排一筆 `kind:"autonomous"`（可附 `jitterMin:10~20` 波動）。睡前約叫醒可順帶 `"silenceUntilTrigger":true`；覺得他在忙或沒空回時直接呼叫 `silence`，把安靜空間留給他。',
      ]
    : tendency === 'normal'
      ? [
          '- 對方約定提醒或你有明確想之後再聊的事時用 `speak_up_plan` 排入（`autonomous` 若在活躍對話 {{activeGapMin}} 分鐘內會自動順延）；想先安靜留白時用 `silence`／`"silenceUntilTrigger":true`。',
        ]
      : [
          '- 在對方明確開口約提醒或請你暫停打擾時呼叫 `speak_up_plan`（`schedule` / `silence`）。',
        ];

  return [
    '【貓窩主動搭話與排程（使用 `speak_up_plan`，勿用系統內建 `schedule`）】',
    '在 `gemini_cat` 裡約時間、定節律或設定勿擾，請透過 MCP `call_mcp_tool`（Server: `"gemini-cat_companion"`, Tool: `"speak_up_plan"`）：',
    '- 單次預約：`{"action":"schedule","kind":"reminder"|"autonomous","delayMinutes":45,"jitterMin":10,"label":"短標題","thought":"想說的事"}`（可用 `"at":"14:30"`；睡醒提醒可加 `"silenceUntilTrigger":true`）。',
    '- 一串時刻：`{"action":"schedule_batch","plans":[{"at":"15:00","kind":"reminder","label":"提醒","thought":"..."},{"at":"22:30","kind":"autonomous","jitterMin":15,"thought":"..."}]}`。',
    '- 固定波動節律：`{"action":"add_routine","timeHHMM":"12:30","jitterMin":20,"days":[1,2,3,4,5],"label":"午間問候","thought":"順口聊聊"}`。',
    '- 自主勿擾：`{"action":"silence","until":"09:30","reason":"先去休息一下"}`（或 `"delayMinutes":120`）；解除 `"clear_silence"`；查刪設 `"list"` / `"remove"` / `"set_config"`。',
    ...tendencyBlock,
    '- `autonomous` 會自動避開活躍聊天（{{activeGapMin}} 分鐘內）；正文保持自然對話，別提工具名稱。',
  ].join('\n');
}

export function buildDefaultFollowUpHintPrompt(cfg = DEFAULT_SPEAK_UP_CONFIG) {
  const tendency = ['high', 'normal', 'low'].includes(cfg?.scheduleTendency) ? cfg.scheduleTendency : 'high';
  if (tendency === 'high') {
    return '（有想到之後想再來找他或關心的時機，可直接呼叫 `speak_up_plan` 排好時間或設波動節律；覺得對方正忙或還沒醒時，用 `silence` 先保持安靜就好。）';
  }
  return '（若有預留的下次關心或勿擾時段，可順手透過 `speak_up_plan` 設定。）';
}

function configPath(root) {
  return join(getDataPaths(root).speakUpDir, 'config.json');
}

function runtimePath(root) {
  return join(getDataPaths(root).speakUpDir, 'state.json');
}

export function normalizeTimezone(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 64);
  if (!s) return '';
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(s)) return '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
    return s;
  } catch {
    return '';
  }
}

export function loadSpeakUpConfig(root) {
  const raw = readJsonSafe(configPath(root), null);
  if (!raw || typeof raw !== 'object') {
    const init = {
      ...DEFAULT_SPEAK_UP_CONFIG,
      peakWindows: parsePeakWindows(DEFAULT_PEAK_WINDOWS_TEXT),
      freshBrowse: normalizeFreshBrowseConfig(DEFAULT_FRESH_BROWSE_CONFIG),
    };
    writeJsonAtomic(configPath(root), init);
    return init;
  }
  const m = { ...DEFAULT_SPEAK_UP_CONFIG, ...raw };
  const parsedWindows = m.peakWindowsText !== undefined
    ? parsePeakWindows(m.peakWindowsText)
    : parsePeakWindows(m.peakWindows || DEFAULT_PEAK_WINDOWS_TEXT);
  const peakWindowsText = m.peakWindowsText !== undefined
    ? (parsedWindows.length ? formatPeakWindows(parsedWindows) : '')
    : (parsedWindows.length ? formatPeakWindows(parsedWindows) : DEFAULT_PEAK_WINDOWS_TEXT);

  const normalized = {
    enabled: m.enabled !== false,
    aiPlanEnabled: m.aiPlanEnabled !== false,
    diceEnabled: m.diceEnabled !== false,
    dryRun: m.dryRun !== false,
    followActive: m.followActive !== false,
    targetConversations: Array.isArray(m.targetConversations)
      ? [...new Set(m.targetConversations.map((x) => String(x || '').trim()).filter(Boolean))]
      : [],
    intervalMinutes: Math.round(clampNum(m.intervalMinutes, 1, 1440, 30)),
    respectActiveChatGapMin: Math.round(clampNum(m.respectActiveChatGapMin, 0, 180, 8)),
    diceBlockActiveChat: m.diceBlockActiveChat !== false,
    suppressDiceBeforeReminder: m.suppressDiceBeforeReminder !== false,
    suppressBeforeReminderMin: Math.round(clampNum(m.suppressBeforeReminderMin, 0, 720, 120)),
    maxUnansweredSpontaneous: Math.round(clampNum(m.maxUnansweredSpontaneous, 0, 20, 2)),
    scheduleTendency: ['high', 'normal', 'low'].includes(m.scheduleTendency) ? m.scheduleTendency : 'high',
    proactiveCueEnabled: m.proactiveCueEnabled !== false,
    usePeakValley: m.usePeakValley !== false,
    peakDays: normalizePeakDays(m.peakDays),
    peakWindows: parsedWindows,
    peakWindowsText,
    peakHitLine: clampNum(m.peakHitLine, 0, 100, 20),
    valleyHitLine: clampNum(m.valleyHitLine, 0, 100, 60),
    timezone: normalizeTimezone(m.timezone),
    missBonus: clampNum(m.missBonus, 0, 100, 10),
    bonusCap: clampNum(m.bonusCap, 0, 100, 40),
    quietStartHour: Math.round(clampNum(m.quietStartHour, 0, 23, 1)),
    quietEndHour: Math.round(clampNum(m.quietEndHour, 0, 23, 8)),
    nearThresholdMin: clampNum(m.nearThresholdMin, 0, 100000, 20),
    nearFactor: clampNum(m.nearFactor, 0, 100, 0.15),
    farThresholdMin: clampNum(m.farThresholdMin, 0, 100000, 360),
    farFactor: clampNum(m.farFactor, 0, 100, 1.5),
    cooldownMin: Math.round(clampNum(m.cooldownMin, 0, 1440, 20)),
    triggerPrompt: typeof m.triggerPrompt === 'string' && m.triggerPrompt.trim()
      ? m.triggerPrompt
      : DEFAULT_SPEAK_UP_CONFIG.triggerPrompt,
    inChatRulePrompt: '',
    followUpHintPrompt: '',
    freshBrowse: normalizeFreshBrowseConfig(m.freshBrowse),
  };
  normalized.followUpHintPrompt = normalizeCustomPrompt(
    m.followUpHintPrompt,
    buildDefaultFollowUpHintPrompt(normalized),
  );
  normalized.inChatRulePrompt = normalizeCustomPrompt(
    m.inChatRulePrompt,
    buildDefaultSpeakUpRulePrompt(normalized),
  );
  return normalized;
}

function collapseDefaultPrompt(val, defaultsList) {
  const s = typeof val === 'string' ? val.trim() : '';
  if (!s) return '';
  for (const d of defaultsList) {
    if (s === String(d || '').trim()) return '';
  }
  return s.slice(0, 6000);
}

export function saveSpeakUpConfig(patch, root) {
  const curResolved = loadSpeakUpConfig(root);
  const rawStored = readJsonSafe(configPath(root), {}) || {};
  const next = {
    ...curResolved,
    inChatRulePrompt: typeof rawStored.inChatRulePrompt === 'string' ? rawStored.inChatRulePrompt : '',
    followUpHintPrompt: typeof rawStored.followUpHintPrompt === 'string' ? rawStored.followUpHintPrompt : '',
    ...(patch || {}),
    freshBrowse: patch && patch.freshBrowse !== undefined
      ? mergeFreshBrowseConfig(curResolved.freshBrowse, patch.freshBrowse)
      : curResolved.freshBrowse,
  };
  const ruleDefaults = ['high', 'normal', 'low'].map((t) => buildDefaultSpeakUpRulePrompt({ ...next, scheduleTendency: t }));
  const followDefaults = ['high', 'normal', 'low'].map((t) => buildDefaultFollowUpHintPrompt({ ...next, scheduleTendency: t }));
  if (patch && Object.hasOwn(patch, 'inChatRulePrompt')) {
    next.inChatRulePrompt = collapseDefaultPrompt(patch.inChatRulePrompt, ruleDefaults);
  } else {
    next.inChatRulePrompt = collapseDefaultPrompt(next.inChatRulePrompt, ruleDefaults);
  }
  if (patch && Object.hasOwn(patch, 'followUpHintPrompt')) {
    next.followUpHintPrompt = collapseDefaultPrompt(patch.followUpHintPrompt, followDefaults);
  } else {
    next.followUpHintPrompt = collapseDefaultPrompt(next.followUpHintPrompt, followDefaults);
  }
  writeJsonAtomic(configPath(root), next);
  return loadSpeakUpConfig(root);
}

function normalizePlanItem(p) {
  if (!p || typeof p !== 'object') return null;
  const triggerAt = Number(p.triggerAt);
  if (!Number.isFinite(triggerAt) || triggerAt <= 0) return null;
  return {
    id: String(p.id || `sp-${Math.random().toString(36).slice(2, 8)}`).slice(0, 48),
    kind: p.kind === 'reminder' ? 'reminder' : 'autonomous',
    label: String(p.label || '').trim().slice(0, 80),
    thought: String(p.thought || '').trim().slice(0, 400),
    requestedAt: Number(p.requestedAt || triggerAt),
    baseAt: Number(p.baseAt || triggerAt),
    jitterMin: Math.round(clampNum(p.jitterMin, 0, 240, 0)),
    triggerAt,
    allowDuringQuiet: Boolean(p.allowDuringQuiet),
    allowWakeFromSleep: p.allowWakeFromSleep !== undefined
      ? Boolean(p.allowWakeFromSleep)
      : p.kind === 'reminder',
    deferredCount: Math.max(0, Math.round(Number(p.deferredCount || 0))),
  };
}

function normalizeRoutineItem(r) {
  if (!r || typeof r !== 'object') return null;
  const parsedMin = parseClockMinutes(r.timeHHMM);
  const timeHHMM = parsedMin === null ? '12:00' : fmtMinutes(parsedMin === 1440 ? 0 : parsedMin);
  const days = Array.isArray(r.days) && r.days.length
    ? normalizePeakDays(r.days)
    : [0, 1, 2, 3, 4, 5, 6];
  return {
    id: String(r.id || `rt-${Math.random().toString(36).slice(2, 8)}`).slice(0, 48),
    enabled: r.enabled !== false,
    label: String(r.label || `每日 ${timeHHMM}`).trim().slice(0, 80),
    days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
    timeHHMM,
    jitterMin: Math.round(clampNum(r.jitterMin, 0, 240, 15)),
    thought: String(r.thought || '').trim().slice(0, 400),
    allowDuringQuiet: Boolean(r.allowDuringQuiet),
    lastFiredAt: Number(r.lastFiredAt || 0),
    nextTriggerAt: Number(r.nextTriggerAt || 0),
    deferredCount: Math.max(0, Math.round(Number(r.deferredCount || 0))),
    createdAt: Number(r.createdAt || Date.now()),
  };
}

export function loadSpeakUpState(root) {
  const raw = readJsonSafe(runtimePath(root), null);
  if (!raw || typeof raw !== 'object') {
    return {
      missStreak: 0,
      unansweredCount: 0,
      silentUntil: 0,
      silentReason: '',
      lastTickAt: 0,
      lastSpeakAt: 0,
      plans: [],
      routines: [],
      logs: [],
    };
  }
  const plans = Array.isArray(raw.plans)
    ? raw.plans.map(normalizePlanItem).filter(Boolean).sort((a, b) => a.triggerAt - b.triggerAt).slice(0, 40)
    : [];
  const routines = Array.isArray(raw.routines)
    ? raw.routines.map(normalizeRoutineItem).filter(Boolean).slice(0, 20)
    : [];
  return {
    missStreak: Math.max(0, Math.round(Number(raw.missStreak) || 0)),
    unansweredCount: Math.max(0, Math.round(Number(raw.unansweredCount) || 0)),
    silentUntil: Math.max(0, Number(raw.silentUntil) || 0),
    silentReason: String(raw.silentReason || '').trim().slice(0, 160),
    lastTickAt: Number(raw.lastTickAt || 0),
    lastSpeakAt: Number(raw.lastSpeakAt || 0),
    plans,
    routines,
    logs: Array.isArray(raw.logs) ? raw.logs.slice(-60) : [],
  };
}

export function saveSpeakUpState(state, root) {
  const plans = Array.isArray(state.plans)
    ? state.plans.map(normalizePlanItem).filter(Boolean).sort((a, b) => a.triggerAt - b.triggerAt).slice(0, 40)
    : [];
  const routines = Array.isArray(state.routines)
    ? state.routines.map(normalizeRoutineItem).filter(Boolean).slice(0, 20)
    : [];
  const clean = {
    missStreak: Math.max(0, Math.round(Number(state.missStreak) || 0)),
    unansweredCount: Math.max(0, Math.round(Number(state.unansweredCount) || 0)),
    silentUntil: Math.max(0, Number(state.silentUntil) || 0),
    silentReason: String(state.silentReason || '').trim().slice(0, 160),
    lastTickAt: Number(state.lastTickAt || 0),
    lastSpeakAt: Number(state.lastSpeakAt || 0),
    plans,
    routines,
    logs: Array.isArray(state.logs) ? state.logs.slice(-60) : [],
  };
  writeJsonAtomic(runtimePath(root), clean);
  return clean;
}

export function resetSpeakUpStreak(root, now = Date.now()) {
  const state = loadSpeakUpState(root);
  state.missStreak = 0;
  appendSpeakLog(state, '已手動歸零連沒中計數（missStreak -> 0）', now);
  return saveSpeakUpState(state, root);
}

export function resetSpeakUpUnanswered(root, now = Date.now()) {
  const state = loadSpeakUpState(root);
  state.unansweredCount = 0;
  appendSpeakLog(state, '已重設已讀未回計數（unansweredCount -> 0）', now);
  return saveSpeakUpState(state, root);
}

export function noteUserSpokeForSpeakUp(root, now = Date.now()) {
  const raw = readJsonSafe(runtimePath(root), null);
  if (!raw || typeof raw !== 'object') return null;
  const curUnanswered = Math.max(0, Math.round(Number(raw.unansweredCount) || 0));
  if (curUnanswered <= 0) return null;
  const state = loadSpeakUpState(root);
  state.unansweredCount = 0;
  appendSpeakLog(state, '使用者已開口回覆，已自動重設未回連發計數', now);
  return saveSpeakUpState(state, root);
}

export function getZonedParts(date = new Date(), timezone = '') {
  const d = date instanceof Date ? date : new Date(date);
  const local = () => ({
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    dayOfMonth: d.getDate(),
    weekday: d.getDay(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    minuteOfDay: d.getHours() * 60 + d.getMinutes(),
  });
  const tz = normalizeTimezone(timezone);
  if (!tz) return local();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const pick = (t) => parts.find((x) => x.type === t)?.value || '';
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = dayMap[pick('weekday')];
    const year = Number(pick('year'));
    const month = Number(pick('month'));
    const dayOfMonth = Number(pick('day'));
    const hour = Number(pick('hour')) % 24;
    const minute = Number(pick('minute'));
    if (
      weekday === undefined ||
      !Number.isFinite(year) ||
      !Number.isFinite(month) ||
      !Number.isFinite(dayOfMonth) ||
      !Number.isFinite(hour) ||
      !Number.isFinite(minute)
    ) {
      return local();
    }
    return { year, month, dayOfMonth, weekday, hour, minute, minuteOfDay: hour * 60 + minute };
  } catch {
    return local();
  }
}

export function getDayAndMinutes(date = new Date(), timezone = '') {
  const p = getZonedParts(date, timezone);
  return { day: p.weekday, hour: p.hour, minuteOfDay: p.minuteOfDay };
}

export function zonedClockToEpoch(baseMs, dayOffset, hh, mm, timezone = '') {
  const tz = normalizeTimezone(timezone);
  if (!tz) {
    const d = new Date(baseMs);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hh, mm, 0, 0);
    return d.getTime();
  }
  const baseParts = getZonedParts(new Date(baseMs), tz);
  const targetWallUtc = Date.UTC(baseParts.year, baseParts.month - 1, baseParts.dayOfMonth + dayOffset, hh, mm, 0, 0);
  let guess = targetWallUtc;
  for (let i = 0; i < 2; i++) {
    const zp = getZonedParts(new Date(guess), tz);
    const guessWallUtc = Date.UTC(zp.year, zp.month - 1, zp.dayOfMonth, zp.hour, zp.minute, 0, 0);
    guess += targetWallUtc - guessWallUtc;
  }
  return guess;
}

export function resolveTargetTimestamp({ at, delayMinutes, nowMs = Date.now(), timezone = '' } = {}) {
  if (delayMinutes !== undefined && delayMinutes !== null && String(delayMinutes).trim() !== '') {
    const mins = Number(delayMinutes);
    if (Number.isFinite(mins) && mins > 0 && mins <= 43200) {
      return { ok: true, baseAt: Math.round(nowMs + mins * 60000) };
    }
  }
  const raw = String(at || '').trim();
  if (!raw) {
    return { ok: false, error: '請提供 delayMinutes（幾分鐘後）或 at（HH:MM / ISO 時間）' };
  }
  const clockMin = parseClockMinutes(raw);
  if (clockMin !== null) {
    const hh = Math.floor((clockMin === 1440 ? 0 : clockMin) / 60);
    const mm = (clockMin === 1440 ? 0 : clockMin) % 60;
    let baseAt = zonedClockToEpoch(nowMs, 0, hh, mm, timezone);
    if (baseAt <= nowMs + 15000) {
      baseAt = zonedClockToEpoch(nowMs, 1, hh, mm, timezone);
    }
    return { ok: true, baseAt };
  }
  if (/^\d{12,15}$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return { ok: true, baseAt: n };
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return { ok: true, baseAt: parsed };
  }
  return { ok: false, error: `無法解析時間格式：${raw}` };
}

export function rollJitteredTimestamp(baseAt, jitterMin = 0, minFloorMs = 0, randomUnitFn = Math.random) {
  const j = Math.round(clampNum(jitterMin, 0, 240, 0));
  if (j <= 0) return Math.max(minFloorMs, baseAt);
  const u = clampNum(Number(randomUnitFn()), 0, 0.999999, 0.5);
  const rolled = Math.round(baseAt + (u * 2 - 1) * j * 60000);
  if (rolled >= minFloorMs) return rolled;
  const maxWin = baseAt + j * 60000;
  if (maxWin <= minFloorMs) return Math.max(minFloorMs, baseAt);
  const u2 = clampNum(Number(randomUnitFn()), 0, 0.999999, 0.5);
  return Math.round(minFloorMs + u2 * Math.max(0, maxWin - minFloorMs));
}

export function computeNextRoutineTrigger(routine, cfg, afterMs = Date.now(), randomUnitFn = Math.random) {
  const clockMin = parseClockMinutes(routine?.timeHHMM);
  const safeMin = clockMin === null ? 12 * 60 : (clockMin === 1440 ? 0 : clockMin);
  const hh = Math.floor(safeMin / 60);
  const mm = safeMin % 60;
  const days = Array.isArray(routine?.days) && routine.days.length
    ? normalizePeakDays(routine.days)
    : [0, 1, 2, 3, 4, 5, 6];
  const daySet = new Set(days.length ? days : [0, 1, 2, 3, 4, 5, 6]);
  const j = Math.round(clampNum(routine?.jitterMin, 0, 240, 15));

  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    const anchor = zonedClockToEpoch(afterMs, dayOffset, hh, mm, cfg?.timezone || '');
    const weekday = getZonedParts(new Date(anchor), cfg?.timezone || '').weekday;
    if (!daySet.has(weekday)) continue;
    const windowEnd = anchor + j * 60000;
    if (windowEnd <= afterMs + 30000) continue;
    return rollJitteredTimestamp(anchor, j, afterMs + 60000, randomUnitFn);
  }
  return 0;
}

export function buildInChatSpeakUpRule(root) {
  const cfg = loadSpeakUpConfig(root);
  if (!cfg.enabled || !cfg.aiPlanEnabled) return '';
  const template = cfg.inChatRulePrompt || buildDefaultSpeakUpRulePrompt(cfg);
  return renderPromptTemplate(template, {
    activeGapMin: cfg.respectActiveChatGapMin,
  });
}

export function isPeakHour(date = new Date(), cfgOrTz = '') {
  const cfg = typeof cfgOrTz === 'object' && cfgOrTz
    ? cfgOrTz
    : {
        usePeakValley: true,
        peakDays: DEFAULT_PEAK_DAYS,
        peakWindows: parsePeakWindows(DEFAULT_PEAK_WINDOWS_TEXT),
        timezone: typeof cfgOrTz === 'string' ? cfgOrTz : '',
      };

  if (cfg.usePeakValley === false) return false;
  const days = normalizePeakDays(cfg.peakDays);
  const windows = Array.isArray(cfg.peakWindows)
    ? cfg.peakWindows
    : parsePeakWindows(cfg.peakWindowsText || DEFAULT_PEAK_WINDOWS_TEXT);
  if (!days.length || !windows.length) return false;

  const { day, minuteOfDay } = getDayAndMinutes(date, cfg.timezone);
  const daySet = new Set(days);
  const prevDay = (day + 6) % 7;

  return windows.some(([start, end]) => {
    if (start < end) {
      return daySet.has(day) && minuteOfDay >= start && minuteOfDay < end;
    }
    // Cross-midnight peak window (e.g. 22:00-02:00)
    return (daySet.has(day) && minuteOfDay >= start) || (daySet.has(prevDay) && minuteOfDay < end);
  });
}

export function inQuietHours(hour, startHour, endHour) {
  if (startHour === endHour) return false;
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

export function calcBaseHitLine(cfg, date = new Date()) {
  if (cfg.usePeakValley === false) {
    return {
      peak: false,
      unified: true,
      baseLine: cfg.valleyHitLine,
      phrase: `基礎命中線 ${cfg.valleyHitLine}%`,
    };
  }
  const peak = isPeakHour(date, cfg);
  return peak
    ? { peak: true, unified: false, baseLine: cfg.peakHitLine, phrase: `峰時命中線 ${cfg.peakHitLine}%` }
    : { peak: false, unified: false, baseLine: cfg.valleyHitLine, phrase: `谷時命中線 ${cfg.valleyHitLine}%` };
}

/**
 * Pure formula matching `dsh-speak-up`:
 *   hitLine = min(100, max(0, baseLine * timingFactor + min(bonusCap, missStreak * missBonus)))
 */
export function calcHitLine(baseLine, factor, missStreak, missBonus, bonusCap) {
  const bonus = Math.min(bonusCap, missStreak * missBonus);
  const line = Math.min(100, Math.max(0, baseLine * factor + bonus));
  return { bonus, line };
}

export function formatCurrentTimeLine(date = new Date()) {
  const h = date.getHours();
  const slot = h < 5 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午'
    : h < 13 ? '中午' : h < 18 ? '下午' : h < 20 ? '傍晚' : h < 23 ? '晚上' : '深夜';
  const wk = '日一二三四五六'[date.getDay()];
  const min = String(date.getMinutes()).padStart(2, '0');
  return `（背景時間：${date.getMonth() + 1}/${date.getDate()} 週${wk} ${slot} ${h}:${min}）`;
}

export function wrapInnerThought(
  promptText,
  date = new Date(),
  { wokeFromSleep = false, followUpHint = '', kind = '', label = '', unansweredCount = 0, freshBrowseBlock = '', root } = {},
) {
  const clean = String(promptText || DEFAULT_SPEAK_UP_CONFIG.triggerPrompt).trim();
  const lines = [
    '<speak-up>',
    SPEAK_UP_MARKER,
    resolvePrompt('speakUp.wrapperIntro', null, root),
  ];
  if (wokeFromSleep) {
    lines.push(resolvePrompt('speakUp.wokeFromSleepNote', null, root));
  }
  if (kind === 'reminder') {
    lines.push(`（這是主人請你到點提醒的事${label ? `「${label}」` : ''}。）`);
  } else if (kind === 'routine') {
    lines.push(`（日常節律${label ? `「${label}」` : ''}探頭時間，隨口打聲招呼就好。）`);
  }
  if (unansweredCount >= 2 && kind !== 'reminder') {
    lines.push(resolvePrompt('speakUp.unansweredNote', { unansweredCount }, root));
  }
  lines.push(formatCurrentTimeLine(date), clean);
  if (freshBrowseBlock) {
    lines.push('', String(freshBrowseBlock).trim());
  }
  if (followUpHint) {
    lines.push(String(followUpHint).trim());
  }
  lines.push('</speak-up>');
  return lines.join('\n');
}

const PROACTIVE_PLAN_CUE_RE = /(?:去睡|睡覺|早點睡|補眠|睡一會|睡一下|晚安|先去忙|我去忙|忙一下|去洗澡|做家事|忙家務|出門|買飯|去吃飯|吃晚餐|吃午餐|吃宵夜|開會|上班|休息一下|晚點再|待會再|等一下再|等下再|別吵|別打擾|安靜一下|叫我|提醒我|幾分鐘後|小時後)/;

/**
 * Emits a lightweight 1-line cue inside `PreInvocation` strictly when the user's message
 * signals leaving, resting, being busy, or expecting a future check-in.
 */
export function buildProactivePlanCue(root, userInput = '', nowMs = Date.now()) {
  const cfg = loadSpeakUpConfig(root);
  if (!cfg.enabled || !cfg.aiPlanEnabled || !cfg.proactiveCueEnabled) return '';
  const clean = String(userInput || '').trim();
  if (!clean || !PROACTIVE_PLAN_CUE_RE.test(clean)) return '';

  const state = loadSpeakUpState(root);
  const upcoming = (state.plans || []).filter((p) => p.triggerAt > nowMs);
  const silenceNote = state.silentUntil > nowMs
    ? `目前勿擾至 ${localClockDisplay(state.silentUntil)}`
    : '';
  const queueNote = upcoming.length
    ? `已有 ${upcoming.length} 筆預約（最近 ${localClockDisplay(upcoming[0].triggerAt)}）`
    : '目前時刻表空白';
  const tendencyNote = cfg.scheduleTendency === 'high'
    ? '（高主動排程開啟中：適合自己決定過陣子再關心時請積極排入 `autonomous`）'
    : '';
  const statusTag = [queueNote, silenceNote].filter(Boolean).join(' · ');
  return resolvePrompt('speakUp.proactiveCue', { statusTag, tendencyNote }, root);
}

function appendSpeakLog(state, text, now = Date.now()) {
  state.logs.push({ at: now, time: localClockDisplay(now), text: String(text) });
  if (state.logs.length > 60) state.logs = state.logs.slice(-60);
}

function appendSpeakLogThrottled(state, prefix, text, now = Date.now()) {
  const last = state.logs[state.logs.length - 1];
  if (last && String(last.text || '').startsWith(prefix)) {
    last.at = now;
    last.time = localClockDisplay(now);
    last.text = String(text);
    return;
  }
  appendSpeakLog(state, text, now);
}

function syncSilenceAndUnanswered(state, nowMs, lastUserSpeechAt = 0) {
  let changed = false;
  if (state.silentUntil > 0 && nowMs >= state.silentUntil) {
    state.silentUntil = 0;
    state.silentReason = '';
    changed = true;
  }
  if (lastUserSpeechAt > 0 && state.lastSpeakAt > 0 && lastUserSpeechAt >= state.lastSpeakAt && state.unansweredCount > 0) {
    state.unansweredCount = 0;
    changed = true;
  }
  return {
    changed,
    isSilenced: state.silentUntil > nowMs,
    effectiveUnanswered: state.unansweredCount,
  };
}

function didSpanQuietHours(cfg, startMs, endMs) {
  if (!startMs || endMs <= startMs || cfg.quietStartHour === cfg.quietEndHour) return false;
  const span = Math.min(endMs - startMs, 24 * 3600_000);
  const stepMs = 30 * 60_000;
  for (let t = startMs; t <= startMs + span; t += stepMs) {
    const { hour } = getDayAndMinutes(new Date(t), cfg.timezone);
    if (inQuietHours(hour, cfg.quietStartHour, cfg.quietEndHour)) return true;
  }
  return false;
}

function shouldSuppressDiceForPendingReminder(cfg, state, nowMs, lastUserSpeechAt = 0) {
  if (!cfg.suppressDiceBeforeReminder) return null;
  const reminders = (state.plans || [])
    .filter((p) => p.kind === 'reminder' && p.triggerAt > nowMs)
    .sort((a, b) => a.triggerAt - b.triggerAt);
  if (!reminders.length) return null;

  const nextRem = reminders[0];
  const minsLeft = Math.max(0, Math.round((nextRem.triggerAt - nowMs) / 60000));
  if (cfg.suppressBeforeReminderMin > 0 && (nextRem.triggerAt - nowMs) <= cfg.suppressBeforeReminderMin * 60000) {
    return { reason: 'near_reminder', reminder: nextRem, minsLeft };
  }

  const noReplySinceRequested = !lastUserSpeechAt || lastUserSpeechAt <= Number(nextRem.requestedAt || 0) + 120_000;
  if (noReplySinceRequested) {
    const isWakeOrRest = /(?:睡|起床|叫醒|叫我|早安|醒來|休息)/.test(`${nextRem.label || ''} ${nextRem.thought || ''}`);
    if (isWakeOrRest || didSpanQuietHours(cfg, Number(nextRem.requestedAt || nowMs), nowMs)) {
      return { reason: 'awaiting_wake_reminder', reminder: nextRem, minsLeft };
    }
  }
  return null;
}

async function deliverSpeakUpThought({
  root,
  cfg,
  state,
  nestState,
  nowMs,
  nowDate,
  targetConvId,
  sender,
  promptText,
  kind = '',
  label = '',
  logText = '',
  allowWakeFromSleep = true,
  includeFreshBrowse = false,
}) {
  let wokeRes = { woke: false, prevSleepStartedAt: 0 };
  if (nestState.sleeping && allowWakeFromSleep) {
    wokeRes = wakeFromSleep(root, {
      now: nowMs,
      reason: 'speak-up',
      label: '睡飽自己醒過來，正準備主動去找你聊兩句…',
      wakeNote: '你在貓窩睡足了一覺自然醒過來，剛掀開小被子準備主動跟主人說話',
      minEnergy: 88,
    });
  }

  const nextUnanswered = (state.unansweredCount || 0) + 1;
  const followUpHint = cfg.aiPlanEnabled
    ? (cfg.followUpHintPrompt || buildDefaultFollowUpHintPrompt(cfg))
    : '';
  const freshPicks = (includeFreshBrowse && kind !== 'reminder' && cfg.freshBrowse?.enabled)
    ? peekFreshBrowsePicks({
        root,
        config: cfg.freshBrowse,
        timezone: cfg.timezone,
        nowMs,
        maxPick: 2,
      })
    : [];
  const freshBrowseBlock = formatFreshBrowsePromptBlock(freshPicks, root);
  const wrapped = wrapInnerThought(promptText, nowDate, {
    wokeFromSleep: wokeRes.woke,
    followUpHint,
    kind,
    label,
    unansweredCount: nextUnanswered,
    freshBrowseBlock,
    root,
  });

  try {
    await sender(targetConvId, wrapped);
  } catch (err) {
    if (wokeRes.woke) {
      restoreSleepState(root, { sleepStartedAt: wokeRes.prevSleepStartedAt, now: nowMs });
    }
    throw err;
  }

  if (freshPicks.length) {
    commitFreshBrowsePicks({
      root,
      picked: freshPicks,
      timezone: cfg.timezone,
      nowMs,
    });
  }

  state.lastSpeakAt = nowMs;
  state.unansweredCount = nextUnanswered;
  const freshTag = freshPicks.length ? `（含 ${freshPicks.length} 則見聞候選）` : '';
  appendSpeakLog(state, `${wokeRes.woke ? '睡醒並' : ''}${logText}${freshTag}`, nowMs);
  return { wokeFromSleep: wokeRes.woke, freshCount: freshPicks.length, message: wrapped };
}

function buildPlanRecord(item, cfg, nowMs, randomUnitFn) {
  const resolved = resolveTargetTimestamp({
    at: item?.at,
    delayMinutes: item?.delayMinutes,
    nowMs,
    timezone: cfg.timezone,
  });
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const jitterMin = Math.round(clampNum(item?.jitterMin, 0, 240, 0));
  const triggerAt = rollJitteredTimestamp(resolved.baseAt, jitterMin, nowMs + 15000, randomUnitFn);
  const kind = item?.kind === 'reminder' ? 'reminder' : 'autonomous';
  const plan = normalizePlanItem({
    id: item?.id || `sp-${nowMs.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    label: item?.label || (kind === 'reminder' ? '約定提醒' : '自主搭話'),
    thought: item?.thought || item?.prompt || '',
    requestedAt: nowMs,
    baseAt: resolved.baseAt,
    jitterMin,
    triggerAt,
    allowDuringQuiet: Boolean(item?.allowDuringQuiet),
    allowWakeFromSleep: item?.allowWakeFromSleep !== undefined
      ? Boolean(item.allowWakeFromSleep)
      : kind === 'reminder',
    deferredCount: 0,
  });
  return { ok: true, plan };
}

/**
 * Mutates AI-scheduled plans, recurring jitter routines, silence windows, or speak-up toggles.
 */
export function mutateSpeakUpPlan(
  action,
  args = {},
  root,
  { now = Date.now(), randomUnitFn = Math.random } = {},
) {
  const cfg = loadSpeakUpConfig(root);
  const state = loadSpeakUpState(root);

  switch (action) {
    case 'list': {
      return {
        ok: true,
        config: cfg,
        state,
        plans: state.plans,
        routines: state.routines,
        freshBrowse: getFreshBrowseSnapshot(root, cfg.freshBrowse, { timezone: cfg.timezone, nowMs: now }),
      };
    }
    case 'schedule':
    case 'add_plan': {
      const built = buildPlanRecord(args, cfg, now, randomUnitFn);
      if (!built.ok) return built;
      const shouldReplaceAuto = built.plan.kind === 'autonomous' && args.replaceExisting !== false;
      if (shouldReplaceAuto) {
        state.plans = state.plans.filter((p) => p.kind !== 'autonomous');
      }
      state.plans.push(built.plan);
      state.plans.sort((a, b) => a.triggerAt - b.triggerAt);
      if (args.silenceUntilTrigger === true) {
        state.silentUntil = Math.max(state.silentUntil || 0, built.plan.triggerAt);
        state.silentReason = String(
          args.silenceReason || (built.plan.label ? `等待「${built.plan.label}」前不打擾` : '等待提醒前不打擾'),
        ).trim().slice(0, 160);
        state.plans = state.plans.filter((p) => p.kind === 'reminder' || p.triggerAt >= state.silentUntil);
      }
      appendSpeakLog(
        state,
        `已預約【${built.plan.kind === 'reminder' ? '提醒' : '自主'}】${built.plan.label || ''} @ ${localClockDisplay(built.plan.triggerAt)}${built.plan.jitterMin ? ` (±${built.plan.jitterMin}m)` : ''}${args.silenceUntilTrigger === true ? '（並設定到點前勿擾）' : ''}`,
        now,
      );
      const saved = saveSpeakUpState(state, root);
      return { ok: true, plan: built.plan, state: saved };
    }
    case 'schedule_batch': {
      const items = Array.isArray(args.plans) ? args.plans : [];
      if (!items.length) return { ok: false, error: '請傳入至少一筆 plans 時間項目' };
      if (args.replaceExisting) {
        state.plans = state.plans.filter((p) => p.kind !== 'autonomous');
      }
      const added = [];
      let silenceUntilMax = 0;
      let silenceLabel = '';
      for (const item of items.slice(0, 20)) {
        const built = buildPlanRecord(item, cfg, now, randomUnitFn);
        if (!built.ok) return built;
        state.plans.push(built.plan);
        added.push(built.plan);
        if (item.silenceUntilTrigger === true && built.plan.triggerAt > silenceUntilMax) {
          silenceUntilMax = built.plan.triggerAt;
          silenceLabel = built.plan.label || '';
        }
      }
      if (silenceUntilMax > 0) {
        state.silentUntil = Math.max(state.silentUntil || 0, silenceUntilMax);
        state.silentReason = silenceLabel ? `等待「${silenceLabel}」前不打擾` : '等待提醒前不打擾';
        state.plans = state.plans.filter((p) => p.kind === 'reminder' || p.triggerAt >= state.silentUntil);
      }
      state.plans.sort((a, b) => a.triggerAt - b.triggerAt);
      appendSpeakLog(state, `已批次排入 ${added.length} 筆搭話／提醒時刻`, now);
      const saved = saveSpeakUpState(state, root);
      return { ok: true, added, state: saved };
    }
    case 'silence': {
      const resolved = resolveTargetTimestamp({
        at: args.until ?? args.at,
        delayMinutes: args.delayMinutes,
        nowMs: now,
        timezone: cfg.timezone,
      });
      if (!resolved.ok) return resolved;
      state.silentUntil = Math.max(now + 60_000, resolved.baseAt);
      state.silentReason = String(args.reason || args.label || '自主判斷暫停打擾').trim().slice(0, 160);
      if (args.clearAutonomous !== false) {
        state.plans = state.plans.filter((p) => p.kind === 'reminder' || p.triggerAt >= state.silentUntil);
      }
      if (args.clearReminders === true) {
        state.plans = state.plans.filter((p) => p.kind !== 'reminder');
      }
      appendSpeakLog(
        state,
        `已啟動自主勿擾至 ${localClockDisplay(state.silentUntil)}（${state.silentReason}）`,
        now,
      );
      const saved = saveSpeakUpState(state, root);
      return { ok: true, silentUntil: state.silentUntil, silentReason: state.silentReason, state: saved };
    }
    case 'clear_silence': {
      state.silentUntil = 0;
      state.silentReason = '';
      appendSpeakLog(state, '已解除自主勿擾狀態', now);
      const saved = saveSpeakUpState(state, root);
      return { ok: true, state: saved };
    }
    case 'add_routine': {
      const clockMin = parseClockMinutes(args.timeHHMM || args.time);
      if (clockMin === null) return { ok: false, error: '固定節律需提供有效的 24 小時時間 HH:MM（例如 12:30）' };
      const routine = normalizeRoutineItem({
        id: args.id || `rt-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        enabled: args.enabled !== false,
        label: args.label || `每日 ${args.timeHHMM || args.time}`,
        days: args.days,
        timeHHMM: fmtMinutes(clockMin === 1440 ? 0 : clockMin),
        jitterMin: args.jitterMin ?? 15,
        thought: args.thought || args.prompt || '',
        allowDuringQuiet: Boolean(args.allowDuringQuiet),
        createdAt: now,
      });
      routine.nextTriggerAt = computeNextRoutineTrigger(routine, cfg, now, randomUnitFn);
      state.routines.push(routine);
      appendSpeakLog(
        state,
        `新增固定節律「${routine.label}」（${routine.timeHHMM} ±${routine.jitterMin}分，下次 ${routine.nextTriggerAt ? localClockDisplay(routine.nextTriggerAt) : '待定'}）`,
        now,
      );
      const saved = saveSpeakUpState(state, root);
      return { ok: true, routine, state: saved };
    }
    case 'update_routine':
    case 'toggle_routine':
    case 'reroll_routine': {
      const idx = state.routines.findIndex((r) => r.id === String(args.id || ''));
      if (idx < 0) return { ok: false, error: `找不到節律 ID：${args.id || ''}` };
      const cur = state.routines[idx];
      const next = normalizeRoutineItem({
        ...cur,
        ...(args.label !== undefined ? { label: args.label } : {}),
        ...(args.days !== undefined ? { days: args.days } : {}),
        ...(args.timeHHMM !== undefined ? { timeHHMM: args.timeHHMM } : {}),
        ...(args.jitterMin !== undefined ? { jitterMin: args.jitterMin } : {}),
        ...(args.thought !== undefined ? { thought: args.thought } : {}),
        ...(args.allowDuringQuiet !== undefined ? { allowDuringQuiet: args.allowDuringQuiet } : {}),
        enabled: action === 'toggle_routine'
          ? (args.enabled !== undefined ? Boolean(args.enabled) : !cur.enabled)
          : (args.enabled !== undefined ? Boolean(args.enabled) : cur.enabled),
      });
      next.nextTriggerAt = next.enabled
        ? computeNextRoutineTrigger(next, cfg, now, randomUnitFn)
        : 0;
      state.routines[idx] = next;
      appendSpeakLog(
        state,
        `${action === 'reroll_routine' ? '重抽波動時間' : '更新固定節律'}「${next.label}」${next.enabled && next.nextTriggerAt ? ` → ${localClockDisplay(next.nextTriggerAt)}` : '（已暫停）'}`,
        now,
      );
      const saved = saveSpeakUpState(state, root);
      return { ok: true, routine: next, state: saved };
    }
    case 'remove':
    case 'remove_plan':
    case 'remove_routine': {
      const id = String(args.id || '').trim();
      const beforeP = state.plans.length;
      const beforeR = state.routines.length;
      state.plans = state.plans.filter((p) => p.id !== id);
      state.routines = state.routines.filter((r) => r.id !== id);
      if (state.plans.length === beforeP && state.routines.length === beforeR) {
        return { ok: false, error: `找不到排程或節律 ID：${id}` };
      }
      appendSpeakLog(state, `已移除排程項目 ${id}`, now);
      const saved = saveSpeakUpState(state, root);
      return { ok: true, state: saved };
    }
    case 'clear_plans': {
      const kind = args.kind === 'reminder' || args.kind === 'autonomous' ? args.kind : '';
      const before = state.plans.length;
      state.plans = kind ? state.plans.filter((p) => p.kind !== kind) : [];
      appendSpeakLog(state, `已清空${kind || '全部'}預約（移除 ${before - state.plans.length} 筆）`, now);
      const saved = saveSpeakUpState(state, root);
      return { ok: true, removed: before - state.plans.length, state: saved };
    }
    case 'set_config': {
      const allowed = {};
      for (const k of [
        'enabled', 'aiPlanEnabled', 'diceEnabled', 'dryRun',
        'respectActiveChatGapMin', 'quietStartHour', 'quietEndHour',
        'triggerPrompt', 'intervalMinutes', 'cooldownMin',
        'diceBlockActiveChat', 'suppressDiceBeforeReminder', 'suppressBeforeReminderMin',
        'maxUnansweredSpontaneous', 'scheduleTendency', 'proactiveCueEnabled',
        'freshBrowse',
      ]) {
        if (args[k] !== undefined) allowed[k] = args[k];
      }
      if (args.freshBrowseEnabled !== undefined) {
        allowed.freshBrowse = {
          ...(allowed.freshBrowse && typeof allowed.freshBrowse === 'object' ? allowed.freshBrowse : {}),
          enabled: Boolean(args.freshBrowseEnabled),
        };
      }
      const nextCfg = saveSpeakUpConfig(allowed, root);
      return { ok: true, config: nextCfg, state };
    }
    default:
      return { ok: false, error: `未知的排程操作：${action}` };
  }
}

/**
 * Unified 60-second background tick handler for Sidecar:
 * 1. If `aiPlanEnabled`, checks due AI-planned queue & jittered routines FIRST (no dice roll).
 * 2. Otherwise if `diceEnabled` and `intervalMinutes` elapsed, runs `executeSpeakUpRoll`.
 */
export async function executeSpeakUpTick({
  root,
  now = new Date(),
  lastUserSpeechAt = 0,
  targetConvId = '',
  minSleepBeforeWakeMs = MIN_SLEEP_FOR_SPEAKUP_WAKE_MS,
  randomFn = () => Math.random() * 100,
  randomUnitFn = Math.random,
  sender = null,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const nowDate = new Date(nowMs);
  const cfg = loadSpeakUpConfig(root);
  if (!cfg.enabled) {
    return { action: 'disabled' };
  }

  const state = loadSpeakUpState(root);
  const synced = syncSilenceAndUnanswered(state, nowMs, lastUserSpeechAt);
  if (synced.changed) saveSpeakUpState(state, root);

  if (cfg.aiPlanEnabled) {
    // Ensure enabled routines missing a nextTriggerAt get initialized seamlessly
    let mutatedInit = false;
    for (const rt of state.routines) {
      if (rt.enabled && (!rt.nextTriggerAt || rt.nextTriggerAt <= 0)) {
        rt.nextTriggerAt = computeNextRoutineTrigger(rt, cfg, nowMs, randomUnitFn);
        mutatedInit = true;
      }
    }
    if (mutatedInit) saveSpeakUpState(state, root);

    // Find earliest due plan or due routine
    const duePlan = state.plans.find((p) => p.triggerAt <= nowMs) || null;
    const dueRoutine = state.routines
      .filter((r) => r.enabled && r.nextTriggerAt > 0 && r.nextTriggerAt <= nowMs)
      .sort((a, b) => a.nextTriggerAt - b.nextTriggerAt)[0] || null;

    let dueType = '';
    let dueItem = null;
    if (duePlan && dueRoutine) {
      if (duePlan.triggerAt <= dueRoutine.nextTriggerAt) {
        dueType = 'plan';
        dueItem = duePlan;
      } else {
        dueType = 'routine';
        dueItem = dueRoutine;
      }
    } else if (duePlan) {
      dueType = 'plan';
      dueItem = duePlan;
    } else if (dueRoutine) {
      dueType = 'routine';
      dueItem = dueRoutine;
    }

    if (dueItem) {
      const kind = dueType === 'routine' ? 'routine' : dueItem.kind;
      const { hour } = getDayAndMinutes(nowDate, cfg.timezone);

      const advanceRoutinePast = (rt, afterEpoch = nowMs) => {
        const cMin = parseClockMinutes(rt.timeHHMM);
        const sMin = cMin === null ? 12 * 60 : (cMin === 1440 ? 0 : cMin);
        const rHh = Math.floor(sMin / 60);
        const rMm = sMin % 60;
        const anchorBase = zonedClockToEpoch(afterEpoch, 0, rHh, rMm, cfg.timezone);
        const afterWin = Math.max(afterEpoch + 60000, anchorBase + (rt.jitterMin || 0) * 60000 + 30000);
        return computeNextRoutineTrigger(rt, cfg, afterWin, randomUnitFn);
      };

      // Silence window pauses autonomous & routines until silentUntil (explicit reminders STILL fire!)
      if (synced.isSilenced && kind !== 'reminder') {
        if (dueType === 'routine') {
          dueItem.nextTriggerAt = advanceRoutinePast(dueItem, state.silentUntil);
          appendSpeakLogThrottled(state, '自主勿擾期間，順延節律', `自主勿擾期間，順延節律「${dueItem.label}」`, nowMs);
        } else {
          state.plans = state.plans.filter((p) => p.id !== dueItem.id);
          appendSpeakLogThrottled(state, '自主勿擾期間，略過自主搭話', `自主勿擾期間，略過自主搭話「${dueItem.label}」`, nowMs);
        }
        saveSpeakUpState(state, root);
        return { action: 'silenced_planned', dueType, state };
      }

      // Unanswered consecutive cap pauses non-reminder autonomous & routines until user replies
      if (
        kind !== 'reminder' &&
        cfg.maxUnansweredSpontaneous > 0 &&
        synced.effectiveUnanswered >= cfg.maxUnansweredSpontaneous
      ) {
        if (dueType === 'routine') {
          dueItem.nextTriggerAt = advanceRoutinePast(dueItem, nowMs);
          appendSpeakLogThrottled(
            state,
            '已讀未回保護（排程）',
            `已讀未回保護（排程）：已連發 ${synced.effectiveUnanswered} 則未獲回覆，節律「${dueItem.label}」順延至下個週期`,
            nowMs,
          );
        } else {
          state.plans = state.plans.filter((p) => p.id !== dueItem.id);
          appendSpeakLogThrottled(
            state,
            '已讀未回保護（排程）',
            `已讀未回保護（排程）：已連發 ${synced.effectiveUnanswered} 則未獲回覆，略過「${dueItem.label}」並等候回覆`,
            nowMs,
          );
        }
        saveSpeakUpState(state, root);
        return { action: 'unanswered_paused_planned', dueType, state };
      }

      if (inQuietHours(hour, cfg.quietStartHour, cfg.quietEndHour) && !dueItem.allowDuringQuiet) {
        if (dueType === 'routine') {
          dueItem.nextTriggerAt = advanceRoutinePast(dueItem);
          appendSpeakLog(state, `節律「${dueItem.label}」落入安靜時段，已順延至下個週期`, nowMs);
        } else if (dueItem.kind === 'autonomous') {
          state.plans = state.plans.filter((p) => p.id !== dueItem.id);
          appendSpeakLog(state, `自主預約「${dueItem.label}」落入安靜時段，已自動略過`, nowMs);
        } else {
          // User-requested reminder deferred by 15m until quiet hours finish
          dueItem.triggerAt = nowMs + 15 * 60000;
          appendSpeakLog(state, `提醒「${dueItem.label}」目前在安靜時段內，延後 15 分鐘待命`, nowMs);
        }
        saveSpeakUpState(state, root);
        return { action: 'quiet_planned', dueType, state };
      }

      const nestState = loadNestState(root, nowMs);
      if (nestState.sleeping) {
        const sleepElapsedMs = Math.max(0, nowMs - Number(nestState.sleepStartedAt || nowMs));
        if (kind !== 'reminder' && sleepElapsedMs < minSleepBeforeWakeMs) {
          if (dueType === 'plan') dueItem.triggerAt = nowMs + 10 * 60000;
          else dueItem.nextTriggerAt = nowMs + 10 * 60000;
          appendSpeakLog(state, `貓窩休眠中，已順延【${dueItem.label}】10 分鐘`, nowMs);
          saveSpeakUpState(state, root);
          return { action: 'sleeping_planned', dueType, state };
        }
      }

      if (
        kind !== 'reminder' &&
        cfg.respectActiveChatGapMin > 0 &&
        lastUserSpeechAt > 0 &&
        nowMs - lastUserSpeechAt < cfg.respectActiveChatGapMin * 60000
      ) {
        const nextWaitAt = Math.max(nowMs + 60000, lastUserSpeechAt + cfg.respectActiveChatGapMin * 60000 + 60000);
        if (dueType === 'routine') {
          dueItem.deferredCount = (dueItem.deferredCount || 0) + 1;
          if (dueItem.deferredCount >= 3) {
            dueItem.deferredCount = 0;
            dueItem.nextTriggerAt = advanceRoutinePast(dueItem);
            appendSpeakLog(state, `節律「${dueItem.label}」因對話持續進行，改排至下次週期`, nowMs);
          } else {
            dueItem.nextTriggerAt = nextWaitAt;
            appendSpeakLog(state, `剛才還在對話中，順延節律「${dueItem.label}」至 ${localClockDisplay(nextWaitAt)}`, nowMs);
          }
        } else {
          dueItem.deferredCount = (dueItem.deferredCount || 0) + 1;
          dueItem.triggerAt = nextWaitAt;
          appendSpeakLog(state, `剛才還在對話中，順延自主預約「${dueItem.label}」至 ${localClockDisplay(nextWaitAt)}`, nowMs);
        }
        saveSpeakUpState(state, root);
        return { action: 'deferred_active_chat', dueType, state };
      }

      const consumeDueItem = () => {
        if (dueType === 'plan') {
          state.plans = state.plans.filter((p) => p.id !== dueItem.id);
        } else {
          dueItem.lastFiredAt = nowMs;
          dueItem.deferredCount = 0;
          dueItem.nextTriggerAt = advanceRoutinePast(dueItem);
        }
      };

      if (cfg.dryRun) {
        consumeDueItem();
        appendSpeakLog(state, `試運行命中【${dueType === 'routine' ? '固定波動節律' : 'AI預約'}】${dueItem.label || ''}`, nowMs);
        saveSpeakUpState(state, root);
        return { action: 'dry_planned', dueType, dry: true, state };
      }

      if (!targetConvId) {
        appendSpeakLog(state, `預約時間已到但無目標對話（${dueItem.label}）`, nowMs);
        saveSpeakUpState(state, root);
        return { action: 'no_target', dueType, state };
      }

      if (typeof sender !== 'function') {
        return { action: 'no_sender', dueType, state };
      }

      const delivered = await deliverSpeakUpThought({
        root,
        cfg,
        state,
        nestState,
        nowMs,
        nowDate,
        targetConvId,
        sender,
        promptText: dueItem.thought || cfg.triggerPrompt,
        kind,
        label: dueItem.label,
        allowWakeFromSleep: kind !== 'reminder' || dueItem.allowWakeFromSleep !== false,
        includeFreshBrowse: kind === 'routine',
        logText: `已依【${dueType === 'routine' ? `波動節律:${dueItem.timeHHMM}±${dueItem.jitterMin}m` : (kind === 'reminder' ? '約定提醒' : '自主排程')}】開口（${dueItem.label || targetConvId.slice(-8)}）`,
      });
      consumeDueItem();
      saveSpeakUpState(state, root);
      return {
        action: 'sent_planned',
        dueType,
        kind,
        wokeFromSleep: delivered.wokeFromSleep,
        targetConvId,
        message: delivered.message,
        state,
      };
    }
  }

  if (synced.isSilenced) {
    return { action: 'silenced', until: state.silentUntil, reason: state.silentReason, state };
  }

  if (!cfg.diceEnabled) {
    return { action: 'waiting_plan', state };
  }

  const intervalMs = Math.max(1, cfg.intervalMinutes) * 60000;
  if (state.lastTickAt > 0 && nowMs - state.lastTickAt < intervalMs) {
    return { action: 'interval_wait', state };
  }

  return executeSpeakUpRoll({
    root,
    mode: 'auto',
    now: nowDate,
    lastUserSpeechAt,
    targetConvId,
    minSleepBeforeWakeMs,
    randomFn,
    sender,
  });
}

/**
 * Evaluates a formula dice roll (`mode`: `'auto' | 'dry' | 'send'`).
 * When `shouldDeliver` is true and `sender` is provided, sends the wrapped thought to `targetConvId`.
 * Manual `'dry'` and `'send'` buttons never mutate `missStreak`.
 */
export async function executeSpeakUpRoll({
  root,
  mode = 'auto',
  now = new Date(),
  lastUserSpeechAt = 0,
  targetConvId = '',
  minSleepBeforeWakeMs = MIN_SLEEP_FOR_SPEAKUP_WAKE_MS,
  randomFn = () => Math.random() * 100,
  sender = null,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const nowDate = new Date(nowMs);
  const cfg = loadSpeakUpConfig(root);
  const state = loadSpeakUpState(root);
  state.lastTickAt = nowMs;
  const synced = syncSilenceAndUnanswered(state, nowMs, lastUserSpeechAt);

  if (mode === 'auto' && !cfg.enabled) {
    appendSpeakLog(state, '自動跳過：總開關未開啟', nowMs);
    saveSpeakUpState(state, root);
    return { action: 'disabled', state };
  }

  if (mode === 'auto' && !cfg.diceEnabled) {
    appendSpeakLog(state, '自動跳過：隨機擲骰開關已關閉', nowMs);
    saveSpeakUpState(state, root);
    return { action: 'dice_disabled', state };
  }

  if (mode === 'auto' && synced.isSilenced) {
    appendSpeakLogThrottled(
      state,
      '自主勿擾中略過',
      `自主勿擾中略過擲骰（至 ${localClockDisplay(state.silentUntil)}${state.silentReason ? `：${state.silentReason}` : ''}）`,
      nowMs,
    );
    saveSpeakUpState(state, root);
    return { action: 'silenced', until: state.silentUntil, reason: state.silentReason, state };
  }

  const { hour } = getDayAndMinutes(nowDate, cfg.timezone);
  if (mode === 'auto' && inQuietHours(hour, cfg.quietStartHour, cfg.quietEndHour)) {
    appendSpeakLog(state, `安靜時段跳過（${hour}點，設定 ${cfg.quietStartHour}~${cfg.quietEndHour}）`, nowMs);
    saveSpeakUpState(state, root);
    return { action: 'quiet', state };
  }

  if (mode === 'auto' && cfg.maxUnansweredSpontaneous > 0 && synced.effectiveUnanswered >= cfg.maxUnansweredSpontaneous) {
    appendSpeakLogThrottled(
      state,
      '已讀未回保護（擲骰）',
      `已讀未回保護（擲骰）：已連發 ${synced.effectiveUnanswered}/${cfg.maxUnansweredSpontaneous} 則未獲回覆，先安靜等對方說話`,
      nowMs,
    );
    saveSpeakUpState(state, root);
    return { action: 'unanswered_paused', unansweredCount: synced.effectiveUnanswered, state };
  }

  if (mode === 'auto' && cfg.diceBlockActiveChat && cfg.respectActiveChatGapMin > 0 && lastUserSpeechAt > 0) {
    const minsSinceUser = Math.max(0, (nowMs - lastUserSpeechAt) / 60000);
    if (minsSinceUser < cfg.respectActiveChatGapMin) {
      appendSpeakLogThrottled(
        state,
        '對話進行中略過擲骰',
        `對話進行中略過擲骰（距上次說話 ${minsSinceUser.toFixed(1)} 分鐘 < 防打擾門檻 ${cfg.respectActiveChatGapMin} 分鐘）`,
        nowMs,
      );
      saveSpeakUpState(state, root);
      return { action: 'active_chat_blocked', state };
    }
  }

  if (mode === 'auto') {
    const remGuard = shouldSuppressDiceForPendingReminder(cfg, state, nowMs, lastUserSpeechAt);
    if (remGuard) {
      appendSpeakLogThrottled(
        state,
        '待辦提醒保護',
        `待辦提醒保護：即將有「${remGuard.reminder.label || '提醒'}」（剩 ${remGuard.minsLeft} 分鐘），自動壓制中間隨機擲骰`,
        nowMs,
      );
      saveSpeakUpState(state, root);
      return { action: 'reminder_guard', reason: remGuard.reason, state };
    }
  }

  const nestState = loadNestState(root, nowMs);
  if (mode === 'auto' && nestState.sleeping) {
    const sleepElapsedMs = Math.max(0, nowMs - Number(nestState.sleepStartedAt || nowMs));
    if (sleepElapsedMs < minSleepBeforeWakeMs) {
      appendSpeakLog(
        state,
        `打盹休眠中跳過（已睡 ${(sleepElapsedMs / 60000).toFixed(1)} 分鐘，滿 ${Math.max(1, Math.round(minSleepBeforeWakeMs / 60000))} 分鐘後命中才會自然醒來）`,
        nowMs,
      );
      saveSpeakUpState(state, root);
      return { action: 'sleeping', state };
    }
  }

  if (mode === 'auto' && cfg.cooldownMin > 0 && state.lastSpeakAt > 0) {
    const effectiveCooldownMin = cfg.cooldownMin * (1 + Math.min(3, synced.effectiveUnanswered));
    const minsSinceSpeak = (nowMs - state.lastSpeakAt) / 60000;
    if (minsSinceSpeak < effectiveCooldownMin) {
      appendSpeakLog(
        state,
        `冷卻中（距上次主動開口 ${minsSinceSpeak.toFixed(1)} 分鐘 < ${effectiveCooldownMin} 分鐘${synced.effectiveUnanswered ? ` [含未回退避 ×${1 + Math.min(3, synced.effectiveUnanswered)}]` : ''}）`,
        nowMs,
      );
      saveSpeakUpState(state, root);
      return { action: 'cooldown', state };
    }
  }

  let factor = 1;
  let distDesc = '尚無對話時間紀錄';
  if (lastUserSpeechAt > 0) {
    const minsSinceUser = Math.max(0, (nowMs - lastUserSpeechAt) / 60000);
    distDesc = `距上次說話 ${minsSinceUser.toFixed(1)} 分鐘`;
    if (minsSinceUser < cfg.nearThresholdMin) factor = cfg.nearFactor;
    else if (minsSinceUser > cfg.farThresholdMin) factor = cfg.farFactor;
  }

  const base = calcBaseHitLine(cfg, nowDate);
  const streakBefore = state.missStreak;
  const { bonus, line } = calcHitLine(base.baseLine, factor, streakBefore, cfg.missBonus, cfg.bonusCap);
  const eq = `${line.toFixed(1)} = ${base.phrase} × 時機因子 ${factor}（${distDesc}）${bonus > 0 ? ` + 沒中加成 ${bonus.toFixed(1)}` : ''}`;

  let hit = true;
  let roll = 0;
  if (mode === 'auto') {
    roll = Number(randomFn());
    hit = roll < line;
    if (!hit) {
      state.missStreak = streakBefore + 1;
      appendSpeakLog(state, `未擲中（骰子 ${roll.toFixed(1)} ≥ ${eq}，連沒中 → ${state.missStreak}）`, nowMs);
      saveSpeakUpState(state, root);
      return { action: 'missed', hit: false, roll, line, eq, state };
    }
    state.missStreak = 0;
  }

  const isDry = mode === 'dry' || (mode === 'auto' && cfg.dryRun);
  if (isDry) {
    const prefix = mode === 'dry' ? '手動演練' : '試運行擲中（不發送）';
    appendSpeakLog(state, `${prefix}：${mode === 'auto' ? `骰子 ${roll.toFixed(1)} < ` : ''}${eq}`, nowMs);
    saveSpeakUpState(state, root);
    return { action: 'dry_hit', hit: true, dry: true, roll, line, eq, state };
  }

  if (!targetConvId) {
    appendSpeakLog(state, `擲中但無可用的 gemini_cat 目標對話：${eq}`, nowMs);
    saveSpeakUpState(state, root);
    return { action: 'no_target', hit: true, roll, line, eq, state };
  }

  if (typeof sender !== 'function') {
    const wrapped = wrapInnerThought(cfg.triggerPrompt, nowDate, { root });
    appendSpeakLog(state, `擲中但目前無發送管道：${eq}`, nowMs);
    saveSpeakUpState(state, root);
    return { action: 'no_sender', hit: true, message: wrapped, state };
  }

  const delivered = await deliverSpeakUpThought({
    root,
    cfg,
    state,
    nestState,
    nowMs,
    nowDate,
    targetConvId,
    sender,
    promptText: cfg.triggerPrompt,
    kind: 'dice',
    includeFreshBrowse: true,
    logText: `已主動搭話（目標 ${targetConvId.slice(-8)}）：${eq}`,
  });
  saveSpeakUpState(state, root);
  return {
    action: 'sent',
    hit: true,
    wokeFromSleep: delivered.wokeFromSleep,
    targetConvId,
    message: delivered.message,
    roll,
    line,
    eq,
    state,
  };
}

export function getSpeakUpSnapshot(root, lastUserSpeechAt = 0, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const nowDate = new Date(nowMs);
  const cfg = loadSpeakUpConfig(root);
  const state = loadSpeakUpState(root);
  const synced = syncSilenceAndUnanswered(state, nowMs, lastUserSpeechAt);

  let factor = 1;
  if (lastUserSpeechAt > 0) {
    const mins = Math.max(0, (nowMs - lastUserSpeechAt) / 60000);
    if (mins < cfg.nearThresholdMin) factor = cfg.nearFactor;
    else if (mins > cfg.farThresholdMin) factor = cfg.farFactor;
  }
  const base = calcBaseHitLine(cfg, nowDate);
  const { bonus, line } = calcHitLine(base.baseLine, factor, state.missStreak, cfg.missBonus, cfg.bonusCap);
  const { hour } = getDayAndMinutes(nowDate, cfg.timezone);
  const freshBrowse = getFreshBrowseSnapshot(root, cfg.freshBrowse, { timezone: cfg.timezone, nowMs });

  return {
    config: cfg,
    freshBrowse,
    defaultInChatRulePrompt: buildDefaultSpeakUpRulePrompt(cfg),
    defaultFollowUpHintPrompt: buildDefaultFollowUpHintPrompt(cfg),
    defaultTriggerPrompt: DEFAULT_SPEAK_UP_CONFIG.triggerPrompt,
    state: {
      ...state,
      silentUntil: synced.isSilenced ? state.silentUntil : 0,
      silentReason: synced.isSilenced ? state.silentReason : '',
      unansweredCount: synced.effectiveUnanswered,
      plans: (state.plans || []).slice().sort((a, b) => a.triggerAt - b.triggerAt),
      routines: (state.routines || []).slice(),
      logs: state.logs.slice().reverse(),
    },
    preview: {
      peak: base.peak,
      unified: Boolean(base.unified),
      usePeakValley: cfg.usePeakValley,
      peakDays: cfg.peakDays,
      peakWindowsText: cfg.peakWindowsText,
      baseLine: base.baseLine,
      factor,
      bonus,
      hitLine: Number(line.toFixed(1)),
      inQuiet: inQuietHours(hour, cfg.quietStartHour, cfg.quietEndHour),
      isSilenced: synced.isSilenced,
      silentUntil: synced.isSilenced ? state.silentUntil : 0,
      silentReason: synced.isSilenced ? state.silentReason : '',
      unansweredCount: synced.effectiveUnanswered,
    },
  };
}
