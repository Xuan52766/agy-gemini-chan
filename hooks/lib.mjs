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
 * Checks whether a transcript JSONL step is a message dispatched by Sidecar `sendMessage`
 * (`Speak-Up`, `Xingxi Pickup`, or `Cat Nest`), which Antigravity records as a
 * `SYSTEM_MESSAGE` (`source: "SYSTEM"`) rather than `USER_INPUT` or hook `<SYSTEM_MESSAGE>`.
 */
export function isSidecarInputStep(step) {
  if (step?.type !== 'SYSTEM_MESSAGE' || typeof step.content !== 'string') return false;
  const c = step.content.trim();
  if (!c || c.startsWith('<SYSTEM_MESSAGE>')) return false;
  return (
    c.includes('[SPEAK_UP_INTERNAL]') ||
    c.includes('<speak-up>') ||
    c.includes('[XINGXI_AUTO_PICKUP]') ||
    c.includes('[CAT_NEST_EVENT]') ||
    c.includes('[TELEGRAM_INCOMING]') ||
    c.includes('[YOUTUBE_PATROL]')
  );
}

/**
 * Inspects the tail of Antigravity `transcriptPath` JSONL to determine:
 * 1. The most recent actual turn input (`USER_INPUT` or Sidecar-dispatched `SYSTEM_MESSAGE`)
 * 2. Whether the current invocation is a mid-turn tool continuation (`PLANNER_RESPONSE` or
 *    `GENERIC` tool output already occurred after the latest turn input).
 */
export function inspectTranscriptTail(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    return {
      hasTranscript: false,
      isMidTurnToolContinuation: false,
      latestInputText: '',
      latestInputStepIndex: -1,
      isSidecarInput: false,
    };
  }
  try {
    const raw = readFileSync(transcriptPath, { encoding: 'utf-8' });
    const lines = raw.split(/\r?\n/).filter(Boolean);
    let sawPlannerOrToolAfterInput = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      let step;
      try { step = JSON.parse(lines[i]); } catch { continue; }
      const type = step?.type;
      if (!type || type === 'CHECKPOINT' || type === 'EPHEMERAL_MESSAGE') continue;
      if (type === 'SYSTEM_MESSAGE' && !isSidecarInputStep(step)) continue;

      if (type === 'USER_INPUT' && typeof step.content === 'string') {
        const cleaned = stripAntigravityWrappers(step.content);
        if (cleaned) {
          return {
            hasTranscript: true,
            isMidTurnToolContinuation: sawPlannerOrToolAfterInput,
            latestInputText: cleaned,
            latestInputStepIndex: Number.isFinite(Number(step.step_index)) ? Number(step.step_index) : i,
            isSidecarInput: false,
          };
        }
      }

      if (isSidecarInputStep(step)) {
        return {
          hasTranscript: true,
          isMidTurnToolContinuation: sawPlannerOrToolAfterInput,
          latestInputText: step.content.trim(),
          latestInputStepIndex: Number.isFinite(Number(step.step_index)) ? Number(step.step_index) : i,
          isSidecarInput: true,
        };
      }

      if (type === 'PLANNER_RESPONSE' || type === 'GENERIC') {
        sawPlannerOrToolAfterInput = true;
      }
    }
    return {
      hasTranscript: lines.length > 0,
      isMidTurnToolContinuation: sawPlannerOrToolAfterInput,
      latestInputText: '',
      latestInputStepIndex: -1,
      isSidecarInput: false,
    };
  } catch {
    return {
      hasTranscript: false,
      isMidTurnToolContinuation: false,
      latestInputText: '',
      latestInputStepIndex: -1,
      isSidecarInput: false,
    };
  }
}

/**
 * Extracts latest turn input (`USER_INPUT` or Sidecar `SYSTEM_MESSAGE`) & assistant text
 * from Antigravity `transcriptPath` JSONL safely.
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
      if (!userText && isSidecarInputStep(step)) {
        userText = step.content.trim();
        break;
      }
      if (!userText && step?.type === 'USER_INPUT' && typeof step.content === 'string') {
        const cleaned = stripAntigravityWrappers(step.content);
        if (cleaned) {
          userText = cleaned;
          break;
        }
      }
    }
    return { userText, assistantText };
  } catch {
    return { userText: '', assistantText: '' };
  }
}
