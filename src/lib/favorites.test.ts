import { describe, expect, it } from 'vitest';
import { favoriteKey } from './favorites';

describe('favoriteKey', () => {
  it('忽略空格、标点与大小写差异', () => {
    expect(favoriteKey('庆余年 第二季')).toBe(favoriteKey('庆余年第二季'));
    expect(favoriteKey('Spider-Man')).toBe(favoriteKey('spider man'));
    expect(favoriteKey(' 现在就出发！')).toBe(favoriteKey('现在就出发'));
  });

  it('同名不同年份分开收藏', () => {
    expect(favoriteKey('射雕英雄传', '1983')).not.toBe(favoriteKey('射雕英雄传', '2003'));
    expect(favoriteKey('射雕英雄传')).not.toBe(favoriteKey('射雕英雄传', '1983'));
  });

  it('标题只有标点时仍能生成稳定且非空的 key', () => {
    const key = favoriteKey('！！！');
    expect(key.length).toBeGreaterThan(1);
    expect(key).toBe(favoriteKey('！！！'));
  });
});
