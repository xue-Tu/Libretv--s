'use client';

import { useState, type KeyboardEvent, type MouseEvent } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, toggleFavorite } from '@/lib/db';
import { favoriteKey, type FavoriteEntry } from '@/lib/favorites';
import { cn } from '@/lib/utils';
import { useToast } from './toast';

export type FavoriteInput = Omit<FavoriteEntry, 'id' | 'createdAt' | 'updatedAt'>;

/**
 * 收藏按钮（书签图标，已收藏时实心）。
 * 用于搜索结果卡片（浮在封面上）和详情弹窗（普通按钮样式）。
 * 收藏按「片名+年份」去重，同一部剧不同源只保留一条。
 */
export function FavoriteButton({
  item,
  className,
  variant = 'overlay',
  size = 'md',
  showLabel = false,
  onToggled,
}: {
  item: FavoriteInput;
  className?: string;
  /** overlay：封面上的半透明浮层按钮；plain：普通工具按钮 */
  variant?: 'overlay' | 'plain';
  size?: 'sm' | 'md';
  /** 显示「收藏 / 已收藏」文字（播放页操作条） */
  showLabel?: boolean;
  onToggled?: (favorited: boolean) => void;
}) {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const id = favoriteKey(item.name, item.year);
  const favorited = useLiveQuery(() => db.favorites.get(id).then(Boolean), [id]);

  const toggle = async (e: MouseEvent<HTMLButtonElement>) => {
    // 卡片本身是 role=button：阻止收藏点击冒泡成「打开详情」
    e.preventDefault();
    e.stopPropagation();
    if (pending) return;
    setPending(true);
    try {
      const next = await toggleFavorite(item);
      onToggled?.(next);
      toast(next ? '已加入收藏' : '已取消收藏', next ? 'success' : 'info');
    } catch (err) {
      toast(err instanceof Error ? err.message : '收藏失败，请重试', 'error');
    } finally {
      setPending(false);
    }
  };

  const stopKey = (e: KeyboardEvent<HTMLButtonElement>) => e.stopPropagation();

  return (
    <button
      type="button"
      onClick={toggle}
      onKeyDown={stopKey}
      className={cn(
        'inline-flex items-center justify-center transition-colors disabled:opacity-60',
        showLabel
          ? 'gap-1.5 rounded-md border border-line bg-chip px-2.5 py-1.5 text-xs font-medium text-muted hover:text-content hover:bg-hover'
          : 'rounded-full',
        !showLabel &&
          (variant === 'overlay'
            ? 'bg-black/55 text-white backdrop-blur-sm hover:bg-black/75 border border-white/10'
            : 'text-muted hover:text-content hover:bg-hover'),
        favorited &&
          (showLabel
            ? 'border-accent/40 bg-accent/10 text-accent'
            : variant === 'overlay'
              ? 'text-amber-300'
              : 'text-accent'),
        !showLabel && (size === 'sm' ? 'p-1.5' : 'p-2'),
        className
      )}
      aria-label={favorited ? `取消收藏 ${item.name}` : `收藏 ${item.name}`}
      aria-pressed={Boolean(favorited)}
      title={favorited ? '取消收藏' : '收藏'}
      disabled={pending}
    >
      <svg
        className={showLabel ? 'w-3.5 h-3.5' : size === 'sm' ? 'w-4 h-4' : 'w-5 h-5'}
        viewBox="0 0 24 24"
        fill={favorited ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M6 4.5A1.5 1.5 0 0 1 7.5 3h9A1.5 1.5 0 0 1 18 4.5V21l-6-4-6 4V4.5Z"
        />
      </svg>
      {showLabel && <span>{favorited ? '已收藏' : '收藏'}</span>}
    </button>
  );
}
