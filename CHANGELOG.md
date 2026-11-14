# 更新紀錄（Changelog）

本專案採用語意化版本控制（[Semantic Versioning](https://semver.org/)），版本號同步維護於 [package.json](./package.json)、[.agents/plugins/gemini-cat/plugin.json](./.agents/plugins/gemini-cat/plugin.json) 與 [mcp/server.mjs](./mcp/server.mjs)。

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
