/**
 * @fileoverview Strictly project-scoped (`gemini_cat` ONLY) Persona catalog & 2-tier
 * scope resolver (`session` override > `gemini_cat` project default).
 *
 * Unlike DSH desktop's multi-workspace setup, there is NO global / cross-project
 * persona tier here so nothing ever leaks into external coding projects.
 *
 * Per user constraint ("人物設定先不決定"), the default starter state leaves
 * `projectDefaultId` empty (`""`), plus a toggleable neutral starter template and
 * full create / edit / delete / project / per-conversation controls.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalSessionKey,
  getDataPaths,
  normalizePathOrUri,
  readJsonSafe,
  writeJsonAtomic,
} from './storage.mjs';

export const MAX_PERSONA_NAME = 60;
export const MAX_PERSONA_BODY = 64000;

export const NEUTRAL_STARTER_ID = 'neutral-companion-template';

function builtInStarterCatalog() {
  return [
    {
      id: NEUTRAL_STARTER_ID,
      name: '預設陪伴範本（待自訂人設）',
      text: [
        '【陪伴互動基底（人設待使用者決定｜僅限 gemini_cat 專案）】',
        '- 你目前住在 `gemini_cat` 專案的「Gemini-chan 貓窩」裡，所有伴侶機制皆只在此專案生效。',
        '- 使用者尚未指定最終固定人物設定，請保持自然、真誠、細心的交流態度，避免擅自套用強硬或油膩的套話。',
        '- 尊重當下注入的心情底色與星汐／長期記憶；沒有記錄或想不起來的事直接坦承，不要編造。',
      ].join('\n'),
      enabled: true,
      builtin: true,
      note: '人物設定先不決定時的安全中性範本，可隨時在「人設庫」修改、停用或替換（僅作用於本專案）。',
    },
  ];
}

function emptyStore() {
  return {
    version: 2,
    projectDefaultId: '',
    enabled: true,
    disabledSessions: {},
    items: [],
    tombstones: [],
    updatedAt: new Date().toISOString(),
  };
}

function normalizePersonaItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim().slice(0, 80);
  if (!id) return null;
  const name = String(raw.name || id).trim().slice(0, MAX_PERSONA_NAME);
  const text = String(raw.text || '').slice(0, MAX_PERSONA_BODY);
  return {
    id,
    name: name || id,
    text,
    enabled: raw.enabled !== false,
    note: String(raw.note || '').slice(0, 300),
    createdAt: raw.createdAt || new Date().toISOString(),
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

function normalizeStore(raw, root) {
  const base = emptyStore();
  if (!raw || typeof raw !== 'object') return base;
  const items = Array.isArray(raw.items)
    ? raw.items.map(normalizePersonaItem).filter(Boolean)
    : [];

  // Migrate smoothly from v1 fields (`workspacePicks` / `activeId` / `globalEnabled`)
  let migratedProjectDefault = typeof raw.projectDefaultId === 'string' ? raw.projectDefaultId.trim() : '';
  if (!migratedProjectDefault && raw.workspacePicks && typeof raw.workspacePicks === 'object') {
    const rootNorm = normalizePathOrUri(root);
    if (rootNorm && typeof raw.workspacePicks[rootNorm] === 'string') {
      migratedProjectDefault = raw.workspacePicks[rootNorm].trim();
    } else {
      const firstPick = Object.values(raw.workspacePicks).find((v) => typeof v === 'string' && v.trim());
      if (firstPick) migratedProjectDefault = firstPick.trim();
    }
  }
  if (!migratedProjectDefault && typeof raw.activeId === 'string' && raw.activeId.trim()) {
    migratedProjectDefault = raw.activeId.trim();
  }

  const enabled = raw.enabled !== undefined
    ? Boolean(raw.enabled)
    : (raw.globalEnabled !== false);

  const disabledSessions = {};
  if (raw.disabledSessions && typeof raw.disabledSessions === 'object') {
    for (const [k, v] of Object.entries(raw.disabledSessions)) {
      const sk = canonicalSessionKey(k);
      if (sk && v) disabledSessions[sk] = true;
    }
  }

  return {
    version: 2,
    projectDefaultId: migratedProjectDefault,
    enabled,
    disabledSessions,
    items,
    tombstones: Array.isArray(raw.tombstones) ? raw.tombstones.slice(-50) : [],
    updatedAt: raw.updatedAt || new Date().toISOString(),
  };
}

export function personaFiles(root) {
  const { personaDir } = getDataPaths(root);
  return {
    personaDir,
    storePath: join(personaDir, 'personas.json'),
    picksPath: join(personaDir, 'session-picks.json'),
  };
}

export function loadPersonaStore(root) {
  const { storePath } = personaFiles(root);
  if (!existsSync(storePath)) {
    const initial = emptyStore();
    writeJsonAtomic(storePath, initial);
    return initial;
  }
  return normalizeStore(readJsonSafe(storePath, {}), root);
}

export function savePersonaStore(store, root) {
  const { storePath } = personaFiles(root);
  const clean = normalizeStore(store, root);
  clean.updatedAt = new Date().toISOString();
  writeJsonAtomic(storePath, clean);
  return clean;
}

export function loadSessionPicks(root) {
  const { picksPath } = personaFiles(root);
  const raw = readJsonSafe(picksPath, null);
  if (!raw || typeof raw !== 'object') return { picks: {}, tombstones: {} };
  const picks = {};
  if (raw.picks && typeof raw.picks === 'object') {
    for (const [k, v] of Object.entries(raw.picks)) {
      const sk = canonicalSessionKey(k);
      if (sk && typeof v === 'string' && v.trim()) picks[sk] = v.trim();
    }
  }
  return {
    picks,
    tombstones: raw.tombstones && typeof raw.tombstones === 'object' ? raw.tombstones : {},
  };
}

export function saveSessionPicks(data, root) {
  const { picksPath } = personaFiles(root);
  writeJsonAtomic(picksPath, {
    picks: data.picks || {},
    tombstones: data.tombstones || {},
    updatedAt: new Date().toISOString(),
  });
}

export function buildCatalog(store) {
  const map = new Map();
  for (const b of builtInStarterCatalog()) map.set(b.id, b);
  for (const item of store.items || []) map.set(item.id, item);
  return [...map.values()];
}

/**
 * Resolves effective persona strictly inside `gemini_cat`:
 *   project disabled -> none
 *   session disabled -> none
 *   session override (`此對話專用`) > project default (`本專案 gemini_cat 共用`)
 */
export function resolvePersona({ root, sessionId = '' } = {}) {
  const store = loadPersonaStore(root);
  const catalog = buildCatalog(store);
  const byId = new Map(catalog.map((p) => [p.id, p]));
  const sk = canonicalSessionKey(sessionId);

  if (!store.enabled) {
    return {
      persona: null,
      source: 'project_disabled',
      effectiveText: '',
      store,
      catalog,
    };
  }

  if (sk && store.disabledSessions?.[sk]) {
    return {
      persona: null,
      source: 'session_disabled',
      effectiveText: '',
      store,
      catalog,
    };
  }

  const sessionPicks = loadSessionPicks(root);
  if (sk && sessionPicks.picks[sk]) {
    const p = byId.get(sessionPicks.picks[sk]);
    if (p && p.enabled) {
      return { persona: p, source: 'session', effectiveText: p.text, store, catalog };
    }
  }

  if (store.projectDefaultId) {
    const p = byId.get(store.projectDefaultId);
    if (p && p.enabled) {
      return { persona: p, source: 'project', effectiveText: p.text, store, catalog };
    }
  }

  return {
    persona: null,
    source: 'none',
    effectiveText: '',
    store,
    catalog,
  };
}

export function mutatePersona(action, payload = {}, root) {
  const store = loadPersonaStore(root);
  const catalog = buildCatalog(store);
  const byId = new Map(catalog.map((p) => [p.id, p]));

  switch (action) {
    case 'toggleProject':
    case 'toggleGlobal': {
      store.enabled = payload.enabled !== undefined ? Boolean(payload.enabled) : !store.enabled;
      return { ok: true, store: savePersonaStore(store, root) };
    }
    case 'create': {
      const name = String(payload.name || '').trim().slice(0, MAX_PERSONA_NAME);
      const text = String(payload.text || '').slice(0, MAX_PERSONA_BODY);
      if (!name) return { ok: false, error: '請填寫人設名稱' };
      if (catalog.some((p) => p.name === name)) {
        return { ok: false, error: `已存在同名「${name}」人設` };
      }
      const id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
      const item = normalizePersonaItem({
        id,
        name,
        text,
        enabled: true,
        note: String(payload.note || ''),
      });
      store.items.push(item);
      if (payload.activate) store.projectDefaultId = item.id;
      return { ok: true, item, store: savePersonaStore(store, root) };
    }
    case 'update': {
      const id = String(payload.id || '').trim();
      const idx = store.items.findIndex((x) => x.id === id);
      if (idx < 0) {
        if (id === NEUTRAL_STARTER_ID) {
          const item = normalizePersonaItem({
            ...builtInStarterCatalog()[0],
            name: payload.name !== undefined ? payload.name : builtInStarterCatalog()[0].name,
            text: payload.text !== undefined ? payload.text : builtInStarterCatalog()[0].text,
            enabled: payload.enabled !== undefined ? payload.enabled : true,
          });
          store.items.push(item);
          return { ok: true, item, store: savePersonaStore(store, root) };
        }
        return { ok: false, error: '找不到指定人設' };
      }
      const nextName = payload.name !== undefined
        ? String(payload.name).trim().slice(0, MAX_PERSONA_NAME)
        : store.items[idx].name;
      if (!nextName) return { ok: false, error: '名稱不可為空' };
      if (catalog.some((p) => p.id !== id && p.name === nextName)) {
        return { ok: false, error: `名稱「${nextName}」已存在` };
      }
      store.items[idx] = normalizePersonaItem({
        ...store.items[idx],
        name: nextName,
        text: payload.text !== undefined ? payload.text : store.items[idx].text,
        enabled: payload.enabled !== undefined ? payload.enabled : store.items[idx].enabled,
        note: payload.note !== undefined ? payload.note : store.items[idx].note,
        updatedAt: new Date().toISOString(),
      });
      return { ok: true, item: store.items[idx], store: savePersonaStore(store, root) };
    }
    case 'rename':
      return mutatePersona('update', { id: payload.id, name: payload.name }, root);
    case 'toggleEnabled':
      return mutatePersona('update', { id: payload.id, enabled: payload.enabled }, root);
    case 'delete': {
      const id = String(payload.id || '').trim();
      if (id === NEUTRAL_STARTER_ID) return { ok: false, error: '內建佔位範本不可刪除，可停用或切換為空白' };
      const idx = store.items.findIndex((x) => x.id === id);
      if (idx < 0) return { ok: false, error: '找不到指定人設' };
      const [removed] = store.items.splice(idx, 1);
      if (store.projectDefaultId === id) store.projectDefaultId = '';
      store.tombstones.push({ id: removed.id, name: removed.name, deletedAt: new Date().toISOString() });
      return { ok: true, store: savePersonaStore(store, root) };
    }
    case 'selectProject':
    case 'selectWorkspace':
    case 'selectGlobal': {
      const id = String(payload.id || '').trim();
      if (id && !byId.has(id)) return { ok: false, error: '找不到該人設' };
      store.projectDefaultId = id;
      return { ok: true, store: savePersonaStore(store, root) };
    }
    case 'selectSession': {
      const sk = canonicalSessionKey(payload.sessionId);
      const id = String(payload.id || '').trim();
      if (!sk) return { ok: false, error: '缺少目前對話 ID（請在 gemini_cat 打開或切到對話後再設定）' };
      const picksData = loadSessionPicks(root);
      if (!id) delete picksData.picks[sk];
      else {
        if (!byId.has(id)) return { ok: false, error: '找不到該人設' };
        picksData.picks[sk] = id;
      }
      saveSessionPicks(picksData, root);
      return { ok: true, sessionPicks: picksData };
    }
    case 'setSessionDisabled': {
      const sk = canonicalSessionKey(payload.sessionId);
      if (!sk) return { ok: false, error: '缺少對話 ID' };
      if (payload.disabled) store.disabledSessions[sk] = true;
      else delete store.disabledSessions[sk];
      return { ok: true, store: savePersonaStore(store, root) };
    }
    default:
      return { ok: false, error: `未知操作: ${action}` };
  }
}

export function getPersonaSnapshot({ root, sessionId = '' } = {}) {
  const resolved = resolvePersona({ root, sessionId });
  const picks = loadSessionPicks(root);
  const sk = canonicalSessionKey(sessionId);
  return {
    enabled: resolved.store.enabled,
    projectDefaultId: resolved.store.projectDefaultId,
    sessionPickId: sk ? (picks.picks[sk] || '') : '',
    sessionDisabled: Boolean(sk && resolved.store.disabledSessions?.[sk]),
    resolvedId: resolved.persona?.id || '',
    resolvedName: resolved.persona?.name || '（尚未選定人設）',
    resolvedSource: resolved.source,
    effectiveText: resolved.effectiveText,
    scopeNotice: '僅限 gemini_cat 專案內生效，不會套用到任何外部專案或全域對話。',
    catalog: resolved.catalog,
  };
}
