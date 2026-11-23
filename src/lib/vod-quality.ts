/**
 * 点播 HLS 画质偏好：默认「最高画质」，并记住用户手动选择。
 * 只在 master playlist 有多档时生效；单码率源没有可选档位。
 */

export const VOD_QUALITY_STORAGE_KEY = 'libretv-vod-quality';

export type VodQualityPreference = 'auto' | 'highest' | number;

export interface VodQualityLevel {
  /** hls.levels 下标 */
  index: number;
  /** 视频高度（1080 / 720…），0 表示未知 */
  height: number;
}

/** 读取偏好：默认 highest；非法值回退 highest */
export function readVodQualityPreference(
  storage: Pick<Storage, 'getItem'> | null | undefined =
    typeof localStorage === 'undefined' ? null : localStorage
): VodQualityPreference {
  try {
    const raw = storage?.getItem(VOD_QUALITY_STORAGE_KEY)?.trim();
    if (!raw) return 'highest';
    if (raw === 'auto' || raw === 'highest') return raw;
    const height = parseInt(raw, 10);
    return Number.isFinite(height) && height > 0 ? height : 'highest';
  } catch {
    return 'highest';
  }
}

export function writeVodQualityPreference(
  pref: VodQualityPreference,
  storage: Pick<Storage, 'setItem'> | null | undefined =
    typeof localStorage === 'undefined' ? null : localStorage
): void {
  try {
    storage?.setItem(VOD_QUALITY_STORAGE_KEY, String(pref));
  } catch {
    // 隐私模式/配额满时静默失败，不影响播放
  }
}

/**
 * 选择目标档位下标；'auto' 返回 -1（交给 hls.js 自动切档）。
 * 指定高度不存在时选最接近的一档；距离相同时优先更高画质。
 */
export function chooseVodQualityLevel(
  levels: VodQualityLevel[],
  pref: VodQualityPreference
): number | undefined {
  const usable = levels.filter((l) => l.height > 0);
  if (usable.length === 0) return undefined;
  if (pref === 'auto') return -1;
  if (pref === 'highest') {
    return usable.reduce((best, l) => (l.height > best.height ? l : best), usable[0]).index;
  }
  const target = pref;
  const closest = [...usable].sort((a, b) => {
    const diff = Math.abs(a.height - target) - Math.abs(b.height - target);
    return diff !== 0 ? diff : b.height - a.height;
  })[0];
  return closest.index;
}

/** 档位标签：1080P / 720P；未知高度返回空串 */
export function vodQualityLabel(height: number | undefined): string {
  return height && height > 0 ? `${height}P` : '';
}
