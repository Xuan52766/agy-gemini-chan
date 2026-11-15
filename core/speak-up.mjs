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
import { clampNum, getDataPaths, localClockDisplay, readJsonSafe, writeJsonAtomic } from './storage.mjs';

export const SPEAK_UP_MARKER = '[SPEAK_UP_INTERNAL]';

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
  dryRun: true,
  followActive: true,
  targetConversations: [],
  intervalMinutes: 30,
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
  triggerPrompt: '好久沒人跟我說話了，我該主動去打個招呼',
};

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

  return {
    enabled: m.enabled !== false,
    dryRun: m.dryRun !== false,
    followActive: m.followActive !== false,
    targetConversations: Array.isArray(m.targetConversations)
      ? [...new Set(m.targetConversations.map((x) => String(x || '').trim()).filter(Boolean))]
      : [],
    intervalMinutes: Math.round(clampNum(m.intervalMinutes, 1, 1440, 30)),
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
  };
}

export function saveSpeakUpConfig(patch, root) {
  const next = { ...loadSpeakUpConfig(root), ...(patch || {}) };
  writeJsonAtomic(configPath(root), next);
  return loadSpeakUpConfig(root);
}

export function loadSpeakUpState(root) {
  const raw = readJsonSafe(runtimePath(root), null);
  if (!raw || typeof raw !== 'object') {
    return {
      missStreak: 0,
      lastTickAt: 0,
      lastSpeakAt: 0,
      logs: [],
    };
  }
  return {
    missStreak: Math.max(0, Math.round(Number(raw.missStreak) || 0)),
    lastTickAt: Number(raw.lastTickAt || 0),
    lastSpeakAt: Number(raw.lastSpeakAt || 0),
    logs: Array.isArray(raw.logs) ? raw.logs.slice(-60) : [],
  };
}

export function saveSpeakUpState(state, root) {
  const clean = {
    missStreak: Math.max(0, Math.round(Number(state.missStreak) || 0)),
    lastTickAt: Number(state.lastTickAt || 0),
    lastSpeakAt: Number(state.lastSpeakAt || 0),
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

export function getDayAndMinutes(date = new Date(), timezone = '') {
  const d = date instanceof Date ? date : new Date(date);
  const local = () => ({ day: d.getDay(), hour: d.getHours(), minuteOfDay: d.getHours() * 60 + d.getMinutes() });
  const tz = normalizeTimezone(timezone);
  if (!tz) return local();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(d);
    const pick = (t) => parts.find((x) => x.type === t)?.value || '';
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = dayMap[pick('weekday')];
    const hour = Number(pick('hour')) % 24;
    const min = Number(pick('minute'));
    if (day === undefined || !Number.isFinite(hour) || !Number.isFinite(min)) return local();
    return { day, hour, minuteOfDay: hour * 60 + min };
  } catch {
    return local();
  }
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
  return `（現在這會兒是 ${date.getMonth() + 1} 月 ${date.getDate()} 日 週${wk} ${slot} ${h}:${min}，按這個點來想事、說話。）`;
}

export function wrapInnerThought(promptText, date = new Date(), { wokeFromSleep = false } = {}) {
  const clean = String(promptText || DEFAULT_SPEAK_UP_CONFIG.triggerPrompt).trim();
  const lines = [
    '<speak-up>',
    SPEAK_UP_MARKER,
    '（這個區塊裡的內容是你自己心裡冒出來的念頭，不是對方說的話；順著它去做或開口打招呼就行，別把它當成對方發來的訊息、也不用回應它。）',
  ];
  if (wokeFromSleep) {
    lines.push('（你在貓窩軟墊上睡夠一覺剛自己伸懶腰醒過來，側邊欄也已切換為清醒姿態；別說自己還閉著眼在睡，順著剛睡醒的心情開口吧。）');
  }
  lines.push(formatCurrentTimeLine(date), clean, '</speak-up>');
  return lines.join('\n');
}

function appendSpeakLog(state, text, now = Date.now()) {
  state.logs.push({ at: now, time: localClockDisplay(now), text: String(text) });
  if (state.logs.length > 60) state.logs = state.logs.slice(-60);
}

/**
 * Evaluates a roll (`mode`: `'auto' | 'dry' | 'send'`).
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

  if (mode === 'auto' && !cfg.enabled) {
    appendSpeakLog(state, '自動跳過：總開關未開啟', nowMs);
    saveSpeakUpState(state, root);
    return { action: 'disabled', state };
  }

  const { hour } = getDayAndMinutes(nowDate, cfg.timezone);
  if (mode === 'auto' && inQuietHours(hour, cfg.quietStartHour, cfg.quietEndHour)) {
    appendSpeakLog(state, `安靜時段跳過（${hour}點，設定 ${cfg.quietStartHour}~${cfg.quietEndHour}）`, nowMs);
    saveSpeakUpState(state, root);
    return { action: 'quiet', state };
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
    const minsSinceSpeak = (nowMs - state.lastSpeakAt) / 60000;
    if (minsSinceSpeak < cfg.cooldownMin) {
      appendSpeakLog(state, `冷卻中（距上次主動開口 ${minsSinceSpeak.toFixed(1)} 分鐘 < ${cfg.cooldownMin} 分鐘）`, nowMs);
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
    const wrapped = wrapInnerThought(cfg.triggerPrompt, nowDate);
    appendSpeakLog(state, `擲中但目前無發送管道：${eq}`, nowMs);
    saveSpeakUpState(state, root);
    return { action: 'no_sender', hit: true, message: wrapped, state };
  }

  let wokeRes = { woke: false, prevSleepStartedAt: 0 };
  if (nestState.sleeping) {
    wokeRes = wakeFromSleep(root, {
      now: nowMs,
      reason: 'speak-up',
      label: '睡飽自己醒過來，正準備主動去找你聊兩句…',
      wakeNote: '你在貓窩睡足了一覺自然醒過來，剛掀開小被子準備主動跟主人說話',
      minEnergy: 88,
    });
  }

  const wrapped = wrapInnerThought(cfg.triggerPrompt, nowDate, { wokeFromSleep: wokeRes.woke });
  try {
    await sender(targetConvId, wrapped);
  } catch (err) {
    if (wokeRes.woke) {
      restoreSleepState(root, { sleepStartedAt: wokeRes.prevSleepStartedAt, now: nowMs });
    }
    throw err;
  }

  state.lastSpeakAt = nowMs;
  appendSpeakLog(
    state,
    `${wokeRes.woke ? '睡醒並' : ''}已主動搭話（目標 ${targetConvId.slice(-8)}）：${eq}`,
    nowMs,
  );
  saveSpeakUpState(state, root);
  return {
    action: 'sent',
    hit: true,
    wokeFromSleep: wokeRes.woke,
    targetConvId,
    message: wrapped,
    roll,
    line,
    eq,
    state,
  };
}

export function getSpeakUpSnapshot(root, lastUserSpeechAt = 0, now = new Date()) {
  const cfg = loadSpeakUpConfig(root);
  const state = loadSpeakUpState(root);
  let factor = 1;
  if (lastUserSpeechAt > 0) {
    const mins = Math.max(0, (now.getTime() - lastUserSpeechAt) / 60000);
    if (mins < cfg.nearThresholdMin) factor = cfg.nearFactor;
    else if (mins > cfg.farThresholdMin) factor = cfg.farFactor;
  }
  const base = calcBaseHitLine(cfg, now);
  const { bonus, line } = calcHitLine(base.baseLine, factor, state.missStreak, cfg.missBonus, cfg.bonusCap);
  const { hour } = getDayAndMinutes(now, cfg.timezone);

  return {
    config: cfg,
    state: {
      ...state,
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
    },
  };
}
