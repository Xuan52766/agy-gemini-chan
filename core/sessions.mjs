/**
 * @fileoverview Low-level verified `gemini_cat` session registry (`runtime/sessions.json`).
 *
 * Depends strictly on `node:path` and `./storage.mjs` so lower-layer domain modules
 * (`xingxi.mjs`, `telegram.mjs`) can query session metadata cleanly without reading
 * private JSON files directly or creating circular dependencies with `bridge.mjs`.
 */

import { join } from 'node:path';
import {
  canonicalSessionKey,
  getDataPaths,
  getProjectRoot,
  isProjectWorkspaceActive,
  readJsonSafe,
  updateJsonLocked,
} from './storage.mjs';

export function getSessionsFilePath(root = getProjectRoot()) {
  return join(getDataPaths(root).runtimeDir, 'sessions.json');
}

export function loadRegisteredSessions(root = getProjectRoot()) {
  const raw = readJsonSafe(getSessionsFilePath(root), null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sessions)) {
    return { activeConversationId: '', sessions: [] };
  }
  return {
    activeConversationId: String(raw.activeConversationId || ''),
    sessions: raw.sessions.slice(-40),
  };
}

/**
 * Registers or refreshes a verified `gemini_cat` conversation so Speak-Up and Sidecar
 * strictly target only conversations inside this project workspace.
 */
export function registerProjectConversation(
  {
    conversationId,
    workspacePaths = [],
    cwd = '',
    transcriptPath = '',
    modelName = '',
    sourceKind = 'user',
    lastUserMessageAt = 0,
    lastDesktopMessageAt = 0,
    turnKey = '',
    turnStartedAt = 0,
    lastRawUserInput = undefined,
    lastInputStepIndex = undefined,
    injectedPersonaHash = undefined,
    hasInjectedStaticRules = undefined,
    hasInjectedStartupContext = undefined,
    injectedRulesHash = undefined,
  } = {},
  root = getProjectRoot(),
) {
  if (!conversationId) return null;
  if (!isProjectWorkspaceActive(workspacePaths, cwd, root)) {
    return null;
  }

  const now = Date.now();
  const key = canonicalSessionKey(conversationId);
  let savedEntry = null;
  updateJsonLocked(getSessionsFilePath(root), { activeConversationId: '', sessions: [] }, (raw) => {
    const data = {
      activeConversationId: String(raw?.activeConversationId || ''),
      sessions: Array.isArray(raw?.sessions) ? raw.sessions.slice() : [],
    };
    let entry = data.sessions.find((s) => canonicalSessionKey(s.conversationId) === key);
    if (!entry) {
      entry = {
        conversationId: String(conversationId),
        firstSeenAt: now,
        lastSeenAt: now,
        lastUserSpeechAt: lastUserMessageAt > 0 ? lastUserMessageAt : 0,
        lastDesktopSpeechAt: lastDesktopMessageAt > 0 ? lastDesktopMessageAt : 0,
        lastTurnStartAt: turnStartedAt || 0,
        lastInjectedTurnKey: turnKey || '',
        lastRawUserInput: typeof lastRawUserInput === 'string' ? lastRawUserInput : '',
        lastInputStepIndex: Number.isFinite(lastInputStepIndex) ? lastInputStepIndex : -1,
        injectedPersonaHash: typeof injectedPersonaHash === 'string' ? injectedPersonaHash : '',
        hasInjectedStaticRules: Boolean(hasInjectedStaticRules),
        hasInjectedStartupContext: Boolean(hasInjectedStartupContext),
        injectedRulesHash: typeof injectedRulesHash === 'string' ? injectedRulesHash : '',
        transcriptPath: transcriptPath || '',
        modelName: modelName || '',
        turnCount: 0,
      };
      data.sessions.push(entry);
    } else {
      entry.conversationId = String(conversationId);
      entry.lastSeenAt = now;
      if (transcriptPath) entry.transcriptPath = transcriptPath;
      if (modelName) entry.modelName = modelName;
      if (lastUserMessageAt > 0) entry.lastUserSpeechAt = lastUserMessageAt;
      if (lastDesktopMessageAt > 0) entry.lastDesktopSpeechAt = lastDesktopMessageAt;
      if (turnStartedAt > 0) entry.lastTurnStartAt = turnStartedAt;
      if (turnKey) entry.lastInjectedTurnKey = turnKey;
      if (typeof lastRawUserInput === 'string') entry.lastRawUserInput = lastRawUserInput;
      if (Number.isFinite(lastInputStepIndex)) entry.lastInputStepIndex = lastInputStepIndex;
      if (typeof injectedPersonaHash === 'string') entry.injectedPersonaHash = injectedPersonaHash;
      if (typeof hasInjectedStaticRules === 'boolean') entry.hasInjectedStaticRules = hasInjectedStaticRules;
      if (typeof hasInjectedStartupContext === 'boolean') entry.hasInjectedStartupContext = hasInjectedStartupContext;
      if (typeof injectedRulesHash === 'string') entry.injectedRulesHash = injectedRulesHash;
    }
    data.activeConversationId = String(conversationId);
    savedEntry = entry;
    return data;
  });
  return savedEntry;
}

/**
 * Verifies whether a candidate conversation ID is known to belong to `gemini_cat`.
 */
export function isVerifiedProjectConversation(conversationId, root = getProjectRoot()) {
  const key = canonicalSessionKey(conversationId);
  if (!key) return false;
  const data = loadRegisteredSessions(root);
  return data.sessions.some((s) => canonicalSessionKey(s.conversationId) === key);
}

/**
 * Read-only query: latest Desktop IDE user-speech timestamp across all registered sessions.
 */
export function getLatestDesktopSpeechAt(root = getProjectRoot()) {
  const data = loadRegisteredSessions(root);
  let maxTs = 0;
  for (const s of data.sessions || []) {
    const t = Number(s?.lastDesktopSpeechAt || 0);
    if (t > maxTs) maxTs = t;
  }
  return maxTs;
}

/**
 * Read-only query: deduplicated non-empty transcript file paths in registration order.
 */
export function listSessionTranscriptPaths(root = getProjectRoot()) {
  const data = loadRegisteredSessions(root);
  const out = [];
  const seen = new Set();
  for (const s of data.sessions || []) {
    const tPath = String(s?.transcriptPath || '').trim();
    if (!tPath || seen.has(tPath)) continue;
    seen.add(tPath);
    out.push(tPath);
  }
  return out;
}
