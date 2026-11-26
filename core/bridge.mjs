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
import { getCentralPromptDefs, loadPromptOverrides, PROMPT_GROUPS } from './prompts.mjs';
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

  const centralOverrides = loadPromptOverrides(root);
  const bridgedItems = [
    {
      key: 'mood.inChatRule',
      group: 'startup',
      timing: '開新對話第 1 輪（對話內心情自評）',
      label: '對話內心情自評與內心小劇場規則',
      hint: '與「心情」分頁共用；引導貓貓在真實情緒事件發生時呼叫 mood_update。',
      vars: ['ownerName', 'selfName', 'selfPronoun'],
      value: mood.config?.inChatRulePrompt || mood.defaultRulePrompt || '',
      defaultText: mood.defaultRulePrompt || '',
      isCustom: Boolean(mood.config?.inChatRulePrompt),
      storage: 'mood',
    },
    {
      key: 'memory.inChatRule',
      group: 'startup',
      timing: '開新對話第 1 輪（長期記憶與主題頁規則）',
      label: '對話內長期記憶提醒詞',
      hint: '與「記憶」分頁共用；規範何時呼叫 remember 與何時整理認識主題頁。',
      vars: ['left', 'dailyQuota', 'ownerName', 'ownerPronoun', 'ownerCall', 'selfPronoun', 'selfName'],
      value: memory.policy?.inChatRulePrompt || memory.defaultRuleTemplate || '',
      defaultText: memory.defaultRuleTemplate || '',
      isCustom: Boolean(memory.policy?.inChatRulePrompt),
      storage: 'memory',
    },
    {
      key: 'speakUp.inChatRule',
      group: 'startup',
      timing: '開新對話第 1 輪（主動搭話與排程規則）',
      label: '對話內主動排程與勿擾規則',
      hint: '與「搭話」分頁共用；說明如何使用 speak_up_plan 預約、定節律與設勿擾。',
      vars: ['activeGapMin'],
      value: speakUp.config?.inChatRulePrompt || speakUp.defaultInChatRulePrompt || '',
      defaultText: speakUp.defaultInChatRulePrompt || '',
      isCustom: Boolean(speakUp.config?.inChatRulePrompt),
      storage: 'speakUp',
    },
    {
      key: 'speakUp.triggerPrompt',
      group: 'speakup',
      timing: '隨機擲骰命中時（預設內心念頭）',
      label: '隨機主動搭話預設念頭',
      hint: '與「搭話」分頁共用；當隨機擲骰命中（無特定預約念頭）時喚醒貓貓的念頭。',
      vars: [],
      value: speakUp.config?.triggerPrompt || speakUp.defaultTriggerPrompt || '',
      defaultText: speakUp.defaultTriggerPrompt || '',
      isCustom: Boolean(
        speakUp.config?.triggerPrompt
        && speakUp.config.triggerPrompt.trim() !== String(speakUp.defaultTriggerPrompt || '').trim(),
      ),
      storage: 'speakUp',
    },
    {
      key: 'speakUp.followUpHint',
      group: 'speakup',
      timing: '主動搭話結尾（順手排下次時間）',
      label: '主動搭話結尾排程提示',
      hint: '與「搭話」分頁共用；附在主動搭話訊息尾端，提醒貓貓順手排下次關心或勿擾。',
      vars: [],
      value: speakUp.config?.followUpHintPrompt || speakUp.defaultFollowUpHintPrompt || '',
      defaultText: speakUp.defaultFollowUpHintPrompt || '',
      isCustom: Boolean(speakUp.config?.followUpHintPrompt),
      storage: 'speakUp',
    },
  ];
  const centralItems = getCentralPromptDefs().map((def) => ({
    key: def.key,
    group: def.group,
    timing: def.timing,
    label: def.label,
    hint: def.hint,
    vars: def.vars,
    value: centralOverrides[def.key] || def.defaultText,
    defaultText: def.defaultText,
    isCustom: Boolean(centralOverrides[def.key]),
    storage: 'central',
  }));
  const allPromptItems = [...centralItems, ...bridgedItems];
  const groupOrder = new Map(PROMPT_GROUPS.map((g, i) => [g.id, i]));
  allPromptItems.sort((a, b) => (groupOrder.get(a.group) ?? 99) - (groupOrder.get(b.group) ?? 99));
  const prompts = {
    groups: PROMPT_GROUPS,
    items: allPromptItems,
    customCount: allPromptItems.filter((it) => it.isCustom).length,
    totalCount: allPromptItems.length,
  };

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
    prompts,
    updatedAt: now,
  };
}
