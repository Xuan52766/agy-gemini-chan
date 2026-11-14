/**
 * @fileoverview Antigravity `PreInvocation` hook for `gemini_cat`.
 *
 * Per user turn (skipped cleanly on mid-turn tool re-invocations `invocationNum > 1`
 * so context is never duplicated):
 * 1. Updates live Cat Nest activity -> `'thinking'`
 * 2. Resolves strictly project-scoped Persona (`session > gemini_cat project`)
 * 3. Recalls matching Fish Memories & updates user speech ruler
 * 4. Consumes pending Mood injection (`event` / `label`) & supplies concise in-chat judge hint
 * 5. Drains pending Cat Nest interactions (`摸摸頭/餵小魚乾/小紙條`) so Sidecar care directly enters dialogue
 */

import { classifyInputSource, loadRegisteredSessions, registerProjectConversation } from '../core/bridge.mjs';
import { buildInChatMemoryRule, recallMemories } from '../core/memory.mjs';
import { buildInChatMoodRule, consumeMoodInjection, loadMoodConfig } from '../core/mood.mjs';
import { consumePendingNestContext, loadNestState, setNestActivity, wakeFromSleep } from '../core/nest.mjs';
import { resolvePersona } from '../core/persona.mjs';
import {
  appendLogLine,
  canonicalSessionKey,
  getDataPaths,
  getProjectRoot,
  stripAntigravityWrappers,
} from '../core/storage.mjs';
import { ensureInProjectScope, injectSystemContext, readHookInput, writeHookOutput } from './lib.mjs';

const ROOT = getProjectRoot();
const LOG = `${getDataPaths(ROOT).runtimeDir}/hooks.log`;

function main() {
  const payload = readHookInput();
  if (!ensureInProjectScope(payload, ROOT)) {
    writeHookOutput({});
    return;
  }

  const sid = payload.conversationId || '';
  const userInput = stripAntigravityWrappers(payload.lastUserInput);
  const sourceKind = classifyInputSource(userInput);
  const invocationNum = Number(payload.invocationNum || 1);
  const turnKey = `${payload.initialNumSteps ?? ''}:${userInput.slice(0, 80)}`;

  const sessions = loadRegisteredSessions(ROOT);
  const prevSess = sessions.sessions.find((s) => canonicalSessionKey(s.conversationId) === canonicalSessionKey(sid));
  const isMidTurnContinuation = invocationNum > 1 || (prevSess && prevSess.lastInjectedTurnKey === turnKey && turnKey !== ':');

  registerProjectConversation(
    {
      conversationId: sid,
      workspacePaths: payload.workspacePaths,
      cwd: payload.cwd,
      transcriptPath: payload.transcriptPath,
      modelName: payload.modelName,
      sourceKind,
      lastUserMessageAt: sourceKind === 'user' && !isMidTurnContinuation ? Date.now() : 0,
      turnStartedAt: !isMidTurnContinuation ? Date.now() : 0,
      turnKey,
    },
    ROOT,
  );

  const KEEP_SLEEPING_RE = /^(?:(?:晚安|安安|好夢|你?快睡吧?|先?去睡吧?|繼續睡吧?|回去睡吧?|好好休息吧?|好好睡吧?|乖乖睡吧?|睡吧|睡覺吧?|不要醒|別醒|別起床|不用起來|再睡一下|晚安喵)[，,、！!~～.。…\s]*)+$/i;
  let nestState = loadNestState(ROOT);
  let wokeByChat = false;
  if (!isMidTurnContinuation && sourceKind === 'user' && nestState.sleeping && !KEEP_SLEEPING_RE.test(userInput.trim())) {
    const woke = wakeFromSleep(ROOT, {
      reason: 'user-chat',
      label: '聽到你的聲音揉揉眼醒來，正準備回你話…',
      wakeNote: '你原本正在貓窩軟墊上打盹，剛聽到主人直接開口跟你說話才揉著眼睛醒過來（語氣可帶一絲剛睡醒的迷糊，若交辦正事就收起睡意認真處理；側邊欄已同步切成清醒姿態）',
    });
    wokeByChat = woke.woke;
    nestState = woke.state;
  }

  const shortPreview = userInput.replace(/\s+/g, ' ').slice(0, 18);
  if (nestState.sleeping) {
    setNestActivity(
      {
        phase: 'sleeping',
        label: sourceKind === 'nest-event'
          ? '在睡夢裡迷迷糊糊感受到了… zzZ'
          : sourceKind === 'xingxi-pickup'
            ? '在睡夢裡悄悄把今天收進星汐記憶卡… zzZ'
            : '在被窩裡迷糊聽見輕聲呼喚… zzZ',
      },
      ROOT,
    );
  } else {
    setNestActivity(
      {
        phase: 'thinking',
        label: wokeByChat
          ? '聽到你說話揉著眼睛醒來，正想怎麼回你…'
          : sourceKind === 'speak-up'
            ? '正準備主動過去跟你說句話…'
            : sourceKind === 'xingxi-pickup'
              ? '正在悄悄整理今天的美好與星汐記憶卡…'
              : sourceKind === 'nest-event'
                ? '感受到貓窩裡的互動，正開心地想回應你…'
                : shortPreview
                  ? `在想「${shortPreview}${userInput.length > 18 ? '…' : ''}」`
                  : '在思考要怎麼回覆你…',
      },
      ROOT,
    );
  }

  if (isMidTurnContinuation) {
    writeHookOutput({});
    return;
  }

  const sections = [];

  // 1. Project-only Persona
  const persona = resolvePersona({ root: ROOT, sessionId: sid });
  if (persona.effectiveText) {
    sections.push(persona.effectiveText);
  }

  // 2. Fish Memory recall (genuine human dialogue or nest event)
  if (userInput && sourceKind !== 'work' && sourceKind !== 'xingxi-pickup') {
    const recalled = recallMemories(userInput, {
      root: ROOT,
      recordSample: sourceKind === 'user',
      saveTrace: true,
    });
    if (recalled.rendered) sections.push(recalled.rendered);
  }

  // 3. One-shot Feiyu Mood shift injection
  const moodInject = consumeMoodInjection({ root: ROOT, consume: true });
  if (moodInject.inject) {
    sections.push(moodInject.inject);
  }

  // 4. Drain Cat Nest UI interactions into conversation turn
  const nestCtx = consumePendingNestContext(ROOT, { consume: true });
  if (nestCtx.text) {
    sections.push(nestCtx.text);
  } else {
    sections.push(nestCtx.statusSummary);
  }

  // 5. In-conversation zero-API mood evaluation prompt & Fish Memory write reminder
  if (sourceKind !== 'xingxi-pickup') {
    const moodCfg = loadMoodConfig(ROOT);
    const judgeRule = buildInChatMoodRule(moodCfg);
    if (judgeRule) sections.push(judgeRule);
    const memRule = buildInChatMemoryRule(ROOT, {
      ownerName: moodCfg.ownerName,
      selfName: moodCfg.selfName,
    });
    if (memRule) sections.push(memRule);
  }

  if (!sections.length) {
    writeHookOutput({});
    return;
  }

  appendLogLine(LOG, `PreInvocation ok: sid=${sid} src=${sourceKind} sections=${sections.length}`);
  writeHookOutput(injectSystemContext(sections.join('\n\n')));
}

main();
