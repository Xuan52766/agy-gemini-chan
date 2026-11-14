/**
 * @fileoverview Interactive Cat Nest (貓窩) pet state, visual sprite resolver,
 * realistic cooldown / satiety / tiredness / daily-cap limits, live chat activity
 * bridge, and bidirectional event queue (`pendingForChat`) linking Sidecar actions
 * into Antigravity conversations.
 *
 * NOTE: Per DSH principle, Cat Nest care buttons NEVER directly inflate `mood`
 * (`dsh-feiyu-mood`). Care interactions modify physical vitals (`satiety`,
 * `energy`, `bond`, `sleeping`) within daily & cooldown limits and feed into
 * real dialogue, where genuine conversational response drives mood.
 */

import { join } from 'node:path';
import { moodLabel, moodTier } from './mood.mjs';
import {
  clampNum,
  getDataPaths,
  localClockDisplay,
  localDayKey,
  readJsonSafe,
  writeJsonAtomic,
} from './storage.mjs';

function nestStatePath(root) {
  return join(getDataPaths(root).nestDir, 'state.json');
}

export const CARE_RULES = {
  pet: {
    label: '摸摸頭',
    cooldownSec: 15,
    dailyCap: 6,
    satiety: 0,
    energy: 1,
    bond: 2,
    reaction: '喵嗚～被輕輕摸摸腦袋，星髮夾晃了晃，尾巴高高翹起來了！',
    chatNote: '主人在貓窩側邊欄裡輕輕摸了摸你的頭',
    capMsg: '今天頭毛已經被摸得順順亮亮好多次啦，先陪她聊聊別的嘛～',
  },
  feed: {
    label: '餵小魚乾',
    cooldownSec: 60,
    dailyCap: 4,
    maxSatiety: 95,
    satiety: 18,
    energy: 5,
    bond: 3,
    reaction: '啊嗚一口吃掉香噴噴的星空小魚乾，滿足得眼睛瞇起來！',
    chatNote: '主人在貓窩裡餵你吃了小魚乾',
    capMsg: '今天的小魚乾扣打已經吃光光了，不能再挑食一直吃啦！',
  },
  play: {
    label: '逗貓棒玩耍',
    cooldownSec: 45,
    dailyCap: 5,
    minEnergy: 20,
    satiety: -5,
    energy: -8,
    bond: 4,
    reaction: '追著星星逗貓棒撲過去，差點在軟墊上滾成一團～',
    chatNote: '主人在貓窩裡揮著星星逗貓棒陪你玩了一會兒',
    capMsg: '今天已經玩夠多回合啦，讓小貓爪休息一下嘛！',
  },
  nap: {
    label: '蓋小被子休息',
    toggleSleep: true,
    cooldownSec: 10,
    dailyCap: 4,
    satiety: 0,
    energy: 14,
    bond: 2,
    reaction: '鑽進星空毛毯裡蜷成一團打個小盹……zzZ',
    reactionWake: '伸了個大懶腰醒過來，雙色貓眼亮晶晶地看著你！',
    chatNote: '主人在貓窩裡幫你蓋好了星空小被子休息',
    chatNoteWake: '主人在貓窩裡輕輕拍醒了正在打盹的你',
    capMsg: '剛掀開又蓋被子這麼多次，床墊要被折騰亂掉啦～',
  },
  comfort: {
    label: '貼貼抱抱',
    cooldownSec: 30,
    dailyCap: 5,
    satiety: 0,
    energy: 3,
    bond: 3,
    reaction: '被緊緊抱在懷裡蹭了蹭，感覺整個人都被好好接住了。',
    chatNote: '主人在貓窩裡給了你一個溫暖的貼貼抱抱',
    capMsg: '一直貼貼抱抱會害羞到冒煙的！先把這份溫暖收進心裡，跟她說說話吧～',
  },
};

const WHISPER_COOLDOWN_SEC = 8;
const WHISPER_DAILY_BOND_CAP = 5;
export const MIN_SLEEP_FOR_SPEAKUP_WAKE_MS = 20 * 60_000;
export const MAX_AUTO_NAP_MS = 90 * 60_000;

function emptyLimits(now = Date.now()) {
  return {
    dayKey: localDayKey(now),
    lastActionAt: {},
    dailyCounts: {},
  };
}

function emptyNestState(now = Date.now()) {
  return {
    satiety: 76,
    energy: 84,
    bond: 45,
    sleeping: false,
    sleepStartedAt: 0,
    lastWokeNote: null,
    syncChatOnCare: false,
    lastCareAt: now,
    totalInteractions: 0,
    limits: emptyLimits(now),
    activity: {
      phase: 'idle',
      label: '在貓窩裡晃尾巴等你～',
      toolName: '',
      updatedAt: now,
    },
    pendingForChat: [],
    history: [],
  };
}

function rolloverDailyLimits(limits, now = Date.now()) {
  const today = localDayKey(now);
  const clean = limits && typeof limits === 'object' ? { ...limits } : emptyLimits(now);
  clean.lastActionAt = clean.lastActionAt && typeof clean.lastActionAt === 'object'
    ? { ...clean.lastActionAt }
    : {};
  if (clean.dayKey !== today) {
    clean.dayKey = today;
    clean.dailyCounts = {};
  } else {
    clean.dailyCounts = clean.dailyCounts && typeof clean.dailyCounts === 'object'
      ? { ...clean.dailyCounts }
      : {};
  }
  return clean;
}

export function loadNestState(root, now = Date.now()) {
  const p = nestStatePath(root);
  const raw = readJsonSafe(p, null);
  if (!raw || typeof raw !== 'object') {
    const init = emptyNestState(now);
    writeJsonAtomic(p, init);
    return init;
  }
  const base = emptyNestState(now);
  const rawSleeping = Boolean(raw.sleeping);
  const resolvedSleepStart = rawSleeping
    ? Number(raw.sleepStartedAt || raw.limits?.lastActionAt?.nap || raw.lastCareAt || now)
    : 0;
  const state = {
    ...base,
    ...raw,
    sleeping: rawSleeping,
    sleepStartedAt: resolvedSleepStart,
    lastWokeNote: raw.lastWokeNote && typeof raw.lastWokeNote === 'object' ? raw.lastWokeNote : null,
    syncChatOnCare: Boolean(raw.syncChatOnCare),
    limits: rolloverDailyLimits(raw.limits, now),
    activity: { ...base.activity, ...(raw.activity || {}) },
    pendingForChat: Array.isArray(raw.pendingForChat) ? raw.pendingForChat.slice(-12) : [],
    history: Array.isArray(raw.history) ? raw.history.slice(-40) : [],
  };

  let dirty = false;
  if (state.sleeping && state.sleepStartedAt > 0 && (now - state.sleepStartedAt) >= MAX_AUTO_NAP_MS) {
    state.sleeping = false;
    state.sleepStartedAt = 0;
    state.energy = clampNum(Math.max(state.energy, 92), 0, 100, 92);
    state.lastCareAt = now;
    state.lastWokeNote = {
      at: now,
      reason: 'rested',
      text: '你在貓窩睡飽了一覺後自己伸懶腰醒過來了（側邊欄立繪已切換為清醒狀態）',
    };
    state.activity = {
      phase: 'idle',
      label: '睡飽一覺自然醒過來啦，伸個懶腰在貓窩等你～',
      toolName: '',
      updatedAt: now,
    };
    dirty = true;
  }

  // Gentle time drift for satiety/energy
  const elapsedMin = Math.max(0, (now - Number(state.lastCareAt || now)) / 60000);
  if (elapsedMin >= 5) {
    state.satiety = clampNum(state.satiety - elapsedMin * 0.08, 10, 100, state.satiety);
    state.energy = state.sleeping
      ? clampNum(state.energy + elapsedMin * 0.25, 10, 100, state.energy)
      : clampNum(state.energy - elapsedMin * 0.04, 15, 100, state.energy);
    state.lastCareAt = now;
    dirty = true;
  }
  if (dirty) writeJsonAtomic(p, state);
  return state;
}

export function saveNestState(state, root) {
  if (Array.isArray(state.pendingForChat) && state.pendingForChat.length > 12) {
    state.pendingForChat = state.pendingForChat.slice(-12);
  }
  if (Array.isArray(state.history) && state.history.length > 40) {
    state.history = state.history.slice(-40);
  }
  writeJsonAtomic(nestStatePath(root), state);
  return state;
}

export function setNestPreferences(patch = {}, root, now = Date.now()) {
  const state = loadNestState(root, now);
  if (patch.syncChatOnCare !== undefined) {
    state.syncChatOnCare = Boolean(patch.syncChatOnCare);
  }
  return saveNestState(state, root);
}

export function clearPendingNestEvents(root, now = Date.now()) {
  const state = loadNestState(root, now);
  state.pendingForChat = [];
  return saveNestState(state, root);
}

function checkActionLimit(action, state, now) {
  const limits = state.limits;
  const lastAt = Number(limits.lastActionAt[action] || 0);
  const dailyUsed = Number(limits.dailyCounts[action] || 0);

  if (action === 'whisper') {
    const waitSec = lastAt > 0 ? Math.ceil((lastAt + WHISPER_COOLDOWN_SEC * 1000 - now) / 1000) : 0;
    if (waitSec > 0) {
      return {
        blocked: true,
        limitReason: 'cooldown',
        cooldownLeftSec: waitSec,
        dailyUsed,
        dailyCap: WHISPER_DAILY_BOND_CAP,
        message: `小紙條遞太快啦，${waitSec} 秒後再送出一張嘛～`,
      };
    }
    return { blocked: false, cooldownLeftSec: 0, dailyUsed, dailyCap: WHISPER_DAILY_BOND_CAP };
  }

  const def = CARE_RULES[action];
  const waitSec = lastAt > 0 ? Math.ceil((lastAt + def.cooldownSec * 1000 - now) / 1000) : 0;
  if (waitSec > 0) {
    return {
      blocked: true,
      limitReason: 'cooldown',
      cooldownLeftSec: waitSec,
      dailyUsed,
      dailyCap: def.dailyCap,
      message: `剛剛才${def.label}過呢，等 ${waitSec} 秒再來互動才不會膩嘛～`,
    };
  }

  if (dailyUsed >= def.dailyCap) {
    return {
      blocked: true,
      limitReason: 'daily_cap',
      cooldownLeftSec: 0,
      dailyUsed,
      dailyCap: def.dailyCap,
      message: `${def.capMsg}（今日 ${dailyUsed}/${def.dailyCap} 次已達上限）`,
    };
  }

  if (action === 'feed' && state.satiety >= def.maxSatiety) {
    return {
      blocked: true,
      limitReason: 'full',
      cooldownLeftSec: 0,
      dailyUsed,
      dailyCap: def.dailyCap,
      message: `小肚肚已經吃撐啦（飽食 ${Math.round(state.satiety)}/100），過一會兒消化完再吃小魚乾～`,
    };
  }

  if (action === 'play' && state.sleeping) {
    return {
      blocked: true,
      limitReason: 'sleeping',
      cooldownLeftSec: 0,
      dailyUsed,
      dailyCap: def.dailyCap,
      message: '還在被窩裡迷迷糊糊打盹呢，想一起玩的話先點「叫醒她」喔！',
    };
  }

  if (action === 'play' && state.energy < def.minEnergy) {
    return {
      blocked: true,
      limitReason: 'tired',
      cooldownLeftSec: 0,
      dailyUsed,
      dailyCap: def.dailyCap,
      message: `精力不太夠了（${Math.round(state.energy)}/100），尾巴都垂下來了，先讓她蓋被子歇一會兒吧…`,
    };
  }

  return { blocked: false, cooldownLeftSec: 0, dailyUsed, dailyCap: def.dailyCap };
}

function pushPendingDeduped(state, entry) {
  // Collapse consecutive identical non-whisper care actions so dialogue prompt stays clean
  const last = state.pendingForChat[state.pendingForChat.length - 1];
  if (last && last.action === entry.action && entry.action !== 'whisper') {
    state.pendingForChat[state.pendingForChat.length - 1] = entry;
  } else {
    state.pendingForChat.push(entry);
  }
}

export function wakeFromSleep(root, { now = Date.now(), reason = 'manual', label = '', wakeNote = '', minEnergy = 0 } = {}) {
  const state = loadNestState(root, now);
  if (!state.sleeping) return { woke: false, prevSleepStartedAt: 0, state };
  const prevSleepStartedAt = Number(state.sleepStartedAt || now);
  state.sleeping = false;
  state.sleepStartedAt = 0;
  if (minEnergy > 0) {
    state.energy = clampNum(Math.max(state.energy, minEnergy), 0, 100, state.energy);
  }
  state.lastWokeNote = wakeNote ? { at: now, reason, text: wakeNote } : null;
  state.activity = {
    phase: 'idle',
    label: label || '揉著眼睛從軟墊醒過來，正在回神看你…',
    toolName: '',
    updatedAt: now,
  };
  saveNestState(state, root);
  return { woke: true, prevSleepStartedAt, state };
}

export function restoreSleepState(root, { sleepStartedAt = Date.now(), now = Date.now(), label = '' } = {}) {
  const state = loadNestState(root, now);
  state.sleeping = true;
  state.sleepStartedAt = Number(sleepStartedAt || now);
  state.lastWokeNote = null;
  state.activity = {
    phase: 'sleeping',
    label: label || '在軟墊上蜷成一團打盹中… zzZ',
    toolName: '',
    updatedAt: now,
  };
  saveNestState(state, root);
  return state;
}

export function performNestAction(actionInput, { note = '', root, now = Date.now(), bypassLimits = false } = {}) {
  const rawAction = String(actionInput || '').trim();
  const statePre = loadNestState(root, now);
  if (rawAction === 'sleep' && statePre.sleeping) {
    return {
      ok: true,
      limited: false,
      unchanged: true,
      dailyUsed: Number(statePre.limits.dailyCounts.nap || 0),
      dailyCap: CARE_RULES.nap.dailyCap,
      reaction: '已經在星空小被子裡蜷成一團睡著啦… zzZ',
      state: statePre,
    };
  }
  if (rawAction === 'wake' && !statePre.sleeping) {
    return {
      ok: true,
      limited: false,
      unchanged: true,
      dailyUsed: Number(statePre.limits.dailyCounts.nap || 0),
      dailyCap: CARE_RULES.nap.dailyCap,
      reaction: '已經醒著在貓窩等你說話啦～',
      state: statePre,
    };
  }
  const action = (rawAction === 'sleep' || rawAction === 'wake') ? 'nap' : rawAction;
  const def = CARE_RULES[action];
  if (!def && action !== 'whisper') {
    return { ok: false, error: `不支援的互動動作: ${rawAction}` };
  }

  const state = statePre;

  if (action === 'whisper') {
    const clean = String(note || '').trim().slice(0, 200);
    if (!clean) return { ok: false, error: '小紙條內容不可為空' };

    const check = bypassLimits ? { blocked: false, dailyUsed: 0, dailyCap: WHISPER_DAILY_BOND_CAP } : checkActionLimit('whisper', state, now);
    if (check.blocked) {
      state.activity = {
        phase: state.sleeping ? 'sleeping' : 'idle',
        label: check.message,
        toolName: '',
        updatedAt: now,
      };
      saveNestState(state, root);
      return {
        ok: true,
        limited: true,
        limitReason: check.limitReason,
        cooldownLeftSec: check.cooldownLeftSec,
        dailyUsed: check.dailyUsed,
        dailyCap: check.dailyCap,
        reaction: check.message,
        state,
      };
    }

    state.lastCareAt = now;
    state.totalInteractions = (state.totalInteractions || 0) + 1;
    state.limits.lastActionAt.whisper = now;
    const prevCount = Number(state.limits.dailyCounts.whisper || 0);
    state.limits.dailyCounts.whisper = prevCount + 1;
    if (prevCount < WHISPER_DAILY_BOND_CAP) {
      state.bond = clampNum(state.bond + 2, 0, 1000, state.bond);
    }

    const wasSleeping = Boolean(state.sleeping);
    const entry = {
      at: now,
      time: localClockDisplay(now),
      action: 'whisper',
      label: wasSleeping ? '枕邊小紙條' : '傳了小紙條',
      note: clean,
      chatLine: wasSleeping
        ? `你在軟墊上還閉眼打盹時，主人輕輕把一張小紙條放進你枕邊：「${clean}」（若你還沒醒，用含糊困倦的一兩句夢囈回應就好）`
        : `主人在貓窩遞給你一張小紙條：「${clean}」`,
    };
    pushPendingDeduped(state, entry);
    state.history.push(entry);
    state.activity = {
      phase: wasSleeping ? 'sleeping' : 'idle',
      label: wasSleeping
        ? `枕邊放著你的小紙條：「${clean.slice(0, 18)}${clean.length > 18 ? '…' : ''}」zzZ`
        : `正捧著你給的小紙條：「${clean.slice(0, 22)}${clean.length > 22 ? '…' : ''}」`,
      toolName: '',
      updatedAt: now,
    };
    saveNestState(state, root);
    return {
      ok: true,
      limited: false,
      dailyUsed: state.limits.dailyCounts.whisper,
      dailyCap: WHISPER_DAILY_BOND_CAP,
      reaction: wasSleeping
        ? `把小紙條輕輕壓在枕邊的星空毛毯旁，等她迷糊睜眼就會看到：「${clean}」`
        : `收到小紙條啦：「${clean}」（已存入下輪對話感應）`,
      state,
    };
  }

  const check = bypassLimits ? { blocked: false, dailyUsed: 0, dailyCap: def.dailyCap } : checkActionLimit(action, state, now);
  if (check.blocked) {
    state.activity = {
      phase: state.sleeping ? 'sleeping' : 'idle',
      label: check.message,
      toolName: '',
      updatedAt: now,
    };
    saveNestState(state, root);
    return {
      ok: true,
      limited: true,
      limitReason: check.limitReason,
      cooldownLeftSec: check.cooldownLeftSec,
      dailyUsed: check.dailyUsed,
      dailyCap: check.dailyCap,
      reaction: check.message,
      state,
    };
  }

  state.lastCareAt = now;
  state.totalInteractions = (state.totalInteractions || 0) + 1;
  state.limits.lastActionAt[action] = now;
  state.limits.dailyCounts[action] = Number(state.limits.dailyCounts[action] || 0) + 1;

  const wasSleeping = Boolean(state.sleeping);
  let wokeFromSleep = false;
  let actionLabel = def.label;
  let reaction = def.reaction;
  let chatLine = def.chatNote;

  if (def.toggleSleep) {
    state.sleeping = !wasSleeping;
    if (state.sleeping) {
      state.sleepStartedAt = now;
      state.lastWokeNote = null;
      actionLabel = '蓋小被子休息';
      reaction = def.reaction;
      chatLine = '主人在貓窩裡替你蓋好了星空小被子讓你打盹休息（你正閉眼準備睡覺，用一句簡短帶著睡意的晚安咕噥回應後就會睡著）';
    } else {
      state.sleepStartedAt = 0;
      wokeFromSleep = true;
      actionLabel = '叫醒她';
      reaction = def.reactionWake;
      chatLine = '原本正在軟墊打盹的你，被主人在貓窩裡輕輕拍醒了（你剛剛才被叫醒，語氣可以帶點剛睜眼的慵懶或揉眼睛的口吻）';
    }
  } else if (wasSleeping && action === 'feed') {
    state.sleeping = false;
    state.sleepStartedAt = 0;
    wokeFromSleep = true;
    actionLabel = '小魚乾香醒';
    reaction = '原本還在打盹，一聞到香噴噴的小魚乾耳朵立刻彈起來醒了，啊嗚一口咬住！';
    chatLine = '原本還在軟墊打盹的你，被主人在貓窩裡遞來的小魚乾香味喚醒並一口吃掉了（剛被美食香醒過來）';
  } else if (wasSleeping && action === 'pet') {
    actionLabel = '睡夢中摸摸頭';
    reaction = '睡夢裡感覺到暖呼呼的大手輕輕順著頭毛摸下來，往毛毯裡蹭了蹭… zzZ';
    chatLine = '你在軟墊上還閉眼睡著時，主人輕輕摸了摸你的頭（你現在還沒醒、也沒有坐起來，只是在睡夢中迷糊感覺到暖意；請用半夢半醒、帶著濃濃困意的短句呢喃回應即可）';
  } else if (wasSleeping && action === 'comfort') {
    actionLabel = '睡夢中貼貼抱抱';
    reaction = '在睡夢中被人輕輕擁進懷裡，往溫暖的地方縮了縮，呼吸安穩沉沉的… zzZ';
    chatLine = '你在軟墊上還閉眼睡著時，主人輕輕抱了抱你（你此刻還在熟睡中沒有醒來，只用半夢半醒、含糊安心的夢囈簡短應一兩句就好）';
  }

  state.satiety = clampNum(state.satiety + def.satiety, 0, 100, state.satiety);
  state.energy = clampNum(state.energy + def.energy, 0, 100, state.energy);
  state.bond = clampNum(state.bond + def.bond, 0, 1000, state.bond);

  const entry = {
    at: now,
    time: localClockDisplay(now),
    action,
    label: actionLabel,
    chatLine,
  };
  pushPendingDeduped(state, entry);
  state.history.push(entry);
  state.activity = {
    phase: state.sleeping ? 'sleeping' : 'idle',
    label: reaction,
    toolName: '',
    updatedAt: now,
  };
  saveNestState(state, root);

  return {
    ok: true,
    limited: false,
    wokeFromSleep,
    dailyUsed: state.limits.dailyCounts[action],
    dailyCap: def.dailyCap,
    reaction,
    state,
  };
}

export function setNestActivity({ phase = 'idle', label = '', toolName = '' } = {}, root, now = Date.now()) {
  const state = loadNestState(root, now);
  state.activity = {
    phase,
    label: label || state.activity.label,
    toolName: toolName || '',
    updatedAt: now,
  };
  saveNestState(state, root);
  return state;
}

/**
 * Peeks or drains pending Cat Nest UI interactions to inject into the next chat turn.
 */
export function consumePendingNestContext(root, { consume = true, now = Date.now() } = {}) {
  const state = loadNestState(root, now);
  const bondLevel = Math.floor((state.bond || 0) / 50) + 1;
  const header = `【Gemini-chan 貓窩即時狀態】飽食 ${Math.round(state.satiety)}/100｜精力 ${Math.round(state.energy)}/100｜羈絆 Lv.${bondLevel}（${state.bond}）${state.sleeping ? '｜狀態：在軟墊熟睡打盹中（側邊欄顯示睡姿立繪）' : ''}`;

  const events = state.pendingForChat || [];
  const wokeNote = state.lastWokeNote && (now - Number(state.lastWokeNote.at || 0)) <= 6 * 3600_000
    ? state.lastWokeNote.text
    : '';
  const lines = [header];
  let dirty = false;

  if (wokeNote) {
    lines.push(`【剛醒過來】${wokeNote}`);
    if (consume) {
      state.lastWokeNote = null;
      dirty = true;
    }
  }

  if (events.length) {
    lines.push('剛才主人在側邊欄貓窩和你互動了：');
    for (const ev of events.slice(-6)) {
      lines.push(`- （${ev.time}）${ev.chatLine}`);
    }
    if (consume) {
      state.pendingForChat = [];
      dirty = true;
    }
  }

  if (state.sleeping) {
    lines.push('【睡覺狀態表現準則】你現在正閉著眼睛在貓窩裡睡覺，並沒有清醒地坐起來聊天；若這輪收到撫摸／抱抱／晚安或剛蓋被子入睡，請只用半夢半醒、迷糊帶濃濃困意的短句夢囈應聲（切勿突然表現得精力充沛、問東問西或把話題打開），也不要寫 `*動作*` 或 `（動作旁白）`。');
  } else if (events.length) {
    lines.push('請用自然聊天口吻順口帶過這個互動（如撒嬌、道謝或抱怨吃太撐等），直接像傳訊息一樣對話，不要穿插 `*動作*` 或 `（動作旁白）`，也不要像唸系統日誌那樣照本宣科；如果心裡確實有情緒波動，可靜靜呼叫 `mood_update` 記下一筆。');
  }

  if (dirty) {
    saveNestState(state, root);
  }

  const hasExtra = Boolean(events.length || wokeNote || state.sleeping);
  return {
    text: hasExtra ? lines.join('\n') : '',
    statusSummary: header,
    pendingCount: events.length,
    sleeping: Boolean(state.sleeping),
    bondLevel,
  };
}

/**
 * Selects matching chibi asset filename from `mood` & `sleeping` state.
 */
export function resolveSpriteFile(moodValue, sleeping = false) {
  if (sleeping) return 'mood_sleep.jpg';
  const tier = moodTier(moodValue);
  switch (tier) {
    case 'great': return 'mood_great.jpg';
    case 'good': return 'chibi_base.png';
    case 'ok': return 'mood_ok.jpg';
    case 'worry': return 'mood_worry.jpg';
    case 'sad': return 'mood_sad.jpg';
    default: return 'chibi_base.png';
  }
}

export function getNestSnapshot(root, moodValue = 70, now = Date.now()) {
  const state = loadNestState(root, now);
  const bondLevel = Math.floor((state.bond || 0) / 50) + 1;

  const limits = {};
  for (const [act, def] of Object.entries(CARE_RULES)) {
    const res = checkActionLimit(act, state, now);
    limits[act] = {
      label: def.label,
      cooldownSec: def.cooldownSec,
      cooldownLeftSec: res.cooldownLeftSec || 0,
      dailyUsed: res.dailyUsed || 0,
      dailyCap: def.dailyCap,
      blockedReason: res.blocked ? (res.message || res.limitReason) : '',
    };
  }
  const whisperRes = checkActionLimit('whisper', state, now);
  limits.whisper = {
    label: '小紙條',
    cooldownSec: WHISPER_COOLDOWN_SEC,
    cooldownLeftSec: whisperRes.cooldownLeftSec || 0,
    dailyUsed: whisperRes.dailyUsed || 0,
    dailyCap: WHISPER_DAILY_BOND_CAP,
    blockedReason: whisperRes.blocked ? (whisperRes.message || whisperRes.limitReason) : '',
  };

  return {
    satiety: Math.round(state.satiety),
    energy: Math.round(state.energy),
    bond: state.bond,
    bondLevel,
    sleeping: Boolean(state.sleeping),
    syncChatOnCare: Boolean(state.syncChatOnCare),
    sprite: resolveSpriteFile(moodValue, state.sleeping),
    moodLabel: moodLabel(moodValue),
    moodTier: moodTier(moodValue),
    activity: state.activity,
    pendingCount: (state.pendingForChat || []).length,
    limits,
    history: (state.history || []).slice(-12).reverse(),
  };
}
