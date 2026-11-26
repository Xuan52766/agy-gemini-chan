/**
 * @fileoverview Unified bridge managing verified `gemini_cat` session tracking,
 * classification (`user` vs `work` vs `speak-up`), and combined snapshots.
 */

import { getMemorySnapshot } from './memory.mjs';
import {
  CAT_NEST_EVENT_MARKER,
  isWorkMarkerPrefix,
  SPEAK_UP_LEGACY_TAG,
  SPEAK_UP_MARKER,
  TELEGRAM_INCOMING_MARKER,
  XINGXI_PICKUP_MARKER,
} from './markers.mjs';
import { getMoodSnapshot } from './mood.mjs';
import { getNestSnapshot } from './nest.mjs';
import { getPersonaSnapshot } from './persona.mjs';
import {
  getSessionsFilePath,
  isVerifiedProjectConversation,
  loadRegisteredSessions,
  registerProjectConversation,
} from './sessions.mjs';
import { getSpeakUpSnapshot } from './speak-up.mjs';
import { getTelegramSnapshot } from './telegram.mjs';
import {
  canonicalSessionKey,
  getProjectRoot,
  unwrapSidecarSystemEnvelope,
} from './storage.mjs';
import { getXingxiSnapshot } from './xingxi.mjs';

export {
  CAT_NEST_EVENT_MARKER,
  getSessionsFilePath,
  isVerifiedProjectConversation,
  loadRegisteredSessions,
  registerProjectConversation,
  TELEGRAM_INCOMING_MARKER,
  XINGXI_PICKUP_MARKER,
};

/**
 * Classifies turn origin (`speak-up` | `xingxi-pickup` | `nest-event` | `telegram` | `work` | `user`).
 */
export function classifyInputSource(userInput = '') {
  const s = unwrapSidecarSystemEnvelope(userInput);
  if (s.startsWith(SPEAK_UP_MARKER) || s.startsWith(SPEAK_UP_LEGACY_TAG)) return 'speak-up';
  if (s.startsWith(XINGXI_PICKUP_MARKER)) return 'xingxi-pickup';
  if (s.startsWith(CAT_NEST_EVENT_MARKER)) return 'nest-event';
  if (s.startsWith(TELEGRAM_INCOMING_MARKER)) return 'telegram';
  if (isWorkMarkerPrefix(s)) return 'work';
  return 'user';
}

export function getFullStateSnapshot({ root = getProjectRoot(), sessionId = '', cwd = '', now = Date.now() } = {}) {
  const sessions = loadRegisteredSessions(root);
  const activeSid = sessionId || sessions.activeConversationId || '';
  const activeSession = sessions.sessions.find(
    (s) => canonicalSessionKey(s.conversationId) === canonicalSessionKey(activeSid),
  );
  const mood = getMoodSnapshot({ root, now });
  const nest = getNestSnapshot(root, mood.mood, now, mood.dims);
  const persona = getPersonaSnapshot({ root, sessionId: activeSid, cwd: cwd || root });
  const memory = getMemorySnapshot(root, now);
  const xingxi = getXingxiSnapshot(root);
  const speakUp = getSpeakUpSnapshot(root, activeSession?.lastUserSpeechAt || 0, new Date(now));
  const telegram = getTelegramSnapshot(root, now);

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
    telegram,
    updatedAt: now,
  };
}
