/**
 * @fileoverview Antigravity `PostToolUse` hook for `gemini_cat`.
 * Keeps `transcriptPath` refreshed & mirrors live tool usage onto Cat Nest UI.
 */

import { registerProjectConversation } from '../core/bridge.mjs';
import { loadNestState, setNestActivity } from '../core/nest.mjs';
import { getProjectRoot } from '../core/storage.mjs';
import { ensureInProjectScope, readHookInput, writeHookOutput } from './lib.mjs';

const ROOT = getProjectRoot();

const TOOL_LABELS = {
  remember: '把這件事偷偷寫進記憶小本本…',
  recall: '在記憶湖裡打撈相關回憶…',
  xingxi: '正在翻閱完整的星汐記憶卡…',
  xingxi_read: '正在星汐日記檔案裡翻找片段…',
  xingxi_open: '正在翻開這一頁主題記憶…',
  xingxi_wiki_write: '正在把新的認識仔細寫進主題頁…',
  xingxi_append: '把重要的一筆收進星汐記憶卡…',
  xingxi_diary: '正在補寫今天的星汐日記…',
  xingxi_pickup: '正在整理今日對話原料準備拾星…',
  mood_status: '照照鏡子看現在的心情…',
  mood_update: '把這一刻心裡的真實感受記下來…',
  nest_interact: '在貓窩裡開心地晃著尾巴…',
};

function main() {
  const payload = readHookInput();
  if (!ensureInProjectScope(payload, ROOT)) {
    writeHookOutput({});
    return;
  }

  if (payload.conversationId) {
    registerProjectConversation(
      {
        conversationId: payload.conversationId,
        workspacePaths: payload.workspacePaths,
        cwd: payload.cwd,
        transcriptPath: payload.transcriptPath,
        modelName: payload.modelName,
        sourceKind: 'tool',
      },
      ROOT,
    );
  }

  const rawName = String(payload?.toolCall?.name || '').trim();
  const baseName = rawName.split('/').pop() || rawName;
  const nest = loadNestState(ROOT);
  if (nest.sleeping) {
    if (baseName !== 'nest_interact') {
      setNestActivity({ phase: 'sleeping', label: '在被窩裡迷糊睡著… zzZ', toolName: baseName }, ROOT);
    }
  } else {
    const label = TOOL_LABELS[baseName] || (baseName ? `正在處理工具 ${baseName}…` : '正在忙手邊的事…');
    setNestActivity({ phase: 'tool', label, toolName: baseName }, ROOT);
  }

  writeHookOutput({});
}

main();
