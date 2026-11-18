/**
 * @fileoverview Unified bridge managing verified `gemini_cat` session tracking,
 * classification (`user` vs `work` vs `speak-up`), and combined snapshots.
 */

import { join } from 'node:path';
import { getMemorySnapshot } from './memory.mjs';
import { getMoodSnapshot } from './mood.mjs';
import { getNestSnapshot, loadNestState } from './nest.mjs';
import { getPersonaSnapshot } from './persona.mjs';
import { getSpeakUpSnapshot, SPEAK_UP_MARKER } from './speak-up.mjs';
import {
  canonicalSessionKey,
  getDataPaths,
  getProjectRoot,
  isProjectWorkspaceActive,
  readJsonSafe,
  writeJsonAtomic,
} from './storage.mjs';
import { getXingxiSnapshot, XINGXI_PICKUP_MARKER } from './xingxi.mjs';

export const CAT_NEST_EVENT_MARKER = '[CAT_NEST_EVENT]';
export { XINGXI_PICKUP_MARKER };

function sessionsFile(root) {
  return join(getDataPaths(root).runtimeDir, 'sessions.json');
}

export function loadRegisteredSessions(root) {
  const raw = readJsonSafe(sessionsFile(root), null);
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
    turnKey = '',
    turnStartedAt = 0,
    lastRawUserInput = undefined,
    lastInputStepIndex = undefined,
    injectedPersonaHash = undefined,
    hasInjectedStaticRules = undefined,
    hasInjectedStartupContext = undefined,
  } = {},
  root = getProjectRoot(),
) {
  if (!conversationId) return null;
  if (!isProjectWorkspaceActive(workspacePaths, cwd, root)) {
    return null;
  }

  const now = Date.now();
  const data = loadRegisteredSessions(root);
  const key = canonicalSessionKey(conversationId);
  let entry = data.sessions.find((s) => canonicalSessionKey(s.conversationId) === key);
  if (!entry) {
    entry = {
      conversationId: String(conversationId),
      firstSeenAt: now,
      lastSeenAt: now,
      lastUserSpeechAt: lastUserMessageAt > 0 ? lastUserMessageAt : 0,
      lastTurnStartAt: turnStartedAt || 0,
      lastInjectedTurnKey: turnKey || '',
      lastRawUserInput: typeof lastRawUserInput === 'string' ? lastRawUserInput : '',
      lastInputStepIndex: Number.isFinite(lastInputStepIndex) ? lastInputStepIndex : -1,
      injectedPersonaHash: typeof injectedPersonaHash === 'string' ? injectedPersonaHash : '',
      hasInjectedStaticRules: Boolean(hasInjectedStaticRules),
      hasInjectedStartupContext: Boolean(hasInjectedStartupContext),
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
    if (turnStartedAt > 0) entry.lastTurnStartAt = turnStartedAt;
    if (turnKey) entry.lastInjectedTurnKey = turnKey;
    if (typeof lastRawUserInput === 'string') entry.lastRawUserInput = lastRawUserInput;
    if (Number.isFinite(lastInputStepIndex)) entry.lastInputStepIndex = lastInputStepIndex;
    if (typeof injectedPersonaHash === 'string') entry.injectedPersonaHash = injectedPersonaHash;
    if (typeof hasInjectedStaticRules === 'boolean') entry.hasInjectedStaticRules = hasInjectedStaticRules;
    if (typeof hasInjectedStartupContext === 'boolean') entry.hasInjectedStartupContext = hasInjectedStartupContext;
  }
  data.activeConversationId = String(conversationId);
  writeJsonAtomic(sessionsFile(root), data);
  return entry;
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
 * Classifies turn origin (`speak-up` | `xingxi-pickup` | `nest-event` | `work` | `user`).
 */
export function classifyInputSource(userInput = '') {
  const s = String(userInput || '');
  if (s.includes(SPEAK_UP_MARKER) || s.includes('<speak-up>')) return 'speak-up';
  if (s.includes(XINGXI_PICKUP_MARKER)) return 'xingxi-pickup';
  if (s.includes(CAT_NEST_EVENT_MARKER)) return 'nest-event';
  if (/^\[(WORK_SCAN|CRON|AUTOMATION|YOUTUBE_PATROL)\]/i.test(s.trim())) return 'work';
  return 'user';
}

export function getFullStateSnapshot({ root = getProjectRoot(), sessionId = '', cwd = '', now = Date.now() } = {}) {
  const sessions = loadRegisteredSessions(root);
  const activeSid = sessionId || sessions.activeConversationId || '';
  const activeSession = sessions.sessions.find(
    (s) => canonicalSessionKey(s.conversationId) === canonicalSessionKey(activeSid),
  );
  const mood = getMoodSnapshot({ root, now });
  const nest = getNestSnapshot(root, mood.mood, now);
  const persona = getPersonaSnapshot({ root, sessionId: activeSid, cwd: cwd || root });
  const memory = getMemorySnapshot(root, now);
  const xingxi = getXingxiSnapshot(root);
  const speakUp = getSpeakUpSnapshot(root, activeSession?.lastUserSpeechAt || 0, new Date(now));

  return {
    projectRoot: root,
    activeConversationId: activeSid,
    verifiedConversations: sessions.sessions.map((s) => ({
      conversationId: s.conversationId,
      lastSeenAt: s.lastSeenAt,
      lastUserSpeechAt: s.lastUserSpeechAt,
      modelName: s.modelName,
    })),
    nest,
    mood,
    persona,
    memory,
    xingxi,
    speakUp,
    updatedAt: now,
  };
}
