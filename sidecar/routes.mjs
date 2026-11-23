/**
 * @fileoverview Testable HTTP router & static asset server for the `Gemini-chan 貓窩` Sidecar.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getFullStateSnapshot,
  isVerifiedProjectConversation,
  loadRegisteredSessions,
  registerProjectConversation,
} from '../core/bridge.mjs';
import {
  clearFreshBrowseCache,
  refreshFreshFeedNow,
  validateAndPreviewFeed,
} from '../core/fresh-browse.mjs';
import {
  batchRememberMemories,
  mutateMemory,
  recallMemories,
  rememberMemory,
} from '../core/memory.mjs';
import {
  applyMoodDelta,
  loadMoodConfig,
  resetMoodState,
  saveMoodConfig,
} from '../core/mood.mjs';
import {
  clearPendingNestEvents,
  getNestSnapshot,
  performNestAction,
  setNestPreferences,
} from '../core/nest.mjs';
import { mutatePersona } from '../core/persona.mjs';
import {
  executeSpeakUpRoll,
  loadSpeakUpConfig,
  mutateSpeakUpPlan,
  resetSpeakUpStreak,
  resetSpeakUpUnanswered,
  saveSpeakUpConfig,
} from '../core/speak-up.mjs';
import {
  appendTelegramLog,
  generateTelegramPairCode,
  loadTelegramConfig,
  parseChatIdSet,
  saveTelegramConfig,
  syncTelegramHistoryFromTranscript,
  telegramGetMe,
  telegramSendText,
  updateTelegramStateLocked,
} from '../core/telegram.mjs';
import {
  canonicalSessionKey,
  getDataPaths,
  getProjectRoot,
  isProjectWorkspaceActive,
  statMtimeMs,
} from '../core/storage.mjs';
import {
  appendDiary,
  appendToChapter,
  executeXingxiPickup,
  readXingxiArchiveFile,
  replaceChapterTwo,
  restoreXingxiBackup,
  saveXingxiConfig,
} from '../core/xingxi.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
};

function parseWorkspaceUrisParam(raw) {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return [raw]; }
  }
  return Array.isArray(raw) ? raw : [];
}

function computeDataVersionToken(root, convId, inProject) {
  const p = getDataPaths(root);
  const dirs = [
    p.runtimeDir,
    p.nestDir,
    p.moodDir,
    p.personaDir,
    p.memoryDir,
    p.speakUpDir,
    p.telegramDir,
    join(p.telegramDir, 'outbox'),
    p.xingxiDir,
    join(p.xingxiDir, 'diary'),
  ];
  let maxMtime = 0;
  let totalEntries = 0;
  for (const dir of dirs) {
    const dirM = statMtimeMs(dir);
    if (dirM > maxMtime) maxMtime = dirM;
    try {
      const names = readdirSync(dir);
      totalEntries += names.length;
      for (const name of names) {
        if (!name.endsWith('.json') && !name.endsWith('.md')) continue;
        const m = statMtimeMs(join(dir, name));
        if (m > maxMtime) maxMtime = m;
      }
    } catch {
      // Directory may not exist yet
    }
  }
  const bucket = Math.floor(Date.now() / 30_000);
  return `${Math.round(maxMtime)}:${totalEntries}:${bucket}:${inProject === null ? 'n' : (inProject ? '1' : '0')}:${convId}`;
}

/**
 * Registers static pages and JSON APIs onto any `SidecarApp`-compatible router (`page`, `api`).
 * `sendMessageFn(conversationId, text)` may be injected by SidecarApp or mocked in tests.
 */
export function registerSidecarRoutes(
  router,
  ResponseClass,
  { root = getProjectRoot(), sendMessageFn = null, freshBrowseFetchFn = fetch } = {},
) {
  const serveStatic = (filePath, contentType) => () => {
    if (!existsSync(filePath)) {
      return new ResponseClass('Not found', { status: 404, contentType: 'text/plain; charset=utf-8' });
    }
    const body = contentType.startsWith('text/') || contentType.includes('javascript')
      ? readFileSync(filePath, { encoding: 'utf-8' })
      : readFileSync(filePath);
    return new ResponseClass(body, {
      status: 200,
      contentType,
      headers: { 'Cache-Control': 'no-store' },
    });
  };

  router.page('/', serveStatic(join(__dirname, 'index.html'), MIME['.html']));
  router.page('/styles.css', serveStatic(join(__dirname, 'styles.css'), MIME['.css']));
  router.page('/app.js', serveStatic(join(__dirname, 'app.js'), MIME['.js']));

  const { assetsDir } = getDataPaths(root);
  const spriteFiles = [
    'chibi_base.png',
    'mood_great.jpg',
    'mood_ok.jpg',
    'mood_worry.jpg',
    'mood_sad.jpg',
    'mood_sleep.jpg',
    'ref_sheet.jpg',
  ];
  for (const name of spriteFiles) {
    const ext = extname(name).toLowerCase();
    router.page(`/assets/${name}`, serveStatic(join(assetsDir, name), MIME[ext] || 'application/octet-stream'));
  }

  // Lightweight change-detection check for conditional polling
  router.api('/api/version', (data = {}) => {
    const workspaceUris = parseWorkspaceUrisParam(data.workspaceUris);
    const convId = String(data.conversationId || '');
    const inProject = workspaceUris.length === 0
      ? null
      : isProjectWorkspaceActive(workspaceUris, '', root);
    return {
      ok: true,
      inProject,
      version: computeDataVersionToken(root, convId, inProject),
    };
  }, 'GET');

  // Heartbeat / state poll (strictly read-only; session writes occur on POST /api/context or hooks)
  router.api('/api/state', (data = {}) => {
    const workspaceUris = parseWorkspaceUrisParam(data.workspaceUris);
    const convId = String(data.conversationId || '');
    const inProject = workspaceUris.length === 0
      ? null // Standalone/unknown client context
      : isProjectWorkspaceActive(workspaceUris, '', root);

    const snapshot = getFullStateSnapshot({ root, sessionId: convId });
    return {
      ok: true,
      inProject,
      ...snapshot,
    };
  }, 'GET');

  // Register workspace focus explicitly via POST (for frontend workspace-change listener)
  router.api('/api/context', (data = {}) => {
    const workspaceUris = Array.isArray(data.workspaceUris) ? data.workspaceUris : [];
    const convId = String(data.conversationId || '');
    const inProject = isProjectWorkspaceActive(workspaceUris, data.cwd || '', root);
    if (inProject && convId) {
      registerProjectConversation(
        { conversationId: convId, workspacePaths: workspaceUris, sourceKind: 'sidecar' },
        root,
      );
    }
    return { ok: true, inProject, snapshot: getFullStateSnapshot({ root, sessionId: convId }) };
  }, 'POST');

  // Cat Nest interactions + optional direct chat delivery
  router.api('/api/nest/action', async (data = {}) => {
    const action = String(data.action || '').trim();
    const sessionId = String(data.conversationId || '');
    if (data.sendToChat === true && sessionId) {
      const preVerified = isVerifiedProjectConversation(sessionId, root)
        || isProjectWorkspaceActive(data.workspaceUris || [], '', root);
      if (!preVerified) {
        return {
          ok: false,
          dispatched: false,
          dispatchError: '安全鎖定：僅允許傳送至 gemini_cat 專案對話。',
          snapshot: getFullStateSnapshot({ root, sessionId }),
        };
      }
    }
    const res = performNestAction(action, { note: data.note || '', root });
    if (!res.ok || res.limited) {
      const snap = getFullStateSnapshot({ root, sessionId });
      return {
        ...res,
        dispatched: false,
        dispatchError: res.reaction || res.error || '',
        snapshot: snap,
      };
    }

    let dispatched = false;
    let dispatchError = '';
    const shouldSend = data.sendToChat === true
      || (data.sendToChat !== false && action !== 'whisper' && Boolean(res.state?.syncChatOnCare));
    if (shouldSend && typeof sendMessageFn === 'function') {
      const targetId = sessionId;
      const verified = isVerifiedProjectConversation(targetId, root)
        || isProjectWorkspaceActive(data.workspaceUris || [], '', root);
      if (!targetId) {
        dispatchError = '找不到目前對話 ID，互動已暫存於下一輪註入。';
      } else if (!verified) {
        dispatchError = '安全鎖定：僅允許傳送至 gemini_cat 專案對話。';
      } else {
        try {
          const actionLabel = res.state.history[res.state.history.length - 1]?.label || action;
          let msg;
          if (action === 'whisper' && data.note) {
            msg = res.state?.sleeping
              ? `[CAT_NEST_EVENT] （你目前還在軟墊上睡覺、還沒被叫醒，主人趁你打盹把一張小紙條壓在你枕邊並推了你一下：「${String(data.note).trim()}」；請只用半夢半醒、含糊困倦的一兩句夢囈簡短回應，不要寫 *動作* 或 （動作旁白）～）`
              : `[CAT_NEST_EVENT] （主人在側邊欄貓窩遞來一張小紙條，並點擊了直接傳送）「${String(data.note).trim()}」`;
          } else if (action === 'nap' && res.state?.sleeping) {
            msg = '[CAT_NEST_EVENT] （主人在側邊欄貓窩替你「蓋小被子休息」，你現在正閉上眼睛準備入睡；只用一句短短帶著濃厚睡意的晚安或咕噥回應，不要打開新話題，也不要寫 *動作* 或 （動作旁白），說完就會睡著～）';
          } else if (action === 'nap' && !res.state?.sleeping) {
            msg = '[CAT_NEST_EVENT] （主人在側邊欄貓窩輕輕拍了拍你，把正在打盹的你「叫醒」了；你剛剛才睜開眼睛醒過來，請直接用自然口語回應主人，不要寫 *動作* 或 （動作旁白）～）';
          } else if (action === 'feed' && res.wokeFromSleep) {
            msg = '[CAT_NEST_EVENT] （原本還在軟墊打盹的你，被主人在側邊欄遞來的「小魚乾」香味香醒並一口吃掉了；請以剛被美食叫醒的自然口語回應主人，不要寫 *動作* 或 （動作旁白）～）';
          } else if (res.state?.sleeping) {
            msg = `[CAT_NEST_EVENT] （你此刻正在貓窩軟墊上閉著眼熟睡中、還沒被叫醒，主人在側邊欄輕輕對你進行了「${actionLabel}」互動；請務必以半夢半醒、帶著濃濃睡意的小聲夢囈簡短應一兩句就好，切勿表現得像已經完全清醒，也不要寫 *動作* 或 （動作旁白）～）`;
          } else {
            msg = `[CAT_NEST_EVENT] （主人在側邊欄貓窩點了「${actionLabel}」陪你一下，順著當下氣氛自然應一兩句就好～）`;
          }
          await sendMessageFn(targetId, msg);
          dispatched = true;
        } catch (err) {
          dispatchError = err?.message || String(err);
        }
      }
    }

    const snap = getFullStateSnapshot({ root, sessionId });
    return { ok: true, ...res, dispatched, dispatchError, snapshot: snap };
  }, 'POST');

  router.api('/api/nest/prefs', (data = {}) => {
    const sessionId = String(data.conversationId || '');
    const res = setNestPreferences({ syncChatOnCare: data.syncChatOnCare }, root);
    return { ...res, snapshot: getFullStateSnapshot({ root, sessionId }) };
  }, 'POST');

  router.api('/api/nest/clear-pending', (data = {}) => {
    const sessionId = String(data.conversationId || '');
    const res = clearPendingNestEvents(root);
    return { ...res, snapshot: getFullStateSnapshot({ root, sessionId }) };
  }, 'POST');

  // Mood endpoints
  router.api('/api/mood/config', (data = {}) => {
    const cfg = saveMoodConfig(data, root);
    const snap = getFullStateSnapshot({ root, sessionId: data.conversationId || '' });
    return { ok: true, config: cfg, snapshot: snap };
  }, 'POST');

  router.api('/api/mood/delta', (data = {}) => {
    const res = applyMoodDelta(data, { root, source: data.source || 'manual', bypassDivisor: Boolean(data.bypassDivisor) });
    return { ok: true, ...res, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  router.api('/api/mood/reset', () => {
    const s = resetMoodState({ root });
    return { ok: true, state: s, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  // Fish Memory endpoints
  router.api('/api/memory/remember', (data = {}) => {
    const res = rememberMemory(data, { root, bypassQuota: Boolean(data.bypassQuota) });
    return { ...res, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  router.api('/api/memory/import', (data = {}) => {
    const res = batchRememberMemories(data.items, { root, bypassQuota: Boolean(data.bypassQuota ?? true) });
    return { ...res, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  router.api('/api/memory/mutate', (data = {}) => {
    const res = mutateMemory(data.action, data, root);
    return { ...res, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  router.api('/api/memory/test-recall', (data = {}) => {
    const query = String(data.query || '').trim();
    if (!query) return { ok: false, error: '請輸入測試問句' };
    const result = recallMemories(query, { root, saveTrace: Boolean(data.saveTrace) });
    return {
      ok: true,
      rendered: result.rendered,
      gate: result.gate,
      selectedCount: result.selected.length,
      rows: (result.scored || []).slice(0, 15).map((r) => ({
        id: r.m.id,
        text: r.m.text,
        factKey: r.m.factKey || '',
        C: Number(r.s.C.toFixed(3)),
        A: Number(r.s.A.toFixed(3)),
        P: Number(r.s.P.toFixed(3)),
        omission: r.omission || (r.nearMiss ? 'near_miss' : 'selected'),
      })),
    };
  }, 'POST');

  router.api('/api/memory/policy', (data = {}) => {
    const res = mutateMemory('updatePolicy', { policy: data }, root);
    return { ...res, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  // Xingxi endpoints
  router.api('/api/xingxi/append', (data = {}) => {
    const res = appendToChapter(data.chapter, data.content, root);
    return { ...res, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  router.api('/api/xingxi/replace-ch2', (data = {}) => {
    const res = replaceChapterTwo(data.content, root);
    return { ...res, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  router.api('/api/xingxi/diary', (data = {}) => {
    const res = appendDiary({ date: data.date, entry: data.entry }, root);
    return { ...res, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  router.api('/api/xingxi/restore', (data = {}) => {
    const res = restoreXingxiBackup(data.backup, root);
    return { ...res, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  router.api('/api/xingxi/file', (data = {}) => {
    return readXingxiArchiveFile(data.name, root);
  }, 'GET');

  router.api('/api/xingxi/schedule', (data = {}) => {
    const cfg = saveXingxiConfig(data, root);
    const sessionId = String(data.conversationId || '');
    return { ok: true, config: cfg, snapshot: getFullStateSnapshot({ root, sessionId }) };
  }, 'POST');

  router.api('/api/xingxi/pickup', async (data = {}) => {
    const sessionId = String(data.conversationId || '');
    const snapBefore = getFullStateSnapshot({ root, sessionId });
    const candidateId = String(
      sessionId
      || snapBefore.activeConversationId
      || snapBefore.verifiedConversations[0]?.conversationId
      || '',
    );
    const verified = Boolean(candidateId) && (
      isVerifiedProjectConversation(candidateId, root)
      || isProjectWorkspaceActive(data.workspaceUris || [], '', root)
    );
    const targetConvId = verified ? candidateId : '';
    const sender = verified && typeof sendMessageFn === 'function' ? sendMessageFn : null;
    const res = await executeXingxiPickup({
      root,
      trigger: 'manual',
      scheduleMode: data.mode || data.scheduleMode,
      date: data.date,
      now: new Date(),
      targetConvId,
      sender,
      force: data.force !== false,
    });
    return { ...res, snapshot: getFullStateSnapshot({ root, sessionId }) };
  }, 'POST');

  // Persona endpoints
  router.api('/api/persona/mutate', (data = {}) => {
    const sessionId = String(data.sessionId || data.conversationId || '');
    const res = mutatePersona(data.action, { ...data, sessionId }, root);
    return { ...res, snapshot: getFullStateSnapshot({ root, sessionId }) };
  }, 'POST');

  // Speak-Up endpoints
  router.api('/api/speak-up/config', (data = {}) => {
    const cfg = saveSpeakUpConfig(data, root);
    return { ok: true, config: cfg, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  router.api('/api/speak-up/plan', (data = {}) => {
    const action = String(data.action || 'list').trim();
    const res = mutateSpeakUpPlan(action, data, root);
    return { ...res, snapshot: getFullStateSnapshot({ root, sessionId: String(data.conversationId || '') }) };
  }, 'POST');

  router.api('/api/speak-up/reset-streak', () => {
    const st = resetSpeakUpStreak(root);
    return { ok: true, state: st, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  router.api('/api/speak-up/reset-unanswered', () => {
    const st = resetSpeakUpUnanswered(root);
    return { ok: true, state: st, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  router.api('/api/speak-up/roll', async (data = {}) => {
    const mode = ['auto', 'dry', 'send'].includes(data.mode) ? data.mode : 'dry';
    const spCfg = loadSpeakUpConfig(root);
    const snapBefore = getFullStateSnapshot({ root, sessionId: data.conversationId || '' });
    let verifiedTarget = null;
    if (spCfg.followActive) {
      verifiedTarget = snapBefore.verifiedConversations.find(
        (c) => !data.conversationId || c.conversationId === data.conversationId,
      ) || snapBefore.verifiedConversations[snapBefore.verifiedConversations.length - 1];
    } else if (spCfg.targetConversations.length) {
      const pool = snapBefore.verifiedConversations.filter((c) => spCfg.targetConversations.includes(c.conversationId));
      verifiedTarget = pool.find((c) => data.conversationId && c.conversationId === data.conversationId) || pool[0] || null;
    }

    const targetConvId = verifiedTarget?.conversationId || '';
    const lastSpeechAt = verifiedTarget?.lastUserSpeechAt || 0;

    const result = await executeSpeakUpRoll({
      root,
      mode,
      targetConvId,
      lastUserSpeechAt: lastSpeechAt,
      sender: typeof sendMessageFn === 'function' && targetConvId ? sendMessageFn : null,
    });
    return { ok: true, result, snapshot: getFullStateSnapshot({ root, sessionId: targetConvId }) };
  }, 'POST');

  router.api('/api/speak-up/fresh/refresh', async () => {
    const spCfg = loadSpeakUpConfig(root);
    const res = await refreshFreshFeedNow({
      root,
      config: spCfg.freshBrowse,
      timezone: spCfg.timezone,
      slotName: 'manual',
      fetchFn: freshBrowseFetchFn,
    });
    if (res?.resolvedWeatherCoords && !spCfg.freshBrowse?.weatherResolvedCity) {
      saveSpeakUpConfig(
        {
          freshBrowse: {
            weatherLat: res.resolvedWeatherCoords.lat,
            weatherLon: res.resolvedWeatherCoords.lon,
            weatherResolvedCity: res.resolvedWeatherCoords.city,
          },
        },
        root,
      );
    }
    return {
      ok: Boolean(res?.ok),
      fetchedCount: Number(res?.fetchedCount || 0),
      addedCount: Number(res?.addedCount || 0),
      itemsCount: Number(res?.itemsCount || 0),
      error: String(res?.error || ''),
      snapshot: getFullStateSnapshot({ root }),
    };
  }, 'POST');

  router.api('/api/speak-up/fresh/test-feed', async (data = {}) => {
    const rawUrl = String(data.url || '').trim();
    const customLabel = String(data.label || '').trim();
    const preview = await validateAndPreviewFeed(rawUrl, { fetchFn: freshBrowseFetchFn });
    if (!preview.ok) {
      return { ok: false, error: preview.error || '無法解析此來源' };
    }
    if (data.add) {
      const spCfg = loadSpeakUpConfig(root);
      const curList = Array.isArray(spCfg.freshBrowse?.customFeeds) ? spCfg.freshBrowse.customFeeds : [];
      const nextList = [
        ...curList.filter((f) => f.url !== preview.url),
        {
          id: `feed-${Date.now().toString(36)}`,
          label: customLabel || preview.label,
          url: preview.url,
          enabled: true,
        },
      ];
      saveSpeakUpConfig({ freshBrowse: { customFeeds: nextList } }, root);
    }
    return {
      ok: true,
      preview,
      snapshot: getFullStateSnapshot({ root }),
    };
  }, 'POST');

  router.api('/api/speak-up/fresh/clear', (data = {}) => {
    clearFreshBrowseCache(root, { clearSeen: Boolean(data.clearSeen) });
    return { ok: true, snapshot: getFullStateSnapshot({ root }) };
  }, 'POST');

  // Telegram Bridge endpoints
  router.api('/api/telegram/config', (data = {}) => {
    saveTelegramConfig(data, root);
    const snap = getFullStateSnapshot({ root, sessionId: String(data.conversationId || '') });
    return { ok: true, telegram: snap.telegram, snapshot: snap };
  }, 'POST');

  router.api('/api/telegram/pair-code', (data = {}) => {
    const pair = generateTelegramPairCode(root);
    const snap = getFullStateSnapshot({ root, sessionId: String(data.conversationId || '') });
    return { ok: !pair.blocked, ...pair, snapshot: snap };
  }, 'POST');

  router.api('/api/telegram/test', async (data = {}) => {
    const cfg = loadTelegramConfig(root);
    const token = (typeof data.botToken === 'string' && data.botToken.trim()) ? data.botToken.trim() : cfg.botToken;
    if (!token) {
      return { ok: false, error: '尚未設定 Telegram Bot Token', snapshot: getFullStateSnapshot({ root }) };
    }
    const me = await telegramGetMe(token);
    if (!me.ok || !me.result) {
      updateTelegramStateLocked(root, (stErr) => {
        appendTelegramLog(stErr, `連線測試失敗：${me.description || '無效的 Bot Token'}`, Date.now(), token);
      });
      return {
        ok: false,
        error: me.description || 'Telegram getMe 失敗',
        snapshot: getFullStateSnapshot({ root }),
      };
    }

    updateTelegramStateLocked(root, (st) => {
      st.botUsername = me.result.username || '';
      st.botDisplayName = me.result.first_name || '';
      appendTelegramLog(st, `Bot 驗證成功：@${st.botUsername || st.botDisplayName}`, Date.now(), token);
    });

    let sent = false;
    let sendError = '';
    if (data.sendTest) {
      if (data.filePath) {
        sendError = '安全限制：測試端點僅支援純文字連線測試，禁止指定本機檔案路徑';
      } else {
        const boundSet = parseChatIdSet(cfg.allowedChatId);
        const requestedChatId = String(data.chatId || '').split(/[\s,，;]+/).map((s) => s.trim()).filter(Boolean)[0] || '';
        const fallbackBoundId = [...boundSet][0] || '';
        const chatId = requestedChatId || fallbackBoundId;

        if (!chatId) {
          sendError = '尚未綁定允許的 Chat ID，請先產生配對碼或填入 Chat ID';
        } else if (cfg.lockSingleChat !== false && boundSet.size > 0 && !boundSet.has(chatId)) {
          sendError = '安全鎖定：已鎖定單一帳號，測試訊息僅能傳送至已綁定之 Chat ID';
        } else {
          const tRes = await telegramSendText(
            token,
            chatId,
            data.text || '喵～這是一則來自電腦端「Gemini-chan 貓窩」的 Telegram 連線測試訊息！',
          );
          sent = tRes.ok;
          sendError = tRes.error || '';
        }
      }
    }

    return {
      ok: data.sendTest ? sent : true,
      bot: { username: me.result.username || '', firstName: me.result.first_name || '' },
      sent,
      error: sendError,
      snapshot: getFullStateSnapshot({ root }),
    };
  }, 'POST');

  router.api('/api/telegram/sync-history', (data = {}) => {
    const sessionsData = getFullStateSnapshot({ root, sessionId: String(data.conversationId || '') });
    const targetSid = String(data.conversationId || sessionsData.activeConversationId || '');
    const reg = loadRegisteredSessions(root);
    const targetKey = canonicalSessionKey(targetSid);
    const matched = targetKey
      ? reg.sessions.find((s) => canonicalSessionKey(s.conversationId) === targetKey)
      : null;
    const res = syncTelegramHistoryFromTranscript(root, matched?.transcriptPath || '');
    return { ...res, snapshot: getFullStateSnapshot({ root, sessionId: targetSid }) };
  }, 'POST');
}
