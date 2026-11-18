/**
 * @fileoverview Safe, non-destructive setup helper that writes Antigravity's
 * Sidecar configuration (`~/.gemini/config/sidecars/gemini-cat-nest/sidecar.json`)
 * pointing to this repository's `sidecar/main.mjs` with forward-slash paths.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = resolve(dirname(__filename), '..');
export const SIDECAR_ID = 'gemini-cat-nest';
export const PLUGIN_SIDECAR_FOLDER = 'gemini_cat_nest';

export function toPosixPath(p) {
  return String(p || '').replace(/\\/g, '/');
}

export function buildSidecarConfig(repoRoot = DEFAULT_REPO_ROOT) {
  const entryPath = toPosixPath(resolve(repoRoot, 'sidecar', 'main.mjs'));
  return {
    command: 'node',
    args: [entryPath],
    restart_policy: 'always',
    display_name: 'Gemini-chan 貓窩',
    description: 'Gemini-chan 互動貓窩側邊欄：即時情緒立繪、長期記憶庫、星汐星圖與主動搭話（僅在目前專案工作區生效）。',
    has_web_ui: true,
    agent_permissions: {
      allows_user_interactions: false,
    },
    ui_config: {
      display_name: 'Gemini-chan 貓窩',
      views: [
        {
          path: '/',
          entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE',
          title: 'Gemini-chan 貓窩',
        },
      ],
    },
  };
}

export function resolveConfigBase(configDir) {
  return configDir
    ? resolve(configDir)
    : process.env.GEMINI_CONFIG_DIR
      ? resolve(process.env.GEMINI_CONFIG_DIR)
      : join(homedir(), '.gemini', 'config');
}

export function resolveTargetPluginDir(configDir) {
  return join(resolveConfigBase(configDir), 'plugins', 'gemini-cat');
}

export function resolveTargetSidecarPath(configDir) {
  return join(resolveTargetPluginDir(configDir), 'sidecars', PLUGIN_SIDECAR_FOLDER, 'sidecar.json');
}

export function removeLegacyStandaloneSidecar(configDir) {
  const legacyDir = join(resolveConfigBase(configDir), 'sidecars', SIDECAR_ID);
  if (existsSync(legacyDir)) {
    try {
      rmSync(legacyDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function syncGlobalPluginBundle(repoRoot = DEFAULT_REPO_ROOT, configDir = '') {
  const pluginSrcDir = resolve(repoRoot, '.agents', 'plugins', 'gemini-cat');
  const targetPluginDir = resolveTargetPluginDir(configDir);
  const rootPosix = toPosixPath(resolve(repoRoot));

  mkdirSync(join(targetPluginDir, 'sidecars', PLUGIN_SIDECAR_FOLDER), { recursive: true });
  mkdirSync(join(targetPluginDir, 'skills', 'cat-nest'), { recursive: true });
  mkdirSync(join(targetPluginDir, 'skills', 'xingxi'), { recursive: true });

  // Copy manifest, logo, README, and skills
  for (const rel of ['plugin.json', 'logo.svg', 'README.md', 'skills/cat-nest/SKILL.md', 'skills/xingxi/SKILL.md']) {
    const src = join(pluginSrcDir, rel);
    if (existsSync(src)) {
      copyFileSync(src, join(targetPluginDir, rel));
    }
  }

  // Write global-safe hooks.json pointing to repoRoot hooks (which strictly check ensureInProjectScope)
  const hooksObj = {
    'gemini-cat': {
      SessionStart: [{ type: 'command', command: `node "${rootPosix}/hooks/session-start.mjs"`, timeout: 10 }],
      PreInvocation: [{ type: 'command', command: `node "${rootPosix}/hooks/pre-invocation.mjs"`, timeout: 10 }],
      PostToolUse: [{
        matcher: '*',
        hooks: [{ type: 'command', command: `node "${rootPosix}/hooks/post-tool-use.mjs"`, timeout: 5 }],
      }],
      Stop: [{ type: 'command', command: `node "${rootPosix}/hooks/stop.mjs"`, timeout: 15 }],
    },
  };
  writeFileSync(join(targetPluginDir, 'hooks.json'), JSON.stringify(hooksObj, null, 2) + '\n', { encoding: 'utf-8' });

  // Write mcp_config.json pointing to repoRoot mcp/server.mjs
  const mcpObj = {
    mcpServers: {
      companion: {
        command: 'node',
        args: [`${rootPosix}/mcp/server.mjs`],
        cwd: rootPosix,
      },
    },
  };
  writeFileSync(join(targetPluginDir, 'mcp_config.json'), JSON.stringify(mcpObj, null, 2) + '\n', { encoding: 'utf-8' });

  // Clean up legacy standalone ~/.gemini/config/sidecars/gemini-cat-nest so only the plugin-bound sidecar appears
  removeLegacyStandaloneSidecar(configDir);

  return targetPluginDir;
}

export function setupSidecar({
  repoRoot = DEFAULT_REPO_ROOT,
  configDir = '',
  dryRun = false,
  force = false,
} = {}) {
  const entryFsPath = resolve(repoRoot, 'sidecar', 'main.mjs');
  if (!existsSync(entryFsPath)) {
    return { ok: false, status: 'missing-entry', message: `找不到 sidecar 進入點：${entryFsPath}` };
  }

  const targetPath = resolveTargetSidecarPath(configDir);
  const nextConfig = buildSidecarConfig(repoRoot);
  const nextJson = JSON.stringify(nextConfig, null, 2) + '\n';

  if (existsSync(targetPath)) {
    let existingRaw = '';
    try {
      existingRaw = readFileSync(targetPath, { encoding: 'utf-8' }).replace(/^\uFEFF/, '');
      const parsed = JSON.parse(existingRaw);
      const currentArg = toPosixPath(parsed?.args?.[0] || '');
      if (currentArg === nextConfig.args[0] && parsed?.has_web_ui === true) {
        if (!dryRun) syncGlobalPluginBundle(repoRoot, configDir);
        return { ok: true, status: 'unchanged', targetPath, config: nextConfig };
      }
    } catch {
      // Malformed JSON or unreadable; require --force before overwriting
    }

    if (!force) {
      return {
        ok: false,
        status: 'exists-conflict',
        targetPath,
        config: nextConfig,
        message: `設定檔已存在且指向不同內容：${targetPath}（為避免覆蓋本機設定，請加上 --force 並會自動備份 .bak）`,
      };
    }

    if (dryRun) {
      return { ok: true, status: 'dry-run-overwrite', targetPath, config: nextConfig, json: nextJson };
    }

    const backupPath = `${targetPath}.bak-${Date.now()}`;
    copyFileSync(targetPath, backupPath);
    writeFileSync(targetPath, nextJson, { encoding: 'utf-8' });
    const pluginDir = syncGlobalPluginBundle(repoRoot, configDir);
    return { ok: true, status: 'updated', targetPath, backupPath, pluginDir, config: nextConfig };
  }

  if (dryRun) {
    return { ok: true, status: 'dry-run-create', targetPath, config: nextConfig, json: nextJson };
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, nextJson, { encoding: 'utf-8' });
  const pluginDir = syncGlobalPluginBundle(repoRoot, configDir);
  return { ok: true, status: 'created', targetPath, pluginDir, config: nextConfig };
}

function parseArgs(argv) {
  const opts = { dryRun: false, force: false, help: false, configDir: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--config-dir' && argv[i + 1]) opts.configDir = argv[++i];
  }
  return opts;
}

const isDirectRun =
  typeof process.argv[1] === 'string' && resolve(process.argv[1]) === resolve(__filename);

if (isDirectRun) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      '用法: node scripts/setup-sidecar.mjs [選項]',
      '',
      '選項:',
      '  --dry-run, -n        只預覽目標路徑與 JSON 內容，不寫入任何檔案',
      '  --force, -f          若 sidecar.json 已存在且路徑不同，先備份 .bak 後覆寫',
      '  --config-dir <dir>   指定 .gemini/config 目錄（預設 ~/.gemini/config）',
      '  --help, -h           顯示此說明',
    ].join('\n'));
    process.exit(0);
  }

  const res = setupSidecar(opts);
  if (!res.ok) {
    console.error(`[setup-sidecar] ${res.message}`);
    process.exit(1);
  }

  if (res.status.startsWith('dry-run')) {
    console.log(`[dry-run] 目標路徑: ${toPosixPath(res.targetPath)}`);
    console.log(res.json);
    process.exit(0);
  }

  if (res.status === 'unchanged') {
    console.log(`[setup-sidecar] 已是最新設定，無需變更：${toPosixPath(res.targetPath)}`);
  } else if (res.status === 'updated') {
    console.log(`[setup-sidecar] 已備份原設定至 ${toPosixPath(res.backupPath)}`);
    console.log(`[setup-sidecar] 已更新設定：${toPosixPath(res.targetPath)}`);
  } else {
    console.log(`[setup-sidecar] 已建立 Sidecar 設定：${toPosixPath(res.targetPath)}`);
  }

  console.log([
    '',
    '接下來請完成 3 個步驟：',
    '1. 使用 Antigravity 2.0 直接開啟本專案根目錄（勿只開上層父資料夾）。',
    '2. 在 Antigravity 設定或側邊欄「UI Extensions」開啟「Gemini-chan 貓窩」開關（必要時重載視窗）。',
    '3. 打開右側貓窩面板的「人設」分頁，選用內建中性範本或匯入你自己的 .md/.txt 人設。',
  ].join('\n'));
}
