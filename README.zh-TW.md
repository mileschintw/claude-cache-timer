# claude-cache-timer

[English](README.md) | **繁體中文**

Claude Code 的 mod：倒數 prompt cache 的剩餘時間，在快取過期前提醒你；也可以在過期前先壓縮對話，免得下一則訊息要重新寫入一大段上下文。

```
cache ██████████████░░░░░░░░░░░░░░░░ 27:43 / 60:00  自動壓縮 關  [ 立即壓縮 ] [ 面板 ] [ 隱藏 ]
上次讀寫 32 分鐘前 · 讀取 182k · 寫入 3k
```

介面預設是英文，切換成繁體中文後就如上圖所示，切換方式見[介面語言](#介面語言)。

## 為什麼需要它

Claude Code 每次請求都會把對話前段放進快取。快取還有效時，下一則訊息讀回整段上下文只需要一般輸入價格的一小部分。快取的 TTL（5 分鐘或 1 小時）一到，下一則訊息就得把整段上下文重新寫進快取，而快取寫入比一般輸入更貴。

長對話裡這是實際的成本，介面卻不會提醒你它快發生了。這個 mod 會顯示快取還剩多久，在過期前提醒你；也可以趁快取還有效時先壓縮對話，讓下一則訊息只需要重新快取一段摘要，而不是整份對話紀錄。

## 功能

- **提示框上方的倒數進度條**：顏色從綠轉黃再轉紅，顯示剩餘時間（剩 5 分鐘前只顯示分鐘，例如 `27 / 60 分`，最後 5 分鐘才顯示 `mm:ss`）和上次讀寫了多少 tokens，並附「立即壓縮」、「面板」、「隱藏」按鈕。
- **狀態列倒數**：剩餘時間也會顯示在狀態列，例如 `快取剩 27 / 60 分` 或 `快取已過期`。
- **`/cache` 面板**：顯示剩餘時間、本 session 的命中率、過期與壓縮次數，以及每次請求快取命中比例的迷你圖，所有設定也都在這裡。
- **到期提醒**：1h 快取在過期前 5 分鐘提醒（5m 快取是前 1 分鐘），過期時再提醒一次。
- **自動壓縮（選用）**：預設關閉。開啟後會在過期前 1、2 或 5 分鐘、快取還有效時壓縮對話。
- **一鍵壓縮**：在進度條或面板按按鈕。
- **英文或繁體中文介面**：可在 plugin 設定、面板或用 `/cache lang` 選擇介面語言。
- **TTL 自動偵測**：一開始假設是 1h，再依 API 回報的實際情況自動修正。隔了 5 分鐘以上還能讀到快取，代表是 1h；隔 5 到 55 分鐘後必須整段重寫，代表是 5m。切換模型時，Claude Code 也會直接回報 TTL。

## 安裝

在 Claude Code 的終端機 session 中輸入：

```
/plugin install cache-timer --marketplace mileschintw/claude-cache-timer
```

詢問是否新增 marketplace 時回答 `y`，再選擇 user scope。以 user scope 安裝後，Claude 桌面版的 Code 分頁也會載入這個 mod。不過桌面版不能執行 `/plugin` 指令，請在終端機裡安裝。

marketplace 安裝的是最新的 [release](https://github.com/mileschintw/claude-cache-timer/releases)，不是 `main` 的最新 commit。

<details>
<summary>改用 clone 下來的資料夾</summary>

```bash
git clone https://github.com/mileschintw/claude-cache-timer.git ~/.claude/mods/cache-timer
```

接著在 `~/.claude/settings.json` 的 `env` 區塊加入這個資料夾：

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "~/.claude/mods/cache-timer"
  }
}
```

之後開啟的每個 session 都會載入它。
</details>

**需求**：支援 function-hook mod 的 Claude Code 版本（目前仍是搶先體驗 API）。已在 Claude Code 2.1.295 的終端機與桌面版上測試。

## 使用方式

送出第一則訊息後，進度條就會出現。其餘操作都透過 `/cache`：

| 指令 | 作用 |
| --- | --- |
| `/cache` | 開啟面板；無法顯示面板時，直接列出相同的數據 |
| `/cache auto on` / `off` | 開啟或關閉自動壓縮 |
| `/cache ttl 5m` / `1h` | 手動設定 TTL |
| `/cache band on` / `off` | 顯示或隱藏提示框上方的進度條 |
| `/cache seconds on` / `off` | 一律顯示 `mm:ss`，不在剩 5 分鐘前只顯示分鐘（預設關） |
| `/cache lang en` / `zh-TW` | 切換介面語言 |

設定會跨 session 保存。

### 介面語言

進度條、面板、提醒和 `/cache` 的回覆可以用英文（`en`，預設）或繁體中文（`zh-TW`）顯示。切換方式有三種：

- **Plugin 設定**：plugin 的 `lang` 選項，在 `/config` 裡是一個下拉選單。安裝時也可以直接選。
- **面板**：`/cache` 面板的「語言」那一列，每種語言各有一個按鈕。
- **指令**：`/cache lang en` 或 `/cache lang zh-TW`。

以最後一次變更為準。在面板或用 `/cache lang` 選的語言會和其他設定一起保存，直到 plugin 設定本身改變為止；改了 plugin 設定，介面就會換成新的值。

## 運作原理

- **計時方式**：主對話的每一次模型請求都會回報從快取讀了多少 tokens、寫入多少。只要有讀或寫，倒數就從那一刻重新開始。子代理（subagent）的請求有各自的快取，不列入計算。
- **自動壓縮的條件**：只在 Claude 閒置時觸發，每個快取週期最多一次，而且上下文至少要有 20k tokens。上下文比這更短時，壓縮省下的成本不值得犧牲細節。5m 快取的提前時間最多 1 分鐘，所以停頓不到 4 分鐘時絕不會壓縮。
- **重開之後**：計時器和本 session 的統計會隨時存下來（保留最近 20 個 session），所以重開 app 或恢復 session 後倒數會馬上出現。在這個版本之前最後使用的 session，或 fork 出來的 session，沒有存檔，倒數會依對話紀錄最後一次回覆的時間估算，進度條下方只顯示上下文大小。
- **桌面版的壓縮**：桌面版（以及 SDK 或 `-p` 的 session）不允許 mod 直接壓縮，所以在那裡按壓縮按鈕會執行 `/compact`，結果會顯示在對話紀錄裡。
- **重新計時**：任何壓縮（`/compact`、Claude Code 內建的自動壓縮，或這個 mod 觸發的）都會取代原本的快取內容，計時器會等到下一則訊息再開始。

## 限制

- **桌面版沒有系統通知**：在桌面版裡，提醒只會以 app 內的 toast 顯示；如果你不在視窗前，就不會看到。
- **倒數是估計值**：時間從回應結束時算起，和 API 那邊的時鐘可能差幾秒。
- **對話框取代提示框時，進度條會被隱藏**：當對話框佔據提示框的位置時，Claude Code 不會畫出進度條，包括問題（終端機）、計畫核准，以及桌面版的「下一步」卡片。回答之後進度條就會回來。在桌面版，「下一步」卡片底下的狀態列仍然看得到，所以倒數還在；在終端機，狀態列也會一起被隱藏。
- **壓縮會失去細節**：所以自動壓縮預設是關閉的。

## 開發

```bash
claude plugin validate .
claude plugin test .
```

主要程式在 [`hooks/register.tsx`](hooks/register.tsx)，狀態型別定義在 [`types/index.d.ts`](types/index.d.ts)，測試在 [`tests/`](tests/)。

## 授權

[MIT](LICENSE)
