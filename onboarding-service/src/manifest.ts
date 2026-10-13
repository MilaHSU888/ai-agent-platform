/**
 * workhub.yaml v1 驗證。平台只採信這裡驗證過的欄位；Owner、部門、權限一律以平台表單為準。
 * 不在平台寫死任何工具名稱、框架或埠號。
 */
import { parse } from 'yaml';
import type { Config } from './config.ts';
import type { Issue } from './zip-intake.ts';

export type Manifest = {
  schemaVersion: 'workhub/v1';
  tool: { id: string; name: string; version: string; description: string };
  build: { dockerfile: string; context: string; platforms: string[] };
  run: {
    port: number;
    command?: string[];
    healthCheck: { path: string; expectStatus: number; startPeriodSeconds: number };
    persistentData: { path: string; purpose: string }[];
    resources: { cpu: string; memory: string };
  };
  test?: { command: string[]; timeoutSeconds: number; network: 'none' };
  env: { required: EnvVar[]; optional: EnvVar[] };
  model: { uses: boolean; provider?: string; approvedEndpoint?: string; fallback?: string };
};
export type EnvVar = { name: string; purpose: string; secret: boolean };

const FILE = 'workhub.yaml';
const SYSTEM_DIRS = ['/', '/bin', '/boot', '/dev', '/etc', '/lib', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var/run'];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isStrArr = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0);

export function memoryToBytes(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(Mi|Gi|M|G)$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round(n * (m[2].startsWith('G') ? 1024 ** 3 : 1024 ** 2));
}

export function validateManifest(text: string, files: Set<string>, cfg: Config): { manifest?: Manifest; issues: Issue[]; warnings: Issue[] } {
  const issues: Issue[] = [];
  const warnings: Issue[] = [];
  const bad = (field: string, reason: string, fix: string) => issues.push({ file: FILE, field, reason, fix });
  const warn = (field: string, reason: string, fix: string) => warnings.push({ file: FILE, field, reason, fix });

  let doc: unknown;
  try {
    doc = parse(text, { maxAliasCount: 20, uniqueKeys: true });
  } catch (e) {
    return { issues: [{ file: FILE, reason: `YAML 格式錯誤：${(e as Error).message.split('\n')[0]}`, fix: '用範本對照縮排與冒號後重新提交' }], warnings };
  }
  if (!isObj(doc)) return { issues: [{ file: FILE, reason: '內容不是設定物件', fix: '請從平台提供的 workhub.yaml 範本開始填寫' }], warnings };

  for (const k of Object.keys(doc)) {
    if (!['schemaVersion', 'tool', 'build', 'run', 'test', 'env', 'model'].includes(k)) warn(k, '未知欄位，平台會忽略', '確認拼字或移除此欄位');
  }
  if (doc.schemaVersion !== 'workhub/v1') bad('schemaVersion', `必須為 workhub/v1（目前：${String(doc.schemaVersion)}）`, '把 schemaVersion 設為 workhub/v1');

  const tool = isObj(doc.tool) ? doc.tool : {};
  if (!isObj(doc.tool)) bad('tool', '缺少 tool 區塊', '補上 tool.id、name、version、description');
  if (typeof tool.id !== 'string' || !/^[a-z][a-z0-9-]{2,40}$/.test(tool.id)) {
    bad('tool.id', '工具 ID 必須是 3～41 個小寫英數字或連字號，且以英文字母開頭', '例如 quote-aggregator');
  }
  if (typeof tool.name !== 'string' || !tool.name.trim()) bad('tool.name', '缺少工具名稱', '填寫使用者看得懂的名稱');
  if (typeof tool.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tool.version)) {
    bad('tool.version', '版本需為語意化版本（例如 1.2.0 或 1.2.0-pilot.1）', '修正版本字串；每次提交更新需遞增');
  }
  if (typeof tool.description !== 'string' || !tool.description.trim()) warn('tool.description', '缺少說明', '補上工具用途說明');

  const build = isObj(doc.build) ? doc.build : {};
  if (!isObj(doc.build)) bad('build', '缺少 build 區塊', '補上 build.dockerfile 與 build.context');
  const context = typeof build.context === 'string' ? build.context.replace(/^\.\/?/, '').replace(/\/$/, '') : '';
  if (build.context !== undefined && (typeof build.context !== 'string' || build.context.includes('..') || build.context.startsWith('/'))) {
    bad('build.context', '建置目錄必須是 ZIP 內的相對路徑', '使用 . 或 ZIP 內的子資料夾');
  }
  const dockerfile = typeof build.dockerfile === 'string' ? build.dockerfile : 'Dockerfile';
  const dfPath = [context, dockerfile.replace(/^\.\//, '')].filter(Boolean).join('/');
  if (dockerfile.includes('..') || dockerfile.startsWith('/')) bad('build.dockerfile', 'Dockerfile 路徑不安全', '使用 ZIP 內的相對路徑');
  else if (!files.has(dfPath)) bad('build.dockerfile', `ZIP 中找不到 ${dfPath}`, '把 Dockerfile 放進提交包，或修正路徑');
  const platforms = Array.isArray(build.platforms) ? build.platforms : [cfg.hostPlatform];
  if (!platforms.includes(cfg.hostPlatform)) {
    bad('build.platforms', `本機只能建置 ${cfg.hostPlatform}（目前宣告：${platforms.join(', ')}）`, `把 ${cfg.hostPlatform} 加入 platforms，並確認依賴支援此架構`);
  }

  const run = isObj(doc.run) ? doc.run : {};
  if (!isObj(doc.run)) bad('run', '缺少 run 區塊', '補上服務埠、健康檢查與資源需求');
  if (!Number.isInteger(run.port) || (run.port as number) < 1024 || (run.port as number) > 65535) {
    bad('run.port', '服務埠必須是 1024～65535 的整數', '填寫工具在容器內監聽的埠，例如 8501');
  }
  if (run.command !== undefined && !isStrArr(run.command)) bad('run.command', '啟動命令必須是字串陣列', '例如 ["python", "app.py"]；或刪除以使用 Dockerfile 的 CMD');
  const hc = isObj(run.healthCheck) ? run.healthCheck : null;
  if (!hc) bad('run.healthCheck', '缺少健康檢查', '補上 healthCheck.path（例如 /health）與 expectStatus');
  else {
    if (typeof hc.path !== 'string' || !hc.path.startsWith('/')) bad('run.healthCheck.path', '健康檢查路徑必須以 / 開頭', '例如 /_stcore/health');
    if (hc.expectStatus !== undefined && !(Number.isInteger(hc.expectStatus) && (hc.expectStatus as number) >= 200 && (hc.expectStatus as number) < 400)) {
      bad('run.healthCheck.expectStatus', '預期狀態碼需為 200～399', '一般填 200');
    }
    if (hc.startPeriodSeconds !== undefined && !(typeof hc.startPeriodSeconds === 'number' && hc.startPeriodSeconds >= 0 && hc.startPeriodSeconds <= 600)) {
      bad('run.healthCheck.startPeriodSeconds', '啟動等待秒數需為 0～600', '依工具啟動時間填寫，例如 40');
    }
  }
  const pd = run.persistentData === undefined ? [] : run.persistentData;
  if (!Array.isArray(pd)) bad('run.persistentData', '持久資料必須是清單', '例如 - path: /data');
  else {
    if (pd.length > 1) bad('run.persistentData', '本機試點每個工具只支援一個持久資料目錄', '把資料集中在單一目錄，例如 /data');
    for (const [i, d] of pd.entries()) {
      if (!isObj(d) || typeof d.path !== 'string' || !d.path.startsWith('/') || SYSTEM_DIRS.includes(d.path.replace(/\/$/, '') || '/')) {
        bad(`run.persistentData[${i}].path`, '持久資料路徑必須是容器內的絕對路徑，且不能是系統目錄', '例如 /data');
      }
    }
  }
  if (Array.isArray(pd) && pd.length === 0) warn('run.persistentData', '未宣告持久資料目錄，容器重建後資料會遺失', '若工具會保存資料，請宣告 /data 之類的目錄');
  const res = isObj(run.resources) ? run.resources : {};
  const cpu = Number(res.cpu ?? 1);
  if (!(cpu > 0 && cpu <= 8)) bad('run.resources.cpu', 'CPU 需為 0～8', '例如 "2"');
  const mem = memoryToBytes(String(res.memory ?? '1Gi'));
  if (mem === null || mem < 128 * 1024 ** 2 || mem > 16 * 1024 ** 3) bad('run.resources.memory', '記憶體需為 128Mi～16Gi，格式如 512Mi 或 3Gi', '例如 3Gi');

  let test: Manifest['test'];
  if (doc.test === undefined) {
    warn('test', '未提供業務測試，測試階段會顯示「未驗證」且不能送交核准', '補上 test.command 與非敏感測試資料');
  } else if (!isObj(doc.test) || !isStrArr(doc.test.command)) {
    bad('test.command', '測試命令必須是字串陣列', '例如 ["python", "-m", "pytest", "-q", "tests"]');
  } else {
    const t = doc.test;
    const timeout = t.timeoutSeconds === undefined ? 900 : Number(t.timeoutSeconds);
    if (!(timeout > 0 && timeout * 1000 <= cfg.timeouts.testMaxMs)) bad('test.timeoutSeconds', `測試逾時需為 1～${cfg.timeouts.testMaxMs / 1000} 秒`, '例如 900');
    if (t.network !== undefined && t.network !== 'none') bad('test.network', '業務測試不得連外，只接受 none', '把 test.network 設為 none，並改用測試資料');
    test = { command: t.command as string[], timeoutSeconds: timeout, network: 'none' };
  }

  const envBlock = isObj(doc.env) ? doc.env : {};
  const envs: Record<'required' | 'optional', EnvVar[]> = { required: [], optional: [] };
  for (const kind of ['required', 'optional'] as const) {
    const listV = envBlock[kind] ?? [];
    if (!Array.isArray(listV)) { bad(`env.${kind}`, '必須是清單', '例如 - name: API_URL'); continue; }
    for (const [i, v] of listV.entries()) {
      if (!isObj(v) || typeof v.name !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(v.name)) {
        bad(`env.${kind}[${i}].name`, '環境變數名稱需為大寫英數字與底線', '例如 OPENAI_BASE_URL');
        continue;
      }
      if ('value' in v || 'default' in v) bad(`env.${kind}[${i}]`, '不可在提交包寫入環境變數的值', '移除 value／default；值由平台安全設定注入');
      envs[kind].push({ name: v.name, purpose: String(v.purpose ?? ''), secret: v.secret === true });
    }
  }

  const model = isObj(doc.model) ? doc.model : { uses: false };
  if (model.uses === true) {
    if (typeof model.approvedEndpoint !== 'string' || !cfg.approvedModelEndpoints.includes(model.approvedEndpoint)) {
      bad('model.approvedEndpoint', `模型端點必須是平台核准清單之一（${cfg.approvedModelEndpoints.join('、')}）`, '填寫核准端點代號；實際網址由平台對應');
    }
    if (model.fallback !== undefined && model.fallback !== 'none') bad('model.fallback', '不得設定退回其他模型端點', '把 fallback 設為 none');
  }

  if (issues.length) return { issues, warnings };
  return {
    issues,
    warnings,
    manifest: {
      schemaVersion: 'workhub/v1',
      tool: { id: tool.id as string, name: (tool.name as string).trim(), version: tool.version as string, description: String(tool.description ?? '') },
      build: { dockerfile: dfPath, context: context || '.', platforms: platforms as string[] },
      run: {
        port: run.port as number,
        command: run.command as string[] | undefined,
        healthCheck: { path: hc!.path as string, expectStatus: (hc!.expectStatus as number) ?? 200, startPeriodSeconds: (hc!.startPeriodSeconds as number) ?? 30 },
        persistentData: (pd as Obj[]).map((d) => ({ path: d.path as string, purpose: String(d.purpose ?? '') })),
        resources: { cpu: String(cpu), memory: String(res.memory ?? '1Gi') },
      },
      test,
      env: envs,
      model: { uses: model.uses === true, provider: model.provider as string | undefined, approvedEndpoint: model.approvedEndpoint as string | undefined, fallback: 'none' },
    },
  };
}
