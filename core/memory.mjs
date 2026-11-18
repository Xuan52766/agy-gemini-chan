/**
 * @fileoverview Long-term Memory engine ported from `dsh-fish-memory`.
 *
 * Implements:
 * - Exponential forgetting curve (`鮮活度`) with importance-scaled half-life `H = baseHalfLifeDays * (1 + 2 * I)`
 * - Evidence calculation `C = s / (s + K)` using normalized IDF rarity + personal speech ruler (`說話尺`)
 * - Overall rank `P = C * (baselineWeight + activationWeight * A + importanceWeight * I + emotionWeight * E) * timeBoost`
 * - Adaptive recall cap `[>=0.6 -> maxItems, >=0.5 -> 4, >=0.4 -> 3, else 1]` + dedupe + char budget + near-miss fallback
 * - `remember` with daily quota, reinforcement (`A' = A + 0.2 * (1 - A)`), explicit supersession (`supersedes`),
 *   and `factKey` convergence blocking universal wildcard keys
 */

import { join } from 'node:path';
import { clampNum, getDataPaths, localDayKey, readJsonSafe, writeJsonAtomic } from './storage.mjs';
import {
  buildRarityTable,
  isSubstantiveClue,
  loadCommonWords,
  normalizeText,
  queryInformationScore,
  RECALL_DUPLICATE_THRESHOLD,
  recordSpeechSample,
  textSimilarity,
  tokenize,
  TRUE_DUPLICATE_THRESHOLD,
  wordRarity,
} from './tokenizer.mjs';

const DAY_MS = 86400000;
const TIME_BOOST = 1.3;

export const DEFAULT_MEMORY_POLICY = {
  enabled: true,
  baseHalfLifeDays: 30,
  emotionHalfLifeDays: 7,
  baselineWeight: 0.55,
  activationWeight: 0.25,
  importanceWeight: 0.15,
  emotionWeight: 0.05,
  threshold: 0.3,
  maxItems: 6,
  maxChars: 800,
  dailyQuota: 8,
  rarityK: 0.8,
  queryGate: 0.8,
  unknownActivation: 0.5,
  repeatWindow: 15,
  factCap: 1,
  ownerPronoun: 'ta',
  selfPronoun: '我',
};

const TIME_CUES = [
  { re: /今天|今日/, from: 0, to: 0 },
  { re: /昨天|昨日|昨晚/, from: 1, to: 1 },
  { re: /前天/, from: 2, to: 2 },
  { re: /這幾天|这几天|最近|前幾天|前几天|這一陣|这一阵|前陣子|前阵子/, from: 0, to: 7 },
  { re: /上週|上周|上星期/, from: 7, to: 14 },
];

const UNIVERSAL_KEY_TAILS = new Set([
  '內容', '内容', '相關', '相关', '其他', '其它', '的事', '記錄', '记录',
  '情況', '情况', '事項', '事项', '東西', '东西', '事情', '雜項', '杂项',
  '各種', '各种', '綜合', '综合',
]);

function storePath(root) {
  return join(getDataPaths(root).memoryDir, 'store.json');
}

function fitWeights(p) {
  const act = clampNum(p.activationWeight, 0, 1, DEFAULT_MEMORY_POLICY.activationWeight);
  const imp = clampNum(p.importanceWeight, 0, 1, DEFAULT_MEMORY_POLICY.importanceWeight);
  const emo = clampNum(p.emotionWeight, 0, 1, DEFAULT_MEMORY_POLICY.emotionWeight);
  const base = Number((1 - act - imp - emo).toFixed(4));
  if (base >= 0.3) return { baselineWeight: base, activationWeight: act, importanceWeight: imp, emotionWeight: emo };
  const total = DEFAULT_MEMORY_POLICY.baselineWeight + act + imp + emo;
  return {
    baselineWeight: Number((DEFAULT_MEMORY_POLICY.baselineWeight / total).toFixed(4)),
    activationWeight: Number((act / total).toFixed(4)),
    importanceWeight: Number((imp / total).toFixed(4)),
    emotionWeight: Number((emo / total).toFixed(4)),
  };
}

export function normalizePolicy(raw) {
  const m = { ...DEFAULT_MEMORY_POLICY, ...(raw && typeof raw === 'object' ? raw : {}) };
  const weights = fitWeights(m);
  return {
    enabled: m.enabled !== false,
    baseHalfLifeDays: clampNum(m.baseHalfLifeDays, 3, 365, DEFAULT_MEMORY_POLICY.baseHalfLifeDays),
    emotionHalfLifeDays: clampNum(m.emotionHalfLifeDays, 1, 90, DEFAULT_MEMORY_POLICY.emotionHalfLifeDays),
    ...weights,
    threshold: clampNum(m.threshold, 0.05, 0.95, DEFAULT_MEMORY_POLICY.threshold),
    maxItems: Math.round(clampNum(m.maxItems, 1, 12, DEFAULT_MEMORY_POLICY.maxItems)),
    maxChars: Math.round(clampNum(m.maxChars, 150, 4000, DEFAULT_MEMORY_POLICY.maxChars)),
    dailyQuota: Math.round(clampNum(m.dailyQuota, 1, 100, DEFAULT_MEMORY_POLICY.dailyQuota)),
    rarityK: clampNum(m.rarityK, 0.1, 5, DEFAULT_MEMORY_POLICY.rarityK),
    queryGate: clampNum(m.queryGate, 0, 3, DEFAULT_MEMORY_POLICY.queryGate),
    unknownActivation: clampNum(m.unknownActivation, 0, 1, DEFAULT_MEMORY_POLICY.unknownActivation),
    repeatWindow: Math.round(clampNum(m.repeatWindow, 0, 40, DEFAULT_MEMORY_POLICY.repeatWindow)),
    factCap: Math.round(clampNum(m.factCap, 0, 5, DEFAULT_MEMORY_POLICY.factCap)),
    ownerPronoun: String(m.ownerPronoun || DEFAULT_MEMORY_POLICY.ownerPronoun).trim().slice(0, 12) || 'ta',
    selfPronoun: String(m.selfPronoun || DEFAULT_MEMORY_POLICY.selfPronoun).trim().slice(0, 12) || '我',
  };
}

export function loadMemoryStore(root) {
  const p = storePath(root);
  const raw = readJsonSafe(p, null);
  if (!raw || typeof raw !== 'object') {
    const init = {
      version: 1,
      policy: normalizePolicy({}),
      memories: [],
      ruler: { n: 0, df: {} },
      turnSeq: 0,
      recentInjected: {},
      traces: [],
    };
    writeJsonAtomic(p, init);
    return init;
  }
  return {
    version: 1,
    policy: normalizePolicy(raw.policy),
    memories: Array.isArray(raw.memories) ? raw.memories : [],
    ruler: raw.ruler && typeof raw.ruler === 'object' ? raw.ruler : { n: 0, df: {} },
    turnSeq: Math.max(0, Math.round(Number(raw.turnSeq) || 0)),
    recentInjected: raw.recentInjected && typeof raw.recentInjected === 'object' ? { ...raw.recentInjected } : {},
    traces: Array.isArray(raw.traces) ? raw.traces.slice(-20) : [],
  };
}

export function saveMemoryStore(store, root) {
  const clean = {
    version: 1,
    policy: normalizePolicy(store.policy),
    memories: Array.isArray(store.memories) ? store.memories : [],
    ruler: store.ruler || { n: 0, df: {} },
    turnSeq: Math.max(0, Math.round(Number(store.turnSeq) || 0)),
    recentInjected: store.recentInjected && typeof store.recentInjected === 'object' ? store.recentInjected : {},
    traces: Array.isArray(store.traces) ? store.traces.slice(-20) : [],
  };
  writeJsonAtomic(storePath(root), clean);
  return clean;
}

export function normalizeFactKey(k) {
  let s = String(k == null ? '' : k).trim();
  if (!s) return '';
  s = s.replace(/[．。｡：:｜|]/g, '.').replace(/\s+/g, '').toLowerCase();
  s = s.replace(/^[`'"「『\[(（]+/, '').replace(/[`'"」』\])）]+$/, '');
  s = s.replace(/[/／>＞-]{1}(?=[^.]*$)/, '.');
  if (s.length > 24) s = s.slice(0, 24);
  return s;
}

export function isUniversalKey(k) {
  const norm = normalizeFactKey(k);
  if (!norm) return false;
  const segs = norm.split('.');
  if (segs.length < 2) return false;
  return UNIVERSAL_KEY_TAILS.has(segs[segs.length - 1]);
}

function markSuperseded(mem, replacedById, reason, nowIso) {
  if (!mem || mem.superseded) return false;
  mem.superseded = {
    by: String(replacedById || ''),
    reason: String(reason || ''),
    at: nowIso,
  };
  return true;
}

function convergeByFactKey(data, triggerId, nowIso) {
  const groups = new Map();
  for (const m of data.memories || []) {
    if (!m || m.superseded) continue;
    const fk = normalizeFactKey(m.factKey);
    if (!fk || isUniversalKey(fk)) continue;
    if (!groups.has(fk)) groups.set(fk, []);
    groups.get(fk).push(m);
  }
  const archived = [];
  for (const [fk, list] of groups) {
    if (list.length < 2) continue;
    const tsOf = (m) => {
      const a = m.at ? Date.parse(m.at) : NaN;
      if (Number.isFinite(a)) return a;
      const c = m.createdAt ? Date.parse(m.createdAt) : NaN;
      return Number.isFinite(c) ? c : -Infinity;
    };
    list.sort((a, b) => tsOf(b) - tsOf(a));
    const latestTs = tsOf(list[0]);
    for (let i = 1; i < list.length; i++) {
      const curTs = tsOf(list[i]);
      if (curTs === latestTs || curTs === -Infinity) continue;
      if (markSuperseded(list[i], triggerId || String(list[0].id), `同「${fk}」只保留最新一筆`, nowIso)) {
        archived.push(String(list[i].id));
      }
    }
  }
  return archived;
}

/**
 * Exact `dsh-fish-memory` freshness calculation (`鮮活度`).
 */
export function computeFreshness(mem, policy = DEFAULT_MEMORY_POLICY, now = Date.now()) {
  const I = typeof mem.importance === 'number' ? clampNum(mem.importance, 0, 1, 0) : 0;
  const H = (policy.baseHalfLifeDays || 30) * (1 + 2 * I);
  const constant = clampNum(policy.unknownActivation, 0, 1, 0.5);
  if (mem.category === 'stable_profile') return constant;

  const anchor = mem.activationAnchor || mem.at || mem.createdAt || mem.importAt || null;
  const anchorMs = anchor ? Date.parse(anchor) : NaN;
  if (!Number.isFinite(anchorMs)) return constant;

  const daysA = Math.max(0, (now - anchorMs) / DAY_MS);
  const A0 = typeof mem.activation0 === 'number' && Number.isFinite(mem.activation0)
    ? clampNum(mem.activation0, 0, 1, 1)
    : 1;
  return A0 * Math.pow(2, -daysA / H);
}

function relativeTimeLabel(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return '';
  const diffDays = Math.floor((now - ts) / DAY_MS);
  if (diffDays <= 0) {
    const mins = Math.max(1, Math.round((now - ts) / 60000));
    if (mins < 60) return `${mins} 分鐘前`;
    return `${Math.round(mins / 60)} 小時前`;
  }
  if (diffDays === 1) return '昨天';
  if (diffDays === 2) return '前天';
  if (diffDays < 30) return `${diffDays} 天前`;
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Evaluates a single memory entry against query terms using IDF evidence `C` and weighted rank `P`.
 */
export function evaluateMemory(mem, query, queryKeys, df, ruler, policy, now = Date.now(), root) {
  const I = typeof mem.importance === 'number' ? clampNum(mem.importance, 0, 1, 0) : 0;
  const atMs = mem.at ? Date.parse(mem.at) : NaN;
  const days = Number.isFinite(atMs) ? Math.max(0, (now - atMs) / DAY_MS) : 0;

  const relWords = [
    ...(Array.isArray(mem.related) ? mem.related : []),
    ...(Array.isArray(mem.keywords) ? mem.keywords : []),
  ];
  const relatedSet = relWords.length
    ? tokenize(relWords.join(' '), root)
    : null;
  const surfaceText = normalizeText(`${mem.text || ''} ${(mem.tags || []).join(' ')} ${relWords.join(' ')}`);
  const memTokens = tokenize(surfaceText, root);

  const speechRarity = (k) => {
    const n = Number(ruler?.n || 0);
    if (n < 20) return 1;
    const top = Math.log(n + 1);
    if (!(top > 0)) return 1;
    const v = Math.log((n + 1) / ((Number(ruler?.df?.[k]) || 0) + 1)) / top;
    return clampNum(v, 0, 1, 1);
  };

  let s = 0;
  let hitN = 0;
  let hitLen = 0;
  for (const k of queryKeys) {
    if (!memTokens.has(k)) continue;
    hitN += 1;
    hitLen += String(k).length;
    const weight = !relatedSet ? 1 : (relatedSet.has(k) ? 1 : 0.7);
    s += wordRarity(df, k) * speechRarity(k) * weight;
  }

  const K = policy.rarityK > 0 ? policy.rarityK : 0.8;
  let C = s / (s + K);
  const normQuery = normalizeText(query);
  if (normQuery.length >= 6 && queryKeys.length > 0 && surfaceText.includes(normQuery)) {
    C = Math.max(C, 0.85);
  }

  const A = computeFreshness(mem, policy, now);
  const E = mem.emotion == null ? 0 : clampNum(mem.emotion, 0, 1, 0) * Math.pow(2, -days / (policy.emotionHalfLifeDays || 7));
  let P = C * (
    policy.baselineWeight +
    policy.activationWeight * A +
    policy.importanceWeight * I +
    policy.emotionWeight * E
  );

  let timeHit = false;
  for (const cue of TIME_CUES) {
    if (cue.re.test(query) && Number.isFinite(atMs)) {
      const md = Math.floor((now - atMs) / DAY_MS);
      if (md >= cue.from && md <= cue.to) {
        timeHit = true;
        P *= TIME_BOOST;
        break;
      }
    }
  }

  return { C, A, E, I, P, s, hitN, hitLen, timeHit };
}

function compareRecallRank(a, b) {
  const dc = Math.round(((b?.s?.C || 0) - (a?.s?.C || 0)) * 1000);
  if (dc === 0) {
    const dn = (b?.s?.hitN || 0) - (a?.s?.hitN || 0);
    if (dn !== 0) return dn;
    const dl = (b?.s?.hitLen || 0) - (a?.s?.hitLen || 0);
    if (dl !== 0) return dl;
  }
  return (b?.s?.P || 0) - (a?.s?.P || 0);
}

/**
 * Recalls relevant active memories for a query without mutating reinforcement/activation.
 * Appends query to user speech ruler when `recordSample` is true.
 */
export function recallMemories(query, { root, now = Date.now(), recordSample = false, saveTrace = false } = {}) {
  const data = loadMemoryStore(root);
  const policy = data.policy;
  if (!policy.enabled) {
    return { selected: [], rendered: '', gate: { blocked: false, reason: 'disabled' }, policy };
  }

  const active = (data.memories || []).filter((m) => m && !m.superseded);
  const df = buildRarityTable(active, root);

  if (recordSample && query) {
    data.ruler = recordSpeechSample(data.ruler, query, root);
    data.turnSeq = (Number(data.turnSeq) || 0) + 1;
  }

  const infoScore = queryInformationScore(data.ruler, query, df, root);
  if (policy.queryGate > 0 && infoScore < policy.queryGate) {
    const out = {
      selected: [],
      scored: [],
      rendered: '',
      gate: { blocked: true, infoScore, threshold: policy.queryGate },
      policy,
    };
    if (recordSample || saveTrace) {
      if (saveTrace) {
        data.traces.push({ at: now, query: String(query || '').slice(0, 80), gateBlocked: true, infoScore, rows: [] });
      }
      saveMemoryStore(data, root);
    }
    return out;
  }

  // Three-level fallback clue filter matching dsh-fish-memory v1.5.9 + v1.6.0:
  // Single-character tokens never count as clue evidence unless the entire query is single-char tokens.
  const qRaw = [...tokenize(query, root)];
  const qMulti = qRaw.filter((k) => String(k).length > 1);
  const qAll = qMulti.length ? qMulti : qRaw;
  const qRare = qAll.filter((k) => {
    if (!(df.totalCount > 1)) return Boolean(df.get(k));
    return wordRarity(df, k) > 0.12;
  });
  const qSubstantive = qRare.filter((k) => isSubstantiveClue(k, root));
  const useSubstantive = qSubstantive.length >= 2 && qSubstantive.some((k) => wordRarity(df, k) > 0);
  const qNonCommon = qAll.filter((k) => isSubstantiveClue(k, root));
  const qFinal = useSubstantive ? qSubstantive : (qNonCommon.length ? qNonCommon : qAll);

  // dsh-fish-memory v1.6.3: strict raw-query gate for `stable_profile` long-term facts
  const commonMap = loadCommonWords(root);
  const rawMulti = qMulti;
  const rawRare = rawMulti.filter((k) => {
    const isRareInBank = !(df.totalCount > 1) ? Boolean(df.get(k)) : wordRarity(df, k) > 0.12;
    return isRareInBank && isSubstantiveClue(k, root);
  });
  const passesFactGate = (mem) => {
    if (!mem || mem.category !== 'stable_profile') return true;
    if (!rawMulti.length) return true;
    const relWords = [
      ...(Array.isArray(mem.related) ? mem.related : []),
      ...(Array.isArray(mem.keywords) ? mem.keywords : []),
    ];
    const memSet = tokenize(`${mem.text || ''} ${(mem.tags || []).join(' ')} ${relWords.join(' ')}`, root);
    const hits = rawMulti.filter((k) => memSet.has(k));
    const rareHits = rawRare.filter((k) => memSet.has(k));
    if (rawMulti.length === 1) {
      return rareHits.length >= 1;
    }
    const singleProperNoun = hits.length === 1 && !commonMap.has(hits[0]) && (df.get(hits[0]) || 0) <= 1;
    return rareHits.length >= 1 && (hits.length >= 2 || singleProperNoun);
  };

  const scored = active.map((m) => ({
    m,
    s: evaluateMemory(m, query, qFinal, df, data.ruler, policy, now, root),
    omission: '',
    nearMiss: false,
  }));

  let picked = [];
  for (const row of scored) {
    if (row.s.C <= 0) row.omission = 'hard_gate';
    else if (row.s.C < policy.threshold) row.omission = 'below_threshold';
    else if (!passesFactGate(row.m)) row.omission = 'fact_unmatched';
    else picked.push(row);
  }
  picked.sort(compareRecallRank);

  // Near-miss safety rescue (`>= 75%` of threshold if nothing reached threshold)
  if (!picked.length) {
    let best = null;
    for (const row of scored) {
      if (row.omission !== 'below_threshold') continue;
      if (row.s.C < policy.threshold * 0.75) continue;
      if (!best || row.s.P > best.s.P) best = row;
    }
    if (best) {
      best.omission = '';
      best.nearMiss = true;
      picked.push(best);
    }
  }

  // dsh-fish-memory v1.6.3: repeatWindow suppression (skip memories injected within the last N user turns)
  const repeatWin = Math.max(0, Number.isFinite(policy.repeatWindow) ? policy.repeatWindow : 15);
  const currentTurn = Number(data.turnSeq || 0);
  if (recordSample && repeatWin > 0 && currentTurn > 0 && data.recentInjected) {
    const nonRepeated = [];
    for (const row of picked) {
      const lastTurn = Number(data.recentInjected[String(row.m.id)]);
      if (Number.isFinite(lastTurn) && lastTurn > 0 && (currentTurn - lastTurn) < repeatWin) {
        row.omission = 'repeat';
        continue;
      }
      nonRepeated.push(row);
    }
    picked = nonRepeated;
  }

  // Dedupe at >= 0.80 similarity
  const tokenizedPicked = picked.map((row) => ({ row, tokens: tokenize(row.m.text, root) }));
  const deduped = [];
  for (const item of tokenizedPicked) {
    const dup = deduped.some((kept) => textSimilarity(item.tokens, kept.tokens) >= RECALL_DUPLICATE_THRESHOLD);
    if (dup) {
      item.row.omission = 'duplicate';
      continue;
    }
    deduped.push(item);
  }

  // dsh-fish-memory v1.6.3: separate slot allocation for event vs `stable_profile` (`factCap`)
  const allRows = deduped.map((x) => x.row);
  const factRows = allRows.filter((r) => r.m && r.m.category === 'stable_profile');
  const eventRows = allRows.filter((r) => !(r.m && r.m.category === 'stable_profile'));
  const topEventC = eventRows.length ? eventRows[0].s.C : 0;
  const tierCaps = [
    [0.6, policy.maxItems],
    [0.5, 4],
    [0.4, 3],
    [0, 1],
  ];
  const eventDynamicCap = eventRows.length ? tierCaps.find(([floor]) => topEventC >= floor)[1] : 0;
  const eventCap = Math.min(eventDynamicCap, policy.maxItems);
  const eventsPickedCount = Math.min(eventRows.length, eventCap);
  const factLimit = Math.max(0, Number.isFinite(policy.factCap) ? policy.factCap : 1);
  const factSlotCap = (factRows.length && factLimit > 0 && eventsPickedCount < policy.maxItems)
    ? Math.min(factLimit, policy.maxItems - eventsPickedCount)
    : 0;

  const withinSlot = eventRows.slice(0, eventCap).concat(factSlotCap ? factRows.slice(0, factSlotCap) : []);
  for (const row of eventRows.slice(eventCap)) {
    if (!row.omission) row.omission = 'weak';
  }
  for (const row of factRows.slice(factSlotCap)) {
    if (!row.omission) row.omission = 'fact_cap';
  }

  const selected = [];
  let chars = 0;
  for (const row of withinSlot) {
    const len = String(row.m.text || '').length;
    if (!selected.length || chars + len <= policy.maxChars) {
      selected.push(row);
      chars += len;
    } else {
      row.omission = 'budget';
    }
  }

  if (recordSample && repeatWin > 0 && currentTurn > 0 && selected.length) {
    if (!data.recentInjected || typeof data.recentInjected !== 'object') data.recentInjected = {};
    for (const r of selected) {
      data.recentInjected[String(r.m.id)] = currentTurn;
    }
  }

  const rendered = selected.length ? formatRecalledBlock(selected, now) : '';
  const sortedAll = scored.slice().sort((a, b) => b.s.P - a.s.P || b.s.C - a.s.C);

  if (recordSample || saveTrace) {
    if (saveTrace) {
      data.traces.push({
        at: now,
        query: String(query || '').slice(0, 80),
        gateBlocked: false,
        infoScore: Number.isFinite(infoScore) ? Number(infoScore.toFixed(2)) : 'inf',
        selectedIds: selected.map((x) => x.m.id),
        rows: sortedAll.slice(0, 12).map((r) => ({
          id: r.m.id,
          text: String(r.m.text || '').slice(0, 60),
          C: Number(r.s.C.toFixed(3)),
          A: Number(r.s.A.toFixed(3)),
          P: Number(r.s.P.toFixed(3)),
          omission: r.omission || (r.nearMiss ? 'near_miss' : 'selected'),
        })),
      });
    }
    saveMemoryStore(data, root);
  }

  return {
    selected,
    scored: sortedAll,
    rendered,
    chars,
    gate: { blocked: false, infoScore },
    policy,
  };
}

export function formatRecalledBlock(selected, now = Date.now()) {
  if (!selected.length) return '';
  const lines = selected.map((r) => {
    const body = String(r.m.text || '').trim();
    if (r.m.at) return `- ${relativeTimeLabel(Date.parse(r.m.at), now)}：${body}`;
    if (r.m.category === 'stable_profile') return `- 一直：${body}`;
    return `- ${body}`;
  });
  return [
    '【你記得的事（長期記憶）】',
    '以下是你們過去真實記下來的事；有標時間的照那個時間說，沒標時間的不要自己編日期；想不起來就直接說想不起來。',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Builds the in-conversation `remember` prompt matching DSH `dsh-fish-memory` (`memory-hint`),
 * wiring configured `ownerPronoun` / `selfPronoun` and today's remaining quota cleanly.
 */
export function buildInChatMemoryRule(root, { now = Date.now(), ownerName = '', selfName = '' } = {}) {
  const data = loadMemoryStore(root);
  const policy = data.policy;
  if (!policy.enabled) return '';

  const today = localDayKey(now);
  const todayCount = (data.memories || []).filter(
    (m) => m.createdAt && localDayKey(Date.parse(m.createdAt)) === today,
  ).length;
  if (todayCount >= policy.dailyQuota) return '';

  const ownerText = String(ownerName || '').trim();
  const ownerPronoun = policy.ownerPronoun || 'ta';
  const ownerCall = ownerText && ownerText !== '主人'
    ? `${ownerText}（寫入第三人稱代稱「${ownerPronoun}」）`
    : `對方／主人（寫入請以「${ownerPronoun}」指代）`;
  const me = policy.selfPronoun || '我';
  const selfText = String(selfName || '').trim();
  const left = Math.max(0, policy.dailyQuota - todayCount);

  return [
    `【對話內長期記憶提醒（今日剩餘額度 ${left}/${policy.dailyQuota}）】這一輪如果出現值得長期記住的事（${ownerText || '對方'}的喜好／禁忌／作息、明確約定、身體狀態或重要里程碑），請直接安靜呼叫 \`remember\` 記下來——**不用等對方特地提醒**，也不要在回覆裡說「我記住了」。日常純寒暄與一次性流水瑣事不用記。`,
    `寫法規範：一條一件事；自稱用「${me}」，${ownerCall}${selfText ? `（寫入時避免用第三人稱「${selfText}」自稱）` : ''}；不要寫「今天／昨天」（時間交給系統）；若屬狀態更新（如作息、住處、計畫變更），請加填 \`factKey\`（如「${ownerPronoun}.作息」）或 \`supersedes\`。`,
  ].join('\n');
}

/**
 * Remembers one memory item (`remember` tool handler + UI add handler).
 * Handles daily quota, exact/near-text reinforcement `A' = A + 0.2*(1-A)`,
 * `supersedes`, and normalized `factKey` convergence.
 */
export function rememberMemory(input, { root, now = Date.now(), bypassQuota = false } = {}) {
  const data = loadMemoryStore(root);
  const policy = data.policy;
  if (!policy.enabled) {
    return { ok: false, message: '記憶功能目前是關閉狀態，請先在側邊欄開啟。' };
  }

  const text = String(input?.text || '').trim();
  if (!text) return { ok: false, message: '記憶內容不能為空' };

  if (!bypassQuota) {
    const today = localDayKey(now);
    const todayCount = (data.memories || []).filter(
      (m) => m.createdAt && localDayKey(Date.parse(m.createdAt)) === today,
    ).length;
    if (todayCount >= policy.dailyQuota) {
      return { ok: false, message: `今天已達每日記憶上限（${policy.dailyQuota} 條），明天再記吧。` };
    }
  }

  const stripPunct = (s) => String(s || '').replace(/[\s，。、！？,.!?;；]/g, '');
  const nt = stripPunct(text);
  const nowIso = new Date(now).toISOString();

  // Check duplicate -> reinforce instead of creating duplicate
  for (const m of data.memories) {
    if (m.superseded) continue;
    const mt = stripPunct(m.text);
    if (mt && (mt === nt || (mt.length > 8 && nt.length > 8 && (mt.includes(nt) || nt.includes(mt))))) {
      const prevA = computeFreshness(m, policy, now);
      const nextA = prevA + 0.2 * (1 - prevA);
      m.activation0 = clampNum(nextA, 0, 1, 1);
      m.activationAnchor = nowIso;
      m.reinforcedAt = nowIso;
      m.reinforceCount = (Number(m.reinforceCount) || 0) + 1;
      saveMemoryStore(data, root);
      return {
        ok: true,
        reinforced: true,
        memory: m,
        message: `這條已經記過了，已幫你記牢一點（強化第 ${m.reinforceCount} 次，鮮活度 ${prevA.toFixed(2)} → ${m.activation0.toFixed(2)}）。`,
      };
    }
  }

  const newId = `m${now.toString(36)}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`;
  const importance = typeof input?.importance === 'number' ? clampNum(input.importance, 0, 1, 0.5) : 0.5;
  const tags = Array.isArray(input?.tags)
    ? input.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 8)
    : [];
  const rawKey = input?.factKey ?? input?.事實鍵 ?? input?.事实键 ?? '';
  const fkNorm = normalizeFactKey(rawKey);
  const finalFactKey = fkNorm && !isUniversalKey(fkNorm) ? fkNorm : '';
  const newTokens = tokenize(text, root);
  const supersededIds = [];

  // Auto-supersede very close wording (`>= 0.85` & similar length)
  for (const m of data.memories) {
    if (m.superseded) continue;
    const sim = textSimilarity(newTokens, tokenize(m.text, root));
    if (sim < TRUE_DUPLICATE_THRESHOLD) continue;
    const maxLen = Math.max(text.length, String(m.text || '').length);
    const minLen = Math.min(text.length, String(m.text || '').length);
    if (maxLen > 0 && minLen / maxLen >= 0.8) {
      if (markSuperseded(m, newId, '跟新記的這條幾乎一樣', nowIso)) supersededIds.push(m.id);
    }
  }

  // Explicit `supersedes` / `取代` matching
  const targetRef = String(input?.supersedes ?? input?.取代 ?? '').trim();
  if (targetRef) {
    const cleanRef = stripPunct(targetRef);
    const refTokens = tokenize(targetRef, root);
    let best = null;
    let bestSim = 0;
    for (const m of data.memories) {
      if (m.superseded) continue;
      if (String(m.id) === targetRef) {
        best = m;
        bestSim = 1;
        break;
      }
      const mt = stripPunct(m.text);
      if (mt && cleanRef && (mt === cleanRef || (mt.length > 6 && cleanRef.length > 6 && (mt.includes(cleanRef) || cleanRef.includes(mt))))) {
        best = m;
        bestSim = 1;
        break;
      }
      const sim = textSimilarity(refTokens, tokenize(m.text, root));
      if (sim > bestSim) {
        bestSim = sim;
        best = m;
      }
    }
    if (best && bestSim >= 0.5 && markSuperseded(best, newId, '新記的這條標明取代了它', nowIso)) {
      supersededIds.push(best.id);
    }
  }

  const item = {
    id: newId,
    text,
    importance,
    tags,
    related: Array.isArray(input?.related) ? input.related.slice(0, 8) : [],
    keywords: Array.isArray(input?.keywords)
      ? input.keywords.map((x) => String(x).trim()).filter(Boolean).slice(0, 20)
      : [],
    factKey: finalFactKey,
    category: (input?.category === 'stable_profile' || importance >= 0.99) ? 'stable_profile' : 'event',
    at: input?.at || nowIso,
    createdAt: nowIso,
    activation0: 1,
    activationAnchor: nowIso,
    emotion: typeof input?.emotion === 'number' ? clampNum(input.emotion, 0, 1, 0) : null,
    reinforceCount: 0,
  };

  data.memories.push(item);
  if (finalFactKey) {
    supersededIds.push(...convergeByFactKey(data, newId, nowIso));
  }
  saveMemoryStore(data, root);

  return {
    ok: true,
    reinforced: false,
    memory: item,
    supersededIds,
    message: '✓',
  };
}

export function mutateMemory(action, payload = {}, root) {
  const data = loadMemoryStore(root);
  const now = Date.now();
  switch (action) {
    case 'updatePolicy': {
      data.policy = normalizePolicy({ ...data.policy, ...(payload.policy || {}) });
      saveMemoryStore(data, root);
      return { ok: true, policy: data.policy };
    }
    case 'resetPolicy': {
      data.policy = normalizePolicy(DEFAULT_MEMORY_POLICY);
      saveMemoryStore(data, root);
      return { ok: true, policy: data.policy };
    }
    case 'update':
    case 'edit': {
      const m = data.memories.find((x) => String(x.id) === String(payload.id || ''));
      if (!m) return { ok: false, error: '找不到該記憶條目' };
      const nextText = payload.text !== undefined ? String(payload.text).trim() : m.text;
      if (!nextText) return { ok: false, error: '記憶內容不可為空' };
      m.text = nextText;
      if (payload.importance !== undefined) {
        m.importance = clampNum(Number(payload.importance), 0, 1, m.importance ?? 0.5);
      }
      if (payload.factKey !== undefined) {
        const fk = normalizeFactKey(payload.factKey);
        m.factKey = fk && !isUniversalKey(fk) ? fk : '';
      }
      if (payload.category === 'stable_profile' || payload.category === 'event') {
        m.category = payload.category;
      }
      if (payload.related !== undefined || payload.keywords !== undefined) {
        const rawKw = payload.related !== undefined ? payload.related : payload.keywords;
        m.related = Array.isArray(rawKw)
          ? rawKw.map((w) => String(w).trim()).filter(Boolean).slice(0, 12)
          : String(rawKw || '')
              .replace(/[，,、。；;]/g, ' ')
              .split(/\s+/)
              .map((w) => w.trim())
              .filter(Boolean)
              .slice(0, 12);
      }
      m.updatedAt = new Date(now).toISOString();
      saveMemoryStore(data, root);
      return { ok: true, memory: m };
    }
    case 'delete': {
      const id = String(payload.id || '');
      const before = data.memories.length;
      data.memories = data.memories.filter((m) => String(m.id) !== id);
      if (data.memories.length === before) return { ok: false, error: '找不到該記憶條目' };
      saveMemoryStore(data, root);
      return { ok: true };
    }
    case 'restore': {
      const m = data.memories.find((x) => String(x.id) === String(payload.id || ''));
      if (!m) return { ok: false, error: '找不到該記憶條目' };
      delete m.superseded;
      m.activationAnchor = new Date(now).toISOString();
      saveMemoryStore(data, root);
      return { ok: true, memory: m };
    }
    case 'supersede': {
      const m = data.memories.find((x) => String(x.id) === String(payload.id || ''));
      if (!m) return { ok: false, error: '找不到該記憶條目' };
      markSuperseded(m, 'manual', payload.reason || '手動收起（已被取代）', new Date(now).toISOString());
      saveMemoryStore(data, root);
      return { ok: true, memory: m };
    }
    case 'reinforce': {
      const m = data.memories.find((x) => String(x.id) === String(payload.id || ''));
      if (!m) return { ok: false, error: '找不到該記憶條目' };
      const curA = computeFreshness(m, data.policy, now);
      m.activation0 = clampNum(curA + 0.2 * (1 - curA), 0, 1, 1);
      m.activationAnchor = new Date(now).toISOString();
      m.reinforceCount = (Number(m.reinforceCount) || 0) + 1;
      saveMemoryStore(data, root);
      return { ok: true, memory: m };
    }
    default:
      return { ok: false, error: `未知操作: ${action}` };
  }
}

export function batchRememberMemories(items = [], { root, now = Date.now(), bypassQuota = true } = {}) {
  const list = Array.isArray(items) ? items.slice(0, 60) : [];
  let added = 0;
  let reinforced = 0;
  let skipped = 0;
  for (let i = 0; i < list.length; i++) {
    const raw = typeof list[i] === 'string' ? { text: list[i] } : list[i];
    if (!raw || !String(raw.text || '').trim()) {
      skipped++;
      continue;
    }
    const res = rememberMemory(raw, { root, now: now + i, bypassQuota });
    if (res?.ok && res.reinforced) reinforced++;
    else if (res?.ok) added++;
    else skipped++;
  }
  return { ok: true, added, reinforced, skipped };
}

export function getMemorySnapshot(root, now = Date.now()) {
  const data = loadMemoryStore(root);
  const policy = data.policy;
  const active = [];
  const archived = [];
  for (const m of data.memories || []) {
    const view = {
      ...m,
      freshness: Number(computeFreshness(m, policy, now).toFixed(3)),
    };
    if (m.superseded) archived.push(view);
    else active.push(view);
  }
  active.sort((a, b) => Date.parse(b.createdAt || b.at || 0) - Date.parse(a.createdAt || a.at || 0));
  return {
    policy,
    activeCount: active.length,
    archivedCount: archived.length,
    active: active.slice(0, 120),
    archived: archived.slice(0, 60),
    rulerSamples: Number(data.ruler?.n || 0),
    lastTrace: data.traces.length ? data.traces[data.traces.length - 1] : null,
    traces: (data.traces || []).slice(-10).reverse(),
  };
}
