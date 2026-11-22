/**
 * @fileoverview Two-way Telegram Bot bridge with file/photo transfer (`gemini_cat` ONLY).
 *
 * Design principles:
 * - Zero external dependencies: uses Node >= 20 native `fetch`, `FormData`, and `Blob`.
 * - Works via Long Polling (`getUpdates`), requiring no public IP, port forwarding, or webhook.
 * - Strict whitelist (`allowedChatId`) + temporary `/bind <CODE>` pairing + masked Token storage.
 * - Exfiltration protection: outbound file transfers allow `gemini_cat` project files, Antigravity
 *   brain artifacts (`~/.gemini/antigravity/brain`), and explicit `extraSendDirs`, while always
 *   blocking secrets (`data/telegram/config.json`, `runtime/`, `.git/`, `.system_generated/`, `.env`).
 */

import { randomInt } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  clampNum,
  getDataPaths,
  getProjectRoot,
  localClockDisplay,
  localDayKey,
  normalizePathOrUri,
  readJsonSafe,
  updateJsonLocked,
  withFileLockSync,
  writeJsonAtomic,
} from './storage.mjs';

export const TELEGRAM_INCOMING_MARKER = '[TELEGRAM_INCOMING]';
const MAX_BOT_API_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const MAX_BOT_API_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_PHOTO_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_PHOTO_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export const DEFAULT_TELEGRAM_CONFIG = {
  enabled: false,
  botToken: '',
  allowedChatId: '',
  allowedUsername: '',
  lockSingleChat: true,
  receiveEnabled: true,
  forwardTelegramReplies: true,
  forwardDesktopReplies: false,
  forwardDesktopUserMessages: true,
  forwardSpeakUp: true,
  forwardXingxi: false,
  muteWhenDesktopActive: true,
  desktopActiveMuteMin: 15,
  desktopMuteMode: 'skip',
  autoSendReplyFiles: true,
  downloadFiles: true,
  followActive: true,
  targetConversationId: '',
  maxUploadMb: 20,
  extraSendDirs: [],
  pairCode: '',
  pairCodeExpiresAt: 0,
};

function tgPaths(root = getProjectRoot()) {
  const { telegramDir } = getDataPaths(root);
  return {
    telegramDir,
    configPath: join(telegramDir, 'config.json'),
    statePath: join(telegramDir, 'state.json'),
    inboxDir: join(telegramDir, 'inbox'),
    outboxDir: join(telegramDir, 'outbox'),
  };
}

export function maskBotToken(token = '') {
  const t = String(token || '').trim();
  if (!t) return '';
  const colonIdx = t.indexOf(':');
  if (colonIdx > 0) {
    return `${t.slice(0, colonIdx)}:***${t.slice(-4)}`;
  }
  if (t.length <= 8) return '***';
  return `${t.slice(0, 4)}***${t.slice(-4)}`;
}

export function redactToken(text, token = '') {
  let s = String(text || '');
  const t = String(token || '').trim();
  if (t && s.includes(t)) {
    s = s.split(t).join('<BOT_TOKEN>');
  }
  return s.replace(/\b\d{6,14}:[A-Za-z0-9_-]{20,}\b/g, '<BOT_TOKEN>');
}

export function sanitizeFilename(name = '', fallbackExt = '') {
  const base = basename(String(name || '').trim())
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  if (base) return base;
  const ext = fallbackExt && String(fallbackExt).startsWith('.') ? fallbackExt : (fallbackExt ? `.${fallbackExt}` : '');
  return `file_${Date.now()}${ext}`;
}

export function guessMimeType(filePath = '') {
  const ext = extname(String(filePath || '')).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

export function parseChatIdSet(allowedChatId = '') {
  return new Set(
    String(allowedChatId || '')
      .split(/[\s,，;]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  );
}

export function loadTelegramConfig(root = getProjectRoot()) {
  const { configPath } = tgPaths(root);
  const raw = readJsonSafe(configPath, null);
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_TELEGRAM_CONFIG };
  }
  const extraSendDirs = Array.isArray(raw.extraSendDirs)
    ? [...new Set(raw.extraSendDirs.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 20)
    : [];
  return {
    enabled: Boolean(raw.enabled),
    botToken: String(raw.botToken || '').trim().slice(0, 256),
    allowedChatId: String(raw.allowedChatId || '').trim().slice(0, 256),
    allowedUsername: String(raw.allowedUsername || '').trim().slice(0, 128),
    lockSingleChat: raw.lockSingleChat !== false,
    receiveEnabled: raw.receiveEnabled !== false,
    forwardTelegramReplies: raw.forwardTelegramReplies !== false,
    forwardDesktopReplies: Boolean(raw.forwardDesktopReplies),
    forwardDesktopUserMessages: raw.forwardDesktopUserMessages !== false,
    forwardSpeakUp: raw.forwardSpeakUp !== false,
    forwardXingxi: Boolean(raw.forwardXingxi),
    muteWhenDesktopActive: raw.muteWhenDesktopActive !== false,
    desktopActiveMuteMin: Math.round(clampNum(raw.desktopActiveMuteMin, 1, 240, 15)),
    desktopMuteMode: raw.desktopMuteMode === 'silent' ? 'silent' : 'skip',
    autoSendReplyFiles: raw.autoSendReplyFiles !== false,
    downloadFiles: raw.downloadFiles !== false,
    followActive: raw.followActive !== false,
    targetConversationId: String(raw.targetConversationId || '').trim().slice(0, 128),
    maxUploadMb: Math.round(clampNum(raw.maxUploadMb, 1, 50, 20)),
    extraSendDirs,
    pairCode: String(raw.pairCode || '').trim().slice(0, 24),
    pairCodeExpiresAt: Number(raw.pairCodeExpiresAt || 0),
  };
}

export function saveTelegramConfig(patch = {}, root = getProjectRoot()) {
  const cur = loadTelegramConfig(root);
  const next = { ...cur };

  const boolKeys = [
    'enabled',
    'lockSingleChat',
    'receiveEnabled',
    'forwardTelegramReplies',
    'forwardDesktopReplies',
    'forwardDesktopUserMessages',
    'forwardSpeakUp',
    'forwardXingxi',
    'muteWhenDesktopActive',
    'autoSendReplyFiles',
    'downloadFiles',
    'followActive',
  ];
  for (const k of boolKeys) {
    if (patch[k] !== undefined) next[k] = Boolean(patch[k]);
  }
  if (patch.desktopActiveMuteMin !== undefined) {
    next.desktopActiveMuteMin = Math.round(clampNum(patch.desktopActiveMuteMin, 1, 240, 15));
  }
  if (patch.desktopMuteMode !== undefined) {
    next.desktopMuteMode = patch.desktopMuteMode === 'silent' ? 'silent' : 'skip';
  }
  if (patch.clearToken === true) {
    next.botToken = '';
  } else if (typeof patch.botToken === 'string' && patch.botToken.trim()) {
    next.botToken = patch.botToken.trim().slice(0, 256);
  }
  if (patch.allowedChatId !== undefined) {
    next.allowedChatId = String(patch.allowedChatId || '').trim().slice(0, 256);
  }
  if (patch.allowedUsername !== undefined) {
    next.allowedUsername = String(patch.allowedUsername || '').trim().slice(0, 128);
  }
  if (patch.targetConversationId !== undefined) {
    next.targetConversationId = String(patch.targetConversationId || '').trim().slice(0, 128);
  }
  if (patch.maxUploadMb !== undefined) {
    next.maxUploadMb = Math.round(clampNum(patch.maxUploadMb, 1, 50, 20));
  }
  if (patch.extraSendDirs !== undefined) {
    const arr = Array.isArray(patch.extraSendDirs)
      ? patch.extraSendDirs
      : String(patch.extraSendDirs || '').split(/[\r\n]+/);
    next.extraSendDirs = [...new Set(arr.map((x) => String(x || '').trim()).filter(Boolean))].slice(0, 20);
  }
  if (patch.pairCode !== undefined) {
    next.pairCode = String(patch.pairCode || '').trim().slice(0, 24);
  }
  if (patch.pairCodeExpiresAt !== undefined) {
    next.pairCodeExpiresAt = Math.max(0, Number(patch.pairCodeExpiresAt || 0));
  }

  writeJsonAtomic(tgPaths(root).configPath, next);
  return loadTelegramConfig(root);
}

export function generateTelegramPairCode(root = getProjectRoot(), now = Date.now()) {
  const cur = loadTelegramConfig(root);
  const boundSet = parseChatIdSet(cur.allowedChatId);
  if (cur.lockSingleChat !== false && boundSet.size > 0) {
    return {
      blocked: true,
      pairCode: '',
      pairCodeExpiresAt: 0,
      error: '已鎖定單一帳號綁定；如需換綁其他 Telegram 帳號，請先清空允許的 Chat ID 或關閉「鎖定單一帳號綁定」。',
    };
  }
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[randomInt(chars.length)];
  }
  const expiresAt = now + 10 * 60_000;
  saveTelegramConfig({ pairCode: code, pairCodeExpiresAt: expiresAt }, root);
  return { blocked: false, pairCode: code, pairCodeExpiresAt: expiresAt };
}

function normalizeBindFailures(rawMap) {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return {};
  const entries = Object.entries(rawMap).slice(-30);
  const out = {};
  for (const [k, v] of entries) {
    if (!k || !v || typeof v !== 'object') continue;
    out[String(k).slice(0, 64)] = {
      count: Math.max(0, Math.round(Number(v.count || 0))),
      firstAt: Number(v.firstAt || 0),
      lockedUntil: Number(v.lockedUntil || 0),
    };
  }
  return out;
}

function normalizeTelegramStateObject(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      lastUpdateId: 0,
      botUsername: '',
      botDisplayName: '',
      sidecarAliveAt: 0,
      lastPollAt: 0,
      lastPollError: '',
      lastSentAt: 0,
      lastReceivedAt: 0,
      forwardedTurns: [],
      recentMcpSentFiles: [],
      chatHistory: [],
      logs: [],
      bindFailures: {},
    };
  }
  return {
    lastUpdateId: Math.max(0, Math.round(Number(raw.lastUpdateId || 0))),
    botUsername: String(raw.botUsername || '').slice(0, 80),
    botDisplayName: String(raw.botDisplayName || '').slice(0, 80),
    sidecarAliveAt: Number(raw.sidecarAliveAt || 0),
    lastPollAt: Number(raw.lastPollAt || 0),
    lastPollError: String(raw.lastPollError || '').slice(0, 240),
    lastSentAt: Number(raw.lastSentAt || 0),
    lastReceivedAt: Number(raw.lastReceivedAt || 0),
    forwardedTurns: Array.isArray(raw.forwardedTurns) ? raw.forwardedTurns.slice(-80) : [],
    recentMcpSentFiles: Array.isArray(raw.recentMcpSentFiles) ? raw.recentMcpSentFiles.slice(-30) : [],
    chatHistory: Array.isArray(raw.chatHistory) ? raw.chatHistory.slice(-40) : [],
    logs: Array.isArray(raw.logs) ? raw.logs.slice(-50) : [],
    bindFailures: normalizeBindFailures(raw.bindFailures),
  };
}

export function loadTelegramState(root = getProjectRoot()) {
  const { statePath } = tgPaths(root);
  const raw = readJsonSafe(statePath, null);
  return normalizeTelegramStateObject(raw);
}

export function saveTelegramState(state, root = getProjectRoot()) {
  const { statePath } = tgPaths(root);
  return withFileLockSync(statePath, () => {
    const clean = normalizeTelegramStateObject(state);
    writeJsonAtomic(statePath, clean);
    return clean;
  });
}

export function updateTelegramStateLocked(root = getProjectRoot(), mutator) {
  const { statePath } = tgPaths(root);
  return updateJsonLocked(statePath, {}, (raw) => {
    const st = normalizeTelegramStateObject(raw);
    const res = mutator(st);
    return normalizeTelegramStateObject(res === undefined ? st : res);
  });
}

export function appendTelegramChatEntry(
  state,
  { dir = 'in', mode = 'telegram', sender = '', text = '', files = [], silent = false } = {},
  now = Date.now(),
  tokenToRedact = '',
) {
  state.chatHistory.push({
    at: now,
    time: localClockDisplay(now),
    dir: dir === 'out' ? 'out' : 'in',
    mode: String(mode || 'telegram').slice(0, 24),
    sender: String(sender || '').slice(0, 60),
    text: redactToken(String(text || ''), tokenToRedact).slice(0, 1200),
    files: Array.isArray(files) ? files.map((f) => String(f || '')).filter(Boolean).slice(0, 10) : [],
    silent: Boolean(silent),
  });
  if (state.chatHistory.length > 40) state.chatHistory = state.chatHistory.slice(-40);
}

export function appendTelegramLog(state, text, now = Date.now(), tokenToRedact = '') {
  state.logs.push({
    at: now,
    time: localClockDisplay(now),
    text: redactToken(String(text || ''), tokenToRedact).slice(0, 240),
  });
  if (state.logs.length > 50) state.logs = state.logs.slice(-50);
}

export function touchTelegramSidecarAlive(root = getProjectRoot(), now = Date.now()) {
  return updateTelegramStateLocked(root, (st) => {
    st.sidecarAliveAt = now;
  });
}

export function isTelegramSidecarAlive(root = getProjectRoot(), now = Date.now(), maxStaleMs = 35_000) {
  const st = loadTelegramState(root);
  return st.sidecarAliveAt > 0 && (now - st.sidecarAliveAt) <= maxStaleMs;
}

function readLatestDesktopSpeechAt(root = getProjectRoot()) {
  const { runtimeDir } = getDataPaths(root);
  const sessData = readJsonSafe(join(runtimeDir, 'sessions.json'), null);
  const sessions = Array.isArray(sessData?.sessions) ? sessData.sessions : [];
  let maxTs = 0;
  for (const s of sessions) {
    const t = Number(s?.lastDesktopSpeechAt || 0);
    if (t > maxTs) maxTs = t;
  }
  return maxTs;
}

export function isDesktopActiveMute(root = getProjectRoot(), cfg = loadTelegramConfig(root), st = loadTelegramState(root), now = Date.now(), overrideDesktopSpeechAt = 0) {
  if (!cfg.muteWhenDesktopActive) return { active: false, minsLeft: 0 };
  const lastDesktopAt = Math.max(Number(overrideDesktopSpeechAt || 0), readLatestDesktopSpeechAt(root));
  if (!lastDesktopAt) return { active: false, minsLeft: 0 };
  // If user subsequently spoke via Telegram more recently than Desktop IDE, unmute immediately!
  if (st.lastReceivedAt > lastDesktopAt) return { active: false, minsLeft: 0 };
  const elapsedMs = now - lastDesktopAt;
  const windowMs = Math.max(1, cfg.desktopActiveMuteMin || 15) * 60_000;
  if (elapsedMs >= 0 && elapsedMs < windowMs) {
    return { active: true, minsLeft: Math.max(1, Math.ceil((windowMs - elapsedMs) / 60_000)) };
  }
  return { active: false, minsLeft: 0 };
}

export function getTelegramSnapshot(root = getProjectRoot(), now = Date.now()) {
  const cfg = loadTelegramConfig(root);
  const st = loadTelegramState(root);
  const outboxDir = tgPaths(root).outboxDir;
  let pendingOutboxCount = 0;
  try {
    if (existsSync(outboxDir)) {
      pendingOutboxCount = readdirSync(outboxDir).filter((f) => f.endsWith('.json')).length;
    }
  } catch {
    pendingOutboxCount = 0;
  }
  const activePair = cfg.pairCode && cfg.pairCodeExpiresAt > now
    ? { code: cfg.pairCode, expiresAt: cfg.pairCodeExpiresAt }
    : null;
  const sidecarAlive = st.sidecarAliveAt > 0 && (now - st.sidecarAliveAt) <= 35_000;
  const muteInfo = isDesktopActiveMute(root, cfg, st, now);

  return {
    config: {
      enabled: cfg.enabled,
      hasBotToken: Boolean(cfg.botToken),
      botTokenMasked: maskBotToken(cfg.botToken),
      allowedChatId: cfg.allowedChatId,
      allowedUsername: cfg.allowedUsername,
      lockSingleChat: cfg.lockSingleChat,
      receiveEnabled: cfg.receiveEnabled,
      forwardTelegramReplies: cfg.forwardTelegramReplies,
      forwardDesktopReplies: cfg.forwardDesktopReplies,
      forwardDesktopUserMessages: cfg.forwardDesktopUserMessages,
      forwardSpeakUp: cfg.forwardSpeakUp,
      forwardXingxi: cfg.forwardXingxi,
      muteWhenDesktopActive: cfg.muteWhenDesktopActive,
      desktopActiveMuteMin: cfg.desktopActiveMuteMin,
      desktopMuteMode: cfg.desktopMuteMode,
      autoSendReplyFiles: cfg.autoSendReplyFiles,
      downloadFiles: cfg.downloadFiles,
      followActive: cfg.followActive,
      targetConversationId: cfg.targetConversationId,
      maxUploadMb: cfg.maxUploadMb,
      extraSendDirs: cfg.extraSendDirs,
      pairCode: activePair?.code || '',
      pairCodeExpiresAt: activePair?.expiresAt || 0,
    },
    status: {
      configured: Boolean(cfg.botToken && cfg.allowedChatId),
      botUsername: st.botUsername,
      botDisplayName: st.botDisplayName,
      sidecarAlive,
      lastPollAt: st.lastPollAt,
      lastPollError: st.lastPollError,
      lastSentAt: st.lastSentAt,
      lastReceivedAt: st.lastReceivedAt,
      pendingOutboxCount,
      desktopMuteActive: muteInfo.active,
      desktopMuteMinsLeft: muteInfo.minsLeft,
    },
    chatHistory: st.chatHistory.slice(),
    logs: st.logs.slice().reverse(),
  };
}

function isPathInsideDir(targetNorm, dirNorm) {
  if (!targetNorm || !dirNorm) return false;
  if (targetNorm === dirNorm) return true;
  const sep = process.platform === 'win32' ? '\\' : '/';
  return targetNorm.startsWith(dirNorm + sep);
}

/**
 * Verifies an outbound file path is safe to send to Telegram:
 * - Blocks Telegram token config/state, runtime session secrets, `.env`, `.git`, and `.system_generated`.
 * - Allows `gemini_cat` project root, Antigravity brain artifacts, or explicit `extraSendDirs`.
 */
const BRAIN_ALLOWED_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
  '.mp4', '.webm', '.mov',
  '.mp3', '.ogg', '.wav', '.m4a',
  '.pdf', '.txt', '.md', '.csv',
]);

function resolveCanonicalRealPath(fsPath) {
  const abs = resolve(fsPath);
  try {
    return normalizePathOrUri(realpathSync.native(abs));
  } catch {
    let cur = abs;
    const tail = [];
    while (true) {
      const parent = dirname(cur);
      if (!parent || parent === cur) break;
      tail.unshift(basename(cur));
      cur = parent;
      try {
        const realParent = realpathSync.native(cur);
        return normalizePathOrUri(join(realParent, ...tail));
      } catch {
        // Keep walking up until existing ancestor
      }
    }
    return normalizePathOrUri(abs);
  }
}

export function isAllowedTelegramSendPath(filePath, root = getProjectRoot(), cfg = loadTelegramConfig(root)) {
  const targetNorm = normalizePathOrUri(filePath);
  if (!targetNorm) return { ok: false, reason: '無效的檔案路徑' };

  let rawFs = String(filePath).trim();
  if (rawFs.startsWith('file://')) {
    try { rawFs = fileURLToPath(rawFs); } catch { /* keep raw */ }
  }
  const absFs = resolve(rawFs);
  const targetReal = resolveCanonicalRealPath(absFs) || targetNorm;
  const candidates = targetReal === targetNorm ? [targetNorm] : [targetNorm, targetReal];

  const base = basename(targetReal).toLowerCase();
  const ext = extname(base).toLowerCase();
  const blockedFileNames = new Set(['.npmrc', '.pypirc', '.netrc', '.git-credentials']);
  const blockedKeyExts = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore']);
  if (
    base === '.env'
    || base.startsWith('.env.')
    || blockedKeyExts.has(ext)
    || blockedFileNames.has(base)
    || base === 'id_rsa' || base.startsWith('id_rsa.')
    || base === 'id_ed25519' || base.startsWith('id_ed25519.')
    || base === 'id_ecdsa' || base.startsWith('id_ecdsa.')
    || /^credentials(?:\..+)?\.json$/i.test(base)
  ) {
    return { ok: false, reason: '安全封鎖：禁止傳送憑證、私鑰或環境敏感檔' };
  }

  const paths = getDataPaths(root);
  const tg = tgPaths(root);
  const dataDirs = [normalizePathOrUri(paths.dataDir), resolveCanonicalRealPath(paths.dataDir)].filter(Boolean);
  if (base === 'config.json' && dataDirs.some((d) => candidates.some((c) => isPathInsideDir(c, d)))) {
    return { ok: false, reason: '安全封鎖：禁止傳送貓窩設定與憑證檔' };
  }

  const blockedExact = new Set([
    normalizePathOrUri(tg.configPath),
    resolveCanonicalRealPath(tg.configPath),
    normalizePathOrUri(tg.statePath),
    resolveCanonicalRealPath(tg.statePath),
    normalizePathOrUri(join(paths.runtimeDir, 'sessions.json')),
    resolveCanonicalRealPath(join(paths.runtimeDir, 'sessions.json')),
  ].filter(Boolean));
  if (candidates.some((c) => blockedExact.has(c))) {
    return { ok: false, reason: '安全封鎖：禁止傳送 Telegram Token 或會話敏感設定檔' };
  }

  const blockedDirs = [
    normalizePathOrUri(tg.outboxDir),
    resolveCanonicalRealPath(tg.outboxDir),
    normalizePathOrUri(paths.runtimeDir),
    resolveCanonicalRealPath(paths.runtimeDir),
    normalizePathOrUri(join(root, '.git')),
    resolveCanonicalRealPath(join(root, '.git')),
  ].filter(Boolean);
  if (blockedDirs.some((d) => candidates.some((c) => isPathInsideDir(c, d)))) {
    return { ok: false, reason: '安全封鎖：禁止傳送內部執行期或版本控制檔案' };
  }

  const sysGenSeg = process.platform === 'win32' ? '\\.system_generated\\' : '/.system_generated/';
  if (candidates.some((c) => c.includes(sysGenSeg))) {
    return { ok: false, reason: '安全封鎖：禁止傳送系統內部日誌檔' };
  }

  const projectRoots = [normalizePathOrUri(root), resolveCanonicalRealPath(root)].filter(Boolean);
  const inboxRoots = [normalizePathOrUri(tg.inboxDir), resolveCanonicalRealPath(tg.inboxDir)].filter(Boolean);
  const brainRaw = join(homedir(), '.gemini', 'antigravity', 'brain');
  const brainRoots = [normalizePathOrUri(brainRaw), resolveCanonicalRealPath(brainRaw)].filter(Boolean);
  const extraRoots = Array.isArray(cfg.extraSendDirs)
    ? cfg.extraSendDirs.flatMap((d) => [normalizePathOrUri(d), resolveCanonicalRealPath(d)]).filter(Boolean)
    : [];

  // Prevent a symlink inside allowed roots from pointing outside allowed directories
  const directRoots = [...new Set([...projectRoots, ...inboxRoots, ...extraRoots])];
  const allAllowedRoots = [...new Set([...directRoots, ...brainRoots])];

  const logicalOk = allAllowedRoots.some((dir) => isPathInsideDir(targetNorm, dir));
  const realOk = allAllowedRoots.some((dir) => isPathInsideDir(targetReal, dir));
  if (!logicalOk || !realOk) {
    return { ok: false, reason: '路徑不在允許範圍內（僅限 gemini_cat 專案、生成媒體暫存或自訂開放資料夾）' };
  }

  const inDirectRoot = directRoots.some((dir) => isPathInsideDir(targetReal, dir));
  const inBrainOnly = !inDirectRoot && brainRoots.some((dir) => isPathInsideDir(targetReal, dir));
  if (inBrainOnly && !BRAIN_ALLOWED_EXTS.has(ext)) {
    return { ok: false, reason: '安全封鎖：brain 目錄僅允許傳送圖片、音訊、影片或文件產物檔案' };
  }

  let fsPath = absFs;
  try {
    if (existsSync(absFs)) fsPath = realpathSync.native(absFs);
  } catch { /* keep resolved absFs */ }
  return { ok: true, fsPath, normalized: targetReal };
}

/**
 * Extracts clickable `file://...` URLs from Markdown replies so reply artifacts
 * can be forwarded back to Telegram automatically.
 */
export function extractMarkdownFileLinks(markdownText = '') {
  const s = String(markdownText || '');
  const seen = new Set();
  const out = [];
  const re = /file:\/\/\/[^\s)"'`<>]+/gi;
  let m;
  while ((m = re.exec(s)) !== null) {
    let rawUrl = m[0].replace(/[.,;:!?]+$/, '');
    // Drop optional `#L12-L34` line range anchor before decoding to file path
    const hashIdx = rawUrl.indexOf('#');
    if (hashIdx > 0) rawUrl = rawUrl.slice(0, hashIdx);
    let fsPath = '';
    try {
      fsPath = fileURLToPath(rawUrl);
    } catch {
      continue;
    }
    const norm = normalizePathOrUri(fsPath);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(fsPath);
    if (out.length >= 10) break;
  }
  return out;
}

export function chunkTelegramText(text = '', maxLen = 4000) {
  const s = String(text || '').trim();
  if (!s) return [];
  if (s.length <= maxLen) return [s];

  const chunks = [];
  let rem = s;
  while (rem.length > maxLen) {
    let cut = rem.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen * 0.4) cut = rem.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.4) cut = rem.lastIndexOf(' ', maxLen);
    if (cut < maxLen * 0.4) cut = maxLen;
    chunks.push(rem.slice(0, cut).trimEnd());
    rem = rem.slice(cut).trimStart();
  }
  if (rem) chunks.push(rem);
  return chunks.filter(Boolean);
}

export async function telegramApiCall(token, method, payload, { fetchFn = fetch, timeoutMs = 25_000 } = {}) {
  const t = String(token || '').trim();
  if (!t) return { ok: false, description: '尚未設定 Telegram Bot Token' };
  const url = `https://api.telegram.org/bot${t}/${method}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const isForm = typeof FormData !== 'undefined' && payload instanceof FormData;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? payload : JSON.stringify(payload || {}),
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    if (json && typeof json === 'object') {
      return json;
    }
    return { ok: false, error_code: res.status, description: redactToken(text.slice(0, 200), t) };
  } catch (err) {
    return {
      ok: false,
      description: redactToken(err?.name === 'AbortError' ? 'Telegram API 連線逾時' : (err?.message || String(err)), t),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function telegramGetMe(token, opts = {}) {
  return telegramApiCall(token, 'getMe', {}, opts);
}

export async function telegramGetUpdates(token, offset = 0, { timeoutSec = 20, fetchFn = fetch } = {}) {
  return telegramApiCall(
    token,
    'getUpdates',
    {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message'],
    },
    { fetchFn, timeoutMs: (timeoutSec + 10) * 1000 },
  );
}

export async function telegramSendText(token, chatId, text, { replyToMessageId, silent = false, fetchFn = fetch, timeoutMs = 15_000 } = {}) {
  const chunks = chunkTelegramText(text, 4000);
  if (!chunks.length) return { ok: true, results: [] };
  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const body = {
      chat_id: chatId,
      text: chunks[i],
    };
    if (silent) body.disable_notification = true;
    if (i === 0 && replyToMessageId) {
      body.reply_to_message_id = replyToMessageId;
    }
    const r = await telegramApiCall(token, 'sendMessage', body, { fetchFn, timeoutMs });
    if (!r.ok) return { ok: false, error: r.description || 'sendMessage 失敗', results };
    results.push(r.result);
  }
  return { ok: true, results };
}

export async function telegramSendFile(
  token,
  chatId,
  filePath,
  {
    root = getProjectRoot(),
    cfg = loadTelegramConfig(root),
    caption = '',
    asPhoto = true,
    silent = false,
    replyToMessageId,
    fetchFn = fetch,
    timeoutMs = 60_000,
  } = {},
) {
  const check = isAllowedTelegramSendPath(filePath, root, cfg);
  if (!check.ok) return { ok: false, error: check.reason };
  if (!existsSync(check.fsPath)) return { ok: false, error: `找不到檔案：${check.fsPath}` };

  const stat = statSync(check.fsPath);
  if (!stat.isFile()) return { ok: false, error: '目標路徑不是一般檔案' };
  if (stat.size <= 0) return { ok: false, error: '檔案為空，無法傳送' };
  if (stat.size > MAX_BOT_API_UPLOAD_BYTES) {
    return { ok: false, error: `檔案超過 Telegram Bot 50MB 傳輸上限（${(stat.size / (1024 * 1024)).toFixed(1)} MB）` };
  }

  const ext = extname(check.fsPath).toLowerCase();
  const usePhoto = asPhoto !== false && IMAGE_PHOTO_EXTS.has(ext) && stat.size <= MAX_PHOTO_UPLOAD_BYTES;
  const method = usePhoto ? 'sendPhoto' : 'sendDocument';
  const fieldName = usePhoto ? 'photo' : 'document';

  const buf = readFileSync(check.fsPath);
  const blob = new Blob([buf], { type: guessMimeType(check.fsPath) });
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append(fieldName, blob, basename(check.fsPath));

  const cleanCaption = String(caption || '').trim();
  const captionHead = cleanCaption.length > 1024 ? `${cleanCaption.slice(0, 1020)}…` : cleanCaption;
  if (captionHead) form.append('caption', captionHead);
  if (silent) form.append('disable_notification', 'true');
  if (replyToMessageId) form.append('reply_to_message_id', String(replyToMessageId));

  const res = await telegramApiCall(token, method, form, { fetchFn, timeoutMs });
  if (!res.ok) {
    // Fallback cleanly to sendDocument if sendPhoto rejected image dimensions
    if (usePhoto) {
      const docForm = new FormData();
      docForm.append('chat_id', String(chatId));
      docForm.append('document', new Blob([buf], { type: guessMimeType(check.fsPath) }), basename(check.fsPath));
      if (captionHead) docForm.append('caption', captionHead);
      if (silent) docForm.append('disable_notification', 'true');
      const docRes = await telegramApiCall(token, 'sendDocument', docForm, { fetchFn, timeoutMs });
      if (docRes.ok) {
        if (cleanCaption.length > 1024) {
          await telegramSendText(token, chatId, cleanCaption.slice(1020), { silent, fetchFn, timeoutMs });
        }
        return { ok: true, method: 'sendDocument', filePath: check.fsPath, result: docRes.result };
      }
      return { ok: false, error: docRes.description || res.description || '傳送檔案失敗' };
    }
    return { ok: false, error: res.description || '傳送檔案失敗' };
  }

  if (cleanCaption.length > 1024) {
    await telegramSendText(token, chatId, cleanCaption.slice(1020), { silent, fetchFn, timeoutMs });
  }
  return { ok: true, method, filePath: check.fsPath, result: res.result };
}

export function extractAttachmentsFromMessage(msg = {}) {
  const items = [];
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    if (largest?.file_id) {
      items.push({
        kind: 'photo',
        fileId: largest.file_id,
        fileSize: Number(largest.file_size || 0),
        originalName: `photo_${msg.message_id || Date.now()}.jpg`,
        mimeType: 'image/jpeg',
      });
    }
  }
  if (msg.document?.file_id) {
    items.push({
      kind: 'document',
      fileId: msg.document.file_id,
      fileSize: Number(msg.document.file_size || 0),
      originalName: msg.document.file_name || `doc_${msg.message_id || Date.now()}`,
      mimeType: msg.document.mime_type || '',
    });
  }
  if (msg.voice?.file_id) {
    items.push({
      kind: 'voice',
      fileId: msg.voice.file_id,
      fileSize: Number(msg.voice.file_size || 0),
      originalName: `voice_${msg.message_id || Date.now()}.ogg`,
      mimeType: msg.voice.mime_type || 'audio/ogg',
    });
  }
  if (msg.audio?.file_id) {
    items.push({
      kind: 'audio',
      fileId: msg.audio.file_id,
      fileSize: Number(msg.audio.file_size || 0),
      originalName: msg.audio.file_name || `audio_${msg.message_id || Date.now()}.mp3`,
      mimeType: msg.audio.mime_type || 'audio/mpeg',
    });
  }
  if (msg.video?.file_id) {
    items.push({
      kind: 'video',
      fileId: msg.video.file_id,
      fileSize: Number(msg.video.file_size || 0),
      originalName: msg.video.file_name || `video_${msg.message_id || Date.now()}.mp4`,
      mimeType: msg.video.mime_type || 'video/mp4',
    });
  }
  if (msg.video_note?.file_id) {
    items.push({
      kind: 'video_note',
      fileId: msg.video_note.file_id,
      fileSize: Number(msg.video_note.file_size || 0),
      originalName: `videonote_${msg.message_id || Date.now()}.mp4`,
      mimeType: 'video/mp4',
    });
  }
  if (msg.sticker?.file_id && !msg.sticker.is_animated) {
    items.push({
      kind: 'sticker',
      fileId: msg.sticker.file_id,
      fileSize: Number(msg.sticker.file_size || 0),
      originalName: `sticker_${msg.message_id || Date.now()}.${msg.sticker.is_video ? 'webm' : 'webp'}`,
      mimeType: msg.sticker.is_video ? 'video/webm' : 'image/webp',
    });
  }
  return items;
}

export async function telegramDownloadIncomingFile(
  token,
  attachment,
  { root = getProjectRoot(), msgId = Date.now(), maxBytes = MAX_BOT_API_DOWNLOAD_BYTES, fetchFn = fetch, now = Date.now() } = {},
) {
  const cap = Math.min(MAX_BOT_API_DOWNLOAD_BYTES, Math.max(1024, Number(maxBytes || MAX_BOT_API_DOWNLOAD_BYTES)));
  if (attachment.fileSize > 0 && attachment.fileSize > cap) {
    return {
      ok: false,
      error: `檔案過大（${(attachment.fileSize / (1024 * 1024)).toFixed(1)} MB > 上限 ${(cap / (1024 * 1024)).toFixed(0)} MB）`,
    };
  }
  const meta = await telegramApiCall(token, 'getFile', { file_id: attachment.fileId }, { fetchFn });
  if (!meta.ok || !meta.result?.file_path) {
    return { ok: false, error: meta.description || 'getFile 取得檔案資訊失敗' };
  }
  const remotePath = meta.result.file_path;
  const remoteSize = Number(meta.result.file_size || attachment.fileSize || 0);
  if (remoteSize > cap) {
    return { ok: false, error: `檔案過大（${(remoteSize / (1024 * 1024)).toFixed(1)} MB）` };
  }

  const dlUrl = `https://api.telegram.org/file/bot${token}/${remotePath}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 45_000);
  try {
    const res = await fetchFn(dlUrl, { method: 'GET', signal: ac.signal });
    if (!res.ok) {
      return { ok: false, error: `下載失敗 (HTTP ${res.status})` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > cap) {
      return { ok: false, error: '下載檔案超過大小限制' };
    }
    const day = localDayKey(now);
    const dayDir = join(tgPaths(root).inboxDir, day);
    mkdirSync(dayDir, { recursive: true });
    const remoteExt = extname(remotePath);
    const desiredName = sanitizeFilename(attachment.originalName || basename(remotePath), remoteExt);
    const prefix = String(msgId || Date.now()).replace(/[^A-Za-z0-9_-]/g, '');
    const outPath = join(dayDir, `${prefix}_${desiredName}`);
    writeFileSync(outPath, buf);
    return {
      ok: true,
      localPath: outPath,
      size: buf.length,
      mimeType: attachment.mimeType || guessMimeType(outPath),
      originalName: desiredName,
      kind: attachment.kind,
    };
  } catch (err) {
    return { ok: false, error: redactToken(err?.message || String(err), token) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Neutralizes internal control markers / Antigravity XML envelope tags inside
 * external Telegram messages so remote text cannot forge hook modes or prompts.
 */
export function neutralizeTelegramMarkers(text = '') {
  return String(text || '')
    .replace(
      /\[(SPEAK_UP_INTERNAL|XINGXI_AUTO_PICKUP|CAT_NEST_EVENT|TELEGRAM_INCOMING|WORK_SCAN|CRON|AUTOMATION|YOUTUBE_PATROL)\]/gi,
      '［$1］',
    )
    .replace(
      /<(\/?)(speak-up|SYSTEM_MESSAGE|SYSTEM_REMINDER|USER_REQUEST|ADDITIONAL_METADATA|CONTEXT_SUMMARY)/gi,
      '＜$1$2',
    );
}

export function formatTelegramIncomingPrompt({
  text = '',
  files = [],
  failedFiles = [],
  senderLabel = '',
  now = Date.now(),
} = {}) {
  const lines = [
    TELEGRAM_INCOMING_MARKER,
    `（這是${senderLabel || '主人'}從 Telegram 傳來的訊息，請直接自然回覆；你這輪的最終文字與生成的檔案會自動轉發回 Telegram。）`,
  ];
  if (files.length) {
    lines.push('（對方夾帶了以下檔案並已下載至本機；需要檢視圖片、音訊或文件內容時可直接用 read_file 開啟路徑；若要主動回傳指定本機檔案或圖片可呼叫 `telegram_send`）');
  }
  lines.push(`時間：${localClockDisplay(now)}`);
  const safeText = neutralizeTelegramMarkers(String(text || '').trim());
  if (safeText) {
    lines.push('訊息內容：', safeText);
  }
  if (files.length) {
    lines.push('夾帶檔案：');
    for (const f of files) {
      const kb = Math.max(1, Math.round((f.size || 0) / 1024));
      lines.push(`- ${f.originalName} (${f.mimeType || f.kind || 'file'}, ${kb} KB) -> ${f.localPath.replace(/\\/g, '/')}`);
    }
  }
  if (failedFiles.length) {
    lines.push('未下載成功的檔案：');
    for (const ff of failedFiles) {
      lines.push(`- ${ff.originalName || '檔案'}：${ff.error}`);
    }
  }
  return lines.join('\n');
}

/**
 * Extracts clean human text from `[TELEGRAM_INCOMING]` wrapper so Mood fallback,
 * Fish Memory queries, and sleep wake-word matching never read boilerplate.
 */
export function extractTelegramCleanUserText(rawInput = '') {
  let s = String(rawInput || '').trim();
  s = s.replace(/^<SYSTEM_MESSAGE>\s*/i, '').replace(/\n?<\/SYSTEM_MESSAGE>\s*$/i, '').trim();
  if (!s.startsWith(TELEGRAM_INCOMING_MARKER)) return s;
  const msgIdx = s.indexOf('\n訊息內容：\n');
  if (msgIdx >= 0) {
    let body = s.slice(msgIdx + '\n訊息內容：\n'.length);
    for (const marker of ['\n夾帶檔案：', '\n未下載成功的檔案：']) {
      const cut = body.indexOf(marker);
      if (cut >= 0) body = body.slice(0, cut);
    }
    return body.trim();
  }
  const filesIdx = s.indexOf('\n夾帶檔案：\n');
  if (filesIdx >= 0) {
    return s.slice(filesIdx + 1).trim();
  }
  return s.replace(TELEGRAM_INCOMING_MARKER, '').trim();
}

/**
 * Processes one or more grouped Telegram message updates (`media_group_id` albums share 1 dispatch).
 */
export async function handleTelegramUpdatesBatch(
  updates = [],
  {
    root = getProjectRoot(),
    dispatchToConversation = null,
    fetchFn = fetch,
    now = Date.now(),
  } = {},
) {
  if (!Array.isArray(updates) || !updates.length) return { handled: 0 };
  const cfg = loadTelegramConfig(root);
  const initialState = loadTelegramState(root);
  const token = cfg.botToken;

  let maxUpdateId = initialState.lastUpdateId;
  let dispatched = 0;

  // Group contiguous updates sharing the same `media_group_id` from the same chat
  const groups = [];
  const albumMap = new Map();
  for (const upd of updates) {
    const uid = Number(upd?.update_id || 0);
    if (uid > maxUpdateId) maxUpdateId = uid;
    const msg = upd?.message;
    if (!msg || msg.from?.is_bot) continue;
    const chatId = String(msg.chat?.id ?? '').trim();
    if (!chatId) continue;

    if (msg.media_group_id) {
      const key = `${chatId}:${msg.media_group_id}`;
      if (albumMap.has(key)) {
        albumMap.get(key).push(msg);
      } else {
        const arr = [msg];
        albumMap.set(key, arr);
        groups.push(arr);
      }
    } else {
      groups.push([msg]);
    }
  }

  const allowedSet = parseChatIdSet(cfg.allowedChatId);

  for (const msgs of groups) {
    const head = msgs[0];
    const chatId = String(head.chat?.id ?? '').trim();
    const userLabel = head.from?.username ? `@${head.from.username}` : (head.from?.first_name || '主人');
    const combinedTexts = msgs
      .map((m) => String(m.text || m.caption || '').trim())
      .filter(Boolean);
    const primaryText = combinedTexts.join('\n').trim();

    // Handle temporary pairing command `/bind <CODE>` or `/start <CODE>` before whitelist check
    const bindMatch = /^(?:\/bind|\/start)\s+([A-Za-z0-9]{4,12})$/i.exec(primaryText);
    if (bindMatch) {
      const currentFailure = loadTelegramState(root).bindFailures?.[chatId];
      if (currentFailure && Number(currentFailure.lockedUntil || 0) > now) {
        updateTelegramStateLocked(root, (st) => {
          appendTelegramLog(st, `已拒絕配對請求（冷卻鎖定中）：chatId=${chatId}`, now, token);
        });
        await telegramSendText(
          token,
          chatId,
          '✗ 連續配對失敗次數過多，請 15 分鐘後再試。',
          { replyToMessageId: head.message_id, fetchFn },
        );
        continue;
      }

      const submitted = bindMatch[1].toUpperCase();
      const validCode = Boolean(cfg.pairCode && cfg.pairCodeExpiresAt > now && submitted === cfg.pairCode.toUpperCase());
      const lockedOut = cfg.lockSingleChat !== false && allowedSet.size > 0 && !allowedSet.has(chatId);
      if (lockedOut) {
        updateTelegramStateLocked(root, (st) => {
          appendTelegramLog(st, `已拒絕第二支帳號配對（單一帳號鎖定中）：${userLabel}, chatId=${chatId}`, now, token);
        });
        await telegramSendText(
          token,
          chatId,
          validCode
            ? '✗ 此貓窩已鎖定單一主人帳號，不接受第二支帳號加入。如需換綁，請先在電腦端側邊欄取消單一帳號鎖定或清空舊 Chat ID。'
            : '✗ 配對碼無效或已過期，請回到電腦貓窩側邊欄的「TG」分頁確認設定。',
          { replyToMessageId: head.message_id, fetchFn },
        );
        continue;
      }
      if (validCode) {
        const nextAllowed = allowedSet.size && allowedSet.has(chatId)
          ? cfg.allowedChatId
          : (cfg.allowedChatId ? `${cfg.allowedChatId}, ${chatId}` : chatId);
        saveTelegramConfig({
          allowedChatId: nextAllowed,
          allowedUsername: userLabel,
          pairCode: '',
          pairCodeExpiresAt: 0,
        }, root);
        cfg.allowedChatId = nextAllowed;
        cfg.pairCode = '';
        cfg.pairCodeExpiresAt = 0;
        allowedSet.add(chatId);
        updateTelegramStateLocked(root, (st) => {
          if (st.bindFailures && typeof st.bindFailures === 'object') {
            delete st.bindFailures[chatId];
          }
          appendTelegramLog(st, `配對成功！已綁定 ${userLabel} (chatId=${chatId})`, now, token);
        });
        await telegramSendText(
          token,
          chatId,
          `✓ 已成功綁定「Gemini-chan 貓窩」！現在直接傳文字、圖片或檔案給我就好囉。`,
          { replyToMessageId: head.message_id, fetchFn },
        );
      } else {
        let justLocked = false;
        updateTelegramStateLocked(root, (st) => {
          const prev = st.bindFailures?.[chatId];
          const withinWindow = prev && (now - Number(prev.firstAt || 0)) <= 10 * 60_000;
          const nextCount = withinWindow ? (Number(prev.count || 0) + 1) : 1;
          const lockedUntil = nextCount >= 5 ? (now + 15 * 60_000) : 0;
          justLocked = lockedUntil > now;
          st.bindFailures = st.bindFailures || {};
          st.bindFailures[chatId] = {
            count: nextCount,
            firstAt: withinWindow ? Number(prev.firstAt || now) : now,
            lockedUntil,
          };
          appendTelegramLog(
            st,
            justLocked
              ? `配對失敗達 ${nextCount} 次，已鎖定 chatId=${chatId} 15 分鐘`
              : `配對失敗 (${nextCount}/5)：無效或過期配對碼來自 chatId=${chatId}`,
            now,
            token,
          );
        });
        await telegramSendText(
          token,
          chatId,
          justLocked
            ? '✗ 連續配對失敗達 5 次，已暫時鎖定 15 分鐘，請稍後再回到側邊欄重新產生配對碼。'
            : '✗ 配對碼無效或已過期，請回到電腦貓窩側邊欄的「TG」分頁重新產生一組配對碼。',
          { replyToMessageId: head.message_id, fetchFn },
        );
      }
      continue;
    }

    if (!allowedSet.size || !allowedSet.has(chatId)) {
      updateTelegramStateLocked(root, (st) => {
        appendTelegramLog(st, `已攔截未授權 Telegram 訊息（來自 ${userLabel}, chatId=${chatId}）`, now, token);
      });
      continue;
    }

    if (primaryText === '/id') {
      await telegramSendText(token, chatId, `你的 Telegram Chat ID：${chatId}`, {
        replyToMessageId: head.message_id,
        fetchFn,
      });
      continue;
    }

    if (!cfg.enabled || !cfg.receiveEnabled) {
      continue;
    }

    const files = [];
    const failedFiles = [];
    const maxBytes = (cfg.maxUploadMb || 20) * 1024 * 1024;
    for (const m of msgs) {
      const attachments = extractAttachmentsFromMessage(m);
      for (const att of attachments) {
        if (!cfg.downloadFiles) {
          failedFiles.push({ originalName: att.originalName, error: '已關閉自動下載傳入檔案' });
          continue;
        }
        const dl = await telegramDownloadIncomingFile(token, att, {
          root,
          msgId: m.message_id,
          maxBytes,
          fetchFn,
          now,
        });
        if (dl.ok) files.push(dl);
        else failedFiles.push({ originalName: att.originalName, error: dl.error });
      }
    }

    if (!primaryText && !files.length && !failedFiles.length) {
      continue;
    }

    const formatted = formatTelegramIncomingPrompt({
      text: primaryText,
      files,
      failedFiles,
      senderLabel: userLabel,
      now,
    });

    if (typeof dispatchToConversation === 'function') {
      try {
        await dispatchToConversation(formatted, { chatId, userLabel, files, messageId: head.message_id });
        dispatched++;
        updateTelegramStateLocked(root, (st) => {
          st.lastReceivedAt = now;
          appendTelegramChatEntry(
            st,
            {
              dir: 'in',
              mode: 'telegram',
              sender: userLabel,
              text: primaryText,
              files: files.map((f) => f.originalName),
            },
            now,
            token,
          );
          appendTelegramLog(
            st,
            `已轉入 Antigravity（${primaryText ? `${primaryText.slice(0, 26)}${primaryText.length > 26 ? '…' : ''}` : ''}${files.length ? ` + ${files.length} 檔` : ''}）`,
            now,
            token,
          );
        });
      } catch (err) {
        const msgErr = redactToken(err?.message || String(err), token);
        updateTelegramStateLocked(root, (st) => {
          appendTelegramLog(st, `轉入對話失敗：${msgErr}`, now, token);
        });
        await telegramSendText(
          token,
          chatId,
          `（電腦端 Antigravity 暫時連不上或正在忙，這則訊息還沒成功送進去：${msgErr.slice(0, 120)}）`,
          { replyToMessageId: head.message_id, fetchFn },
        );
      }
    }
  }

  updateTelegramStateLocked(root, (st) => {
    st.lastUpdateId = Math.max(Number(st.lastUpdateId || 0), maxUpdateId);
    st.lastPollAt = now;
  });
  return { handled: dispatched, lastUpdateId: maxUpdateId };
}

/**
 * Queues an outgoing reply/proactive message into `data/telegram/outbox/*.json`
 * cleanly inside `Stop` hook (< 3ms) without risking 15s hook timeouts.
 */
export function maybeQueueTelegramOutgoing({
  root = getProjectRoot(),
  mode = 'user',
  sid = '',
  turnHash = '',
  userText = '',
  assistantText = '',
  lastDesktopSpeechAt = 0,
  now = Date.now(),
} = {}) {
  const cfg = loadTelegramConfig(root);
  if (!cfg.enabled || !cfg.botToken || !cfg.allowedChatId) {
    return { queued: false, reason: 'disabled_or_unconfigured' };
  }

  const text = String(assistantText || '').trim();
  const mirrorUserText = (mode === 'user' && cfg.forwardDesktopReplies === true && cfg.forwardDesktopUserMessages !== false)
    ? String(userText || '').trim().slice(0, 4000)
    : '';

  let shouldForward = false;
  if (mode === 'telegram') shouldForward = cfg.forwardTelegramReplies !== false;
  else if (mode === 'speak-up') shouldForward = cfg.forwardSpeakUp !== false;
  else if (mode === 'xingxi-pickup') shouldForward = cfg.forwardXingxi === true;
  else if (mode === 'user' || mode === 'nest-event') shouldForward = cfg.forwardDesktopReplies === true;
  else shouldForward = false;

  if (!shouldForward) {
    return { queued: false, reason: `mode_not_forwarded:${mode}` };
  }

  const { statePath, outboxDir, inboxDir } = tgPaths(root);
  return withFileLockSync(statePath, () => {
    const state = loadTelegramState(root);
    if (turnHash && state.forwardedTurns.includes(turnHash)) {
      return { queued: false, reason: 'duplicate_turn' };
    }

    let silent = false;
    if (mode !== 'telegram') {
      const muteInfo = isDesktopActiveMute(root, cfg, state, now, lastDesktopSpeechAt);
      if (muteInfo.active) {
        if (cfg.desktopMuteMode !== 'silent') {
          appendTelegramLog(state, `桌面對話活躍中（剩 ${muteInfo.minsLeft} 分），已略過 ${mode} Telegram 推播`, now, cfg.botToken);
          if (turnHash) {
            state.forwardedTurns.push(turnHash);
            if (state.forwardedTurns.length > 80) state.forwardedTurns = state.forwardedTurns.slice(-80);
          }
          writeJsonAtomic(statePath, normalizeTelegramStateObject(state));
          return { queued: false, reason: 'desktop_active_muted' };
        }
        silent = true;
      }
    }

    const files = [];
    if (cfg.autoSendReplyFiles && text) {
      const inboxNorm = resolveCanonicalRealPath(inboxDir) || normalizePathOrUri(inboxDir);
      const recentSent = new Set(
        (state.recentMcpSentFiles || [])
          .filter((r) => r && (now - Number(r.at || 0)) <= 120_000)
          .map((r) => resolveCanonicalRealPath(r.path) || normalizePathOrUri(r.path)),
      );
      const links = extractMarkdownFileLinks(text);
      for (const candidate of links) {
        const check = isAllowedTelegramSendPath(candidate, root, cfg);
        if (!check.ok || !existsSync(check.fsPath)) continue;
        if (inboxNorm && isPathInsideDir(check.normalized, inboxNorm)) continue;
        if (recentSent.has(check.normalized)) continue;
        files.push(check.fsPath);
      }
    }

    if (!text && !mirrorUserText && !files.length) {
      return { queued: false, reason: 'empty_output' };
    }

    const jobId = `tg_${now}_${Math.random().toString(36).slice(2, 8)}`;
    mkdirSync(outboxDir, { recursive: true });
    writeJsonAtomic(join(outboxDir, `${jobId}.json`), {
      id: jobId,
      createdAt: now,
      attempts: 0,
      mode,
      sid,
      silent,
      chatIds: [...parseChatIdSet(cfg.allowedChatId)],
      mirrorUserText,
      mirrorUserSent: false,
      text,
      files,
    });

    if (turnHash) {
      state.forwardedTurns.push(turnHash);
      if (state.forwardedTurns.length > 80) state.forwardedTurns = state.forwardedTurns.slice(-80);
    }
    writeJsonAtomic(statePath, normalizeTelegramStateObject(state));
    return { queued: true, jobId, silent, mirroredUser: Boolean(mirrorUserText), fileCount: files.length };
  });
}

const activeOutboxFlushes = new Set();

export async function flushTelegramOutbox(
  root = getProjectRoot(),
  { fetchFn = fetch, now = Date.now(), timeoutMs = 30_000 } = {},
) {
  const { outboxDir } = tgPaths(root);
  const lockKey = normalizePathOrUri(outboxDir) || outboxDir;
  if (activeOutboxFlushes.has(lockKey)) {
    return { sent: 0, remaining: 0, busy: true };
  }
  activeOutboxFlushes.add(lockKey);
  try {
  if (!existsSync(outboxDir)) return { sent: 0, remaining: 0 };

  let files;
  try {
    files = readdirSync(outboxDir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return { sent: 0, remaining: 0 };
  }
  if (!files.length) return { sent: 0, remaining: 0 };

  const cfg = loadTelegramConfig(root);
  const token = cfg.botToken;
  if (!cfg.enabled || !token) {
    return { sent: 0, remaining: files.length };
  }

  const pendingChatEntries = [];
  const pendingLogs = [];
  let sentCount = 0;

  for (const fname of files) {
    const fpath = join(outboxDir, fname);
    const job = readJsonSafe(fpath, null);
    if (!job || !Array.isArray(job.chatIds) || !job.chatIds.length) {
      try { unlinkSync(fpath); } catch { /* ignore */ }
      continue;
    }

    let okAll = true;
    let mirrorSentThisPass = false;
    let lastErr = '';
    if (job.mirrorUserText && !job.mirrorUserSent) {
      let mirrorOk = true;
      for (const cid of job.chatIds) {
        const mr = await telegramSendText(
          token,
          cid,
          `💬 你（電腦端）：\n${job.mirrorUserText}`,
          { silent: Boolean(job.silent), fetchFn, timeoutMs },
        );
        if (!mr.ok) {
          mirrorOk = false;
          okAll = false;
          lastErr = mr.error || 'sendMessage (desktop prompt) 失敗';
        }
      }
      if (mirrorOk) {
        job.mirrorUserSent = true;
        mirrorSentThisPass = true;
      }
    }

    if (okAll) {
      for (const cid of job.chatIds) {
        if (job.text) {
          const tr = await telegramSendText(token, cid, job.text, { silent: Boolean(job.silent), fetchFn, timeoutMs });
          if (!tr.ok) {
            okAll = false;
            lastErr = tr.error || 'sendMessage 失敗';
          }
        }
        if (Array.isArray(job.files)) {
          for (const fp of job.files) {
            const fr = await telegramSendFile(token, cid, fp, { root, cfg, silent: Boolean(job.silent), fetchFn, timeoutMs });
            if (!fr.ok) {
              pendingLogs.push(`附件自動轉傳略過 (${basename(fp)})：${fr.error}`);
            }
          }
        }
      }
    }

    if (okAll) {
      try { unlinkSync(fpath); } catch { /* ignore */ }
      sentCount++;
      if (job.mirrorUserText) {
        pendingChatEntries.push({
          entry: {
            dir: 'in',
            mode: 'desktop-mirror',
            sender: '你（電腦端）',
            text: job.mirrorUserText,
            files: [],
            silent: Boolean(job.silent),
          },
          at: now,
        });
      }
      if (job.text || (Array.isArray(job.files) && job.files.length)) {
        pendingChatEntries.push({
          entry: {
            dir: 'out',
            mode: job.mode || 'telegram',
            sender: 'Gemini 貓貓',
            text: job.text || '',
            files: Array.isArray(job.files) ? job.files.map((fp) => basename(fp)) : [],
            silent: Boolean(job.silent),
          },
          at: now + (job.mirrorUserText ? 1 : 0),
        });
      }
      pendingLogs.push(
        `已${job.silent ? '靜音' : ''}轉發${job.mirrorUserText ? '電腦提問+' : ''}回覆到 Telegram（${job.text ? `${job.text.slice(0, 22)}${job.text.length > 22 ? '…' : ''}` : ''}${job.files?.length ? ` + ${job.files.length} 檔` : ''}）`,
      );
    } else {
      job.attempts = Number(job.attempts || 0) + 1;
      if (mirrorSentThisPass && job.mirrorUserText) {
        pendingChatEntries.push({
          entry: {
            dir: 'in',
            mode: 'desktop-mirror',
            sender: '你（電腦端）',
            text: job.mirrorUserText,
            files: [],
            silent: Boolean(job.silent),
          },
          at: now,
        });
      }
      if (job.attempts >= 5) {
        try { unlinkSync(fpath); } catch { /* ignore */ }
        pendingLogs.push(`Telegram 發送重試達上限已放棄：${lastErr}`);
      } else {
        writeJsonAtomic(fpath, job);
        pendingLogs.push(`Telegram 發送失敗（將重試 ${job.attempts}/5）：${lastErr}`);
      }
    }
  }

  if (sentCount > 0 || pendingChatEntries.length || pendingLogs.length) {
    updateTelegramStateLocked(root, (st) => {
      if (sentCount > 0) st.lastSentAt = now;
      for (const item of pendingChatEntries) {
        appendTelegramChatEntry(st, item.entry, item.at, token);
      }
      for (const msg of pendingLogs) {
        appendTelegramLog(st, msg, now, token);
      }
    });
  }
  let remaining = 0;
  try { remaining = readdirSync(outboxDir).filter((f) => f.endsWith('.json')).length; } catch { /* ignore */ }
  return { sent: sentCount, remaining };
  } finally {
    activeOutboxFlushes.delete(lockKey);
  }
}

/**
 * Records an MCP `telegram_send` file transfer so `Stop` hook doesn't duplicate-send it.
 */
export function recordTelegramMcpSentFile(root = getProjectRoot(), filePath, now = Date.now()) {
  const norm = resolveCanonicalRealPath(filePath) || normalizePathOrUri(filePath);
  if (!norm) return;
  updateTelegramStateLocked(root, (st) => {
    st.recentMcpSentFiles.push({ at: now, path: norm });
    st.lastSentAt = now;
  });
}

export async function pollTelegramOnce(
  root = getProjectRoot(),
  { dispatchToConversation = null, fetchFn = fetch, timeoutSec = 20, now = Date.now() } = {},
) {
  const cfg = loadTelegramConfig(root);
  if (!cfg.enabled || !cfg.botToken) {
    return { ok: false, skipped: true };
  }
  const state = loadTelegramState(root);
  const res = await telegramGetUpdates(cfg.botToken, state.lastUpdateId + 1, { timeoutSec, fetchFn });
  if (!res.ok) {
    const errText = redactToken(res.description || 'getUpdates 失敗', cfg.botToken);
    updateTelegramStateLocked(root, (stNow) => {
      stNow.lastPollAt = now;
      stNow.lastPollError = errText;
      appendTelegramLog(stNow, `輪詢錯誤：${errText}`, now, cfg.botToken);
    });
    return { ok: false, error: errText };
  }

  if (state.lastPollError) {
    updateTelegramStateLocked(root, (stClear) => {
      stClear.lastPollError = '';
    });
  }

  const updates = Array.isArray(res.result) ? res.result : [];
  if (!updates.length) {
    updateTelegramStateLocked(root, (stQuiet) => {
      stQuiet.lastPollAt = now;
      stQuiet.lastPollError = '';
    });
    return { ok: true, updates: 0 };
  }

  const batch = await handleTelegramUpdatesBatch(updates, {
    root,
    dispatchToConversation,
    fetchFn,
    now,
  });
  return { ok: true, updates: updates.length, handled: batch.handled };
}

/**
 * Extracts `[TELEGRAM_INCOMING]` user turns and their matching `PLANNER_RESPONSE`
 * replies from Antigravity's `transcript.jsonl` into `state.chatHistory` so
 * historical Telegram exchanges can also be viewed cleanly inside Sidecar.
 */
export function syncTelegramHistoryFromTranscript(root = getProjectRoot(), transcriptPath = '') {
  const pathStr = String(transcriptPath || '').trim();
  if (!pathStr || !existsSync(pathStr)) {
    return { ok: false, imported: 0, error: '找不到指定對話的 transcript 紀錄檔' };
  }

  let lines;
  try {
    lines = readFileSync(pathStr, { encoding: 'utf-8' }).split(/\r?\n/).filter(Boolean);
  } catch (err) {
    return { ok: false, imported: 0, error: err?.message || '讀取 transcript 失敗' };
  }

  const parsedEntries = [];
  let awaitingReply = false;
  for (const raw of lines) {
    let step;
    try { step = JSON.parse(raw); } catch { continue; }
    const content = typeof step?.content === 'string' ? step.content : '';
    const unwrappedContent = content.replace(/^<SYSTEM_MESSAGE>\s*/i, '').trimStart();
    const ts = step?.created_at ? (Date.parse(step.created_at) || Date.now()) : Date.now();
    if (step?.type === 'SYSTEM_MESSAGE' && unwrappedContent.startsWith(TELEGRAM_INCOMING_MARKER)) {
      const cleanIn = extractTelegramCleanUserText(content);
      if (cleanIn) {
        parsedEntries.push({
          key: `in|${cleanIn.slice(0, 80)}`,
          entry: {
            at: ts,
            time: localClockDisplay(ts),
            dir: 'in',
            mode: 'telegram',
            sender: '主人（Telegram）',
            text: cleanIn.slice(0, 1200),
            files: [],
            silent: false,
          },
        });
      }
      awaitingReply = true;
      continue;
    }
    if (awaitingReply && step?.type === 'PLANNER_RESPONSE' && content.trim()) {
      const cleanOut = content.trim();
      parsedEntries.push({
        key: `out|${cleanOut.slice(0, 80)}`,
        entry: {
          at: ts,
          time: localClockDisplay(ts),
          dir: 'out',
          mode: 'telegram',
          sender: 'Gemini 貓貓',
          text: cleanOut.slice(0, 1200),
          files: [],
          silent: false,
        },
      });
      awaitingReply = false;
      continue;
    }
    if (step?.type === 'USER_INPUT') {
      awaitingReply = false;
    }
  }

  let imported = 0;
  let total = 0;
  updateTelegramStateLocked(root, (st) => {
    const existingKeys = new Set(
      (st.chatHistory || []).map((e) => `${e.dir}|${String(e.text || '').slice(0, 80)}`),
    );
    for (const item of parsedEntries) {
      if (!existingKeys.has(item.key)) {
        existingKeys.add(item.key);
        st.chatHistory.push(item.entry);
        imported++;
      }
    }
    if (imported > 0) {
      st.chatHistory.sort((a, b) => Number(a.at || 0) - Number(b.at || 0));
    }
    total = Math.min(40, st.chatHistory.length);
  });
  return { ok: true, imported, total };
}
