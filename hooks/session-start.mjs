/**
 * @fileoverview Antigravity `SessionStart` hook for `gemini_cat`.
 * Strictly scoped to the `gemini_cat` project workspace.
 * Injects:
 * 1. Project-only persona (no global scope)
 * 2. Xingxi Memory Card + recent 3 days of diaries + core high-importance Fish Memories
 * 3. Current mood tone guide + zero-API in-conversation `mood_update` instructions
 * 4. Cat Nest live vitals snapshot
 */

import { createHash } from 'node:crypto';
import { registerProjectConversation } from '../core/bridge.mjs';
import { buildInChatMemoryRule } from '../core/memory.mjs';
import { buildSessionMoodGuide, getMoodSnapshot } from '../core/mood.mjs';
import { getNestSnapshot, setNestActivity } from '../core/nest.mjs';
import { resolvePersona } from '../core/persona.mjs';
import { appendLogLine, getDataPaths, getProjectRoot } from '../core/storage.mjs';
import { buildSessionStartupContext, ensureXingxiArchive } from '../core/xingxi.mjs';
import { ensureInProjectScope, injectSystemContext, readHookInput, writeHookOutput } from './lib.mjs';

const ROOT = getProjectRoot();
const LOG = `${getDataPaths(ROOT).runtimeDir}/hooks.log`;

function computePersonaHash(persona) {
  return createHash('sha1')
    .update(`${persona?.source || 'none'}:${persona?.persona?.id || ''}:${persona?.effectiveText || ''}`)
    .digest('hex')
    .slice(0, 16);
}

function main() {
  const payload = readHookInput();
  if (!ensureInProjectScope(payload, ROOT)) {
    writeHookOutput({});
    return;
  }

  ensureXingxiArchive(ROOT);
  const sid = payload.conversationId || '';
  const persona = resolvePersona({ root: ROOT, sessionId: sid });
  const personaHash = computePersonaHash(persona);

  registerProjectConversation(
    {
      conversationId: sid,
      workspacePaths: payload.workspacePaths,
      cwd: payload.cwd,
      transcriptPath: payload.transcriptPath,
      modelName: payload.modelName,
      sourceKind: 'session-start',
      injectedPersonaHash: personaHash,
    },
    ROOT,
  );

  const mood = getMoodSnapshot({ root: ROOT });
  const nest = getNestSnapshot(ROOT, mood.mood);
  setNestActivity({ phase: nest.sleeping ? 'sleeping' : 'idle', label: '剛連上這個新對話～從星汐檔案回憶起你們的事' }, ROOT);

  const blocks = [];
  if (persona.effectiveText) {
    blocks.push(persona.effectiveText);
  } else {
    blocks.push('【Gemini-chan 貓窩（僅限 gemini_cat 專案）】目前尚未選定固定人物設定，保持自然真誠即可（無任何全域人設會干擾外部專案）。');
  }

  // Inject Xingxi Memory Card + recent diaries + core persistent anchors into new conversation
  const startupMem = buildSessionStartupContext(ROOT);
  if (startupMem) blocks.push(startupMem);

  const memRule = buildInChatMemoryRule(ROOT, {
    ownerName: mood.config?.ownerName,
    selfName: mood.config?.selfName,
  });
  if (memRule) blocks.push(memRule);

  // Inject current mood tone + in-conversation mood_update guide
  const moodGuide = buildSessionMoodGuide(ROOT);
  if (moodGuide) blocks.push(moodGuide);

  blocks.push(`【貓窩即時狀態】羈絆 Lv.${nest.bondLevel}（${nest.bond}）｜今日陪伴 ${nest.todayCareCount || 0} 次${nest.sleeping ? '｜打盹中' : ''}${nest.pendingCount ? `｜待帶入互動 ${nest.pendingCount} 項` : ''}`);

  appendLogLine(LOG, `SessionStart ok: sid=${sid}`);
  writeHookOutput(injectSystemContext(blocks.join('\n\n')));
}

main();
