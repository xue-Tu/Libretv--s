import { describe, expect, it } from 'vitest';
import {
  buildSuggestionItems,
  cleanHotWord,
  isLikelyVideoTitle,
  parseBaiduSuggestWords,
  parseDoubanSuggest,
  parseGoogleSuggestWords,
  suggestionSearchText,
} from './douban-suggest';

describe('suggestionSearchText', () => {
  it('去掉末尾「第 N 季」：中文数字、阿拉伯数字、有无空格都支持', () => {
    expect(suggestionSearchText('现在就出发 第五季')).toBe('现在就出发');
    expect(suggestionSearchText('庆余年 第2季')).toBe('庆余年');
    expect(suggestionSearchText('奔跑吧第10季')).toBe('奔跑吧');
    expect(suggestionSearchText('  现在就出发 第五季  ')).toBe('现在就出发');
  });

  it('季数在中间或标题本身就是季数时不误删', () => {
    expect(suggestionSearchText('斗罗大陆 第二季 绝世唐门')).toBe('斗罗大陆 第二季 绝世唐门');
    expect(suggestionSearchText('第五季')).toBe('第五季');
    expect(suggestionSearchText('现在就出发')).toBe('现在就出发');
    expect(suggestionSearchText('')).toBe('');
  });
});

describe('parseDoubanSuggest', () => {
  it('映射标题/搜索词/年份/类型，并按搜索词去重', () => {
    const items = parseDoubanSuggest([
      { title: '现在就出发 第五季', year: '2027', type: 'movie' },
      // 同一部剧的第四季：展示标题不同，但实际搜索词相同，只保留第一条
      { title: '现在就出发 第四季', year: '2026', type: 'tv' },
      { title: ' 现在不是出轨的问题 ', year: '26', type: 'unknown' },
      { title: '' },
      { title: 123 },
      null,
    ]);

    expect(items).toEqual([
      { title: '现在就出发 第五季', query: '现在就出发', year: '2027', type: 'movie' },
      { title: '现在不是出轨的问题', query: '现在不是出轨的问题' },
    ]);
  });

  it('非数组返回空，条数按 limit 截断', () => {
    expect(parseDoubanSuggest(null)).toEqual([]);
    expect(parseDoubanSuggest({ items: [] })).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `剧名${i}` }));
    expect(parseDoubanSuggest(many, 3)).toHaveLength(3);
  });
});

describe('parseBaiduSuggestWords', () => {
  it('从 JSONP 中取 s 数组，过滤非字符串并 trim', () => {
    expect(
      parseBaiduSuggestWords('cb({q:"现在",p:false,s:["现在就出发","现在有机器人吗"]});')
    ).toEqual(['现在就出发', '现在有机器人吗']);
    expect(parseBaiduSuggestWords('cb({q:"x",p:false,s:[1," 片名 ",null]});')).toEqual(['片名']);
  });

  it('空数组/格式错误返回空', () => {
    expect(parseBaiduSuggestWords('cb({q:"x",p:false,s:[]});')).toEqual([]);
    expect(parseBaiduSuggestWords('not jsonp')).toEqual([]);
    expect(parseBaiduSuggestWords('')).toEqual([]);
  });
});

describe('parseGoogleSuggestWords', () => {
  it('取 Google 数组的第二个元素', () => {
    expect(
      parseGoogleSuggestWords(
        '["现在",["现在就出发第四季","现在就出发","现在不是出轨的问题"],[],{}]'
      )
    ).toEqual(['现在就出发第四季', '现在就出发', '现在不是出轨的问题']);
  });

  it('格式错误返回空', () => {
    expect(parseGoogleSuggestWords('not json')).toEqual([]);
    expect(parseGoogleSuggestWords('["现在"]')).toEqual([]);
    expect(parseGoogleSuggestWords('["现在",[1," 片名 "]]')).toEqual(['片名']);
  });
});

describe('cleanHotWord', () => {
  it('交替剥离 SEO 修饰与季数后缀', () => {
    expect(cleanHotWord('现在就出发第四季在线观看')).toBe('现在就出发');
    expect(cleanHotWord('现在就出发第四季')).toBe('现在就出发');
    expect(cleanHotWord('现在就出发4')).toBe('现在就出发');
    expect(cleanHotWord('现在就出发综艺第4季')).toBe('现在就出发');
    expect(cleanHotWord('现在就出发 第五季 免费观看')).toBe('现在就出发');
  });

  it('不误伤纯数字片名和普通片名', () => {
    expect(cleanHotWord('2012')).toBe('2012');
    expect(cleanHotWord('现在就出发')).toBe('现在就出发');
  });
});

describe('isLikelyVideoTitle', () => {
  it('保留以输入开头的片名', () => {
    expect(isLikelyVideoTitle('现在就出发', '现在')).toBe(true);
    expect(isLikelyVideoTitle('现在不是出轨的问题', '现在')).toBe(true);
  });

  it('过滤疑问/时间/生活类搜索词', () => {
    expect(isLikelyVideoTitle('现在有机器人吗', '现在')).toBe(false);
    expect(isLikelyVideoTitle('现在几点', '现在')).toBe(false);
    expect(isLikelyVideoTitle('现在是美国时间几点', '现在')).toBe(false);
    expect(isLikelyVideoTitle('现在生意好做吗', '现在')).toBe(false);
  });
});

describe('buildSuggestionItems', () => {
  const doubanItems = [
    { title: '现在不是出轨的问题', query: '现在不是出轨的问题', year: '2026' },
    { title: '现在就出发 第五季', query: '现在就出发', year: '2027' },
  ];

  it('按热度词排序，并保留豆瓣的完整标题/年份', () => {
    expect(
      buildSuggestionItems(
        doubanItems,
        ['现在就出发第四季', '现在就出发', '现在不是出轨的问题', '现在是美国时间几点'],
        '现在'
      )
    ).toEqual([
      { title: '现在就出发 第五季', query: '现在就出发', year: '2027' },
      { title: '现在不是出轨的问题', query: '现在不是出轨的问题', year: '2026' },
    ]);
  });

  it('豆瓣为空时用热度词兜底，过滤噪声并去重', () => {
    expect(
      buildSuggestionItems(
        [],
        ['现在就出发第四季', '现在就出发', '现在有机器人吗', '现在是美国时间几点', '现在不是外遇的问题'],
        '现在'
      )
    ).toEqual([
      { title: '现在就出发', query: '现在就出发' },
      { title: '现在不是外遇的问题', query: '现在不是外遇的问题' },
    ]);
  });

  it('热度词未覆盖的豆瓣结果补在后面，并按 limit 截断', () => {
    expect(buildSuggestionItems(doubanItems, ['现在不是出轨的问题'], '现在')).toEqual([
      { title: '现在不是出轨的问题', query: '现在不是出轨的问题', year: '2026' },
      { title: '现在就出发 第五季', query: '现在就出发', year: '2027' },
    ]);
    expect(buildSuggestionItems(doubanItems, ['现在就出发', '现在不是出轨的问题'], '现在', 1)).toHaveLength(1);
  });
});
