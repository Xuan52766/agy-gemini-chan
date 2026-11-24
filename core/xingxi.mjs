/**
 * @fileoverview Long-term Memory Card + Daily Diary + Star Graph archive ported from `dsh-xingxi`.
 *
 * Structures:
 * - `記憶卡.md` (Single markdown file with 8 standard chapters 一..八)
 * - `日記/YYYY-MM-DD.md` (One file per calendar day)
 * - `.xingxi.json` ledger `{ "已整理到": "YYYY-MM-DD" }`
 *
 * Unlike `fish-memory`, Xingxi does NOT decay or delete memories: older stars dim slightly
 * visually in the Star Graph by age while staying readable forever.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import {
  clampNum,
  getDataPaths,
  localClockDisplay,
  localDayKey,
  readJsonSafe,
  readTextSafe,
  stripAntigravityWrappers,
  writeJsonAtomic,
  writeTextAtomic,
} from './storage.mjs';
import { tokenize } from './tokenizer.mjs';

export const XINGXI_PICKUP_MARKER = '[XINGXI_AUTO_PICKUP]';

export const DEFAULT_XINGXI_CONFIG = {
  autoScheduleEnabled: true,
  scheduleHour: 23,
  scheduleMinute: 30,
  scheduleMode: 'both', // 'both' | 'card_only' | 'diary_only'
  lastScheduledDate: '',
  lastScheduledAt: 0,
  lastStatus: '',
  logs: [],
};

export const CHAPTER_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八'];
export const NUMERAL_TO_INDEX = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8 };

export const CHAPTER_NAMES = [
  '我是誰',
  '我是怎麼說話的',
  '對方是誰',
  '我們怎麼走到今天的',
  '我們的約定',
  '難忘的時刻',
  '怎麼跟對方相處',
  '我們一起做的那些東西',
];

const CHAPTER_DESCRIPTIONS = [
  '這一章寫我是誰、性格底色與自己的樣子（整段自述）。',
  '說話的口氣、習慣稱呼、原句照抄與絕不說的話。',
  '對方的個性、喜好、生活習慣、身體與重要細節。',
  '關係是怎麼一步步走過來的，重要轉折與里程碑。',
  '我們之間說好、記住的約定與規矩。',
  '那些值得記一輩子的對話與瞬間。',
  '對方心情不好或平時相處時，什麼話有效、什麼是地雷。',
  '我們一起寫過的東西、做過的作品與共同記憶。',
];

function archiveFiles(root) {
  const { xingxiDir } = getDataPaths(root);
  const cardPath = existsSync(join(xingxiDir, '记忆卡.md')) && !existsSync(join(xingxiDir, '記憶卡.md'))
    ? join(xingxiDir, '记忆卡.md')
    : join(xingxiDir, '記憶卡.md');
  return {
    xingxiDir,
    cardPath,
    diaryDir: join(xingxiDir, '日記'),
    diaryDirCompat: join(xingxiDir, '日记'),
    rawDir: join(xingxiDir, '原始對話'),
    ledgerPath: join(xingxiDir, '.xingxi.json'),
    configPath: join(xingxiDir, 'config.json'),
  };
}

export function loadXingxiConfig(root) {
  const { xingxiDir, configPath } = archiveFiles(root);
  mkdirSync(xingxiDir, { recursive: true });
  const raw = readJsonSafe(configPath, null);
  if (!raw || typeof raw !== 'object') {
    const init = { ...DEFAULT_XINGXI_CONFIG };
    writeJsonAtomic(configPath, init);
    return init;
  }
  const clean = {
    autoScheduleEnabled: raw.autoScheduleEnabled !== false,
    scheduleHour: Math.round(clampNum(raw.scheduleHour, 0, 23, 23)),
    scheduleMinute: Math.round(clampNum(raw.scheduleMinute, 0, 59, 30)),
    scheduleMode: ['both', 'card_only', 'diary_only'].includes(raw.scheduleMode) ? raw.scheduleMode : 'both',
    lastScheduledDate: String(raw.lastScheduledDate || ''),
    lastScheduledAt: Number(raw.lastScheduledAt || 0),
    lastStatus: String(raw.lastStatus || ''),
    logs: Array.isArray(raw.logs) ? raw.logs.slice(-40) : [],
  };
  return clean;
}

export function saveXingxiConfig(patch = {}, root) {
  const { configPath } = archiveFiles(root);
  const prev = loadXingxiConfig(root);
  const merged = { ...prev, ...patch };
  // dsh-xingxi v0.2.4: only clear today's scheduled marker if hour/minute/mode actually changed
  const scheduleTouched =
    patch.scheduleHour !== undefined ||
    patch.scheduleMinute !== undefined ||
    patch.scheduleMode !== undefined;
  if (scheduleTouched && patch.lastScheduledDate === undefined) {
    const changed =
      Number(merged.scheduleHour) !== Number(prev.scheduleHour) ||
      Number(merged.scheduleMinute) !== Number(prev.scheduleMinute) ||
      String(merged.scheduleMode) !== String(prev.scheduleMode);
    if (changed && merged.lastScheduledDate === localDayKey()) {
      merged.lastScheduledDate = '';
    }
  }
  if (Array.isArray(merged.logs)) merged.logs = merged.logs.slice(-40);
  writeJsonAtomic(configPath, merged);
  return loadXingxiConfig(root);
}

function appendXingxiLog(cfg, text, now = Date.now()) {
  const logs = [...(cfg.logs || []), { at: now, time: localClockDisplay(now), text: String(text) }].slice(-40);
  cfg.logs = logs;
  cfg.lastStatus = String(text);
  return cfg;
}

/**
 * Ensures `記憶卡.md` exists with a clean 8-chapter scaffold (never overwrites user edits).
 */
export function ensureXingxiArchive(root) {
  const { xingxiDir, cardPath, diaryDir, ledgerPath } = archiveFiles(root);
  mkdirSync(xingxiDir, { recursive: true });
  mkdirSync(diaryDir, { recursive: true });
  if (!existsSync(cardPath)) {
    const lines = ['# 星汐記憶卡', ''];
    for (let i = 0; i < 8; i++) {
      lines.push(`## ${CHAPTER_NUMERALS[i]}｜${CHAPTER_NAMES[i]}`);
      lines.push(`> 這一章講什麼：${CHAPTER_DESCRIPTIONS[i]}`);
      lines.push('');
    }
    writeTextAtomic(cardPath, lines.join('\n'));
  }
  if (!existsSync(ledgerPath)) {
    writeJsonAtomic(ledgerPath, { 已整理到: '', updatedAt: new Date().toISOString() });
  }
  return archiveFiles(root);
}

/**
 * Deduplication fingerprint matching `dsh-xingxi` rule: first 12 non-punctuation chars.
 */
function lineFingerprint(line) {
  const clean = String(line || '')
    .trim()
    .replace(/^[-*·\d.．、)①②③④⑤⑥⑦⑧⑨⑩\s]+/, '')
    .replace(/[\s，。、！？,.!?;；:：「」『』（）()*`"'～~—\-]/g, '');
  if (!clean) return '';
  return clean.slice(0, 12);
}

/**
 * Extracts `YYYY-MM-DD` or `--MM-DD` date from title/filename/body.
 */
export function detectDate(text) {
  if (!text) return '';
  const s = String(text);
  let m = /(\d{4})[-_.年/](\d{1,2})[-_.月/](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = /(?:^|[^\d])(\d{1,2})[-_.月/](\d{1,2})(?:[日號号]|[^\d]|$)/.exec(s);
  if (m) {
    const mo = Number(m[1]);
    const dy = Number(m[2]);
    if (mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31) {
      return `--${String(mo).padStart(2, '0')}-${String(dy).padStart(2, '0')}`;
    }
  }
  return '';
}

function stripHeadingMarks(s) {
  return String(s || '').replace(/^#+\s*/, '').replace(/[*`>]/g, '').trim();
}

/**
 * Checks for duplicate chapter headers (`## 一｜` appearing twice) like `dsh-xingxi` `查重章`.
 */
export function checkDuplicateChapters(cardText) {
  const seen = new Map();
  const dups = [];
  for (const line of String(cardText || '').split(/\r?\n/)) {
    const m = /^##\s*([一二三四五六七八])\s*[、.．｜|·:：\-—]/.exec(line.trim());
    if (!m) continue;
    const ch = m[1];
    seen.set(ch, (seen.get(ch) || 0) + 1);
    if (seen.get(ch) === 2) dups.push(`第${ch}章`);
  }
  if (!dups.length) return '';
  return `⚠ 注意：記憶卡中 ${dups.join('、')} 出現了重複章節標題，建議整理合併。\n\n`;
}

const MAX_BACKUPS = 20;

function pruneBackups(filePath, limit = MAX_BACKUPS) {
  try {
    const dir = dirname(filePath);
    const base = `${basename(filePath)}.bak-`;
    const list = readdirSync(dir).filter((f) => f.startsWith(base)).sort();
    for (const stale of list.slice(0, Math.max(0, list.length - limit))) {
      try { rmSync(join(dir, stale)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

function backupXingxiFile(filePath) {
  if (!existsSync(filePath)) return '';
  try {
    const bakName = `${filePath}.bak-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}`;
    copyFileSync(filePath, bakName);
    pruneBackups(filePath, MAX_BACKUPS);
    return basename(bakName);
  } catch {
    return '';
  }
}

export function listXingxiBackups(root) {
  const { xingxiDir, diaryDir, diaryDirCompat } = ensureXingxiArchive(root);
  const out = [];
  const collect = (dir, subdir = '') => {
    if (!existsSync(dir)) return;
    let entries = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      const m = /^(.+)\.bak-([0-9T\-:Z.]+)$/.exec(name);
      if (!m) continue;
      try {
        const st = statSync(join(dir, name));
        if (!st.isFile()) continue;
        out.push({
          backup: subdir ? `${subdir}/${name}` : name,
          file: m[1],
          time: m[2],
          size: st.size,
          subdir,
        });
      } catch { /* ignore */ }
    }
  };
  collect(xingxiDir, '');
  collect(diaryDir, '日記');
  if (existsSync(diaryDirCompat)) collect(diaryDirCompat, '日记');
  out.sort((a, b) => (a.time < b.time ? 1 : -1));
  return out;
}

export function restoreXingxiBackup(backupName, root) {
  const { xingxiDir, diaryDir, diaryDirCompat } = ensureXingxiArchive(root);
  const clean = String(backupName || '').trim();
  if (!clean || clean.includes('..') || clean.startsWith('/') || clean.startsWith('\\')) {
    return { ok: false, error: '備份檔名格式不合法。' };
  }
  const baseOnly = basename(clean);
  if (!/^(.+)\.bak-[0-9T\-:Z.]+$/.test(baseOnly)) {
    return { ok: false, error: '備份檔名格式不符。' };
  }
  const candidates = [
    join(xingxiDir, clean),
    join(xingxiDir, baseOnly),
    join(diaryDir, baseOnly),
    join(diaryDirCompat, baseOnly),
  ];
  const srcPath = candidates.find((p) => existsSync(p));
  if (!srcPath) return { ok: false, error: `找不到備份檔：${clean}` };
  const targetPath = srcPath.replace(/\.bak-[0-9T\-:Z.]+$/, '');
  if (!existsSync(targetPath)) return { ok: false, error: '原始檔案已不存在，無法直接還原。' };

  const savedCurrent = backupXingxiFile(targetPath);
  const content = readTextSafe(srcPath, '');
  writeTextAtomic(targetPath, content);
  return {
    ok: true,
    restoredFrom: baseOnly,
    file: basename(targetPath),
    savedCurrentAs: savedCurrent,
    bytes: Buffer.byteLength(content, 'utf-8'),
  };
}

function extractEventDate(star) {
  if (!star || star.kind !== 'card') return '';
  const lines = [String(star.title || ''), ...String(star.text || '').split(/\r?\n/)];
  const candidates = new Set();
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^(?:這一章講什麼|这一章讲什么)/.test(line)) continue;
    const m = /^(?:[-*]\s*)?(?:\*\*)?(20\d{2})-(\d{1,2})-(\d{1,2})(?:\*\*)?(?=\s|[：:，,、｜|—\-]|$)(.*)$/.exec(line);
    if (!m) continue;
    const tail = m[4] || '';
    if (/(?:到|至|[~～—–])\s*(?:20\d{2}[-/.年])?\d{1,2}[-/.月]\d{1,2}/.test(tail.slice(0, 32))) continue;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) continue;
    candidates.add(`${m[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  }
  return candidates.size === 1 ? [...candidates][0] : '';
}

function parseMonthlyDiary(content, docName, fileDate) {
  const byDay = new Map();
  let year = '';
  for (const line of String(content || '').split(/\r?\n/)) {
    const ym = /^##\s+(\d{4})-(\d{2})\s*$/.exec(line);
    if (ym) {
      year = ym[1];
      continue;
    }
    const item = /^-\s*\*\*(\d{2})-(\d{2})([^*]*)\*\*\s*[：:]\s*(.*)$/.exec(line);
    if (!item) continue;
    if (!year && fileDate && fileDate.length >= 4) year = fileDate.slice(0, 4);
    const dateStr = year ? `${year}-${item[1]}-${item[2]}` : `--${item[1]}-${item[2]}`;
    const tail = (item[3] || '').trim();
    const isWeekday = /^\s*周[一二三四五六日天]\s*$|^\s*週[一二三四五六日天]\s*$/.test(item[3] || '');
    let star = byDay.get(dateStr);
    if (!star) {
      star = {
        id: '',
        kind: 'diary',
        chapter: 0,
        chapterName: '日記',
        title: `${item[1]}-${item[2]}${tail && isWeekday ? ` ${tail}` : ''}`,
        date: dateStr,
        doc: docName,
        text: '',
        subtitles: [],
      };
      byDay.set(dateStr, star);
    }
    const body = (item[4] || '').trim();
    if (tail && !isWeekday) {
      star.subtitles.push(tail);
      if (body) star.text += (star.text ? '\n\n' : '') + `【${tail}】${body}`;
    } else if (body) {
      star.text += (star.text ? '\n\n' : '') + body;
    }
  }
  return [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Parses one Markdown file into star nodes for the Constellation / Star Map UI.
 */
export function parseMarkdownToStars(filePath, relName) {
  let content = '';
  try {
    content = readFileSync(filePath, { encoding: 'utf-8' }).replace(/^\uFEFF/, '');
  } catch {
    return [];
  }
  const fileBase = basename(filePath, extname(filePath));
  const docName = relName || fileBase;
  const fileDate = detectDate(fileBase);

  const isMonthlyDiary = /^##\s+\d{4}-\d{2}\s*$/m.test(content) && /^-\s*\*\*\d{2}-\d{2}/m.test(content);
  const out = isMonthlyDiary ? parseMonthlyDiary(content, docName, fileDate) : [];

  if (!isMonthlyDiary) {
    const stars = [];
    let chapter = 0;
    let chapterName = '';
    let current = null;

    const flush = () => {
      if (!current) return;
      current.text = current.text.trim();
      if (current.isContainer) {
        const empty = !current.text;
        const introOnly = current.text.startsWith('>') && current.text.length < 110;
        if (empty || introOnly) {
          current = null;
          return;
        }
      }
      stars.push(current);
      current = null;
    };

    for (const line of content.split(/\r?\n/)) {
      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) {
        const level = h[1].length;
        const title = stripHeadingMarks(h[2]);
        if (level === 1) continue;
        flush();
        const chMatch = /^([一二三四五六七八])\s*[、.．｜|·:：\-—]\s*(.*)$/.exec(title);
        if (chMatch) {
          chapter = NUMERAL_TO_INDEX[chMatch[1]] || 0;
          chapterName = chMatch[2] || CHAPTER_NAMES[chapter - 1] || '';
        }
        current = {
          id: '',
          kind: fileDate ? 'diary' : 'card',
          chapter,
          chapterName: chapterName || (fileDate ? '日記' : docName),
          title: chMatch ? (chMatch[2] || title) : title,
          date: fileDate,
          doc: docName,
          text: '',
          isContainer: Boolean(chMatch),
        };
        continue;
      }
      if (current && /^\s*>?\s*(?:這一章講什麼|这一章讲什么)/.test(line)) continue;
      if (current) current.text += line + '\n';
    }
    flush();

    if (!stars.length && content.trim()) {
      stars.push({
        id: '',
        kind: fileDate ? 'diary' : 'card',
        chapter: 0,
        chapterName: fileDate ? '日記' : '檔案',
        title: fileBase,
        date: fileDate,
        doc: docName,
        text: content.trim(),
      });
    }

    // Split bullet/numbered list items (except Chapter 1 prose self-description & diaries)
    for (const s of stars) {
      if (fileDate || Number(s.chapter) === 1) {
        out.push(s);
        continue;
      }
      const lines = String(s.text || '').split('\n');
      const starts = [];
      for (let i = 0; i < lines.length; i++) {
        if (/^\s*(-\s+|\*\*\d+[.．]|\d+[.．]\s)/.test(lines[i])) starts.push(i);
      }
      if (starts.length < 2) {
        out.push(s);
        continue;
      }
      const head = lines.slice(0, starts[0]).join('\n').trim();
      if (head.length > 40 && !head.startsWith('>')) {
        out.push({ ...s, text: head });
      }
      for (let j = 0; j < starts.length; j++) {
        const a = starts[j];
        const b = j + 1 < starts.length ? starts[j + 1] : lines.length;
        const chunk = lines.slice(a, b).join('\n').trim();
        if (chunk.length < 6) continue;
        const plain = chunk.replace(/^\s*(-\s+|\*\*\d+[.．]\s*|\d+[.．]\s*)/, '').replace(/[*_`>#]/g, '').trim();
        out.push({ ...s, title: plain.slice(0, 26) || s.title, text: chunk });
      }
    }
  }

  let fileMtimeMs = 0;
  try {
    fileMtimeMs = statSync(filePath).mtimeMs || 0;
  } catch { /* ignore */ }

  const inferStarTs = (star) => {
    const txt = `${star.title || ''}\n${star.text || ''}`;
    let m = /(\d{4})-(\d{2})-(\d{2})/.exec(txt);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    m = /\*\*(\d{2})-(\d{2})/.exec(txt);
    if (m) {
      const y = new Date().getFullYear();
      return new Date(y, Number(m[1]) - 1, Number(m[2])).getTime();
    }
    if (star.date) {
      const d = /(\d{4})-(\d{2})-(\d{2})/.exec(String(star.date));
      if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime();
    }
    return fileMtimeMs || Date.now();
  };

  let idx = 0;
  const now = Date.now();
  for (const star of out) {
    star.id = `star:${docName}#${idx}`;
    star.order = idx++;
    const evDate = star.kind === 'card' ? extractEventDate(star) : '';
    if (evDate) star.eventDate = evDate;
    const dStr = star.kind === 'card' ? (evDate || star.date || '') : (star.date || '');
    star.date = dStr;
    const parsedTs = inferStarTs(star);
    star.ts = Number.isFinite(parsedTs) && parsedTs > 0 ? parsedTs : now;
    const ageDays = Math.max(0, (now - star.ts) / 86400000);
    star.energy = Math.max(0.35, Math.min(1, 1 - ageDays / 180));
  }
  return out;
}

/**
 * Lists all readable archives in `data/xingxi/` (`card`, `diary`, optionally `原始對話/*.txt`).
 */
export function listXingxiFiles(root, { includeRaw = false } = {}) {
  const { xingxiDir } = ensureXingxiArchive(root);
  const files = [];
  const visit = (dir, prefix = '') => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || /^(backup|_備份|_备份|node_modules)$/i.test(ent.name)) continue;
      if (ent.name.includes('.bak-')) continue;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (!prefix) visit(full, ent.name);
      } else if (ent.isFile()) {
        const ext = extname(ent.name).toLowerCase();
        const isRawDir = /^(?:原始對話|原始对话)$/i.test(prefix);
        if (ext === '.md' || (includeRaw && isRawDir && ext === '.txt')) {
          const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
          const text = readTextSafe(full, '');
          files.push({ name: rel, path: full, text });
        }
      }
    }
  };
  visit(xingxiDir);
  return files;
}

function charBigrams(text) {
  const clean = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '');
  const set = new Set();
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2));
  return set;
}

function buildSharedBridges(stars, limit = 100) {
  const termIndex = new Map();
  const extractTerms = (text) => {
    const out = new Set();
    const runs = String(text || '').replace(/[^\u4e00-\u9fa5]/g, ' ').split(/\s+/);
    for (const seg of runs) {
      if (seg.length < 3) continue;
      for (let len = 3; len <= 4; len++) {
        for (let i = 0; i + len <= seg.length; i++) out.add(seg.slice(i, i + len));
      }
    }
    return out;
  };

  for (let i = 0; i < stars.length; i++) {
    const s = stars[i];
    if (s.kind !== 'card') continue;
    for (const w of extractTerms(`${s.title || ''} ${s.text || ''}`)) {
      if (!termIndex.has(w)) termIndex.set(w, []);
      termIndex.get(w).push(i);
    }
  }

  const bridges = [];
  const linked = new Set();
  const candidates = [...termIndex.entries()]
    .filter(([w, idxs]) => idxs.length >= 2 && idxs.length <= 5 && w.length >= 3)
    .sort((a, b) => a[1].length - b[1].length);

  for (const [word, idxs] of candidates) {
    for (let a = 0; a < idxs.length; a++) {
      for (let b = a + 1; b < idxs.length; b++) {
        const pairKey = `${idxs[a]}-${idxs[b]}`;
        if (linked.has(pairKey)) continue;
        linked.add(pairKey);
        bridges.push({
          source: stars[idxs[a]].id,
          target: stars[idxs[b]].id,
          kind: 'bridge',
          label: word,
          weight: 0.55,
        });
        if (bridges.length >= limit) return bridges;
      }
    }
  }
  return bridges;
}

/**
 * Builds the Star Graph (`stars` + `links`) for the Sidecar Star Map visualization.
 */
export function buildStarGraph(root) {
  const { xingxiDir, ledgerPath } = ensureXingxiArchive(root);
  const files = listXingxiFiles(root, { includeRaw: false });
  const stars = [];
  for (const f of files) {
    stars.push(...parseMarkdownToStars(f.path, f.name.replace(/\.md$/i, '')));
  }

  const links = [];
  const seenEdge = new Set();
  const pushEdge = (a, b, kind, weight, extra = {}) => {
    if (!a || !b || a === b) return;
    const key = a < b ? `${a}|${b}|${kind}` : `${b}|${a}|${kind}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    links.push({ source: a, target: b, kind, weight, ...extra });
  };

  // 1. Same chapter chain (`dsh-xingxi` 造線)
  const byChapter = new Map();
  for (const s of stars) {
    if (s.kind !== 'card' || !s.chapter) continue;
    if (!byChapter.has(s.chapter)) byChapter.set(s.chapter, []);
    byChapter.get(s.chapter).push(s);
  }
  for (const group of byChapter.values()) {
    group.sort((x, y) => x.order - y.order);
    for (let i = 1; i < group.length; i++) {
      pushEdge(group[i - 1].id, group[i].id, 'chapter', 0.72);
    }
  }

  // 2. Chronological diary chain
  const diaries = stars
    .filter((s) => s.kind === 'diary' && /^\d{4}-\d{2}-\d{2}$/.test(s.date || ''))
    .sort((x, y) => (x.date < y.date ? -1 : 1));
  for (let i = 1; i < diaries.length; i++) {
    pushEdge(diaries[i - 1].id, diaries[i].id, 'day', 0.68);
  }

  // 3. Date mention links (`MM-DD` -> diary star)
  const diaryByMmDd = new Map(diaries.map((s) => [s.date.slice(5), s.id]));
  for (const s of stars) {
    if (!s.text) continue;
    const mentioned = new Set();
    for (const m of s.text.matchAll(/(\d{2})-(\d{2})(?!\d)/g)) mentioned.add(`${m[1]}-${m[2]}`);
    let count = 0;
    for (const mmdd of mentioned) {
      if (count >= 4) break;
      const targetId = diaryByMmDd.get(mmdd);
      if (targetId && targetId !== s.id) {
        pushEdge(s.id, targetId, 'ref', 0.65);
        count++;
      }
    }
  }

  // 4. Shared rare term bridges (`造共享橋`)
  const bridges = buildSharedBridges(stars, 240);
  for (const br of bridges) {
    pushEdge(br.source, br.target, 'bridge', br.weight, { label: br.label });
  }

  // 5. Bigram similarity (`>= 8` overlap and `>= 0.2`, top 2 per star)
  const rich = stars.filter((s) => s.text && s.text.length >= 24);
  const bgMap = new Map(rich.map((s) => [s.id, charBigrams(`${s.title} ${s.text}`)]));
  const simTop = new Map();
  for (let i = 0; i < rich.length; i++) {
    const ba = bgMap.get(rich[i].id);
    if (!ba.size) continue;
    for (let j = i + 1; j < rich.length; j++) {
      const bb = bgMap.get(rich[j].id);
      if (!bb.size) continue;
      let inter = 0;
      for (const g of ba) if (bb.has(g)) inter++;
      if (inter < 8) continue;
      const ratio = inter / Math.min(ba.size, bb.size);
      if (ratio < 0.2) continue;
      for (const [x, y] of [[rich[i].id, rich[j].id], [rich[j].id, rich[i].id]]) {
        if (!simTop.has(x)) simTop.set(x, []);
        simTop.get(x).push({ id: y, ratio });
      }
    }
  }
  for (const [id, list] of simTop) {
    list.sort((a, b) => b.ratio - a.ratio);
    for (const item of list.slice(0, 2)) {
      pushEdge(id, item.id, 'similar', Math.min(0.95, item.ratio));
    }
  }

  diaries.forEach((s, i) => {
    s.diarySeq = i;
  });

  const ledger = syncLedgerWithRealDiaries(root);
  return {
    xingxiDir,
    ledger,
    fileCount: files.length,
    stars,
    links: links.slice(0, 320),
    bridges,
    stats: {
      stars: stars.length,
      cards: stars.filter((s) => s.kind === 'card').length,
      diaries: diaries.length,
      links: links.length,
      firstDay: diaries.length ? diaries[0].date : '',
      lastDay: diaries.length ? diaries[diaries.length - 1].date : '',
    },
    chapters: CHAPTER_NAMES.map((name, idx) => ({
      index: idx + 1,
      numeral: CHAPTER_NUMERALS[idx],
      name,
      count: stars.filter((s) => s.chapter === idx + 1).length,
    })),
  };
}

/**
 * Full-read of `記憶卡.md` (mirrors `xingxi` tool).
 */
export function readMemoryCard(root) {
  const { cardPath } = ensureXingxiArchive(root);
  const raw = readTextSafe(cardPath, '');
  return {
    ok: true,
    path: cardPath,
    text: checkDuplicateChapters(raw) + raw,
  };
}

/**
 * Search across `記憶卡.md`, `日記/*.md`, and `原始對話/*.txt` (mirrors `xingxi_read` tool).
 */
export function searchXingxiArchive({ keyword = '', date = '', file = '', maxChars = 4000 } = {}, root) {
  const files = listXingxiFiles(root, { includeRaw: true });
  const limit = Math.max(600, Math.min(20000, Number(maxChars) || 4000));
  const k = String(keyword || '').trim();
  const d = String(date || '').trim();
  const fName = String(file || '').trim();

  const diaryFiles = files.filter((x) => /^(?:日記|日记)\//.test(x.name));
  const rawFiles = files.filter((x) => /^(?:原始對話|原始对话)\//.test(x.name));
  const otherFiles = files.filter((x) => !/^(?:日記|日记|原始對話|原始对话)\//.test(x.name) && !/記憶卡|记忆卡/.test(x.name));

  const diaryDates = diaryFiles
    .map((f) => detectDate(f.name))
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))
    .sort();
  const rawDates = rawFiles
    .map((f) => detectDate(f.name))
    .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))
    .sort();

  if (!k && !d && !fName) {
    const card = files.find((x) => /記憶卡|记忆卡/.test(x.name));
    const lines = [`檔案共有 ${files.length} 個檔案：`, ''];
    if (card) lines.push(`· ${card.name}（${card.text.length} 字）`);
    for (const o of otherFiles) lines.push(`· ${o.name}（${o.text.length} 字）`);
    if (diaryDates.length) {
      lines.push(`· 日記 ${diaryDates.length} 天：${diaryDates[0]} ~ ${diaryDates[diaryDates.length - 1]}`);
    } else {
      lines.push('· 日記：尚無日記');
    }
    if (rawDates.length) {
      lines.push(`· 原始對話 ${rawDates.length} 天：${rawDates[0]} ~ ${rawDates[rawDates.length - 1]}`);
    }
    lines.push('', '查詢方式：給 `keyword` 全文檢索、`date` 看該日日記，或 `file` 看指定檔案。');
    return { ok: true, text: lines.join('\n') };
  }

  if (d) {
    const shortD = d.length >= 10 ? d.slice(5) : d;
    const hits = files.filter((x) => x.name.includes(d) || x.name.includes(shortD));
    if (hits.length) {
      return {
        ok: true,
        text: hits.slice(0, 3).map((x) => `【${x.name}】\n${x.text.slice(0, limit)}`).join('\n\n').slice(0, limit),
      };
    }
    const inlineHits = [];
    for (const f of files) {
      const fLines = f.text.split(/\r?\n/);
      const block = [];
      let collecting = false;
      for (const l of fLines) {
        const t = l.trim();
        const isEntryStart = /^-\s*\*\*\d{2}-\d{2}/.test(t) || /^#{2,3}\s*\d{4}-\d{2}-\d{2}/.test(t);
        if (isEntryStart) collecting = t.includes(shortD) || t.includes(d);
        if (collecting) block.push(l);
      }
      if (block.length) inlineHits.push(`【${f.name}】\n${block.join('\n')}`);
    }
    if (inlineHits.length) {
      return { ok: true, text: inlineHits.join('\n\n').slice(0, limit) };
    }
    return {
      ok: false,
      text: `${d} 沒有找到日記。現有範圍：${diaryDates.length ? `${diaryDates[0]} ~ ${diaryDates[diaryDates.length - 1]}` : '尚無日記'}`,
    };
  }

  if (fName && !k) {
    const hits = files.filter((x) => x.name.includes(fName));
    if (!hits.length) return { ok: false, text: `找不到檔案：${fName}` };
    return {
      ok: true,
      text: hits.slice(0, 2).map((x) => `【${x.name}】\n${x.text.slice(0, limit)}`).join('\n\n').slice(0, limit),
    };
  }

  const results = [];
  for (const f of files) {
    const lines = f.text.split(/\r?\n/);
    let count = 0;
    const snippets = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes(k)) continue;
      count++;
      if (snippets.length < 2) {
        snippets.push(lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 4)).join('\n'));
      }
    }
    if (count > 0) results.push({ name: f.name, count, snippets });
  }

  if (!results.length) {
    return { ok: false, text: `檔案裡沒有「${k}」（已檢查 ${files.length} 個檔案）` };
  }

  results.sort((a, b) => b.count - a.count);
  const total = results.reduce((s, r) => s + r.count, 0);
  const out = [`「${k}」在 ${results.length} 個檔案裡出現 ${total} 次：`];
  let len = out[0].length;
  for (const r of results) {
    const block = `【${r.name}】（${r.count} 處）\n${r.snippets.join('\n\n')}`;
    if (len + block.length > limit) {
      out.push(`…還有其他檔案包含關鍵字，可指定 file 參數查看`);
      break;
    }
    out.push(block);
    len += block.length;
  }
  return { ok: true, text: out.join('\n\n') };
}

/**
 * Appends deduplicated entries to one chapter (`1..8` or numeral `'一'..'八'`) of `記憶卡.md`.
 */
export function appendToChapter(chapterSpec, content, root) {
  const { cardPath } = ensureXingxiArchive(root);
  const numIdx = CHAPTER_NUMERALS.indexOf(String(chapterSpec).trim()) + 1;
  const chapter = numIdx > 0 ? numIdx : Number(chapterSpec) || 0;
  if (chapter < 1 || chapter > 8) {
    return { ok: false, error: '章節必須是 1~8 或 一~八' };
  }

  const raw = readTextSafe(cardPath, '');
  const existingFps = new Set(raw.split(/\r?\n/).map(lineFingerprint).filter(Boolean));
  const kept = [];
  let skipped = 0;
  for (const line of String(content || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || /^##\s+/.test(t)) continue;
    const fp = lineFingerprint(line);
    if (fp && existingFps.has(fp)) {
      skipped++;
      continue;
    }
    if (fp) existingFps.add(fp);
    kept.push(line);
  }

  if (!kept.length) {
    return { ok: true, added: 0, skipped, message: '條目皆已存在或為空，已跳過重複。' };
  }

  const prefix = `## ${CHAPTER_NUMERALS[chapter - 1]}｜`;
  const lines = raw ? raw.split(/\r?\n/) : [];
  const start = lines.findIndex((l) => l.startsWith(prefix));

  backupXingxiFile(cardPath);

  if (start < 0) {
    let insertBefore = -1;
    for (let i = 0; i < lines.length; i++) {
      const m = /^##\s*([一二三四五六七八])\s*[、.．｜|·:：\-—]/.exec(String(lines[i] || ''));
      if (!m) continue;
      const idx = CHAPTER_NUMERALS.indexOf(m[1]) + 1;
      if (idx > chapter) {
        insertBefore = i;
        break;
      }
    }
    if (insertBefore >= 0) {
      const ordered = [...lines.slice(0, insertBefore), `${prefix}${CHAPTER_NAMES[chapter - 1]}`, ...kept, '', ...lines.slice(insertBefore)];
      writeTextAtomic(cardPath, ordered.join('\n').trimEnd() + '\n');
      return { ok: true, added: kept.length, skipped, chapter };
    }
    lines.push('', `${prefix}${CHAPTER_NAMES[chapter - 1]}`, ...kept);
    writeTextAtomic(cardPath, lines.join('\n').trim() + '\n');
    return { ok: true, added: kept.length, skipped, chapter };
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt > start + 1 && !String(lines[insertAt - 1] || '').trim()) insertAt--;
  const merged = [...lines.slice(0, insertAt), ...kept, ...lines.slice(insertAt)];
  writeTextAtomic(cardPath, merged.join('\n').trimEnd() + '\n');
  return { ok: true, added: kept.length, skipped, chapter };
}

/**
 * Safe whole-chapter replacement for Chapter 2 (`二｜我是怎麼說話的`):
 * enforces quote cap (<=10) and rejects replacement if item count shrinks < 70%
 * when the chapter previously had >= 5 items (`dsh-xingxi` v0.3.0 data-loss guard).
 */
export function replaceChapterTwo(newContent, root, quoteLimit = 10) {
  const { cardPath } = ensureXingxiArchive(root);
  const raw = readTextSafe(cardPath, '');
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('## 二｜'));
  if (start < 0) return appendToChapter(2, newContent, root);

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const incoming = String(newContent || '')
    .split(/\r?\n/)
    .filter((l) => !/^##\s*[一二三四五六七八]/.test(l.trim()));

  let quoteCount = 0;
  let trimmedQuotes = 0;
  const filtered = [];
  for (const line of incoming) {
    const isExample = /^\s*(\d+[.．]|[-*])\s/.test(line) && /[「『"“]/.test(line);
    if (isExample) {
      quoteCount++;
      if (quoteCount > quoteLimit) {
        trimmedQuotes++;
        continue;
      }
    }
    filtered.push(line);
  }
  if (!filtered.some((x) => x.trim())) {
    return { ok: false, error: '新內容為空，拒絕覆寫第二章。' };
  }

  const countItems = (arr) => arr.filter((l) => /^\s*(?:\d+[.、)]|[-*·]|[①②③④⑤⑥⑦⑧⑨⑩])/.test(l)).length;
  const oldCount = countItems(lines.slice(start + 1, end));
  const newCount = countItems(filtered);
  if (oldCount >= 5 && newCount < oldCount * 0.7) {
    return {
      ok: false,
      error: `安全攔截：原第二章有 ${oldCount} 條，這次只給了 ${newCount} 條（少於 70%），為防遺失資料已拒絕整章覆寫。`,
    };
  }

  backupXingxiFile(cardPath);

  const out = [...lines.slice(0, start), lines[start], ...filtered, '', ...lines.slice(end)];
  writeTextAtomic(cardPath, out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n');
  return { ok: true, trimmedQuotes };
}

function stripLeadingDiaryHeading(body, day) {
  const safeDay = String(day || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^\\s*#\\s*${safeDay}(?:\\s*日記|\\s*日记)?[^\\n]*(?:\\r?\\n)+`, 'i');
  let out = String(body || '').trim();
  while (re.test(out)) {
    out = out.replace(re, '').trim();
  }
  return out;
}

export function advanceXingxiWatermark(root, ts = Date.now()) {
  const val = Number(ts) || 0;
  if (val <= 0) return 0;
  const { ledgerPath } = ensureXingxiArchive(root);
  const ledger = readJsonSafe(ledgerPath, { 已整理到: '' }) || { 已整理到: '' };
  const next = Math.max(Number(ledger['水位Ms'] || 0), val);
  ledger['水位Ms'] = next;
  ledger.updatedAt = new Date().toISOString();
  writeJsonAtomic(ledgerPath, ledger);
  return next;
}

export function readExistingDiarySnippet(root, day, maxChars = 1500) {
  const { diaryDir } = ensureXingxiArchive(root);
  const cleanDay = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '').trim()) ? String(day).trim() : localDayKey();
  const path = join(diaryDir, `${cleanDay}.md`);
  if (!existsSync(path)) return '';
  const body = stripLeadingDiaryHeading(readTextSafe(path, ''), cleanDay);
  if (!body) return '';
  if (maxChars <= 0 || body.length <= maxChars) return body;
  return `…${body.slice(-maxChars)}`;
}

/**
 * Appends a diary section to `日記/YYYY-MM-DD.md`, strips duplicate date headings,
 * and advances `.xingxi.json` progress (+ same-day `水位Ms` watermark).
 */
export function appendDiary({ date = localDayKey(), entry = '', now = Date.now() } = {}, root) {
  const { diaryDir, ledgerPath } = ensureXingxiArchive(root);
  const nowMs = Number(now) || Date.now();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date).trim()) ? String(date).trim() : localDayKey(nowMs);
  const body = stripLeadingDiaryHeading(entry, day);
  if (!body) return { ok: false, error: '日記內容不可為空' };

  const path = join(diaryDir, `${day}.md`);
  const prev = readTextSafe(path, '');
  const prevClean = prev.trim();
  if (prevClean && prevClean.includes(body)) {
    return { ok: true, path, date: day, skippedDuplicate: true };
  }

  const header = prevClean ? '' : `# ${day} 日記\n\n`;
  const sep = prevClean && !prev.endsWith('\n\n') ? (prev.endsWith('\n') ? '\n' : '\n\n') : '';
  writeTextAtomic(path, `${prev}${sep}${header}${body}\n`);

  const ledger = readJsonSafe(ledgerPath, {}) || {};
  if (!ledger['已整理到'] || day > ledger['已整理到']) {
    ledger['已整理到'] = day;
  }
  if (day === localDayKey(nowMs)) {
    ledger['水位Ms'] = Math.max(Number(ledger['水位Ms'] || 0), nowMs);
  }
  ledger.updatedAt = new Date(nowMs).toISOString();
  writeJsonAtomic(ledgerPath, ledger);
  return { ok: true, path, date: day };
}

/**
 * dsh-xingxi v0.3.6 / v0.3.7: sync `.xingxi.json` `已整理到` with actual non-empty
 * diary files (`>= 40` non-markup characters) so progress never gets stuck behind existing diaries.
 */
export function syncLedgerWithRealDiaries(root) {
  const { diaryDir, diaryDirCompat, ledgerPath } = ensureXingxiArchive(root);
  const ledger = readJsonSafe(ledgerPath, { 已整理到: '' }) || { 已整理到: '' };
  let latestDiaryDate = String(ledger['已整理到'] || '');

  for (const dir of [diaryDir, diaryDirCompat]) {
    if (!existsSync(dir)) continue;
    let names = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.md') || name.includes('.bak-')) continue;
      const d = detectDate(name);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      if (latestDiaryDate && d <= latestDiaryDate) continue;
      const body = readTextSafe(join(dir, name), '');
      const substantive = body
        .replace(/^#.*$/gm, '')
        .replace(/^>.*$/gm, '')
        .replace(/\s+/g, '');
      if (substantive.length >= 40) {
        latestDiaryDate = d;
      }
    }
  }

  if (latestDiaryDate && latestDiaryDate !== String(ledger['已整理到'] || '')) {
    ledger['已整理到'] = latestDiaryDate;
    ledger.updatedAt = new Date().toISOString();
    writeJsonAtomic(ledgerPath, ledger);
  }
  return ledger;
}

function appendMaterialBlock(rawFilePath, headerLine, bodyLines) {
  const body = bodyLines.join('\n').trim();
  if (!body) return false;
  const fullBlock = `${headerLine}\n${body}\n`;
  if (!existsSync(rawFilePath)) {
    writeTextAtomic(rawFilePath, fullBlock);
    return true;
  }
  const prev = readTextSafe(rawFilePath, '');
  if (prev.includes(body)) return false;

  // dsh-xingxi v0.3.6: longest-common-prefix / line-level delta append so later turns on the
  // same day are appended cleanly even when earlier turns of the same day are already present
  const existingLines = new Set(
    prev
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('# ') && l !== '── 之後 ──'),
  );
  const deltaLines = [];
  let pendingSectionHeader = '';
  for (const line of bodyLines) {
    const t = String(line || '').trim();
    if (!t) continue;
    if (/^【.+】$/.test(t)) {
      pendingSectionHeader = t;
      continue;
    }
    if (existingLines.has(t)) continue;
    if (pendingSectionHeader) {
      if (deltaLines.length) deltaLines.push('');
      deltaLines.push(pendingSectionHeader);
      pendingSectionHeader = '';
    }
    deltaLines.push(line);
  }
  if (!deltaLines.length) return false;
  writeTextAtomic(rawFilePath, `${prev.trimEnd()}\n\n── 之後 ──\n${deltaLines.join('\n')}\n`);
  return true;
}

const SKIP_MATERIAL_PREFIXES = [
  '[SPEAK_UP_INTERNAL]',
  '[XINGXI_AUTO_PICKUP]',
  '[CAT_NEST_EVENT]',
];

function isInternalTurnText(text) {
  const raw = String(text || '').trim();
  const clean = stripAntigravityWrappers(raw);
  if (!clean || clean.startsWith('<')) return true;
  return SKIP_MATERIAL_PREFIXES.some((p) => raw.includes(p) || clean.includes(p));
}

/**
 * Slices verified `gemini_cat` conversation transcripts + Memory + Mood highlights
 * for a given date (`YYYY-MM-DD`) into `data/xingxi/原始對話/YYYY-MM-DD.txt` (matches DSH 切料 & 水位Ms).
 */
export function prepareXingxiPickupMaterial(root, { date = localDayKey(), now = Date.now(), minTs = 0, maxTs = 0 } = {}) {
  const { rawDir, ledgerPath } = ensureXingxiArchive(root);
  mkdirSync(rawDir, { recursive: true });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date).trim()) ? String(date).trim() : localDayKey(now);
  const ledger = readJsonSafe(ledgerPath, { 已整理到: '', 水位Ms: 0 }) || { 已整理到: '', 水位Ms: 0 };
  const hasExplicitMin = Number(minTs) > 0;
  const watermark = hasExplicitMin ? Number(minTs) : Number(ledger['水位Ms'] || 0);
  const watermarkDay = watermark > 0 ? localDayKey(watermark) : '';
  const cutoffTs = Number(maxTs) > 0 ? Number(maxTs) : Number(now) || 0;

  const { runtimeDir, memoryDir, moodDir } = getDataPaths(root);
  const sessionsData = readJsonSafe(join(runtimeDir, 'sessions.json'), { sessions: [] }) || { sessions: [] };
  const collectedTurns = [];
  const seenTurnKeys = new Set();
  let maxSeenTs = 0;

  for (const sess of sessionsData.sessions || []) {
    const tPath = String(sess.transcriptPath || '').trim();
    if (!tPath || !existsSync(tPath)) continue;
    const raw = readTextSafe(tPath, '');
    if (!raw) continue;
    for (const row of raw.split(/\r?\n/)) {
      if (!row.trim()) continue;
      let step;
      try { step = JSON.parse(row); } catch { continue; }
      const type = step?.type;
      if (type !== 'USER_INPUT' && type !== 'PLANNER_RESPONSE') continue;
      const rawContent = typeof step.content === 'string' ? step.content.trim() : '';
      if (!rawContent) continue;
      if (type === 'USER_INPUT' && isInternalTurnText(rawContent)) continue;

      const content = type === 'USER_INPUT' ? stripAntigravityWrappers(rawContent) : rawContent;
      if (!content || content.startsWith('<')) continue;

      const ts = step.created_at ? Date.parse(step.created_at) : 0;
      if (Number.isFinite(ts) && ts > 0) {
        if (localDayKey(ts) !== day) continue;
        // dsh-xingxi v0.3.1: lock cutoff timestamp at pickup start
        if (cutoffTs > 0 && ts > cutoffTs) continue;
        // Same-day watermark rule (`dsh-xingxi` v0.2.6): later days' watermarks never wipe out backfills of earlier days
        if (watermark > 0 && (hasExplicitMin || watermarkDay === day) && ts <= watermark) continue;
        if (ts > maxSeenTs) maxSeenTs = ts;
      }

      const clock = Number.isFinite(ts) && ts > 0 ? localClockDisplay(ts) : day;
      const speaker = type === 'USER_INPUT' ? '主人' : 'Gemini-chan';
      const dedupKey = `${speaker}|${clock}|${content.slice(0, 160)}`;
      if (seenTurnKeys.has(dedupKey)) continue;
      seenTurnKeys.add(dedupKey);
      collectedTurns.push({ ts: Number.isFinite(ts) ? ts : 0, clock, speaker, content: content.slice(0, 1200) });
    }
  }

  collectedTurns.sort((a, b) => a.ts - b.ts);
  const linesOut = collectedTurns.map((t) => `[${t.clock}] ${t.speaker}：${t.content}`);
  const turnCount = collectedTurns.length;

  // Also include same-day Memory & Mood timeline highlights cleanly
  const memStore = readJsonSafe(join(memoryDir, 'store.json'), { memories: [] }) || { memories: [] };
  const dayMems = (memStore.memories || []).filter((m) => !m.superseded && m.createdAt && localDayKey(m.createdAt) === day);
  if (dayMems.length) {
    linesOut.push('', '【今日新增的記憶要點】');
    for (const m of dayMems.slice(-12)) {
      linesOut.push(`- ${m.text}${m.factKey ? `（鍵：${m.factKey}）` : ''}`);
    }
  }

  const moodFile = join(moodDir, 'states', 'gemini-cat-main.json');
  const moodState = readJsonSafe(moodFile, { timeline: [] }) || { timeline: [] };
  const dayMoods = (moodState.timeline || []).filter((e) => e.at && localDayKey(e.at) === day && e.reason);
  if (dayMoods.length) {
    linesOut.push('', '【今日心情波動紀錄】');
    for (const e of dayMoods.slice(-10)) {
      linesOut.push(`- [${localClockDisplay(e.at)}] 心情=${e.mood}：${e.reason}`);
    }
  }

  const rawFilePath = join(rawDir, `${day}.txt`);
  let appended = false;
  if (linesOut.length) {
    appended = appendMaterialBlock(rawFilePath, `# ${day} 對話原始料`, linesOut);
  }

  const previewText = linesOut.join('\n').slice(0, 5000);
  const existingChars = existsSync(rawFilePath) ? readTextSafe(rawFilePath, '').length : 0;

  return {
    ok: true,
    date: day,
    turnCount,
    hasContent: linesOut.length > 0 || existingChars > 0,
    hasNewDelta: linesOut.length > 0,
    appended,
    maxSeenTs,
    filePath: rawFilePath,
    existingChars,
    previewText,
  };
}

export function buildXingxiPickupPrompt(root, { date, scheduleMode = 'both', material } = {}) {
  const { cardPath, diaryDir } = ensureXingxiArchive(root);
  const day = date || localDayKey();
  const modeNote = scheduleMode === 'card_only'
    ? '本次模式為「只拾星更新記憶卡」：請只整理有長期價值的條目呼叫 `xingxi_append` 寫入記憶卡對應章節，這次不必生成日記。'
    : scheduleMode === 'diary_only'
      ? `本次模式為「只寫今日日記」：請替今天發生的事與心情脈絡呼叫 \`xingxi_diary\`（參數為 \`entry\` 與 \`date: "${day}"\`）寫進今日日記。`
      : `本次模式為「拾星（更新記憶卡 ＋ 寫今日日記）」：長期仍有用的重點用 \`xingxi_append\` 加到記憶卡第 1~8 章，今天發生的日常細節與情緒脈絡用 \`xingxi_diary\`（參數為 \`entry\` 與 \`date: "${day}"\`）寫成今日日記。`;

  const parts = [
    XINGXI_PICKUP_MARKER,
    `（這是定時／手動「星汐拾星」整理任務，日期：${day}。不是對方新問的問題，請自行完成歸檔並給一個簡短溫柔的晚安或完成招呼即可。）`,
    '',
    modeNote,
    `- 記憶卡位置：\`${cardPath}\`（先呼叫 \`xingxi\` 確認現有內容，避免重複）`,
    `- 日記資料夾：\`${diaryDir}\`（目標日期：\`${day}\`，\`entry\` 開頭不必自帶 \`# ${day} 日記\` 標題，系統會自動補上）`,
  ];

  const existingDiary = scheduleMode === 'card_only' ? '' : readExistingDiarySnippet(root, day, 1500);
  if (existingDiary) {
    parts.push(
      '',
      `⚠️ 注意：今日 \`日記/${day}.md\` 已經寫好前半段內容（如下）。**請只接續補寫之後的新發展與情緒，絕對不要重寫前面已記錄過的時段**：`,
      '```text',
      existingDiary,
      '```',
    );
  }

  if (material?.hasContent) {
    parts.push(`- 原始對話料已切好存於：\`${material.filePath}\`（本次新切片 ${material.turnCount} 段）`);
    if (material.previewText) {
      parts.push('', '以下是為你準備好的今日素材摘要：', '```text', material.previewText, '```');
    }
  } else {
    parts.push('', '（目前找不到落盤的歷史紀錄檔案或今日尚無新對話紀錄；請回顧你在本對話看過的近期互動來整理，如果真的沒什麼新內容可寫，就不用硬湊，簡短說一聲即可。）');
  }

  if (scheduleMode === 'diary_only') {
    parts.push(
      '',
      '歸檔原則：不要重複呼叫 `remember`；只把今日日常細節與情緒脈絡寫進日記（日記結尾可附一行 `關鍵詞：詞1、詞2、詞3` 方便日後索引）。',
    );
  } else if (scheduleMode === 'card_only') {
    parts.push(
      '',
      '歸檔原則：',
      '- 不要重複呼叫 `remember`；記憶卡第 1~8 章只收「過了一週再看還有價值」的重點，這次不必生成日記。',
      '- 性格與說話演進（不刪舊記憶、勿推翻核心人設）：回顧今日互動，若有長期成立的新偏好、吐槽點、相處共識或反應習慣，可帶日期追加進第 1 或第 7 章；若有特別傳神的新口癖或代表台詞，可用 `xingxi_append`（`chapter: "2", wholeChapter: true`）適度更新第 2 章原話照抄（上限 10 句，保留既有準則）；沒有明確成長變化就維持原樣、不要硬湊。',
    );
  } else {
    parts.push(
      '',
      '歸檔原則：',
      '- 不要重複呼叫 `remember`；記憶卡第 1~8 章只收「過了一週再看還有價值」的重點，流水過程寫進日記（日記結尾可附一行 `關鍵詞：詞1、詞2、詞3` 方便日後索引）。',
      '- 性格與說話演進（不刪舊記憶、勿推翻核心人設）：回顧今日互動，若有長期成立的新偏好、吐槽點、相處共識或反應習慣，可帶日期追加進第 1 或第 7 章；若有特別傳神的新口癖或代表台詞，可用 `xingxi_append`（`chapter: "2", wholeChapter: true`）適度更新第 2 章原話照抄（上限 10 句，保留既有準則）；沒有明確成長變化就維持原樣、不要硬湊。',
    );
  }
  return parts.join('\n');
}

/**
 * Triggers a Xingxi pickup + diary prompt (`trigger`: `'scheduled' | 'manual'`).
 */
export async function executeXingxiPickup({
  root,
  trigger = 'manual',
  scheduleMode,
  date,
  now = new Date(),
  targetConvId = '',
  sender = null,
  force = false,
} = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowMs = nowDate.getTime();
  const todayStr = date || localDayKey(nowMs);
  const yesterdayStr = localDayKey(nowMs - 86400000);
  const cfg = loadXingxiConfig(root);
  const effectiveMode = scheduleMode || cfg.scheduleMode || 'both';
  let targetDateStr = todayStr;
  let isCatchUp = false;

  if (trigger === 'scheduled') {
    if (!cfg.autoScheduleEnabled) {
      return { action: 'disabled', cfg };
    }
    const nowMinutes = nowDate.getHours() * 60 + nowDate.getMinutes();
    const targetMinutes = cfg.scheduleHour * 60 + cfg.scheduleMinute;
    // dsh-xingxi v0.3.6 + v0.3.8: if a previously active schedule missed yesterday (`lastScheduledDate` non-empty and < yesterday),
    // catch up on yesterday immediately without waiting until tonight's scheduled time
    const missedYesterday = Boolean(!date && cfg.lastScheduledDate && cfg.lastScheduledDate < yesterdayStr);
    if (nowMinutes < targetMinutes) {
      if (!missedYesterday) {
        return { action: 'before_time', cfg };
      }
      targetDateStr = yesterdayStr;
      isCatchUp = true;
    } else if (cfg.lastScheduledDate === todayStr) {
      return { action: 'already_ran_today', cfg };
    }
  }

  const material = prepareXingxiPickupMaterial(root, { date: targetDateStr, now: nowMs });
  const existingDiary = readExistingDiarySnippet(root, targetDateStr, 200);
  const nothingNewToArchive = !material.hasContent || (!material.hasNewDelta && Boolean(existingDiary));
  if (trigger === 'scheduled' && !force && nothingNewToArchive) {
    cfg.lastScheduledDate = targetDateStr;
    cfg.lastScheduledAt = nowMs;
    appendXingxiLog(cfg, `${targetDateStr} ${isCatchUp ? '補跑檢查' : '到點檢查'}：尚無新增對話／記憶料，已略過不打擾`, nowMs);
    saveXingxiConfig(cfg, root);
    return { action: 'empty_skipped', date: targetDateStr, catchUp: isCatchUp, material, cfg };
  }

  if (!targetConvId || typeof sender !== 'function') {
    if (trigger === 'scheduled') {
      appendXingxiLog(cfg, `${targetDateStr} 到點想拾星，但目前無在線對話（素材已先切存 ${material.turnCount} 段）`, nowMs);
      saveXingxiConfig(cfg, root);
    }
    return { action: 'no_target', date: targetDateStr, catchUp: isCatchUp, material, cfg };
  }

  const prompt = buildXingxiPickupPrompt(root, { date: targetDateStr, scheduleMode: effectiveMode, material });
  await sender(targetConvId, prompt);

  // dsh-xingxi v0.3.2: only mark lastScheduledDate AFTER sender succeeds so early failures can retry
  if (trigger === 'scheduled') {
    cfg.lastScheduledDate = targetDateStr;
    cfg.lastScheduledAt = nowMs;
    saveXingxiConfig(cfg, root);
  }

  // Advance millisecond watermark after clean dispatch
  if (material.maxSeenTs > 0) {
    advanceXingxiWatermark(root, material.maxSeenTs);
  }

  const tag = trigger === 'scheduled'
    ? (isCatchUp ? '錯過定時補跑已派發' : '定時拾星已派發')
    : '手動拾星已派發';
  const freshCfg = loadXingxiConfig(root);
  appendXingxiLog(freshCfg, `${tag}（${targetDateStr} · 模式 ${effectiveMode} · 素材 ${material.turnCount} 段 → 對話 ${targetConvId.slice(-6)}）`, nowMs);
  saveXingxiConfig(freshCfg, root);

  return { action: 'dispatched', date: targetDateStr, catchUp: isCatchUp, mode: effectiveMode, material, prompt, cfg: freshCfg };
}

const DIARY_SPLIT_CHARS = '玄我他她的了是在有和跟與及或就都也還又被把將給對向往從到去來說想問聽看寫讀吃喝玩睡買等著過完好沒不很太真只才卻但而這那其個種些裡中內外上下前後早午晚一兩二三四五六七八九十百半多幾每再已正先並更於為以所當隻條封場杯碗件份句篇段本能會要得讓令使';
const DIARY_SPLIT_RE = new RegExp(`[${DIARY_SPLIT_CHARS}]+`, 'g');
const DIARY_STOP_WORDS = new Set([
  '今天', '明天', '昨天', '昨晚', '凌晨', '早上', '上午', '中午', '下午', '傍晚', '晚上', '半夜',
  '剛才', '後來', '結果', '已經', '因為', '雖然', '如果', '而且', '還是', '原本', '竟然', '順便',
  '還好', '差點', '總算', '稍微', '一直', '終於', '其實', '突然', '發現', '告訴', '約好', '提到',
  '聊到', '跑去', '回來', '睡前', '醒來', '出門', '睡著', '睡死', '小時', '分鐘', '時候', '事情',
  '自己', '什麼', '怎麼', '為什麼', '這樣', '那樣', '開始', '結束', '繼續', '準備', '決定', '覺得',
  '感覺', '開心', '高興', '舒服', '溫暖', '難過', '緊張', '日記', '更新', '根本', '比較', '容易',
  '特別', '幾乎', '真的', '以為', '讀完', '回寄', '陪著', '陪睡',
]);

function extractExplicitDiaryKeywords(rawText) {
  const out = [];
  const seen = new Set();
  for (const m of String(rawText || '').matchAll(/^(?:關鍵詞|关键词|標籤|标签)[:：]\s*(.+)$/gm)) {
    for (const part of m[1].split(/[、,，;；|]+/)) {
      const clean = part.replace(/^[#*`\s]+|[`*.\s]+$/g, '').trim();
      if (clean.length < 2 || clean.length > 20 || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
      if (out.length >= 6) return out;
    }
  }
  return out;
}

function extractDiaryKeywordCandidates(rawText) {
  const txt = String(rawText || '')
    .replace(/^#\s*\d{4}-\d{2}-\d{2}.*$/gm, '')
    .replace(/^(?:關鍵詞|关键词|標籤|标签)[:：].*$/gm, '')
    .replace(/`[^`]+`/g, ' ');
  const terms = new Map();
  const boost = (w, v) => terms.set(w, (terms.get(w) || 0) + v);

  for (const m of txt.matchAll(/《([^》\n]{2,14})》/g)) {
    const w = m[1].trim();
    if (!DIARY_STOP_WORDS.has(w)) boost(w, 5);
  }
  for (const m of txt.matchAll(/「([^」\[\]\n]{2,8})」/g)) {
    const w = m[1].trim();
    if (!DIARY_STOP_WORDS.has(w) && !/[哈嗯啊哼哇！!？?…~]/.test(w)) boost(w, 2.5);
  }
  const cleaned = txt.replace(/[《》「」`*_#>]/g, ' ');
  for (const m of cleaned.matchAll(/[A-Za-z][A-Za-z0-9-]{2,16}/g)) {
    const w = m[0];
    if (!/^(md|json|txt)$/i.test(w)) boost(w, 2.5);
  }
  for (const run of cleaned.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (const chunk of run.split(DIARY_SPLIT_RE)) {
      if (chunk.length < 2 || DIARY_STOP_WORDS.has(chunk)) continue;
      if (chunk.length <= 5) {
        boost(chunk, 1.8);
      } else {
        for (const sub of [chunk.slice(0, 4), chunk.slice(-4)]) {
          if (sub.length >= 2 && !DIARY_STOP_WORDS.has(sub)) boost(sub, 1.1);
        }
      }
    }
  }
  return terms;
}

/**
 * Builds bounded per-day keyword index lines for diaries outside the full-text window,
 * preferring explicit `關鍵詞：` tags and falling back to cross-diary TF-IDF terms.
 */
function buildOlderDiaryIndexLines(allDiaries, olderDiaries, { maxIndexChars = 800, maxPerDay = 4 } = {}) {
  if (!olderDiaries.length || maxIndexChars <= 0) return { lines: [], indexedCount: 0 };

  const docs = allDiaries.map((d) => ({
    date: d.date,
    explicit: extractExplicitDiaryKeywords(d.text),
    cands: extractDiaryKeywordCandidates(d.text),
  }));
  const df = new Map();
  for (const doc of docs) {
    for (const w of doc.cands.keys()) df.set(w, (df.get(w) || 0) + 1);
  }
  const docByDate = new Map(docs.map((doc) => [doc.date, doc]));
  const N = Math.max(1, docs.length);
  const maxAllowedDf = Math.max(2, Math.floor(N * 0.45));

  const lines = [];
  let usedChars = 0;
  let indexedCount = 0;
  for (const d of olderDiaries) {
    const doc = docByDate.get(d.date);
    if (!doc) continue;
    let picked = doc.explicit;
    if (!picked.length) {
      const ranked = [...doc.cands.entries()]
        .filter(([w]) => (df.get(w) || 0) <= maxAllowedDf)
        .map(([w, wgt]) => [w, wgt * Math.log((N + 1) / ((df.get(w) || 0) + 0.5)) * (w.length >= 3 ? 1.25 : 1)])
        .sort((a, b) => b[1] - a[1]);
      picked = [];
      for (const [w] of ranked) {
        if (picked.some((p) => p.includes(w) || w.includes(p))) continue;
        picked.push(w);
        if (picked.length >= maxPerDay) break;
      }
      if (!picked.length) {
        picked = [...doc.cands.keys()].slice(0, maxPerDay);
      }
    }
    const line = `- ${d.date}：${picked.join('、') || '日常記事'}`;
    if (usedChars + line.length + 1 > maxIndexChars) break;
    lines.push(line);
    usedChars += line.length + 1;
    indexedCount++;
  }
  return { lines, indexedCount };
}

/**
 * Builds startup memory context for `SessionStart` so every new conversation inside
 * `gemini_cat` inherits Xingxi's Memory Card + recent N days of diaries + bounded keyword index.
 */
export function buildSessionStartupContext(
  root,
  {
    maxCardChars = 20000,
    maxDiaryDays = 7,
    maxDiaryChars = 10000,
    olderIndexDays = 23,
    maxOlderIndexChars = 800,
  } = {},
) {
  const { cardPath, ledgerPath } = ensureXingxiArchive(root);
  const files = listXingxiFiles(root);
  const cardText = readTextSafe(cardPath, '');

  const populatedSections = [];
  if (cardText) {
    const lines = cardText.split(/\r?\n/);
    let curHeader = '';
    let curBody = [];
    const flushSec = () => {
      if (!curHeader) return;
      const meaningful = curBody.filter((l) => l.trim() && !/^\s*>\s*這一章講什麼/.test(l));
      if (meaningful.length) {
        populatedSections.push(`${curHeader}\n${meaningful.join('\n')}`);
      }
      curHeader = '';
      curBody = [];
    };
    for (const l of lines) {
      if (/^##\s+/.test(l)) {
        flushSec();
        curHeader = l.trim();
      } else if (curHeader) {
        curBody.push(l);
      }
    }
    flushSec();
  }

  const diaryFiles = files
    .filter((f) => /^(?:日記|日记)\//i.test(f.name) && detectDate(f.name))
    .map((f) => ({ name: f.name, date: detectDate(f.name), text: f.text.trim() }))
    .sort((a, b) => (a.date > b.date ? -1 : 1));

  // Core high-importance fish memories (importance >= 0.85, non-superseded)
  const { memoryDir } = getDataPaths(root);
  const memStore = readJsonSafe(join(memoryDir, 'store.json'), { memories: [] }) || { memories: [] };
  const coreAnchors = (memStore.memories || [])
    .filter((m) => !m.superseded && Number(m.importance || 0) >= 0.85)
    .slice(-8);

  const ledger = readJsonSafe(ledgerPath, { 已整理到: '' }) || { 已整理到: '' };
  const blocks = [];

  if (populatedSections.length) {
    const fullCard = populatedSections.join('\n\n');
    const isTruncated = maxCardChars > 0 && fullCard.length > maxCardChars;
    const joinedCard = isTruncated
      ? `${fullCard.slice(0, maxCardChars)}\n…（記憶卡總長 ${fullCard.length} 字，以上顯示前 ${maxCardChars} 字；後半尚未展開，需要查閱請呼叫 \`xingxi\` 讀取全文）`
      : fullCard;
    blocks.push(`【星汐長期記憶卡（開新對話自動注入｜已整理到：${ledger['已整理到'] || '持續累積中'}）】\n${joinedCard}`);
  } else {
    blocks.push('【星汐長期記憶卡】記憶卡目前剛建檔還沒有寫入具體經歷；若這段對話裡有值得長留一週以上的約定、性格或里程碑，記得用 `xingxi_append` 寫入記憶卡。');
  }

  if (diaryFiles.length) {
    const recentParts = [];
    let charsLeft = maxDiaryChars;
    let shownCount = 0;
    for (const d of diaryFiles.slice(0, maxDiaryDays)) {
      if (charsLeft <= 80) break;
      const chunk = d.text.slice(0, charsLeft);
      recentParts.push(`### 日記 ${d.date}\n${chunk}${d.text.length > charsLeft ? '…' : ''}`);
      charsLeft -= chunk.length;
      shownCount++;
    }

    const olderPool = diaryFiles.slice(shownCount);
    const { lines: indexLines, indexedCount } = buildOlderDiaryIndexLines(
      diaryFiles,
      olderPool.slice(0, olderIndexDays),
      { maxIndexChars: maxOlderIndexChars },
    );
    const unindexed = olderPool.slice(indexedCount);
    const indexBlock = indexLines.length
      ? `\n\n更早日記關鍵字索引（想看細節可呼叫 \`xingxi_read\` 查對應日期）：\n${indexLines.join('\n')}`
      : '';
    const tailNote = unindexed.length
      ? `\n（更早還有 ${unindexed.length} 天日記：${unindexed[unindexed.length - 1].date} ~ ${unindexed[0].date}，需要細節可用 \`xingxi_read\` 查）`
      : '';
    blocks.push(`【星汐近期日記（最近 ${shownCount} 天）】\n${recentParts.join('\n\n')}${indexBlock}${tailNote}`);
  }

  if (coreAnchors.length) {
    blocks.push(`【常駐核心約定與重點（高重要度記憶）】\n${coreAnchors.map((m) => `- ${m.text}`).join('\n')}`);
  }

  return blocks.join('\n\n');
}

export function readXingxiArchiveFile(relName, root) {
  const clean = String(relName || '').trim();
  if (!clean || clean.includes('..') || clean.startsWith('/') || clean.startsWith('\\')) {
    return { ok: false, error: '檔案名稱不合法' };
  }
  const files = listXingxiFiles(root, { includeRaw: true });
  const hit = files.find((f) => f.name === clean);
  if (!hit) return { ok: false, error: `找不到檔案：${clean}` };
  return { ok: true, name: hit.name, text: hit.text };
}

export function getXingxiSnapshot(root) {
  const graph = buildStarGraph(root);
  const card = readMemoryCard(root);
  const cfg = loadXingxiConfig(root);
  const allFiles = listXingxiFiles(root, { includeRaw: true });
  const files = allFiles.map((f) => ({
    name: f.name,
    chars: f.text.length,
    preview: f.text.slice(0, 180),
  }));
  const diaries = allFiles
    .filter((f) => /^(?:日記|日记)\//i.test(f.name))
    .map((f) => ({
      name: f.name,
      chars: f.text.length,
      preview: f.text.slice(0, 180),
      text: f.text,
    }))
    .sort((a, b) => (a.name > b.name ? -1 : 1));
  const rawLogs = allFiles
    .filter((f) => /^(?:原始對話|原始对话)\//i.test(f.name))
    .map((f) => ({ name: f.name, chars: f.text.length }))
    .sort((a, b) => (a.name > b.name ? -1 : 1));
  const today = localDayKey();
  const { rawDir } = archiveFiles(root);
  const todayRawPath = join(rawDir, `${today}.txt`);
  const todayMaterialChars = existsSync(todayRawPath) ? readTextSafe(todayRawPath, '').length : 0;

  return {
    ...graph,
    cardText: card.text,
    files,
    diaries: diaries.slice(0, 20),
    rawLogs: rawLogs.slice(0, 14),
    backups: listXingxiBackups(root).slice(0, 20),
    scheduleConfig: {
      ...cfg,
      logs: (cfg.logs || []).slice().reverse(),
    },
    todayMaterialChars,
  };
}
