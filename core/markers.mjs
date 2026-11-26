/**
 * @fileoverview Centralized internal control markers and work-prefix classifiers
 * (zero dependencies; single source of truth across core/ and hooks/).
 */

export const SPEAK_UP_MARKER = '[SPEAK_UP_INTERNAL]';
export const SPEAK_UP_LEGACY_TAG = '<speak-up>';
export const XINGXI_PICKUP_MARKER = '[XINGXI_AUTO_PICKUP]';
export const CAT_NEST_EVENT_MARKER = '[CAT_NEST_EVENT]';
export const TELEGRAM_INCOMING_MARKER = '[TELEGRAM_INCOMING]';

export const DEFAULT_WORK_MARKERS = ['WORK_SCAN', 'CRON', 'AUTOMATION', 'YOUTUBE_PATROL'];

const PICKUP_SKIP_PREFIXES = [
  SPEAK_UP_MARKER,
  XINGXI_PICKUP_MARKER,
  CAT_NEST_EVENT_MARKER,
];

function escapeRegex(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns active external work-prefix names (default list + comma-separated
 * `GEMINI_CAT_WORK_MARKERS` env override).
 */
export function getWorkMarkers(extraEnv = process.env.GEMINI_CAT_WORK_MARKERS) {
  const out = new Set(DEFAULT_WORK_MARKERS);
  if (typeof extraEnv === 'string' && extraEnv.trim()) {
    for (const part of extraEnv.split(',')) {
      const cleaned = part.trim().replace(/^\[|\]$/g, '');
      if (cleaned && /^[A-Za-z0-9_:-]{2,48}$/.test(cleaned)) out.add(cleaned);
    }
  }
  return [...out];
}

/**
 * Checks whether `clean` starts with any registered external work marker (`[WORK_SCAN]`, etc.).
 */
export function isWorkMarkerPrefix(clean = '', extraEnv = process.env.GEMINI_CAT_WORK_MARKERS) {
  const s = String(clean || '').trim();
  if (!s.startsWith('[')) return false;
  const markers = getWorkMarkers(extraEnv);
  if (!markers.length) return false;
  const rx = new RegExp(`^\\[(?:${markers.map(escapeRegex).join('|')})\\]`, 'i');
  return rx.test(s);
}

/**
 * Checks whether an unwrapped transcript step text was dispatched by Sidecar `sendMessage`
 * or an external patrol plugin (not a system SDK hook injection).
 */
export function isSidecarDispatchedPrefix(clean = '', extraEnv = process.env.GEMINI_CAT_WORK_MARKERS) {
  const c = String(clean || '').trim();
  if (!c) return false;
  if (
    c.startsWith(SPEAK_UP_MARKER) ||
    c.startsWith(SPEAK_UP_LEGACY_TAG) ||
    c.startsWith(XINGXI_PICKUP_MARKER) ||
    c.startsWith(CAT_NEST_EVENT_MARKER) ||
    c.startsWith(TELEGRAM_INCOMING_MARKER)
  ) {
    return true;
  }
  return isWorkMarkerPrefix(c, extraEnv);
}

/**
 * Checks whether a user-turn string is an internal control prompt that should be skipped
 * when slicing raw dialogue material for Xingxi pickup.
 */
export function isInternalPickupSkipText(raw = '', clean = '') {
  const r = String(raw || '').trim();
  const c = String(clean || '').trim();
  if (!c || c.startsWith('<')) return true;
  return PICKUP_SKIP_PREFIXES.some((p) => r.includes(p) || c.includes(p));
}
