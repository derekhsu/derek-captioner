## Captioner 規劃草案

## 1. 專案定位

- 使用 Tauri + React (Vite, Bun) 建立跨平台桌面應用。
- 產品目標是提供一個以本地檔案工作流為核心的圖片 caption 管理工具。
- 使用者可批次掃描資料夾、呼叫 OpenAI 相容 API 生成 caption、預覽圖片、手動編輯 caption，並將結果寫回同目錄文字檔。

## 2. 核心需求

- 遞迴掃描指定目錄與所有子目錄中的圖片檔。
- 支援圖片副檔名：`jpg`、`jpeg`、`png`、`webp`，並以大小寫不敏感方式處理。
- 呼叫 OpenAI 相容 API（Vision）為圖片產生 caption，支援多組自訂提示詞 preset。
- Caption 輸出格式為與圖片同目錄、同主檔名的 `.txt` 純文字檔。
- 提供圖片預覽、caption 檢視與手動編輯功能，編輯後可保存回對應 `.txt`。
- 支援批次任務佇列、進度顯示、失敗重試與執行摘要。
- 設定需以 JSON 持久化，支援匯出/匯入，並在下次啟動時自動載入。

## 3. 檔案與資料規則

- Caption 定義：`foo/bar/img001.jpg` 對應 `foo/bar/img001.txt`。
- Caption 檔案格式：UTF-8 純文字，不附加額外 metadata。
- 掃描結果建議依相對路徑排序，確保清單穩定。
- 已存在 caption 時需支援以下模式：
  - `skip`
  - `overwrite`
  - `only-empty`
- 執行前由使用者選擇覆寫策略。

## 4. 設定模型

- `base_url`
- `api_key`（可空，支援 LM Studio 或其他本地服務）
- `model`
- `concurrency`
- `retry_count`
- `request_timeout_seconds`
- `selected_prompt_preset_id`
- `prompt_presets[]`
- `last_opened_directory`
- `overwrite_mode`
- `dry_run_count`
- `theme`

## 5. 主要功能模組

### 5.1 目錄掃描

- 提供 UI 按鈕開啟資料夾選擇對話框。
- 選取後遞迴掃描支援格式的圖片檔。
- 顯示掃描摘要：總圖片數、已有 caption 數、待處理數。

### 5.2 Prompt Preset 管理

- 建立、編輯、刪除、選擇多組提示詞 preset。
- 可指定預設 preset 作為批次執行時使用的提示模板。

### 5.3 API 設定管理

- 可設定 `base_url`、`api_key`、`model`、`concurrency`、`retry_count`、`request_timeout_seconds`。
- `api_key` 可留空，不應阻止本地端 API 的使用。
- 設定需自動保存並支援 JSON 匯出/匯入。

### 5.4 Caption 瀏覽與編輯

- 圖片清單需支援狀態篩選：未處理、已生成、已手動修改、失敗。
- 點選圖片後顯示圖片預覽與 caption 編輯區。
- 若 `.txt` 已存在，優先讀取現有內容。
- 使用者可手動修改並保存，直接覆寫對應 `.txt`。
- 若內容未保存即切換項目，需提示是否保存。

### 5.5 批次執行與任務佇列

- 支援試跑前 N 張。
- 批次執行時顯示整體進度與單筆狀態：`queued`、`running`、`success`、`fail`。
- API 失敗時支援 timeout、429/5xx 重試與錯誤原因顯示。
- 需定義停止任務後是否保留已完成結果，以及重新執行時是否跳過已完成項目。

## 6. UX 流程（MVP）

1. 開啟 App，看到空狀態引導先設定 API 與選擇資料夾。
2. 選擇目錄後，自動遞迴掃描圖片並顯示摘要。
3. 設定或選擇 prompt preset、API 參數與覆寫策略。
4. 可先執行「試跑前 N 張」確認輸出品質。
5. 開始批次標註，於任務清單查看進度與錯誤。
6. 完成後可檢視圖片與 caption、手動修正並保存。
7. 需要時可匯出/匯入設定 JSON，或再次執行後續批次處理。

## 7. User Stories

- 作為使用者，我可以選擇一個目錄並遞迴載入所有支援的圖片檔。
- 作為使用者，我可以設定 API base URL、可選 API key、model 與批次執行參數。
- 作為使用者，我可以建立與切換多組 prompt preset。
- 作為使用者，我可以預覽圖片並查看對應 caption。
- 作為使用者，我可以手動修改 caption 並保存回同名 `.txt`。
- 作為使用者，我可以看到批次執行進度、失敗原因與重試結果。
- 作為使用者，我可以匯出與匯入設定 JSON，並在重新開啟 App 時保留先前狀態。

## 8. 非功能性需求

- 設定檔與 caption 寫入需可靠，避免異常中斷造成資料毀損。
- 對大型資料夾需維持合理記憶體占用與操作流暢度。
- UI 應支援空狀態、loading、錯誤狀態與完成摘要。
- API key 若有填寫，應支援顯示/隱藏，不長期明文暴露。
- 所有檔案操作以本地端為主，不應將資料送往未指定的外部位置。

## 9. 技術堆疊

- 桌面應用：Tauri
- 前端框架：React + Vite + TypeScript
- 套件管理與腳本：Bun
- 狀態管理：Zustand
- UI 套件：Chakra UI 或 Mantine（二選一）
- 表單與驗證：React Hook Form + Zod
- 通知：sonner 或 react-hot-toast
- 大量列表：react-virtual
- 圖示：Tabler Icons

## 10. 開發階段建議

- Phase 1：設定管理、目錄選擇、遞迴掃描、圖片清單與預覽、caption 讀寫。
- Phase 2：Prompt preset、API 串接、單張測試生成功能、試跑前 N 張。
- Phase 3：任務佇列、批次執行、重試、失敗列表、覆寫策略。
- Phase 4：匯出/匯入設定、結果統計、體驗優化、打包分發。

## 11. 已完成

- 建立 `desktop/` 子專案（React + Vite + TS，使用 Bun）。
- 安裝並初始化 Tauri。
- 新增 VSCode 啟動設定（`Tauri Dev (Bun, desktop)`）。
- 修正 Tauri 設定：
  - `productName`: Captioner
  - `identifier`: com.derek.captioner
  - `frontendDist`: 指向 `dist`
  - build 命令使用 `bun run dev/build`
- 成功打包 macOS 版本，產出：
  - `.app`: `desktop/src-tauri/target/release/bundle/macos/Captioner.app`
  - `.dmg`: `desktop/src-tauri/target/release/bundle/dmg/Captioner_0.1.0_aarch64.dmg`
- 清理舊版 bundle（desktop.app / desktop_0.1.0_aarch64.dmg）。
