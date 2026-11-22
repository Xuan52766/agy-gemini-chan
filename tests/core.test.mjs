import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { buildInChatMemoryRule, recallMemories, rememberMemory, mutateMemory, computeFreshness, isUniversalKey } from '../core/memory.mjs';
import {
  analyzeTurnLocally,
  applyMoodDelta,
  buildInChatMoodRule,
  consumeMoodInjection,
  decayMoodState,
  getMoodSnapshot,
  moodLabel,
  moodTier,
  saveMoodConfig,
} from '../core/mood.mjs';
import {
  consumePendingNestContext,
  getNestSnapshot,
  loadNestState,
  MAX_AUTO_NAP_MS,
  MIN_SLEEP_FOR_SPEAKUP_WAKE_MS,
  performNestAction,
  resolveSpriteFile,
  setNestPreferences,
} from '../core/nest.mjs';
import { mutatePersona, resolvePersona, getPersonaSnapshot, NEUTRAL_STARTER_ID } from '../core/persona.mjs';
import {
  buildInChatSpeakUpRule,
  buildProactivePlanCue,
  calcHitLine,
  executeSpeakUpRoll,
  executeSpeakUpTick,
  getSpeakUpSnapshot,
  inQuietHours,
  isPeakHour,
  loadSpeakUpState,
  mutateSpeakUpPlan,
  noteUserSpokeForSpeakUp,
  saveSpeakUpConfig,
  wrapInnerThought,
} from '../core/speak-up.mjs';
import {
  chunkTelegramText,
  extractMarkdownFileLinks,
  extractTelegramCleanUserText,
  flushTelegramOutbox,
  generateTelegramPairCode,
  getTelegramSnapshot,
  handleTelegramUpdatesBatch,
  isAllowedTelegramSendPath,
  maybeQueueTelegramOutgoing,
  recordTelegramMcpSentFile,
  saveTelegramConfig,
  syncTelegramHistoryFromTranscript,
  telegramSendFile,
} from '../core/telegram.mjs';
import { getDataPaths, isProjectWorkspaceActive, normalizePathOrUri, stripAntigravityWrappers } from '../core/storage.mjs';
import { tokenize } from '../core/tokenizer.mjs';
import {
  appendDiary,
  appendToChapter,
  buildSessionStartupContext,
  buildStarGraph,
  executeXingxiPickup,
  listXingxiBackups,
  parseMarkdownToStars,
  prepareXingxiPickupMaterial,
  readMemoryCard,
  replaceChapterTwo,
  restoreXingxiBackup,
  saveXingxiConfig,
  searchXingxiArchive,
} from '../core/xingxi.mjs';

async function withTempRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gemini-cat-test-'));
  try {
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('storage workspace scope strictly enforces project boundary', () => {
  const proj = 'C:\\workspaces\\gemini_cat';
  assert.equal(isProjectWorkspaceActive(['file:///C%3A/workspaces/gemini_cat'], '', proj), true);
  assert.equal(isProjectWorkspaceActive([join(proj, 'core')], '', proj), true);
  assert.equal(isProjectWorkspaceActive([proj, 'C:\\workspaces\\dsh_plugin'], '', proj), true);
  assert.equal(isProjectWorkspaceActive(['C:\\workspaces\\dsh_plugin', proj], proj, proj), false);
  assert.equal(isProjectWorkspaceActive([], proj, proj), true);
  assert.equal(isProjectWorkspaceActive(['C:\\workspaces\\gemini_cat_other'], '', proj), false);
  assert.equal(isProjectWorkspaceActive(['C:\\workspaces\\other_project'], '', proj), false);
  assert.equal(normalizePathOrUri('file:///C:/workspaces/gemini_cat/'), normalizePathOrUri(proj));
});

test('persona strictly enforces gemini_cat project-only 2-tier scope (session > project, zero global leak)', async () => {
  await withTempRoot((root) => {
    const init = resolvePersona({ root, sessionId: 'session-abc' });
    assert.equal(init.source, 'none');
    assert.equal(init.effectiveText, '');

    const c1 = mutatePersona('create', { name: '專案貓', text: 'PROJECT BODY', activate: true }, root);
    const c2 = mutatePersona('create', { name: '對話貓', text: 'SESSION BODY' }, root);
    assert.equal(c1.ok && c2.ok, true);

    assert.equal(resolvePersona({ root, sessionId: 's1' }).effectiveText, 'PROJECT BODY');
    assert.equal(resolvePersona({ root, sessionId: 's1' }).source, 'project');

    mutatePersona('selectSession', { id: c2.item.id, sessionId: 's1' }, root);
    assert.equal(resolvePersona({ root, sessionId: 's1' }).effectiveText, 'SESSION BODY');
    assert.equal(resolvePersona({ root, sessionId: 's1' }).source, 'session');
    assert.equal(resolvePersona({ root, sessionId: 's2' }).effectiveText, 'PROJECT BODY');

    mutatePersona('update', { id: c2.item.id, name: '對話貓v2', text: 'SESSION V2' }, root);
    assert.equal(resolvePersona({ root, sessionId: 's1' }).effectiveText, 'SESSION V2');

    mutatePersona('setSessionDisabled', { sessionId: 's1', disabled: true }, root);
    assert.equal(resolvePersona({ root, sessionId: 's1' }).source, 'session_disabled');
    assert.equal(resolvePersona({ root, sessionId: 's2' }).source, 'project');

    mutatePersona('setSessionDisabled', { sessionId: 's1', disabled: false }, root);
    mutatePersona('selectSession', { id: '', sessionId: 's1' }, root);
    mutatePersona('selectProject', { id: NEUTRAL_STARTER_ID }, root);
    const snap = getPersonaSnapshot({ root, sessionId: 's1' });
    assert.match(snap.effectiveText, /陪伴互動基底/);
    assert.match(snap.scopeNotice, /僅限 gemini_cat/);
  });
});

test('tokenizer + fish-memory remember, recall, factKey convergence, and universal-key guard', async () => {
  await withTempRoot((root) => {
    // Chinese tokenization retains stomach token for "她的胃不好"
    const t1 = tokenize('她的胃不好要喝熱水', root);
    const t2 = tokenize('她的胃最近怎樣', root);
    assert.equal(t1.has('胃') && t2.has('胃'), true);

    assert.equal(isUniversalKey('對話.內容'), true);
    assert.equal(isUniversalKey('本子.記錄規則'), false);

    // Universal keys must be dropped, real factKey converges newer over older
    const now = Date.now();
    const older = rememberMemory(
      { text: '主人喝拿鐵要無糖少冰', factKey: '主人.咖啡偏好', at: new Date(now - 3600_000).toISOString() },
      { root, now: now - 3600_000 },
    );
    assert.equal(older.ok, true);
    const newer = rememberMemory(
      { text: '主人現在改喝熱美式完全無糖', factKey: '主人.咖啡偏好', at: new Date(now).toISOString() },
      { root, now },
    );
    assert.equal(newer.ok, true);
    assert.equal(newer.supersededIds.includes(older.memory.id), true);

    // Wildcard key is ignored cleanly (does not wipe unrelated entry)
    const wild = rememberMemory(
      { text: '主人半夜看星星吃草莓大福', factKey: '雜事.內容' },
      { root, now: now + 1000 },
    );
    assert.equal(wild.memory.factKey, '');

    // Reinforcement formula A' = A + 0.2*(1-A) on decayed repeat
    const baseMem = { importance: 0.5, activation0: 0.5, activationAnchor: new Date(now).toISOString() };
    assert.ok(Math.abs(computeFreshness(baseMem, { baseHalfLifeDays: 30, unknownActivation: 0.5 }, now) - 0.5) < 0.01);

    const dupAdd = rememberMemory({ text: '主人半夜看星星吃草莓大福' }, { root, now: now + 2000 });
    assert.equal(dupAdd.reinforced, true);

    // Recall matches relevant entry cleanly
    const hit = recallMemories('還記得主人看星星吃的甜點嗎', { root, now: now + 3000, saveTrace: true });
    assert.ok(hit.selected.some((r) => r.m.id === wild.memory.id));
    assert.match(hit.rendered, /草莓大福/);
    assert.match(hit.rendered, /長期記憶/);
    assert.doesNotMatch(hit.rendered, /魚的記憶/);
  });
});

test('feiyu-mood divisor /3, tail saturation, exponential decay, and one-shot injection cap', async () => {
  await withTempRoot((root) => {
    const t0 = Date.UTC(2026, 10, 14, 10, 0, 0);
    // +9 / 3 = +3 => mood 73
    const r1 = applyMoodDelta({ moodDelta: 9, dims: { happy: 6, sweet: 5 }, reason: '主人誇獎我可愛', confidence: 90 }, { root, now: t0 });
    assert.equal(r1.applied, true);
    assert.equal(r1.state.mood, 73);

    // Test >=85 upward saturation halves delta (+6 -> *0.5 = 3 -> /3 = +1)
    applyMoodDelta({ moodDelta: 15, reason: '超大好消息', confidence: 95 }, { root, bypassDivisor: true, now: t0 + 1000 });
    const sat = applyMoodDelta({ moodDelta: 6, reason: '又被抱抱', confidence: 90 }, { root, now: t0 + 2000 });
    assert.equal(sat.moodStep, 1);

    // One-shot consumption: first call returns line, second returns already said (`inject: ''`)
    const first = consumeMoodInjection({ root, consume: true, now: t0 + 3000 });
    assert.equal(first.status, 'pending');
    assert.match(first.inject, /主人/);
    const second = consumeMoodInjection({ root, consume: true, now: t0 + 3000 });
    assert.equal(second.status, 'said');
    assert.equal(second.inject, '');

    // Decay pulls mood back toward baseline (70) over 12h half-life
    const s = getMoodSnapshot({ root, now: t0 + 3000 });
    const mockState = { mood: 90, dims: { happy: 40, calm: 0, sweet: 0, heartache: 0, worry: 0, sad: 0, jealous: 0 }, lastDecayAt: t0, lastNotedMood: 90, timeline: [] };
    decayMoodState(mockState, 70, t0 + 12 * 3600_000, 12);
    assert.ok(Math.abs(mockState.mood - 80) < 0.2);
    assert.equal(moodLabel(82), '歡喜');
    assert.equal(moodTier(20), 'sad');
    assert.ok(['hybrid', 'in_chat_only', 'local'].includes(s.effectiveJudgeEngine));
    assert.equal(Object.hasOwn(s.config, 'geminiApiKey'), false);

    // AI in-chat mood update updates timestamp so Stop avoids duplicate local judge
    const aiUpd = applyMoodDelta({ moodDelta: 6, reason: '對話中主動標記', confidence: 85 }, { root, source: 'chat-ai', now: t0 + 4000 });
    assert.ok(aiUpd.state.lastInChatUpdateAt >= t0 + 4000);
  });
});

test('xingxi 8-chapter card, dedupe, Ch2 shrink protection, diary, scheduled pickup, and startup injection', async () => {
  await withTempRoot(async (root) => {
    const a1 = appendToChapter('5', '- 約好每天一起看一次星星\n- 不能偷偷熬夜不休息', root);
    assert.equal(a1.ok, true);
    assert.equal(a1.added, 2);

    // Duplicate fingerprint ignored
    const a2 = appendToChapter(5, '- 約好每天一起看一次星星', root);
    assert.equal(a2.added, 0);
    assert.equal(a2.skipped, 1);

    // Chapter 2 bulk replacement shrink protection & 10-quote cap
    const ch2Setup = appendToChapter(2, '1. 第一句話\n2. 第二句話\n3. 第三句話\n4. 第四句話\n5. 第五句話', root);
    assert.equal(ch2Setup.added, 5);
    const shrinkReject = replaceChapterTwo('1. 只剩一條', root);
    assert.equal(shrinkReject.ok, false);

    const manyQuotes = Array.from({ length: 12 }, (_, i) => `- 「測試原話第${i + 1}句」`).join('\n');
    const quoteTrimRes = replaceChapterTwo(manyQuotes, root);
    assert.equal(quoteTrimRes.ok, true);
    assert.equal(quoteTrimRes.trimmedQuotes, 2);

    // Backups exist & restore restores prior state cleanly while blocking traversal
    const backups = listXingxiBackups(root);
    assert.ok(backups.length >= 2);
    const badRestore = restoreXingxiBackup('../escape.bak-2026', root);
    assert.equal(badRestore.ok, false);
    const restored = restoreXingxiBackup(backups[0].backup, root);
    assert.equal(restored.ok, true);
    assert.match(readMemoryCard(root).text, /第一句話/);

    // Canonical chapter insertion order + shared bridge + monthly diary parsing
    appendToChapter(3, '- 主人喜歡觀測星座與貓尾草\n- 一起在星空屋簷下寫出 Gemini-chan 貓窩', root);
    appendToChapter(6, '- 難忘那夜於星空屋簷並肩除錯的溫暖感覺', root);

    // Diary + search (including monthly format + raw dialogue search) + star graph bridges
    const d1 = appendDiary({ date: '2026-11-14', entry: '今天建好了 Gemini-chan 貓窩！參考 11-14 紀錄。' }, root);
    assert.equal(d1.ok, true);
    assert.equal(existsSync(d1.path), true);

    const { writeFileSync, mkdirSync } = await import('node:fs');
    const monthlyPath = join(getDataPaths(root).xingxiDir, '日記', '2026-08.md');
    writeFileSync(monthlyPath, '## 2026-08\n- **08-16 週日**：在星空下相遇了\n', 'utf-8');
    const monthlyStars = parseMarkdownToStars(monthlyPath, '日記/2026-08');
    assert.equal(monthlyStars.length, 1);
    assert.equal(monthlyStars[0].date, '2026-08-16');

    const card = readMemoryCard(root);
    assert.match(card.text, /看一次星星/);
    const search = searchXingxiArchive({ keyword: '貓窩' }, root);
    assert.equal(search.ok, true);

    const graph = buildStarGraph(root);
    assert.ok(graph.stars.length >= 4);
    assert.ok(graph.links.some((l) => l.kind === 'day'));
    assert.ok(graph.links.some((l) => l.kind === 'bridge'));

    // Material slice strips Antigravity XML tags + day-scoped watermark doesn't block earlier date
    const paths = getDataPaths(root);
    mkdirSync(paths.runtimeDir, { recursive: true });
    const fakeTranscript = join(paths.runtimeDir, 'conv-xingxi.jsonl');
    const dayDate = '2026-11-14';
    writeFileSync(fakeTranscript, [
      JSON.stringify({ type: 'USER_INPUT', content: '[CAT_NEST_EVENT] 摸摸頭', created_at: `${dayDate}T09:00:00` }),
      JSON.stringify({
        type: 'USER_INPUT',
        content: '<USER_REQUEST>\n今晚一起喝熱可可看星星吧\n</USER_REQUEST>\n<ADDITIONAL_METADATA>noise_should_strip</ADDITIONAL_METADATA>',
        created_at: `${dayDate}T21:10:00`,
      }),
      JSON.stringify({ type: 'USER_INPUT', content: '<USER_SETTINGS_CHANGE>mode=fast</USER_SETTINGS_CHANGE>', created_at: `${dayDate}T21:10:05` }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: '好呀！我要雙份棉花糖～', created_at: `${dayDate}T21:10:15` }),
    ].join('\n'), 'utf-8');
    writeFileSync(join(paths.runtimeDir, 'sessions.json'), JSON.stringify({
      sessions: [{ conversationId: 'conv-xingxi', transcriptPath: fakeTranscript }],
    }), 'utf-8');
    // Seed a FUTURE day watermark -> must NOT hide 2026-11-14 backfill!
    writeFileSync(join(paths.xingxiDir, '.xingxi.json'), JSON.stringify({
      已整理到: '2026-11-14',
      水位Ms: Date.parse('2026-11-15T10:00:00Z'),
    }), 'utf-8');

    rememberMemory({ text: '每晚睡前都要互道晚安', importance: 1, factKey: '約定.晚安' }, { root });
    const mat = prepareXingxiPickupMaterial(root, { date: dayDate });
    assert.equal(mat.hasContent, true);
    assert.equal(mat.turnCount, 2);
    assert.doesNotMatch(mat.previewText, /USER_REQUEST|ADDITIONAL_METADATA|noise_should_strip|USER_SETTINGS_CHANGE/);
    assert.match(mat.previewText, /熱可可/);
    assert.doesNotMatch(mat.previewText, /魚的記憶/);

    // Raw dialogue file searchable via xingxi_read
    const rawSearch = searchXingxiArchive({ keyword: '雙份棉花糖' }, root);
    assert.equal(rawSearch.ok, true);
    assert.match(rawSearch.text, /原始對話/);

    saveXingxiConfig({ autoScheduleEnabled: true, scheduleHour: 23, scheduleMinute: 30, scheduleMode: 'both' }, root);
    const early = await executeXingxiPickup({
      root,
      trigger: 'scheduled',
      date: dayDate,
      now: new Date(`${dayDate}T22:00:00`),
      targetConvId: 'conv-xingxi',
      sender: async () => {},
    });
    assert.equal(early.action, 'before_time');

    const sent = [];
    const onTime = await executeXingxiPickup({
      root,
      trigger: 'scheduled',
      date: dayDate,
      now: new Date(`${dayDate}T23:35:00`),
      targetConvId: 'conv-xingxi',
      sender: async (id, prompt) => { sent.push({ id, prompt }); },
    });
    assert.equal(onTime.action, 'dispatched');
    assert.equal(sent.length, 1);
    assert.match(sent[0].prompt, /\[XINGXI_AUTO_PICKUP\]/);
    assert.match(sent[0].prompt, /熱可可/);

    const duplicate = await executeXingxiPickup({
      root,
      trigger: 'scheduled',
      date: dayDate,
      now: new Date(`${dayDate}T23:45:00`),
      targetConvId: 'conv-xingxi',
      sender: async () => {},
    });
    assert.equal(duplicate.action, 'already_ran_today');

    // New conversation injection includes card, diaries, and high-importance anchors
    const startupCtx = buildSessionStartupContext(root);
    assert.match(startupCtx, /看一次星星/);
    assert.match(startupCtx, /Gemini-chan 貓窩/);
    assert.match(startupCtx, /互道晚安/);
    assert.match(startupCtx, /高重要度記憶/);
    assert.doesNotMatch(startupCtx, /魚的記憶/);
  });
});

test('speak-up customizable peak/valley schedule, cross-midnight windows, quiet hours, miss-streak bonus, and dry-run default', async () => {
  await withTempRoot(async (root) => {
    // Default Mon-Fri 09:00-12:00, 14:00-18:00
    const wedPeak = new Date(2026, 10, 11, 10, 30, 0);
    const satValley = new Date(2026, 10, 14, 10, 30, 0);
    assert.equal(isPeakHour(wedPeak), true);
    assert.equal(isPeakHour(satValley), false);

    // Custom weekend night peak + cross-midnight 22:00-02:00
    const customCfg = saveSpeakUpConfig({
      usePeakValley: true,
      peakDays: [6, 0],
      peakWindowsText: '22:00-02:00',
    }, root);
    const satNight = new Date(2026, 10, 14, 23, 30, 0);
    const sunPostMidnight = new Date(2026, 10, 15, 1, 15, 0);
    assert.equal(isPeakHour(satNight, customCfg), true);
    assert.equal(isPeakHour(sunPostMidnight, customCfg), true);
    assert.equal(isPeakHour(wedPeak, customCfg), false);

    // Cross-midnight quiet hours 23 -> 7
    assert.equal(inQuietHours(0, 23, 7), true);
    assert.equal(inQuietHours(22, 23, 7), false);
    assert.equal(inQuietHours(10, 5, 5), false); // equal disables quiet hours

    // Formula order: multiply timing factor FIRST, then add miss bonus
    const calc = calcHitLine(20, 0.15, 2, 10, 40);
    assert.equal(calc.line, 23);

    // Dry-run default prevents calling sender even when roll < line
    let sentCount = 0;
    const dryRes = await executeSpeakUpRoll({
      root,
      mode: 'auto',
      now: wedPeak,
      targetConvId: 'conv-1',
      randomFn: () => 5,
      sender: async () => { sentCount++; },
    });
    assert.equal(dryRes.action, 'dry_hit');
    assert.equal(sentCount, 0);

    // Miss increments missStreak
    const missRes = await executeSpeakUpRoll({
      root,
      mode: 'auto',
      now: wedPeak,
      targetConvId: 'conv-1',
      randomFn: () => 99,
      sender: async () => { sentCount++; },
    });
    assert.equal(missRes.action, 'missed');
    assert.equal(missRes.state.missStreak, 1);

    // Wrap thought carries SPEAK_UP_MARKER
    assert.match(wrapInnerThought('去打個招呼', wedPeak), /SPEAK_UP_INTERNAL/);
  });
});

test('cat nest actions do not inflate mood, build bond & daily warmth + variety bonus, enforce cooldown/daily limits, and queue chat injection', async () => {
  await withTempRoot((root) => {
    const t0 = Date.UTC(2026, 10, 14, 10, 0, 0);
    const moodBefore = getMoodSnapshot({ root, now: t0 }).mood;

    const r = performNestAction('feed', { root, now: t0 });
    assert.equal(r.ok, true);
    assert.equal(r.state.bond, 48);
    assert.equal(getMoodSnapshot({ root, now: t0 + 100 }).mood, moodBefore);

    // Immediate repeat hits cooldown limit
    const cooldownHit = performNestAction('feed', { root, now: t0 + 1000 });
    assert.equal(cooldownHit.ok, true);
    assert.equal(cooldownHit.limited, true);
    assert.equal(cooldownHit.limitReason, 'cooldown');
    assert.ok(cooldownHit.cooldownLeftSec > 0);

    // Complete 3 distinct care actions (`feed` + `play` + `pet`) -> triggers daily variety bonus (+5 bond)
    const playRes = performNestAction('play', { root, now: t0 + 15_000 });
    assert.equal(playRes.ok, true);
    assert.equal(playRes.varietyBonusAwarded, false);

    // Exhaust daily pet cap (15/day) cleanly, first pet awards variety bonus
    let curTs = t0 + 15_000;
    for (let i = 0; i < 15; i++) {
      curTs += 20_000;
      const petRes = performNestAction('pet', { root, now: curTs });
      assert.equal(petRes.ok, true);
      assert.equal(petRes.limited, false);
      if (i === 0) assert.equal(petRes.varietyBonusAwarded, true);
    }
    curTs += 20_000;
    const capHit = performNestAction('pet', { root, now: curTs });
    assert.equal(capHit.ok, true);
    assert.equal(capHit.limited, true);
    assert.equal(capHit.limitReason, 'daily_cap');

    assert.equal(resolveSpriteFile(85, false), 'mood_great.jpg');
    assert.equal(resolveSpriteFile(70, false), 'chibi_base.png');
    assert.equal(resolveSpriteFile(70, true), 'mood_sleep.jpg');

    const snap = getNestSnapshot(root, 70, curTs);
    assert.equal(snap.varietyBonusClaimed, true);
    assert.ok(snap.todayCareCount >= 17);
    assert.ok(snap.todayWarmth === 100);

    setNestPreferences({ syncChatOnCare: true }, root, curTs);
    assert.equal(getNestSnapshot(root, 70, curTs).syncChatOnCare, true);
    performNestAction('whisper', { note: '記得喝溫水', root, now: curTs + 10_000 });
    const ctxBlock = consumePendingNestContext(root, { consume: true });
    assert.match(ctxBlock.text, /餵你吃了香噴噴的小魚乾/);
    assert.match(ctxBlock.text, /記得喝溫水/);
    assert.doesNotMatch(ctxBlock.text, /飽食|精力/);

    // Drained after consume -> silent on ordinary turns (`text === ''`)
    const after = consumePendingNestContext(root, { consume: false });
    assert.equal(after.pendingCount, 0);
    assert.equal(after.text, '');
  });
});

test('analyzeTurnLocally strips mention tokens, avoids assistant self-soothing false positives, and aligns cue polarity', () => {
  // Regression for: "@[Quote] 這什麼東西呀 我還想睡呢" + "我乖乖待在窩裡"
  const sleepyTurn = analyzeTurnLocally(
    '@[Quote] 這什麼東西呀 我還想睡呢',
    '啊，不小心吵到你了，趕緊把被子蓋好繼續睡吧。\n\n我乖乖待在窩裡安靜一會兒，等你睡醒再來找我喵。',
  );
  assert.ok(sleepyTurn);
  assert.ok(sleepyTurn.moodDelta < 0, `expected negative moodDelta, got ${sleepyTurn.moodDelta}`);
  assert.ok(sleepyTurn.dims.heartache > 0);
  assert.equal(sleepyTurn.dims.happy, 0);
  assert.doesNotMatch(sleepyTurn.reason, /@\[Quote\]/);
  assert.match(sleepyTurn.reason, /心疼對方辛苦或低落/);

  // Mixed cues: when net delta is positive, reason must choose the positive cue instead of heartache
  const mixedTurn = analyzeTurnLocally(
    '雖然今天好累，但謝謝你陪我真是太開心太棒了',
    '不客氣喵！',
  );
  assert.ok(mixedTurn);
  assert.ok(mixedTurn.moodDelta > 0);
  assert.match(mixedTurn.reason, /被暖到與開心互動/);
  assert.doesNotMatch(mixedTurn.reason, /心疼對方辛苦或低落/);

  // Negated user expressions should not trigger positive/negative spikes
  const negatedTurn = analyzeTurnLocally('今天不是太開心，也不是很累', '陪你坐一會兒。');
  assert.equal(negatedTurn, null);

  // Wrapper stripper removes @[Quote] / @[File: ...] mentions cleanly
  assert.equal(
    stripAntigravityWrappers('<USER_REQUEST>\n@[Quote] 早安\n@[File: app.js] 看這裡\n</USER_REQUEST>'),
    '早安\n看這裡',
  );
});

test('sleeping state stays consistent across care actions, auto nap timeout, and speak-up auto wake', async () => {
  await withTempRoot(async (root) => {
    const t0 = new Date(2026, 10, 11, 10, 0, 0).getTime(); // Wed 10:00 peak (outside quiet hours)

    // 1. Fall asleep -> pet/comfort/whisper keep sleeping with dreamy responses
    const nap1 = performNestAction('nap', { root, now: t0 });
    assert.equal(nap1.state.sleeping, true);
    assert.equal(nap1.state.history[nap1.state.history.length - 1].label, '蓋小被子休息');

    const alreadySleep = performNestAction('sleep', { root, now: t0 + 1000 });
    assert.equal(alreadySleep.unchanged, true);
    assert.equal(alreadySleep.state.sleeping, true);

    const petWhileSleep = performNestAction('pet', { root, now: t0 + 2000 });
    assert.equal(petWhileSleep.state.sleeping, true);
    assert.match(petWhileSleep.reaction, /睡夢|zzZ/);
    assert.doesNotMatch(petWhileSleep.reaction, /尾巴高高翹起/);

    const whisperSleep = performNestAction('whisper', { note: '早點醒來吃魚乾', root, now: t0 + 3000 });
    assert.equal(whisperSleep.state.sleeping, true);
    assert.match(whisperSleep.reaction, /枕邊/);

    const sleepCtx = consumePendingNestContext(root, { consume: true, now: t0 + 4000 });
    assert.equal(sleepCtx.sleeping, true);
    assert.match(sleepCtx.text, /睡覺狀態表現準則/);
    assert.match(sleepCtx.text, /枕邊/);

    // 2. Speak-up skips early nap (< MIN_SLEEP_FOR_SPEAKUP_WAKE_MS), then naturally wakes when hit after sleeping long enough
    saveSpeakUpConfig({ enabled: true, dryRun: false, peakHitLine: 100, valleyHitLine: 100 }, root);
    const earlyMessages = [];
    const earlyRoll = await executeSpeakUpRoll({
      root,
      mode: 'auto',
      now: new Date(t0 + 5 * 60_000),
      targetConvId: 'conv-sleep',
      randomFn: () => 1,
      sender: async (id, msg) => earlyMessages.push({ id, msg }),
    });
    assert.equal(earlyRoll.action, 'sleeping');
    assert.equal(earlyMessages.length, 0);
    assert.equal(loadNestState(root, t0 + 5 * 60_000).sleeping, true);

    const lateMessages = [];
    const wakeRoll = await executeSpeakUpRoll({
      root,
      mode: 'auto',
      now: new Date(t0 + MIN_SLEEP_FOR_SPEAKUP_WAKE_MS + 60_000),
      targetConvId: 'conv-sleep',
      randomFn: () => 1,
      sender: async (id, msg) => lateMessages.push({ id, msg }),
    });
    assert.equal(wakeRoll.action, 'sent');
    assert.equal(wakeRoll.wokeFromSleep, true);
    assert.equal(lateMessages.length, 1);
    assert.match(lateMessages[0].msg, /睡夠一覺剛自己伸懶腰醒過來/);
    assert.equal(loadNestState(root, t0 + MIN_SLEEP_FOR_SPEAKUP_WAKE_MS + 61_000).sleeping, false);

    // 3. Feed wakes sleeping cat with dedicated wake label & MAX_AUTO_NAP_MS ends unattended naps
    const nap2 = performNestAction('nap', { root, now: t0 + 40 * 60_000 });
    assert.equal(nap2.state.sleeping, true);
    const feedWake = performNestAction('feed', { root, now: t0 + 41 * 60_000 });
    assert.equal(feedWake.wokeFromSleep, true);
    assert.equal(feedWake.state.sleeping, false);
    assert.match(feedWake.reaction, /香醒|醒了/);

    const nap3 = performNestAction('nap', { root, now: t0 + 45 * 60_000 });
    assert.equal(nap3.state.sleeping, true);
    const autoRested = loadNestState(root, t0 + 45 * 60_000 + MAX_AUTO_NAP_MS + 1000);
    assert.equal(autoRested.sleeping, false);
    assert.ok(autoRested.energy >= 92);
    const wokeCtx = consumePendingNestContext(root, { consume: true, now: t0 + 45 * 60_000 + MAX_AUTO_NAP_MS + 2000 });
    assert.match(wokeCtx.text, /剛醒過來/);
  });
});

test('upstream parity upgrades: fish-memory v1.6.1 stable_profile recall, feiyu-mood v0.9.3 angry 45m half-life, xingxi v0.3.2 bridges & eventDate, speak-up v0.3.2 tag', async () => {
  await withTempRoot(async (root) => {
    const t0 = Date.UTC(2026, 10, 15, 10, 0, 0);

    // 1. dsh-fish-memory v1.6.1: stable_profile / importance=1 is recalled + custom keywords
    const profMem = rememberMemory({
      text: '主人最愛喝熱伯爵鮮奶茶微糖',
      importance: 1,
      category: 'stable_profile',
      factKey: '主人.飲品',
      keywords: ['飲料偏好', '下午茶'],
    }, { root, now: t0 });
    assert.equal(profMem.ok, true);
    assert.equal(profMem.memory.category, 'stable_profile');

    const recallHit = recallMemories('下午茶想點飲料偏好', { root, now: t0 + 1000 });
    assert.equal(recallHit.selected.length, 1);
    assert.equal(recallHit.selected[0].m.id, profMem.memory.id);

    // 2. dsh-feiyu-mood v0.9.3: 8th dimension angry has 45m half-life vs 90m for sad, and blocked preview accuracy
    saveMoodConfig({ injectPerDay: 1 }, root);
    const m1 = applyMoodDelta({
      moodDelta: -18,
      dims: { angry: 15, sad: 15 },
      reason: '測試生氣與難過半衰期差異',
      confidence: 95,
    }, { root, now: t0 });
    assert.equal(m1.state.dims.angry, 15);
    assert.equal(m1.state.dims.sad, 15);

    // After 45 minutes: angry halves (15 -> 8), while sad is at 11 (90m half-life)
    const after45m = getMoodSnapshot({ root, now: t0 + 45 * 60_000 });
    const angryVal = after45m.dims.find((d) => d.key === 'angry')?.value;
    const sadVal = after45m.dims.find((d) => d.key === 'sad')?.value;
    assert.equal(after45m.dims.length, 8);
    assert.equal(angryVal, 8);
    assert.equal(sadVal, 11);

    // Consume 1/1 daily injection -> next significant change must preview as blocked (not said)
    const inj1 = consumeMoodInjection({ root, now: t0 + 1000, consume: true });
    assert.equal(inj1.status, 'pending');
    assert.ok(inj1.text);
    applyMoodDelta({
      moodDelta: 18,
      dims: { happy: 15 },
      reason: '第二次顯著事件',
      confidence: 95,
    }, { root, now: t0 + 5000 });
    const injPreview = consumeMoodInjection({ root, now: t0 + 6000, consume: false });
    assert.equal(injPreview.status, 'blocked');

    // 3. dsh-xingxi v0.3.2: eventDate extraction, shared-word bridges, and schedule preservation
    appendToChapter(3, '- 主人喜歡看星辰煙火與喝伯爵茶', root);
    appendToChapter(6, '- **2026-11-12｜花火大會**：我們一起在河畔看星辰煙火與喝伯爵茶', root);
    appendDiary({ date: '2026-11-12', entry: '今晚在河畔看星辰煙火，還喝了熱呼呼的伯爵茶。' }, root);
    const graph = buildStarGraph(root);
    assert.ok(graph.stats.stars >= 2);
    assert.ok(graph.stats.diaries >= 1);
    assert.ok(Array.isArray(graph.bridges) && graph.bridges.length >= 1);
    const ch6Star = graph.stars.find((s) => s.chapter === 6);
    assert.equal(ch6Star?.eventDate, '2026-11-12');

    // saveXingxiConfig preserves lastScheduledDate when time/mode are unchanged, and clears today's marker when changed
    const todayKey = new Date().toLocaleDateString('sv-SE');
    saveXingxiConfig({ scheduleHour: 23, scheduleMinute: 30, scheduleMode: 'both', lastScheduledDate: todayKey }, root);
    const savedSame = saveXingxiConfig({ scheduleHour: 23, scheduleMinute: 30, scheduleMode: 'both', autoScheduleEnabled: true }, root);
    assert.equal(savedSame.lastScheduledDate, todayKey);
    const savedChanged = saveXingxiConfig({ scheduleHour: 22, scheduleMinute: 30, scheduleMode: 'both' }, root);
    assert.equal(savedChanged.lastScheduledDate, '');

    // 4. dsh-speak-up v0.3.2: closed <speak-up>...</speak-up> block
    const wrapped = wrapInnerThought('記得看看今天的待辦事項', new Date(t0));
    assert.match(wrapped, /^<speak-up>[\s\S]*<\/speak-up>$/);

    // 5. Latest upstream sync: fish-memory v1.6.3 (OOV proper noun sliding window + repeatWindow + factCap),
    //    feiyu-mood v0.9.6 (subject=other/none bystander protection), xingxi v0.3.8 (missed-schedule catch-up & delta append)
    const oovTokens = tokenize('星礫今天乖乖', root);
    assert.equal(oovTokens.has('星礫'), true);

    const oovMem = rememberMemory({
      text: '星礫是一隻愛吃抹茶團子的小白貓',
      importance: 0.8,
      category: 'event',
    }, { root, now: t0 + 10_000 });
    assert.equal(oovMem.ok, true);

    // First user turn recalls OOV proper noun memory
    const firstTurnRecall = recallMemories('星礫最喜歡吃什麼甜點', { root, now: t0 + 11_000, recordSample: true });
    assert.ok(firstTurnRecall.selected.some((r) => r.m.id === oovMem.memory.id));
    // Immediate next user turn within repeatWindow (15 turns) suppresses duplicate re-injection
    const secondTurnRecall = recallMemories('星礫最喜歡吃什麼甜點', { root, now: t0 + 12_000, recordSample: true });
    assert.equal(secondTurnRecall.selected.some((r) => r.m.id === oovMem.memory.id), false);

    // feiyu-mood v0.9.6: subject='other' clamps moodDelta to 0
    const moodBeforeBystander = getMoodSnapshot({ root, now: t0 + 20_000 }).mood;
    const bystanderRes = applyMoodDelta({
      subject: 'other',
      moodDelta: -12,
      dims: { sad: 10, heartache: 9, calm: 2 },
      reason: '聊到電視劇裡的路人角色很慘',
      confidence: 90,
    }, { root, now: t0 + 20_000 });
    assert.equal(getMoodSnapshot({ root, now: t0 + 20_000 }).mood, moodBeforeBystander);
    assert.equal(bystanderRes.state.dims.heartache, 0);

    // xingxi v0.3.6-v0.3.8: missed-schedule catch-up when lastScheduledDate < yesterday (and before today's scheduled hour)
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const paths = getDataPaths(root);
    mkdirSync(paths.runtimeDir, { recursive: true });
    const catchupTranscript = join(paths.runtimeDir, 'conv-catchup.jsonl');
    writeFileSync(catchupTranscript, [
      JSON.stringify({ type: 'USER_INPUT', content: '昨天傍晚一起吃章魚燒', created_at: '2026-11-17T18:00:00' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: '超好吃！', created_at: '2026-11-17T18:01:00' }),
    ].join('\n'), 'utf-8');
    writeFileSync(join(paths.runtimeDir, 'sessions.json'), JSON.stringify({
      sessions: [{ conversationId: 'conv-catchup', transcriptPath: catchupTranscript }],
    }), 'utf-8');

    saveXingxiConfig({
      autoScheduleEnabled: true,
      scheduleHour: 23,
      scheduleMinute: 30,
      scheduleMode: 'both',
      lastScheduledDate: '2026-11-16',
    }, root);
    const catchupSent = [];
    const catchupRes = await executeXingxiPickup({
      root,
      trigger: 'scheduled',
      now: new Date('2026-11-18T10:00:00'),
      targetConvId: 'conv-catchup',
      sender: async (id, prompt) => catchupSent.push({ id, prompt }),
    });
    assert.equal(catchupRes.action, 'dispatched');
    assert.equal(catchupRes.catchUp, true);
    assert.equal(catchupRes.date, '2026-11-17');
    assert.equal(catchupSent.length, 1);
    assert.match(catchupSent[0].prompt, /章魚燒/);
  });
});

test('mood innerThought toggle, editable prompts, and speak-up queue/routines with random jitter & dual switches', async () => {
  await withTempRoot(async (root) => {
    const t0 = new Date('2026-11-20T12:00:00').getTime();

    // 1. innerThought persists even when moodDelta=0, never fabricated by local fallback or decay, and respects toggle
    const pureThought = applyMoodDelta({
      subject: 'self',
      moodDelta: 0,
      innerThought: '剛忙完一段落，等會兒找機會提醒對方伸個懶腰。',
    }, { root, source: 'chat-ai', now: t0 });
    assert.equal(pureThought.applied, true);
    assert.match(getMoodSnapshot({ root, now: t0 }).lastInnerThought, /伸個懶腰/);

    // Decay advances mood note without erasing real innerThought
    const decayed = getMoodSnapshot({ root, now: t0 + 1000 * 3600 });
    assert.match(decayed.lastInnerThought, /伸個懶腰/);

    // Disabling innerThoughtEnabled stops storing innerThought & removes innerThought prompt hint
    const mCfgOff = saveMoodConfig({ innerThoughtEnabled: false, ownerName: '小主人' }, root);
    assert.doesNotMatch(buildInChatMoodRule(mCfgOff), /innerThought/);
    applyMoodDelta({ moodDelta: 3, reason: '純數字更新', innerThought: 'SHOULD_NOT_SAVE' }, { root, source: 'chat-ai', now: t0 + 5000 });
    assert.doesNotMatch(getMoodSnapshot({ root, now: t0 + 5000 }).lastInnerThought, /SHOULD_NOT_SAVE/);

    // Custom prompt templates render placeholders & collapse back to default when reset to ''
    saveMoodConfig({
      innerThoughtEnabled: true,
      inChatRulePrompt: 'CUSTOM_MOOD for {{ownerName}} / {{selfPronoun}}',
    }, root);
    assert.equal(buildInChatMoodRule(saveMoodConfig({}, root)), 'CUSTOM_MOOD for 小主人 / 我');
    saveMoodConfig({ inChatRulePrompt: '' }, root);
    assert.match(buildInChatMoodRule(saveMoodConfig({}, root)), /對話內心情自評/);

    // Adjustable stepDivisor, changesPerDay cap, and injectUnlimited
    saveMoodConfig({ stepDivisor: 1, changesPerDay: 2, injectPerDay: 1, injectUnlimited: false }, root);
    const snapBeforeCap = getMoodSnapshot({ root, now: t0 + 10_000 });
    const prevMoodVal = snapBeforeCap.mood;
    const prevChanges = snapBeforeCap.changesToday; // 1 from earlier line 725!
    assert.equal(prevChanges, 1);
    const hit1 = applyMoodDelta({ moodDelta: 1, reason: '1:1 靈敏度測試', confidence: 90 }, { root, source: 'chat-ai', now: t0 + 11_000 });
    assert.equal(hit1.moodStep, 1);
    assert.equal(Math.round(hit1.state.mood), prevMoodVal + 1);
    const blockedNum = applyMoodDelta({ moodDelta: 3, reason: '超過每日數值變化上限', confidence: 90 }, { root, source: 'chat-ai', now: t0 + 12_000 });
    assert.equal(blockedNum.applied, false);
    assert.equal(blockedNum.capped, true);
    const thoughtWhenCapped = applyMoodDelta({
      moodDelta: 3,
      reason: '數值滿額但仍記內心小劇場',
      innerThought: '今天心情數字不能再動了，但心裡還是偷樂一下！',
    }, { root, source: 'chat-ai', now: t0 + 13_000 });
    assert.equal(thoughtWhenCapped.applied, true);
    assert.equal(thoughtWhenCapped.moodStep, 0);
    assert.match(getMoodSnapshot({ root, now: t0 + 13_000 }).lastInnerThought, /偷樂一下/);

    // Reset changesPerDay to unlimited (0) & test injectUnlimited bypassing injectPerDay=1
    saveMoodConfig({ changesPerDay: 0, injectPerDay: 1, injectUnlimited: true }, root);
    consumeMoodInjection({ root, consume: true, now: t0 + 14_000 });
    applyMoodDelta({ moodDelta: 5, reason: '無限注入測試', confidence: 95 }, { root, source: 'chat-ai', now: t0 + 15_000 });
    const unlimInj = consumeMoodInjection({ root, consume: false, now: t0 + 16_000 });
    assert.equal(unlimInj.status, 'pending');
    assert.equal(getMoodSnapshot({ root, now: t0 + 16_000 }).injectQuota.unlimited, true);

    mutateMemory('updatePolicy', {
      policy: { inChatRulePrompt: 'CUSTOM_MEM {{left}}/{{dailyQuota}} for {{ownerName}}' },
    }, root);
    assert.match(buildInChatMemoryRule(root, { ownerName: '小主人', now: t0 }), /^CUSTOM_MEM \d+\/8 for 小主人$/);

    // 2. Speak-Up AI plan queue + batch + recurring jitter routines + active chat deferral vs explicit reminder
    saveSpeakUpConfig({
      enabled: true,
      aiPlanEnabled: true,
      diceEnabled: false,
      dryRun: false,
      quietStartHour: 1,
      quietEndHour: 7,
      respectActiveChatGapMin: 10,
      inChatRulePrompt: 'CUSTOM_SP_RULE gap={{activeGapMin}}',
      followUpHintPrompt: 'CUSTOM_FOLLOWUP_HINT',
    }, root);
    assert.equal(buildInChatSpeakUpRule(root), 'CUSTOM_SP_RULE gap=10');

    // Pure AI mode skips dice roll when queue empty
    const sentMsgs = [];
    const waitTick = await executeSpeakUpTick({
      root,
      now: new Date(t0),
      targetConvId: 'cat-conv',
      randomFn: () => 0,
      sender: async (id, text) => sentMsgs.push({ id, text }),
    });
    assert.equal(waitTick.action, 'waiting_plan');
    assert.equal(sentMsgs.length, 0);

    // Batch plans + active chat deferral for autonomous vs on-time delivery for reminder
    const batch = mutateSpeakUpPlan('schedule_batch', {
      plans: [
        { delayMinutes: 5, kind: 'autonomous', label: '自主關心', thought: '來看看你忙完沒' },
        { delayMinutes: 8, kind: 'reminder', label: '喝水提醒', thought: '記得喝口水喔' },
      ],
    }, root, { now: t0 });
    assert.equal(batch.ok, true);
    assert.equal(batch.added.length, 2);

    // At t0 + 5m: user spoke 2m ago -> autonomous plan is deferred, NOT sent
    const deferredTick = await executeSpeakUpTick({
      root,
      now: new Date(t0 + 5 * 60000),
      lastUserSpeechAt: t0 + 3 * 60000,
      targetConvId: 'cat-conv',
      sender: async (id, text) => sentMsgs.push({ id, text }),
    });
    assert.equal(deferredTick.action, 'deferred_active_chat');
    assert.equal(sentMsgs.length, 0);

    // At t0 + 8m: reminder plan fires ON TIME even though user chatted recently!
    const reminderTick = await executeSpeakUpTick({
      root,
      now: new Date(t0 + 8 * 60000),
      lastUserSpeechAt: t0 + 7 * 60000,
      targetConvId: 'cat-conv',
      sender: async (id, text) => sentMsgs.push({ id, text }),
    });
    assert.equal(reminderTick.action, 'sent_planned');
    assert.equal(reminderTick.kind, 'reminder');
    assert.equal(sentMsgs.length, 1);
    assert.match(sentMsgs[0].text, /記得喝口水喔/);
    assert.match(sentMsgs[0].text, /CUSTOM_FOLLOWUP_HINT/);

    // 3. Fixed routine within ±20m random window advances to next day after firing
    const rtRes = mutateSpeakUpPlan('add_routine', {
      label: '中午波動問候',
      timeHHMM: '12:30',
      jitterMin: 20,
      thought: '問候吃飯沒',
    }, root, { now: t0, randomUnitFn: () => 0.75 }); // +10m -> 12:40 today!
    assert.equal(rtRes.ok, true);
    const rtHourMin = new Date(rtRes.routine.nextTriggerAt);
    assert.equal(rtHourMin.getHours(), 12);
    assert.equal(rtHourMin.getMinutes(), 40);

    // Clear remaining autonomous plan so routine fires at 12:41
    mutateSpeakUpPlan('clear_plans', { kind: 'autonomous' }, root, { now: t0 });
    const rtFire = await executeSpeakUpTick({
      root,
      now: new Date(rtRes.routine.nextTriggerAt + 60000),
      lastUserSpeechAt: 0,
      targetConvId: 'cat-conv',
      randomUnitFn: () => 0.25, // -10m -> tomorrow 12:20!
      sender: async (id, text) => sentMsgs.push({ id, text }),
    });
    assert.equal(rtFire.action, 'sent_planned');
    assert.equal(rtFire.dueType, 'routine');
    assert.match(sentMsgs[sentMsgs.length - 1].text, /問候吃飯沒/);
    const reloaded = loadSpeakUpState(root);
    const tomorrowRt = new Date(reloaded.routines[0].nextTriggerAt);
    assert.equal(tomorrowRt.getDate(), rtHourMin.getDate() + 1);
    assert.equal(tomorrowRt.getHours(), 12);
    assert.equal(tomorrowRt.getMinutes(), 20);

    // Turning aiPlanEnabled off + diceEnabled on reverts tick to classic dice fallback
    // Simulate user having chatted 30m before diceTick so unansweredCount resets cleanly
    saveSpeakUpConfig({ aiPlanEnabled: false, diceEnabled: true, valleyHitLine: 100, usePeakValley: false }, root);
    assert.equal(buildInChatSpeakUpRule(root), '');
    const diceTick = await executeSpeakUpTick({
      root,
      now: new Date(t0 + 75 * 60000),
      lastUserSpeechAt: t0 + 45 * 60000,
      targetConvId: 'cat-conv',
      randomFn: () => 1,
      sender: async (id, text) => sentMsgs.push({ id, text }),
    });
    assert.equal(diceTick.action, 'sent');
  });
});

test('smart speak-up restraint: active-chat dice block, silence window, reminder guard, unanswered cap & backoff, and tendency cues', async () => {
  await withTempRoot(async (root) => {
    const sent = [];
    const sender = async (id, msg) => sent.push({ id, msg });

    // 1. Dice must respect active chat gap even when missBonus > 0 (prevents 2.7m interruptions!)
    const dayT0 = new Date('2026-11-20T16:40:00').getTime();
    saveSpeakUpConfig({
      enabled: true,
      aiPlanEnabled: true,
      diceEnabled: true,
      dryRun: false,
      respectActiveChatGapMin: 8,
      diceBlockActiveChat: true,
      missBonus: 10,
      bonusCap: 40,
      peakHitLine: 20,
      cooldownMin: 20,
      maxUnansweredSpontaneous: 2,
    }, root);
    const activeBlocked = await executeSpeakUpRoll({
      root,
      mode: 'auto',
      now: new Date(dayT0 + 3 * 60_000),
      lastUserSpeechAt: dayT0, // 3 mins ago (< 8m)
      targetConvId: 'cat-conv',
      randomFn: () => 0,
      sender,
    });
    assert.equal(activeBlocked.action, 'active_chat_blocked');
    assert.equal(sent.length, 0);

    // 2. Overnight wake-up reminder + silenceUntilTrigger suppresses morning random dice while firing wake reminder ON TIME
    const bedtime = new Date('2026-11-21T02:02:00').getTime();
    saveSpeakUpConfig({
      quietStartHour: 2,
      quietEndHour: 8,
      suppressDiceBeforeReminder: true,
      suppressBeforeReminderMin: 120,
      intervalMinutes: 25,
      valleyHitLine: 100,
      peakHitLine: 100,
    }, root);
    const wakePlan = mutateSpeakUpPlan('schedule', {
      kind: 'reminder',
      at: '09:00',
      label: '早上叫主人起床',
      thought: '早安，九點啦該起床囉',
      silenceUntilTrigger: true,
    }, root, { now: bedtime });
    assert.equal(wakePlan.ok, true);
    assert.ok(wakePlan.state.silentUntil >= wakePlan.plan.triggerAt);

    // At 08:12 (after quiet hours ended, while silentUntil active until 09:00): dice tick stays silenced
    const morningSilenced = await executeSpeakUpTick({
      root,
      now: new Date('2026-11-21T08:12:00'),
      lastUserSpeechAt: bedtime,
      targetConvId: 'cat-conv',
      randomFn: () => 0,
      sender,
    });
    assert.equal(morningSilenced.action, 'silenced');
    assert.equal(sent.length, 0);

    // Even after clearing manual silence, awaiting_wake_reminder guard STILL suppresses morning dice before 09:00 (even with near window = 30m)!
    mutateSpeakUpPlan('clear_silence', {}, root, { now: new Date('2026-11-21T08:15:00').getTime() });
    saveSpeakUpConfig({ suppressBeforeReminderMin: 30 }, root);
    const guardWake = await executeSpeakUpRoll({
      root,
      mode: 'auto',
      now: new Date('2026-11-21T08:20:00'),
      lastUserSpeechAt: bedtime,
      targetConvId: 'cat-conv',
      randomFn: () => 0,
      sender,
    });
    assert.equal(guardWake.action, 'reminder_guard');
    assert.equal(guardWake.reason, 'awaiting_wake_reminder');
    assert.equal(sent.length, 0);

    // Near reminder window (08:40 -> 20m left <= 30m) returns near_reminder
    const guardNear = await executeSpeakUpRoll({
      root,
      mode: 'auto',
      now: new Date('2026-11-21T08:40:00'),
      lastUserSpeechAt: bedtime,
      targetConvId: 'cat-conv',
      randomFn: () => 0,
      sender,
    });
    assert.equal(guardNear.action, 'reminder_guard');
    assert.equal(guardNear.reason, 'near_reminder');
    assert.equal(sent.length, 0);

    // At 09:00: wake-up reminder fires ON TIME!
    const wakeFired = await executeSpeakUpTick({
      root,
      now: new Date('2026-11-21T09:00:00'),
      lastUserSpeechAt: bedtime,
      targetConvId: 'cat-conv',
      sender,
    });
    assert.equal(wakeFired.action, 'sent_planned');
    assert.equal(wakeFired.kind, 'reminder');
    assert.equal(sent.length, 1);
    assert.equal(wakeFired.state.unansweredCount, 1);
    assert.doesNotMatch(sent[0].msg, /按這個點來想事、說話/);

    // 3. Unanswered backoff (at 10:07 >= 2*20m cooldown -> 2nd message sends), then capped at maxUnansweredSpontaneous=2 (11:15 blocked!)
    const followUp = await executeSpeakUpTick({
      root,
      now: new Date('2026-11-21T10:07:00'),
      lastUserSpeechAt: bedtime,
      targetConvId: 'cat-conv',
      randomFn: () => 0,
      sender,
    });
    assert.equal(followUp.action, 'sent');
    assert.equal(sent.length, 2);
    assert.equal(followUp.state.unansweredCount, 2);
    assert.match(sent[1].msg, /連續第 2 則/);

    const pausedThird = await executeSpeakUpTick({
      root,
      now: new Date('2026-11-21T11:15:00'),
      lastUserSpeechAt: bedtime,
      targetConvId: 'cat-conv',
      randomFn: () => 0,
      sender,
    });
    assert.equal(pausedThird.action, 'unanswered_paused');
    assert.equal(sent.length, 2);

    // Once user replies, unansweredCount resets cleanly and spontaneous Speak-Up works again
    noteUserSpokeForSpeakUp(root, new Date('2026-11-21T11:30:00').getTime());
    assert.equal(loadSpeakUpState(root).unansweredCount, 0);

    // 4. scheduleTendency + proactiveCue triggers only on transition cues, not ordinary chat
    assert.equal(buildProactivePlanCue(root, '哈哈真的很好笑'), '');
    const cue = buildProactivePlanCue(root, '我先去忙一下等下回來');
    assert.match(cue, /貓窩排程小提示/);
    assert.match(cue, /高主動排程開啟中/);

    saveSpeakUpConfig({ scheduleTendency: 'low' }, root);
    const snapLow = getSpeakUpSnapshot(root);
    assert.doesNotMatch(snapLow.defaultInChatRulePrompt, /高積極度自主排程意識/);
  });
});

test('telegram bridge supports /bind pairing, whitelist guard, album media download, path security, and outbox file transfer', async () => {
  await withTempRoot(async (root) => {
    const t0 = new Date('2026-11-21T17:00:00').getTime();
    const apiCalls = [];
    const mockFetch = async (url, opts = {}) => {
      const u = String(url);
      if (u.endsWith('/getFile')) {
        const parsed = JSON.parse(opts.body);
        apiCalls.push({ method: 'getFile', fileId: parsed.file_id });
        const ext = parsed.file_id === 'doc_1' ? 'report.txt' : 'pic.jpg';
        return new Response(JSON.stringify({
          ok: true,
          result: { file_id: parsed.file_id, file_path: `docs/${ext}`, file_size: 12 },
        }));
      }
      if (u.includes('/file/bot')) {
        return new Response(u.endsWith('report.txt') ? 'hello report' : 'FAKEJPGDATA', { status: 200 });
      }
      const method = u.split('/').pop();
      const body = opts.body instanceof FormData ? opts.body : JSON.parse(opts.body || '{}');
      apiCalls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 99, username: 'cat_nest_bot' } }));
    };

    // 1. Token stored safely and masked in snapshots
    saveTelegramConfig({ enabled: true, botToken: '123456:SECRET_ABC_XYZ_9999' }, root);
    const snap0 = getTelegramSnapshot(root, t0);
    assert.equal(snap0.config.hasBotToken, true);
    assert.equal(snap0.config.botTokenMasked, '123456:***9999');
    assert.equal(Object.hasOwn(snap0.config, 'botToken'), false);

    // 2. Pair code binds chatId cleanly & rejects unauthorized outsiders
    const { pairCode } = generateTelegramPairCode(root, t0);
    const dispatches = [];
    const dispatchFn = async (text, meta) => dispatches.push({ text, meta });

    await handleTelegramUpdatesBatch(
      [
        { update_id: 1, message: { message_id: 10, chat: { id: 8888 }, from: { id: 8888, first_name: 'Stranger' }, text: '偷窺一下' } },
        { update_id: 2, message: { message_id: 11, chat: { id: 7777 }, from: { id: 7777, username: 'owner_user' }, text: `/bind ${pairCode}` } },
      ],
      { root, dispatchToConversation: dispatchFn, fetchFn: mockFetch, now: t0 + 1000 },
    );
    assert.equal(dispatches.length, 0);
    assert.equal(getTelegramSnapshot(root, t0 + 2000).config.allowedChatId, '7777');

    // 3. Album photo + document download into inbox and combine media_group_id into 1 Antigravity turn
    await handleTelegramUpdatesBatch(
      [
        {
          update_id: 3,
          message: {
            message_id: 12,
            media_group_id: 'alb1',
            chat: { id: 7777 },
            from: { id: 7777, username: 'owner_user' },
            caption: '幫我看這張圖與這份文字檔',
            photo: [{ file_id: 'ph_small', file_size: 5 }, { file_id: 'ph_big', file_size: 12 }],
          },
        },
        {
          update_id: 4,
          message: {
            message_id: 13,
            media_group_id: 'alb1',
            chat: { id: 7777 },
            from: { id: 7777, username: 'owner_user' },
            document: { file_id: 'doc_1', file_name: '../evil/../../report.txt', mime_type: 'text/plain', file_size: 12 },
          },
        },
      ],
      { root, dispatchToConversation: dispatchFn, fetchFn: mockFetch, now: t0 + 5000 },
    );
    assert.equal(dispatches.length, 1);
    assert.match(dispatches[0].text, /\[TELEGRAM_INCOMING\]/);
    assert.match(dispatches[0].text, /幫我看這張圖與這份文字檔/);
    assert.match(dispatches[0].text, /report\.txt/);
    assert.equal(dispatches[0].meta.files.length, 2);
    assert.equal(existsSync(dispatches[0].meta.files[1].localPath), true);
    assert.equal(readFileSync(dispatches[0].meta.files[1].localPath, 'utf-8'), 'hello report');
    assert.equal(extractTelegramCleanUserText(dispatches[0].text), '幫我看這張圖與這份文字檔');

    // 4. Outbound path safety blocks telegram config / runtime / env files while allowing project & extraSendDirs
    const dataPaths = getDataPaths(root);
    assert.equal(isAllowedTelegramSendPath(join(dataPaths.telegramDir, 'config.json'), root).ok, false);
    assert.equal(isAllowedTelegramSendPath(join(root, '.env'), root).ok, false);
    assert.equal(isAllowedTelegramSendPath(join(dataPaths.runtimeDir, 'sessions.json'), root).ok, false);

    const artDir = join(root, 'exports');
    mkdirSync(artDir, { recursive: true });
    const outImg = join(artDir, 'cat_chart.png');
    const outDuplicate = join(artDir, 'already_sent.png');
    writeFileSync(outImg, 'PNGDATA');
    writeFileSync(outDuplicate, 'PNGDATA2');

    // Outbox skips files already sent via MCP telegram_send AND skips inbox echo files
    recordTelegramMcpSentFile(root, outDuplicate, t0 + 6000);
    const inboxFileUrl = pathToFileURL(dispatches[0].meta.files[0].localPath).href;
    const outImgUrl = pathToFileURL(outImg).href;
    const dupUrl = pathToFileURL(outDuplicate).href;
    const replyMd = `看完了，幫你生好新圖：[cat_chart.png](${outImgUrl})\n（原圖 [inbox](${inboxFileUrl}) 與 [dup](${dupUrl}) 不應重發）`;

    assert.equal(extractMarkdownFileLinks(replyMd).length, 3);
    // Desktop turn shouldn't forward when forwardDesktopReplies=false
    const deskSkip = maybeQueueTelegramOutgoing({
      root,
      mode: 'user',
      turnHash: 'h-desk',
      assistantText: '電腦回覆不應轉傳',
      now: t0 + 7000,
    });
    assert.equal(deskSkip.queued, false);

    // Telegram turn queues text + only new artifact cat_chart.png
    const qRes = maybeQueueTelegramOutgoing({
      root,
      mode: 'telegram',
      turnHash: 'h-tg-1',
      assistantText: replyMd,
      now: t0 + 8000,
    });
    assert.equal(qRes.queued, true);
    assert.equal(qRes.fileCount, 1);

    // Duplicate turnHash skipped
    assert.equal(
      maybeQueueTelegramOutgoing({ root, mode: 'telegram', turnHash: 'h-tg-1', assistantText: replyMd, now: t0 + 8100 }).queued,
      false,
    );

    apiCalls.length = 0;
    const flushed = await flushTelegramOutbox(root, { fetchFn: mockFetch, now: t0 + 9000 });
    assert.equal(flushed.sent, 1);
    assert.equal(flushed.remaining, 0);
    assert.ok(apiCalls.some((c) => c.method === 'sendMessage'));
    assert.ok(apiCalls.some((c) => c.method === 'sendPhoto' && c.body instanceof FormData));

    // Direct non-image file uses sendDocument & long text chunks <= 4000 chars
    const pdfPath = join(artDir, 'summary.pdf');
    writeFileSync(pdfPath, 'PDFBYTES');
    const docSend = await telegramSendFile('123456:SECRET_ABC_XYZ_9999', '7777', pdfPath, { root, fetchFn: mockFetch });
    assert.equal(docSend.ok, true);
    assert.equal(docSend.method, 'sendDocument');
    assert.equal(chunkTelegramText('A\n\n'.repeat(2500), 4000).every((c) => c.length <= 4000), true);

    // 5. Desktop-active mute skips non-telegram notifications during active PC chat, or delivers silently with disable_notification=true
    saveTelegramConfig({
      forwardSpeakUp: true,
      muteWhenDesktopActive: true,
      desktopActiveMuteMin: 15,
      desktopMuteMode: 'skip',
    }, root);
    const desktopNow = t0 + 5 * 60_000;
    const mutedSkip = maybeQueueTelegramOutgoing({
      root,
      mode: 'speak-up',
      turnHash: 'h-sp-muted',
      assistantText: '電腦前正在聊，手機先不吵',
      lastDesktopSpeechAt: desktopNow - 2 * 60_000,
      now: desktopNow,
    });
    assert.equal(mutedSkip.queued, false);
    assert.equal(mutedSkip.reason, 'desktop_active_muted');

    // Silent mode forwards with `disable_notification: true`
    saveTelegramConfig({ desktopMuteMode: 'silent' }, root);
    const mutedSilent = maybeQueueTelegramOutgoing({
      root,
      mode: 'speak-up',
      turnHash: 'h-sp-silent',
      assistantText: '無聲傳過去備忘',
      lastDesktopSpeechAt: desktopNow - 2 * 60_000,
      now: desktopNow + 100,
    });
    assert.equal(mutedSilent.queued, true);
    assert.equal(mutedSilent.silent, true);
    apiCalls.length = 0;
    await flushTelegramOutbox(root, { fetchFn: mockFetch, now: desktopNow + 200 });
    assert.equal(apiCalls.find((c) => c.method === 'sendMessage')?.body?.disable_notification, true);

    // Direct reply to a Telegram-originated turn is never muted even when PC was active earlier
    const tgReplyDuringDesktop = maybeQueueTelegramOutgoing({
      root,
      mode: 'telegram',
      turnHash: 'h-tg-direct',
      assistantText: '你剛從 Telegram 找我，這則直接回你！',
      lastDesktopSpeechAt: desktopNow - 60_000,
      now: desktopNow + 300,
    });
    assert.equal(tgReplyDuringDesktop.queued, true);
    assert.equal(tgReplyDuringDesktop.silent, false);

    // Non-existent extra path blocked unless listed in extraSendDirs
    const outsideDir = mkdtempSync(join(tmpdir(), 'tg-outside-'));
    try {
      const outsideFile = join(outsideDir, 'hello.txt');
      writeFileSync(outsideFile, 'ok');
      assert.equal(isAllowedTelegramSendPath(outsideFile, root).ok, false);
      saveTelegramConfig({ extraSendDirs: [outsideDir] }, root);
      assert.equal(isAllowedTelegramSendPath(outsideFile, root).ok, true);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }

    // 6. Transcript history sync backfills past [TELEGRAM_INCOMING] + PLANNER_RESPONSE turns
    const txPath = join(root, 'fake-transcript.jsonl');
    writeFileSync(
      txPath,
      [
        JSON.stringify({ type: 'SYSTEM_MESSAGE', created_at: '2026-11-21T09:17:23Z', content: '<SYSTEM_MESSAGE>\n[TELEGRAM_INCOMING]\n時間：17:17\n訊息內容：\n同步舊紀錄測試\n</SYSTEM_MESSAGE>' }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', created_at: '2026-11-21T09:17:24Z', content: '收到同步測試！' }),
      ].join('\n'),
      'utf-8',
    );
    const syncRes = syncTelegramHistoryFromTranscript(root, txPath);
    assert.equal(syncRes.ok, true);
    assert.equal(syncRes.imported, 2);
    assert.ok(getTelegramSnapshot(root, desktopNow + 500).chatHistory.some((h) => h.text === '同步舊紀錄測試'));

    // 7. Desktop conversation mirror forwards user prompt + assistant reply in strict order
    saveTelegramConfig({
      forwardDesktopReplies: true,
      forwardDesktopUserMessages: true,
      desktopMuteMode: 'silent',
    }, root);
    await flushTelegramOutbox(root, { fetchFn: mockFetch, now: desktopNow + 600 });
    apiCalls.length = 0;
    const mirrorQ = maybeQueueTelegramOutgoing({
      root,
      mode: 'user',
      turnHash: 'h-desk-both',
      userText: '電腦這邊問的問題也能同步嗎',
      assistantText: '沒問題，兩邊一起同步過去！',
      lastDesktopSpeechAt: desktopNow - 30_000,
      now: desktopNow + 700,
    });
    assert.equal(mirrorQ.queued, true);
    assert.equal(mirrorQ.mirroredUser, true);
    assert.equal(mirrorQ.silent, true);
    await flushTelegramOutbox(root, { fetchFn: mockFetch, now: desktopNow + 800 });
    const msgCalls = apiCalls.filter((c) => c.method === 'sendMessage').map((c) => c.body);
    assert.equal(msgCalls.length, 2);
    assert.match(msgCalls[0].text, /你（電腦端）：\n電腦這邊問的問題也能同步嗎/);
    assert.equal(msgCalls[0].disable_notification, true);
    assert.equal(msgCalls[1].text, '沒問題，兩邊一起同步過去！');
    assert.equal(msgCalls[1].disable_notification, true);
    const histAfterMirror = getTelegramSnapshot(root, desktopNow + 900).chatHistory;
    assert.ok(histAfterMirror.some((h) => h.dir === 'in' && h.mode === 'desktop-mirror' && h.text === '電腦這邊問的問題也能同步嗎'));

    // Turning off forwardDesktopUserMessages mirrors only assistant reply
    saveTelegramConfig({ forwardDesktopUserMessages: false }, root);
    apiCalls.length = 0;
    const mirrorReplyOnly = maybeQueueTelegramOutgoing({
      root,
      mode: 'user',
      turnHash: 'h-desk-reply-only',
      userText: '這句只該留在電腦',
      assistantText: '只同步貓貓回覆',
      lastDesktopSpeechAt: desktopNow - 30_000,
      now: desktopNow + 950,
    });
    assert.equal(mirrorReplyOnly.mirroredUser, false);
    await flushTelegramOutbox(root, { fetchFn: mockFetch, now: desktopNow + 960 });
    assert.equal(apiCalls.filter((c) => c.method === 'sendMessage').length, 1);

    // 8. lockSingleChat=true (default) blocks pairCode generation and second-account /bind once already bound
    const blockedPair = generateTelegramPairCode(root, desktopNow + 1000);
    assert.equal(blockedPair.blocked, true);
    assert.equal(blockedPair.pairCode, '');
    // Even if a stale pairCode exists in config while locked, a different chatId cannot piggyback
    saveTelegramConfig({ pairCode: 'ZZZZ99', pairCodeExpiresAt: desktopNow + 600_000 }, root);
    await handleTelegramUpdatesBatch(
      [{ update_id: 20, message: { message_id: 90, chat: { id: 9999 }, from: { id: 9999, first_name: 'Intruder' }, text: '/bind ZZZZ99' } }],
      { root, dispatchToConversation: dispatchFn, fetchFn: mockFetch, now: desktopNow + 1100 },
    );
    assert.equal(getTelegramSnapshot(root, desktopNow + 1200).config.allowedChatId, '7777');

    // Unlocking single-chat allows adding a second device cleanly
    saveTelegramConfig({ lockSingleChat: false }, root);
    const unlockedPair = generateTelegramPairCode(root, desktopNow + 1300);
    assert.equal(unlockedPair.blocked, false);
    assert.ok(unlockedPair.pairCode);
    await handleTelegramUpdatesBatch(
      [{ update_id: 21, message: { message_id: 91, chat: { id: 9999 }, from: { id: 9999, first_name: 'Tablet' }, text: `/bind ${unlockedPair.pairCode}` } }],
      { root, dispatchToConversation: dispatchFn, fetchFn: mockFetch, now: desktopNow + 1400 },
    );
    assert.equal(getTelegramSnapshot(root, desktopNow + 1500).config.allowedChatId, '7777, 9999');
  });
});
