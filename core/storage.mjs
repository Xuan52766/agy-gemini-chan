/**
 * @fileoverview Storage, path resolution, workspace boundary enforcement,
 * and atomic UTF-8 file helpers shared across hooks, MCP server, and sidecar.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = resolve(dirname(__filename), '..');

/**
 * Resolves the active project root (`GEMINI_CAT_ROOT` override is supported for
 * isolated test execution).
 */
export function getProjectRoot() {
  const override = process.env.GEMINI_CAT_ROOT;
  return override && override.trim() ? resolve(override.trim()) : DEFAULT_ROOT;
}

/**
 * Returns canonical data directory paths for all subsystems.
 */
export function getDataPaths(root = getProjectRoot()) {
  const dataDir = process.env.GEMINI_CAT_DATA_DIR
    ? resolve(process.env.GEMINI_CAT_DATA_DIR)
    : join(root, 'data');
  return {
    root,
    dataDir,
    dictDir: join(DEFAULT_ROOT, 'data', 'dict'),
    personaDir: join(dataDir, 'persona'),
    memoryDir: join(dataDir, 'fish-memory'),
    moodDir: join(dataDir, 'mood'),
    xingxiDir: join(dataDir, 'xingxi'),
    speakUpDir: join(dataDir, 'speak-up'),
    nestDir: join(dataDir, 'nest'),
    telegramDir: join(dataDir, 'telegram'),
    runtimeDir: join(dataDir, 'runtime'),
    assetsDir: join(DEFAULT_ROOT, 'assets', 'geminichan'),
  };
}

/**
 * Normalizes a filesystem path or `file://` URI for cross-platform comparison.
 */
export function normalizePathOrUri(input) {
  if (!input || typeof input !== 'string') return '';
  let s = input.trim();
  if (!s) return '';
  if (s.startsWith('file://')) {
    try {
      s = fileURLToPath(s);
    } catch {
      // Fall back to string normalization when malformed
      s = s.replace(/^file:\/\/\/?/, '');
      try { s = decodeURIComponent(s); } catch { /* ignore */ }
    }
  }
  let resolved;
  try {
    resolved = resolve(s);
  } catch {
    resolved = normalize(s);
  }
  resolved = resolved.replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Checks whether a path or URI matches or sits inside the `gemini_cat` project root.
 * Strict equality or subdirectory match avoids colliding with sibling folders.
 */
export function isWithinProject(candidate, expectedRoot = DEFAULT_ROOT) {
  const target = normalizePathOrUri(candidate);
  const root = normalizePathOrUri(expectedRoot);
  if (!target || !root) return false;
  if (target === root) return true;
  const sep = process.platform === 'win32' ? '\\' : '/';
  return target.startsWith(root + sep);
}

/**
 * Checks an array of workspace paths / URIs + optional cwd to ensure the primary
 * (first) workspace path belongs to this `gemini_cat` workspace. Secondary mounted
 * reference folders (e.g. `[other_project, gemini_cat]`) intentionally stay silent
 * so companion persona, hooks, and memory never leak into other projects' windows.
 * Only falls back to `cwd` when `workspaceList` has no non-empty entries.
 */
export function isProjectWorkspaceActive(workspaceList, cwd, expectedRoot = DEFAULT_ROOT) {
  const normalizedList = Array.isArray(workspaceList)
    ? workspaceList.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
    : (typeof workspaceList === 'string' && workspaceList.trim() ? [workspaceList.trim()] : []);

  if (normalizedList.length > 0) {
    return isWithinProject(normalizedList[0], expectedRoot);
  }
  return Boolean(cwd) && isWithinProject(cwd, expectedRoot);
}

/**
 * Strips `session-` prefix so session IDs from different APIs canonicalize identically.
 */
export function canonicalSessionKey(id) {
  const s = String(id ?? '').trim();
  if (!s) return '';
  return s.startsWith('session-') ? s.slice('session-'.length) : s;
}

/**
 * Ensures parent directory exists and reads a UTF-8 file (stripping optional UTF-8 BOM).
 */
export function readTextSafe(filePath, fallback = '') {
  try {
    if (!existsSync(filePath)) return fallback;
    return readFileSync(filePath, { encoding: 'utf-8' }).replace(/^\uFEFF/, '');
  } catch {
    return fallback;
  }
}

/**
 * Reads and parses a JSON file safely, returning `fallback` on missing or invalid JSON.
 */
export function readJsonSafe(filePath, fallback = null) {
  const text = readTextSafe(filePath, '');
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * Writes UTF-8 text atomically using a unique temporary file + rename.
 */
export function writeTextAtomic(filePath, content) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    writeFileSync(tmp, String(content ?? ''), { encoding: 'utf-8' });
    renameSync(tmp, filePath);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    // Windows fallback if file lock briefly prevented rename
    writeFileSync(filePath, String(content ?? ''), { encoding: 'utf-8' });
  }
}

/**
 * Serializes JSON cleanly with 2-space indentation and UTF-8 atomic write.
 */
export function writeJsonAtomic(filePath, value) {
  writeTextAtomic(filePath, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Returns local calendar date string `YYYY-MM-DD`.
 */
export function localDayKey(ms = Date.now()) {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Returns compact local timestamp `MM-DD HH:mm:ss` for diagnostics & timelines.
 */
export function localClockDisplay(ms = Date.now()) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function clampNum(val, min, max, fallback = min) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Replaces `{{key}}` placeholders inside editable user prompt templates.
 */
export function renderPromptTemplate(template, vars = {}) {
  return String(template ?? '').replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (full, key) => (
    Object.hasOwn(vars, key) ? String(vars[key] ?? '') : full
  ));
}

/**
 * Normalizes a customizable prompt field: blank or identical to default collapses to `''`
 * so unmodified prompts continue tracking future built-in refinements automatically.
 */
export function normalizeCustomPrompt(value, defaultRendered = '', maxLen = 4000) {
  const clean = String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, maxLen);
  const def = String(defaultRendered ?? '').replace(/\r\n/g, '\n').trim();
  if (!clean || (def && clean === def)) return '';
  return clean;
}

/**
 * Strips Antigravity runtime XML envelopes (`<USER_REQUEST>`, `<ADDITIONAL_METADATA>`, etc.)
 * so transcripts, recall queries, and mood reasons retain clean human text.
 */
export function stripAntigravityWrappers(text) {
  let s = String(text || '');
  s = s.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  s = s.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
  s = s.replace(/<CONTEXT_SUMMARY>[\s\S]*?<\/CONTEXT_SUMMARY>/gi, '');
  s = s.replace(/<SYSTEM_REMINDER>[\s\S]*?<\/SYSTEM_REMINDER>/gi, '');
  s = s.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '');
  const reqMatch = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(s);
  if (reqMatch) s = reqMatch[1];
  s = s.replace(/<\/?USER_REQUEST>/gi, '');
  s = s.replace(/@\[(?:Quote|File|Image|Folder|Selection|Code|Terminal|Diff|Commit|Branch|Web|Docs|Url|Link|Mention)(?:[\s:][^\]]*)?\]\s*/gi, '');
  return s.trim();
}

export function statMtimeMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export function appendLogLine(filePath, line, maxLines = 250) {
  try {
    const prev = readTextSafe(filePath, '');
    const lines = prev ? prev.split(/\r?\n/).filter(Boolean) : [];
    lines.push(`[${localClockDisplay()}] ${String(line || '').trim()}`);
    const sliced = lines.slice(-maxLines);
    writeTextAtomic(filePath, sliced.join('\n') + '\n');
  } catch {
    // Logging must never crash host hooks or sidecar
  }
}
