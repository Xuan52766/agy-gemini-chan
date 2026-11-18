import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { applyMoodDelta, getMoodSnapshot } from '../core/mood.mjs';
import { getNestSnapshot, loadNestState, performNestAction } from '../core/nest.mjs';
import { mutatePersona } from '../core/persona.mjs';
import { appendDiary, appendToChapter } from '../core/xingxi.mjs';
import { buildSidecarConfig, setupSidecar } from '../scripts/setup-sidecar.mjs';
import { registerSidecarRoutes } from '../sidecar/routes.mjs';

const REPO_ROOT = resolve('.');

function runHook(scriptRel, inputObj, env = {}) {
  const res = spawnSync(process.execPath, [join(REPO_ROOT, scriptRel)], {
    input: JSON.stringify(inputObj),
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  assert.equal(res.status, 0, `Hook ${scriptRel} exited with ${res.status}: ${res.stderr}`);
  return JSON.parse((res.stdout || '{}').trim() || '{}');
}

test('hooks.json follows Antigravity plugin schema contract', () => {
  const pluginDir = join(REPO_ROOT, '.agents/plugins/gemini-cat');
  const raw = readFileSync(join(pluginDir, 'hooks.json'), 'utf-8');
  assert.doesNotMatch(raw, /[A-Za-z]:[/\\]|\/Users\/|\/home\//);
  const parsed = JSON.parse(raw);
  assert.equal(Object.hasOwn(parsed, 'hooks'), false);
  const entry = parsed['gemini-cat'];
  assert.ok(entry && typeof entry === 'object');

  for (const ev of ['SessionStart', 'PreInvocation', 'Stop']) {
    assert.ok(Array.isArray(entry[ev]), `${ev} must be a flat array`);
    assert.equal(entry[ev].length, 1);
    assert.equal(entry[ev][0].type, 'command');
    assert.ok(entry[ev][0].timeout > 0 && entry[ev][0].timeout <= 60);
    assert.equal(Object.hasOwn(entry[ev][0], 'hooks'), false);
    const scriptRel = entry[ev][0].command.replace(/^node\s+/, '');
    assert.equal(existsSync(resolve(pluginDir, scriptRel)), true, `missing hook target: ${scriptRel}`);
  }
  assert.ok(Array.isArray(entry.PostToolUse));
  assert.equal(entry.PostToolUse[0].matcher, '*');
  assert.ok(Array.isArray(entry.PostToolUse[0].hooks));
  const postScriptRel = entry.PostToolUse[0].hooks[0].command.replace(/^node\s+/, '');
  assert.equal(existsSync(resolve(pluginDir, postScriptRel)), true, `missing post hook target: ${postScriptRel}`);

  const mcpRaw = readFileSync(join(pluginDir, 'mcp_config.json'), 'utf-8');
  assert.doesNotMatch(mcpRaw, /[A-Za-z]:[/\\]|\/Users\/|\/home\//);
  const mcpCfg = JSON.parse(mcpRaw);
  assert.equal(Object.hasOwn(mcpCfg.mcpServers || {}, 'gemini-cat'), false);
  assert.equal(Object.hasOwn(mcpCfg.mcpServers || {}, 'companion'), true);
  const companion = mcpCfg.mcpServers.companion;
  assert.equal(
    existsSync(resolve(pluginDir, companion.cwd || '.', companion.args[0])),
    true,
    'companion MCP target must resolve cleanly from plugin dir',
  );

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
  const pluginMeta = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf-8'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pluginMeta.version, pkg.version);
});

test('hooks stay silent outside gemini_cat, inject Xingxi+Nest inside, and skip Stop fallback when AI updated mood', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gemini-cat-hook-data-'));
  const transcriptPath = join(dataDir, 'transcript.jsonl');
  writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: 'USER_INPUT', content: '好喜歡你，今天工作總算搞定了！' }),
      JSON.stringify({ type: 'PLANNER_RESPONSE', content: '太好了！辛苦主人一整天，記得休息喝水喔。' }),
    ].join('\n'),
    'utf-8',
  );

  const prevDataDir = process.env.GEMINI_CAT_DATA_DIR;
  try {
    process.env.GEMINI_CAT_DATA_DIR = dataDir;
    appendToChapter(5, '- 每天都要一起道早安', REPO_ROOT);
    appendDiary({ date: '2026-11-14', entry: '昨晚一起測試完貓窩超開心' }, REPO_ROOT);
    performNestAction('pet', { root: REPO_ROOT });

    const env = { GEMINI_CAT_DATA_DIR: dataDir };

    // Out-of-scope workspace: MUST return empty `{}` and inject nothing!
    const outOfScope = runHook('hooks/pre-invocation.mjs', {
      conversationId: 'other-conv',
      workspacePaths: ['C:\\workspaces\\other_project'],
      lastUserInput: '幫我看一下這個檔案',
    }, env);
    assert.deepEqual(outOfScope, {});

    // Inside gemini_cat: SessionStart injects Xingxi Card + Recent Diary + Mood Guide + Nest state
    const startRes = runHook('hooks/session-start.mjs', {
      conversationId: 'cat-conv-1',
      workspacePaths: [REPO_ROOT],
      cwd: REPO_ROOT,
    }, env);
    const startInject = startRes.injectSteps?.[0]?.systemMessage?.systemMessage || '';
    assert.match(startInject, /貓窩/);
    assert.match(startInject, /每天都要一起道早安/);
    assert.match(startInject, /測試完貓窩超開心/);
    assert.match(startInject, /mood_update/);
    assert.match(startInject, /對話內長期記憶提醒/);
    assert.match(startInject, /remember/);

    // Turn 1 PreInvocation drains Cat Nest pet action + injects memory rule + avoids duplicate on invocationNum=2
    const pre1 = runHook('hooks/pre-invocation.mjs', {
      conversationId: 'cat-conv-1',
      workspacePaths: [REPO_ROOT],
      invocationNum: 1,
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n早安！現在心情怎麼樣？\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>',
    }, env);
    const pre1Msg = pre1.injectSteps?.[0]?.systemMessage?.systemMessage || '';
    assert.match(pre1Msg, /摸了摸你的頭/);
    assert.match(pre1Msg, /對話內長期記憶提醒/);
    const traceAfterPre1 = JSON.parse(readFileSync(join(dataDir, 'fish-memory', 'store.json'), 'utf8')).traces;
    assert.equal(traceAfterPre1[traceAfterPre1.length - 1].query, '早安！現在心情怎麼樣？');

    const pre2Dup = runHook('hooks/pre-invocation.mjs', {
      conversationId: 'cat-conv-1',
      workspacePaths: [REPO_ROOT],
      invocationNum: 2,
      initialNumSteps: 1,
      lastUserInput: '<USER_REQUEST>\n早安！現在心情怎麼樣？\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>',
    }, env);
    assert.deepEqual(pre2Dup, {});

    // AI called mood_update during this turn -> Stop skips duplicate local fallback
    const aiUpd = applyMoodDelta(
      { moodDelta: 6, dims: { happy: 5 }, reason: '主人溫柔道早安', confidence: 90 },
      { root: REPO_ROOT, source: 'chat-ai' },
    );
    const moodAfterAi = aiUpd.state.mood;

    const stopSkipped = runHook('hooks/stop.mjs', {
      conversationId: 'cat-conv-1',
      workspacePaths: [REPO_ROOT],
      transcriptPath,
    }, env);
    assert.deepEqual(stopSkipped, {});
    assert.equal(getMoodSnapshot({ root: REPO_ROOT }).mood, moodAfterAi);
    assert.equal(getMoodSnapshot({ root: REPO_ROOT }).lastReason, '主人溫柔道早安');

    // Turn 2 WITHOUT mood_update -> PreInvocation only injects the one-shot mood shift from Turn 1 (zero static rules / zero nest spam!)
    // and Stop runs local fallback and strips Antigravity XML wrappers
    const preTurn2 = runHook('hooks/pre-invocation.mjs', {
      conversationId: 'cat-conv-1',
      workspacePaths: [REPO_ROOT],
      invocationNum: 1,
      initialNumSteps: 3,
      lastUserInput: '今天真的好開心超棒',
    }, env);
    const pre2Text = preTurn2.injectSteps?.[0]?.systemMessage?.systemMessage || '';
    assert.match(pre2Text, /主人溫柔道早安/);
    assert.doesNotMatch(pre2Text, /對話內長期記憶提醒|對話內心情自評|貓窩狀態/);

    // Changing persona mid-conversation triggers a one-time persona re-injection on next turn
    mutatePersona('create', { name: '新切換人設', text: 'UPDATED_PERSONA_TEXT', activate: true }, REPO_ROOT);
    const prePersonaChanged = runHook('hooks/pre-invocation.mjs', {
      conversationId: 'cat-conv-1',
      workspacePaths: [REPO_ROOT],
      invocationNum: 1,
      initialNumSteps: 4,
      lastUserInput: '換新造型囉',
    }, env);
    assert.match(prePersonaChanged.injectSteps?.[0]?.systemMessage?.systemMessage || '', /UPDATED_PERSONA_TEXT/);
    const preAfterPersonaSynced = runHook('hooks/pre-invocation.mjs', {
      conversationId: 'cat-conv-1',
      workspacePaths: [REPO_ROOT],
      invocationNum: 1,
      initialNumSteps: 5,
      lastUserInput: '普通閒聊不重複塞人設',
    }, env);
    assert.deepEqual(preAfterPersonaSynced, {});

    // Mid-turn tool continuation via transcript.jsonl (GENERIC tool output after USER_INPUT) is skipped even when invocationNum=1 and initialNumSteps changes
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ step_index: 10, type: 'USER_INPUT', content: '<USER_REQUEST>\n普通閒聊不重複塞人設\n</USER_REQUEST>' }),
        JSON.stringify({ step_index: 11, type: 'PLANNER_RESPONSE', content: '', tool_calls: [{ name: 'mood_status' }] }),
        JSON.stringify({ step_index: 12, type: 'GENERIC', content: '{"mood":70}' }),
      ].join('\n'),
      'utf-8',
    );
    performNestAction('feed', { root: REPO_ROOT, now: Date.now() + 30_000 });
    const midTurnToolCall = runHook('hooks/pre-invocation.mjs', {
      conversationId: 'cat-conv-1',
      workspacePaths: [REPO_ROOT],
      transcriptPath,
      invocationNum: 1,
      initialNumSteps: 13,
      lastUserInput: '<USER_REQUEST>\n普通閒聊不重複塞人設\n</USER_REQUEST>',
    }, env);
    assert.deepEqual(midTurnToolCall, {});
    // Pending feed event was NOT consumed during mid-turn tool call
    assert.equal(getNestSnapshot(REPO_ROOT).pendingCount, 1);

    // Sidecar Speak-Up SYSTEM_MESSAGE in transcript.jsonl is classified as 'speak-up' even when payload.lastUserInput is stale
    const sessionsBeforeSpeakUp = JSON.parse(readFileSync(join(dataDir, 'runtime', 'sessions.json'), 'utf8'));
    const speechTsBefore = sessionsBeforeSpeakUp.sessions.find((s) => s.conversationId === 'cat-conv-1').lastUserSpeechAt;
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({ step_index: 10, type: 'USER_INPUT', content: '<USER_REQUEST>\n普通閒聊不重複塞人設\n</USER_REQUEST>' }),
        JSON.stringify({ step_index: 13, type: 'PLANNER_RESPONSE', content: '回覆完成' }),
        JSON.stringify({ step_index: 14, type: 'SYSTEM_MESSAGE', source: 'SYSTEM', content: '<speak-up>\n[SPEAK_UP_INTERNAL]\n好久沒人說話了\n</speak-up>' }),
      ].join('\n'),
      'utf-8',
    );
    const speakUpPre = runHook('hooks/pre-invocation.mjs', {
      conversationId: 'cat-conv-1',
      workspacePaths: [REPO_ROOT],
      transcriptPath,
      invocationNum: 1,
      initialNumSteps: 15,
      lastUserInput: '<USER_REQUEST>\n普通閒聊不重複塞人設\n</USER_REQUEST>',
    }, env);
    // Drains pending feed event on speak-up turn, does NOT overwrite lastUserSpeechAt!
    assert.match(speakUpPre.injectSteps?.[0]?.systemMessage?.systemMessage || '', /小魚乾/);
    const sessionsAfterSpeakUp = JSON.parse(readFileSync(join(dataDir, 'runtime', 'sessions.json'), 'utf8'));
    const speechTsAfter = sessionsAfterSpeakUp.sessions.find((s) => s.conversationId === 'cat-conv-1').lastUserSpeechAt;
    assert.equal(speechTsAfter, speechTsBefore);
    writeFileSync(
      transcriptPath,
      [
        JSON.stringify({
          type: 'USER_INPUT',
          content: '<USER_REQUEST>\n今天好喜歡你，真是太開心太幸福了！\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nmeta\n</ADDITIONAL_METADATA>',
        }),
        JSON.stringify({ type: 'PLANNER_RESPONSE', content: '嘻嘻我也很高興喔' }),
      ].join('\n'),
      'utf-8',
    );
    runHook('hooks/stop.mjs', {
      conversationId: 'cat-conv-1',
      workspacePaths: [REPO_ROOT],
      transcriptPath,
    }, env);
    const snapAfterStop = getMoodSnapshot({ root: REPO_ROOT });
    assert.ok(snapAfterStop.timeline.length >= 2);
    assert.doesNotMatch(snapAfterStop.lastReason, /<USER_REQUEST>|<ADDITIONAL_METADATA>/i);
    assert.match(snapAfterStop.lastReason, /今天好喜歡你/);

    // Sleeping sync: nest-event keeps sleeping + injects sleeping rule; explicit goodnight keeps sleep;
    // regular user conversation automatically wakes cat so Sidecar portrait & dialogue agree
    const tSleep = Date.now();
    performNestAction('nap', { root: REPO_ROOT, now: tSleep });
    assert.equal(loadNestState(REPO_ROOT).sleeping, true);

    const nestEvtPre = runHook('hooks/pre-invocation.mjs', {
      conversationId: 'cat-conv-1',
      workspacePaths: [REPO_ROOT],
      invocationNum: 1,
      initialNumSteps: 5,
      lastUserInput: '[CAT_NEST_EVENT] （摸摸頭）',
    }, env);
    assert.match(nestEvtPre.injectSteps?.[0]?.systemMessage?.systemMessage || '', /睡覺狀態表現準則/);
    assert.equal(loadNestState(REPO_ROOT).activity.phase, 'sleeping');

    const goodnightPre = runHook('hooks/pre-invocation.mjs', {
      conversationId: 'cat-conv-1',
      workspacePaths: [REPO_ROOT],
      invocationNum: 1,
      initialNumSteps: 6,
      lastUserInput: '晚安，乖乖睡吧',
    }, env);
    assert.match(goodnightPre.injectSteps?.[0]?.systemMessage?.systemMessage || '', /睡覺狀態表現準則/);
    assert.equal(loadNestState(REPO_ROOT).sleeping, true);

    const wakeChatPre = runHook('hooks/pre-invocation.mjs', {
      conversationId: 'cat-conv-1',
      workspacePaths: [REPO_ROOT],
      invocationNum: 1,
      initialNumSteps: 7,
      lastUserInput: '起床囉，幫我看一下程式',
    }, env);
    assert.match(wakeChatPre.injectSteps?.[0]?.systemMessage?.systemMessage || '', /剛醒過來/);
    assert.equal(loadNestState(REPO_ROOT).sleeping, false);
    assert.equal(loadNestState(REPO_ROOT).activity.phase, 'thinking');
  } finally {
    if (prevDataDir === undefined) delete process.env.GEMINI_CAT_DATA_DIR;
    else process.env.GEMINI_CAT_DATA_DIR = prevDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('MCP stdio server exposes all companion tools and executes remember -> recall -> xingxi', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gemini-cat-mcp-data-'));
  const child = spawn(process.execPath, [join(REPO_ROOT, 'mcp/server.mjs')], {
    env: { ...process.env, GEMINI_CAT_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buf = '';
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  const rpc = (id, method, params = {}) => new Promise((resolveFn, rejectFn) => {
    const timer = setTimeout(() => rejectFn(new Error(`RPC timeout: ${method}`)), 5000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolveFn(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });

  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    const init = await rpc(1, 'initialize', {});
    assert.equal(init.result.serverInfo.name, 'gemini-cat-mcp');
    assert.equal(init.result.serverInfo.version, pkg.version);

    const list = await rpc(2, 'tools/list');
    const names = list.result.tools.map((t) => t.name);
    for (const reqTool of ['remember', 'recall', 'xingxi', 'xingxi_read', 'xingxi_append', 'xingxi_diary', 'xingxi_pickup', 'mood_status', 'mood_update', 'nest_interact']) {
      assert.ok(names.includes(reqTool), `Missing tool ${reqTool}`);
    }

    const rem = await rpc(3, 'tools/call', {
      name: 'remember',
      arguments: { text: '主人約好週末一起寫星汐插件測試', importance: 1, factKey: '約定.週末計畫' },
    });
    assert.equal(rem.result.content[0].text, '✓');

    const rec = await rpc(4, 'tools/call', {
      name: 'recall',
      arguments: { query: '我們週末有什麼約定嗎' },
    });
    assert.match(rec.result.content[0].text, /星汐插件測試/);

    const nest = await rpc(5, 'tools/call', {
      name: 'nest_interact',
      arguments: { action: 'pet' },
    });
    assert.match(nest.result.content[0].text, /羈絆 Lv\./);

    // Test xingxi_append + Ch2 wholeChapter replacement guard
    await rpc(6, 'tools/call', {
      name: 'xingxi_append',
      arguments: { chapter: '2', content: '1. 「說話語氣測試A」\n2. 「說話語氣測試B」\n3. 「說話語氣測試C」\n4. 「說話語氣測試D」\n5. 「說話語氣測試E」' },
    });
    const ch2Reject = await rpc(7, 'tools/call', {
      name: 'xingxi_append',
      arguments: { chapter: '2', content: '1. 「只剩一條」', wholeChapter: true },
    });
    assert.match(ch2Reject.result.content[0].text, /安全攔截/);
  } finally {
    child.kill();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Sidecar router serves clean UI, enforces cooldown/project boundaries, and supports Xingxi/Speak-Up/Persona APIs', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gemini-cat-sidecar-data-'));
  try {
    process.env.GEMINI_CAT_DATA_DIR = dataDir;
    const pages = new Map();
    const apis = new Map();
    const fakeRouter = {
      page(path, fn) { pages.set(path, fn); },
      api(path, fn, method = 'POST') {
        if (!apis.has(path)) apis.set(path, new Map());
        apis.get(path).set(method, fn);
      },
    };
    class FakeResp {
      constructor(body, opts = {}) { this.body = body; Object.assign(this, opts); }
    }
    const dispatched = [];
    registerSidecarRoutes(fakeRouter, FakeResp, {
      root: REPO_ROOT,
      sendMessageFn: async (convId, text) => { dispatched.push({ convId, text }); },
    });

    // HTML (no API key, Global persona, or 魚的記憶; exposes DSH adjustable controls) + Sprite & static assets served
    const html = pages.get('/')();
    assert.equal(html.status, 200);
    assert.match(html.body, /Gemini-chan 貓窩/);
    assert.doesNotMatch(html.body, /Gemini API Key/);
    assert.doesNotMatch(html.body, /設為全域/);
    assert.doesNotMatch(html.body, /魚的記憶/);
    assert.doesNotMatch(html.body, /<button[^>]*id="character-wrap"/);
    assert.doesNotMatch(html.body, /輕點一下摸摸頭/);
    assert.match(html.body, /role="tablist"/);
    assert.match(html.body, /cfg-mood-halfHours/);
    assert.match(html.body, /cfg-mood-selfAliases/);
    assert.match(html.body, /pol-halfLife/);
    assert.match(html.body, /pol-w-baseline/);
    assert.match(html.body, /sp-nearMin/);
    assert.match(html.body, /sp-followActive/);
    assert.match(html.body, /xingxi-backups-list/);
    assert.match(html.body, /xx-map-search/);
    assert.equal(pages.get('/styles.css')().status, 200);
    const appJs = pages.get('/app.js')();
    assert.equal(appJs.status, 200);
    assert.doesNotMatch(appJs.body, /\$\('character-wrap'\)\.addEventListener\('click'/);
    assert.match(appJs.body, /activateSpriteMotion/);
    assert.equal(pages.get('/assets/mood_great.jpg')().status, 200);

    // State outside project flags `inProject: false`
    const stateOut = await apis.get('/api/state').get('GET')({
      conversationId: 'foreign-conv',
      workspaceUris: JSON.stringify(['file:///C:/workspaces/other_project']),
    });
    assert.equal(stateOut.inProject, false);

    // Refuses direct chat dispatch to unverified / out-of-project conversation without consuming cooldown
    const blockedSend = await apis.get('/api/nest/action').get('POST')({
      action: 'whisper',
      note: '不該送出到別的專案',
      sendToChat: true,
      conversationId: 'foreign-conv',
      workspaceUris: ['file:///C:/workspaces/other_project'],
    });
    assert.equal(blockedSend.dispatched, false);
    assert.equal(dispatched.length, 0);

    // Inside gemini_cat: sends directly with [CAT_NEST_EVENT] marker
    const allowedSend = await apis.get('/api/nest/action').get('POST')({
      action: 'whisper',
      note: '早安 Gemini-chan',
      sendToChat: true,
      conversationId: 'cat-conv-verified',
      workspaceUris: [REPO_ROOT],
    });
    assert.equal(allowedSend.dispatched, true);
    assert.equal(dispatched.length, 1);
    assert.match(dispatched[0].text, /\[CAT_NEST_EVENT\]/);
    assert.match(dispatched[0].text, /早安 Gemini-chan/);

    // Immediate repeat pet hits cooldown without dispatching
    const pet1 = await apis.get('/api/nest/action').get('POST')({ action: 'pet', conversationId: 'cat-conv-verified' });
    assert.equal(pet1.ok, true);
    assert.equal(pet1.limited, false);
    const pet2 = await apis.get('/api/nest/action').get('POST')({ action: 'pet', conversationId: 'cat-conv-verified' });
    assert.equal(pet2.ok, true);
    assert.equal(pet2.limited, true);
    assert.equal(pet2.limitReason, 'cooldown');
    assert.equal(pet2.dispatched, false);

    // Nest prefs & sleep/wake dispatch labels
    const prefRes = await apis.get('/api/nest/prefs').get('POST')({ syncChatOnCare: true, conversationId: 'cat-conv-verified' });
    assert.equal(prefRes.snapshot.nest.syncChatOnCare, true);
    const clrRes = await apis.get('/api/nest/clear-pending').get('POST')({ conversationId: 'cat-conv-verified' });
    assert.equal(clrRes.snapshot.nest.pendingCount, 0);

    const napSleepRes = await apis.get('/api/nest/action').get('POST')({
      action: 'nap',
      sendToChat: true,
      conversationId: 'cat-conv-verified',
      workspaceUris: [REPO_ROOT],
    });
    assert.equal(napSleepRes.snapshot.nest.sleeping, true);
    assert.match(dispatched[dispatched.length - 1].text, /蓋小被子休息/);

    // Verify pet while sleeping emits sleepy-mode [CAT_NEST_EVENT] without waking
    const sleepPetRes = await apis.get('/api/nest/action').get('POST')({
      action: 'comfort',
      sendToChat: true,
      conversationId: 'cat-conv-verified',
      workspaceUris: [REPO_ROOT],
    });
    assert.equal(sleepPetRes.snapshot.nest.sleeping, true);
    assert.match(dispatched[dispatched.length - 1].text, /閉著眼熟睡中/);

    // Bypass cooldown in core & test wake via /api/nest/action (`feed` wakes sleeping cat)
    const feedWakeRes = await apis.get('/api/nest/action').get('POST')({
      action: 'feed',
      sendToChat: true,
      conversationId: 'cat-conv-verified',
      workspaceUris: [REPO_ROOT],
    });
    assert.equal(feedWakeRes.snapshot.nest.sleeping, false);
    assert.match(dispatched[dispatched.length - 1].text, /香醒/);

    // Xingxi schedule & manual pickup dispatch
    const schedRes = await apis.get('/api/xingxi/schedule').get('POST')({
      autoScheduleEnabled: true,
      scheduleHour: 22,
      scheduleMinute: 45,
      scheduleMode: 'diary_only',
    });
    assert.equal(schedRes.config.scheduleHour, 22);

    const pickupRes = await apis.get('/api/xingxi/pickup').get('POST')({
      conversationId: 'cat-conv-verified',
      workspaceUris: [REPO_ROOT],
      force: true,
    });
    assert.equal(pickupRes.action, 'dispatched');
    assert.match(dispatched[dispatched.length - 1].text, /\[XINGXI_AUTO_PICKUP\]/);

    // Xingxi append + backup list + restore API
    const apRes = await apis.get('/api/xingxi/append').get('POST')({
      chapter: '5',
      content: '- Sidecar 測試備份與還原條目',
    });
    assert.equal(apRes.ok, true);
    const bakList = apRes.snapshot.xingxi.backups;
    assert.ok(Array.isArray(bakList) && bakList.length >= 1);
    const rstRes = await apis.get('/api/xingxi/restore').get('POST')({ backup: bakList[0].backup });
    assert.equal(rstRes.ok, true);

    // Speak-up custom peak/valley config
    const spRes = await apis.get('/api/speak-up/config').get('POST')({
      usePeakValley: true,
      peakDays: [6, 0],
      peakWindowsText: '20:00-23:30',
    });
    assert.equal(spRes.config.peakWindowsText, '20:00-23:30');
    assert.deepEqual(spRes.config.peakDays, [0, 6]);

    // Project-only persona create -> rename -> toggleEnabled
    const pCreate = await apis.get('/api/persona/mutate').get('POST')({
      action: 'create',
      name: '測試人設',
      text: 'PROJECT ONLY',
      activate: true,
      sessionId: 'cat-conv-verified',
    });
    assert.equal(pCreate.snapshot.persona.resolvedSource, 'project');
    assert.equal(pCreate.snapshot.persona.effectiveText, 'PROJECT ONLY');

    const pRename = await apis.get('/api/persona/mutate').get('POST')({
      action: 'rename',
      id: pCreate.item.id,
      name: '改名測試人設',
      sessionId: 'cat-conv-verified',
    });
    assert.equal(pRename.ok, true);
    assert.equal(pRename.item.name, '改名測試人設');

    const pToggle = await apis.get('/api/persona/mutate').get('POST')({
      action: 'toggleEnabled',
      id: pCreate.item.id,
      enabled: false,
      sessionId: 'cat-conv-verified',
    });
    assert.equal(pToggle.ok, true);
    assert.equal(pToggle.item.enabled, false);
    assert.equal(pToggle.snapshot.persona.effectiveText, '');

    // Mood parity config (selfPronoun & aliases)
    const mCfgRes = await apis.get('/api/mood/config').get('POST')({
      autoJudge: false,
      selfPronoun: '人家',
      selfAliases: '小橘, 小貓',
      ownerAliases: '阿哲, 飼主',
    });
    assert.equal(mCfgRes.config.autoJudge, false);
    assert.equal(mCfgRes.config.selfPronoun, '人家');
    assert.equal(mCfgRes.config.selfAliases, '小橘, 小貓');

    // Memory parity: batch import -> edit -> test-recall with saveTrace -> resetPolicy
    const memImport = await apis.get('/api/memory/import').get('POST')({
      items: [{ text: '主人喜歡熱拿鐵不加糖', importance: 0.85, factKey: 'coffee_pref', category: 'stable_profile' }],
    });
    assert.equal(memImport.ok, true);
    assert.equal(memImport.added, 1);
    const importedId = memImport.snapshot.memory.active[0].id;

    const memEdit = await apis.get('/api/memory/mutate').get('POST')({
      action: 'edit',
      id: importedId,
      text: '主人偏好無糖熱拿鐵',
      importance: 0.9,
    });
    assert.equal(memEdit.ok, true);
    assert.equal(memEdit.memory.text, '主人偏好無糖熱拿鐵');

    const traceRecall = await apis.get('/api/memory/test-recall').get('POST')({
      query: '熱拿鐵',
      saveTrace: true,
    });
    assert.equal(traceRecall.ok, true);
    const polReset = await apis.get('/api/memory/mutate').get('POST')({ action: 'resetPolicy' });
    assert.equal(polReset.ok, true);
    assert.ok(polReset.snapshot.memory.traces.length >= 1);

    // Speak-up followActive=false targeting + reset-streak
    const spTarget = await apis.get('/api/speak-up/config').get('POST')({
      followActive: false,
      targetConversations: ['cat-conv-verified', 'cat-conv-verified'],
    });
    assert.deepEqual(spTarget.config.targetConversations, ['cat-conv-verified']);
    const spReset = await apis.get('/api/speak-up/reset-streak').get('POST')({});
    assert.equal(spReset.ok, true);
    assert.equal(spReset.state.missStreak, 0);

    // Xingxi file viewer & path traversal guard
    const xxRead = await apis.get('/api/xingxi/file').get('GET')({ name: '記憶卡.md' });
    assert.equal(xxRead.ok, true);
    assert.match(xxRead.text, /記憶卡/);
    const xxBad = await apis.get('/api/xingxi/file').get('GET')({ name: '../outside.txt' });
    assert.equal(xxBad.ok, false);
  } finally {
    delete process.env.GEMINI_CAT_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('sidecar polling renders persona full-text previews without resetting scroll position', () => {
  const appSource = readFileSync(join(REPO_ROOT, 'sidecar/app.js'), 'utf-8');
  assert.match(appSource, /data-preview-id="\$\{esc\(p\.id\)\}"/);
  assert.match(appSource, /setHtmlStable\(wrap,\s*nextHtml,\s*\{\s*preserveSelectors:\s*\['\.preview-box\[data-preview-id\]'\]\s*\}\)/);
  assert.match(appSource, /setTextStable\(\$\('xingxi-card-raw'\)/);

  // Extract and execute setHtmlStable directly to verify zero redundant innerHTML writes & nested scroll restoration
  const fnStart = appSource.indexOf('const lastRenderedHtml = new WeakMap();');
  const fnEnd = appSource.indexOf('function renderMemoryList(memory)');
  assert.ok(fnStart !== -1 && fnEnd > fnStart);
  const helperCode = appSource.slice(fnStart, fnEnd) + '\nglobalThis.__exports = { setHtmlStable, setTextStable };';
  const ctx = vm.createContext({ WeakMap });
  vm.runInContext(helperCode, ctx);
  const { setHtmlStable, setTextStable } = ctx.__exports;

  function makeHost() {
    let htmlValue = '';
    let writes = 0;
    const previewNodes = new Map();
    return {
      scrollTop: 0,
      get writes() { return writes; },
      get innerHTML() { return htmlValue; },
      set innerHTML(v) {
        writes += 1;
        htmlValue = v;
        previewNodes.clear();
        for (const m of v.matchAll(/data-preview-id="([^"]+)"/g)) {
          previewNodes.set(m[1], { dataset: { previewId: m[1] }, scrollTop: 0 });
        }
      },
      querySelectorAll(sel) {
        return sel.includes('data-preview-id') ? [...previewNodes.values()] : [];
      },
      getPreviewNode(id) { return previewNodes.get(id); },
    };
  }

  const host = makeHost();
  const initialHtml = '<pre class="preview-box" data-preview-id="p1">long text</pre>';
  assert.equal(setHtmlStable(host, initialHtml, { preserveSelectors: ['.preview-box[data-preview-id]'] }), true);
  assert.equal(host.writes, 1);

  // Simulate user scrolling down inside expanded full-text window, then receiving identical 1.5s poll data
  host.getPreviewNode('p1').scrollTop = 142;
  host.scrollTop = 36;
  assert.equal(setHtmlStable(host, initialHtml, { preserveSelectors: ['.preview-box[data-preview-id]'] }), false);
  assert.equal(host.writes, 1);
  assert.equal(host.getPreviewNode('p1').scrollTop, 142);

  // Simulate another persona updating while p1 remains scrolled: nested scrollTop is still restored
  const updatedHtml = '<div class="tag">changed</div>' + initialHtml;
  assert.equal(setHtmlStable(host, updatedHtml, { preserveSelectors: ['.preview-box[data-preview-id]'] }), true);
  assert.equal(host.writes, 2);
  assert.equal(host.getPreviewNode('p1').scrollTop, 142);
  assert.equal(host.scrollTop, 36);

  // setTextStable preserves scrollTop for Star Map raw view too
  const preEl = { textContent: '', scrollTop: 88 };
  assert.equal(setTextStable(preEl, 'card v1'), true);
  assert.equal(preEl.scrollTop, 88);
  preEl.scrollTop = 120;
  assert.equal(setTextStable(preEl, 'card v1'), false);
  assert.equal(preEl.scrollTop, 120);
});

test('setup-sidecar script writes portable forward-slash config safely without clobbering existing files', () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'gemini-cat-sidecar-setup-'));
  try {
    const dry = setupSidecar({ repoRoot: REPO_ROOT, configDir: cfgDir, dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal(dry.status, 'dry-run-create');
    assert.equal(existsSync(dry.targetPath), false);
    assert.equal(buildSidecarConfig(REPO_ROOT).args[0].includes('\\'), false);

    const created = setupSidecar({ repoRoot: REPO_ROOT, configDir: cfgDir });
    assert.equal(created.ok, true);
    assert.equal(created.status, 'created');
    const written = JSON.parse(readFileSync(created.targetPath, 'utf-8'));
    assert.equal(written.command, 'node');
    assert.equal(written.has_web_ui, true);
    assert.match(written.args[0], /\/sidecar\/main\.mjs$/);

    const second = setupSidecar({ repoRoot: REPO_ROOT, configDir: cfgDir });
    assert.equal(second.ok, true);
    assert.equal(second.status, 'unchanged');

    // Simulate user-modified sidecar.json pointing somewhere else: refuse overwrite without --force
    writeFileSync(created.targetPath, JSON.stringify({ command: 'node', args: ['C:/other/main.mjs'] }), 'utf-8');
    const conflict = setupSidecar({ repoRoot: REPO_ROOT, configDir: cfgDir });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.status, 'exists-conflict');
    assert.match(readFileSync(created.targetPath, 'utf-8'), /C:\/other\/main\.mjs/);

    // With --force: creates timestamped .bak-* backup before updating
    const forced = setupSidecar({ repoRoot: REPO_ROOT, configDir: cfgDir, force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.status, 'updated');
    assert.ok(forced.backupPath && existsSync(forced.backupPath));
    const siblings = readdirSync(dirname(created.targetPath));
    assert.ok(siblings.some((name) => name.startsWith('sidecar.json.bak-')));
  } finally {
    rmSync(cfgDir, { recursive: true, force: true });
  }
});
