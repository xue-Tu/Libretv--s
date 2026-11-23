'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import type { HistoryEntry } from '@/lib/db';
import { buildWatchUrl, formatRelativeTime } from '@/lib/utils';
import { resolveSource, useAppStore } from '@/lib/store';
import { Icon, type IconName } from './icon';
import { SmartImage } from './smart-image';

/**
 * 首页「我的影视」快捷区：继续观看 + 我的收藏。
 * 只展示最近 8 条，完整列表在顶栏的观看历史 / 我的收藏抽屉里。
 * 没有数据时整块不渲染，不打扰首次使用的用户。
 */
export function MyLibrary() {
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);

  const history = useLiveQuery(
    () => db.history.orderBy('timestamp').reverse().limit(8).toArray(),
    []
  );
  const favorites = useLiveQuery(
    () => db.favorites.orderBy('createdAt').reverse().limit(8).toArray(),
    []
  );

  const historyCards = (history ?? []).map((h) => {
    const source = resolveSource({ customAPIs, envSources }, h.sourceKey);
    return {
      key: h.id,
      href: buildWatchUrl({
        sourceKey: h.sourceKey,
        vodId: h.vodId,
        index: h.episodeIndex,
        title: h.title,
        sourceUrl: h.sourceUrl ?? source?.url,
        detail: source?.detail,
      }),
      pic: h.pic,
      title: h.title,
      meta:
        h.totalEpisodes > 0
          ? `第 ${h.episodeIndex + 1}/${h.totalEpisodes} 集 · ${formatRelativeTime(h.timestamp)}`
          : formatRelativeTime(h.timestamp),
      progress: progressOf(h),
    };
  });

  const favoriteCards = (favorites ?? []).map((f) => ({
    key: f.id,
    href: buildWatchUrl({
      sourceKey: f.sourceKey,
      vodId: f.vodId,
      title: f.name,
      sourceUrl: f.sourceUrl,
      detail: f.detail,
    }),
    pic: f.pic,
    title: f.name,
    meta: [f.year, f.typeName].filter(Boolean).join(' · ') || f.sourceName || '已收藏',
    favorite: true,
  }));

  if (historyCards.length === 0 && favoriteCards.length === 0) return null;

  return (
    <div className="space-y-6 mb-8">
      {historyCards.length > 0 && (
        <LibraryRow title="继续观看" icon="clock" items={historyCards} />
      )}
      {favoriteCards.length > 0 && (
        <LibraryRow title="我的收藏" icon="bookmark" items={favoriteCards} />
      )}
    </div>
  );
}

interface LibraryCard {
  key: string;
  href: string;
  pic?: string;
  title: string;
  meta: string;
  progress?: number;
  favorite?: boolean;
}

function LibraryRow({
  title,
  icon,
  items,
}: {
  title: string;
  icon: IconName;
  items: LibraryCard[];
}) {
  return (
    <section aria-label={title}>
      <div className="flex items-center gap-1.5 mb-2.5">
        <h2 className="flex items-center gap-1.5 text-sm font-medium text-content">
          <Icon name={icon} className="w-4 h-4 text-accent" />
          {title}
        </h2>
      </div>
      <div className="flex gap-2.5 overflow-x-auto overscroll-x-contain pb-1 -mx-1 px-1 scrollbar-thin">
        {items.map((item) => (
          <LibraryCardView key={item.key} item={item} />
        ))}
      </div>
    </section>
  );
}

function LibraryCardView({ item }: { item: LibraryCard }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!item.pic && !imgFailed;

  return (
    <Link
      href={item.href}
      className="group w-[124px] sm:w-[136px] shrink-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      title={item.title}
    >
      <div className="relative aspect-[2/3] rounded-lg overflow-hidden bg-chip border border-line">
        {showImg ? (
          <SmartImage
            url={item.pic}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={item.title}
            className="absolute inset-0 w-full h-full object-cover transition-transform duration-200 group-hover:scale-[1.04]"
            onExhausted={() => setImgFailed(true)}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <Icon name="bookmark" className="w-7 h-7 text-faint" />
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/70 to-transparent" />
        {item.favorite && (
          <span className="absolute right-1.5 top-1.5 p-1 rounded-full bg-black/55 text-amber-300">
            <Icon name="bookmark" className="w-3 h-3" />
          </span>
        )}
        {typeof item.progress === 'number' && item.progress > 0 && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50">
            <div className="h-full bg-accent" style={{ width: `${item.progress}%` }} />
          </div>
        )}
      </div>
      <div className="mt-1.5 text-xs font-medium text-content leading-snug line-clamp-2">{item.title}</div>
      <div className="mt-0.5 text-[10px] text-faint truncate">{item.meta}</div>
    </Link>
  );
}

function progressOf(entry: HistoryEntry): number | undefined {
  if (!(entry.playbackPosition > 10 && entry.duration > 0 && entry.playbackPosition < entry.duration * 0.95)) {
    return undefined;
  }
  return Math.max(1, Math.min(100, Math.round((entry.playbackPosition / entry.duration) * 100)));
}
