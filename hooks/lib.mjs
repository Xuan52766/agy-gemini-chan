/**
 * @fileoverview Shared Antigravity Hook utilities: stdin JSON reading, strict
 * `gemini_cat` project boundary checking, and transcript parsing.
 */

import { readFileSync } from 'node:fs';
import { getProjectRoot, isProjectWorkspaceActive, stripAntigravityWrappers } from '../core/storage.mjs';

export function readHookInput() {
  const raw = readFileSync(0, { encoding: 'utf-8' }).trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function writeHookOutput(obj = {}) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

export function injectSystemContext(text) {
  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: String(text),
        },
      },
    ],
    terminationBehavior: '',
  };
}

/**
 * Guards every hook so even if triggered outside `gemini_cat` it immediately exits
 * without mutating state or injecting context into unrelated projects.
 */
export function ensureInProjectScope(payload, root = getProjectRoot()) {
  return isProjectWorkspaceActive(payload?.workspacePaths, payload?.cwd, root);
}

/**
 * Extracts latest user & assistant text from Antigravity `transcriptPath` JSONL safely.
 */
export function extractLatestTurnFromTranscript(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return { userText: '', assistantText: '' };
  try {
    const raw = readFileSync(transcriptPath, { encoding: 'utf-8' });
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let userText = '';
    let assistantText = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      let step;
      try { step = JSON.parse(lines[i]); } catch { continue; }
      if (!assistantText && step?.type === 'PLANNER_RESPONSE' && typeof step.content === 'string' && step.content.trim()) {
        assistantText = step.content.trim();
      }
      if (!userText && step?.type === 'USER_INPUT' && typeof step.content === 'string') {
        const cleaned = stripAntigravityWrappers(step.content);
        if (cleaned) userText = cleaned;
      }
      if (userText && assistantText) break;
    }
    return { userText, assistantText };
  } catch {
    return { userText: '', assistantText: '' };
  }
}
