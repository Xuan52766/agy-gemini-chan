/**
 * @fileoverview Antigravity `Stop` hook for `gemini_cat`.
 *
 * Runs when an invocation finishes:
 * 1. Refreshes verified session registration & `transcriptPath`
 * 2. Checks whether active conversation AI already judged mood via MCP `mood_update`
 *    during this turn (`lastInChatUpdateAt >= lastTurnStartAt`). If YES, skips
 *    local overwrite!
 * 3. Otherwise runs zero-API local affective fallback when `judgeMode === 'hybrid' | 'local'`
 * 4. Restores Cat Nest activity back to cozy idle / sleeping
 */

import { createHash } from 'node:crypto';
import { classifyInputSource, loadRegisteredSessions, registerProjectConversation } from '../core/bridge.mjs';
import {
  applyMoodDelta,
  evaluateTurnMood,
  loadMoodConfig,
  loadMoodState,
  saveMoodState,
} from '../core/mood.mjs';
import { loadNestState, setNestActivity } from '../core/nest.mjs';
import {
  extractTelegramCleanUserText,
  flushTelegramOutbox,
  isTelegramSidecarAlive,
  maybeQueueTelegramOutgoing,
} from '../core/telegram.mjs';
import {
  appendLogLine,
  canonicalSessionKey,
  getDataPaths,
  getProjectRoot,
  stripAntigravityWrappers,
} from '../core/storage.mjs';
import { ensureInProjectScope, extractLatestTurnFromTranscript, readHookInput, writeHookOutput } from './lib.mjs';

const ROOT = getProjectRoot();
const LOG = `${getDataPaths(ROOT).runtimeDir}/hooks.log`;

async function main() {
  const payload = readHookInput();
  if (!ensureInProjectScope(payload, ROOT)) {
    writeHookOutput({});
    return;
  }

  const sid = payload.conversationId || '';
  const cfg = loadMoodConfig(ROOT);
  const { userText, assistantText } = extractLatestTurnFromTranscript(payload.transcriptPath);
  const fallbackInput = userText || stripAntigravityWrappers(payload.lastUserInput);
  const mode = classifyInputSource(fallbackInput);

  registerProjectConversation(
    {
      conversationId: sid,
      workspacePaths: payload.workspacePaths,
      cwd: payload.cwd,
      transcriptPath: payload.transcriptPath,
      modelName: payload.modelName,
      sourceKind: mode,
    },
    ROOT,
  );

  const sessions = loadRegisteredSessions(ROOT);
  const sess = sessions.sessions.find((s) => canonicalSessionKey(s.conversationId) === canonicalSessionKey(sid));
  const turnStartAt = Number(sess?.lastTurnStartAt || 0);
  const turnHash = (fallbackInput || assistantText)
    ? createHash('sha1').update(`${mode}:${fallbackInput}\n---\n${assistantText}`).digest('hex')
    : '';

  if (cfg.enabled && cfg.autoJudge && mode !== 'xingxi-pickup' && (fallbackInput || assistantText)) {
    const judgeUserInput = (mode === 'speak-up' || mode === 'nest-event')
      ? ''
      : (mode === 'telegram' ? extractTelegramCleanUserText(fallbackInput) : fallbackInput);
    const state = loadMoodState({ root: ROOT, persist: false });

    if (state.lastTurnHash !== turnHash) {
      if (turnStartAt > 0 && Number(state.lastInChatUpdateAt || 0) >= turnStartAt) {
        // Conversation AI already judged mood via `mood_update` inside this turn — keep it intact!
        state.lastTurnHash = turnHash;
        saveMoodState(state, { root: ROOT });
        appendLogLine(LOG, `Stop mood kept in-conversation AI judgement: mood=${Math.round(state.mood)}`);
      } else {
        const delta = await evaluateTurnMood(judgeUserInput, assistantText, { root: ROOT, mode });
        if (delta) {
          const res = applyMoodDelta(delta, { root: ROOT, source: mode === 'speak-up' ? 'speak-up' : 'chat' });
          const updated = res.state;
          updated.lastTurnHash = turnHash;
          saveMoodState(updated, { root: ROOT });
          appendLogLine(
            LOG,
            `Stop local fallback (${delta.engine || 'local'}, mode=${mode}): delta=${delta.moodDelta} -> mood=${Math.round(updated.mood)} reason=${delta.reason}`,
          );
        } else {
          state.lastTurnHash = turnHash;
          saveMoodState(state, { root: ROOT });
        }
      }
    }
  }

  if (assistantText) {
    const queuedTg = maybeQueueTelegramOutgoing({
      root: ROOT,
      mode,
      sid,
      turnHash,
      userText: mode === 'user' ? stripAntigravityWrappers(fallbackInput) : '',
      assistantText,
      lastDesktopSpeechAt: Number(sess?.lastDesktopSpeechAt || 0),
      now: Date.now(),
    });
    if (queuedTg.queued && !isTelegramSidecarAlive(ROOT)) {
      await flushTelegramOutbox(ROOT, { timeoutMs: 3500 });
    }
  }

  const nest = loadNestState(ROOT);
  setNestActivity(
    {
      phase: nest.sleeping ? 'sleeping' : 'idle',
      label: nest.sleeping ? '在軟墊上蜷成一團打盹中… zzZ' : '剛聊完天，開心地晃著尾巴在貓窩等你～',
      toolName: '',
    },
    ROOT,
  );

  writeHookOutput({});
}

main().catch((err) => {
  appendLogLine(LOG, `Stop hook error: ${err?.message || err}`);
  writeHookOutput({});
});
