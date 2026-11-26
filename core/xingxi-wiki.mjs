/**
 * @fileoverview Open-ended topic Wiki (`data/xingxi/認識/*.md` + `目錄.md`) with live
 * `[[bidirectional links]]`, daily `.history/` backups, path traversal protection,
 * compact catalog rendering, and gap diagnostics for `agy-gemini-chan`.
 *
 * Strictly lower-triangular: depends ONLY on `node:fs`, `node:path`, and `./storage.mjs`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import {
  clampNum,
  getDataPaths,
  getProjectRoot,
  localDayKey,
  readTextSafe,
  writeTextAtomic,
} from './storage.mjs';

export const WIKI_DIR_NAME = '認識';
export const WIKI_DIR_ALT_NAME = '认识';
export const WIKI_CATALOG_TITLE = '目錄';
export const WIKI_HISTORY_DIR_NAME = '.history';
export const DEFAULT_CATALOG_CAP = 2000;
export const DEFAULT_OPEN_LIMIT = 2000;
export const MAX_OPEN_LIMIT = 8000;
export const MAX_WIKI_PAGE_CHARS = 30000;

const INVALID_TITLE_RE = /[<>:"/\\|?*\x00-\x1f]/;
const WIKI_LINK_RE = /\[\[([^\[\]\r\n]{1,64})\]\]/g;

export function isCatalogTitle(title) {
  const clean = sanitizeWikiTitle(title);
  return clean === '目錄' || clean === '目录';
}

/**
 * Sanitizes a topic page title into a safe filename stem.
 * Returns `''` if the title is empty or attempts path traversal / uses illegal path chars.
 */
export function sanitizeWikiTitle(rawTitle) {
  let s = String(rawTitle || '').trim();
  if (!s) return '';
  if (s.startsWith('[[') && s.endsWith(']]')) {
    s = s.slice(2, -2).trim();
  }
  if (s.includes('|')) {
    s = s.split('|')[0].trim();
  }
  if (!s || s === '.' || s === '..' || s.startsWith('.') || s.includes('..') || INVALID_TITLE_RE.test(s)) {
    return '';
  }
  s = s.replace(/\.(?:md|txt)$/i, '').trim();
  if (!s || s === '.' || s === '..' || s.startsWith('.') || s.includes('..') || INVALID_TITLE_RE.test(s)) {
    return '';
  }
  if (s.length > 48) {
    s = s.slice(0, 48).trim();
  }
  if (!s || s === '.' || s === '..' || s.endsWith('.')) return '';
  return s;
}

/**
 * Case-insensitive normalized key for matching titles consistently on Windows & POSIX.
 */
export function normalizeTitleKey(title) {
  const clean = sanitizeWikiTitle(title);
  if (!clean) return '';
  if (clean === '目录') return '目錄';
  return clean.toLowerCase();
}

export function getWikiDir(root = getProjectRoot()) {
  return join(getDataPaths(root).xingxiDir, WIKI_DIR_NAME);
}

function isInsideDir(targetPath, baseDir) {
  const normBase = resolve(baseDir).toLowerCase();
  const normTarget = resolve(targetPath).toLowerCase();
  return normTarget.startsWith(normBase + sep);
}

function resolveSafeWikiFilePath(wikiDir, safeTitle) {
  const candidate = resolve(wikiDir, `${safeTitle}.md`);
  if (!isInsideDir(candidate, wikiDir)) return '';
  if (existsSync(wikiDir)) {
    try {
      const realBase = realpathSync.native(wikiDir).toLowerCase();
      const realCand = existsSync(candidate)
        ? realpathSync.native(candidate).toLowerCase()
        : resolve(realBase, `${safeTitle}.md`).toLowerCase();
      if (!realCand.startsWith(realBase + sep)) return '';
    } catch {
      return '';
    }
  }
  return candidate;
}

/**
 * Extracts unique `[[Title]]` links in order of appearance, excluding empty, invalid,
 * and self-referential links.
 */
export function extractWikiLinks(content, selfTitle = '') {
  const selfKey = normalizeTitleKey(selfTitle);
  const out = [];
  const seen = new Set();
  for (const m of String(content || '').matchAll(WIKI_LINK_RE)) {
    const clean = sanitizeWikiTitle(m[1]);
    if (!clean) continue;
    const key = normalizeTitleKey(clean);
    if (!key || key === selfKey || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

/**
 * Lists all Markdown pages inside `data/xingxi/認識/` (plus read-only fallback for `认识/`).
 * Excludes `.history/` and `.bak-*` backup files.
 */
export function listWikiPages(root = getProjectRoot()) {
  const { xingxiDir } = getDataPaths(root);
  const dirs = [
    { dir: join(xingxiDir, WIKI_DIR_NAME), prefix: WIKI_DIR_NAME },
    { dir: join(xingxiDir, WIKI_DIR_ALT_NAME), prefix: WIKI_DIR_ALT_NAME },
  ];
  const pages = [];
  const seenKeys = new Set();

  for (const { dir, prefix } of dirs) {
    if (!existsSync(dir)) continue;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (ent.name.startsWith('.') || ent.name.includes('.bak-')) continue;
      if (extname(ent.name).toLowerCase() !== '.md') continue;
      const rawStem = ent.name.slice(0, -3);
      const title = sanitizeWikiTitle(rawStem);
      const key = normalizeTitleKey(title);
      if (!title || !key || seenKeys.has(key)) continue;

      const fullPath = resolveSafeWikiFilePath(dir, title);
      if (!fullPath) continue;
      const content = readTextSafe(fullPath, '');
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(fullPath).mtimeMs || 0;
      } catch { /* ignore */ }
      seenKeys.add(key);
      pages.push({
        title,
        key,
        isCatalog: isCatalogTitle(title),
        fileName: ent.name,
        relPath: `${prefix}/${ent.name}`,
        path: fullPath,
        content,
        chars: content.length,
        mtimeMs,
        links: extractWikiLinks(content, title),
      });
    }
  }

  pages.sort((a, b) => (b.mtimeMs - a.mtimeMs) || a.title.localeCompare(b.title, 'zh-Hant'));
  return pages;
}

/**
 * Computes live bidirectional relations (`links`, `linkedFrom`, `missing`) for `targetPage`.
 */
export function computePageRelations(targetPage, allPages, { maxLinks = 20 } = {}) {
  const pageByKey = new Map();
  for (const p of allPages || []) pageByKey.set(p.key, p);

  const allOut = [];
  const missing = [];
  for (const rawLink of targetPage?.links || []) {
    const k = normalizeTitleKey(rawLink);
    if (!k) continue;
    const hit = pageByKey.get(k);
    if (hit) {
      allOut.push(hit.title);
    } else {
      allOut.push(rawLink);
      missing.push(rawLink);
    }
  }

  const allIn = [];
  const seenIn = new Set();
  for (const p of allPages || []) {
    if (!p || p.key === targetPage.key || p.isCatalog) continue;
    const hasLink = (p.links || []).some((l) => normalizeTitleKey(l) === targetPage.key);
    if (hasLink && !seenIn.has(p.key)) {
      seenIn.add(p.key);
      allIn.push(p.title);
    }
  }

  const links = allOut.slice(0, maxLinks);
  const linkedFrom = allIn.slice(0, maxLinks);
  const more = {};
  if (allOut.length > maxLinks) more.links = allOut.length - maxLinks;
  if (allIn.length > maxLinks) more.linkedFrom = allIn.length - maxLinks;

  return {
    links,
    linkedFrom,
    missing,
    ...(Object.keys(more).length ? { more } : {}),
  };
}

/**
 * Suggests close existing page titles when an exact match is not found.
 */
export function findNearTitles(allPages, rawTitle, limit = 6) {
  const needle = String(rawTitle || '').trim().toLowerCase();
  const nonCatalog = (allPages || []).filter((p) => !p.isCatalog);
  const scored = [];
  if (needle) {
    for (const p of nonCatalog) {
      const lo = p.title.toLowerCase();
      if (lo.includes(needle) || needle.includes(lo)) {
        scored.push(p.title);
      }
    }
  }
  const seen = new Set(scored);
  for (const p of nonCatalog) {
    if (scored.length >= limit) break;
    if (!seen.has(p.title)) {
      seen.add(p.title);
      scored.push(p.title);
    }
  }
  return scored.slice(0, limit);
}

/**
 * Opens a topic Wiki page by title with bounded paging and live bidirectional links.
 */
export function openWikiPage(root, rawTitle, { offset = 0, limit = DEFAULT_OPEN_LIMIT } = {}) {
  const cleanTitle = sanitizeWikiTitle(rawTitle);
  const allPages = listWikiPages(root);
  if (!cleanTitle) {
    return {
      ok: false,
      error: '主題標題不合法（不可為空或包含路徑字元）',
      suggestions: findNearTitles(allPages, rawTitle),
    };
  }

  const key = normalizeTitleKey(cleanTitle);
  const page = allPages.find((p) => p.key === key);
  if (!page) {
    return {
      ok: false,
      error: `找不到主題認識頁「${cleanTitle}」`,
      suggestions: findNearTitles(allPages, cleanTitle),
    };
  }

  const safeLimit = Math.round(clampNum(limit, 200, MAX_OPEN_LIMIT, DEFAULT_OPEN_LIMIT));
  const safeOffset = Math.max(0, Math.round(Number(offset) || 0));
  const totalChars = page.content.length;
  const slice = page.content.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = (safeOffset + slice.length) < totalChars ? (safeOffset + slice.length) : null;

  return {
    ok: true,
    title: page.title,
    relPath: page.relPath,
    totalChars,
    offset: safeOffset,
    content: slice,
    truncated: nextOffset !== null,
    nextOffset,
    relations: computePageRelations(page, allPages),
  };
}

/**
 * Creates, updates, or deletes a topic Wiki page (`data/xingxi/認識/<title>.md`) atomically,
 * preserving one initial `.history/<title>-<YYYY-MM-DD>.md` snapshot per day on overwrite or delete.
 */
export function writeWikiPage(root, { title, content = '', mode = 'replace', now = Date.now() } = {}) {
  const rawSafe = sanitizeWikiTitle(title);
  if (!rawSafe) {
    return { ok: false, error: '主題標題不合法（不可為空、含 .. 或路徑非法字元）' };
  }
  const canonicalTitle = isCatalogTitle(rawSafe) ? WIKI_CATALOG_TITLE : rawSafe;
  const wikiDir = getWikiDir(root);
  const targetPath = resolveSafeWikiFilePath(wikiDir, canonicalTitle);
  if (!targetPath) {
    return { ok: false, error: '目標路徑超出認識頁安全範圍' };
  }

  const backupExisting = () => {
    const historyDir = join(wikiDir, WIKI_HISTORY_DIR_NAME);
    mkdirSync(historyDir, { recursive: true });
    const day = localDayKey(now);
    const histPath = resolve(historyDir, `${canonicalTitle}-${day}.md`);
    if (isInsideDir(histPath, historyDir) && !existsSync(histPath)) {
      try {
        copyFileSync(targetPath, histPath);
        return { backupCreated: true, backupPath: histPath };
      } catch { /* ignore backup error */ }
    }
    return { backupCreated: false, backupPath: '' };
  };

  if (mode === 'delete') {
    if (canonicalTitle === WIKI_CATALOG_TITLE) {
      return { ok: false, error: '總目錄「目錄」不可刪除，請改用 replace 更新內容' };
    }
    if (!existsSync(targetPath)) {
      return { ok: false, error: `找不到主題認識頁「${canonicalTitle}」` };
    }
    const beforePages = listWikiPages(root);
    const targetPage = beforePages.find((p) => p.key === normalizeTitleKey(canonicalTitle));
    const prevRelations = targetPage ? computePageRelations(targetPage, beforePages) : { linkedFrom: [] };
    const { backupCreated, backupPath } = backupExisting();
    try {
      unlinkSync(targetPath);
    } catch (err) {
      return { ok: false, error: `刪除失敗：${err?.message || String(err)}` };
    }
    return {
      ok: true,
      deleted: true,
      title: canonicalTitle,
      path: targetPath,
      relPath: `${WIKI_DIR_NAME}/${canonicalTitle}.md`,
      mode: 'delete',
      backupCreated,
      backupPath,
      linkedFrom: prevRelations.linkedFrom || [],
    };
  }

  const body = String(content || '').trim();
  if (!body) {
    return { ok: false, error: '內容不可為空' };
  }
  if (body.length > MAX_WIKI_PAGE_CHARS) {
    return { ok: false, error: `單頁內容超過上限（最多 ${MAX_WIKI_PAGE_CHARS} 字）` };
  }

  mkdirSync(wikiDir, { recursive: true });

  const existed = existsSync(targetPath);
  const prevText = existed ? readTextSafe(targetPath, '') : '';
  const effectiveMode = canonicalTitle === WIKI_CATALOG_TITLE
    ? 'replace'
    : (mode === 'append' ? 'append' : 'replace');

  let finalText = body;
  let skipped = false;
  if (effectiveMode === 'append' && prevText.trim()) {
    const prevTrim = prevText.trimEnd();
    if (prevTrim.endsWith(body)) {
      finalText = prevText;
      skipped = true;
    } else {
      finalText = `${prevTrim}\n\n${body}`;
    }
  }

  if (finalText.length > MAX_WIKI_PAGE_CHARS) {
    return { ok: false, error: `追加後單頁超過上限（最多 ${MAX_WIKI_PAGE_CHARS} 字）` };
  }

  let backupCreated = false;
  let backupPath = '';
  if (!skipped) {
    if (existed && prevText.trim()) {
      const b = backupExisting();
      backupCreated = b.backupCreated;
      backupPath = b.backupPath;
    }
    writeTextAtomic(targetPath, finalText.endsWith('\n') ? finalText : `${finalText}\n`);
  }

  const allPages = listWikiPages(root);
  const savedKey = normalizeTitleKey(canonicalTitle);
  const savedPage = allPages.find((p) => p.key === savedKey);
  const relations = savedPage
    ? computePageRelations(savedPage, allPages)
    : { links: extractWikiLinks(finalText, canonicalTitle), linkedFrom: [], missing: [] };

  let inCatalog = true;
  if (canonicalTitle !== WIKI_CATALOG_TITLE) {
    const catalog = allPages.find((p) => p.isCatalog);
    const catalogLinks = new Set((catalog?.links || []).map((l) => normalizeTitleKey(l)));
    const catalogRawLo = String(catalog?.content || '').toLowerCase();
    inCatalog = Boolean(
      catalog && (catalogLinks.has(savedKey) || catalogRawLo.includes(canonicalTitle.toLowerCase())),
    );
  }

  return {
    ok: true,
    title: canonicalTitle,
    path: targetPath,
    relPath: `${WIKI_DIR_NAME}/${canonicalTitle}.md`,
    chars: finalText.length,
    mode: effectiveMode,
    skipped,
    backupCreated,
    backupPath,
    inCatalog,
    links: relations.links,
    missing: relations.missing,
  };
}

/**
 * Renders the compact startup Wiki catalog block (`<= maxChars`).
 * Returns `''` when no Wiki pages exist yet (0 Token overhead for legacy users).
 */
export function renderWikiCatalogBlock(root, { maxChars = DEFAULT_CATALOG_CAP, header = '' } = {}) {
  const allPages = listWikiPages(root);
  const catalog = allPages.find((p) => p.isCatalog);
  const topicPages = allPages.filter((p) => !p.isCatalog);
  if (!catalog && !topicPages.length) return '';

  const head = String(header || '').trim() ||
    `【我寫過的認識】頁面在 ${getWikiDir(root)}，一個主題一個檔案，頁和頁用 [[標題]] 互相連結。想看哪一頁，用 \`xingxi_open\` 寫頁名打開；想查哪一頁提到過某件事，用 \`xingxi_read\`（填 \`keyword\`，可設 \`kind: "wiki"\`）。`;

  const cap = Math.max(200, Number(maxChars) || DEFAULT_CATALOG_CAP);
  if (catalog && catalog.content.trim()) {
    const raw = catalog.content.trim();
    const truncated = raw.length > cap;
    const body = truncated
      ? `${raw.slice(0, cap)}\n…（目錄尚餘 ${raw.length - cap} 字，可用 \`xingxi_open({ title: "目錄", offset: ${cap} })\` 翻閱）`
      : raw;
    return `${head}\n${body}`;
  }

  // Fallback when topic pages exist but `目錄.md` hasn't been written yet
  const lines = [];
  let used = 0;
  for (const p of topicPages) {
    const line = `- [[${p.title}]]`;
    if (used + line.length + 1 > cap) break;
    lines.push(line);
    used += line.length + 1;
  }
  const hiddenCount = topicPages.length - lines.length;
  const tail = hiddenCount > 0
    ? `\n…（尚有 ${hiddenCount} 頁未列，建議整理時建立 \`目錄.md\`）`
    : '\n（尚未撰寫 `目錄.md`，請用 `xingxi_wiki_write({ title: "目錄", ... })` 補上一行式索引，每頁只寫簡介、不寫結論）';
  return `${head}\n${lines.join('\n')}${tail}`;
}

/**
 * Analyzes broken `[[links]]` and topic pages missing from `目錄.md`.
 */
export function analyzeWikiGaps(root) {
  const allPages = listWikiPages(root);
  const catalog = allPages.find((p) => p.isCatalog);
  const topicPages = allPages.filter((p) => !p.isCatalog);
  const keySet = new Set(allPages.map((p) => p.key));

  const broken = [];
  const seenBroken = new Set();
  for (const p of allPages) {
    for (const target of p.links || []) {
      const k = normalizeTitleKey(target);
      if (k && !keySet.has(k)) {
        const pair = `${p.title} → ${target}`;
        if (!seenBroken.has(pair)) {
          seenBroken.add(pair);
          broken.push(pair);
        }
      }
    }
  }

  const outsideCatalog = [];
  if (topicPages.length) {
    const catalogLinks = new Set((catalog?.links || []).map((l) => normalizeTitleKey(l)));
    const catalogRawLo = String(catalog?.content || '').toLowerCase();
    for (const p of topicPages) {
      if (!catalog || (!catalogLinks.has(p.key) && !catalogRawLo.includes(p.title.toLowerCase()))) {
        outsideCatalog.push(p.title);
      }
    }
  }

  return { broken, outsideCatalog };
}

/**
 * Formats a concise one-line gap report for `buildXingxiPickupPrompt`, or `''` when clean.
 */
export function buildWikiGapReport(root) {
  const { broken, outsideCatalog } = analyzeWikiGaps(root);
  if (!broken.length && !outsideCatalog.length) return '';
  const parts = [];
  if (broken.length) {
    parts.push(`有 ${broken.length} 處斷鏈（${broken.slice(0, 5).join('、')}${broken.length > 5 ? '…' : ''}）`);
  }
  if (outsideCatalog.length) {
    parts.push(`有 ${outsideCatalog.length} 頁未收進目錄（${outsideCatalog.slice(0, 5).join('、')}${outsideCatalog.length > 5 ? '…' : ''}）`);
  }
  return `認識頁檢查：${parts.join('；')}。`;
}

/**
 * Searches all Wiki pages by title and content, returning bounded excerpts + live relations.
 */
export function searchWikiPages(root, keyword, { limit = 8, excerptChars = 200, includeRelations = false } = {}) {
  const q = String(keyword || '').trim().toLowerCase();
  if (!q) return [];
  const allPages = listWikiPages(root);
  const hits = [];
  for (const p of allPages) {
    const titleHit = p.title.toLowerCase().includes(q);
    const bodyLo = p.content.toLowerCase();
    const idx = bodyLo.indexOf(q);
    if (!titleHit && idx < 0) continue;
    let excerpt = '';
    if (idx >= 0) {
      const start = Math.max(0, idx - Math.floor(excerptChars * 0.35));
      excerpt = p.content.slice(start, start + excerptChars).replace(/\s+/g, ' ').trim();
      if (start > 0) excerpt = `…${excerpt}`;
      if (start + excerptChars < p.content.length) excerpt = `${excerpt}…`;
    } else {
      excerpt = p.content.slice(0, excerptChars).replace(/\s+/g, ' ').trim();
      if (p.content.length > excerptChars) excerpt = `${excerpt}…`;
    }
    const row = {
      title: p.title,
      relPath: p.relPath,
      chars: p.chars,
      excerpt,
    };
    if (includeRelations) {
      row.relations = computePageRelations(p, allPages);
    }
    hits.push(row);
    if (hits.length >= limit) break;
  }
  return hits;
}
