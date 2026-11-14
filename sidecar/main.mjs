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
import { decayMoodState, loadMoodConfig, loadMoodState, saveMoodState } from '../core/mood.mjs';
import { executeSpeakUpRoll, loadSpeakUpConfig, loadSpeakUpState } from '../core/speak-up.mjs';
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
      // Passive mood decay refresh
      const nowMs = Date.now();
      const moodCfg = loadMoodConfig(ROOT);
      const moodState = loadMoodState({ root: ROOT, persist: false });
      decayMoodState(moodState, moodCfg.moodBase, nowMs, moodCfg.decayHalfHours);
      saveMoodState(moodState, { root: ROOT });

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

      // Check Speak-Up interval
      if (!spCfg.enabled) return;
      const spState = loadSpeakUpState(ROOT);
      const intervalMs = Math.max(1, spCfg.intervalMinutes) * 60000;
      if (spState.lastTickAt > 0 && nowMs - spState.lastTickAt < intervalMs) {
        return;
      }

      if (!targetEntry) return;

      await executeSpeakUpRoll({
        root: ROOT,
        mode: 'auto',
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

  app.run();
  appendLogLine(LOG_PATH, 'Gemini-chan Cat Nest Sidecar started');
}

start().catch((err) => {
  appendLogLine(LOG_PATH, `Sidecar startup fatal: ${err?.stack || err?.message || err}`);
  console.error(err);
  process.exit(1);
});
