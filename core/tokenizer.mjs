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
let commonFreqIsRankBucket = true;

// Common Traditional -> Simplified mapping so Traditional queries match Simplified `dict.txt` / `freq.txt`
const T2S_PAIRS =
  '萬万與与專专業业東东兩两嚴严臨临為为麗丽舉举義义樂乐習习書书亂乱爭争於于亞亚產产親亲億亿僅仅從从價价優优傳传傷伤備备兒儿內内關关興兴養养寫写軍军農农準准幾几擊击別别刪删劃划創创劇剧劑剂務务勝胜勞劳勢势區区協协單单衛卫卻却歷历壓压厭厌參参雙双變变號号聽听啟启嗎吗員员響响團团園园國国圖图圓圆場场報报塊块壞坏聲声處处複复夠够夢梦獎奖婦妇媽妈學学寧宁實实審审寬宽寶宝將将對对導导層层屬属歲岁島岛師师帳帐帶带幫帮廣广廳厅張张強强歸归錄录徹彻徵征憶忆應应懷怀態态總总慣惯愛爱憲宪戲戏戰战戶户擴扩掃扫揚扬換换損损據据擬拟擾扰攝摄擺摆攜携敗败敘叙數数斷断無无舊旧時时會会術术機机殺杀雜杂權权條条來来構构標标樣样檢检檔档歡欢氣气決决沒没測测溫温滅灭滿满漢汉漸渐燈灯燒烧營营熱热獨独獻献現现環环畫画異异當当發发監监盤盘盡尽確确碼码禮礼離离種种稱称積积穩稳窮穷競竞筆笔簡简簽签約约紅红級级紀纪紙纸紛纷納纳純纯組组終终結结給给統统絲丝經经綜综綠绿維维網网緊紧緒绪線线練练編编緩缓縮缩績绩續续纖纤聯联職职肅肃臉脸腳脚腦脑節节範范藥药蘇苏蘋苹虛虚補补裝装製制見见規规視视覺觉覽览觀观觸触計计訂订訊讯討讨訓训託托記记設设許许訴诉診诊註注証证評评詞词詢询試试詩诗話话該该詳详語语誤误說说誰谁課课調调談谈請请論论諸诸諾诺謀谋謂谓講讲謝谢證证識识警警譯译議议護护讀读讓让讚赞負负財财貢贡貧贫貨货販贩貪贪貫贯責责貴贵買买貸贷費费貼贴貿贸賀贺資资賣卖質质賞赏賢贤賬账賴赖賺赚賽赛贈赠贊赞贏赢趕赶趙赵趨趋躍跃車车軌轨軒轩軟软較较載载輔辅輕轻輝辉輩辈輪轮輯辑輸输轉转辭辞辦办這这連连進进過过達达違违遠远適适選选遺遗還还邁迈邏逻鄉乡郵邮鄭郑鄰邻醫医釋释針针釣钓鈴铃銀银銅铜銘铭銷销鋁铝鋒锋鋪铺鋼钢錢钱錯错鍋锅鍵键鍾钟鎮镇鏡镜鐘钟鐵铁鑑鉴長长門门閉闭開开閒闲間间悶闷閘闸鬧闹聞闻閣阁閱阅闊阔防防陣阵陰阴陳陈陸陆陽阳階阶際际隨随險险隱隐隻只雞鸡難难雲云電电霧雾靈灵靜静頁页頂顶項项順顺須须預预頑顽頓顿領领頭头頻频顆颗題题額额顏颜願愿類类顧顾顯显風风飄飘飛飞飯饭飲饮飾饰飽饱餐餐餘余館馆馬马駐驻駕驾駛驶驗验驚惊體体髮发魚鱼鮮鲜鳥鸟鳴鸣鳳凤鴨鸭鴻鸿鵝鹅點点黨党齊齐齒齿齡龄龍龙龜龟貓猫';
const T2S_MAP = new Map();
for (let i = 0; i + 1 < T2S_PAIRS.length; i += 2) {
  T2S_MAP.set(T2S_PAIRS[i], T2S_PAIRS[i + 1]);
}

/**
 * Lightweight Traditional -> Simplified character fold for matching Simplified `dict.txt` / `freq.txt`.
 */
export function toSimplifiedApprox(text) {
  let out = '';
  for (const ch of String(text || '')) out += T2S_MAP.get(ch) || ch;
  return out;
}

/**
 * Loads common-word frequency table (`freq.txt`) to distinguish general filler words
 * from substantive rare clues during memory recall and Xingxi bridge extraction.
 * Note: bundled `freq.txt` stores Zipf-like rank buckets (`0` = most common .. `62` = rarest in top-20k).
 */
export function loadCommonWords(root) {
  if (cachedCommonFreq) return cachedCommonFreq;
  const { dictDir } = getDataPaths(root);
  const freqPath = join(dictDir, 'freq.txt');
  const map = new Map();
  let maxVal = 0;
  if (existsSync(freqPath)) {
    const raw = readFileSync(freqPath, { encoding: 'utf-8' });
    for (const line of raw.split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const w = parts[0];
      const f = Number(parts[1]);
      if (w && Number.isFinite(f)) {
        map.set(w, f);
        if (f > maxVal) maxVal = f;
      }
    }
  }
  cachedCommonFreq = map;
  if (maxVal > 0 && maxVal <= 100) {
    // Rank-bucket format (0..62, smaller = more common): <=46 covers everyday fillers
    commonFreqIsRankBucket = true;
    commonCutoff = 46;
  } else {
    // Raw document-count format (larger = more common)
    commonFreqIsRankBucket = false;
    commonCutoff = Math.max(500, maxVal * 0.005);
  }
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
 * FMM greedy longest-match dictionary segmentation with single-character fallback
 * plus `dsh-fish-memory` v1.6.2 proper-noun sliding window (`補專名`: 2..4 char
 * windows across consecutive non-dictionary single characters such as 「星礫」「雲喵」).
 */
export function tokenize(s, root) {
  const dict = loadChineseDict(root);
  const out = new Set();
  const clean = normalizeText(s);
  for (const m of clean.matchAll(/[a-z0-9]{2,}/g)) {
    if (!EN_STOPS.has(m[0])) out.add(m[0]);
  }
  for (const run of clean.match(/[\u4e00-\u9fa5]+/g) || []) {
    const segs = [];
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
        const word = run.slice(i, i + matchLen);
        out.add(word);
        segs.push({ start: i, end: i + matchLen, isDict: true });
        i += matchLen;
      } else {
        const ch = run[i];
        if (!SINGLE_STOP_CHARS.has(ch)) out.add(ch);
        segs.push({ start: i, end: i + 1, isDict: false });
        i += 1;
      }
    }

    // dsh-fish-memory v1.6.2 `補專名`: consecutive single-char fallbacks form 2..4 char OOV proper noun tokens
    let a = 0;
    while (a < segs.length) {
      if (segs[a].isDict) {
        a += 1;
        continue;
      }
      let b = a + 1;
      while (b < segs.length && !segs[b].isDict) b += 1;
      if (b - a >= 2) {
        for (let p = a; p < b; p++) {
          for (let w = 2; w <= 4 && p + w <= b; w++) {
            out.add(run.slice(segs[p].start, segs[p + w - 1].end));
          }
        }
      }
      a = b;
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
    if (!m || m.replacedBy || m.已被取代 || m.superseded) continue;
    const surface =
      String(m.text || '') +
      ' ' +
      (Array.isArray(m.tags) ? m.tags.join(' ') : '') +
      ' ' +
      (Array.isArray(m.related) ? m.related.join(' ') : '') +
      ' ' +
      (Array.isArray(m.keywords) ? m.keywords.join(' ') : '');
    for (const k of tokenize(surface, root)) {
      df.set(k, (df.get(k) || 0) + 1);
    }
  }
  const count = memories.filter((m) => m && !m.replacedBy && !m.已被取代 && !m.superseded).length;
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
 * Supports both Simplified and Traditional Chinese via `toSimplifiedApprox`.
 */
export function isSubstantiveClue(word, root) {
  const freq = loadCommonWords(root);
  const w = String(word || '').trim();
  if (!w) return false;
  const f = freq.get(w) ?? freq.get(toSimplifiedApprox(w));
  if (f === undefined) return true;
  return commonFreqIsRankBucket ? f > commonCutoff : f < commonCutoff;
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
  const rawTokens = [...tokenize(query, root)];
  const multiTokens = rawTokens.filter((k) => String(k).length > 1);
  const tokens = multiTokens.length ? multiTokens : rawTokens;
  let sum = 0;
  for (const k of tokens) {
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
