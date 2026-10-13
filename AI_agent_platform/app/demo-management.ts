export type DemoStatus = '運行中' | '驗證中' | '待核准' | '維護中' | '已下架';
export type DemoConfig = { status: DemoStatus; category: string; model: string; localOnly: boolean; owner: string; url: string; version: string; previousVersion: string; access: boolean; description: string; cpu: string; memory: string; gpu: string; network: string; scope: string; quota: string; checked: boolean; tested: boolean };
export type DemoTool = { id: string; name: string; description: string; department: string; type: 'AI' | '非 AI'; users: number; runs: number; saved: number; color: string; icon: string; url?: string };
export type DemoIssue = { id: string; tool: string; text: string; attachment: string; status: '待初判' | '處理中' | '已解決'; reply: string };
/** 模型端點（示範）：正式版由 LLM Proxy 提供清單與切換，這裡只存在本機瀏覽器 */
export type DemoModel = { name: string; kind: '地端' | '雲端'; provider: string; note: string; enabled: boolean };
export type DemoModelChange = { tool: string; from: string; to: string; reason: string; actor: string; time: string };
export type DemoState = { configs: Record<string, DemoConfig>; added: DemoTool[]; categories: string[]; favorites: string[]; clicks: { tool: string; time: string }[]; audit: string[]; issues: DemoIssue[]; requests: string[]; endpoints: string[]; models?: DemoModel[]; modelHistory?: DemoModelChange[] };
export const DEFAULT_LOCAL_MODEL = '地端 5090｜Strata Qwen3.8 Flash Next IQ3_S';
export const DEFAULT_MODELS: DemoModel[] = [
  { name: DEFAULT_LOCAL_MODEL, kind: '地端', provider: 'Wisely 5090（經 LLM Proxy）', note: '試點已實測：文字與圖片皆可', enabled: true },
  { name: '地端 5090｜Strata Qwen3.8 Flash Next IQ3_XXS', kind: '地端', provider: 'Wisely 5090（經 LLM Proxy）', note: '較小、較快；數字辨識準確度較低', enabled: true },
  { name: '雲端｜通用大型模型（示範）', kind: '雲端', provider: '待客戶核准', note: '資料政策、契約與金鑰管理待定', enabled: false },
];
/** 舊示範資料的模型名稱對應到新清單 */
const LEGACY: Record<string, string> = { '示範地端模型': DEFAULT_LOCAL_MODEL, '示範雲端模型': '雲端｜通用大型模型（示範）', '核准模型端點（wisely-5090）': DEFAULT_LOCAL_MODEL, '待確認 LLM 使用情況': DEFAULT_LOCAL_MODEL };
export const modelsOf = (s: DemoState): DemoModel[] => s.models ?? DEFAULT_MODELS;
export const normalizeModel = (name: string) => LEGACY[name] ?? name;
export const modelKind = (s: DemoState, name: string): DemoModel['kind'] | undefined => modelsOf(s).find((m) => m.name === normalizeModel(name))?.kind ?? (name.includes('雲端') ? '雲端' : name.includes('地端') ? '地端' : undefined);
export function defaultConfig(tool: Pick<DemoTool, 'id' | 'type' | 'description' | 'url'>): DemoConfig {
  return {status:'運行中', category:tool.id === 'vision' ? '品質檢驗' : tool.id === 'quote' ? '採購作業' : '協作效率', model:tool.type === '非 AI' ? '不使用模型' : DEFAULT_LOCAL_MODEL,localOnly:true,owner:'待確認 Owner',url:tool.url ?? '',version:'v1.0.0',previousVersion:'',access:true,description:tool.description,cpu:'待確認',memory:'待確認',gpu:'待確認',network:'預設禁止未申告連線',scope:'所屬部門（示範）',quota:'待確認',checked:false,tested:false};
}
export function initialDemo(): DemoState { return {configs:{},added:[],categories:['協作效率','採購作業','品質檢驗','生產製造'],favorites:[],clicks:[],audit:[],issues:[],requests:[],endpoints:['示範地端模型','示範雲端模型']}; }
export function entryBlock(config: DemoConfig): string { return !config.access ? '尚未取得示範使用權限' : config.status !== '運行中' ? `工具${config.status}，暫停開啟` : ''; }
export function modelAllowed(config: DemoConfig, model: string) { return !(config.localOnly && model.includes('雲端')); }
export function transition(config: DemoConfig, status: DemoStatus): DemoConfig {
  if(status === '待核准' && (!config.checked || !config.tested)) throw new Error('請先完成示範檢查及測試確認');
  if(status === '運行中' && ['驗證中','待核准'].includes(config.status) && (!config.checked || !config.tested)) throw new Error('檢查及測試尚未完成，不可發布');
  return {...config,status};
}
