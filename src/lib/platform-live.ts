/**
 * 平台直播地址识别（客户端/服务端共用，纯函数，不引入 Node 依赖）。
 *
 * 这些平台不能像普通 IPTV 一样直接填 m3u8：
 * - B站：可用公开的直播间 playurl 接口解析（见 platform-live-resolver）；
 * - 抖音/虎牙/斗鱼：接口带签名/风控/防盗链，更适合交给外部转接服务。
 */

export type PlatformLivePlatform = 'douyin' | 'huya' | 'douyu' | 'bilibili';

export interface PlatformLiveInfo {
  platform: PlatformLivePlatform;
  /** 用于界面展示：抖音直播 / 虎牙直播 / 斗鱼直播 / B站直播 */
  label: string;
  /** 直播间号；短链/分享链接可能没有 */
  roomId?: string;
}

const LABELS: Record<PlatformLivePlatform, string> = {
  douyin: '抖音直播',
  huya: '虎牙直播',
  douyu: '斗鱼直播',
  bilibili: 'B站直播',
};

function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** 从路径/查询串里取第一个 2 位以上的数字作为直播间号 */
function extractRoomId(parsed: URL): string | undefined {
  for (const key of ['room_id', 'roomId', 'rid']) {
    const value = parsed.searchParams.get(key);
    if (value && /^\d+$/.test(value)) return value;
  }
  const match = parsed.pathname.match(/\/(\d+)(?:\/|$)/);
  return match?.[1];
}

/**
 * 识别直播间地址。普通 M3U/网页地址返回 null。
 * 支持：
 * - https://live.douyin.com/123456 / https://v.douyin.com/xxxx
 * - https://www.huya.com/660000
 * - https://www.douyu.com/9999
 * - https://live.bilibili.com/6 / https://b23.tv/xxxx
 */
export function detectPlatformLive(url: string): PlatformLiveInfo | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();

  if (hostIs(host, 'douyin.com')) {
    return { platform: 'douyin', label: LABELS.douyin, roomId: extractRoomId(parsed) };
  }
  if (hostIs(host, 'huya.com')) {
    return { platform: 'huya', label: LABELS.huya, roomId: extractRoomId(parsed) };
  }
  if (hostIs(host, 'douyu.com')) {
    return { platform: 'douyu', label: LABELS.douyu, roomId: extractRoomId(parsed) };
  }
  if (host === 'b23.tv' || host === 'bili2233.cn' || hostIs(host, 'bilibili.com')) {
    // 只把 live.bilibili.com / 短链当直播；普通 www.bilibili.com 视频页不处理
    if (hostIs(host, 'bilibili.com') && host !== 'live.bilibili.com') return null;
    return { platform: 'bilibili', label: LABELS.bilibili, roomId: extractRoomId(parsed) };
  }
  return null;
}

/** 列表里展示的小标签；不是平台直播时返回 undefined */
export function platformLiveLabel(url: string): string | undefined {
  return detectPlatformLive(url)?.label;
}
