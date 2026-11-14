import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { recallMemories, rememberMemory, mutateMemory, computeFreshness, isUniversalKey } from '../core/memory.mjs';
import { analyzeTurnLocally, applyMoodDelta, consumeMoodInjection, decayMoodState, getMoodSnapshot, moodLabel, moodTier } from '../core/mood.mjs';
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
import { calcHitLine, executeSpeakUpRoll, inQuietHours, isPeakHour, saveSpeakUpConfig, wrapInnerThought } from '../core/speak-up.mjs';
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

test('cat nest actions do not inflate mood, enforce cooldown/satiety/daily limits, and queue chat injection', async () => {
  await withTempRoot((root) => {
    const t0 = Date.UTC(2026, 10, 14, 10, 0, 0);
    const moodBefore = getMoodSnapshot({ root, now: t0 }).mood;

    const r = performNestAction('feed', { root, now: t0 });
    assert.equal(r.ok, true);
    assert.ok(r.state.satiety >= 90);
    assert.equal(getMoodSnapshot({ root, now: t0 + 100 }).mood, moodBefore);

    // Immediate repeat hits cooldown limit
    const cooldownHit = performNestAction('feed', { root, now: t0 + 1000 });
    assert.equal(cooldownHit.ok, true);
    assert.equal(cooldownHit.limited, true);
    assert.equal(cooldownHit.limitReason, 'cooldown');
    assert.ok(cooldownHit.cooldownLeftSec > 0);

    // Exhaust daily pet cap (6/day) cleanly
    let curTs = t0;
    for (let i = 0; i < 6; i++) {
      curTs += 20_000;
      const petRes = performNestAction('pet', { root, now: curTs });
      assert.equal(petRes.ok, true);
      assert.equal(petRes.limited, false);
    }
    curTs += 20_000;
    const capHit = performNestAction('pet', { root, now: curTs });
    assert.equal(capHit.ok, true);
    assert.equal(capHit.limited, true);
    assert.equal(capHit.limitReason, 'daily_cap');

    assert.equal(resolveSpriteFile(85, false), 'mood_great.jpg');
    assert.equal(resolveSpriteFile(70, false), 'chibi_base.png');
    assert.equal(resolveSpriteFile(70, true), 'mood_sleep.jpg');

    setNestPreferences({ syncChatOnCare: true }, root, curTs);
    assert.equal(getNestSnapshot(root, 70, curTs).syncChatOnCare, true);
    performNestAction('whisper', { note: '記得喝溫水', root, now: curTs + 10_000 });
    const ctxBlock = consumePendingNestContext(root, { consume: true });
    assert.match(ctxBlock.text, /餵你吃了小魚乾/);
    assert.match(ctxBlock.text, /記得喝溫水/);

    // Drained after consume
    const after = consumePendingNestContext(root, { consume: false });
    assert.equal(after.pendingCount, 0);
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
