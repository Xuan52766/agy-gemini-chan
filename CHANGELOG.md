# 更新紀錄（Changelog）

本專案採用語意化版本控制（[Semantic Versioning](https://semver.org/)），版本號同步維護於 [package.json](./package.json)、[.agents/plugins/gemini-cat/plugin.json](./.agents/plugins/gemini-cat/plugin.json) 與 [mcp/server.mjs](./mcp/server.mjs)。

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
