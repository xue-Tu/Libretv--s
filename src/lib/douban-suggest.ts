import type { SearchSuggestItem } from './types';
import { fetchUpstream, getCache, setCache } from './fetch-utils';
import { normalizeTitle } from './cms-parser';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * 搜索联想词：以豆瓣 subject_suggest 为片名来源，再用 Google suggestion 的
 * 搜索热度顺序重排；Google 不可用时回退百度 suggestion。
 *
 * 为什么不用采集站做联想：一次联想要打全部选中源（当前 34 个），
 * 每敲一个字就放大成几十个上游请求，比一次完整搜索还重。
 *
 * 为什么还要 Google/百度：豆瓣 suggest 只按「新片/相关度」排，实测输入「现在」
 * 时把《现在不是出轨的问题》排在《现在就出发》前面；Google suggestion 的排序
 * 更接近大众搜索热度（「现在就出发」排第一），百度作为 Google 被网络屏蔽时的
 * 兜底。两家结果都只用来排序，不直接展示，避免把「现在时间」这类非影视
 * 搜索词带进下拉。
 *
 * 联想只是输入辅助，任一上游失败都静默降级：豆瓣失败返回空；排序源失败沿用
 * 豆瓣原顺序。不影响手动搜索。
 */

const DOUBAN_SUGGEST_API = 'https://movie.douban.com/j/subject_suggest';
const GOOGLE_SUGGEST_API = 'https://suggestqueries.google.com/complete/search';
const BAIDU_SUGGEST_API = 'https://suggestion.baidu.com/su';
const CACHE_TTL = 10 * 60 * 1000;
/** 空结果也短暂缓存：避免用户输入一个没有联想的词时每次停顿都重打上游 */
const EMPTY_CACHE_TTL = 30 * 1000;
/** 排序源失败时只缓存 1 分钟，让下一次停顿有机会重新拿到热度顺序 */
const NO_RANK_CACHE_TTL = 60 * 1000;
const GOOGLE_TIMEOUT_MS = 2000;
const BAIDU_TIMEOUT_MS = 1500;
/** 豆瓣被限流时经常 1.5s+ 才返回空数组，超过这个时间就直接用热度词兜底 */
const DOUBAN_TIMEOUT_MS = 1500;
const MAX_ITEMS = 8;
const MAX_QUERY_LENGTH = 50;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/** 联想词尾部常见的 SEO 修饰，逐层剥离（可能叠加多段，如「…免费观看完整版」） */
const HOT_WORD_SUFFIX =
  /(免费观看|在线观看|在线播放|在线看|完整版|高清版|高清|全集|最新|在线|免费|观看|下载|电视剧|综艺|电影|动漫|小说|网盘|资源|国语版|粤语版|中字|HD|BD)$/u;

/** 明显不是影视片名的搜索词：时间/生活查询/工具类 */
const HOT_WORD_NOISE =
  /(几点|时间|天气|温度|日期|星期|农历|汇率|油价|金价|房价|工资|生意|旅游|哪里|怎么|多少|为什么|是什么|官网|客服|下载|安装|机票|火车|快递|医保|社保|公积金|退休|年龄|星座|运势|考试|成绩|签证|政策|贷款|利率|股票|基金|小说|txt|pdf)/iu;

/**
 * 固定目标专用连接池：联想是高频、低延迟场景，而 fetchUpstream 的 SSRF Agent
 * 每次请求都新建连接并禁用 keep-alive，实测每次都要重新 TLS 握手（2-3s）。
 * 这里保留 5 分钟长连接；豆瓣/Google/百度都是固定域名，q 只进查询参数，
 * 不存在 SSRF 面。
 */
const suggestAgent = new Agent({
  keepAliveTimeout: 5 * 60 * 1000,
  keepAliveMaxTimeout: 5 * 60 * 1000,
  connections: 4,
});

/**
 * 把联想词转成实际搜索关键词：去掉末尾的「第 N 季」。
 * 例如「现在就出发 第五季」→「现在就出发」。
 * 只处理末尾季数，避免误伤「斗罗大陆 第二季 绝世唐门」这类季数在中间的正式片名。
 */
export function suggestionSearchText(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) return '';
  const base = trimmed.replace(/\s*第\s*(?:[0-9]+|[一二两三四五六七八九十百]+)\s*季\s*$/u, '').trim();
  return base || trimmed;
}

/**
 * 解析豆瓣 suggest 原始数组：
 * - 丢弃缺少标题的脏数据；
 * - 按「实际搜索词」去重，避免第五季/第四季两行点了之后搜同一个词；
 * - 年份只保留四位数字，类型只保留 movie/tv；
 * - 最多返回 limit 条，顺序沿用豆瓣的相关度排序。
 */
export function parseDoubanSuggest(data: unknown, limit = MAX_ITEMS): SearchSuggestItem[] {
  if (!Array.isArray(data)) return [];
  const seen = new Set<string>();
  const items: SearchSuggestItem[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!title) continue;
    const query = suggestionSearchText(title).slice(0, 100);
    if (!query) continue;
    const dedupeKey = query.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const year = typeof raw.year === 'string' && /^\d{4}$/u.test(raw.year) ? raw.year : undefined;
    const type = raw.type === 'tv' ? 'tv' : raw.type === 'movie' ? 'movie' : undefined;
    items.push({ title: title.slice(0, 80), query, year, type });
    if (items.length >= limit) break;
  }
  return items;
}

/**
 * 从百度 suggestion 的 JSONP 响应中取 `s` 数组。
 * 响应形如 `cb({q:"现在",p:false,s:["现在就出发",...]});`，
 * 键没有引号，不是合法 JSON，因此只截取 `s:[...]` 这一段再解析。
 */
export function parseBaiduSuggestWords(text: string): string[] {
  const match = /s:(\[[\s\S]*?\])/u.exec(text);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12);
  } catch {
    return [];
  }
}

/**
 * 解析 Google suggestion 的 JSON 数组：
 * `["现在",["现在就出发第四季","现在就出发",...],[],{...}]`
 * 第二个元素就是按热度排好的搜索词。
 */
export function parseGoogleSuggestWords(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) return [];
    return (parsed[1] as unknown[])
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 12);
  } catch {
    return [];
  }
}

/**
 * 清洗热度词：去掉尾部 SEO 修饰、季数后缀与紧跟汉字的季数数字。
 * 例：「现在就出发第四季在线观看」→「现在就出发」；「现在就出发4」→「现在就出发」。
 */
export function cleanHotWord(word: string): string {
  let value = word.trim();
  value = suggestionSearchText(value);
  // SEO 修饰与季数可能交替出现（「…第四季免费观看」），交替剥 3 轮足够
  for (let i = 0; i < 3; i++) {
    const stripped = value.replace(HOT_WORD_SUFFIX, '').trim();
    if (stripped === value) break;
    value = suggestionSearchText(stripped);
  }
  // 去掉紧跟汉字的季数数字（「现在就出发4」），纯数字片名（「2012」）不受影响
  value = value.replace(/(\p{Script=Han})\s*\d{1,2}$/u, '$1').trim();
  return value;
}

/** 是否像一个以当前输入开头的影视片名（过滤「现在几点」「现在有机器人吗」等） */
export function isLikelyVideoTitle(word: string, keyword: string): boolean {
  if (!word || word.length > 30) return false;
  if (/[?？]$/u.test(word) || /(吗|呢|吧|么)$/u.test(word)) return false;
  if (HOT_WORD_NOISE.test(word)) return false;
  const normalizedWord = normalizeTitle(word);
  const normalizedKeyword = normalizeTitle(keyword);
  if (!normalizedWord || !normalizedKeyword) return false;
  return normalizedWord === normalizedKeyword || normalizedWord.startsWith(normalizedKeyword);
}

/**
 * 用 Google/百度热度词构建最终联想列表：
 * 1. 热度词先清洗、过滤、去重；
 * 2. 热度词能对上豆瓣片名时，采用豆瓣的完整标题/年份（如「现在就出发 第五季」）；
 * 3. 对不上豆瓣时，用清洗后的热度词本身兜底——豆瓣被限流返回空时，
 *    联想仍能靠 Google/百度正常工作；
 * 4. 热度词没覆盖到的豆瓣结果，按原顺序补在后面。
 */
export function buildSuggestionItems(
  doubanItems: SearchSuggestItem[],
  hotWords: string[],
  keyword: string,
  limit = MAX_ITEMS
): SearchSuggestItem[] {
  const result: SearchSuggestItem[] = [];
  const used = new Set<number>();
  const seenQueries = new Set<string>();

  const add = (item: SearchSuggestItem) => {
    const key = normalizeTitle(item.query);
    if (!key || seenQueries.has(key) || result.length >= limit) return;
    seenQueries.add(key);
    result.push(item);
  };

  const findMatch = (query: string): number => {
    const normalizedQuery = normalizeTitle(query);
    if (!normalizedQuery) return -1;
    // 先精确匹配，保留豆瓣的年份/类型
    for (let i = 0; i < doubanItems.length; i++) {
      if (!used.has(i) && normalizeTitle(doubanItems[i].query) === normalizedQuery) return i;
    }
    // 再宽松匹配：至少 3 个字，避免「现在」误配「现在不是…」
    if (normalizedQuery.length < 3) return -1;
    for (let i = 0; i < doubanItems.length; i++) {
      if (used.has(i)) continue;
      const itemQuery = normalizeTitle(doubanItems[i].query);
      if (itemQuery.startsWith(normalizedQuery) || normalizedQuery.startsWith(itemQuery)) return i;
    }
    return -1;
  };

  for (const raw of hotWords) {
    const word = cleanHotWord(raw);
    if (!isLikelyVideoTitle(word, keyword)) continue;
    const query = suggestionSearchText(word).slice(0, 100) || word.slice(0, 100);
    const matched = findMatch(query);
    if (matched >= 0) {
      used.add(matched);
      add(doubanItems[matched]);
    } else {
      add({ title: word.slice(0, 80), query });
    }
  }

  // 热度词没有覆盖到的豆瓣结果补在后面，避免漏掉冷门片名
  for (let i = 0; i < doubanItems.length; i++) {
    if (!used.has(i)) add(doubanItems[i]);
  }
  return result;
}

function fallbackProxies(): string[] {
  const proxy = process.env.FALLBACK_CORS_PROXY;
  return proxy ? [proxy] : [];
}

async function fetchSuggestJson(target: string, trusted = false): Promise<unknown> {
  // 直连豆瓣用专用长连接 Agent：目标域名是固定常量、q 只进查询参数，不存在 SSRF 面。
  // 降级代理地址来自部署配置，仍走 fetchUpstream 的 SSRF 校验。
  const res = trusted
    ? await undiciFetch(target, {
        dispatcher: suggestAgent,
        redirect: 'error',
        signal: AbortSignal.timeout(DOUBAN_TIMEOUT_MS),
        headers: { 'User-Agent': UA, Referer: 'https://movie.douban.com/', Accept: 'application/json' },
      })
    : await fetchUpstream(target, {
        timeoutMs: DOUBAN_TIMEOUT_MS,
        headers: { 'User-Agent': UA, Referer: 'https://movie.douban.com/', Accept: 'application/json' },
      });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchDoubanData(q: string): Promise<unknown> {
  const target = `${DOUBAN_SUGGEST_API}?q=${encodeURIComponent(q)}`;
  try {
    return await fetchSuggestJson(target, true);
  } catch {
    // 降级：经 FALLBACK_CORS_PROXY（与豆瓣推荐同一套降级链）
    for (const proxy of fallbackProxies()) {
      try {
        const data = await fetchSuggestJson(proxy + encodeURIComponent(target));
        if (data) return data;
      } catch {
        // 继续尝试下一个
      }
    }
  }
  return undefined;
}

/**
 * Google suggestion（firefox client）返回 UTF-8 JSON 数组，直接取第二个元素。
 * 失败由调用方的 allSettled/回退逻辑兜住，只影响排序。
 */
async function fetchGoogleWords(q: string): Promise<string[]> {
  const target = `${GOOGLE_SUGGEST_API}?client=firefox&hl=zh-CN&gl=cn&q=${encodeURIComponent(q)}`;
  const res = await undiciFetch(target, {
    dispatcher: suggestAgent,
    redirect: 'error',
    signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
    headers: { 'User-Agent': UA, Referer: 'https://www.google.com/' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseGoogleSuggestWords(await res.text());
}

/**
 * 百度 suggestion 返回 GBK 编码的 JSONP；用 TextDecoder('gbk') 解码后取 `s`。
 * Google 不可用时的兜底排序源。
 */
async function fetchBaiduWords(q: string): Promise<string[]> {
  const target = `${BAIDU_SUGGEST_API}?wd=${encodeURIComponent(q)}&cb=cb`;
  const res = await undiciFetch(target, {
    dispatcher: suggestAgent,
    redirect: 'error',
    signal: AbortSignal.timeout(BAIDU_TIMEOUT_MS),
    headers: { 'User-Agent': UA, Referer: 'https://www.baidu.com/' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder('gbk').decode(bytes);
  return parseBaiduSuggestWords(text);
}

export async function fetchDoubanSuggest(keyword: string): Promise<SearchSuggestItem[]> {
  const q = keyword.trim().slice(0, MAX_QUERY_LENGTH);
  if (!q) return [];

  const cacheKey = `search:suggest:${q.toLowerCase()}`;
  const cached = getCache<SearchSuggestItem[]>(cacheKey);
  if (cached) return cached;

  // 豆瓣提供片名，Google 提供排序；两边并行，互不阻塞对方的失败
  const [douban, google] = await Promise.allSettled([fetchDoubanData(q), fetchGoogleWords(q)]);
  const items = parseDoubanSuggest(douban.status === 'fulfilled' ? douban.value : undefined);

  let words = google.status === 'fulfilled' ? google.value : [];
  if (words.length === 0) {
    // Google 被网络屏蔽/限流时回退百度；只在需要时发这一次额外请求
    try {
      words = await fetchBaiduWords(q);
    } catch {
      words = [];
    }
  }

  const suggestions = buildSuggestionItems(items, words, q);

  const ttl =
    suggestions.length === 0
      ? EMPTY_CACHE_TTL
      : words.length > 0
        ? CACHE_TTL
        : NO_RANK_CACHE_TTL;
  setCache(cacheKey, suggestions, ttl);
  return suggestions;
}
