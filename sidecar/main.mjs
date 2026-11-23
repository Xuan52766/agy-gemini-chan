/**
 * @fileoverview Background entry point for the `Gemini-chan 貓窩` Antigravity Sidecar.
 *
 * Hosts:
 * - Web UI & API server via `sidecar_sdk` `SidecarApp`
 * - Background `dsh-speak-up` periodic dice ticker (strictly restricted to verified
 *   `gemini_cat` conversations)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getFullStateSnapshot } from '../core/bridge.mjs';
import { maybeRefreshFreshFeed } from '../core/fresh-browse.mjs';
import { loadMoodState } from '../core/mood.mjs';
import { executeSpeakUpTick, loadSpeakUpConfig, saveSpeakUpConfig } from '../core/speak-up.mjs';
import {
  flushTelegramOutbox,
  loadTelegramConfig,
  pollTelegramOnce,
  touchTelegramSidecarAlive,
} from '../core/telegram.mjs';
import { appendLogLine, getDataPaths, getProjectRoot } from '../core/storage.mjs';
import { ensureXingxiArchive, executeXingxiPickup } from '../core/xingxi.mjs';
import { registerSidecarRoutes } from './routes.mjs';

async function loadSidecarSdk() {
  try {
    return await import('sidecar_sdk');
  } catch {
    const sdkPath =
      process.env.SIDECAR_SDK_PATH ||
      join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'index.mjs');
    const fallbackUrl = pathToFileURL(sdkPath).href;
    return await import(fallbackUrl);
  }
}

const ROOT = getProjectRoot();
const LOG_PATH = `${getDataPaths(ROOT).runtimeDir}/sidecar.log`;

async function start() {
  ensureXingxiArchive(ROOT);
  const { SidecarApp, Response } = await loadSidecarSdk();
  const app = new SidecarApp();

  const sendToConversation = async (conversationId, text) => {
    appendLogLine(LOG_PATH, `Sending message to gemini_cat conversation ${conversationId.slice(-8)}`);
    return app.sendMessage(conversationId, text);
  };

  registerSidecarRoutes(app, Response, { root: ROOT, sendMessageFn: sendToConversation });

  // Background Speak-Up + Mood passive decay scheduler (runs safely every 60s)
  const tickTimer = setInterval(async () => {
    try {
      // Passive mood decay refresh (locked read-decay-write inside loadMoodState)
      const nowMs = Date.now();
      loadMoodState({ root: ROOT, now: nowMs, persist: true });

      const spCfg = loadSpeakUpConfig(ROOT);
      const snap = getFullStateSnapshot({ root: ROOT, now: nowMs });
      const activeEntry = snap.verifiedConversations.find((c) => c.conversationId === snap.activeConversationId)
        || snap.verifiedConversations[snap.verifiedConversations.length - 1]
        || null;

      let targetEntry = null;
      if (spCfg.followActive) {
        targetEntry = activeEntry;
      } else if (spCfg.targetConversations.length) {
        const picked = snap.verifiedConversations.filter((c) => spCfg.targetConversations.includes(c.conversationId));
        targetEntry = picked.length ? picked[Math.floor(Math.random() * picked.length)] : null;
      }

      // Scheduled Xingxi pickup & diary archival (independent of Speak-Up enabled toggle)
      const xingxiTarget = activeEntry || targetEntry;
      await executeXingxiPickup({
        root: ROOT,
        trigger: 'scheduled',
        now: new Date(nowMs),
        targetConvId: xingxiTarget?.conversationId || '',
        sender: sendToConversation,
      });

      // Background fresh-browse refresh (at most twice/day inside configured windows, opt-in only)
      if (spCfg.enabled && spCfg.freshBrowse?.enabled) {
        try {
          const fbRes = await maybeRefreshFreshFeed({
            root: ROOT,
            config: spCfg.freshBrowse,
            timezone: spCfg.timezone,
            nowMs,
          });
          if (fbRes?.resolvedWeatherCoords && !spCfg.freshBrowse.weatherResolvedCity) {
            saveSpeakUpConfig(
              {
                freshBrowse: {
                  weatherLat: fbRes.resolvedWeatherCoords.lat,
                  weatherLon: fbRes.resolvedWeatherCoords.lon,
                  weatherResolvedCity: fbRes.resolvedWeatherCoords.city,
                },
              },
              ROOT,
            );
          }
        } catch (err) {
          appendLogLine(LOG_PATH, `Fresh browse refresh error: ${err?.message || err}`);
        }
      }

      // Check Speak-Up (AI-scheduled plans & jittered routines checked every 60s; dice fallback obeys intervalMinutes)
      if (!spCfg.enabled || !targetEntry) return;

      await executeSpeakUpTick({
        root: ROOT,
        now: new Date(nowMs),
        lastUserSpeechAt: targetEntry.lastUserSpeechAt || 0,
        targetConvId: targetEntry.conversationId,
        sender: sendToConversation,
      });
    } catch (err) {
      appendLogLine(LOG_PATH, `Scheduler tick error: ${err?.message || err}`);
    }
  }, 60000);
  tickTimer.unref?.();

  // Fast outbox worker & heartbeat (flushes queued Telegram replies within ~1.5s, zero network when idle)
  let lastHeartbeatAt = 0;
  const outboxTimer = setInterval(async () => {
    try {
      const nowMs = Date.now();
      if (nowMs - lastHeartbeatAt >= 10_000) {
        touchTelegramSidecarAlive(ROOT, nowMs);
        lastHeartbeatAt = nowMs;
      }
      await flushTelegramOutbox(ROOT, { now: nowMs });
    } catch (err) {
      appendLogLine(LOG_PATH, `Telegram outbox error: ${err?.message || err}`);
    }
  }, 1500);
  outboxTimer.unref?.();

  // Sequential Telegram Long-Polling loop (no concurrent overlapping getUpdates calls)
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const dispatchTelegramTurn = async (formattedText) => {
    const tgCfg = loadTelegramConfig(ROOT);
    const snap = getFullStateSnapshot({ root: ROOT });
    let targetId = '';
    if (!tgCfg.followActive && tgCfg.targetConversationId) {
      const found = snap.verifiedConversations.find((c) => c.conversationId === tgCfg.targetConversationId);
      if (!found) throw new Error('指定的目標 gemini_cat 對話尚未在線或無效');
      targetId = found.conversationId;
    } else {
      const activeEntry = snap.verifiedConversations.find((c) => c.conversationId === snap.activeConversationId)
        || snap.verifiedConversations[snap.verifiedConversations.length - 1]
        || null;
      targetId = activeEntry?.conversationId || '';
    }

    if (!targetId) {
      if (tgCfg.followActive && typeof app.startConversation === 'function') {
        appendLogLine(LOG_PATH, 'No existing gemini_cat session; starting new conversation for Telegram message');
        return app.startConversation(formattedText, { model: 'flash' });
      }
      throw new Error('找不到線上 gemini_cat 對話，請先在 Antigravity 開啟專案對話');
    }

    try {
      return await sendToConversation(targetId, formattedText);
    } catch (err) {
      // Single retry after brief pause if Antigravity was finishing a turn
      await sleepMs(2000);
      return sendToConversation(targetId, formattedText);
    }
  };

  (async function runTelegramPollLoop() {
    touchTelegramSidecarAlive(ROOT);
    let backoffMs = 2000;
    while (true) {
      try {
        const tgCfg = loadTelegramConfig(ROOT);
        if (!tgCfg.enabled || !tgCfg.botToken || !tgCfg.receiveEnabled) {
          backoffMs = 2000;
          await sleepMs(2000);
          continue;
        }
        const pollRes = await pollTelegramOnce(ROOT, {
          timeoutSec: 20,
          dispatchToConversation: dispatchTelegramTurn,
        });
        if (pollRes?.ok) {
          backoffMs = 2000;
          await sleepMs(300);
        } else {
          await sleepMs(backoffMs);
          backoffMs = Math.min(30_000, Math.round(backoffMs * 1.8));
        }
      } catch (err) {
        appendLogLine(LOG_PATH, `Telegram poll loop error: ${err?.message || err}`);
        await sleepMs(backoffMs);
        backoffMs = Math.min(30_000, Math.round(backoffMs * 1.8));
      }
    }
  })();

  app.run();
  appendLogLine(LOG_PATH, 'Gemini-chan Cat Nest Sidecar started');
}

start().catch((err) => {
  appendLogLine(LOG_PATH, `Sidecar startup fatal: ${err?.stack || err?.message || err}`);
  console.error(err);
  process.exit(1);
});
