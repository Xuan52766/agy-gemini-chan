#!/usr/bin/env node
/**
 * @fileoverview Safe one-click updater for `agy-gemini-chan`.
 *
 * Guarantees user data (`data/*` memories, moods, personas, diaries, Telegram config,
 * speak-up plans, nest state, and optional root `AGENTS.md`) is NEVER lost:
 * 1. Backs up all personal data to `~/.gemini/config/backups/agy-gemini-chan/` before updating.
 * 2. Updates code via `git pull --ff-only` (when `.git` exists) or GitHub release tarball
 *    overlay (when installed from ZIP / offline `--source-dir`), preserving `data/*` (except `data/dict/`).
 * 3. Re-syncs `~/.gemini/config/plugins/gemini-cat/` and Sidecar manifest via `setupSidecar`.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigBase, setupSidecar, toPosixPath } from './setup-sidecar.mjs';

const __filename = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = resolve(dirname(__filename), '..');
const DEFAULT_REPO_SLUG = 'Xuan52766/agy-gemini-chan';

const USER_DATA_SUBDIRS = [
  'fish-memory',
  'mood',
  'nest',
  'persona',
  'speak-up',
  'telegram',
  'xingxi',
  'runtime',
];

const OVERLAY_ENTRIES = [
  '.agents',
  'assets',
  'core',
  'hooks',
  'mcp',
  'scripts',
  'sidecar',
  'tests',
  '.gitignore',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'package.json',
  '使用手冊.md',
];

function formatBackupStamp(now = Date.now()) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function shouldSkipTempEntry(name) {
  return name.endsWith('.lock') || /\.tmp-[A-Za-z0-9_-]+$/.test(name);
}

function copyTreeFiltered(srcDir, dstDir, { skipNames = shouldSkipTempEntry } = {}) {
  if (!existsSync(srcDir)) return 0;
  let copied = 0;
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (skipNames && skipNames(entry.name)) continue;
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyTreeFiltered(src, dst, { skipNames });
    } else if (entry.isFile()) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      copied++;
    }
  }
  return copied;
}

/**
 * Backs up all personal companion data (`data/*` excluding `data/dict/`, plus optional
 * root `AGENTS.md`) before upgrading, keeping the newest `maxBackups` snapshots.
 */
export function backupUserData(
  repoRoot = DEFAULT_REPO_ROOT,
  backupBaseDir = join(resolveConfigBase(), 'backups', 'agy-gemini-chan'),
  { now = Date.now(), maxBackups = 5 } = {},
) {
  const dataRoot = join(repoRoot, 'data');
  const targets = USER_DATA_SUBDIRS.map((sub) => [join(dataRoot, sub), join('data', sub)])
    .filter(([src]) => existsSync(src));
  const localAgents = join(repoRoot, 'AGENTS.md');
  const hasAgents = existsSync(localAgents);

  if (!targets.length && !hasAgents) {
    return { skipped: true, fileCount: 0, backupDir: '' };
  }

  let backupDir = join(backupBaseDir, `upgrade-${formatBackupStamp(now)}`);
  if (existsSync(backupDir)) {
    let idx = 1;
    while (existsSync(`${backupDir}-${idx}`)) idx++;
    backupDir = `${backupDir}-${idx}`;
  }
  let fileCount = 0;
  for (const [src, rel] of targets) {
    fileCount += copyTreeFiltered(src, join(backupDir, rel));
  }
  if (hasAgents) {
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(localAgents, join(backupDir, 'AGENTS.md'));
    fileCount++;
  }

  // Prune older upgrade backups if exceeding maxBackups
  try {
    const dirs = readdirSync(backupBaseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('upgrade-'))
      .map((e) => {
        const p = join(backupBaseDir, e.name);
        return { name: e.name, path: p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => (b.mtime - a.mtime) || b.name.localeCompare(a.name));
    for (const stale of dirs.slice(Math.max(1, maxBackups))) {
      rmSync(stale.path, { recursive: true, force: true });
    }
  } catch {
    // Non-fatal backup pruning
  }

  return { skipped: false, fileCount, backupDir };
}

/**
 * Overlays updated code, assets, skills, and `data/dict/` from `srcRepoDir` into
 * `targetRepoDir` while leaving all personal `data/*` folders and root `AGENTS.md` untouched.
 */
export function applyArchiveDirectory(srcRepoDir, targetRepoDir) {
  let updatedFiles = 0;
  for (const rel of OVERLAY_ENTRIES) {
    const src = join(srcRepoDir, rel);
    const dst = join(targetRepoDir, rel);
    if (!existsSync(src)) continue;
    const st = statSync(src);
    if (st.isDirectory()) {
      updatedFiles += copyTreeFiltered(src, dst, { skipNames: (n) => n === '.git' || n === 'node_modules' });
    } else if (st.isFile()) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      updatedFiles++;
    }
  }
  const srcDict = join(srcRepoDir, 'data', 'dict');
  if (existsSync(srcDict)) {
    updatedFiles += copyTreeFiltered(srcDict, join(targetRepoDir, 'data', 'dict'));
  }
  return { updatedFiles };
}

export function readPackageVersion(repoRoot = DEFAULT_REPO_ROOT) {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), { encoding: 'utf-8' }));
    return String(pkg?.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

export async function checkRemoteLatestVersion(repoSlug = DEFAULT_REPO_SLUG, { fetchFn = fetch } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'agy-gemini-chan-updater',
  };
  const relRes = await fetchFn(`https://api.github.com/repos/${repoSlug}/releases/latest`, { headers });
  if (relRes.ok) {
    const rel = await relRes.json();
    const tag = String(rel.tag_name || '').trim();
    return {
      source: 'release',
      tagName: tag,
      version: tag.replace(/^v/i, ''),
      tarballUrl: rel.tarball_url || `https://api.github.com/repos/${repoSlug}/tarball/${tag || 'main'}`,
      htmlUrl: rel.html_url || `https://github.com/${repoSlug}/releases`,
    };
  }
  const pkgRes = await fetchFn(`https://raw.githubusercontent.com/${repoSlug}/main/package.json`, { headers });
  if (!pkgRes.ok) {
    throw new Error(`無法查詢遠端版本 (HTTP ${pkgRes.status})`);
  }
  const pkg = await pkgRes.json();
  const ver = String(pkg?.version || '0.0.0');
  return {
    source: 'main',
    tagName: `v${ver}`,
    version: ver,
    tarballUrl: `https://api.github.com/repos/${repoSlug}/tarball/main`,
    htmlUrl: `https://github.com/${repoSlug}`,
  };
}

function runGit(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function findExtractedRoot(extractDir) {
  if (existsSync(join(extractDir, 'package.json'))) return extractDir;
  for (const entry of readdirSync(extractDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sub = join(extractDir, entry.name);
    if (existsSync(join(sub, 'package.json'))) return sub;
  }
  return '';
}

export async function runUpdate({
  repoRoot = DEFAULT_REPO_ROOT,
  configDir = '',
  backupBaseDir = '',
  sourceDir = '',
  dryRun = false,
  stash = false,
  force = false,
  runTests = true,
  fetchFn = fetch,
} = {}) {
  const beforeVersion = readPackageVersion(repoRoot);
  const resolvedBackupBase = backupBaseDir || join(resolveConfigBase(configDir), 'backups', 'agy-gemini-chan');
  const isGitRepo = !sourceDir && existsSync(join(repoRoot, '.git'));

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      mode: sourceDir ? 'archive-dir' : (isGitRepo ? 'git' : 'release-tarball'),
      beforeVersion,
      backupBaseDir: resolvedBackupBase,
    };
  }

  const backup = backupUserData(repoRoot, resolvedBackupBase);
  let updateMode = '';
  let changedDetails = '';
  let stashed = false;

  if (sourceDir) {
    const resolvedSrc = resolve(sourceDir);
    if (!existsSync(join(resolvedSrc, 'package.json'))) {
      throw new Error(`指定的更新來源目錄無效（找不到 package.json）：${resolvedSrc}`);
    }
    const { updatedFiles } = applyArchiveDirectory(resolvedSrc, repoRoot);
    updateMode = 'archive-dir';
    changedDetails = `已覆蓋同步 ${updatedFiles} 個程式與資源檔案`;
  } else if (isGitRepo) {
    updateMode = 'git';
    const dirtyTracked = runGit(repoRoot, ['status', '--porcelain', '--untracked-files=no']);
    if (dirtyTracked) {
      if (!stash) {
        return {
          ok: false,
          reason: 'dirty_tracked',
          beforeVersion,
          backup,
          message: `偵測到未提交的程式碼修改，為避免衝突已停止更新。請先提交或加上 --stash 重試：\n${dirtyTracked}`,
        };
      }
      runGit(repoRoot, ['stash', 'push', '-m', `auto-stash-before-update-${Date.now()}`]);
      stashed = true;
    }

    const oldSha = runGit(repoRoot, ['rev-parse', '--short', 'HEAD']);
    const branch = runGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    runGit(repoRoot, ['fetch', 'origin', '--tags']);
    const targetRef = branch === 'HEAD' ? 'origin/main' : `origin/${branch}`;
    const pullRes = spawnSync('git', ['pull', '--ff-only', 'origin', branch === 'HEAD' ? 'main' : branch], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    if (pullRes.status !== 0) {
      throw new Error(`git pull --ff-only 失敗（${targetRef}）：${(pullRes.stderr || pullRes.stdout || '').trim()}`);
    }
    const newSha = runGit(repoRoot, ['rev-parse', '--short', 'HEAD']);
    changedDetails = oldSha === newSha ? `已位於最新提交 (${newSha})` : `${oldSha} -> ${newSha}`;
  } else {
    updateMode = 'release-tarball';
    const remote = await checkRemoteLatestVersion(DEFAULT_REPO_SLUG, { fetchFn });
    if (!force && remote.version === beforeVersion) {
      changedDetails = `目前已是最新版本 v${beforeVersion}`;
    } else {
      const stageDir = mkdtempSync(join(tmpdir(), 'gcat-update-'));
      try {
        const tgzPath = join(stageDir, 'release.tar.gz');
        const extractDir = join(stageDir, 'extracted');
        mkdirSync(extractDir, { recursive: true });
        const tarRes = await fetchFn(remote.tarballUrl, {
          headers: { 'User-Agent': 'agy-gemini-chan-updater' },
        });
        if (!tarRes.ok) {
          throw new Error(`下載新版壓縮檔失敗 (HTTP ${tarRes.status})`);
        }
        const buf = Buffer.from(await tarRes.arrayBuffer());
        writeFileSync(tgzPath, buf);
        execFileSync('tar', ['-xzf', tgzPath, '-C', extractDir], { encoding: 'utf-8' });
        const extractedRoot = findExtractedRoot(extractDir);
        if (!extractedRoot) {
          throw new Error('解壓新版壓縮檔後找不到 package.json');
        }
        const { updatedFiles } = applyArchiveDirectory(extractedRoot, repoRoot);
        changedDetails = `已下載並套用 ${remote.tagName}（更新 ${updatedFiles} 個檔案）`;
      } finally {
        rmSync(stageDir, { recursive: true, force: true });
      }
    }
  }

  let setupRes = setupSidecar({ repoRoot, configDir, force: Boolean(force) });
  if (!setupRes.ok && setupRes.status === 'exists-conflict') {
    // Try force-syncing sidecar path when upgrading into a moved folder
    setupRes = setupSidecar({ repoRoot, configDir, force: true });
  }

  let testsPassed = null;
  let testSummary = '';
  if (runTests) {
    const testDir = join(repoRoot, 'tests');
    const testFiles = existsSync(testDir)
      ? readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')).map((f) => join('tests', f))
      : [];
    if (testFiles.length) {
      const tRes = spawnSync(process.execPath, ['--test', ...testFiles], {
        cwd: repoRoot,
        encoding: 'utf-8',
      });
      testsPassed = tRes.status === 0;
      testSummary = testsPassed ? '全部驗證測試通過' : (tRes.stderr || tRes.stdout || '部分測試未通過').slice(-400);
    }
  }

  const afterVersion = readPackageVersion(repoRoot);
  return {
    ok: true,
    updateMode,
    beforeVersion,
    afterVersion,
    changedDetails,
    stashed,
    backup,
    setupStatus: setupRes.status,
    testsPassed,
    testSummary,
  };
}

function parseCliArgs(argv) {
  const opts = {
    dryRun: false,
    stash: false,
    force: false,
    runTests: true,
    help: false,
    configDir: '',
    sourceDir: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') opts.dryRun = true;
    else if (a === '--stash') opts.stash = true;
    else if (a === '--force' || a === '-f') opts.force = true;
    else if (a === '--skip-tests' || a === '--no-test') opts.runTests = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--config-dir' && argv[i + 1]) opts.configDir = argv[++i];
    else if (a === '--source-dir' && argv[i + 1]) opts.sourceDir = argv[++i];
  }
  return opts;
}

const isDirectRun =
  typeof process.argv[1] === 'string' && resolve(process.argv[1]) === resolve(__filename);

if (isDirectRun) {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      '用法: node scripts/update.mjs [選項]',
      '',
      '安全一鍵更新 agy-gemini-chan（更新前自動備份所有記憶/人設/日記/Telegram 設定）：',
      '  --dry-run, -n       預覽目前更新模式與備份路徑，不寫入任何檔案',
      '  --stash             若程式碼有本機未提交修改，自動 git stash 後再更新',
      '  --force, -f         強制下載最新 Release（非 Git 版）或強制覆寫 Sidecar 路徑',
      '  --skip-tests        更新後略過自動化測試（預設會自動驗證）',
      '  --config-dir <dir>  自訂 .gemini/config 目錄（預設 ~/.gemini/config）',
      '  --help, -h          顯示此說明',
    ].join('\n'));
    process.exit(0);
  }

  runUpdate(opts)
    .then((res) => {
      if (!res.ok) {
        console.error(`[update] ${res.message}`);
        process.exit(1);
      }
      if (res.dryRun) {
        console.log(`[dry-run] 更新方式：${res.mode} | 目前版本：v${res.beforeVersion}`);
        console.log(`[dry-run] 備份位置：${toPosixPath(res.backupBaseDir)}`);
        process.exit(0);
      }
      console.log(`[update] 更新方式：${res.updateMode} | ${res.changedDetails}`);
      console.log(`[update] 版本：v${res.beforeVersion} -> v${res.afterVersion}`);
      if (!res.backup.skipped) {
        console.log(`[update] 已自動備份 ${res.backup.fileCount} 個個人資料檔至：${toPosixPath(res.backup.backupDir)}`);
      }
      if (res.stashed) {
        console.log('[update] 提醒：已將更新前的程式碼本機修改暫存（可用 git stash pop 查看）。');
      }
      if (res.testsPassed === true) {
        console.log('[update] 驗證結果：✔ 測試全數通過');
      } else if (res.testsPassed === false) {
        console.warn(`[update] 注意：更新已完成，但部分測試未通過：\n${res.testSummary}`);
      }
      console.log('');
      console.log('接下來請完成最後一步讓背景服務載入新版：');
      console.log('1. 在 Antigravity 右側「UI Extensions」將「Gemini-chan 貓窩」關掉再重新開啟（或重載視窗）。');
      console.log('2. 若你曾於側邊欄手動儲存過規則提示詞，可檢查各模組抽屜中的「恢復預設」以取得新版規則提示。');
    })
    .catch((err) => {
      console.error(`[update] 失敗：${err?.message || err}`);
      process.exit(1);
    });
}
