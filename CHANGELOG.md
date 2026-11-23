# 更新紀錄（Changelog）

本專案採用語意化版本控制（[Semantic Versioning](https://semver.org/)），版本號同步維護於 [package.json](./package.json) 與 [.agents/plugins/gemini-cat/plugin.json](./.agents/plugins/gemini-cat/plugin.json)。

## [1.4.5] - 2026-11-23

### 新增、文件合規與測試可攜性改進（Added & Changed）
- **一鍵無損安全更新系統（`scripts/update.mjs`、`scripts/setup.cmd`、`scripts/update.cmd`、`package.json` `"update"`）**：
  - 更新前自動備份 `data/fish-memory`、`data/mood`、`data/nest`、`data/persona`、`data/speak-up`、`data/telegram`、`data/xingxi`、`data/runtime` 與根目錄 `AGENTS.md` 至 `~/.gemini/config/backups/agy-gemini-chan/upgrade-<時間戳>/`（排除 `.lock` 與 `.tmp-*` 並最多保留最新 5 份）。
  - 同時支援 Git（`git pull --ff-only`／`--stash`）與免 Git 壓縮檔（ZIP 安裝自動下載 GitHub 最新 Release Tarball，僅覆蓋程式碼、資源與 `data/dict/`，絕對不動個人 `data/*` 與 `AGENTS.md`）；完成後自動重整 Sidecar 外掛路徑並執行 `node --test tests/*.test.mjs` 驗證。
  - 新增純 ASCII `scripts/setup.cmd` 與 `scripts/update.cmd`，解決 Windows 環境下 PowerShell 腳本執行原則封鎖 `npm.ps1` 的安裝／升級障礙。
- **授權條款合規與新手上手文件全面改寫（`README.md`、`.agents/plugins/gemini-cat/README.md`）**：
  - 依 `Yuuyuko-uu 插件許可 1.2` 第 5 條將原作者 `Yuuyuko-uu` 署名、四項原倉庫網址與主要改動摘要置於 `README.md` 首屏；補齊「初次使用必看 3 件事」（手動啟用中性／自訂人設、`dryRun: true` 預設與 `mcp(gemini-cat_companion/*)` Allow 授權設定）、完整 13 項 MCP 工具（含 `telegram_send`）與 Telegram 雙向橋接安全指南。
- **測試沙盒可攜性與更新器驗證補齊（`tests/core.test.mjs`、`tests/hooks-mcp-sidecar.test.mjs`）**：
  - 針對不允許建立 NTFS junction 的受限環境優雅處理 `EPERM`/`EACCES` 診斷（保留其餘路徑安全與防偽造斷言不減弱），並新增 `backupUserData`、`applyArchiveDirectory`、`runUpdate` 與 `checkRemoteLatestVersion` 整合測試。

## [1.4.4] - 2026-11-22

### 安全性、資料一致性與介面穩定性修正（Fixed & Security）
- **跨行程獨佔檔案鎖與狀態寫入安全（`core/storage.mjs`、`core/bridge.mjs`、`core/mood.mjs`、`core/telegram.mjs`）**：
  - 新增純 Node 獨佔檔案鎖 `withFileLockSync`／`updateJsonLocked` 與 `writeTextAtomic` 3 次重新命名重試（Windows 短暫檔案鎖容錯），消除 Hooks、Sidecar 輪詢與 60 秒排程並發寫入時的狀態覆蓋競態。
  - 重構 `handleTelegramUpdatesBatch`、`flushTelegramOutbox`、`maybeQueueTelegramOutgoing`、`applyMoodDelta`、`consumeMoodInjection` 與 `registerProjectConversation`，避免橫跨 `await` 後以舊快照覆寫最新狀態。
- **Telegram 防偽造、防外洩與測試端點收緊（`core/telegram.mjs`、`core/bridge.mjs`、`hooks/lib.mjs`、`sidecar/routes.mjs`）**：
  - 新增 `neutralizeTelegramMarkers` 跳脫外部訊息夾帶的內部標記與標籤，並新增 `unwrapSidecarSystemEnvelope`（`core/storage.mjs`）剝除 `Antigravity` 真實紀錄的 `<SYSTEM_MESSAGE>`／`[Message] ... content=` 外殼，讓 `classifyInputSource`、`isSidecarInputStep`（忽略 `SYSTEM_SDK` 注入）與 `syncTelegramHistoryFromTranscript` 在前綴精準比對下不會跳過 Telegram／主動搭話輪次或誤鏡像舊電腦提問。
  - 強化 `isAllowedTelegramSendPath`：以 `realpathSync.native` 驗證實體路徑防止 symlink／junction 逃逸；擴大封鎖私鑰與憑證檔（`.pem`/`.key`/`.p12`/`.pfx`/`id_rsa*`/`id_ed25519*`/`.npmrc`/`.pypirc`/`.git-credentials`/`credentials*.json`/`data/**/config.json`）；限制 `brain` 目錄僅允許圖片、音訊、影片與文件產物。
  - 配對碼改用 `crypto.randomInt`，並針對每個 `chatId` 加上 `/bind` 失敗 5 次鎖定 15 分鐘防暴力嘗試；`POST /api/telegram/test` 在單帳號已鎖定綁定後僅允許對已綁定 `Chat ID` 傳送純文字測試（拒絕 `filePath`）。
- **Sidecar XSS 修復、唯讀與條件輪詢（`sidecar/routes.mjs`、`sidecar/app.js`、`sidecar/index.html`、`sidecar/styles.css`）**：
  - 修正記憶召回追溯列表（`traceBox`）未經 `esc()` 跳脫的 XSS 風險，並補齊 `esc()` 單引號（`&#39;`）跳脫。
  - 移除 `GET /api/state` 寫入 `sessions.json` 的副作用；新增輕量 `GET /api/version` 條件輪詢與背景頁籤 10 秒降頻；清理 `sync-history` 嚴格比對當前對話。
  - 補上按鈕防連點鎖定、失敗 Toast 提示、斷線狀態膠囊、外部工作區完整停用寫入元件、刪除／還原／重設 3 秒兩段式確認、未儲存分頁圓點與 `beforeunload` 提醒、`prefers-reduced-motion` 與主題快取最佳化。
- **文件與版本一致（`mcp/server.mjs`、`.agents/plugins/gemini-cat/rules/AGENTS.md`、`CHANGELOG.md`、`README.md`）**：
  - 更新 MCP 預設 fallback 版本字串、補上 Rule 0 `telegram_send` 禁令與正確指出首輪 `PreInvocation` 注入。

## [1.4.3] - 2026-11-21

### 修正（Fixed）
- **多資料夾工作區隔離強化（`core/storage.mjs`、`.agents/plugins/gemini-cat/rules/AGENTS.md`）**：
  - `isProjectWorkspaceActive` 改為嚴格檢查非空 `workspaceList` 的**第 1 個（主要）工作區**是否屬於 `gemini_cat`（僅在 `workspaceList` 為空時才退回檢查 `cwd`）。
  - 當其他專案為主工作區、`gemini_cat` 僅作為第 2 個參考資料夾掛載時（例如 `[dsh_plugin/, gemini_cat/]`），所有 Hooks 保持完全靜默不載入貓貓人設或寫入紀錄，側邊欄亦正確標示外部工作區待機；同步補上 `AGENTS.md` 多資料夾防誤觸規則，防止未經 Hook 注入時誤觸 MCP 工具。

## [1.4.2] - 2026-11-21

### 新增功能（Added）
- **鏡像電腦端提問＋單一帳號綁定鎖定（`core/telegram.mjs`、`hooks/stop.mjs`、`sidecar/`）**：
  - **電腦端完整問答同步（`forwardDesktopUserMessages`）**：開啟電腦視窗聊天鏡像時，於 `Stop` hook 依嚴格先後順序把你在 `Antigravity` 送出的提問（`💬 你（電腦端）：...`）與貓貓回覆一併送到 `Telegram` 與側邊欄「TG 來回對話視窗」（遵守 `skip`/`silent` 靜音設定，可獨立開關控制是否附上提問）。
  - **單一帳號綁定鎖（`lockSingleChat` / 預設開啟）**：完成首次綁定後，自動阻擋任何第二支 `Telegram` 帳號透過 `/bind` 產生或追加綁定，除非在側邊欄手動清空原 `Chat ID` 或關閉鎖定。

## [1.4.1] - 2026-11-21

### 新增與改進（Added & Changed）
- **電腦端活躍自動靜音 Telegram（`core/telegram.mjs`、`core/bridge.mjs`、`hooks/pre-invocation.mjs`、`hooks/stop.mjs`、`sidecar/`）**：
  - 在 `Antigravity` 桌面視窗正在對話時，自動於可設定分鐘數內（預設 `15` 分鐘）抑制非 `Telegram` 觸發的推播（包含桌面鏡像、貓貓主動搭話／定時提醒與拾星摘要）。
  - 支援兩種靜音方式：`不發送（skip）` 完全略過，或 `無聲送達（silent / disable_notification: true）` 低調送達手機不響鈴震動；若主人在窗期內改從 `Telegram` 發言（`lastReceivedAt > lastDesktopSpeechAt`），立刻自動解除靜音，直接從 `Telegram` 發問的回覆亦永遠正常傳回。
- **Telegram 對話同步視窗與舊紀錄回補（`core/telegram.mjs`、`sidecar/`）**：
  - 修正真實 `Antigravity` `transcript` 中 `<SYSTEM_MESSAGE>` 尾標截斷與來訊提示詞字眼；於狀態與快照維護最近 `40` 筆雙向來回紀錄（`chatHistory`）。
  - 於側邊欄「TG」分頁新增「Telegram 來回對話視窗」與一鍵「從目前對話紀錄補抓舊 Telegram 訊息」按鈕（`POST /api/telegram/sync-history` / `syncTelegramHistoryFromTranscript`），讓離線或錯過的手機 ↔ 電腦對話可在側邊欄集中檢視。
- **介面文案釐清（`sidecar/index.html`）**：
  - 統一區分「`Telegram 端`／`Antigravity 視窗`／`本機`」，並明確拆清「接收訊息進對話」與「下載附件存檔」的開關責任。

## [1.4.0] - 2026-11-21

### 新增功能（Added）
- **Telegram 雙向橋接與安全檔案傳輸（`core/telegram.mjs`、`sidecar/`、`hooks/`、`mcp/server.mjs`）**：
  - **免公網、免額外外部 API 金鑰的雙向轉發**：利用 Node 20+ 原生 `fetch`／`FormData`／`Blob` 以 Long Polling（`getUpdates`）連接 Telegram Bot，並透過 `sidecar_sdk` `sendMessage` 與 `Stop` Hook `outbox` 佇列將手機 Telegram 輸入與貓貓在 Antigravity 內的回覆雙向串接（不卡 15 秒 Hook 逾時）。
  - **完整雙向圖片與檔案傳輸**：
    - 傳入（Telegram → 電腦）：支援單張或多圖合輯（`media_group_id`）、文件、音訊、語音與影片自動下載至隔離收件匣 `data/telegram/inbox/YYYY-MM-DD/`，連同文字透過 `[TELEGRAM_INCOMING]` 推進對話，並同步觸發記憶召回、未回計數歸零與睡眠喚醒。
    - 傳出（電腦 → Telegram）：新增 MCP 工具 `telegram_send`（可主動傳送圖片或檔案），且在回覆包含安全的 `file://` 本機圖片／檔案連結時可自動偵測一併轉傳（`autoSendReplyFiles`），自動避開重發剛上傳的 `inbox` 原檔或同輪 MCP 已傳檔案。
  - **安全防護、白名單配對與側邊欄控制頁（「TG」分頁）**：
    - 支援一鍵產生 10 分鐘臨時 6 碼配對指令（`/bind <CODE>`）自動綁定白名單 `allowedChatId`；Bot Token 僅儲存在不進 Git 的 `data/telegram/config.json`，快照與介面全面遮罩不回傳明文。
    - 嚴格限制可外傳路徑僅限 `gemini_cat` 專案、Antigravity 生成媒體暫存與明確自訂資料夾（永久封鎖設定檔、執行期工作階段、`.env`、`.git` 與內部紀錄檔）。
    - 新增「TG」側邊欄分頁與可獨立調整開關：總開關、接收轉入、回覆轉回、桌面視窗回覆鏡像、主動搭話推播、每日拾星通知、自動下載與自動回傳附檔。

## [1.3.3] - 2026-11-21

### 新增功能與微調（Added & Changed）
- **智能不打擾煞車機制與高積極度自主排程（`core/speak-up.mjs`、`hooks/pre-invocation.mjs`、`mcp/server.mjs`、`sidecar/`）**：
  - **`speak_up_plan` 新增自主勿擾控制（`silence` / `clear_silence` / `silenceUntilTrigger`）**：貓貓在睡前排叫醒提醒、察覺主人正在忙碌或連續未回時，可直接靜悄悄設定勿擾到點，不再發送「我不吵你了」的矛盾提示訊息；明確 `reminder` 到點仍準時觸發。
  - **擲骰遵守活躍聊天防打擾（`diceBlockActiveChat`）**：防止累積 `missBonus` 在剛聊完幾分鐘內（`< respectActiveChatGapMin`）繞過降權插話。
  - **待辦／叫醒提醒前自動壓制擲骰（`suppressDiceBeforeReminder`、`suppressBeforeReminderMin`）**：睡前約好早上叫醒、或即將到明確提醒前（預設 `120` 分鐘內），自動壓制中間的隨機擲骰。
  - **已讀未回連發上限與退避冷卻（`maxUnansweredSpontaneous` / 預設 `2`）**：連發未獲回覆時自動拉長冷卻並於達上限後暫停隨機／自主冒泡，直到主人重新開口發言（`PreInvocation` 自動重設，側邊欄亦提供「重設未回」按鈕）。
  - **拉高貓貓自主排程積極度（`scheduleTendency`: `high`/`normal`/`low` + `proactiveCueEnabled`）**：預設 `high` 主動傾向搭配轉折語意（去睡／忙別的事／出門／晚點聊等）即時 1 行情境提醒，引導長對話裡也積極運用 `speak_up_plan`（`autonomous` + `silence`）。
- **說話去 AI 套路與真人口吻優化（`core/speak-up.mjs`、`core/nest.mjs`、`sidecar/routes.mjs`、`.agents/plugins/gemini-cat/rules/AGENTS.md`）**：
  - 調整主動搭話背景時間線與預設念頭，解除強制報時與二選一猜測起手式；減少貓窩互動的重複感謝收據口吻。
  - 調整 `saveSpeakUpConfig` 保留未自訂預設範本的動態追蹤（`""`），避免儲存其他設定時鎖死舊版預設提示詞。

## [1.3.2] - 2026-11-21

### 新增功能與微調（Added & Changed）
- **心情每日變化上限、提醒不限次數與靈敏度除數全面可調**（`core/mood.mjs`、`mcp/server.mjs`、`sidecar/`）：
  - **每日心情變化次數上限（`changesPerDay` / `#cfg-mood-changesPerDay`）**：預設 `0`（不限次數），可自由設定 `1–500` 限制每天最多幾次數值變動；達上限後仍可記錄第一人稱 `innerThought`（且不阻擋手動 `+3/-3` 微調）。
  - **每日主動提醒注入上限與無上限開關（`injectPerDay`、`injectUnlimited` / `#cfg-mood-injectUnlimited`）**：提醒上限自原本 `0–50` 擴寬至 `0–500`，並新增「每日主動提醒不限次數」開關。
  - **變動靈敏度除數（`stepDivisor` / `#cfg-mood-stepDivisor`，1–5，預設 `3`）**：解決原本寫死 `/ 3` 導致對話內給 `moodDelta: ±1` 時被四捨五入吃成 `0`、看起來像心情分數卡住的問題；調成 `1` 即可 `1:1` 立即反映每點情緒起伏。

## [1.3.1] - 2026-11-20

### 問題修正（Fixed）
- **修正舊有對話未自動刷新 `v1.3.0` 新版規則導致仍呼叫系統 `schedule` 與忽略 `innerThought` 的問題**（`hooks/pre-invocation.mjs`、`core/speak-up.mjs`、`core/mood.mjs`）：
  - 修正 `PreInvocation` 在遇到升級前已存在、`hasInjectedStaticRules: true` 但尚無 `injectedRulesHash` 的舊對話時，`rulesChanged` 誤判為 `false` 而跳過注入新規則、卻直接覆寫 `injectedRulesHash` 的漏洞；同時更新雜湊基準（`rules-v2`）讓已開啟的既有對話也能在下一輪自動補齊最新指引。
  - 在 `buildDefaultSpeakUpRulePrompt` 與 `buildDefaultMoodRulePrompt` 明確加入 Lazy MCP（`call_mcp_tool` → `gemini-cat_companion`）參數範例，並明確禁止以系統內建 `schedule` 計時器取代 `speak_up_plan`。

## [1.3.0] - 2026-11-20

### 新增功能（Added）
- **第一人稱心情「內心小劇場 (`innerThought`)」與專屬呈現卡片**（`core/mood.mjs`、`mcp/server.mjs`、`sidecar/`）：
  - `mood_update` 新增可選欄位 `innerThought`，讓貓貓依人設口氣在對話內順手記下第一人稱真實心聲（支援即使數值不變動 `moodDelta=0` 時也能純寫心聲；且本地正則兜底與自然衰減絕不偽造第一人稱獨白）。
  - 側邊欄「心情」分頁上方新增 **「貓貓此刻心裡在想…」** 專屬引述卡，情緒時間線同步呈現每刻心聲，同時維持對話泡泡本身零旁白的一對一聊天體驗。
- **自然語言主動搭話排程 (`speak_up_plan`)、多時間佇列與固定波動節律**（`core/speak-up.mjs`、`mcp/server.mjs`、`sidecar/`）：
  - 新增第 12 個 MCP 工具 **`speak_up_plan`**（替代易因重啟消失的系統通用計時器），支援在對話中依自然語言安排 **單次預約（`schedule`）**、**一串批次時間點（`schedule_batch`）**、**固定每日／週幾基準時間 ± 隨機波動半徑（`add_routine` / `update_routine`，如 `12:30 ±20 分` 自動在 `12:10–12:50` 間抽點）**，以及以口語調整開關與安靜時段（`set_config`）。
  - 明確提醒（`reminder`）與自主關心（`autonomous` / `routine`）自動分流：自主關心遇剛聊完沒多久（`respectActiveChatGapMin`）會智慧順延避免唐突；明確提醒時間到準點觸發。
  - Sidecar 60 秒輪詢升級為 `executeSpeakUpTick`，優先精準執行到期預約／波動節律。
- **全模組自由開關與提示詞可編輯微調**（`core/storage.mjs`、`core/mood.mjs`、`core/memory.mjs`、`core/speak-up.mjs`、`hooks/pre-invocation.mjs`、`sidecar/`）：
  - 新增獨立開關：`cfg-mood-innerThoughtEnabled`（內心獨白開關）、`sp-aiPlanEnabled`（AI 自主預約／波動節律開關）、`sp-diceEnabled`（傳統峰谷隨機擲骰補位開關），搭話支援「雙開混合 / 純 AI 排程 / 純擲骰 / 全關」四種模式自由即時切換。
  - 心情、記憶、搭話（排程規則、預設念頭、醒來接續提示詞）共 **5 組對話內提示詞** 全面開放於側邊欄直接編輯、即時追蹤預設範本並附一鍵「恢復預設」；`PreInvocation` 透過 `injectedRulesHash` 自動偵測提示詞或開關變動，僅在修改後的下一輪單次重新注入，平時維持 0 膨脹。

## [1.2.1] - 2026-11-18

### 問題修正（Fixed）
- **修正新對話未收到人設、星汐記憶卡與近期日記的問題**（`hooks/session-start.mjs`、`hooks/pre-invocation.mjs`、`core/bridge.mjs`）：
  - 經實機對話紀錄驗證，Antigravity 2.0 並不會將 `SessionStart` 回傳的 `injectSteps` 插入對話軌跡中；原先 `session-start.mjs` 又提前標記了 `injectedPersonaHash`，導致第 1 輪 `PreInvocation` 誤判已注入而跳過人設。
  - 現改為由 `SessionStart` 僅負責初始化星汐檔案、登記專案對話狀態（不預先鎖定 `injectedPersonaHash`）與更新貓窩活動狀態；改由每個對話第 1 輪 `PreInvocation`（含缺少 `hasInjectedStartupContext` 的舊對話補救）保證注入 **人設＋星汐記憶卡＋近 3 日日記＋重要核心記憶＋心情基底＋貓窩即時狀態與工具規則**，後續輪次依然只注入動態差量，維持零膨脹 Token 最佳化。
- **修正全域外掛 `hooks.json` 在 Windows 路徑含引號導致外部工作區報錯問題**（`scripts/setup-sidecar.mjs`）：
  - Antigravity 執行全域外掛（`~/.gemini/config/plugins/gemini-cat/hooks.json`）時會將命令參數視為相對於外掛目錄的路徑，造成 `node "F:/..."` 被拼成無效模組路徑並報 `Cannot find module`。
  - `npm run setup`（`setup-sidecar.mjs`）現在會在外掛目錄下生成輕量 ESM 轉發腳本（`hooks/*.mjs`）並於 `hooks.json` 使用無引號相對路徑 `node hooks/*.mjs`，同時保留嚴格的 `ensureInProjectScope` 專案邊界防護，於其他工作區可無錯安靜略過。

## [1.2.0] - 2026-11-18

### 架構與體驗升級（Added & Changed）
- **完整 Plugin ＋ Sidecar 單一化打包與左紅右黃異色瞳圖示**（`.agents/plugins/gemini-cat/`、`scripts/setup-sidecar.mjs`）：
  - 新增插件專屬 `logo.svg`（左紅 `#EA4335`、右黃 `#FBBC05` 異色瞳貓貓＋星星髮夾，致敬 Google 前兩個 `o` 配色）、插件說明頁 `README.md` 與內建 `sidecars/gemini_cat_nest/sidecar.json`。
  - `npm run setup`（`scripts/setup-sidecar.mjs`）現在會將插件與 Sidecar 統一同步至 `~/.gemini/config/plugins/gemini-cat/`（並自動清理舊版獨立 `~/.gemini/config/sidecars/gemini-cat-nest`），支援於 **Customizations → Plugins** 一鍵開關整個插件與側邊欄，同時維持跨專案 0 規則外洩與 0 Token 干擾。
- **貓窩（Cat Nest）數值與陪伴架構改版**（`core/nest.mjs`、`sidecar/index.html`、`sidecar/app.js`、`mcp/server.mjs`）：
  - 移除隨時間倒扣的「飽食 / 精力」生存懲罰機制與每輪固定狀態洗版，改為 **「心情（0–100） / 羈絆進度（Lv.X · 0–50） / 今日陪伴（今日互動次數與暖度 0–100%）」** 三欄設計。
  - 保留全部 5 個照護按鈕（摸頭、餵小魚乾、逗貓棒、貼貼、打盹／叫醒）與傳小紙條，移除「吃太飽拒食」與「精力過低拒玩」限制，並將冷卻時間調降至 `5–12` 秒、每日互動額度調升至 `10–15` 次。
  - 新增 **「每日多元陪伴加成」**：單日內達成 **3 種不同照護動作** 時，自動額外獎勵 **羈絆 `+5`**。
- **同步 `dsh-fish-memory` v1.6.2–v1.6.3 檢索與防重複機制**（`core/tokenizer.mjs`、`core/memory.mjs`、`sidecar/`）：
  - **專有名詞滑動切詞（`補專名`）**：對連續 2～4 個詞典外單字（如「星礫」「雲喵」）自動建立多字詞 token，避免單字過濾時漏掉專有名詞。
  - **同條記憶防重複注入窗（`repeatWindow`，預設 `15` 輪）**：剛注入過的記憶在接下來 15 輪使用者對話內不再重複塞入，節省上下文名額與 Token。
  - **常駐檔案單輪上限（`factCap`，預設 `1` 條）與原句嚴格門檻**：`stable_profile` 條目需命中 $\ge 2$ 個實詞（含至少 1 個罕見詞）或單一專有名詞才放行。
  - **同分排序優化（`比召回`）**：當關聯度 `C` 同分（精確至小數第 3 位）時，優先排命中詞數 `hitN` 與命中總字長 `hitLen`。
- **同步 `dsh-feiyu-mood` v0.9.4–v0.9.6 情緒主體保護**（`core/mood.mjs`、`mcp/server.mjs`）：
  - `mood_update` 與情緒判定新增 `subject`（`owner | self | other | none`）：當對話主題為外人八卦或無關雙方的閒聊（`other` / `none`）時，強制將 `moodDelta` 歸零並壓制負向情緒維度，避免聊別人的事拉低伴侶心情。
- **同步 `dsh-xingxi` v0.3.6–v0.3.8 拾星差量追加與錯過補跑**（`core/xingxi.mjs`）：
  - **同日二次拾星差量追加**：`原始對話/YYYY-MM-DD.txt` 改按已存在行比對差量寫入，解決同日第二次切料因開頭相同而被整段略過的問題。
  - **錯過定時自動補跑**：若已啟用定時拾星且 `lastScheduledDate` 非空並早於昨天，輪詢時自動補跑昨天的拾星歸檔，無須等到當晚定時點。
  - **帳本進度自動對齊真實日記**：若 `日記/YYYY-MM-DD.md` 已存在 $\ge 40$ 字有效正文且晚於 `.xingxi.json` 的 `已整理到`，自動推進帳本日期。

### 問題修正與 Token 最佳化（Fixed）
- **大幅降低對話 Token 消耗（消除每輪與工具呼叫重複注入）**（`hooks/lib.mjs`、`hooks/pre-invocation.mjs`、`hooks/session-start.mjs`、`core/bridge.mjs`）：
  - 以 `injectedPersonaHash` 追蹤對話已注入的人設版本；人設與靜態規則僅在 `SessionStart`（或側邊欄中途切換／編修人設）時注入一次，不再每輪重複往 `transcript.jsonl` 累加 4,500 字人設。
  - 新增 `inspectTranscriptTail(transcriptPath)`：精確攔截工具呼叫後的同輪續行（`PLANNER_RESPONSE` / `GENERIC`），並辨識 `sidecar.sendMessage` 寫入的 `SYSTEM_MESSAGE`（`[SPEAK_UP_INTERNAL]`、`[XINGXI_AUTO_PICKUP]`、`[CAT_NEST_EVENT]`），防止主動搭話輪誤重置 `lastUserSpeechAt` 或在 `Stop` 重複拿舊訊息評分。
  - 收緊對話內 `mood_update` 觸發條件（僅在明確情緒事件時呼叫工具，微幅波動交由輪末 0 Token 的 `Stop` 鉤子處理），減少不必要的第二次模型推理呼叫。

## [1.1.0] - 2026-11-15

### 新增功能（Added）
- **星汐 3D 記憶宇宙星圖（`MEMORY UNIVERSE`）與「年輪」時間軸**（對齊 `dsh-xingxi` v0.3.2）：
  - 由原本的 2D 平面環狀圖全面升級為 60fps 3D 球體記憶宇宙（`sidecar/app.js`、`sidecar/index.html`、`sidecar/styles.css`）：球心坐鎮「我是誰」暖金日冕核心星，內核球殼配置八章記憶卡，外層球殼按時間先後排列日記與帶事件日期（`eventDate`）的記憶星點。
  - 採用 64×64 離屏珠光貼圖、雙層呼吸星雲與 360 顆視差星塵；支援滑鼠拖曳 3D 旋轉、平時緩慢自轉、滾輪縮放、懸停浮動卡片預覽、鄰居隔離高亮與「共詞橋」共享關鍵詞膠囊顯示。
  - 新增底部 **「年輪」時間軸**（`▶`/`Ⅱ` 9 秒自動播放、進度滑桿、日期進度徽章與 `↺` 一鍵回到全部記憶）。
- **心情引擎新增第 8 維「生氣（angry）」與 45 分鐘快消氣半衰期**（對齊 `dsh-feiyu-mood` v0.9.0–v0.9.3）：
  - 新增第 8 維情緒 `angry`（生氣，嚴格限定「只對事不對人」，如事情卡住、白忙一場或替對方抱不平），半衰期設為 **45 分鐘**（比其他 7 維的 90 分鐘快一倍消氣）。
- **長期記憶自訂檢索詞與單字噪音過濾**（對齊 `dsh-fish-memory` v1.5.4–v1.6.1）：
  - `remember` 與記憶編輯新增 `keywords` 自訂檢索詞支援，且 `importance: 1` 自動歸入 `stable_profile`。
  - 檢索與資訊量門檻新增「單字一律不當檢索線索」過濾（除非整句問句僅由單字組成），大幅減少常用單字造成的假命中。
- **主動搭話 `<speak-up>` 閉合標籤包裹**（對齊 `dsh-speak-up` v0.3.2）：
  - `wrapInnerThought` 改以 `<speak-up>...</speak-up>` 閉合區塊包裹內心念頭與時間提示，防止模型將相鄰上下文誤判為念頭本體。

### 問題修正（Fixed）
- **修復 `stable_profile`（`importance: 1`）記憶在 `recall` 時被過濾掉無法召回的問題**（同步上游 `dsh-fish-memory` v1.6.1 Issue #38 修正）。
- **修復每日心情注入額度滿時 Sidecar 預覽狀態誤顯示為 `said` 的問題**：額度達上限時不再提前覆寫 `injectedFor`，確保預覽如實顯示 `blocked`。
- **下調日常問候的本地心情正偏置**（同步上游 `dsh-feiyu-mood` v0.8.5）：避免早安／晚安等例行問候隨時間把心情一路推到滿分。
- **修復星汐定時拾星與原始對話切存的多項邊界問題**（同步上游 `dsh-xingxi` v0.2.4 / v0.3.0 / v0.3.2）：
  - 修改拾星排程設定時，若時間與模式未變，不再清空當日 `lastScheduledDate`。
  - 定時拾星改於 `sender()` 實際送出整理提示成功後才標記 `lastScheduledDate`。
  - `原始對話/YYYY-MM-DD.txt` 追加前加入原文冪等比對與單輪去重，防止中斷重試時重複寫入同一段對話。
  - `xingxi_append` 對第二章傳入 `wholeChapter: true` 觸發 `< 70%` 防縮水保護時，自動降級為單條追加（`appendToChapter`），避免直接丟失新增語錄。

## [1.0.0] - 2026-11-14

### 初始公開版（Antigravity 2.0 移植與整合）
- **Antigravity 2.0 原生擴充架構整合**：
  - `.agents/plugins/gemini-cat/` 工作區 plugin 自動發現（四段式 `hooks.json`、Stdio MCP `companion`、規則與 `/xingxi`、`/cat-nest` Skills），全部使用可攜式相對路徑。
  - `mcp/server.mjs` 提供 11 個原生 MCP 工具（`remember`、`recall`、`memory_forget`、`xingxi`、`xingxi_read`、`xingxi_append`、`xingxi_diary`、`xingxi_pickup`、`mood_status`、`mood_update`、`nest_interact`）。
  - `sidecar/main.mjs` 與 `sidecar/` 提供 Antigravity 右側 Aux Pane 互動面板與即時狀態同步。
- **五大核心模組 porting 與擴充**：
  - 移植自 **Yuuyuko-uu** 的 `dsh-fish-memory`、`dsh-feiyu-mood`、`dsh-xingxi`、`dsh-speak-up`（遵循 [Yuuyuko-uu 插件許可 1.2](./LICENSE)）。
  - 參考並移植 **huaizhuanghub** 的 `dsh-persona-dafeiyu`（MIT）人設管理設計，改寫為「單一對話覆寫 ＞ 專案共用 ＞ 內建安全中性陪伴範本」雙層隔離模式。
  - 新增 **Gemini-chan 貓窩**（`core/nest.mjs` & `assets/geminichan/`）物理狀態、立繪對應與睡眠喚醒同步，並導入 `hybrid` 零外部 API 心情評估。
- **安全安裝與資料隔離**：
  - 新增非破壞性安裝腳本 `scripts/setup-sidecar.mjs`（支援 `--dry-run` 與 `--force` 自動 `.bak-*` 備份）。
  - `.gitignore` 隔離所有本機 `data/*` 個人資料（`data/dict/` 詞典除外）。
