'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addSearchHistory, clearSearchHistory, db, removeSearchHistory, restoreSearchHistory } from '@/lib/db';
import type { SearchSuggestItem } from '@/lib/types';
import { api } from '@/lib/client-api';
import { useAuth } from './auth';
import { cn } from '@/lib/utils';
import { useToast } from './toast';
import { Icon } from './icon';

/** 下拉最多展示条数，与 db 层 MAX_SEARCH_HISTORY 保持一致 */
const HISTORY_LIMIT = 10;
/** 联想请求防抖：中文输入法组合期间不查询，停顿后再打上游 */
const SUGGEST_DEBOUNCE_MS = 250;
/** 下拉最多展示的联想条数（服务端也按 8 条截断） */
const SUGGEST_LIMIT = 8;

export interface SearchCompletionItem {
  kind: 'suggestion' | 'history';
  /** 实际用于搜索的关键词：联想词会去掉末尾「第 N 季」 */
  text: string;
  /** 下拉中展示的文案（联想词保留完整季数标题） */
  label: string;
  /** 年份等次要信息 */
  meta?: string;
}

/** 简单防抖：空字符串立即生效，避免清空输入后还挂着上一次的联想 */
function useDebouncedValue(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (!value) {
      setDebounced('');
      return;
    }
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * 搜索框补全逻辑：最近搜索 + 豆瓣联想词（首页与顶栏共用）。
 *
 * - 聚焦展开、输入过滤最近搜索；
 * - 输入停顿 250ms 后拉联想词，中文输入法组合期间不请求；
 * - 联想优先展示，最近搜索在后；同一关键词只出现一次；
 * - ↑/↓ 在「联想 + 历史」整体列表里移动，Enter 采用当前高亮项。
 */
export function useSearchHistory(input: string) {
  const { toast } = useToast();
  const { verified } = useAuth();
  const [open, setOpen] = useState(false);
  /** 键盘高亮项下标，-1 表示未选中 */
  const [activeIndex, setActiveIndex] = useState(-1);
  /** 中文输入法组合期间不请求联想，避免把拼音当成关键词打上游 */
  const [composing, setComposing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const keyword = input.trim();
  const debouncedKeyword = useDebouncedValue(keyword, SUGGEST_DEBOUNCE_MS);

  const history = useQuery({
    queryKey: ['searchHistory'],
    queryFn: () => db.searchHistory.orderBy('timestamp').reverse().limit(HISTORY_LIMIT).toArray(),
  });

  // 未登录时不请求：登录框后面的输入框仍可能被键入，避免无谓的 401
  const suggest = useQuery({
    queryKey: ['searchSuggest', debouncedKeyword],
    queryFn: ({ signal }) => api.suggest(debouncedKeyword, signal),
    enabled: verified && open && !composing && debouncedKeyword.length > 0,
    staleTime: 10 * 60 * 1000,
    retry: false,
  });

  const historyMatches = useMemo(() => {
    const all = history.data ?? [];
    const lower = keyword.toLowerCase();
    return lower ? all.filter((h) => h.text.toLowerCase().includes(lower)) : all;
  }, [history.data, keyword]);

  const suggestItems = useMemo<SearchCompletionItem[]>(() => {
    const list: SearchSuggestItem[] = suggest.data?.items ?? [];
    return list.slice(0, SUGGEST_LIMIT).map((s) => ({
      kind: 'suggestion',
      text: s.query,
      label: s.title,
      meta: s.year,
    }));
  }, [suggest.data]);

  // 联想 + 最近搜索合并成一个可键盘导航的列表；同一搜索词不重复出现
  const items = useMemo<SearchCompletionItem[]>(() => {
    const historyTexts = new Set(historyMatches.map((h) => h.text));
    return [
      ...suggestItems.filter((s) => !historyTexts.has(s.text)),
      ...historyMatches.map((h) => ({ kind: 'history' as const, text: h.text, label: h.text })),
    ];
  }, [suggestItems, historyMatches]);

  const suggestLoading =
    suggest.isFetching && debouncedKeyword.length > 0 && !composing && items.every((i) => i.kind === 'history');

  // 唯一命中项与输入内容完全一致时不展开：否则会盖住用户刚敲进去的内容
  const visible = open && (items.length > 0 || suggestLoading) && !(items.length === 1 && items[0].text === keyword);

  // 联想结果异步到达后列表会变长/变短，清掉旧高亮，避免指向已失效的项
  const itemsKey = items.map((item) => `${item.kind}:${item.text}:${item.label}`).join('\n');
  useEffect(() => setActiveIndex(-1), [itemsKey]);

  // 点按下拉之外的任意位置收起
  useEffect(() => {
    if (!visible) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [visible]);

  const close = () => {
    setOpen(false);
    setActiveIndex(-1);
  };

  /** 记录一次搜索；顺带刷新下拉数据（历史也会在播放页被写入） */
  const record = (text: string) => {
    addSearchHistory(text)
      .then(() => history.refetch())
      .catch(() => {});
  };

  const remove = (text: string) => {
    setActiveIndex(-1);
    removeSearchHistory(text).then(() => history.refetch());
  };

  const clearAll = async () => {
    const snapshot = history.data ?? [];
    if (snapshot.length === 0) return;
    close();
    await clearSearchHistory();
    await history.refetch();
    // 轻量破坏性操作：给一次撤销机会，不打断式弹确认
    toast('已清空搜索记录', 'info', {
      action: {
        label: '撤销',
        onClick: () => {
          restoreSearchHistory(snapshot).then(() => history.refetch());
        },
      },
    });
  };

  const onFocus = () => {
    setOpen(true);
    history.refetch();
  };

  const onCompositionStart = () => setComposing(true);
  const onCompositionEnd = () => setComposing(false);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>, onPick: (text: string) => void) => {
    if (e.key === 'Escape') {
      close();
      return;
    }
    if (!visible) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (items.length === 0) return;
      e.preventDefault();
      setActiveIndex((i) => (e.key === 'ArrowDown' ? (i + 1) % items.length : i <= 0 ? items.length - 1 : i - 1));
    } else if (e.key === 'Enter' && activeIndex >= 0 && items[activeIndex]) {
      // 有高亮项时 Enter 采用该项，不再提交输入框原文
      e.preventDefault();
      onPick(items[activeIndex].text);
    }
  };

  return {
    visible,
    items,
    activeIndex,
    containerRef,
    suggestLoading,
    close,
    record,
    remove,
    clearAll,
    onFocus,
    onCompositionStart,
    onCompositionEnd,
    onKeyDown,
    /** 输入变化时清掉键盘高亮，避免指向已过滤掉的项 */
    resetActive: () => setActiveIndex(-1),
  };
}

/**
 * 搜索补全浮层：紧贴输入框下方，与输入框「拼成同一个面板」。
 * - 不留间隙、不画上边框、上角为直角：上圆角与上边框由输入框容器补齐，
 *   因此接缝处既不会出现缝隙，也不会出现双线；
 * - 外框取 accent 色，与输入框的聚焦边框同色，避免拼接处「上半蓝、下半灰」断色；
 * - 左右内边距与输入框文字（pl-4）对齐，使下拉文字与输入内容在同一条竖线上；
 * - 作为浮层不占文档流，出现/消失不会引起下方内容跳动。
 */
export function SearchHistoryDropdown({
  id,
  items,
  activeIndex,
  suggestLoading,
  onPick,
  onRemove,
  onClearAll,
}: {
  /** 同时作为 listbox 的 id 前缀：外部输入框用 aria-controls 指向它 */
  id: string;
  items: SearchCompletionItem[];
  activeIndex: number;
  suggestLoading: boolean;
  onPick: (text: string) => void;
  onRemove: (text: string) => void;
  onClearAll: () => void;
}) {
  const suggestionCount = items.filter((item) => item.kind === 'suggestion').length;
  const hasSuggestions = suggestionCount > 0;
  const hasHistory = items.length > suggestionCount;

  return (
    <div
      className={cn(
        'absolute left-0 right-0 top-full z-40 overflow-hidden text-left',
        'rounded-b-xl border-x border-b border-accent bg-surface-raised shadow-2xl animate-fade-in'
      )}
    >
      <div
        id={id}
        role="listbox"
        aria-label="搜索建议与最近搜索"
        className="max-h-[min(70vh,400px)] overflow-y-auto scrollbar-thin"
      >
        {suggestLoading && !hasSuggestions && (
          <div className="flex items-center gap-1.5 px-4 py-2.5 text-xs text-faint border-b border-line">
            <span
              className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin"
              aria-hidden
            />
            正在联想…
          </div>
        )}

        {hasSuggestions && (
          <>
            <div className="flex items-center justify-between pl-4 pr-2 py-2 border-b border-line">
              <span className="flex items-center gap-1.5 text-xs text-faint">
                <Icon name="search" className="w-3.5 h-3.5" />
                搜索建议
              </span>
            </div>
            <ul role="group" aria-label="搜索建议" className="py-1">
              {items.slice(0, suggestionCount).map((item, i) => (
                <li
                  key={`${item.kind}:${item.text}:${item.label}`}
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  className={cn('flex items-center hover:bg-hover', i === activeIndex && 'bg-hover')}
                >
                  <button
                    type="button"
                    className="flex-1 min-w-0 pl-4 pr-2 py-2.5 text-left text-sm text-content flex items-center gap-2"
                    onClick={() => onPick(item.text)}
                  >
                    <span className="flex-1 min-w-0 truncate">{item.label}</span>
                    {item.meta && <span className="shrink-0 text-xs text-faint tabular-nums">{item.meta}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {hasHistory && (
          <>
            <div
              className={cn(
                'flex items-center justify-between pl-4 pr-2 py-2 border-b border-line',
                hasSuggestions && 'border-t'
              )}
            >
              <span className="flex items-center gap-1.5 text-xs text-faint">
                <Icon name="clock" className="w-3.5 h-3.5" />
                最近搜索
              </span>
              <button
                type="button"
                className="px-2 py-1 rounded-md text-xs text-faint hover:text-danger hover:bg-hover transition-colors"
                onClick={onClearAll}
              >
                清空
              </button>
            </div>
            <ul role="group" aria-label="最近搜索" className="py-1">
              {items.slice(suggestionCount).map((item, offset) => {
                const i = suggestionCount + offset;
                return (
                  <li
                    key={`${item.kind}:${item.text}:${item.label}`}
                    id={`${id}-${i}`}
                    role="option"
                    aria-selected={i === activeIndex}
                    className={cn('flex items-center hover:bg-hover', i === activeIndex && 'bg-hover')}
                  >
                    <button
                      type="button"
                      className="flex-1 min-w-0 pl-4 pr-2 py-2.5 text-left text-sm text-content truncate"
                      onClick={() => onPick(item.text)}
                    >
                      {item.label}
                    </button>
                    <button
                      type="button"
                      className="shrink-0 p-1.5 mr-2 rounded-md text-faint hover:text-danger hover:bg-chip transition-colors"
                      aria-label={`删除搜索记录 ${item.text}`}
                      onClick={() => onRemove(item.text)}
                    >
                      <Icon name="close" className="w-3.5 h-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
