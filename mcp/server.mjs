/**
 * @fileoverview Stdio MCP Server for `gemini_cat` exposing companion tools from
 * `dsh-fish-memory`, `dsh-xingxi`, `dsh-feiyu-mood`, `dsh-persona-dafeiyu`, and `Cat Nest`.
 *
 * Uses newline-delimited JSON-RPC 2.0 per standard MCP stdio transport specification.
 */

import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getProjectRoot, readJsonSafe } from '../core/storage.mjs';
import { recallMemories, rememberMemory, mutateMemory } from '../core/memory.mjs';
import { applyMoodDelta, getMoodSnapshot } from '../core/mood.mjs';
import { getNestSnapshot, performNestAction } from '../core/nest.mjs';
import { getPersonaSnapshot } from '../core/persona.mjs';
import {
  appendDiary,
  appendToChapter,
  prepareXingxiPickupMaterial,
  readMemoryCard,
  replaceChapterTwo,
  searchXingxiArchive,
} from '../core/xingxi.mjs';

const ROOT = getProjectRoot();
const APP_VERSION = String(readJsonSafe(join(ROOT, 'package.json'), {})?.version || '1.0.0');

const TOOLS = [
  {
    name: 'remember',
    description:
      '把一件事記進長期記憶（含淡忘曲線與事實鍵）。一條只裝一件事；只記有長期價值的事（重要設定、約定、偏好、生活狀態、共同經歷），不要記流水瑣事，也不要在回覆裡說「我記住了」。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: {
        text: { type: 'string', description: '要記住的一件事，簡潔明確。' },
        importance: { type: 'number', description: '0~1，1=約定/稱呼/禁忌等必須常駐的事，0.5=一般事件與喜好（預設 0.5）。' },
        tags: { type: 'array', items: { type: 'string' }, description: '關鍵詞標籤，例如 ["約定","作息"]。' },
        factKey: {
          type: 'string',
          description: '可選，「對象.方面」（例如 她.作息、約定.睡前）。同一鍵只留最新一筆；不可用 .內容 / .相關 / .其他 等萬能鍵，流水帳不要填。',
        },
        supersedes: {
          type: 'string',
          description: '可選，若這條是在更新某件舊事（例如狀態改變），填入舊記憶的關鍵片段或 ID，舊記憶會標成已被取代。',
        },
      },
    },
  },
  {
    name: 'recall',
    description: '依查詢關鍵句主動檢索長期記憶，不會改變被檢索條目的強化度。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: '要回憶的主題或句子。' },
      },
    },
  },
  {
    name: 'memory_forget',
    description: '將指定 ID 的長期記憶標記為「已被取代」以停止召回（資料仍保留可供復原）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '記憶 ID，例如 m1a2b3c。' },
        reason: { type: 'string', description: '收起或作廢的原因。' },
      },
    },
  },
  {
    name: 'xingxi',
    description: '通讀星汐完整記憶卡（記憶卡.md 全文），適合在上下文整理後或剛開始對話想確認完整檔案時呼叫。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'xingxi_read',
    description: '檢索星汐長期檔案（記憶卡與按日分檔的日記）。不帶參數回傳總覽索引；帶 keyword 全文搜尋；帶 date（如 2026-11-14）查當日日記。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keyword: { type: 'string', description: '搜尋關鍵詞' },
        date: { type: 'string', description: '日期 YYYY-MM-DD 或 MM-DD' },
        file: { type: 'string', description: '指定檔名或片段' },
        maxChars: { type: 'number', description: '最大回傳字數（預設 4000）' },
      },
    },
  },
  {
    name: 'xingxi_append',
    description: '將過了一週再看仍有長期價值的要點，追加到記憶卡.md 的第 1~8 章之一（自動去重與備份；第 2 章可設 wholeChapter=true 執行防遺失整章合併）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['chapter', 'content'],
      properties: {
        chapter: { type: 'string', description: '章節編號 1~8 或 中文 一~八' },
        content: { type: 'string', description: '要追加的條目內容（Markdown 列表行，或 wholeChapter=true 時的新第二章正文）' },
        wholeChapter: {
          type: 'boolean',
          description: '可選，僅第 2 章生效：true 時整章合併覆寫並強制上限 10 句原話與 >=70% 條目防遺失保護。',
        },
      },
    },
  },
  {
    name: 'xingxi_diary',
    description: '記錄某一天的日記（日記/YYYY-MM-DD.md），保留當日細節與情緒脈絡並推進帳本進度。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['entry'],
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD（預設今天）' },
        entry: { type: 'string', description: '日記正文內容' },
      },
    },
  },
  {
    name: 'xingxi_pickup',
    description: '手動替指定日期（預設今天）執行星汐「切料拾星準備」：從已驗證的 gemini_cat 對話紀錄切出原始料檔（原始對話/YYYY-MM-DD.txt）與當日記憶心情摘要回傳，供後續寫入記憶卡或日記。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD（預設今天）' },
      },
    },
  },
  {
    name: 'mood_status',
    description: '讀取目前的心情數值（0~100）、7 維情緒、貓窩精力/飽食/羈絆度與目前啟用的人設摘要（嚴格限 gemini_cat 專案內）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'mood_update',
    description: '由對話內的你依這輪真實互動，安靜記錄心情與 7 維情緒變化（寫入即時貓窩 UI 與時間線，無需外部 API）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['reason'],
      properties: {
        moodDelta: { type: 'number', description: '-10 到 +10 的心情起伏（負值代表心疼/擔心/委屈，正值代表開心/踏實/甜蜜）' },
        dims: {
          type: 'object',
          description: '情緒維度微調：happy, calm, sweet, heartache, worry, sad, jealous（各 -10~+10）',
        },
        reason: { type: 'string', description: '具體過去式簡短原因（例如：主人主動摸了摸頭還說早安，心裡暖呼呼的）' },
        confidence: { type: 'number', description: '0~100 可信度（預設 80）' },
      },
    },
  },
  {
    name: 'nest_interact',
    description: '在對話中替貓窩裡的 Gemini-chan 進行照護或作息互動（摸摸/餵食/玩耍/貼貼，或用 sleep 入睡、wake 叫醒、nap 切換打盹，受冷卻與飽食精力限制）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['pet', 'feed', 'play', 'nap', 'sleep', 'wake', 'comfort'] },
      },
    },
  },
];

async function callTool(name, args = {}) {
  switch (name) {
    case 'remember': {
      const res = rememberMemory(args, { root: ROOT });
      return { content: [{ type: 'text', text: res.ok ? res.message : `✗ ${res.message}` }] };
    }
    case 'recall': {
      const res = recallMemories(String(args.query || ''), { root: ROOT, saveTrace: true });
      const text = res.rendered || '（這句話沒有勾起符合門檻的長期記憶）';
      return { content: [{ type: 'text', text }] };
    }
    case 'memory_forget': {
      const res = mutateMemory('supersede', { id: args.id, reason: args.reason }, ROOT);
      return { content: [{ type: 'text', text: res.ok ? `已將記憶 ${args.id} 標記為已被取代。` : `✗ ${res.error}` }] };
    }
    case 'xingxi': {
      const res = readMemoryCard(ROOT);
      return { content: [{ type: 'text', text: res.text }] };
    }
    case 'xingxi_read': {
      const res = searchXingxiArchive(args, ROOT);
      return { content: [{ type: 'text', text: res.text }] };
    }
    case 'xingxi_append': {
      const chSpec = String(args.chapter || '').trim();
      const isCh2 = chSpec === '2' || chSpec === '二';
      if (args.wholeChapter === true && isCh2) {
        const res = replaceChapterTwo(args.content, ROOT);
        return {
          content: [{
            type: 'text',
            text: res.ok
              ? `記憶卡第 2 章已完成整章合併${res.trimmedQuotes ? `（已依上限裁掉 ${res.trimmedQuotes} 條多餘原話）` : ''}。`
              : `✗ ${res.error}`,
          }],
        };
      }
      const res = appendToChapter(args.chapter, args.content, ROOT);
      return {
        content: [{
          type: 'text',
          text: res.ok
            ? `記憶卡第 ${res.chapter} 章已更新（新增 ${res.added} 條，跳過重複 ${res.skipped} 條）。`
            : `✗ ${res.error}`,
        }],
      };
    }
    case 'xingxi_diary': {
      const res = appendDiary(args, ROOT);
      return {
        content: [{
          type: 'text',
          text: res.ok ? `已寫入 ${res.date} 日記（${res.path}）。` : `✗ ${res.error}`,
        }],
      };
    }
    case 'xingxi_pickup': {
      const mat = prepareXingxiPickupMaterial(ROOT, { date: args.date });
      const header = `【拾星原料切片完成】日期：${mat.date}｜新切片段落：${mat.turnCount}｜檔案：${mat.filePath}`;
      return {
        content: [{
          type: 'text',
          text: mat.previewText ? `${header}\n\n${mat.previewText}` : `${header}\n（目前這一天沒有待整理的新對話段落，請直接依上下文補寫或略過）`,
        }],
      };
    }
    case 'mood_status': {
      const mood = getMoodSnapshot({ root: ROOT });
      const nest = getNestSnapshot(ROOT, mood.mood);
      const persona = getPersonaSnapshot({ root: ROOT });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            mood: { score: mood.mood, label: mood.moodLabel, dims: mood.dims, lastReason: mood.lastReason },
            nest: { satiety: nest.satiety, energy: nest.energy, bond: nest.bond, bondLevel: nest.bondLevel, sleeping: nest.sleeping },
            persona: { resolvedName: persona.resolvedName, source: persona.resolvedSource, scopeNotice: persona.scopeNotice },
          }, null, 2),
        }],
      };
    }
    case 'mood_update': {
      const res = applyMoodDelta(args, { root: ROOT, source: 'chat-ai' });
      return {
        content: [{
          type: 'text',
          text: res.applied
            ? `已於對話內更新心情至 ${Math.round(res.state.mood)}（${args.reason}）。`
            : '這輪沒有實際數值變化。',
        }],
      };
    }
    case 'nest_interact': {
      const res = performNestAction(args.action, { root: ROOT });
      if (!res.ok) return { content: [{ type: 'text', text: `✗ ${res.error}` }] };
      const limitNote = res.limited ? '【受限未計入額度】' : '';
      const sleepTag = res.state.sleeping ? '｜狀態：睡覺中' : '｜狀態：清醒';
      return {
        content: [{
          type: 'text',
          text: `${limitNote}${res.reaction}（飽食 ${Math.round(res.state.satiety)} / 精力 ${Math.round(res.state.energy)}${sleepTag}）`,
        }],
      };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendResponse(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = req;
  // Notifications have no id and expect no reply
  if (id === undefined || id === null) return;

  try {
    switch (method) {
      case 'initialize':
        sendResponse(id, {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'gemini-cat-mcp', version: APP_VERSION },
        });
        break;
      case 'ping':
        sendResponse(id, {});
        break;
      case 'tools/list':
        sendResponse(id, { tools: TOOLS });
        break;
      case 'tools/call': {
        const res = await callTool(params?.name, params?.arguments || {});
        sendResponse(id, res);
        break;
      }
      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    sendError(id, -32000, err?.message || String(err));
  }
});
