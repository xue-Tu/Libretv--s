import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/douban-suggest', () => ({
  fetchDoubanSuggest: vi.fn(),
}));

import { GET } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { fetchDoubanSuggest } from '@/lib/douban-suggest';
import type { SearchSuggestItem } from '@/lib/types';

const mockedSuggest = vi.mocked(fetchDoubanSuggest);

function makeRequest(q?: string, withCookie = true): Request {
  const url = new URL('https://local.test/api/suggest');
  if (q !== undefined) url.searchParams.set('q', q);
  const headers: Record<string, string> = {};
  if (withCookie) {
    const { token } = signSession();
    headers.cookie = `${SESSION_COOKIE}=${token}`;
  }
  return new Request(url, { headers });
}

beforeAll(() => {
  process.env.PASSWORD = 'test-password-123';
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/suggest', () => {
  it('未登录返回 401，且不请求上游', async () => {
    const res = await GET(makeRequest('现在', false));
    expect(res.status).toBe(401);
    expect(mockedSuggest).not.toHaveBeenCalled();
  });

  it('空关键词直接返回空列表', async () => {
    const res = await GET(makeRequest('   '));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [] });
    expect(mockedSuggest).not.toHaveBeenCalled();
  });

  it('关键词 trim 后查询，并原样返回联想结果', async () => {
    const items: SearchSuggestItem[] = [
      { title: '现在就出发 第五季', query: '现在就出发', year: '2027', type: 'movie' },
    ];
    mockedSuggest.mockResolvedValue(items);

    const res = await GET(makeRequest('  现在  '));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items });
    expect(mockedSuggest).toHaveBeenCalledWith('现在');
  });

  it('上游异常时静默降级为空列表', async () => {
    mockedSuggest.mockRejectedValue(new Error('upstream down'));
    const res = await GET(makeRequest('现在'));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ items: [] });
  });
});
