import { normalizeTitle } from './cms-parser';

/**
 * 点播收藏：按「片名 + 年份」去重，而不是按源去重。
 * 同一部剧常有多条采集源，用户收藏的是这部剧；具体播放源只作为打开时的首选，
 * 源失效后仍可在播放页「切换资源」。
 */
export interface FavoriteEntry {
  /** favoriteKey(name, year) */
  id: string;
  name: string;
  year?: string;
  pic?: string;
  typeName?: string;
  remarks?: string;
  /** 首选播放源 */
  sourceKey: string;
  sourceName?: string;
  sourceUrl?: string;
  detail?: string;
  vodId: string;
  createdAt: number;
  updatedAt: number;
}

/** 收藏上限：与历史一样做本地淘汰，避免无限增长 */
export const MAX_FAVORITES = 200;

/**
 * 收藏主键：忽略标题里的空格、标点与大小写，同名不同年份（翻拍）分开。
 * 标题只有标点时 normalizeTitle 会得到空串，退回原文小写，避免所有异常条目挤到同一个 key。
 */
export function favoriteKey(name: string, year?: string): string {
  const normalized = normalizeTitle(name) || name.trim().toLowerCase();
  return `${normalized}|${(year || '').trim()}`;
}
