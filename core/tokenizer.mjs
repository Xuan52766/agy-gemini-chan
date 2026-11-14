/**
 * @fileoverview Chinese dictionary FMM tokenizer, EN/ZH stop-word filter,
 * adaptive per-session speech ruler (說話尺), and IDF rarity / similarity scorer
 * ported from `dsh-fish-memory`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDataPaths } from './storage.mjs';

const EN_STOPS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was',
  'one', 'our', 'out', 'has', 'his', 'how', 'man', 'new', 'now', 'old', 'see',
  'two', 'way', 'who', 'did', 'its', 'let', 'put', 'say', 'she', 'too', 'use',
  'that', 'with', 'have', 'this', 'will', 'your', 'from', 'they', 'know', 'want',
  'been', 'good', 'much', 'some', 'time', 'very', 'when', 'come', 'here', 'just',
  'like', 'long', 'make', 'many', 'over', 'such', 'take', 'than', 'them', 'well',
  'were', 'what',
]);

// Single-character function words filtered out when falling back to characters
const SINGLE_STOP_CHARS = new Set([
  ...'的了在是我有和就都不人一上個中大為來以到說時要就出會可也你對生能而子那得於著下自之年過發後作裡用道行所然家種事成方多經麼去法學如都同現當沒動面起看定天分還進好小部其些主樣理心她本前開但因只從想實日軍者意無力它與長把機十民第公此已工使情明性知全三又關點正業外將兩高間由問很最重並物手應戰向頭文體政美相見被利什二等產或新己制身果加西斯月話合回特代內信表化老給世位次度門任常先海通教兒原東聲提立及比員解水名真論處走義各入幾口認條平系氣題活爾更別打女變四神總何電數安少報才結反受目太量再感建務做接必場件計管期市直德資命山金指克許統區保至隊形社便空決治展馬科司五基眼書非則聽白卻界達光放強即像難且權思王象完設式色路記南品住告類求據程北邊死張該交規萬取拉格望覺術領共確傳師觀清麻快',
]);

export const REPEAT_CANDIDATE_THRESHOLD = 0.75;
export const TRUE_DUPLICATE_THRESHOLD = 0.85;
export const RECALL_DUPLICATE_THRESHOLD = 0.8;

let cachedDict = null;
let maxWordLen = 8;

/**
 * Loads `dict.txt` (`<word> <freq> <pos>`) from `data/dict/` once per process.
 */
export function loadChineseDict(root) {
  if (cachedDict) return cachedDict;
  const { dictDir } = getDataPaths(root);
  const dictPath = join(dictDir, 'dict.txt');
  const set = new Set();
  let maxL = 2;
  if (existsSync(dictPath)) {
    const raw = readFileSync(dictPath, { encoding: 'utf-8' });
    for (const line of raw.split(/\r?\n/)) {
      const sp = line.indexOf(' ');
      const word = (sp > 0 ? line.slice(0, sp) : line).trim();
      if (!word) continue;
      set.add(word);
      if (word.length > maxL && word.length <= 16) maxL = word.length;
    }
  }
  cachedDict = set;
  maxWordLen = maxL;
  return cachedDict;
}

let cachedCommonFreq = null;
let commonCutoff = 0;

/**
 * Loads common-word frequency table (`freq.txt`) to distinguish general filler words
 * from substantive rare clues during safety-net fallback.
 */
export function loadCommonWords(root) {
  if (cachedCommonFreq) return cachedCommonFreq;
  const { dictDir } = getDataPaths(root);
  const freqPath = join(dictDir, 'freq.txt');
  const map = new Map();
  let totalDocs = 0;
  if (existsSync(freqPath)) {
    const raw = readFileSync(freqPath, { encoding: 'utf-8' });
    for (const line of raw.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const w = parts[0];
      const f = Number(parts[1]);
      if (w && Number.isFinite(f)) {
        map.set(w, f);
        if (f > totalDocs) totalDocs = f;
      }
    }
  }
  cachedCommonFreq = map;
  commonCutoff = Math.max(500, totalDocs * 0.005);
  return cachedCommonFreq;
}

/**
 * Normalizes punctuation/casing while keeping CJK, ASCII letters, and digits.
 */
export function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s，。、！？,.!?;；:："'「」『』（）()【】\[\]<>《》~～\-—_]+/g, ' ')
    .trim();
}

/**
 * FMM greedy longest-match dictionary segmentation with single-character fallback.
 * Never drops unknown CJK characters (fixes compound loss such as 「她的胃」 vs 「胃不好」).
 */
export function tokenize(s, root) {
  const dict = loadChineseDict(root);
  const out = new Set();
  const clean = normalizeText(s);
  for (const m of clean.matchAll(/[a-z0-9]{2,}/g)) {
    if (!EN_STOPS.has(m[0])) out.add(m[0]);
  }
  for (const run of clean.match(/[\u4e00-\u9fa5]+/g) || []) {
    let i = 0;
    while (i < run.length) {
      let matchLen = 0;
      const upper = Math.min(maxWordLen, run.length - i);
      for (let n = upper; n >= 2; n--) {
        if (dict.has(run.slice(i, i + n))) {
          matchLen = n;
          break;
        }
      }
      if (matchLen > 0) {
        out.add(run.slice(i, i + matchLen));
        i += matchLen;
      } else {
        const ch = run[i];
        if (!SINGLE_STOP_CHARS.has(ch)) out.add(ch);
        i += 1;
      }
    }
  }
  return out;
}

/**
 * Computes memory-bank document frequency map `df` normalized for 0..1 IDF rarity.
 */
export function buildRarityTable(memories, root) {
  const df = new Map();
  for (const m of memories) {
    if (!m || m.replacedBy || m.已被取代) continue;
    const surface =
      String(m.text || '') +
      ' ' +
      (Array.isArray(m.tags) ? m.tags.join(' ') : '') +
      ' ' +
      (Array.isArray(m.related) ? m.related.join(' ') : '');
    for (const k of tokenize(surface, root)) {
      df.set(k, (df.get(k) || 0) + 1);
    }
  }
  const count = memories.filter((m) => m && !m.replacedBy && !m.已被取代).length;
  df.totalCount = count;
  df.top = Math.log((count + 1) / 2);
  return df;
}

/**
 * Normalized 0..1 rarity inside the memory bank (`<=1` clamped so absent terms score 0).
 */
export function wordRarity(df, word) {
  if (!(df.totalCount > 1)) return df.get(word) ? 1 : 0;
  if (!(df.top > 0)) return 0;
  const count = df.get(word);
  if (!count) return 0;
  const v = Math.log((df.totalCount + 1) / (count + 1)) / df.top;
  return v > 1 ? 1 : v > 0 ? v : 0;
}

/**
 * Returns true if `word` is NOT an ultra-common corpus filler word.
 */
export function isSubstantiveClue(word, root) {
  const freq = loadCommonWords(root);
  const f = freq.get(word);
  if (f === undefined) return true;
  return f < commonCutoff;
}

/**
 * Word overlap ratio measured against the SHORTER set (`|A ∩ B| / min(|A|, |B|)`).
 * Requires at least 3 tokens on the shorter side to reject coincidental 1-word hits.
 */
export function textSimilarity(setA, setB) {
  if (!setA || !setB || !setA.size || !setB.size) return 0;
  const small = setA.size <= setB.size ? setA : setB;
  const large = small === setA ? setB : setA;
  if (small.size < 3) return 0;
  let intersect = 0;
  for (const token of small) {
    if (large.has(token)) intersect++;
  }
  return intersect / small.size;
}

/**
 * Computes query informativeness against user's personal speech frequency ruler (`說話尺`).
 * Returns `Infinity` until at least 20 user utterances have been observed so small
 * sessions are never over-filtered.
 */
export function queryInformationScore(ruler, query, df, root) {
  const n = Number(ruler?.n || 0);
  if (n < 20) return Infinity;
  const top = Math.log(n + 1);
  if (!(top > 0)) return Infinity;
  const dfMap = ruler?.df || {};
  let sum = 0;
  for (const k of tokenize(query, root)) {
    if (!df.get(k)) continue;
    sum += Math.log((n + 1) / ((Number(dfMap[k]) || 0) + 1));
  }
  return sum / top;
}

/**
 * Updates persisted user speech ruler (`n`, `df`) with one genuine human utterance.
 */
export function recordSpeechSample(ruler, text, root) {
  const clean = String(text || '').trim();
  if (!clean || clean.length > 1000) return ruler;
  const next = ruler && typeof ruler === 'object' ? ruler : { n: 0, df: {} };
  if (!next.df || typeof next.df !== 'object') next.df = {};
  next.n = (Number(next.n) || 0) + 1;
  for (const k of tokenize(clean, root)) {
    next.df[k] = (Number(next.df[k]) || 0) + 1;
  }
  return next;
}
