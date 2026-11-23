/**
 * @fileoverview Stdio MCP Server for `gemini_cat` exposing companion tools from
 * `dsh-fish-memory`, `dsh-xingxi`, `dsh-feiyu-mood`, `dsh-persona-dafeiyu`, and `Cat Nest`.
 *
 * Uses newline-delimited JSON-RPC 2.0 per standard MCP stdio transport specification.
 */

import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { getProjectRoot, localClockDisplay, readJsonSafe } from '../core/storage.mjs';
import { recallMemories, rememberMemory, mutateMemory } from '../core/memory.mjs';
import { applyMoodDelta, getMoodSnapshot } from '../core/mood.mjs';
import { getNestSnapshot, performNestAction } from '../core/nest.mjs';
import { getPersonaSnapshot } from '../core/persona.mjs';
import { getSpeakUpSnapshot, mutateSpeakUpPlan } from '../core/speak-up.mjs';
import {
  getTelegramSnapshot,
  loadTelegramConfig,
  recordTelegramMcpSentFile,
  telegramSendFile,
  telegramSendText,
} from '../core/telegram.mjs';
import {
  appendDiary,
  appendToChapter,
  prepareXingxiPickupMaterial,
  readMemoryCard,
  replaceChapterTwo,
  searchXingxiArchive,
} from '../core/xingxi.mjs';

const ROOT = getProjectRoot();
const APP_VERSION = String(readJsonSafe(join(ROOT, 'package.json'), {})?.version || '0.0.0-unknown');

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
        importance: { type: 'number', description: '0~1，1=對方的名字/稱呼/約定/禁忌等要記一輩子的事，0.5=一般事件與喜好（預設 0.5）。' },
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
    description: '讀取目前的心情數值（0~100）、8 維情緒、貓窩羈絆等級／今日陪伴狀態與目前啟用的人設摘要（嚴格限 gemini_cat 專案內）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'mood_update',
    description:
      '由對話內的你依這輪真實互動，安靜記錄心情波動、8 維情緒與第一人稱內心獨白（寫入即時貓窩 UI 與時間線，不會出現在聊天回覆裡，無需外部 API）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subject: {
          type: 'string',
          enum: ['owner', 'self', 'other', 'none'],
          description: '情緒主體：owner=主人本人的事、self=你自己的事、other=外人八卦故事、none=純閒聊（若為 other/none 則不變動大心情）。',
        },
        moodDelta: { type: 'number', description: '-10 到 +10 的心情起伏（可為 0；負值代表心疼/擔心/委屈，正值代表開心/踏實/甜蜜）' },
        dims: {
          type: 'object',
          description: '情緒維度微調：happy, calm, sweet, heartache, worry, sad, jealous, angry（各 -10~+10；angry 只對事或替主人抱不平，絕不對主人本人）',
        },
        reason: { type: 'string', description: '具體過去式簡短事件原因（例如：主人主動摸了摸頭還說早安，心裡暖呼呼的）' },
        innerThought: {
          type: 'string',
          description: '第一人稱內心想法／心裡碎碎念（只顯示於貓窩心情頁面，不會出現在聊天泡泡中；用你人設的口氣寫下真實感受或對接下來想做的事）',
        },
        confidence: { type: 'number', description: '0~100 可信度（預設 80）' },
      },
    },
  },
  {
    name: 'nest_interact',
    description: '在對話中替貓窩裡的 Gemini-chan 進行陪伴或作息互動（摸摸/餵食/玩耍/貼貼，或用 sleep 入睡、wake 叫醒、nap 切換打盹，累積羈絆與今日陪伴）。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['pet', 'feed', 'play', 'nap', 'sleep', 'wake', 'comfort'] },
      },
    },
  },
  {
    name: 'speak_up_plan',
    description:
      '貓窩專屬的主動搭話／自然語言提醒／自主勿擾排程器（取代系統 timer/schedule，IDE 重啟不遺失、並與貓窩睡眠／安靜時段連動）。支援單次預約、批次排入一串時間、設定固定時段 ± 隨機波動節律、設定自主勿擾時段（silence），及查詢／調整搭話設定。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'schedule', 'schedule_batch', 'add_routine', 'update_routine', 'toggle_routine', 'reroll_routine', 'silence', 'clear_silence', 'remove', 'clear_plans', 'set_config'],
          description: '排程動作：schedule=單次預約；schedule_batch=一次排入多筆 plans；add_routine=新增固定時間隨機波動節律；silence=設定勿擾到指定時間；clear_silence=提前解除勿擾；list=查看目前時刻表、設定與見聞籃；set_config=調整開關或參數；remove=刪除指定 ID；clear_plans=清空預約佇列。',
        },
        id: { type: 'string', description: '要修改、切換或移除的預約／節律 ID' },
        kind: {
          type: 'string',
          enum: ['autonomous', 'reminder'],
          description: 'autonomous=你自主決定稍後找主人（若對方剛才仍在說話會自動順延）；reminder=主人明確交代到點提醒（準點不因閒聊或勿擾被吞掉）。',
        },
        delayMinutes: { type: 'number', description: '幾分鐘後（單次 schedule 或 silence 使用，1~43200）' },
        at: { type: 'string', description: '目標時間："HH:MM"（24 小時制，已過則算明天）或完整 ISO 8601 時間字串' },
        until: { type: 'string', description: 'silence 專用：勿擾結束目標時間（"HH:MM" 或 ISO 字串，用法同 at）' },
        reason: { type: 'string', description: 'silence 專用：自我勿擾原因（例如「主人去睡覺了，約定時間前先不打擾」）' },
        jitterMin: { type: 'number', description: '隨機波動半徑（分鐘，0~240），例如 12:30 搭 20 代表在 12:10~12:50 間隨機挑點' },
        label: { type: 'string', description: '短標題（例如「睡前看他休息了沒」或「喝水提醒」）' },
        thought: { type: 'string', description: '屆時喚醒你開口時要帶入的心裡念頭或想說的話' },
        allowDuringQuiet: { type: 'boolean', description: '是否允許在安靜時段內仍提醒（預設 false）' },
        allowWakeFromSleep: { type: 'boolean', description: '打盹休眠時此提醒是否可直接傳入（reminder 預設 true）' },
        silenceUntilTrigger: { type: 'boolean', description: '排入提醒時順帶設定勿擾直到該提醒觸發（適合睡前約早上叫醒，避免清晨搶先亂插話）' },
        silenceReason: { type: 'string', description: '搭配 silenceUntilTrigger 時的自訂勿擾原因說明' },
        clearAutonomous: { type: 'boolean', description: 'silence 專用：設定勿擾時是否順手清掉勿擾期內的舊 autonomous 預約（預設 true）' },
        clearReminders: { type: 'boolean', description: 'silence 專用：是否連明確 reminder 一起清除（預設 false）' },
        replaceExisting: { type: 'boolean', description: '單次 autonomous 預約是否覆蓋先前尚未觸發的 autonomous 預約（預設 true）' },
        plans: {
          type: 'array',
          description: 'schedule_batch 專用：多筆排程時間陣列',
          items: {
            type: 'object',
            properties: {
              delayMinutes: { type: 'number' },
              at: { type: 'string' },
              jitterMin: { type: 'number' },
              kind: { type: 'string', enum: ['autonomous', 'reminder'] },
              label: { type: 'string' },
              thought: { type: 'string' },
              allowDuringQuiet: { type: 'boolean' },
              silenceUntilTrigger: { type: 'boolean' },
            },
          },
        },
        timeHHMM: { type: 'string', description: '固定節律專用：每日基準時間 24 小時制 "HH:MM"，例如 "12:30"' },
        days: { type: 'array', items: { type: 'number' }, description: '固定節律專用：星期陣列 0(日)~6(六)，省略代表每天' },
        enabled: { type: 'boolean', description: '用於 add_routine/update_routine 或 set_config 總開關' },
        aiPlanEnabled: { type: 'boolean', description: 'set_config 專用：開關 AI 自主預約／節律引擎' },
        diceEnabled: { type: 'boolean', description: 'set_config 專用：開關傳統峰谷公式隨機擲骰補位' },
        diceBlockActiveChat: { type: 'boolean', description: 'set_config 專用：擲骰是否強制遵守剛聊完防打擾間隔' },
        suppressDiceBeforeReminder: { type: 'boolean', description: 'set_config 專用：有待辦／叫醒提醒前是否自動壓制擲骰' },
        suppressBeforeReminderMin: { type: 'number', description: 'set_config 專用：明確提醒前幾分鐘內不擲骰 (0~720)' },
        maxUnansweredSpontaneous: { type: 'number', description: 'set_config 專用：已讀未回連發幾則後暫停主動插話 (0=不限)' },
        scheduleTendency: { type: 'string', enum: ['high', 'normal', 'low'], description: 'set_config 專用：AI 自主排程傾向' },
        proactiveCueEnabled: { type: 'boolean', description: 'set_config 專用：對話中出現睡覺／暫離訊號時是否即時提醒排程' },
        quietStartHour: { type: 'number', description: 'set_config 專用：安靜時段開始小時 (0~23)' },
        quietEndHour: { type: 'number', description: 'set_config 專用：安靜時段結束小時 (0~23)' },
        respectActiveChatGapMin: { type: 'number', description: 'set_config 專用：對話進行中防打擾順延分鐘數' },
        triggerPrompt: { type: 'string', description: 'set_config 專用：修改預設內心念頭文案' },
        freshBrowseEnabled: { type: 'boolean', description: 'set_config 專用：開關外網新鮮見聞（預設 false，開啟後主動搭話偶爾可自由帶入外界新事）' },
      },
    },
  },
  {
    name: 'telegram_send',
    description:
      '主動透過已綁定的 Telegram Bot 傳送文字訊息、圖片或檔案給主人（支援本機檔案與生成圖片；受安全白名單限制，絕不會外洩設定或金鑰）。若本輪直接傳過指定檔案，系統結束時不會重複傳送同一檔案。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: '要傳給主人的文字訊息；若有附帶 filePath 則會作為說明文字 (caption)' },
        filePath: { type: 'string', description: '可選，欲傳送的本機檔案或圖片路徑（限 gemini_cat 專案、生成媒體目錄或已開放資料夾內）' },
        asPhoto: { type: 'boolean', description: '圖片（PNG/JPG/WEBP ≤10MB）是否以壓縮相片預覽送出；設 false 則改以原檔 sendDocument 送出（預設 true）' },
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
        if (!res.ok) {
          // dsh-xingxi v0.3.0: if whole-chapter replacement was rejected (e.g. <70% items), fall back to safe append
          const fb = appendToChapter(2, args.content, ROOT);
          if (fb.ok) {
            return {
              content: [{
                type: 'text',
                text: `${res.error} 已自動改走安全追加（第 2 章新增 ${fb.added} 條，跳過重複 ${fb.skipped} 條）。`,
              }],
            };
          }
        }
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
      const sp = getSpeakUpSnapshot(ROOT);
      const tg = getTelegramSnapshot(ROOT);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            mood: {
              score: mood.mood,
              label: mood.moodLabel,
              dims: mood.dims,
              lastReason: mood.lastReason,
              lastInnerThought: mood.lastInnerThought,
              innerThoughtEnabled: mood.config?.innerThoughtEnabled !== false,
            },
            nest: {
              bond: nest.bond,
              bondLevel: nest.bondLevel,
              bondProgress: nest.bondProgress,
              todayCareCount: nest.todayCareCount,
              todayWarmth: nest.todayWarmth,
              sleeping: nest.sleeping,
            },
            speakUp: {
              enabled: sp.config.enabled,
              aiPlanEnabled: sp.config.aiPlanEnabled,
              diceEnabled: sp.config.diceEnabled,
              dryRun: sp.config.dryRun,
              scheduleTendency: sp.config.scheduleTendency,
              isSilenced: sp.preview.isSilenced,
              silentUntil: sp.preview.silentUntil ? localClockDisplay(sp.preview.silentUntil) : '',
              silentReason: sp.preview.silentReason || '',
              unansweredCount: sp.state.unansweredCount || 0,
              maxUnansweredSpontaneous: sp.config.maxUnansweredSpontaneous,
              plans: (sp.state.plans || []).slice(0, 6).map((p) => ({
                id: p.id,
                kind: p.kind,
                label: p.label,
                at: localClockDisplay(p.triggerAt),
                jitterMin: p.jitterMin,
                thought: p.thought,
              })),
              routines: (sp.state.routines || []).map((r) => ({
                id: r.id,
                enabled: r.enabled,
                label: r.label,
                timeHHMM: r.timeHHMM,
                jitterMin: r.jitterMin,
                nextAt: r.nextTriggerAt ? localClockDisplay(r.nextTriggerAt) : '',
              })),
            },
            persona: { resolvedName: persona.resolvedName, source: persona.resolvedSource, scopeNotice: persona.scopeNotice },
            telegram: {
              enabled: tg.config.enabled,
              configured: tg.status.configured,
              botUsername: tg.status.botUsername,
              sidecarAlive: tg.status.sidecarAlive,
            },
          }, null, 2),
        }],
      };
    }
    case 'mood_update': {
      const res = applyMoodDelta(args, { root: ROOT, source: 'chat-ai' });
      if (!res.applied) {
        return {
          content: [{
            type: 'text',
            text: res.capped
              ? `已達今日心情數值變化上限（${res.changesToday}/${res.cap} 次），本輪保留目前數值。`
              : '這輪沒有實際數值或內心想法寫入。',
          }],
        };
      }
      const note = res.state.lastReason ? `（${res.state.lastReason}）` : '';
      const thoughtNote = args.innerThought ? '，並已寫入貓窩內心小劇場' : '';
      const capNote = res.cappedNumeric ? '（數值已達今日變化上限，本次僅記錄心聲）' : '';
      return {
        content: [{
          type: 'text',
          text: `已於對話內記錄心情至 ${Math.round(res.state.mood)}${note}${thoughtNote}${capNote}。`,
        }],
      };
    }
    case 'nest_interact': {
      const res = performNestAction(args.action, { root: ROOT });
      if (!res.ok) return { content: [{ type: 'text', text: `✗ ${res.error}` }] };
      const limitNote = res.limited ? '【受限未計入額度】' : '';
      const bondLevel = Math.floor((res.state.bond || 0) / 50) + 1;
      const sleepTag = res.state.sleeping ? '｜狀態：睡覺中' : '｜狀態：清醒';
      return {
        content: [{
          type: 'text',
          text: `${limitNote}${res.reaction}（羈絆 Lv.${bondLevel} · ${res.state.bond}${sleepTag}）`,
        }],
      };
    }
    case 'speak_up_plan': {
      const action = String(args.action || 'list').trim();
      const res = mutateSpeakUpPlan(action, args, ROOT);
      if (!res.ok) return { content: [{ type: 'text', text: `✗ ${res.error}` }] };
      const snap = getSpeakUpSnapshot(ROOT);
      const summary = {
        ok: true,
        action,
        ...(res.plan ? {
          plan: {
            id: res.plan.id,
            kind: res.plan.kind,
            label: res.plan.label,
            triggerAt: localClockDisplay(res.plan.triggerAt),
            jitterMin: res.plan.jitterMin,
          },
        } : {}),
        ...(Array.isArray(res.added) ? {
          added: res.added.map((p) => ({
            id: p.id,
            kind: p.kind,
            label: p.label,
            triggerAt: localClockDisplay(p.triggerAt),
          })),
        } : {}),
        ...(res.routine ? {
          routine: {
            id: res.routine.id,
            label: res.routine.label,
            timeHHMM: res.routine.timeHHMM,
            jitterMin: res.routine.jitterMin,
            nextTriggerAt: res.routine.nextTriggerAt ? localClockDisplay(res.routine.nextTriggerAt) : '',
            enabled: res.routine.enabled,
          },
        } : {}),
        switches: {
          enabled: snap.config.enabled,
          aiPlanEnabled: snap.config.aiPlanEnabled,
          diceEnabled: snap.config.diceEnabled,
          dryRun: snap.config.dryRun,
          scheduleTendency: snap.config.scheduleTendency,
          diceBlockActiveChat: snap.config.diceBlockActiveChat,
          suppressDiceBeforeReminder: snap.config.suppressDiceBeforeReminder,
          maxUnansweredSpontaneous: snap.config.maxUnansweredSpontaneous,
        },
        silence: {
          active: snap.preview.isSilenced,
          until: snap.preview.silentUntil ? localClockDisplay(snap.preview.silentUntil) : '',
          reason: snap.preview.silentReason || '',
        },
        unansweredCount: snap.state.unansweredCount || 0,
        upcomingPlans: (snap.state.plans || []).map((p) => ({
          id: p.id,
          kind: p.kind,
          label: p.label,
          triggerAt: localClockDisplay(p.triggerAt),
          jitterMin: p.jitterMin,
          thought: p.thought,
        })),
        routines: (snap.state.routines || []).map((r) => ({
          id: r.id,
          enabled: r.enabled,
          label: r.label,
          timeHHMM: r.timeHHMM,
          jitterMin: r.jitterMin,
          days: r.days,
          nextTriggerAt: r.nextTriggerAt ? localClockDisplay(r.nextTriggerAt) : '',
          thought: r.thought,
        })),
        freshBrowse: {
          enabled: Boolean(snap.freshBrowse?.config?.enabled),
          fetchTimes: snap.freshBrowse?.config?.fetchTimes || [],
          presets: snap.freshBrowse?.config?.presets || [],
          weatherCity: snap.freshBrowse?.config?.weatherResolvedLabel || snap.freshBrowse?.config?.weatherCity || '',
          pendingItems: (snap.freshBrowse?.items || []).slice(0, 5).map((i) => ({
            source: i.source,
            title: i.title,
            url: i.url,
          })),
        },
      };
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    }
    case 'telegram_send': {
      const cfg = loadTelegramConfig(ROOT);
      if (!cfg.enabled) {
        return { content: [{ type: 'text', text: '✗ Telegram 橋接尚未啟用（請先在側邊欄「TG」分頁開啟總開關）' }] };
      }
      if (!cfg.botToken || !cfg.allowedChatId) {
        return { content: [{ type: 'text', text: '✗ Telegram 尚未設定 Bot Token 或綁定主人 Chat ID' }] };
      }
      const chatId = String(cfg.allowedChatId).split(/[\s,，;]+/).map((s) => s.trim()).filter(Boolean)[0];
      const text = String(args.text || '').trim();
      const filePath = String(args.filePath || '').trim();
      if (!text && !filePath) {
        return { content: [{ type: 'text', text: '✗ 請至少提供 text 或 filePath 其中一項' }] };
      }
      if (filePath) {
        const res = await telegramSendFile(cfg.botToken, chatId, filePath, {
          root: ROOT,
          cfg,
          caption: text,
          asPhoto: args.asPhoto !== false,
        });
        if (!res.ok) {
          return { content: [{ type: 'text', text: `✗ Telegram 傳檔失敗：${res.error}` }] };
        }
        recordTelegramMcpSentFile(ROOT, res.filePath || filePath);
        return { content: [{ type: 'text', text: `✓ 已透過 ${res.method} 傳送檔案到 Telegram：${res.filePath}` }] };
      }
      const res = await telegramSendText(cfg.botToken, chatId, text);
      if (!res.ok) {
        return { content: [{ type: 'text', text: `✗ Telegram 發送失敗：${res.error}` }] };
      }
      return { content: [{ type: 'text', text: '✓ 已傳送訊息到 Telegram' }] };
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
