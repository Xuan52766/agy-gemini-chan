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

import { createHash } from 'node:crypto';
import { classifyInputSource, loadRegisteredSessions, registerProjectConversation } from '../core/bridge.mjs';
import { buildInChatMemoryRule, loadMemoryStore, recallMemories } from '../core/memory.mjs';
import { buildInChatMoodRule, buildSessionMoodGuide, consumeMoodInjection, getMoodSnapshot, loadMoodConfig } from '../core/mood.mjs';
import { getNestSnapshot, consumePendingNestContext, loadNestState, setNestActivity, wakeFromSleep } from '../core/nest.mjs';
import { resolvePersona } from '../core/persona.mjs';
import {
  buildInChatSpeakUpRule,
  buildProactivePlanCue,
  loadSpeakUpConfig,
  noteUserSpokeForSpeakUp,
} from '../core/speak-up.mjs';
import { extractTelegramCleanUserText } from '../core/telegram.mjs';
import {
  appendLogLine,
  canonicalSessionKey,
  getDataPaths,
  getProjectRoot,
  stripAntigravityWrappers,
} from '../core/storage.mjs';
import { buildSessionStartupContext, ensureXingxiArchive } from '../core/xingxi.mjs';
import {
  ensureInProjectScope,
  injectSystemContext,
  inspectTranscriptTail,
  readHookInput,
  writeHookOutput,
} from './lib.mjs';

const ROOT = getProjectRoot();
const LOG = `${getDataPaths(ROOT).runtimeDir}/hooks.log`;

function computePersonaHash(persona) {
  return createHash('sha1')
    .update(`${persona?.source || 'none'}:${persona?.persona?.id || ''}:${persona?.effectiveText || ''}`)
    .digest('hex')
    .slice(0, 16);
}

function computeRulesHash(moodCfg, memPolicy, spCfg) {
  return createHash('sha1')
    .update(JSON.stringify([
      'rules-v4',
      Boolean(moodCfg?.enabled),
      moodCfg?.judgeMode || 'hybrid',
      Boolean(moodCfg?.innerThoughtEnabled),
      moodCfg?.ownerName || '',
      moodCfg?.selfName || '',
      moodCfg?.selfPronoun || '',
      moodCfg?.inChatRulePrompt || '',
      Boolean(memPolicy?.enabled),
      memPolicy?.ownerPronoun || '',
      memPolicy?.selfPronoun || '',
      memPolicy?.inChatRulePrompt || '',
      Boolean(spCfg?.enabled),
      Boolean(spCfg?.aiPlanEnabled),
      spCfg?.scheduleTendency || 'high',
      Boolean(spCfg?.proactiveCueEnabled),
      spCfg?.respectActiveChatGapMin ?? 8,
      spCfg?.inChatRulePrompt || '',
    ]))
    .digest('hex')
    .slice(0, 16);
}

function main() {
  const payload = readHookInput();
  if (!ensureInProjectScope(payload, ROOT)) {
    writeHookOutput({});
    return;
  }

  const sid = payload.conversationId || '';
  const sessions = loadRegisteredSessions(ROOT);
  const prevSess = sessions.sessions.find((s) => canonicalSessionKey(s.conversationId) === canonicalSessionKey(sid));

  const transcriptPath = payload.transcriptPath || prevSess?.transcriptPath || '';
  const transcriptInfo = inspectTranscriptTail(transcriptPath);
  const cleanPayloadInput = stripAntigravityWrappers(payload.lastUserInput);

  // Sidecar.sendMessage writes a SYSTEM_MESSAGE to transcript.jsonl while payload.lastUserInput stays stale
  const effectiveInput = (transcriptInfo.hasTranscript && transcriptInfo.isSidecarInput && transcriptInfo.latestInputText)
    ? transcriptInfo.latestInputText
    : (cleanPayloadInput || transcriptInfo.latestInputText || '');

  const sourceKind = classifyInputSource(effectiveInput);
  const invocationNum = Number(payload.invocationNum || 1);
  const turnKey = (transcriptInfo.hasTranscript && transcriptInfo.latestInputStepIndex >= 0)
    ? `step-${transcriptInfo.latestInputStepIndex}:${effectiveInput.slice(0, 80)}`
    : `${payload.initialNumSteps ?? ''}:${effectiveInput.slice(0, 80)}`;

  const isNewPayloadUserInput = Boolean(cleanPayloadInput && cleanPayloadInput !== (prevSess?.lastRawUserInput || ''));
  const isMidTurnContinuation =
    invocationNum > 1 ||
    Boolean(prevSess && prevSess.lastInjectedTurnKey === turnKey && turnKey !== ':') ||
    Boolean(transcriptInfo.isMidTurnToolContinuation && !isNewPayloadUserInput && !transcriptInfo.isSidecarInput);

  const persona = resolvePersona({ root: ROOT, sessionId: sid });
  const personaHash = computePersonaHash(persona);
  const moodCfgNow = loadMoodConfig(ROOT);
  const memPolicyNow = loadMemoryStore(ROOT).policy;
  const spCfgNow = loadSpeakUpConfig(ROOT);
  const rulesHash = computeRulesHash(moodCfgNow, memPolicyNow, spCfgNow);
  const canInjectTurn = !isMidTurnContinuation && sourceKind !== 'xingxi-pickup';
  const needsStartupInject = canInjectTurn && !prevSess?.hasInjectedStartupContext;
  const needsPersonaInject = Boolean(
    persona.effectiveText &&
    canInjectTurn &&
    (needsStartupInject || prevSess?.injectedPersonaHash !== personaHash),
  );
  const rulesChanged = Boolean(prevSess?.hasInjectedStaticRules && prevSess?.injectedRulesHash !== rulesHash);
  const needsStaticRules = canInjectTurn && (!prevSess?.hasInjectedStaticRules || needsPersonaInject || needsStartupInject || rulesChanged);

  if (needsStartupInject) {
    ensureXingxiArchive(ROOT);
  }

  const isUserTurn = sourceKind === 'user' || sourceKind === 'telegram';
  const cleanHumanInput = sourceKind === 'telegram' ? extractTelegramCleanUserText(effectiveInput) : effectiveInput;

  registerProjectConversation(
    {
      conversationId: sid,
      workspacePaths: payload.workspacePaths,
      cwd: payload.cwd,
      transcriptPath: payload.transcriptPath,
      modelName: payload.modelName,
      sourceKind,
      lastUserMessageAt: isUserTurn && !isMidTurnContinuation ? Date.now() : 0,
      lastDesktopMessageAt: sourceKind === 'user' && !isMidTurnContinuation ? Date.now() : 0,
      turnStartedAt: !isMidTurnContinuation ? Date.now() : 0,
      turnKey: !isMidTurnContinuation ? turnKey : undefined,
      lastRawUserInput: !isMidTurnContinuation && sourceKind === 'user' ? cleanPayloadInput : undefined,
      lastInputStepIndex: !isMidTurnContinuation && transcriptInfo.latestInputStepIndex >= 0
        ? transcriptInfo.latestInputStepIndex
        : undefined,
      injectedPersonaHash: canInjectTurn ? personaHash : undefined,
      hasInjectedStaticRules: canInjectTurn ? true : undefined,
      hasInjectedStartupContext: canInjectTurn ? true : undefined,
      injectedRulesHash: canInjectTurn ? rulesHash : undefined,
    },
    ROOT,
  );

  if (!isMidTurnContinuation && isUserTurn) {
    noteUserSpokeForSpeakUp(ROOT, Date.now());
  }

  const KEEP_SLEEPING_RE = /^(?:(?:晚安|安安|好夢|你?快睡吧?|先?去睡吧?|繼續睡吧?|回去睡吧?|好好休息吧?|好好睡吧?|乖乖睡吧?|睡吧|睡覺吧?|不要醒|別醒|別起床|不用起來|再睡一下|晚安喵)[，,、！!~～.。…\s]*)+$/i;
  let nestState = loadNestState(ROOT);
  let wokeByChat = false;
  if (!isMidTurnContinuation && isUserTurn && nestState.sleeping && !KEEP_SLEEPING_RE.test(cleanHumanInput.trim())) {
    const woke = wakeFromSleep(ROOT, {
      reason: 'user-chat',
      label: '聽到你的聲音揉揉眼醒來，正準備回你話…',
      wakeNote: '你原本正在貓窩軟墊上打盹，剛聽到主人直接開口跟你說話才揉著眼睛醒過來（語氣可帶一絲剛睡醒的迷糊，若交辦正事就收起睡意認真處理；側邊欄已同步切成清醒姿態）',
    });
    wokeByChat = woke.woke;
    nestState = woke.state;
  }

  const shortPreview = cleanHumanInput.replace(/\s+/g, ' ').slice(0, 18);
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
  } else if (!isMidTurnContinuation) {
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
                : sourceKind === 'telegram'
                  ? (shortPreview ? `收到 Telegram：「${shortPreview}${cleanHumanInput.length > 18 ? '…' : ''}」` : '收到你在 Telegram 傳來的訊息…')
                  : shortPreview
                    ? `在想「${shortPreview}${cleanHumanInput.length > 18 ? '…' : ''}」`
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

  // 1. Project-only Persona — injected on Turn 1 (startup) or when user switches/edits persona mid-conversation
  if (needsPersonaInject) {
    sections.push(persona.effectiveText);
  } else if (needsStartupInject) {
    sections.push('【Gemini-chan 貓窩（僅限 gemini_cat 專案）】目前尚未選定固定人物設定，保持自然真誠即可（無任何全域人設會干擾外部專案）。');
  }

  // 2. Startup Xingxi Memory Card + recent 3 days of diaries + core persistent anchors (once per session on Turn 1)
  if (needsStartupInject) {
    const startupMem = buildSessionStartupContext(ROOT);
    if (startupMem) sections.push(startupMem);
  }

  // 3. Fish Memory recall (only on genuine human dialogue or nest event, never on speak-up / work / xingxi-pickup)
  if (cleanHumanInput && (isUserTurn || sourceKind === 'nest-event')) {
    const recalled = recallMemories(cleanHumanInput, {
      root: ROOT,
      recordSample: isUserTurn,
      saveTrace: isUserTurn,
    });
    if (recalled.rendered) sections.push(recalled.rendered);
  }

  // 4. One-shot Feiyu Mood shift injection
  const moodInject = consumeMoodInjection({ root: ROOT, consume: true });
  if (moodInject.inject) {
    sections.push(moodInject.inject);
  }

  // 5. Drain Cat Nest UI interactions into conversation turn (silent on ordinary turns when no action pending)
  const nestCtx = consumePendingNestContext(ROOT, { consume: true });
  if (nestCtx.text) {
    sections.push(nestCtx.text);
  }

  // 6. Startup mood tone guide + static in-conversation rules (injected once on Turn 1, or refreshed on persona / prompt / toggle change)
  if (needsStartupInject) {
    const moodSnap = getMoodSnapshot({ root: ROOT });
    const moodGuide = buildSessionMoodGuide(ROOT);
    if (moodGuide) sections.push(moodGuide);
    const memRule = buildInChatMemoryRule(ROOT, {
      ownerName: moodSnap.config?.ownerName,
      selfName: moodSnap.config?.selfName,
    });
    if (memRule) sections.push(memRule);
    const spRule = buildInChatSpeakUpRule(ROOT);
    if (spRule) sections.push(spRule);
    const nest = getNestSnapshot(ROOT, moodSnap.mood, Date.now(), moodSnap.dims);
    sections.push(
      `【貓窩即時狀態】羈絆 Lv.${nest.bondLevel}（${nest.bond}）｜今日陪伴 ${nest.todayCareCount || 0} 次${nest.sleeping ? '｜打盹中' : ''}${nest.pendingCount ? `｜待帶入互動 ${nest.pendingCount} 項` : ''}`,
    );
  } else if (needsStaticRules) {
    const moodCfg = loadMoodConfig(ROOT);
    const judgeRule = buildInChatMoodRule(moodCfg);
    if (judgeRule) sections.push(judgeRule);
    const memRule = buildInChatMemoryRule(ROOT, {
      ownerName: moodCfg.ownerName,
      selfName: moodCfg.selfName,
    });
    if (memRule) sections.push(memRule);
    const spRule = buildInChatSpeakUpRule(ROOT);
    if (spRule) sections.push(spRule);
  }

  // 7. Situational autonomous-scheduling / self-restraint cue on transitional user turns
  if (canInjectTurn && isUserTurn && !needsStartupInject && !needsStaticRules) {
    const proactiveCue = buildProactivePlanCue(ROOT, cleanHumanInput, Date.now());
    if (proactiveCue) sections.push(proactiveCue);
  }

  if (!sections.length) {
    writeHookOutput({});
    return;
  }

  appendLogLine(
    LOG,
    `PreInvocation ok: sid=${sid} src=${sourceKind} startup=${needsStartupInject ? 1 : 0} persona=${needsPersonaInject ? 1 : 0} rules=${needsStaticRules ? 1 : 0} sections=${sections.length}`,
  );
  writeHookOutput(injectSystemContext(sections.join('\n\n')));
}

main();
