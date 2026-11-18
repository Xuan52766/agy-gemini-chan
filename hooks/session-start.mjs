/**
 * @fileoverview Antigravity `SessionStart` hook for `gemini_cat`.
 * Strictly scoped to the `gemini_cat` project workspace.
 *
 * Antigravity 2.0 does NOT insert `SessionStart` `injectSteps` into conversation
 * transcripts, so this hook initializes archives, registers the project session
 * without pre-marking startup flags, and updates Cat Nest activity, while Turn-1
 * `PreInvocation` performs the guaranteed startup injection (Persona, Xingxi card,
 * recent 3-day diaries, mood guide, and in-chat rules).
 */

import { registerProjectConversation } from '../core/bridge.mjs';
import { getMoodSnapshot } from '../core/mood.mjs';
import { getNestSnapshot, setNestActivity } from '../core/nest.mjs';
import { appendLogLine, getDataPaths, getProjectRoot } from '../core/storage.mjs';
import { ensureXingxiArchive } from '../core/xingxi.mjs';
import { ensureInProjectScope, readHookInput, writeHookOutput } from './lib.mjs';

const ROOT = getProjectRoot();
const LOG = `${getDataPaths(ROOT).runtimeDir}/hooks.log`;

function main() {
  const payload = readHookInput();
  if (!ensureInProjectScope(payload, ROOT)) {
    writeHookOutput({});
    return;
  }

  ensureXingxiArchive(ROOT);
  const sid = payload.conversationId || '';

  registerProjectConversation(
    {
      conversationId: sid,
      workspacePaths: payload.workspacePaths,
      cwd: payload.cwd,
      transcriptPath: payload.transcriptPath,
      modelName: payload.modelName,
      sourceKind: 'session-start',
    },
    ROOT,
  );

  const mood = getMoodSnapshot({ root: ROOT });
  const nest = getNestSnapshot(ROOT, mood.mood);
  setNestActivity({ phase: nest.sleeping ? 'sleeping' : 'idle', label: '剛連上這個新對話～準備好從星汐檔案回憶起你們的事' }, ROOT);

  appendLogLine(LOG, `SessionStart ok: sid=${sid}`);
  writeHookOutput({});
}

main();
