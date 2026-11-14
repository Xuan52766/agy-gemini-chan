# Gemini-chan 貓窩伴侶系統（Antigravity 專案限定版）

> **來源與授權聲明（必讀）**
>
> 本專案派生自原作者 **[Yuuyuko-uu](https://github.com/Yuuyuko-uu)** 所開發的 DSH（DeepSeek Harness）系列伴侶插件，並依 **[Yuuyuko-uu 插件許可 1.2](./LICENSE)**（其中 `dsh-xingxi` 原倉庫為 1.1）進行跨平台移植、重構與公開衍生分享。
>
> **原倉庫出處**：
> - 長期記憶：<https://github.com/Yuuyuko-uu/dsh-fish-memory>
> - 心情引擎：<https://github.com/Yuuyuko-uu/dsh-feiyu-mood>
> - 星汐記憶卡與日記：<https://github.com/Yuuyuko-uu/dsh-xingxi>
> - 主動搭話：<https://github.com/Yuuyuko-uu/dsh-speak-up>
> - 人設設計概念：參考 `Yuuyuko-uu` 的 DSH 伴侶插件套件生態（`dsh-persona-dafeiyu` 雙層人設／伴侶系統規範）

本專案僅在 **本工作區（`gemini_cat` 根目錄）** 內生效，透過 Antigravity Plugin Hooks、Stdio MCP Server 與 Sidecar Web UI 運行，零外部 AI API 依賴。

> 完整操作方式、數值公式與每日排程說明請見：**[使用手冊.md](使用手冊.md)**

## 相較原版 DSH 插件的主要修改與擴充

1. **平台適配（DSH / Cordis → Antigravity）**
   - 將原版 Cordis 掛載與 UI 改寫為 Antigravity Plugin 架構（[hooks.json](.agents/plugins/gemini-cat/hooks.json)、[mcp_config.json](.agents/plugins/gemini-cat/mcp_config.json)、[mcp/server.mjs](mcp/server.mjs)、[sidecar/main.mjs](sidecar/main.mjs)），與 `data/*`（`data/dict/` 除外）本機私人資料目錄分離並透過 `.gitignore` 隔離。
2. **嚴格單一工作區隔離 & 雙層人設（[core/persona.mjs](core/persona.mjs)、[core/storage.mjs](core/storage.mjs)）**
   - 移除跨專案全域人設層，僅保留「單一對話覆寫 ＞ 本專案共用 ＞ 安全中性陪伴範本」，防止人設與記憶外洩到其他開發專案。
   - 所有 Hook、MCP 與 Sidecar 推播皆經 `isProjectWorkspaceActive` 與 [core/bridge.mjs](core/bridge.mjs) 檢查。
3. **零外部 API 混成心情系統（[core/mood.mjs](core/mood.mjs)）**
   - 保留原版基準 `70`、步長 `/3`、極端區間減半飽和、7 維情緒、指數衰減與一次性語氣注入公式；將背景額外 LLM 裁判改寫為 **「對話內 AI 呼叫 `mood_update`（主力）＋ `Stop` Hook 本地語意分析（兜底）」** 的 `hybrid` 免金鑰模式。
4. **星汐清理、按日重置水位與備份還原（[core/xingxi.mjs](core/xingxi.mjs)）**
   - 實作 Antigravity transcript 系統標籤剝離匯出（`原始對話/YYYY-MM-DD.txt`）、按日作用域重置 `水位Ms`、第 2 章整章合併防縮水保護，以及修改前自動 `.bak-*` 備份與一鍵還原。
5. **主動搭話自訂峰谷時段（[core/speak-up.mjs](core/speak-up.mjs)）**
   - 在原版隨機擲骰與時機因子公式基礎上，新增週幾、多組峰谷時段（含跨午夜）、自訂 IANA 時區、安靜時段、冷卻與預設 `dryRun: true` 試運行保護。
6. **新增側邊欄「Gemini-chan 貓窩」連動系統（[core/nest.mjs](core/nest.mjs) & [sidecar/](sidecar/)）**
   - 新增 Q 版立繪對應、物理狀態（飽食／精力／羈絆／打盹狀態）、冷卻與每日上限、對話內 `nest_interact` 連動、打盹自然喚醒與不搶跳的互動節奏控制。

## 本機啟用與 Sidecar 設定方式

1. **複製專案**：將本倉庫複製到本機目錄後，以 Antigravity 開啟該專案資料夾（工作區 plugin 會自動載入 [.agents/plugins/gemini-cat/](.agents/plugins/gemini-cat/) 的 Hooks、Skills 與 MCP Server）。
2. **設定側邊欄 Sidecar（選配但建議）**：在 `~/.gemini/config/sidecars/gemini-cat-nest/sidecar.json` 建立設定，將 `args` 指到你的專案路徑：

```json
{
  "command": "node",
  "args": ["/path/to/your/gemini-cat/sidecar/main.mjs"],
  "restart_policy": "always",
  "display_name": "Gemini-chan 貓窩",
  "has_web_ui": true,
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

> 分詞詞典 [data/dict/](data/dict/) 沿用 jieba 詞表（MIT 授權，詳見 [data/dict/LICENSE-dict.txt](data/dict/LICENSE-dict.txt)）。

## 開發驗證

```bash
node --test tests/*.test.mjs
```
