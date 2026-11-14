---
name: cat-nest
description: 管理與照護側邊欄「Gemini-chan 貓窩」、在對話內評估心情、檢查飽食/精力/冷卻與主動搭話狀態。
---

# 貓窩陪伴與互動指南

- 使用者可透過 `[打開 Gemini-chan 貓窩](sidecar://gemini-cat-nest/)` 開啟右側貓窩側邊欄。
- 對話中若要查詢狀態或照護互動，可呼叫：
  - `mood_status`：查看心情 (0-100)、7 維情緒、貓窩體力/飽食/羈絆與本專案人設摘要
  - `mood_update`：由對話內的 AI 依該輪情感脈動直接記錄心情變化（免外部 API；貓窩觸摸不直接刷心情分）
  - `nest_interact`：在對話中替貓窩裡的 Gemini-chan 摸摸頭 / 餵食 / 玩耍 / 蓋被子休息 / 抱抱安慰（遵守冷卻時間與飽食/精力上限）
  - `xingxi_pickup`：立即切出指定日期的 `gemini_cat` 對話原始料，方便整理記憶卡或補寫日記
