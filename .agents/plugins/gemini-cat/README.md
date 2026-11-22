# Gemini-chan 貓窩伴侶 (`gemini-cat`)

專為 **Antigravity 2.0** 打造的專案限定 AI 伴侶與互動貓窩插件。僅在開啟本專案工作區時生效，切換至其他開發專案時自動保持靜默。

## 包含元件
- **Sidecar 面板（`Gemini-chan 貓窩`）**：Q 版情緒／打盹立繪、羈絆進度與今日陪伴暖度、5 項日常照護按鈕＋小紙條、3D 記憶宇宙星圖與年輪時間軸。
- **Lifecycle Hooks（4 段式）**：
  - `SessionStart`：初始化星汐檔案、登記專案對話並更新貓窩狀態。
  - `PreInvocation`：於新對話第 1 輪（及修改提示詞／開關時）單次載入人設、星汐八章記憶卡、近 3 天日記、核心記憶與各模組指引；後續輪次僅差量注入當輪召回記憶、顯著心情提示與待處理貓窩互動（平時無變動則 0 Token）。
  - `PostToolUse`：同步更新貓窩活動氣泡。
  - `Stop`：當對話內未呼叫 `mood_update` 時，自動執行本地語意心情兜底。
- **MCP 工具（`gemini-cat_companion`，共 12 個）**：`remember`、`recall`、`memory_forget`、`xingxi`、`xingxi_read`、`xingxi_append`、`xingxi_diary`、`xingxi_pickup`、`mood_status`、`mood_update`、`nest_interact`、`speak_up_plan`。
- **Skills**：`/cat-nest`、`/xingxi`。
