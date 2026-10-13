# WorkHub 工具上架 SOP（開發者版）

版本：2026-10-13・正本為線上文件，本檔由正本匯出；請勿在本檔直接修改。

## 1. 上架流程總覽

開發者只需交付一個 ZIP（原始碼＋建置設定），之後的驗證、建置、檢查、測試與預覽都由平台自動完成；開發者在預覽中測試並確認結果，發布核准與發布由平台管理者執行。第一次上架看第 8 節，版本更新看第 9 節。最快的做法是把程式碼和開發者中心下載的「上架資料包」交給 AI agent 打包，見第 12 節。開發者不需要操作 Docker。

1. **準備 ZIP（開發者）**：依第 2～7 節準備檔案，用第 8 節的清單自我檢查。
2. **上傳（WorkHub 開發者中心）**：選擇部門、填寫 Owner、上傳 ZIP。新工具用「新增工具」；已上架工具用該工具的「提交新版本」。
3. **收件檢查（平台，數秒）**：檢查 ZIP 結構、禁止內容與 `workhub.yaml`。不通過時逐項列出「檔案／原因／補正方法」，並停止建置。
4. **建置（平台）**：依 Dockerfile 建置 linux/arm64 image，不注入任何憑證。
5. **漏洞檢查（平台）**：掃描套件的已知漏洞，結果列在漏洞清單（可下載 CSV）。只記錄、不阻擋發布；掃描工具本身無法執行時才會停止。
6. **程式碼 AI review**：本機試點暫不執行，畫面標示「略過」，不代表通過。
7. **平台共通檢查（平台）**：以空白資料卷啟動容器，確認健康檢查回應正確。
8. **業務測試（平台）**：在無網路的容器執行你提供的測試命令，結束碼 0 才算通過。
9. **預覽（平台）**：全部通過後啟動預覽環境，供人工操作核對。
10. **開發者預覽與測試（開發者）**：開啟預覽，實際操作主要功能（至少上傳、解析、匯出），無誤後按「確認測試結果」並寫下核對說明，狀態變成「待管理者審核」。
11. **核准與發布（平台管理者，在發布管理）**：核准後按「發布」，部署同一份已測試的 image；健康檢查通過才開放工具入口。

任一步失敗時，在提交詳情點「查看日誌」找原因；修正後重新打包，用「提交新版本」上傳（測試失敗不想留著可先按「取消提交」）。重新提交會使上一份提交的確認與核准失效。不需要登入碼，網站會自動帶入本機通行碼。

## 2. ZIP 必須包含的檔案

`workhub.yaml` 與 `Dockerfile` 必須放在 ZIP 最上層（用 Finder「壓縮」多包一層資料夾也可以，平台會自動辨識）。

| 檔案 | 必要性 | 內容要求 |
| --- | --- | --- |
| `workhub.yaml` | 必要 | 工具代號、版本、埠、健康檢查、測試命令等設定，見第 4 節 |
| `Dockerfile` | 必要 | 建置與啟動方式，見第 5 節 |
| 原始碼 | 必要 | 工具執行需要的所有程式檔 |
| 鎖定套件清單 | 必要 | Python：寫死版本的 `requirements.lock` 或 `requirements.txt`（`套件==版本`）；Node.js：`package-lock.json` 或 `pnpm-lock.yaml` |
| 業務測試 | 必要 | 自動測試程式（例如 `tests/`），見第 6 節；未提供則不能送交核准 |
| 測試資料 | 依測試需要 | 已去識別化、不含真實客戶或個人資料 |
| 空白範本 | 依工具需要 | 例如匯出用 Excel 範本；只能有欄位標題，不可帶業務資料 |
| `.env.example` | 建議 | 只列變數名稱與說明，不填值 |
| `README.md` | 建議 | 工具用途與使用方式 |

`workhub.yaml` 範本在開發者中心「下載上架資料包」裡。

## 3. ZIP 不可包含的內容與大小上限

平台收件時會自動檢查以下項目，任一項不符就整份拒收，不會開始建置。

| 不可包含 | 例子 | 改法 |
| --- | --- | --- |
| 密鑰與設定檔 | `.env`、`.env.local`、`*.pem`、`*.key`、`id_rsa`、`.npmrc`、`credentials.json`、`secrets.yaml` | 移除。連線參數由平台以環境變數注入（`.env.example` 可以放，只列名稱） |
| 寫死在程式裡的密鑰 | `sk-…`、`AKIA…`、`ghp_…`、`api_key = "…"`、私鑰內容 | 刪掉寫死的值，改讀環境變數 |
| 版本庫資料 | `.git/` | 壓縮前排除（歷史紀錄可能藏有舊密鑰） |
| 已安裝的套件與快取 | `node_modules/`、`venv/`、`.venv/`、`__pycache__/`、`wheels/` | 移除。套件在建置時依鎖定清單安裝 |
| 真實資料與資料庫 | `*.db`、`*.sqlite`、客戶報價單、含個資的 Excel | 移除。測試只用去識別化資料 |
| 壓縮檔裡的壓縮檔 | `.zip`、`.tar.gz`、`.7z`、`.rar` | 解開後用一般檔案放入 |
| 符號連結、加密 ZIP | 捷徑、有密碼的壓縮檔 | 換成實際檔案；用不加密的 ZIP |
| 不安全的路徑 | 絕對路徑、`..`、反斜線、不分大小寫重複的檔名 | 從專案資料夾內重新壓縮 |

| 上限 | 數值 |
| --- | --- |
| ZIP 檔案大小 | 100 MB |
| 檔案數 | 5,000 個 |
| 解壓後總量 | 500 MB |
| 單一檔案（解壓後） | 200 MB |

Mac 壓縮時產生的 `__MACOSX/` 與 `.DS_Store` 會自動忽略，不必手動刪除。

## 4. workhub.yaml 欄位說明

`workhub.yaml` 告訴平台怎麼建置、啟動、檢查與測試你的工具。部門、Owner 與使用權限以平台表單為準，不寫在這裡；檔案裡也不可以有任何密鑰或環境變數的值。

| 欄位 | 必填 | 規則 | 例子 |
| --- | --- | --- | --- |
| `schemaVersion` | 必填 | 固定 `workhub/v1` | `workhub/v1` |
| `tool.id` | 必填 | 3～41 個小寫英數字或連字號，英文字母開頭；**上架後不可更改** | `quote-aggregator` |
| `tool.name` | 必填 | 使用者看得懂的名稱 | `採購報價單彙整工具` |
| `tool.version` | 必填 | 語意化版本；每次提交更新都要遞增，已發布過的版本號不能再用 | `1.2.0`、`2.12.0-pilot.5` |
| `tool.description` | 建議 | 一句話說明用途 |  |
| `build.dockerfile` | 必填 | ZIP 內的相對路徑 | `Dockerfile` |
| `build.context` | 選填 | 建置目錄，預設 `.` | `.` |
| `build.platforms` | 必填 | 必須包含 `linux/arm64`（本機試點的架構） | `[linux/arm64]` |
| `run.port` | 必填 | 工具在容器內監聽的埠，1024～65535 | `8501` |
| `run.command` | 選填 | 字串陣列；不填就用 Dockerfile 的 `CMD` | `["node", "server.js"]` |
| `run.healthCheck.path` | 必填 | `/` 開頭，工具正常時回應的網址 | `/health`、`/_stcore/health` |
| `run.healthCheck.expectStatus` | 選填 | 200～399，預設 200 | `200` |
| `run.healthCheck.startPeriodSeconds` | 選填 | 啟動需要的秒數，0～600 | `40` |
| `run.persistentData` | 會存資料就必填 | 只能一個目錄，絕對路徑、不可是系統目錄；沒宣告的資料在更新後會消失 | `- path: /data` |
| `run.resources.cpu` | 選填 | 0～8，預設 1 | `"2"` |
| `run.resources.memory` | 選填 | 128Mi～16Gi，預設 1Gi | `3Gi` |
| `test.command` | 必填 | 字串陣列；沒填就「未驗證」，不能送交核准 | `["npm", "test"]` |
| `test.timeoutSeconds` | 選填 | 1～3600，預設 900 | `900` |
| `test.network` | 選填 | 只能是 `none`（測試不得連外） | `none` |
| `env.required` / `env.optional` | 選填 | 只列變數名稱（大寫英數字與底線）、用途、是否機密；**不可寫值** | 見範本 |
| `model.uses` | 用 AI 就必填 | 工具是否呼叫 AI 模型 | `true` |
| `model.approvedEndpoint` | 用 AI 就必填 | 平台核准的端點代號，實際網址由平台對應 | `wisely-5090` |
| `model.fallback` | 選填 | 只能是 `none`，不得退回其他端點 | `none` |

完整範本（以 Node.js 網站為例，不用 AI）：

```yaml
schemaVersion: workhub/v1

tool:
  id: shipping-tracker
  name: 出貨進度查詢
  version: 1.0.0
  description: 依訂單號查詢出貨狀態

build:
  dockerfile: Dockerfile
  context: .
  platforms: [linux/arm64]

run:
  port: 3000
  healthCheck:
    path: /health
    expectStatus: 200
    startPeriodSeconds: 10
  persistentData:
    - path: /data
      purpose: 查詢紀錄
  resources:
    cpu: "1"
    memory: 512Mi

test:
  command: ["npm", "test"]
  timeoutSeconds: 300
  network: none

env:
  required: []
  optional: []

model:
  uses: false
```

範本也在開發者中心「下載上架資料包」裡；使用 AI 的工具要另外填 `env` 與 `model`，見第 7 節。

## 5. Dockerfile 撰寫要求

Dockerfile 必須讓工具在「沒有外網、沒有密鑰」的容器裡就能啟動。上線後工具跑在隔離網路，只連得到平台的模型服務，連不到網際網路或公司其他系統。

| 要求 | 原因 | 怎麼做 |
| --- | --- | --- |
| 支援 linux/arm64 | 本機試點是 arm64 | 用官方多架構基底映像，寫死版本（`python:3.14-slim-trixie`、`node:22-slim`），不用 `latest` |
| 套件在建置時裝好 | 執行時沒有外網 | 依鎖定清單安裝（`pip install -r requirements.lock`、`npm ci`）；執行時不再下載任何東西 |
| 用非 root 使用者執行 | 降低工具被攻擊時的影響 | 建立一般使用者，最後用 `USER` 切換 |
| 監聽 `0.0.0.0` | 只聽 127.0.0.1 時平台連不到 | 例如 Streamlit 加 `--server.address=0.0.0.0`；Node 用 `app.listen(3000, '0.0.0.0')` |
| 提供健康檢查網址 | 平台靠它判斷是否啟動成功 | 回應 `workhub.yaml` 寫的路徑與狀態碼；不要求登入 |
| 資料只寫在持久目錄 | 更新版本時只保留這個目錄 | 資料庫、上傳檔、匯出檔都放 `/data`（可用環境變數 `DATA_DIR=/data`）；暫存放 `/tmp`；程式目錄視為唯讀 |
| 不複製密鑰 | 密鑰會被寫進 image | 加 `.dockerignore` 排除 `.env`、`.git`、`venv`、`node_modules`、資料檔 |
| 啟動時不依賴外部服務 | 隔離網路連不到外面 | 缺少的設定要能提示使用者，不要讓程式直接當掉 |

Python（Streamlit）範例：

```dockerfile
FROM python:3.14-slim-trixie
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DATA_DIR=/data
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY . .
RUN useradd --uid 10001 --create-home app && mkdir -p /data && chown app /data
USER app
EXPOSE 8501
CMD ["streamlit", "run", "app.py", "--server.port=8501", "--server.address=0.0.0.0", "--server.headless=true"]
```

Node.js 範例：

```dockerfile
FROM node:22-slim
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /data && chown node /data
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

平台啟動容器時會再加上安全限制（移除系統權限、限制程序數與記憶體），工具不需要也不應該要求特權。

## 6. 業務測試要求

業務測試由平台在「沒有網路、空白資料目錄」的容器裡執行 `test.command`，結束碼為 0 才算通過。沒有提供測試的工具會顯示「未驗證」，不能送交核准。

- **測到主要功能**：至少涵蓋工具的核心流程，例如「讀入檔案 → 解析 → 匯出」。匯出要實際寫檔到資料目錄並確認檔案打得開（採購工具曾因匯出路徑寫死而在容器裡失敗）。
- **不連外**：測試時沒有網路。需要 AI 的功能要能在「未設定模型」時給出明確提示，測試驗證這個提示即可；真實 AI 呼叫在預覽中手動測試。
- **不依賴既有資料**：資料目錄是空的，測試需要的資料要自己放在提交包裡（例如 `tests/fixtures/`），而且必須是去識別化資料。
- **可以重複執行**：同一份測試跑兩次結果要相同，不依賴執行順序或當下時間。
- **在時限內結束**：預設 900 秒，最長 3,600 秒；逾時視為失敗。
- **失敗要看得懂**：網站顯示最後幾行輸出，請讓失敗訊息說明是哪個功能、哪個檔案。

| 語言 | `test.command` 寫法 |
| --- | --- |
| Python（pytest） | `["python", "-m", "pytest", "-q", "-p", "no:cacheprovider", "tests"]` |
| Node.js | `["npm", "test"]` 或 `["node", "--test"]` |

測試用的套件（例如 pytest）要一併寫在鎖定清單裡，因為測試容器不能下載套件。業務測試不取代人工預覽：通過後仍要在預覽中實際操作，再按「確認測試結果」。

## 7. 使用 AI 模型的工具

工具只從三個環境變數讀取模型設定，由平台在預覽與上線時注入；程式裡不寫模型主機、金鑰或模型名稱。使用哪個模型（地端或雲端）由平台管理者決定，換模型不需要改工具或重新上架。model.approvedEndpoint 只能填平台核准的端點代號，本機試點只有 wisely-5090；最新清單寫在資料包的「給AI的打包指令.txt」。

| 環境變數 | 內容 |
| --- | --- |
| `OPENAI_BASE_URL` | 平台提供的 OpenAI 相容網址 |
| `OPENAI_API_KEY` | 這個工具專用的通行碼（不是模型的真實金鑰） |
| `OPENAI_MODEL` | 管理者指派的模型名稱 |

1. 在 `workhub.yaml` 宣告使用模型，並把三個變數列在 `env.optional`（只列名稱，不寫值）：

```yaml
env:
  optional:
    - name: OPENAI_BASE_URL
      purpose: 平台提供的模型網址
      secret: false
    - name: OPENAI_API_KEY
      purpose: 平台提供的工具通行碼
      secret: true
    - name: OPENAI_MODEL
      purpose: 平台指派的模型
      secret: false
model:
  uses: true
  provider: openai-compatible
  approvedEndpoint: wisely-5090
  fallback: none
```

2. 程式以 OpenAI 相容格式呼叫 `POST {OPENAI_BASE_URL}/chat/completions`，標頭帶 `Authorization: Bearer {OPENAI_API_KEY}`，`model` 填 `OPENAI_MODEL`。可以傳圖片（`image_url` 內放 `data:image/png;base64,…`）。
3. 變數沒有注入時，顯示「AI 未設定」之類的提示，不要當掉，也不要改連其他服務。
4. 不得退回其他模型主機（例如本機 Ollama 或外部 API）；上線後工具在隔離網路，也連不到它們。
5. 模型連不到、逾時或回應格式不對時，要顯示錯誤，**不可當成成功**（例如匯出空白結果）。預設等待建議 120 秒以內。
6. AI 解析的結果要在畫面上標示「由 AI 解析」，提醒使用者核對。
7. 不要在日誌印出提示詞或模型回應的全文（可能含報價等業務資料）。

## 8. 第一次上架：打包與上傳

1. **本機先跑過**：在自己電腦上執行測試命令，全部通過。
2. **整理資料夾**：最上層放 `workhub.yaml`、`Dockerfile`、`.dockerignore`、鎖定清單、原始碼與 `tests/`；刪除第 3 節列出的東西。
3. **壓縮**：Mac 在 Finder 對資料夾按右鍵「壓縮」即可（多包一層資料夾也沒關係）。建議檔名帶版本，例如 `shipping-tracker-1.0.0.zip`。
4. **上傳**：WorkHub → 開發者中心 → 「＋ 新增工具」，選部門、填 Owner、選 ZIP，按「上傳並開始建置」。
5. **等自動流程**：建置約 5～20 分鐘。可以關閉瀏覽器，進度不受影響；在「我的提交」看狀態。
6. **預覽測試**：全部通過後點「開啟預覽」，實際操作主要功能。預覽的資料與正式版分開，可以放心測。
7. **確認測試結果**：寫下測了什麼、結果如何，送出後狀態變成「待管理者審核」。
8. **等核准與發布**：平台管理者在發布管理核准並發布；完成後工具出現在 WorkHub 工具中心。

上傳前自我檢查：

- [ ] `workhub.yaml` 與 `Dockerfile` 在 ZIP 最上層
- [ ] `tool.id` 是小寫英數字或連字號，而且沒有和其他工具重複
- [ ] `tool.version` 是語意化版本（例如 1.0.0）
- [ ] `build.platforms` 包含 `linux/arm64`
- [ ] 工具監聽 `0.0.0.0` 和 `run.port` 寫的埠
- [ ] 健康檢查網址不用登入就回應 200
- [ ] 會存的資料都寫在 `run.persistentData` 宣告的目錄
- [ ] 套件都寫死版本，包含測試套件
- [ ] `test.command` 在沒有網路的情況下也能全部通過
- [ ] 沒有 `.env`、金鑰、`.git`、`node_modules`、虛擬環境、資料庫或真實資料
- [ ] 用 AI 的工具：只讀 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`，沒有寫死主機或金鑰
- [ ] ZIP 小於 100 MB

## 9. 版本更新（版更）SOP

版更和第一次上架走同一條自動流程，差別只有三點：`tool.id` 不變、`tool.version` 要遞增、從該工具的「提交新版本」上傳。上線中的舊版在新版發布前照常服務。

| 改動類型 | 版本號怎麼變 | 例子 |
| --- | --- | --- |
| 修錯、小調整 | 第三碼 +1 | 1.2.0 → 1.2.1 |
| 新增功能，舊資料照常可用 | 第二碼 +1，第三碼歸 0 | 1.2.1 → 1.3.0 |
| 資料格式改變、舊版讀不懂新資料 | 第一碼 +1 | 1.3.0 → 2.0.0 |
| 試點或測試版 | 加後綴 | 2.0.0-pilot.1 → 2.0.0-pilot.2 |

已發布過的版本號不能再用；內容沒改只是想重跑，也要遞增版本號。

開發者的步驟：

1. **修改程式並補測試**：修哪個問題，就加一個能抓到它的測試。
2. **遞增 `tool.version`**，`tool.id` 保持不變。
3. **確認舊資料可用**：新版會接手舊版的資料目錄。資料庫欄位或檔案格式有變時，程式啟動時要自動轉換，並在確認說明裡寫明。
4. **本機跑過測試、照第 8 節打包**。
5. **上傳**：開發者中心 → 工具提交 → 該工具旁的「↻ 提交新版本」。不要用「新增工具」，會被擋下（此工具已存在）。
6. **預覽測試**：預覽是空白資料，重點測這次改的功能，以及上傳、解析、匯出等主要流程。
7. **確認測試結果**：寫下改了什麼、測了什麼、資料格式有沒有變。

平台與管理者接手的部分：

| 階段 | 發生什麼 |
| --- | --- |
| 上傳新版時 | 同一工具尚未發布的舊提交自動作廢，它的測試確認與核准失效；上線中的版本不受影響 |
| 管理者核准後發布 | 停止舊版 → 備份資料 → 啟動新版 → 健康檢查通過才切換入口，網址不變；使用者約有 1 分鐘打不開 |
| 新版啟動失敗 | 自動還原備份、重新啟動舊版；入口維持舊版，發布紀錄標示失敗原因 |
| 上線後發現問題 | 管理者在發布管理「切換版本」回到任何曾經上線的版本。回到前一版時可選「保留目前資料」（資料格式相容）或「還原發布前的備份」（之後新增的資料會消失） |
| 緊急狀況 | 管理者在維運中心「進入維護」先關閉入口、「重新啟動」、「查看日誌」，或在發布管理下架 |

不需要版更的情況：更換 AI 模型、調整 Owner 或使用範圍，都由平台管理者在平台上設定，不用重新提交。

## 10. 常見錯誤與補正方法

以下都是採購工具試點時實際遇到的狀況。收件檢查的錯誤會直接列在上傳表單下方；後面步驟的錯誤要在提交詳情點「查看日誌」。

| 看到的訊息或狀況 | 原因 | 怎麼修 |
| --- | --- | --- |
| 此工具已存在 | 用「新增工具」上傳已上架工具的新版 | 改用該工具的「提交新版本」 |
| 版本 X 已發布過 | 版本號沒有遞增 | 改 `tool.version` 後重新打包 |
| ZIP 的工具識別與選取的更新工具不符 | `tool.id` 被改了，或上傳錯工具的 ZIP | 改回原本的 `tool.id` |
| 相同內容已在處理中或已完成 | 同一份 ZIP 重複上傳 | 沒改內容就用「重試」；有改就重新打包 |
| ZIP 最上層找不到 workhub.yaml | 檔案包了兩層以上資料夾，或檔名打錯 | 從專案資料夾本身壓縮 |
| 疑似環境設定檔（.env）、疑似寫死的金鑰 | 提交包帶了密鑰 | 移除；改讀環境變數（第 7 節） |
| 本機只能建置 linux/arm64 | `build.platforms` 沒寫 arm64 | 加上 `linux/arm64`，並確認套件支援 |
| 建置失敗 | 套件版本衝突、Windows 專用套件、缺少系統工具 | 看建置日誌最後幾行；用 Linux 重新產生鎖定清單，系統工具在 Dockerfile 用 `apt-get` 安裝 |
| 平台共通檢查未通過 | 只監聽 127.0.0.1、埠號不符、健康路徑錯、啟動太慢 | 監聽 0.0.0.0；核對 `run.port` 與 `healthCheck.path`；加大 `startPeriodSeconds` |
| 業務測試未通過 | 測試需要網路、缺測試套件、依賴既有資料 | 測試資料放進提交包；測試套件寫進鎖定清單；不要連外 |
| 預覽中匯出失敗（Permission denied） | 程式寫死路徑、把檔案寫進程式目錄 | 所有寫入都放 `DATA_DIR`（`/data`）或 `/tmp`，並加一個匯出測試 |
| 預覽中顯示「AI 未設定」 | `workhub.yaml` 沒列模型變數或 `model.uses` 不是 true；或平台尚未設定模型端點 | 補齊第 7 節的設定；仍然一樣請聯絡平台管理者 |
| 工具連不到外部網站或公司其他系統 | 上線後工具在隔離網路 | 本機試點不開放；若業務必需，提出連線申請由平台評估 |
| 漏洞清單很長 | 基底映像或套件有已知漏洞 | 不阻擋發布。可改用較新的基底映像、升級套件、安裝後移除用不到的工具（例如 pip、setuptools） |
| 漏洞掃描未完成 | 掃描工具暫時無法執行 | 按「重試」；持續失敗請聯絡平台管理者 |

## 11. 參考範例：採購報價單彙整工具

採購報價單彙整工具（Python / Streamlit，使用 AI）是第一個照本 SOP 完整上架、版更、回復並接上模型的工具。`quote-aggregator-2.12.0-pilot.5.zip` 共 71 個檔案，結構如下：

```text
quote-aggregator-2.12.0-pilot.5.zip
├── workhub.yaml          上架設定（tool.id: quote-aggregator，port 8501，/data，AI 端點 wisely-5090）
├── Dockerfile            python:3.14-slim-trixie，安裝 LibreOffice、Tesseract，使用者 app
├── .dockerignore         排除 .env、資料庫、虛擬環境、快取
├── requirements.lock     82 個套件，全部寫死版本（在 Linux 上產生）
├── README.md
├── app.py · settings.py · .streamlit/
├── core/ · parsers/ · pages/ · scripts/ · docs/
├── data/templates/比較表範本.xlsx   只有欄位標題的空白範本
└── tests/                189 個測試，包含匯出路徑測試與去識別化測試檔
```

這個工具試點時做過的調整，其他工具可以直接照做：

| 調整 | 版本 |
| --- | --- |
| 移除本機 Ollama 退回，模型只讀平台注入的 `OPENAI_*` 變數 | pilot.1 |
| 安裝完套件後移除 pip 與 setuptools，漏洞數變少 | pilot.3 |
| 匯出路徑改用 `DATA_DIR`，修正容器內無法匯出比較表；補上匯出路徑測試 | pilot.4 |
| 內容不變只遞增版本號，重新走完整流程接上模型轉接 | pilot.5 |

需要完整的提交包做參考，請向平台管理者索取（內含採購業務邏輯，不公開放置）。

## 12. 交給 AI agent 打包

開發者把「程式碼資料夾＋上架資料包」交給能執行指令的 AI agent（例如 Claude Code），貼上指令範本，AI 完成可上傳的 ZIP 與打包報告；開發者只要回答 AI 的問題、看報告、上傳。只能聊天、不能執行指令的 AI 無法完成本機驗證，不建議使用。

### 12.1 開發者要準備

1. 第一次上架在開發者中心點「下載上架資料包」；版本更新在該工具那一列點「下載更新資料包」，給 AI 的指令已帶入 tool.id、目前版本、建議的新版本號與模型端點。解壓後把 `workhub-kit/` 資料夾放進專案資料夾。資料包內有本 SOP（`WorkHub工具上架SOP.md`）、`workhub.yaml` 範本、預檢工具 `workhub-check.mjs`、指令範本 `給AI的打包指令.txt`。
2. 電腦裝好 Docker Desktop 與 Node.js 22 以上（AI 驗證與預檢要用）。
3. 準備好答案：工具代號與名稱、是否存資料、是否用 AI、測試資料是否已去識別化。`tool.id` 與版本號可在開發者中心「工具提交」該工具那一列看到，版更用的資料包也已帶入。
4. 開啟 AI agent，貼上 `給AI的打包指令.txt` 的內容，勾選第一次上架或版本更新。

### 12.2 AI agent 的工作步驟

1. **讀 SOP**：完整讀過第 1～12 節再動手。
2. **盤點專案**：語言與框架、進入點、監聽埠、會寫檔的位置、對外連線、寫死的金鑰或主機、現有測試、只能在 Windows 執行的套件。
3. **先問人**：遇到 12.5 的事項，一次列出問題，等開發者回答。
4. **補齊設定**：依第 4、5 節寫 `workhub.yaml`、`Dockerfile`、`.dockerignore`；在 Linux 容器裡產生寫死版本的鎖定清單（Python 可用 `docker run --rm -v "$PWD":/w -w /w python:3.14-slim-trixie sh -c "pip install -r requirements.txt && pip freeze > requirements.lock"`）。
5. **調整程式**（只改必要的）：資料與匯出改寫 `DATA_DIR`、監聽 `0.0.0.0`、加健康檢查網址、寫死的金鑰與模型主機改讀環境變數（第 7 節）、移除未核准的外部連線或退回。
6. **補測試**：依第 6 節覆蓋主要流程（至少讀入、處理、匯出寫檔），測試資料只用去識別化資料。
7. **本機驗證**：執行 12.4 的指令，全部通過。
8. **打包與預檢**：從專案資料夾壓縮（排除 `workhub-kit/` 與第 3 節的內容），檔名 `<tool.id>-<版本>.zip`；執行 `node workhub-kit/workhub-check.mjs <ZIP>` 直到顯示「通過收件檢查」。
9. **交付**：ZIP 與 12.6 格式的打包報告。

### 12.3 常見框架對照

| 框架 | 常用埠 | 健康檢查網址 | 監聽 0.0.0.0 的寫法 |
| --- | --- | --- | --- |
| Streamlit | 8501 | `/_stcore/health`（內建） | `--server.address=0.0.0.0 --server.headless=true` |
| Flask（gunicorn） | 8000 | 自行加 `/health` | `gunicorn -b 0.0.0.0:8000 app:app` |
| FastAPI（uvicorn） | 8000 | 自行加 `/health` | `uvicorn main:app --host 0.0.0.0 --port 8000` |
| Gradio | 7860 | `/`（或自行加） | `launch(server_name="0.0.0.0", server_port=7860)` |
| Node.js（http、Express） | 3000 | 自行加 `/health` | `listen(3000, "0.0.0.0")` |
| Next.js | 3000 | 自行加 `/api/health` | `next start -H 0.0.0.0 -p 3000` |
| 靜態網站（nginx） | 8080 | `/` | nginx 設定 `listen 8080;`，用非 root 映像（例如 `nginxinc/nginx-unprivileged`） |

### 12.4 本機驗證指令

把 `<…>` 換成 `workhub.yaml` 裡的值，按順序執行：

```bash
# 1. 建置（與平台相同架構）
docker build --platform linux/arm64 -t <tool.id>:check .

# 2. 業務測試：不連網、空白資料目錄，結束碼要是 0
docker run --rm --network none -v <tool.id>-check-data:/data <tool.id>:check <test.command 各項以空格分開>

# 3. 啟動並檢查健康檢查網址（等 startPeriodSeconds 秒）
docker run -d --name <tool.id>-check -p 127.0.0.1:18999:<run.port> -v <tool.id>-check-data:/data <tool.id>:check
sleep <startPeriodSeconds>
curl -fsS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18999<healthCheck.path>

# 4. 清理
docker rm -f <tool.id>-check && docker volume rm <tool.id>-check-data

# 5. 打包後預檢（與平台收件同一套檢查）
node workhub-kit/workhub-check.mjs <tool.id>-<版本>.zip
```

第 3 步要回應 `expectStatus`（通常是 200）。預檢結束碼 0 代表不會被拒收；建置、健康檢查與業務測試要靠第 1～3 步先驗證。

### 12.5 必須停下來問人的事

- `tool.id` 與工具名稱（版更時確認沿用原本的 `tool.id`）
- 版本號（第一次上架從 1.0.0 開始；版更時已由更新資料包帶入，只在缺少時才問）
- 工具會保存哪些資料、舊資料格式是否改變
- 是否使用 AI 模型
- 專案裡的資料檔是否含真實客戶或個人資料、可不可以當測試資料
- 工具需要連外部網站或公司其他系統（上線後連不到，需開發者決定移除或提出申請）
- 套件只支援 Windows、或需要大幅改寫程式才能在容器執行
- 找到寫死的金鑰（AI 只回報位置與移除方式，不複製金鑰內容）
- 測試或驗證修三次仍失敗

AI 不可以做的事：把金鑰、密碼或 `.env` 放進 ZIP；放真實資料；為了通過而刪掉或跳過測試；版更時改 `tool.id`；自己填部門或 Owner（這兩項在平台上傳表單填）。

### 12.6 打包報告格式

```markdown
# 打包報告：<工具名稱> <版本>
- ZIP：<檔名>（<檔案數> 個檔案，<大小>）
- 類型：第一次上架／版本更新（上一版 <版本號>）
- tool.id：<…>　埠：<…>　健康檢查：<…>　資料目錄：<…>　使用 AI：是／否

## 改了什麼
- <檔案>：<為什麼改>

## 驗證結果
- 業務測試（不連網）：<通過數>/<總數>
- docker 建置（linux/arm64）：成功／失敗
- 健康檢查：<網址> 回應 <狀態碼>
- 預檢：通過（提醒 <n> 項）

## 需要開發者確認
- <問題或風險>

## 上傳後在預覽要測的功能
- <功能>
```
