'use client';

import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import Link from 'next/link';
import { Drawer } from './drawer';
import { ConfirmDialog } from './confirm-dialog';
import { EmptyState, LoadingState } from './states';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import {
  db,
  clearFavorites,
  removeFavorite,
  restoreFavorite,
} from '@/lib/db';
import { MAX_FAVORITES, type FavoriteEntry } from '@/lib/favorites';
import { buildWatchUrl, cn, formatRelativeTime } from '@/lib/utils';
import { useToast } from './toast';
import { useAppStore } from '@/lib/store';

/** 未搜索时默认展示条数；更早的收藏用搜索查 */
const VISIBLE_LIMIT = 60;

/** 点播收藏抽屉：点击直接回到播放页，不用重新搜索。 */
export function FavoritesPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const favorites = useLiveQuery(
    () => db.favorites.orderBy('createdAt').reverse().limit(MAX_FAVORITES).toArray(),
    [open]
  );
  const { toast } = useToast();
  const [confirmClear, setConfirmClear] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const keyword = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const all = favorites ?? [];
    if (!keyword) return all.slice(0, VISIBLE_LIMIT);
    return all.filter(
      (f) =>
        f.name.toLowerCase().includes(keyword) ||
        (f.sourceName || '').toLowerCase().includes(keyword)
    );
  }, [favorites, keyword]);

  const total = favorites?.length ?? 0;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="我的收藏"
      width="max-w-lg"
      subheader={
        total > 0 ? (
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Icon
                name="search"
                className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-faint pointer-events-none"
              />
              <input
                type="text"
                className="w-full h-9 pl-8 pr-8 rounded-lg border border-line bg-chip text-sm text-content placeholder:text-faint focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/40"
                placeholder="搜索收藏..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="搜索收藏"
              />
              {query && (
                <button
                  type="button"
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-full text-faint hover:text-content hover:bg-hover transition-colors"
                  onClick={() => setQuery('')}
                  aria-label="清空搜索"
                >
                  <Icon name="close" className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
            <button
              className="shrink-0 px-2 py-1.5 rounded-md text-xs text-faint hover:text-danger hover:bg-hover transition-colors"
              onClick={() => setConfirmClear(true)}
            >
              清空收藏
            </button>
          </div>
        ) : undefined
      }
    >
      {!favorites ? (
        <LoadingState />
      ) : total === 0 ? (
        <EmptyState
          variant="plain"
          title="暂无收藏"
          description="在搜索结果卡片或详情弹窗点书签图标，就能把想看的影片存到这里"
        />
      ) : visible.length === 0 ? (
        <EmptyState variant="plain" title={`没有匹配「${query.trim()}」的收藏`} />
      ) : (
        <>
          {!keyword && total > VISIBLE_LIMIT && (
            <p className="text-xs text-faint mb-2">
              共 {total} 条收藏，仅显示最近 {VISIBLE_LIMIT} 条，可用上方搜索查找更早的收藏
            </p>
          )}
          <ul className="space-y-2">
            {visible.map((item) => (
              <FavoriteItem key={item.id} item={item} onClose={onClose} />
            ))}
          </ul>
        </>
      )}

      <ConfirmDialog
        open={confirmClear}
        danger
        title="清空全部收藏？"
        message={favorites ? `将删除 ${favorites.length} 条收藏，此操作不可撤销。` : undefined}
        confirmLabel="清空"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          void clearFavorites().then(() => toast('收藏已清空', 'success'));
          setConfirmClear(false);
        }}
      />
    </Drawer>
  );
}

function FavoriteItem({ item, onClose }: { item: FavoriteEntry; onClose: () => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const { toast } = useToast();
  const [imgFailed, setImgFailed] = useState(false);

  const href = buildWatchUrl({
    sourceKey: item.sourceKey,
    vodId: item.vodId,
    title: item.name,
    sourceUrl: item.sourceUrl,
    detail: item.detail,
  });

  const remove = () => {
    void removeFavorite(item.id).then(() => {
      toast('已取消收藏', 'info', {
        action: {
          label: '撤销',
          onClick: () => {
            void restoreFavorite(item).then(() => toast('已恢复收藏', 'success'));
          },
        },
      });
    });
  };

  return (
    <li className="relative group">
      <Link
        href={href}
        onClick={onClose}
        className="block bg-card hover:bg-hover rounded-lg p-3 pr-10 transition-colors"
      >
        <div className="flex items-center gap-3">
          {item.pic && !imgFailed ? (
            <SmartImage
              url={item.pic}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt=""
              className="w-10 h-14 object-cover rounded bg-chip"
              onExhausted={() => setImgFailed(true)}
            />
          ) : (
            <div className="w-10 h-14 rounded bg-chip flex items-center justify-center shrink-0">
              <Icon name="bookmark" className="w-4 h-4 text-faint" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-content truncate">{item.name}</div>
            <div className="text-xs text-faint mt-0.5 flex items-center gap-1.5 flex-wrap">
              {item.year && <span>{item.year}</span>}
              {item.typeName && <span>· {item.typeName}</span>}
              {item.sourceName && <span>· {item.sourceName}</span>}
              <span>· {formatRelativeTime(item.createdAt)}</span>
            </div>
          </div>
        </div>
      </Link>
      <button
        className={cn(
          'absolute right-2 top-2 p-2 rounded-full text-faint hover:text-danger',
          'opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity'
        )}
        aria-label="取消收藏"
        title="取消收藏（可在提示中撤销）"
        onClick={remove}
      >
        <Icon name="close" className="w-4 h-4" />
      </button>
    </li>
  );
}
