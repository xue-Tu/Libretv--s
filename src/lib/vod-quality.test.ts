import { describe, expect, it } from 'vitest';
import {
  chooseVodQualityLevel,
  readVodQualityPreference,
  writeVodQualityPreference,
  VOD_QUALITY_STORAGE_KEY,
} from './vod-quality';

function fakeStorage(initial?: string) {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(VOD_QUALITY_STORAGE_KEY, initial);
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    map,
  };
}

describe('vod quality preference', () => {
  it('默认 highest，支持 auto / highest / 指定高度', () => {
    expect(readVodQualityPreference(fakeStorage())).toBe('highest');
    expect(readVodQualityPreference(fakeStorage('auto'))).toBe('auto');
    expect(readVodQualityPreference(fakeStorage('highest'))).toBe('highest');
    expect(readVodQualityPreference(fakeStorage('1080'))).toBe(1080);
    expect(readVodQualityPreference(fakeStorage('bad'))).toBe('highest');
  });

  it('写入失败不抛错', () => {
    expect(() =>
      writeVodQualityPreference(1080, {
        setItem: () => {
          throw new Error('quota');
        },
      })
    ).not.toThrow();
  });
});

describe('chooseVodQualityLevel', () => {
  const levels = [
    { index: 0, height: 360 },
    { index: 1, height: 720 },
    { index: 2, height: 1080 },
  ];

  it('auto 返回 -1，highest 返回最高档', () => {
    expect(chooseVodQualityLevel(levels, 'auto')).toBe(-1);
    expect(chooseVodQualityLevel(levels, 'highest')).toBe(2);
  });

  it('指定高度优先精确匹配，其次最接近', () => {
    expect(chooseVodQualityLevel(levels, 720)).toBe(1);
    expect(chooseVodQualityLevel(levels, 900)).toBe(2);
    expect(chooseVodQualityLevel(levels, 100)).toBe(0);
  });

  it('没有有效档位返回 undefined', () => {
    expect(chooseVodQualityLevel([], 'highest')).toBeUndefined();
    expect(chooseVodQualityLevel([{ index: 0, height: 0 }], 'highest')).toBeUndefined();
  });
});
