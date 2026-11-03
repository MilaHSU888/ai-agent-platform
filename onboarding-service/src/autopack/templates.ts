/**
 * 原始碼自動打包：依語言範本產生 Dockerfile、.dockerignore、workhub.yaml 與輔助腳本（不用 AI）。
 * 埠號、健康檢查與「接受外部連線」的寫法取自上架 SOP 12.3 常見框架對照；workhub.yaml 以上架資料包的範本欄位為準。
 * 平台規定：資料只寫在 /data（DATA_DIR）、非 root 執行、業務測試在無網路容器執行。
 */
import { stringify } from 'yaml';
import type { Analysis } from './analyze.ts';

export type Generated = {
  files: Record<string, string>;
  command: string[];
  test: { command: string[]; label: string; smoke: boolean };
  dataDir: string | null;
  notes: string[];
};

type PrevManifest = { run?: { port?: number; healthCheck?: { path?: string; startPeriodSeconds?: number }; resources?: { cpu?: string; memory?: string } }; env?: unknown } | null;

const sh = (lines: string[]) => lines.join('\n') + '\n';

/** 專案沒有業務測試時用的「啟動測試」：在無網路容器裡啟動工具，健康檢查網址回應正常即通過 */
const SMOKE = sh([
  '#!/bin/sh',
  '# WorkHub 自動打包：啟動測試（專案沒有業務測試時使用；建議之後補上真正的業務測試）',
  '# 用法：smoke-test.sh <健康檢查網址> <啟動命令…>',
  'URL="$1"; shift',
  '"$@" > /tmp/workhub-smoke.log 2>&1 &',
  'PID=$!',
  'probe() {',
  '  if command -v curl >/dev/null 2>&1; then curl -fsS -o /dev/null "$URL";',
  '  elif command -v wget >/dev/null 2>&1; then wget -q -O /dev/null "$URL";',
  '  elif command -v python3 >/dev/null 2>&1; then python3 -c "import sys,urllib.request; sys.exit(0 if urllib.request.urlopen(sys.argv[1], timeout=3).status < 400 else 1)" "$URL";',
  '  elif command -v node >/dev/null 2>&1; then node -e "fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "$URL";',
  '  else return 1; fi',
  '}',
  'i=0',
  'while [ $i -lt 90 ]; do',
  '  if probe >/dev/null 2>&1; then echo "啟動測試通過：$URL"; kill $PID 2>/dev/null; exit 0; fi',
  '  if ! kill -0 $PID 2>/dev/null; then echo "工具啟動後就結束了："; cat /tmp/workhub-smoke.log; exit 1; fi',
  '  i=$((i+1)); sleep 1',
  'done',
  'echo "90 秒內健康檢查沒有回應："; tail -50 /tmp/workhub-smoke.log; kill $PID 2>/dev/null; exit 1',
]);

/** 啟動前的固定處理（不改工具程式）：
 *  1. 第一次啟動時把隨程式附帶的資料（例如範本）複製到資料目錄，不覆蓋已存在的檔案
 *  2. 程式寫在自己資料夾裡的資料（例如 data/outbox）：把那個資料夾連到資料目錄，更新後不會不見
 *  3. 程式用自己的環境變數名稱讀模型網址／金鑰／模型：填成平台注入的 OPENAI_* */
export function entrypoint(o: { seed: boolean; links: string[]; workdir: string; envMap: Analysis['ai']['envMap'] }): string {
  const q = (x: string) => `"${x.replace(/"/g, '')}"`;
  const lines = ['#!/bin/sh', '# WorkHub 自動打包產生：啟動前的固定處理（不改工具程式）', 'set -e'];
  if (o.seed) lines.push('# 1. 隨程式附帶的資料第一次啟動時複製到資料目錄', 'if [ -d /workhub/seed ] && [ -n "$DATA_DIR" ]; then', '  mkdir -p "$DATA_DIR"', '  cp -Rn /workhub/seed/. "$DATA_DIR"/ 2>/dev/null || true', 'fi');
  if (o.links.length) {
    lines.push('# 2. 程式寫在自己資料夾裡的資料：連到資料目錄', 'if [ -n "$DATA_DIR" ]; then');
    for (const p of o.links) {
      const app = `${o.workdir}/${p}`, data = `$DATA_DIR/${p}`;
      lines.push(`  mkdir -p ${q(data)}`, `  if [ -d ${q(app)} ] && [ ! -L ${q(app)} ]; then cp -Rn ${q(app + '/.')} ${q(data + '/')} 2>/dev/null || true; rm -rf ${q(app)}; fi`,
        `  mkdir -p ${q(app.slice(0, app.lastIndexOf('/')))}`, `  ln -sfn ${q(data)} ${q(app)}`);
    }
    lines.push('fi');
  }
  if (o.envMap) {
    const m = o.envMap;
    lines.push('# 3. 模型設定：程式讀自己的變數名稱，填成平台注入的值', `if [ -n "$OPENAI_BASE_URL" ]; then export ${m.base}="${m.stripV1 ? '${OPENAI_BASE_URL%/v1}' : '$OPENAI_BASE_URL'}"; fi`);
    if (m.key) lines.push(`if [ -n "$OPENAI_API_KEY" ]; then export ${m.key}="$OPENAI_API_KEY"; fi`);
    if (m.model) lines.push(`if [ -n "$OPENAI_MODEL" ]; then export ${m.model}="$OPENAI_MODEL"; fi`);
  }
  lines.push('exec "$@"');
  return sh(lines);
}

const DOCKERIGNORE = sh([
  '# WorkHub 自動打包產生：不放進映像檔的東西',
  '.git', '**/__pycache__', '**/*.pyc', '.venv', 'venv', 'env', 'node_modules', '.next/cache', '.env', '.env.*', '!.env.example',
  '**/.DS_Store', '*.ps1', '*.bat', '*.cmd', 'wheels', '.pytest_cache', 'target', 'bin', 'obj',
]);

const apt = (pkgs: string[]) => pkgs.length
  ? [`RUN apt-get update && apt-get install -y --no-install-recommends ${[...new Set(pkgs)].join(' ')} \\`, ' && rm -rf /var/lib/apt/lists/*']
  : [];

export function generate(a: Analysis, opts: { toolId: string; description: string; platforms: string[]; reqFile: string | null; hasLock: boolean; installable?: boolean; links?: string[]; prev?: PrevManifest; date: string }): Generated {
  const notes: string[] = [];
  const files: Record<string, string> = {};
  const usesData = a.language !== 'static' && a.framework !== 'spa' && (a.data.readsDataDirEnv || a.data.keep.length > 0 || a.data.seeds.length > 0 || a.data.outside.length > 0);
  const dataDir = usesData ? '/data' : null;
  const seed = a.data.seeds.length > 0 && !!dataDir;
  const links = dataDir && ['python', 'node'].includes(a.language ?? '') ? (opts.links ?? []) : [];
  const useEntry = seed || links.length > 0 || !!a.ai.envMap;
  const pkgs = a.systemPackages.map((p) => p.pkg);
  const head = [`# WorkHub 自動打包產生（${opts.date}）：${a.frameworkLabel}`, '# 依上架 SOP 第 5 節：非 root 執行、資料只寫在 /data、不放任何金鑰'];
  const envLine = (extra: string[]) => [`ENV TZ=Asia/Taipei${dataDir ? ` DATA_DIR=${dataDir}` : ''}${extra.length ? ' ' + extra.join(' ') : ''}`];
  const entry = useEntry ? ['ENTRYPOINT ["/workhub/entrypoint.sh"]'] : [];
  const port = opts.prev?.run?.port ?? a.port;
  let cmd: string[] = [];
  let df: string[] = [];
  let user = '10001';

  switch (a.language) {
    case 'python': {
      const ver = a.runtimeVersion ?? '3.12';
      const extra: string[] = [];
      if (a.framework === 'fastapi' && !a.manifest.deps.includes('uvicorn')) extra.push('uvicorn==0.34.0');
      if (['flask', 'django'].includes(a.framework ?? '') && !a.manifest.deps.includes('gunicorn')) extra.push('gunicorn==23.0.0');
      if (a.tests.command && !a.manifest.deps.includes('pytest')) extra.push('pytest');
      const install = opts.reqFile ? [`COPY ${opts.reqFile} ./`, `RUN pip install -r ${opts.reqFile}${extra.length ? ` && pip install ${extra.join(' ')}` : ''}`, 'COPY . .']
        : opts.installable ? ['COPY . .', `RUN pip install .${extra.length ? ` && pip install ${extra.join(' ')}` : ''}`]
        : ['COPY . .', ...(extra.length ? [`RUN pip install ${extra.join(' ')}`] : [])];
      const env = ['PYTHONDONTWRITEBYTECODE=1', 'PYTHONUNBUFFERED=1', 'PYTHONUTF8=1', 'PIP_NO_CACHE_DIR=1', 'PIP_DISABLE_PIP_VERSION_CHECK=1', 'HOME=/tmp'];
      if (a.framework === 'gradio') env.push('GRADIO_SERVER_NAME=0.0.0.0', `GRADIO_SERVER_PORT=${port}`);
      if (a.framework === 'dash') env.push('HOST=0.0.0.0', `PORT=${port}`);
      cmd = a.framework === 'streamlit' ? ['streamlit', 'run', a.entry ?? 'app.py', '--server.address=0.0.0.0', `--server.port=${port}`, '--server.headless=true', '--browser.gatherUsageStats=false']
        : a.framework === 'fastapi' ? ['uvicorn', a.entry ?? 'main:app', '--host', '0.0.0.0', '--port', String(port)]
        : a.framework === 'flask' || a.framework === 'django' ? ['gunicorn', '-b', `0.0.0.0:${port}`, '--timeout', '120', a.entry ?? 'app:app']
        : ['python', a.entry ?? 'app.py'];
      df = [...head, `FROM python:${ver}-slim-trixie`, ...envLine(env), ...apt(pkgs), 'WORKDIR /app', ...install, 'COPY .workhub /workhub',
        'RUN useradd --uid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin app \\',
        ` && mkdir -p ${dataDir ?? '/tmp/app'} && chown -R 10001 /app${dataDir ? ` ${dataDir}` : ''} && chmod +x /workhub/*.sh`];
      break;
    }
    case 'node': {
      const ver = a.runtimeVersion ?? '22';
      const ci = opts.hasLock ? 'npm ci --include=dev' : 'npm install --include=dev';
      if (a.framework === 'spa') {
        df = [...head, `FROM node:${ver}-bookworm-slim AS build`, 'WORKDIR /src', 'COPY package*.json ./', `RUN ${ci}`, 'COPY . .', 'RUN npm run build \\',
          ' && mkdir -p /out && cp -R $(for d in dist build out; do [ -d "$d" ] && echo "$d" && break; done)/. /out/',
          'FROM nginxinc/nginx-unprivileged:1.27-alpine', 'COPY --from=build /out /usr/share/nginx/html', 'COPY .workhub /workhub', 'USER root', 'RUN chmod +x /workhub/*.sh', 'USER 101'];
        cmd = ['nginx', '-g', 'daemon off;'];
        user = '101';
        notes.push('前端網頁：建置後的檔案由 nginx 提供，服務埠 8080');
        break;
      }
      cmd = a.framework === 'next' ? ['npx', 'next', 'start', '-H', '0.0.0.0', '-p', String(port)] : a.entry === 'npm start' || !a.entry ? ['npm', 'start'] : ['node', a.entry];
      df = [...head, `FROM node:${ver}-bookworm-slim`, ...envLine([`PORT=${port}`, 'HOST=0.0.0.0', 'NEXT_TELEMETRY_DISABLED=1']), ...apt(pkgs.filter((p) => p !== 'tzdata').concat('tzdata')), 'WORKDIR /app',
        'COPY package*.json ./', `RUN ${ci}`, 'COPY . .', ...(a.framework === 'next' ? ['RUN npm run build'] : []), 'COPY .workhub /workhub',
        `RUN mkdir -p ${dataDir ?? '/tmp/app'} && chown -R node /app${dataDir ? ` ${dataDir}` : ''} && chmod +x /workhub/*.sh`];
      user = 'node';
      break;
    }
    case 'java': {
      const v = a.runtimeVersion ?? '21';
      const maven = a.framework === 'spring-maven';
      df = [...head, maven ? `FROM maven:3.9-eclipse-temurin-${v} AS build` : `FROM gradle:8-jdk${v} AS build`, 'WORKDIR /src', 'COPY . .',
        maven ? 'RUN mvn -q -B -DskipTests package && cp $(ls target/*.jar | grep -v -e original -e sources -e plain | head -1) /app.jar'
          : 'RUN gradle -q bootJar -x test && cp $(ls build/libs/*.jar | grep -v plain | head -1) /app.jar',
        `FROM eclipse-temurin:${v}-jre`, ...envLine([]), ...apt(['curl', 'tzdata', ...pkgs]), 'WORKDIR /app', 'COPY --from=build /app.jar /app/app.jar', 'COPY .workhub /workhub',
        'RUN useradd --uid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin app \\', ` && mkdir -p ${dataDir ?? '/tmp/app'} && chown -R 10001 /app${dataDir ? ` ${dataDir}` : ''} && chmod +x /workhub/*.sh`];
      cmd = ['java', '-jar', '/app/app.jar', '--server.address=0.0.0.0', `--server.port=${port}`];
      break;
    }
    case 'dotnet': {
      const v = a.runtimeVersion ?? '8';
      const proj = a.entry ?? 'app.csproj';
      const asm = proj.split('/').pop()!.replace(/\.csproj$/i, '');
      df = [...head, `FROM mcr.microsoft.com/dotnet/sdk:${v}.0 AS build`, 'WORKDIR /src', 'COPY . .', `RUN dotnet publish "${proj}" -c Release -o /out`,
        `FROM mcr.microsoft.com/dotnet/aspnet:${v}.0`, ...envLine([`ASPNETCORE_HTTP_PORTS=${port}`, 'DOTNET_CLI_TELEMETRY_OPTOUT=1']), ...apt(['curl', 'tzdata', ...pkgs]), 'WORKDIR /app', 'COPY --from=build /out .', 'COPY .workhub /workhub',
        'RUN useradd --uid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin wh \\', ` && mkdir -p ${dataDir ?? '/tmp/app'} && chown -R 10001 /app${dataDir ? ` ${dataDir}` : ''} && chmod +x /workhub/*.sh`];
      cmd = ['dotnet', `${asm}.dll`];
      break;
    }
    case 'go': {
      df = [...head, `FROM golang:${a.runtimeVersion ?? '1.23'} AS build`, 'WORKDIR /src', 'COPY go.* ./', 'RUN go mod download', 'COPY . .', 'RUN CGO_ENABLED=0 go build -o /out/app .',
        'FROM debian:trixie-slim', ...envLine([`PORT=${port}`]), ...apt(['ca-certificates', 'curl', 'tzdata', ...pkgs]), 'WORKDIR /app', 'COPY --from=build /out/app /app/app', 'COPY .workhub /workhub',
        'RUN useradd --uid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin app \\', ` && mkdir -p ${dataDir ?? '/tmp/app'} && chown -R 10001 /app${dataDir ? ` ${dataDir}` : ''} && chmod +x /workhub/*.sh`];
      cmd = ['/app/app'];
      break;
    }
    case 'php': {
      const docroot = a.entry ?? '.';
      df = [...head, ...(opts.reqFile === 'composer.json' ? ['FROM composer:2 AS vendor', 'WORKDIR /app', 'COPY composer.* ./', 'RUN composer install --no-dev --no-interaction --prefer-dist --no-scripts'] : []),
        `FROM php:${a.runtimeVersion ?? '8.3'}-cli`, ...envLine([]), ...apt(['curl', 'tzdata', ...pkgs]), 'WORKDIR /app', 'COPY . .',
        ...(opts.reqFile === 'composer.json' ? ['COPY --from=vendor /app/vendor ./vendor'] : []), 'COPY .workhub /workhub',
        'RUN useradd --uid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin app \\', ` && mkdir -p ${dataDir ?? '/tmp/app'} && chown -R 10001 /app${dataDir ? ` ${dataDir}` : ''} && chmod +x /workhub/*.sh`];
      cmd = ['php', '-S', `0.0.0.0:${port}`, '-t', docroot];
      break;
    }
    case 'static': {
      df = [...head, 'FROM nginxinc/nginx-unprivileged:1.27-alpine', `COPY ${a.entry === '.' || !a.entry ? '.' : a.entry} /usr/share/nginx/html`, 'COPY .workhub /workhub', 'USER root',
        'RUN rm -rf /usr/share/nginx/html/.workhub /usr/share/nginx/html/Dockerfile /usr/share/nginx/html/workhub.yaml && chmod +x /workhub/*.sh', 'USER 101'];
      cmd = ['nginx', '-g', 'daemon off;'];
      user = '101';
      break;
    }
    default:
      throw new Error('不支援的專案類型');
  }
  df.push(...(a.language === 'static' || a.framework === 'spa' ? [] : [`USER ${user}`]), `EXPOSE ${port}`, ...entry, `CMD ${JSON.stringify(cmd)}`);
  files['Dockerfile'] = df.join('\n') + '\n';
  files['.dockerignore'] = DOCKERIGNORE;
  files['.workhub/smoke-test.sh'] = SMOKE;
  files['.workhub/entrypoint.sh'] = entrypoint({ seed, links, workdir: '/app', envMap: a.ai.envMap });
  if (links.length) notes.push(`程式寫在自己資料夾裡的 ${links.join('、')}，啟動時由平台連到資料目錄（不改程式），更新後不會不見`);
  if (a.ai.envMap) notes.push(`程式本來就是 OpenAI 相容介面，啟動時由平台把 ${[a.ai.envMap.base, a.ai.envMap.key, a.ai.envMap.model].filter(Boolean).join('、')} 填成平台模型的設定（不改程式）`);

  const health = opts.prev?.run?.healthCheck?.path ?? a.healthPath;
  const smoke = !a.tests.command;
  const testCmd = smoke ? ['/workhub/smoke-test.sh', `http://127.0.0.1:${port}${health}`, ...(useEntry ? ['/workhub/entrypoint.sh'] : []), ...cmd] : a.tests.command!;
  if (smoke) notes.push('專案沒有業務測試，先用「啟動測試」（工具能啟動、健康檢查有回應）；建議之後補上真正的業務測試');

  const heavy = pkgs.includes('libreoffice-writer-nogui') || pkgs.some((p) => p.startsWith('tesseract'));
  const mem = opts.prev?.run?.resources?.memory ?? (heavy ? '2Gi' : a.language === 'java' ? '1Gi' : a.language === 'python' || a.language === 'node' ? '1Gi' : '512Mi');
  const keepList = [...a.data.keep.map((d) => d.path), ...a.data.outside.map((o) => o.path)].filter(Boolean);
  const manifest = {
    schemaVersion: 'workhub/v1',
    tool: { id: opts.toolId, description: opts.description.slice(0, 80) || a.frameworkLabel },
    build: { dockerfile: 'Dockerfile', context: '.', platforms: opts.platforms },
    run: {
      port,
      healthCheck: { path: health, expectStatus: 200, startPeriodSeconds: opts.prev?.run?.healthCheck?.startPeriodSeconds ?? (a.language === 'java' ? 90 : a.language === 'python' ? 40 : 20) },
      ...(dataDir ? { persistentData: [{ path: dataDir, purpose: keepList.length ? `工具資料：${keepList.slice(0, 6).join('、')}` : '工具需要保存的資料' }] } : {}),
      resources: { cpu: opts.prev?.run?.resources?.cpu ?? '1', memory: mem },
    },
    test: { command: testCmd, timeoutSeconds: 900, network: 'none' },
    env: {
      required: [],
      optional: a.ai.uses ? [
        { name: 'OPENAI_BASE_URL', purpose: '平台模型轉接網址（平台注入）', secret: false },
        { name: 'OPENAI_API_KEY', purpose: '工具專用轉接通行碼（平台注入）', secret: true },
        { name: 'OPENAI_MODEL', purpose: '平台指定的模型（平台注入）', secret: false },
      ] : [],
    },
    model: { uses: a.ai.uses },
  };
  files['workhub.yaml'] = `# WorkHub 自動打包產生（${opts.date}）；版本號由平台自動編號，不用填\n${stringify(manifest, { lineWidth: 0 })}`;
  if (seed) notes.push(`隨程式附帶的資料（${a.data.seeds.length} 個檔案，例如範本）會在第一次啟動時複製到資料目錄，不覆蓋已存在的檔案`);
  return { files, command: cmd, test: { command: testCmd, label: smoke ? '啟動測試（工具能啟動、健康檢查有回應）' : a.tests.label, smoke }, dataDir, notes };
}
