/**
 * @fileoverview Lightweight, zero-dependency fresh web discovery for Speak-Up (`外網新鮮見聞`).
 *
 * Design principles:
 * - Opt-in ONLY (`enabled: false` by default). Never crawls arbitrary HTML pages or calls external LLMs.
 * - Strictly validates HTTPS URLs & blocks private/loopback/link-local IPs + DNS rebinding (SSRF guard).
 * - Polls at most twice per day during configurable morning/evening windows when Sidecar is alive.
 * - Filters items <= `maxAgeHours` (default 48h), neutralizes embedded control markers, deduplicates
 *   shared keys, and injects up to 1-3 ambient candidates into `<speak-up>` with explicit instruction
 *   that the companion may freely skip them and never act like a news anchor.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import {
  clampNum,
  getDataPaths,
  getProjectRoot,
  localDayKey,
  neutralizeControlMarkers,
  readJsonSafe,
  updateJsonLocked,
} from './storage.mjs';

const MAX_FEED_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 6000;
const MAX_REDIRECT_HOPS = 3;
const MAX_CUSTOM_FEEDS = 15;
const MAX_STORED_ITEMS = 32;
const MAX_SEEN_KEYS = 250;

export const FRESH_PRESET_PACKS = {
  science: {
    id: 'science',
    name: '科學冷知識',
    desc: 'PanSci 泛科學（動物、宇宙、研究趣聞）',
    feeds: [{ label: 'PanSci 泛科學', url: 'https://pansci.asia/feed' }],
  },
  acg: {
    id: 'acg',
    name: '遊戲 / ACG',
    desc: '巴哈姆特 GNN 新聞',
    feeds: [{ label: '巴哈姆特 GNN', url: 'https://gnn.gamer.com.tw/rss.xml' }],
  },
  tech: {
    id: 'tech',
    name: '科技與數位生活',
    desc: 'TechNews 科技新報 / iThome',
    feeds: [
      { label: 'TechNews 科技新報', url: 'https://technews.tw/feed/' },
      { label: 'iThome', url: 'https://www.ithome.com.tw/rss' },
    ],
  },
  dev: {
    id: 'dev',
    name: '程式社群討論',
    desc: 'Lobste.rs 精選工程議題',
    feeds: [{ label: 'Lobste.rs', url: 'https://lobste.rs/rss' }],
  },
  weather: {
    id: 'weather',
    name: '異常天氣叮嚀',
    desc: '僅在明顯降溫或高降雨機率時提醒（需填寫城市）',
    feeds: [],
  },
};

export const DEFAULT_FRESH_BROWSE_CONFIG = {
  enabled: false,
  dailyShareLimit: 2,
  maxAgeHours: 48,
  presets: ['science', 'acg'],
  weatherCity: '',
  weatherLat: null,
  weatherLon: null,
  weatherResolvedCity: '',
  customFeeds: [],
};

function cacheFilePath(root = getProjectRoot()) {
  return join(getDataPaths(root).speakUpDir, 'fresh-picks.json');
}

function defaultCacheState() {
  return {
    version: 1,
    dayKey: '',
    todaySlotsUsed: [],
    todayFetchCount: 0,
    lastCheckedAt: 0,
    lastSuccessAt: 0,
    lastError: '',
    shareDayKey: '',
    todayShareCount: 0,
    lastWeatherAlertDay: '',
    items: [],
    recentShared: [],
    seenKeys: [],
  };
}

function formatDayAndHour(ms, timezone = '') {
  try {
    if (timezone) {
      const dParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(new Date(ms));
      const map = Object.fromEntries(dParts.map((p) => [p.type, p.value]));
      return {
        dayKey: `${map.year}-${map.month}-${map.day}`,
        hour: Number(map.hour) % 24,
      };
    }
  } catch {
    // Fallback to local clock
  }
  const d = new Date(ms);
  return {
    dayKey: localDayKey(ms),
    hour: d.getHours(),
  };
}

/**
 * Checks whether an IPv4 or IPv6 literal falls into loopback, private, link-local,
 * CGNAT, multicast, or unspecified address ranges (prevents SSRF to local services).
 */
export function isPrivateOrReservedIp(ip = '') {
  let clean = String(ip || '').trim().toLowerCase();
  if (!clean) return true;
  if (clean.startsWith('[') && clean.endsWith(']')) clean = clean.slice(1, -1);
  const zoneIdx = clean.indexOf('%');
  if (zoneIdx >= 0) clean = clean.slice(0, zoneIdx);

  // Unwrap IPv4-mapped IPv6 (`::ffff:127.0.0.1` or `::ffff:7f00:1`)
  if (clean.startsWith('::ffff:')) {
    const tail = clean.slice(7);
    if (isIP(tail) === 4) {
      clean = tail;
    } else if (/^[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(tail)) {
      const [hi, lo] = tail.split(':').map((h) => parseInt(h, 16));
      clean = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }

  const ver = isIP(clean);
  if (ver === 4) {
    const parts = clean.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a >= 224) return true;
    return false;
  }

  if (ver === 6) {
    if (clean === '::' || clean === '::1') return true;
    const firstHextet = parseInt(clean.split(':')[0] || '0', 16);
    if (Number.isNaN(firstHextet)) return true;
    // fc00::/7 (ULA), fe80::/10 (link-local), ff00::/8 (multicast)
    if ((firstHextet & 0xfe00) === 0xfc00) return true;
    if ((firstHextet & 0xffc0) === 0xfe80) return true;
    if ((firstHextet & 0xff00) === 0xff00) return true;
    return false;
  }

  return true;
}

/**
 * Normalizes user-supplied YouTube channel links / channel IDs into standard Atom feed URLs
 * and validates strictly for safe external HTTPS endpoints.
 */
export function normalizeYouTubeOrFeedUrl(raw = '') {
  const s = String(raw || '').trim();
  if (!s) return { ok: false, url: '', error: '請輸入 RSS / Atom 網址或 YouTube 頻道連結' };

  if (/^UC[A-Za-z0-9_-]{20,}$/.test(s)) {
    return {
      ok: true,
      url: `https://www.youtube.com/feeds/videos.xml?channel_id=${s}`,
      isYouTube: true,
      needsHandleResolve: false,
    };
  }

  let candidate = s;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  const checked = validateExternalFeedUrl(candidate);
  if (!checked.ok) return checked;

  const u = new URL(checked.url);
  const host = u.hostname.toLowerCase();
  const isYtHost = host === 'youtube.com' || host === 'www.youtube.com' || host === 'm.youtube.com';
  if (isYtHost) {
    const chMatch = /^\/channel\/(UC[A-Za-z0-9_-]{20,})/i.exec(u.pathname);
    if (chMatch) {
      return {
        ok: true,
        url: `https://www.youtube.com/feeds/videos.xml?channel_id=${chMatch[1]}`,
        isYouTube: true,
        needsHandleResolve: false,
      };
    }
    if (u.pathname.startsWith('/feeds/videos.xml')) {
      return { ok: true, url: u.toString(), isYouTube: true, needsHandleResolve: false };
    }
    if (/^\/@[^/]+/.test(u.pathname) || /^\/(?:c|user)\/[^/]+/.test(u.pathname)) {
      return {
        ok: true,
        url: `https://www.youtube.com${u.pathname}`,
        isYouTube: true,
        needsHandleResolve: true,
      };
    }
  }

  return { ok: true, url: checked.url, isYouTube: false, needsHandleResolve: false };
}

/**
 * Strictly validates an external feed URL against SSRF vectors.
 */
export function validateExternalFeedUrl(rawUrl = '') {
  let u;
  try {
    u = new URL(String(rawUrl || '').trim());
  } catch {
    return { ok: false, url: '', error: '網址格式不正確' };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, url: '', error: '基於安全考量僅允許 https:// 來源網址' };
  }
  if (u.username || u.password) {
    return { ok: false, url: '', error: '來源網址不可包含帳號密碼' };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false, url: '', error: '不可連線至本機或內部網域名稱' };
  }
  if (isIP(host) !== 0) {
    return { ok: false, url: '', error: '不允許直接連線至純 IP 位址（避免內網探測）' };
  }
  if (!host.includes('.')) {
    return { ok: false, url: '', error: '請輸入完整的公開網域名稱' };
  }
  if (u.port && u.port !== '443') {
    return { ok: false, url: '', error: '僅允許標準 HTTPS 443 連接埠' };
  }
  return { ok: true, url: u.toString(), error: '' };
}

function normalizeCustomFeedEntry(entry, idx = 0) {
  if (!entry || typeof entry !== 'object') return null;
  const norm = normalizeYouTubeOrFeedUrl(entry.url || '');
  if (!norm.ok || norm.needsHandleResolve) return null;
  const url = norm.url;
  const fallbackHost = (() => {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return '自訂來源'; }
  })();
  const id = String(entry.id || `feed-${idx}-${Buffer.from(url).toString('base64url').slice(0, 8)}`).slice(0, 48);
  const label = neutralizeControlMarkers(String(entry.label || fallbackHost).trim().slice(0, 40)) || fallbackHost;
  return {
    id,
    label,
    url,
    enabled: entry.enabled !== false,
  };
}

export function normalizeFreshBrowseConfig(raw) {
  const m = { ...DEFAULT_FRESH_BROWSE_CONFIG, ...(raw && typeof raw === 'object' ? raw : {}) };
  const presets = Array.isArray(m.presets)
    ? [...new Set(m.presets.map((x) => String(x || '').trim()).filter((id) => Object.hasOwn(FRESH_PRESET_PACKS, id)))]
    : [...DEFAULT_FRESH_BROWSE_CONFIG.presets];

  const customFeeds = [];
  const seenUrls = new Set();
  if (Array.isArray(m.customFeeds)) {
    for (let i = 0; i < m.customFeeds.length && customFeeds.length < MAX_CUSTOM_FEEDS; i++) {
      const norm = normalizeCustomFeedEntry(m.customFeeds[i], i);
      if (norm && !seenUrls.has(norm.url)) {
        seenUrls.add(norm.url);
        customFeeds.push(norm);
      }
    }
  }

  const weatherCity = neutralizeControlMarkers(String(m.weatherCity || '').trim().slice(0, 60));
  const sameCity = weatherCity && weatherCity === String(m.weatherResolvedCity || '').trim();
  const lat = sameCity && Number.isFinite(Number(m.weatherLat)) ? Number(m.weatherLat) : null;
  const lon = sameCity && Number.isFinite(Number(m.weatherLon)) ? Number(m.weatherLon) : null;

  return {
    enabled: Boolean(m.enabled),
    dailyShareLimit: Math.round(clampNum(m.dailyShareLimit, 0, 6, DEFAULT_FRESH_BROWSE_CONFIG.dailyShareLimit)),
    maxAgeHours: Math.round(clampNum(m.maxAgeHours, 6, 168, DEFAULT_FRESH_BROWSE_CONFIG.maxAgeHours)),
    presets,
    weatherCity,
    weatherLat: lat,
    weatherLon: lon,
    weatherResolvedCity: sameCity ? weatherCity : '',
    customFeeds,
  };
}

export function mergeFreshBrowseConfig(currentCfg, patch) {
  const cur = normalizeFreshBrowseConfig(currentCfg);
  if (!patch || typeof patch !== 'object') return cur;
  const merged = { ...cur, ...patch };
  if (patch.weatherCity !== undefined && String(patch.weatherCity || '').trim() !== cur.weatherCity) {
    merged.weatherLat = null;
    merged.weatherLon = null;
    merged.weatherResolvedCity = '';
  }
  return normalizeFreshBrowseConfig(merged);
}

async function assertHostResolvesPublic(hostname, lookupFn) {
  const records = await lookupFn(hostname, { all: true });
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) {
    throw new Error(`網域解析無結果：${hostname}`);
  }
  for (const rec of list) {
    const addr = rec?.address || rec;
    if (isPrivateOrReservedIp(addr)) {
      throw new Error(`封鎖私人或保留 IP 位址（${addr}）`);
    }
  }
}

async function readResponseWithLimit(res, maxBytes = MAX_FEED_BYTES) {
  if (!res.body || typeof res.body.getReader !== 'function') {
    const txt = await res.text();
    if (Buffer.byteLength(txt, 'utf-8') > maxBytes) {
      throw new Error(`回應內容超過上限 (${Math.round(maxBytes / 1024)} KB)`);
    }
    return txt;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`回應內容超過上限 (${Math.round(maxBytes / 1024)} KB)`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Fetches text safely over HTTPS with manual redirect re-validation, DNS SSRF check,
 * timeout, and response byte ceiling.
 */
export async function safeFetchExternalText(
  initialUrl,
  {
    fetchFn = fetch,
    lookupFn = dnsLookup,
    verifyDns = fetchFn === fetch || lookupFn !== dnsLookup,
    timeoutMs = FETCH_TIMEOUT_MS,
    maxBytes = MAX_FEED_BYTES,
  } = {},
) {
  let currentUrl = initialUrl;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    const check = validateExternalFeedUrl(currentUrl);
    if (!check.ok) throw new Error(check.error);

    if (verifyDns) {
      const host = new URL(check.url).hostname;
      await assertHostResolvesPublic(host, lookupFn);
    }

    const res = await fetchFn(check.url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml, application/json, text/xml;q=0.9, text/html;q=0.5',
        'User-Agent': 'agy-gemini-chan-fresh-browse/1.0',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers?.get?.('location') || '';
      if (!loc || hop === MAX_REDIRECT_HOPS) {
        throw new Error('重新導向次數過多或無目標位址');
      }
      currentUrl = new URL(loc, check.url).toString();
      continue;
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return await readResponseWithLimit(res, maxBytes);
  }
  throw new Error('超出允許的重新導向次數');
}

function decodeHtmlEntities(str = '') {
  const named = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'",
    '&nbsp;': ' ',
    '&ndash;': '–',
    '&mdash;': '—',
    '&hellip;': '…',
  };
  return String(str)
    .replace(/&(amp|lt|gt|quot|apos|nbsp|ndash|mdash|hellip);/gi, (m) => named[m.toLowerCase()] || m)
    .replace(/&#(\d+);/g, (_, num) => {
      const cp = Number(num);
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const cp = parseInt(hex, 16);
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    });
}

function cleanExternalSnippet(raw = '', maxLen = 140) {
  let s = String(raw || '');
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = decodeHtmlEntities(s);
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeHtmlEntities(s);
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  s = neutralizeControlMarkers(s);
  if (s.length > maxLen) {
    s = `${s.slice(0, maxLen - 1).trim()}…`;
  }
  return s;
}

function extractXmlTagText(block = '', tagNames = []) {
  for (const tag of tagNames) {
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(`<${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escaped}>`, 'i');
    const m = rx.exec(block);
    if (m && m[1]) return m[1];
  }
  return '';
}

function extractXmlLink(block = '', isAtom = false) {
  if (isAtom) {
    const alt = /<link\b[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(block)
      || /<link\b[^>]*href=["']([^"']+)["'][^>]*rel=["']alternate["'][^>]*\/?>/i.exec(block)
      || /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i.exec(block);
    if (alt && alt[1]) return decodeHtmlEntities(alt[1].trim());
  }
  const tagLink = extractXmlTagText(block, ['link', 'guid']);
  const clean = cleanExternalSnippet(tagLink, 400);
  return clean;
}

/**
 * Parses standard RSS 2.0 or Atom XML feeds without external dependencies.
 */
export function parseFeedXml(
  xmlText = '',
  { sourceLabel = '', category = 'custom', maxAgeHours = 48, nowMs = Date.now(), maxItems = 8 } = {},
) {
  const xml = String(xmlText || '');
  if (!xml.trim() || /^\s*<!doctype\s+html/i.test(xml) || /^\s*<html[\s>]/i.test(xml)) {
    throw new Error('回傳內容為 HTML 網頁而非有效的 RSS / Atom Feed');
  }

  const isAtom = /<feed[\s>]/i.test(xml) && /<entry[\s>]/i.test(xml);
  const entryRegex = isAtom
    ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi
    : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;

  // Detect feed-level title before first <item>/<entry>
  const firstEntryIdx = xml.search(/<(?:item|entry)\b/i);
  const headerSlice = firstEntryIdx > 0 ? xml.slice(0, firstEntryIdx) : xml.slice(0, 2000);
  const feedTitle = cleanExternalSnippet(extractXmlTagText(headerSlice, ['title']), 48);
  const resolvedSource = neutralizeControlMarkers(String(sourceLabel || feedTitle || '外部來源').trim().slice(0, 40));

  const maxAgeMs = Math.max(1, maxAgeHours) * 3600_000;
  const out = [];
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = cleanExternalSnippet(extractXmlTagText(block, ['title']), 100);
    if (!title) continue;

    const rawUrl = extractXmlLink(block, isAtom);
    const safeUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl.slice(0, 300) : '';
    const rawId = cleanExternalSnippet(extractXmlTagText(block, ['id', 'guid', 'yt:videoId']), 200);

    const dateStr = cleanExternalSnippet(extractXmlTagText(block, ['pubDate', 'published', 'updated', 'dc:date']), 80);
    const parsedTime = dateStr ? Date.parse(dateStr) : NaN;
    const publishedAt = Number.isFinite(parsedTime) ? parsedTime : 0;

    if (publishedAt > 0 && nowMs - publishedAt > maxAgeMs) {
      continue;
    }
    if (publishedAt > nowMs + 12 * 3600_000) {
      // Skip clearly broken far-future timestamps
      continue;
    }

    const summaryRaw = extractXmlTagText(block, [
      'description',
      'summary',
      'media:description',
      'content:encoded',
      'content',
    ]);
    let summary = cleanExternalSnippet(summaryRaw, 150);
    if (summary === title) summary = '';

    const key = safeUrl || rawId || `${resolvedSource}:${title}`;
    out.push({
      key: key.slice(0, 260),
      source: resolvedSource,
      category,
      title,
      summary,
      url: safeUrl,
      publishedAt,
      fetchedAt: nowMs,
    });
    if (out.length >= maxItems) break;
  }

  return { feedTitle, items: out };
}

/**
 * Resolves a custom URL (including YouTube `@handle` pages) into a fetchable RSS/Atom URL,
 * tests fetching at least 1 entry, and returns metadata for UI preview.
 */
export async function validateAndPreviewFeed(
  rawUrl = '',
  { fetchFn = fetch, lookupFn = dnsLookup, nowMs = Date.now() } = {},
) {
  const norm = normalizeYouTubeOrFeedUrl(rawUrl);
  if (!norm.ok) return { ok: false, error: norm.error };

  const fetchOpts = { fetchFn, lookupFn };
  let feedUrl = norm.url;
  let resolvedLabel = '';

  if (norm.needsHandleResolve) {
    const html = await safeFetchExternalText(feedUrl, fetchOpts);
    const cidMatch = /<meta\s+itemprop=["']channelId["']\s+content=["'](UC[A-Za-z0-9_-]{20,})["']/i.exec(html)
      || /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{20,})"/i.exec(html)
      || /channel_id=(UC[A-Za-z0-9_-]{20,})/i.exec(html);
    if (!cidMatch) {
      return { ok: false, error: '無法從此 YouTube 頁面解析頻道 ID，請改貼含 /channel/UC... 的網址' };
    }
    feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${cidMatch[1]}`;
    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
    if (titleMatch) {
      resolvedLabel = cleanExternalSnippet(titleMatch[1].replace(/\s*-\s*YouTube\s*$/i, ''), 40);
    }
  }

  const xml = await safeFetchExternalText(feedUrl, fetchOpts);
  const parsed = parseFeedXml(xml, {
    sourceLabel: resolvedLabel,
    category: 'custom',
    maxAgeHours: 24 * 30,
    nowMs,
    maxItems: 3,
  });

  if (!parsed.feedTitle && !parsed.items.length) {
    return { ok: false, error: '找不到任何條目或標題，請確認這是標準 RSS / Atom 網址' };
  }

  const hostFallback = new URL(feedUrl).hostname.replace(/^www\./, '');
  return {
    ok: true,
    url: feedUrl,
    label: parsed.feedTitle || resolvedLabel || hostFallback,
    sampleTitle: parsed.items[0]?.title || '',
    sampleUrl: parsed.items[0]?.url || '',
    itemCount: parsed.items.length,
  };
}

function summarizeWeatherCode(code) {
  const c = Number(code);
  if (c >= 95) return '雷雨';
  if ((c >= 61 && c <= 67) || (c >= 80 && c <= 82)) return '明顯降雨';
  if (c >= 51 && c <= 57) return '細雨或飄雨';
  if (c >= 71 && c <= 77) return '降雪';
  if (c === 45 || c === 48) return '起霧';
  if (c <= 1) return '晴朗';
  return '多雲陰天';
}

/**
 * Fetches 2-day forecast from Open-Meteo and returns a notice ONLY when tomorrow shows
 * a significant weather swing (rain >= 60%, temperature drop >= 5°C, or extreme temp).
 */
export async function fetchWeatherNotice({
  city = '',
  weatherLat = null,
  weatherLon = null,
  weatherResolvedCity = '',
  fetchFn = fetch,
  lookupFn = dnsLookup,
  nowMs = Date.now(),
} = {}) {
  const cleanCity = neutralizeControlMarkers(String(city || '').trim().slice(0, 60));
  if (!cleanCity) return { ok: false, reason: 'no_city' };

  const fetchOpts = { fetchFn, lookupFn };
  let lat = weatherLat;
  let lon = weatherLon;
  let displayCity = weatherResolvedCity || cleanCity;

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cleanCity)}&count=1&language=zh`;
    const geoJson = JSON.parse(await safeFetchExternalText(geoUrl, fetchOpts));
    const hit = geoJson?.results?.[0];
    if (!hit || !Number.isFinite(hit.latitude) || !Number.isFinite(hit.longitude)) {
      return { ok: false, reason: 'city_not_found' };
    }
    lat = hit.latitude;
    lon = hit.longitude;
    displayCity = cleanExternalSnippet(hit.name || cleanCity, 40) || cleanCity;
  }

  const fcUrl =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}` +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=2';
  const fcJson = JSON.parse(await safeFetchExternalText(fcUrl, fetchOpts));
  const daily = fcJson?.daily;
  if (!daily || !Array.isArray(daily.time) || daily.time.length < 2) {
    return { ok: false, reason: 'no_forecast', resolvedCoords: { lat, lon, city: cleanCity, displayCity } };
  }

  const t0Max = Number(daily.temperature_2m_max?.[0]);
  const t1Max = Number(daily.temperature_2m_max?.[1]);
  const t0Min = Number(daily.temperature_2m_min?.[0]);
  const t1Min = Number(daily.temperature_2m_min?.[1]);
  const p1Rain = Number(daily.precipitation_probability_max?.[1] ?? 0);
  const w1Desc = summarizeWeatherCode(daily.weather_code?.[1]);
  const tomorrowDate = String(daily.time[1] || '');

  const reasons = [];
  if (Number.isFinite(t0Max) && Number.isFinite(t1Max) && t0Max - t1Max >= 5) {
    reasons.push(`明天白天比今天降溫 ${Math.round(t0Max - t1Max)}°C`);
  } else if (Number.isFinite(t0Min) && Number.isFinite(t1Min) && t0Min - t1Min >= 5) {
    reasons.push(`明晚會比今天涼 ${Math.round(t0Min - t1Min)}°C 左右`);
  }
  if (Number.isFinite(p1Rain) && p1Rain >= 60) {
    reasons.push(`明日${w1Desc}機率約 ${Math.round(p1Rain)}%`);
  }
  if (Number.isFinite(t1Min) && t1Min <= 12) {
    reasons.push(`明天低溫下探 ${Math.round(t1Min)}°C`);
  } else if (Number.isFinite(t1Max) && t1Max >= 34) {
    reasons.push(`明天高溫上看 ${Math.round(t1Max)}°C`);
  }

  if (!reasons.length) {
    return { ok: true, alert: null, resolvedCoords: { lat, lon, city: cleanCity, displayCity } };
  }

  const tempRange = (Number.isFinite(t1Min) && Number.isFinite(t1Max))
    ? `${Math.round(t1Min)}～${Math.round(t1Max)}°C`
    : '';
  return {
    ok: true,
    resolvedCoords: { lat, lon, city: cleanCity, displayCity },
    alert: {
      key: `weather:${displayCity}:${tomorrowDate}`,
      source: `${displayCity}天氣提醒`,
      category: 'weather',
      title: `${displayCity}：${reasons.join('、')}`,
      summary: `${tempRange ? `明日氣溫約 ${tempRange}，` : ''}留意帶傘或調整衣物。`,
      url: '',
      publishedAt: nowMs,
      fetchedAt: nowMs,
    },
  };
}

export function loadFreshBrowseCache(root = getProjectRoot()) {
  const raw = readJsonSafe(cacheFilePath(root), null);
  if (!raw || typeof raw !== 'object') return defaultCacheState();
  return {
    ...defaultCacheState(),
    ...raw,
    todaySlotsUsed: Array.isArray(raw.todaySlotsUsed) ? raw.todaySlotsUsed.map(String) : [],
    items: Array.isArray(raw.items) ? raw.items : [],
    recentShared: Array.isArray(raw.recentShared) ? raw.recentShared : [],
    seenKeys: Array.isArray(raw.seenKeys) ? raw.seenKeys.map(String) : [],
  };
}

/**
 * Resolves the list of enabled RSS/Atom sources from active preset packs + custom feeds.
 */
export function resolveConfiguredFeedSources(config) {
  const cfg = normalizeFreshBrowseConfig(config);
  const sources = [];
  const seenUrls = new Set();

  for (const presetId of cfg.presets) {
    const pack = FRESH_PRESET_PACKS[presetId];
    if (!pack || !Array.isArray(pack.feeds)) continue;
    for (const f of pack.feeds) {
      if (f?.url && !seenUrls.has(f.url)) {
        seenUrls.add(f.url);
        sources.push({ label: f.label, url: f.url, category: presetId });
      }
    }
  }

  for (const f of cfg.customFeeds) {
    if (!f.enabled || !f.url || seenUrls.has(f.url)) continue;
    seenUrls.add(f.url);
    sources.push({ label: f.label, url: f.url, category: 'custom' });
  }

  return sources;
}

/**
 * Fetches all enabled external sources + optional weather swing check, then merges
 * unseen fresh entries into `data/speak-up/fresh-picks.json` safely under lock.
 * All async network calls run outside the synchronous file lock.
 */
export async function refreshFreshFeedNow({
  root = getProjectRoot(),
  config,
  timezone = '',
  slotName = 'manual',
  nowMs = Date.now(),
  fetchFn = fetch,
  lookupFn = dnsLookup,
} = {}) {
  const cfg = normalizeFreshBrowseConfig(config);
  const sources = resolveConfiguredFeedSources(cfg);
  const { dayKey } = formatDayAndHour(nowMs, timezone);
  const wantWeather = cfg.presets.includes('weather') || Boolean(cfg.weatherCity);

  if (!sources.length && !(wantWeather && cfg.weatherCity)) {
    return { ok: false, fetchedCount: 0, addedCount: 0, error: '尚未勾選任何主題分類或設定自訂來源' };
  }

  const collected = [];
  const errors = [];

  for (const src of sources) {
    try {
      const xml = await safeFetchExternalText(src.url, { fetchFn, lookupFn });
      const parsed = parseFeedXml(xml, {
        sourceLabel: src.label,
        category: src.category,
        maxAgeHours: cfg.maxAgeHours,
        nowMs,
        maxItems: 6,
      });
      collected.push(...parsed.items);
    } catch (err) {
      errors.push(`${src.label}: ${err?.message || err}`);
    }
  }

  let resolvedWeatherCoords = null;
  if (wantWeather && cfg.weatherCity) {
    try {
      const w = await fetchWeatherNotice({
        city: cfg.weatherCity,
        weatherLat: cfg.weatherLat,
        weatherLon: cfg.weatherLon,
        weatherResolvedCity: cfg.weatherResolvedCity,
        fetchFn,
        lookupFn,
        nowMs,
      });
      if (w.resolvedCoords) resolvedWeatherCoords = w.resolvedCoords;
      if (w.alert) collected.push(w.alert);
    } catch (err) {
      errors.push(`天氣預報: ${err?.message || err}`);
    }
  }

  let addedCount = 0;
  let itemsCount = 0;
  const maxAgeMs = cfg.maxAgeHours * 3600_000;

  const updated = updateJsonLocked(cacheFilePath(root), defaultCacheState(), (raw) => {
    const state = {
      ...defaultCacheState(),
      ...(raw && typeof raw === 'object' ? raw : {}),
    };
    if (state.dayKey !== dayKey) {
      state.dayKey = dayKey;
      state.todaySlotsUsed = [];
      state.todayFetchCount = 0;
    }
    state.lastCheckedAt = nowMs;
    if (slotName === 'morning' || slotName === 'evening') {
      if (!state.todaySlotsUsed.includes(slotName)) state.todaySlotsUsed.push(slotName);
    }
    state.todayFetchCount = Number(state.todayFetchCount || 0) + 1;

    const seenSet = new Set(Array.isArray(state.seenKeys) ? state.seenKeys : []);
    const existingByKey = new Map();
    for (const item of (Array.isArray(state.items) ? state.items : [])) {
      if (!item || !item.key || seenSet.has(item.key)) continue;
      const ageRef = item.publishedAt || item.fetchedAt || nowMs;
      if (nowMs - ageRef <= maxAgeMs) {
        existingByKey.set(item.key, item);
      }
    }

    for (const item of collected) {
      if (!item?.key || seenSet.has(item.key)) continue;
      if (item.category === 'weather' && state.lastWeatherAlertDay === dayKey) continue;
      if (!existingByKey.has(item.key)) {
        existingByKey.set(item.key, item);
        addedCount++;
        if (item.category === 'weather') state.lastWeatherAlertDay = dayKey;
      }
    }

    // Keep diverse newest items capped at MAX_STORED_ITEMS
    const mergedItems = [...existingByKey.values()]
      .sort((a, b) => (b.publishedAt || b.fetchedAt || 0) - (a.publishedAt || a.fetchedAt || 0))
      .slice(0, MAX_STORED_ITEMS);

    state.items = mergedItems;
    itemsCount = mergedItems.length;
    if (collected.length > 0 || errors.length === 0) {
      state.lastSuccessAt = nowMs;
      state.lastError = errors.length ? errors.slice(0, 2).join('；') : '';
    } else {
      state.lastError = errors.slice(0, 2).join('；');
    }
    return state;
  });

  return {
    ok: collected.length > 0 || errors.length === 0,
    fetchedCount: collected.length,
    addedCount,
    itemsCount,
    error: errors.slice(0, 2).join('；'),
    resolvedWeatherCoords,
    cache: updated,
  };
}

/**
 * Checks whether Sidecar's 60s tick falls in the daily morning (10-12h) or evening (17-20h)
 * window and has not yet fetched in that slot today (strictly max 2 scheduled fetches/day).
 */
export async function maybeRefreshFreshFeed({
  root = getProjectRoot(),
  config,
  timezone = '',
  nowMs = Date.now(),
  fetchFn = fetch,
  lookupFn = dnsLookup,
} = {}) {
  const cfg = normalizeFreshBrowseConfig(config);
  if (!cfg.enabled) return { skipped: true, reason: 'disabled' };

  const sources = resolveConfiguredFeedSources(cfg);
  const wantWeather = (cfg.presets.includes('weather') || Boolean(cfg.weatherCity)) && Boolean(cfg.weatherCity);
  if (!sources.length && !wantWeather) return { skipped: true, reason: 'no_sources' };

  const { dayKey, hour } = formatDayAndHour(nowMs, timezone);
  let slotName = '';
  if (hour >= 10 && hour <= 12) slotName = 'morning';
  else if (hour >= 17 && hour <= 20) slotName = 'evening';
  if (!slotName) return { skipped: true, reason: 'outside_window' };

  const cache = loadFreshBrowseCache(root);
  const used = cache.dayKey === dayKey ? cache.todaySlotsUsed : [];
  if (used.includes(slotName)) return { skipped: true, reason: 'slot_already_fetched' };

  // Minimum 25-min cooldown between fetch attempts (handles repeated failures gracefully)
  if (cache.lastCheckedAt > 0 && nowMs - cache.lastCheckedAt < 25 * 60_000) {
    return { skipped: true, reason: 'throttle' };
  }

  return await refreshFreshFeedNow({ root, config: cfg, timezone, slotName, nowMs, fetchFn, lookupFn });
}

function selectDiverseFreshPicks(state, cfg, dayKey, nowMs, maxPick) {
  if (state.shareDayKey === dayKey && Number(state.todayShareCount || 0) >= cfg.dailyShareLimit) {
    return [];
  }
  const maxAgeMs = cfg.maxAgeHours * 3600_000;
  const seenSet = new Set(Array.isArray(state.seenKeys) ? state.seenKeys : []);
  const freshPool = (Array.isArray(state.items) ? state.items : []).filter((item) => {
    if (!item?.key || !item?.title || seenSet.has(item.key)) return false;
    const ref = item.publishedAt || item.fetchedAt || nowMs;
    return nowMs - ref <= maxAgeMs;
  });
  if (!freshPool.length) return [];

  // Round-robin across sources so a single noisy site doesn't crowd out other topics
  const bySource = new Map();
  for (const item of freshPool) {
    const s = item.source || '其他';
    if (!bySource.has(s)) bySource.set(s, []);
    bySource.get(s).push(item);
  }

  const selected = [];
  let progress = true;
  while (selected.length < maxPick && progress) {
    progress = false;
    for (const [, list] of bySource.entries()) {
      if (list.length > 0 && selected.length < maxPick) {
        selected.push(list.shift());
        progress = true;
      }
    }
  }
  return selected;
}

/**
 * Peeks up to `maxPick` (default 3) unseen diverse candidates without modifying cache state.
 */
export function peekFreshBrowsePicks({
  root = getProjectRoot(),
  config,
  timezone = '',
  nowMs = Date.now(),
  maxPick = 3,
} = {}) {
  const cfg = normalizeFreshBrowseConfig(config);
  if (!cfg.enabled || cfg.dailyShareLimit <= 0) return [];
  const { dayKey } = formatDayAndHour(nowMs, timezone);
  const state = loadFreshBrowseCache(root);
  return selectDiverseFreshPicks(state, cfg, dayKey, nowMs, maxPick);
}

/**
 * Atomically marks previously peeked items as consumed after successful delivery.
 */
export function commitFreshBrowsePicks({
  root = getProjectRoot(),
  picked = [],
  timezone = '',
  nowMs = Date.now(),
} = {}) {
  if (!Array.isArray(picked) || !picked.length) return [];
  const { dayKey } = formatDayAndHour(nowMs, timezone);
  const pickedKeys = new Set(picked.map((x) => x?.key).filter(Boolean));
  if (!pickedKeys.size) return [];

  updateJsonLocked(cacheFilePath(root), defaultCacheState(), (raw) => {
    const state = {
      ...defaultCacheState(),
      ...(raw && typeof raw === 'object' ? raw : {}),
    };
    if (state.shareDayKey !== dayKey) {
      state.shareDayKey = dayKey;
      state.todayShareCount = 0;
    }
    const seenSet = new Set(Array.isArray(state.seenKeys) ? state.seenKeys : []);
    state.items = (Array.isArray(state.items) ? state.items : []).filter((x) => x?.key && !pickedKeys.has(x.key));
    state.seenKeys = [...seenSet, ...pickedKeys].slice(-MAX_SEEN_KEYS);
    state.recentShared = [
      ...picked.map((x) => ({
        key: x.key,
        source: x.source,
        title: x.title,
        url: x.url,
        sharedAt: nowMs,
      })),
      ...(Array.isArray(state.recentShared) ? state.recentShared : []),
    ].slice(0, 10);
    state.todayShareCount = Number(state.todayShareCount || 0) + 1;
    return state;
  });
  return picked;
}

/**
 * Atomically selects up to `maxPick` (default 3) unseen diverse candidates for `<speak-up>`,
 * enforces daily share quota, and marks shown keys in `seenKeys` so headlines never repeat.
 */
export function consumeFreshBrowsePicks({
  root = getProjectRoot(),
  config,
  timezone = '',
  nowMs = Date.now(),
  maxPick = 3,
} = {}) {
  const cfg = normalizeFreshBrowseConfig(config);
  if (!cfg.enabled || cfg.dailyShareLimit <= 0) return [];

  const { dayKey } = formatDayAndHour(nowMs, timezone);
  let picked = [];

  updateJsonLocked(cacheFilePath(root), defaultCacheState(), (raw) => {
    const state = {
      ...defaultCacheState(),
      ...(raw && typeof raw === 'object' ? raw : {}),
    };
    if (state.shareDayKey !== dayKey) {
      state.shareDayKey = dayKey;
      state.todayShareCount = 0;
    }
    const selected = selectDiverseFreshPicks(state, cfg, dayKey, nowMs, maxPick);
    if (!selected.length) return state;

    picked = selected;
    const pickedKeys = new Set(selected.map((x) => x.key));
    const seenSet = new Set(Array.isArray(state.seenKeys) ? state.seenKeys : []);
    state.items = (Array.isArray(state.items) ? state.items : []).filter((x) => x?.key && !pickedKeys.has(x.key));
    state.seenKeys = [...seenSet, ...pickedKeys].slice(-MAX_SEEN_KEYS);
    state.recentShared = [
      ...selected.map((x) => ({
        key: x.key,
        source: x.source,
        title: x.title,
        url: x.url,
        sharedAt: nowMs,
      })),
      ...(Array.isArray(state.recentShared) ? state.recentShared : []),
    ].slice(0, 10);
    state.todayShareCount = Number(state.todayShareCount || 0) + 1;
    return state;
  });

  return picked;
}

export function clearFreshBrowseCache(root = getProjectRoot(), { clearSeen = false } = {}) {
  return updateJsonLocked(cacheFilePath(root), defaultCacheState(), (raw) => {
    const state = {
      ...defaultCacheState(),
      ...(raw && typeof raw === 'object' ? raw : {}),
    };
    state.items = [];
    state.lastError = '';
    if (clearSeen) {
      state.seenKeys = [];
      state.recentShared = [];
    }
    return state;
  });
}

/**
 * Formats selected fresh picks into an optional, explicitly anti-news-anchor block
 * for injection inside `<speak-up>`.
 */
export function formatFreshBrowsePromptBlock(picks = []) {
  if (!Array.isArray(picks) || !picks.length) return '';
  const lines = [
    '【剛才自己逛網看到的新鮮見聞（完全由你決定要不要聊，不強制採用）】',
  ];
  for (const item of picks) {
    const src = item.source ? `[${item.source}] ` : '';
    const sum = item.summary ? ` — ${item.summary}` : '';
    const link = item.url ? ` (${item.url})` : '';
    lines.push(`- ${src}${item.title}${sum}${link}`);
  }
  lines.push(
    '（說話分寸：這只是你剛才自己滑手機瞄到的幾件外界新鮮事，**千萬不要當成新聞播報員逐條整理或做每日摘要**。只有當其中某 1 件剛好讓你覺得好玩、有吐槽點、或覺得主人可能會感興趣時，才用你平時的人設口吻自然聊這 1 件就好；如果都沒特別想聊的感覺，就乾脆隻字不提，照你本來想說的打聲招呼即可。）',
  );
  return lines.join('\n');
}

export function getFreshBrowseSnapshot(root = getProjectRoot(), config, { timezone = '', nowMs = Date.now() } = {}) {
  const cfg = normalizeFreshBrowseConfig(config);
  const cache = loadFreshBrowseCache(root);
  const { dayKey } = formatDayAndHour(nowMs, timezone);
  const sameDay = cache.dayKey === dayKey;
  const sameShareDay = cache.shareDayKey === dayKey;
  return {
    config: cfg,
    presetsCatalog: Object.values(FRESH_PRESET_PACKS).map((p) => ({ id: p.id, name: p.name, desc: p.desc })),
    status: {
      lastCheckedAt: cache.lastCheckedAt || 0,
      lastSuccessAt: cache.lastSuccessAt || 0,
      lastError: cache.lastError || '',
      todayFetchCount: sameDay ? Number(cache.todayFetchCount || 0) : 0,
      todaySlotsUsed: sameDay ? cache.todaySlotsUsed : [],
      todayShareCount: sameShareDay ? Number(cache.todayShareCount || 0) : 0,
      pendingCount: (cache.items || []).length,
    },
    items: (cache.items || []).slice(0, 12),
    recentShared: (cache.recentShared || []).slice(0, 6),
  };
}
