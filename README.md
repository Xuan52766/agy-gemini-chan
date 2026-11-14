# agy-gemini-chan｜Gemini-chan 貓窩（Antigravity 2.0 伴侶插件系統）

<p align="center">
  <img src="./assets/geminichan/chibi_base.png" width="180" alt="Gemini-chan 貓窩 Q 版立繪" />
</p>

<p align="center">
  <strong>目前版本：<code>v1.0.0</code></strong> ・ <a href="./CHANGELOG.md">更新紀錄</a> ・ <a href="./使用手冊.md">完整使用手冊</a> ・ <a href="./LICENSE">授權條款</a>
</p>

**專為 Antigravity 2.0 生態打造的專案限定 AI 伴侶與互動貓窩系統**——透過 Antigravity 原生 **Plugin Lifecycle Hooks**、**Stdio MCP Server**、**Skills** 與 **Sidecar Aux Pane Web UI** 深度整合，不需要額外外部 AI API Key，就能在單一工作區裡為你的 Agent 帶來會淡忘的長期記憶、可感知的即時心情、八章星汐記憶卡、視覺化星座星圖，以及隨時陪伴在側邊欄的 Q 版 Gemini-chan 貓窩。

> **來源與授權聲明（必讀）**
>
> 本專案派生並改寫自以下原專案與原作者之創作，特此致謝並依各自授權條款公開分享：
> - **Yuuyuko-uu**（<https://github.com/Yuuyuko-uu>）—— 原作者開發之 DSH 伴侶插件系列，本專案依 **[Yuuyuko-uu 插件許可 1.2](./LICENSE)**（其中 `dsh-xingxi` 原倉庫為 `1.1`）進行跨平台移植與公開衍生：
>   - 長期記憶：<https://github.com/Yuuyuko-uu/dsh-fish-memory>
>   - 心情引擎：<https://github.com/Yuuyuko-uu/dsh-feiyu-mood>
>   - 星汐記憶卡與日記：<https://github.com/Yuuyuko-uu/dsh-xingxi>
>   - 主動搭話：<https://github.com/Yuuyuko-uu/dsh-speak-up>
> - **huaizhuanghub** —— 原作者開發之人設插件 **`dsh-persona-dafeiyu`**（<https://www.npmjs.com/package/dsh-persona-dafeiyu> / <https://github.com/huaizhuanghub/dsh-persona-dafeiyu>，MIT 授權），本專案參考並移植其雙層作用域人設設計。

---

## 為什麼搬到 Antigravity 2.0 生態？

**大肥魚**與那套細膩的 AI 伴侶生態原本生長在 **DSH（DeepSeek Harness）** 上；**既然要養的是 Gemini 貓貓，那她的貓窩當然就該住進 Antigravity 2.0 這裡。**

**`agy-gemini-chan`（Gemini-chan 貓窩）** 把 DSH 上這套備受喜愛的長期陪伴體驗原生對接到 **Antigravity 2.0** 的擴充架構上，透過無外部 API 的本地整合與工作區隔離設計，讓陪伴與寫程式各自安好、互不打擾：

1. **Workspace Plugin 自動探索（`.agents/plugins/gemini-cat/`）**
   開啟本專案工作區即自動載入，無需手動修改全域設定；搭配 `isProjectWorkspaceActive` 與對話白名單檢查，**嚴格限定僅在該工作區生效**，切到其他開發專案自動保持靜默。
2. **四段式 Lifecycle Hooks（`hooks/`）**
   - `SessionStart`：新對話啟動時自動載入人設、八章記憶卡、近 3 天日記、高重要度長期記憶錨點與貓窩狀態。
   - `PreInvocation`：依當輪對話線索動態召回相關記憶，附帶一次性心情語氣提示、記憶寫入提醒與未讀貓窩互動事件。
   - `PostToolUse`：即時更新側邊欄活動狀態。
   - `Stop`：當對話內尚未手動呼叫 `mood_update` 時，自動執行本地語意心情兜底。
3. **11 個原生 MCP 工具（`mcp/server.mjs` → `gemini-cat_companion`）**
   讓 Antigravity Agent 直接在對話中自主記憶與互動：`remember`、`recall`、`memory_forget`、`xingxi`、`xingxi_read`、`xingxi_append`、`xingxi_diary`、`xingxi_pickup`、`mood_status`、`mood_update`、`nest_interact`。
4. **Sidecar Aux Pane 互動面板（`sidecar/main.mjs`）**
   直接嵌在 Antigravity 2.0 右側輔窗的完整控制台：Q 版情緒立繪、飽食／精力／羈絆數值、互動按鈕與對話即時同步、星座星圖 Canvas、記憶檢索測試、心情時間線與主動搭話排程器。
5. **內建 Skills 與互動規則**
   內附 `/xingxi`（通讀與整理長期記憶卡）、`/cat-nest`（貓窩互動與心情查詢）與專案限定對話口語規範，開箱即能自然互動。

---

## 核心功能一覽

| 模組 | 能力亮點 | 實作核心 |
| :--- | :--- | :--- |
| **Q 版互動貓窩** | 對應心情與睡眠狀態切換立繪（含 `mood_great`、`chibi_base`、`mood_ok`、`mood_worry`、`mood_sad`、`mood_sleep`）；支援摸頭、餵小魚乾、逗貓棒、蓋被子／叫醒、貼貼與傳紙條；內建冷卻時間、每日次數保護與「僅在對話或互動時擺動」節奏 | [core/nest.mjs](core/nest.mjs)、[sidecar/](sidecar/) |
| **會淡忘的長期記憶** | 內建中文詞典最長匹配切詞＋說話尺 IDF、`queryGate` 過濾無意義寒暄、鮮活度指數半衰期 $H = 30 \times (1 + 2I)$、召回強化、高相似度去重與 `factKey`／`supersedes` 事實覆寫 | [core/memory.mjs](core/memory.mjs)、[core/tokenizer.mjs](core/tokenizer.mjs) |
| **零外部 API 心情引擎** | 預設 `hybrid` 混成模式：對話內 AI 主動評估（`mood_update`）為主、回合結束本地語意分析兜底；支援大心情（`0–100`）、7 維細分情緒、兩端飽和抑制與半衰期自然回穩 | [core/mood.mjs](core/mood.mjs) |
| **星汐記憶卡與星座星圖** | 嚴格八章結構 `記憶卡.md`＋`日記/YYYY-MM-DD.md`＋系統標籤清潔後的 `原始對話/`；每日 `23:30` 定時與手動「拾星」、自動 `.bak-*` 備份一鍵還原，以及五種關聯連線的互動式星圖 | [core/xingxi.mjs](core/xingxi.mjs) |
| **可自訂主動搭話** | 支援週幾、跨午夜峰谷時段、指定時區、安靜時段、冷卻時間與連沒中保底加成；預設開啟 `dryRun: true` 試運行保護，確認節奏後再一鍵啟用真實冒泡 | [core/speak-up.mjs](core/speak-up.mjs) |
| **嚴格隔離雙層人設庫** | **單一對話覆寫 ＞ 本專案共用 ＞ 內建安全中性陪伴範本**；支援側邊欄即時編輯、改名、單筆啟停、`.md`/`.txt` 匯入與 `.md` 匯出（本倉庫不附帶原作者私人人設，`data/*` 由 `.gitignore` 排除） | [core/persona.mjs](core/persona.mjs) |

---

## 新人 5 分鐘首次上手（4 步驟）

### 環境需求
- **Node.js `>= 20.0.0`**
- **Antigravity 2.0**（支援 Workspace Plugin 與 Aux Pane Sidecar）

### 步驟 1：複製專案並一鍵寫入 Sidecar 設定
```bash
git clone https://github.com/Xuan52766/agy-gemini-chan.git
cd agy-gemini-chan
node scripts/setup-sidecar.mjs
```
> - 安裝腳本會自動將目前資料夾的正斜線 `/` 路徑寫入 `~/.gemini/config/sidecars/gemini-cat-nest/sidecar.json`（Windows 為 `%USERPROFILE%\.gemini\config\sidecars\gemini-cat-nest\sidecar.json`）。
> - 安全防護：若目標檔案已存在且指向不同路徑，腳本不會直接覆蓋（加上 `--dry-run` 可只預覽不寫入；加上 `--force` 會先自動備份 `.bak-*` 再更新）。

<details>
<summary>如果想手動建立 <code>sidecar.json</code>（Windows / macOS / Linux 通用範例）</summary>

請在 `~/.gemini/config/sidecars/gemini-cat-nest/sidecar.json` 建立以下 JSON（Windows 請務必使用正斜線 `/` 或雙反斜線 `\\`）：

```json
{
  "command": "node",
  "args": ["/path/to/your/agy-gemini-chan/sidecar/main.mjs"],
  "restart_policy": "always",
  "display_name": "Gemini-chan 貓窩",
  "description": "Gemini-chan 互動貓窩側邊欄：即時情緒立繪、長期記憶庫、星汐星圖與主動搭話（僅在目前專案工作區生效）。",
  "has_web_ui": true,
  "agent_permissions": {
    "allows_user_interactions": false
  },
  "ui_config": {
    "display_name": "Gemini-chan 貓窩",
    "views": [
      {
        "path": "/",
        "entrypoint": "SIDECAR_UI_ENTRYPOINT_AUX_PANE",
        "title": "Gemini-chan 貓窩"
      }
    ]
  }
}
```

</details>

### 步驟 2：直接開啟本專案資料夾，並在 UI Extensions 打開開關
1. 在 Antigravity 2.0 **直接開啟複製下來的 `agy-gemini-chan` 資料夾本身**（⚠️ **請勿只開上一層父資料夾**；為防止外洩，安全邊界僅在本專案根目錄或其子目錄內才會啟用）。
2. 開啟 Antigravity 的 **UI Extensions** 列表，找到 **「Gemini-chan 貓窩」** 並切開開關（若剛建好設定未出現，重開視窗即可），再從側邊欄輔窗或對話點擊 `[打開 Gemini-chan 貓窩](sidecar://gemini-cat-nest/)` 開啟面板。

### 步驟 3：選定或匯入你的角色人設
本公開倉庫僅附帶一個中性的 **「預設陪伴範本（待自訂人設）」**，且**初始未預先啟用私人角色**，避免強綁定特定性格。請先：
1. 切換到右側貓窩面板的 **「人設」** 分頁。
2. 你可以直接點 **「設為本專案」** 套用內建的預設陪伴範本，或點擊新增／匯入你自己的 `.md`／`.txt` 人設提示詞。

### 步驟 4：開始對話與體驗雙向互動
- 開一個新對話直接聊天，嘗試按下貓窩面板的「摸摸頭」、「餵小魚乾」或「傳小紙條」，也可在對話中使用 `/cat-nest` 與 `/xingxi`。
- 第一次讓模型呼叫 `gemini-cat_companion` 工具（例如 `remember`、`mood_update`）時，在介面上允許一次授權即可。
- **想讓她自己找你搭話？** 主動搭話出廠預設為 **`dryRun: true`（試運行）** 以免打擾；確認好時段與節奏後，到側邊欄 **「主動搭話」** 分頁取消勾選「試運行」並儲存即可。

詳細數值公式與進階設定請參閱：**[使用手冊.md](使用手冊.md)**。

---

## 常見疑問（FAQ）

<details>
<summary><strong>1. 為什麼在 Antigravity 的全域 MCP 或 Plugins 設定頁看不到 <code>gemini-cat</code>？</strong></summary>

這是刻意設計的 **專案隔離機制**：本系統的外掛定義放在專案內的 [.agents/plugins/gemini-cat/](.agents/plugins/gemini-cat/)（非全域安裝），只有開啟本工作區時才會動態掛載 Hooks、Skills 與 MCP server（`gemini-cat_companion`）。相對地，側邊欄 Sidecar 依 Antigravity 規格登記於全域，因此在 **UI Extensions** 會看得到「Gemini-chan 貓窩」，在其他程式專案則會自動維持靜默待機。

</details>

<details>
<summary><strong>2. 把資料夾改成別的名字或搬移位置也能用嗎？</strong></summary>

可以。核心模組透過檔案位置自動解析專案根目錄（不寫死資料夾名稱）；若你搬移或改名了專案資料夾，重新執行一次 `node scripts/setup-sidecar.mjs --force` 更新 `sidecar.json` 路徑即可。

</details>

<details>
<summary><strong>3. 我的記憶、日記和私人人設會不小心推上 Git 嗎？</strong></summary>

不會。`.gitignore` 已排除 `data/*`（僅保留 `data/dict/` 公開中文詞典）與各類記錄／暫存檔，所有人設、記憶、心情時間線與原始對話都不會進入版本控制。

</details>

---

## 相較原版 DSH 插件的移植與修改摘要

為符合原許可要求，以下列出本專案相對於上述原倉庫所做的架構改造與功能調整：

1. **運行平台重構**：由 DSH / Cordis 桌面／網頁掛載架構完整移植為 Antigravity 2.0 原生 Plugin（Hooks JSON、Stdio MCP Server、Skills 與 `sidecar_sdk` Web UI），並以 `data/*`（`data/dict/` 除外）集中管理可忽略之本機私人資料。
2. **嚴格單一工作區隔離**：將原版支援跨工作區／全域切換之人設設計收斂為「單對話覆寫 ＞ 專案共用」雙層架構，並在 Hooks、MCP 與 Sidecar 推播入口加入工作區邊界與已登記對話驗證（[core/bridge.mjs](core/bridge.mjs)）。
3. **免外部 LLM API 心情評分**：將原本呼叫獨立裁判模型的方式改為在現行對話內由 Agent 呼叫 `mood_update`，搭配 `Stop` Hook 本地語意分析作為兜底。
4. **新增「貓窩」伴侶視覺與物理狀態系統**：實作獨立於心情分數之外的飽食／精力／羈絆數值、立繪切換、打盹與自然喚醒同步、以及前端互動節奏穩定性修正。
5. **星汐、主動搭話與安全安裝擴充**：新增 Antigravity transcript 系統標籤剝離、按日重置之 `水位Ms`、`.bak-*` 備份一鍵還原 API、可在 UI 自由設定的自訂峰谷時段與 `dryRun` 試運行，以及非破壞性 Sidecar 安裝腳本（[scripts/setup-sidecar.mjs](scripts/setup-sidecar.mjs)）。

---

## 開發驗證

```bash
node --test tests/*.test.mjs
```

## 授權與致謝

- 本專案之 `dsh-fish-memory`、`dsh-feiyu-mood`、`dsh-xingxi`、`dsh-speak-up` 派生部分持續遵循 **[Yuuyuko-uu 插件許可 1.2](./LICENSE)**（原作者 [Yuuyuko-uu](https://github.com/Yuuyuko-uu)）；`dsh-xingxi` 原倉庫另附 1.1 版本條款。
- 人設庫設計參考並派生自 **[huaizhuanghub / dsh-persona-dafeiyu](https://www.npmjs.com/package/dsh-persona-dafeiyu)**（MIT License）。
- 中文分詞詞典 [data/dict/](data/dict/) 沿用 [jieba](https://github.com/fxsjy/jieba) 詞表（MIT 授權，完整聲明見 [data/dict/LICENSE-dict.txt](data/dict/LICENSE-dict.txt)）。
