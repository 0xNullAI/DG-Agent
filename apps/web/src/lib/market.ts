// DG-Market 社区市场客户端：拉取他人上传的波形 / 场景，供「从市场导入」使用。
// 部署 DG-Market 后，把下面的 VITE_MARKET_BASE_URL 设为你的 Worker 地址，
// 或直接改这里的兜底常量。

const FALLBACK_BASE_URL = 'https://dg-market.0xnullai.workers.dev';

export const MARKET_BASE_URL: string =
  (import.meta.env.VITE_MARKET_BASE_URL as string | undefined)?.replace(/\/$/, '') ??
  FALLBACK_BASE_URL;

export type MarketItemType = 'waveform' | 'scenario';

export interface MarketWaveformContent {
  frames: [number, number][];
  pulse?: string;
}

export interface MarketScenarioContent {
  prompt: string;
}

export interface MarketItem {
  id: string;
  type: MarketItemType;
  name: string;
  description?: string;
  author?: string;
  icon?: string;
  tags: string[];
  content: MarketWaveformContent | MarketScenarioContent;
  downloads: number;
  createdAt: number;
}

export interface FetchMarketParams {
  type: MarketItemType;
  q?: string;
  sort?: 'new' | 'popular';
  limit?: number;
}

export async function fetchMarketItems(params: FetchMarketParams): Promise<MarketItem[]> {
  const search = new URLSearchParams({ type: params.type });
  if (params.q) search.set('q', params.q);
  if (params.sort) search.set('sort', params.sort);
  search.set('limit', String(params.limit ?? 50));

  const res = await fetch(`${MARKET_BASE_URL}/api/items?${search.toString()}`);
  if (!res.ok) throw new Error(`市场请求失败 (${res.status})`);
  const data = (await res.json()) as { items?: MarketItem[] };
  return data.items ?? [];
}

export async function markMarketDownloaded(id: string): Promise<void> {
  await fetch(`${MARKET_BASE_URL}/api/items/${id}/download`, { method: 'POST' }).catch(() => {});
}
