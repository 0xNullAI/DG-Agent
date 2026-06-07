import { useCallback, useEffect, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  fetchMarketItems,
  markMarketDownloaded,
  type MarketItem,
  type MarketItemType,
} from '@/lib/market';

interface MarketImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: MarketItemType;
  // 返回 true 表示导入成功，对话框据此给出反馈。
  onImport: (item: MarketItem) => Promise<void> | void;
}

export function MarketImportDialog({
  open,
  onOpenChange,
  type,
  onImport,
}: MarketImportDialogProps) {
  const [items, setItems] = useState<MarketItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());

  const load = useCallback(
    async (q: string) => {
      setLoading(true);
      setError(null);
      try {
        const result = await fetchMarketItems({ type, q: q.trim() || undefined, sort: 'popular' });
        setItems(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [type],
  );

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => void load(query), query ? 300 : 0);
    return () => window.clearTimeout(id);
  }, [open, query, load]);

  async function handleImport(item: MarketItem) {
    await onImport(item);
    void markMarketDownloaded(item.id);
    setImportedIds((prev) => new Set(prev).add(item.id));
  }

  const label = type === 'waveform' ? '波形' : '场景';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        overlayClassName="bg-black/18 backdrop-blur-[2px]"
        className="max-w-[680px] overflow-hidden p-0"
      >
        <div className="panel-header">
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-[1.1rem] tracking-[-0.03em]">
              从市场导入{label}
            </DialogTitle>
            <DialogDescription className="mt-1">
              浏览社区上传的{label}，一键加入本地库
            </DialogDescription>
          </div>
        </div>

        <div className="px-5 pb-5">
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-faint)]" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`搜索${label}名称 / 标签`}
              className="pl-9"
            />
          </div>

          <div className="max-h-[52vh] space-y-1.5 overflow-y-auto">
            {loading && (
              <div className="py-8 text-center text-sm text-[var(--text-faint)]">加载中…</div>
            )}
            {error && (
              <div className="py-8 text-center text-sm text-[var(--danger)]">
                {error}
                <div className="mt-1 text-[12px] text-[var(--text-faint)]">
                  请确认已部署 DG-Market 并配置了市场地址
                </div>
              </div>
            )}
            {!loading && !error && items.length === 0 && (
              <div className="py-8 text-center text-sm text-[var(--text-faint)]">
                市场里还没有{label}
              </div>
            )}
            {!loading &&
              !error &&
              items.map((item) => {
                const imported = importedIds.has(item.id);
                return (
                  <div
                    key={item.id}
                    className="group flex items-center gap-3 rounded-[10px] px-3 py-2.5 hover:bg-[var(--bg-soft)]"
                  >
                    <span className="shrink-0 text-lg">
                      {type === 'scenario' ? item.icon || '🎭' : '〰️'}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-[var(--text)]">{item.name}</div>
                      <div className="mt-0.5 truncate text-[12px] text-[var(--text-faint)]">
                        {item.author ? `@${item.author}` : '匿名'} · ↓ {item.downloads}
                        {item.description ? ` · ${item.description}` : ''}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={imported ? 'ghost' : 'secondary'}
                      className="shrink-0 gap-1"
                      disabled={imported}
                      onClick={() => void handleImport(item)}
                    >
                      <Download className="h-3.5 w-3.5" />
                      {imported ? '已导入' : '导入'}
                    </Button>
                  </div>
                );
              })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
