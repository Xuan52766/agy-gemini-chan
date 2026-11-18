# 更新紀錄（Changelog）

本專案採用語意化版本控制（[Semantic Versioning](https://semver.org/)），版本號同步維護於 [package.json](./package.json)、[.agents/plugins/gemini-cat/plugin.json](./.agents/plugins/gemini-cat/plugin.json) 與 [mcp/server.mjs](./mcp/server.mjs)。

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
  - **專有名詞滑動切詞（`補專名`）**：對連續 2～4 個詞典外單字（如「糯鯨」「奈奈」）自動建立多字詞 token，避免單字過濾時漏掉專有名詞。
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
