import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchDoubanSuggest } from '@/lib/douban-suggest';

export const runtime = 'nodejs';

/**
 * 搜索联想词：输入框下方提示。
 * 只做锦上添花——上游失败或没有联想时返回空数组（HTTP 200），
 * 让客户端安静地回退到「最近搜索」，不弹错误、不打断输入。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const q = (new URL(req.url).searchParams.get('q') || '').trim().slice(0, 50);
  if (!q) return NextResponse.json({ items: [] });

  try {
    const items = await fetchDoubanSuggest(q);
    return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ items: [] });
  }
}
