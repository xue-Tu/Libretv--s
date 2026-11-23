import type { LiveChannel, LivePlaylistResponse } from './types';
import type { PlatformLiveInfo } from './platform-live';
import { fetchUpstream } from './fetch-utils';
import { parseM3u } from './m3u-parser';

/**
 * 平台直播解析（仅服务端）：
 * - B站：内置官方公开 playurl 接口，无需外部服务；
 * - 抖音/虎牙/斗鱼：走 PLATFORM_LIVE_RELAY 配置的外部转接服务；
 * - B站短链或内置解析失败时，也回退到外部转接。
 *
 * 外部转接约定（GET）：
 *   PLATFORM_LIVE_RELAY=https://relay.example.com/resolve?url={url}
 *   {url} 会被替换为 encodeURIComponent(直播间地址)；也可不带占位符，自动追加 ?url=
 * 可选请求头：
 *   PLATFORM_LIVE_RELAY_TOKEN -> Authorization: Bearer <token>
 * 响应支持：
 *   1) JSON：{"url":"https://...m3u8","name":"房间名","group":"分组","logo":"..."}
 *   2) JSON：{"streams":[{"url":"...","name":"..."}]}
 *   3) text/plain：直接返回一个 http(s) 流地址
 *   4) M3U 文本（#EXTM3U...）
 */

const UA =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const DEFAULT_GROUP = '平台直播';
const RELAY_TIMEOUT_MS = 12_000;
const BILIBILI_TIMEOUT_MS = 8_000;

function relayConfigured(): string | undefined {
  return process.env.PLATFORM_LIVE_RELAY?.trim() || undefined;
}

/** 构造转接服务请求地址；模板不含 {url} 时自动补 ?url= */
export function buildRelayUrl(template: string, roomUrl: string): string {
  if (template.includes('{url}')) {
    return template.split('{url}').join(encodeURIComponent(roomUrl));
  }
  const url = new URL(template);
  url.searchParams.set('url', roomUrl);
  return url.toString();
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function defaultChannelName(info: PlatformLiveInfo): string {
  return `${info.label}${info.roomId ? ` ${info.roomId}` : ''}`;
}

function groupsOf(channels: LiveChannel[]): string[] {
  return [...new Set(channels.map((c) => c.group).filter((g): g is string => Boolean(g)))].sort((a, b) =>
    a.localeCompare(b, 'zh')
  );
}

/** 单个 JSON 流对象/字符串 -> LiveChannel；非法地址返回 undefined */
function toChannel(
  raw: unknown,
  info: PlatformLiveInfo,
  index: number,
  baseUrl: string
): LiveChannel | undefined {
  const record = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : undefined;
  const rawUrl =
    typeof raw === 'string'
      ? raw
      : typeof record?.url === 'string'
        ? record.url
        : typeof record?.streamUrl === 'string'
          ? record.streamUrl
          : typeof record?.stream_url === 'string'
            ? record.stream_url
            : typeof record?.playUrl === 'string'
              ? record.playUrl
              : typeof record?.m3u8 === 'string'
                ? record.m3u8
                : typeof record?.flv === 'string'
                  ? record.flv
                  : undefined;
  if (!rawUrl) return undefined;
  let url: string;
  try {
    url = new URL(rawUrl, baseUrl).href;
  } catch {
    return undefined;
  }
  if (!isHttpUrl(url)) return undefined;

  const name =
    (typeof record?.name === 'string' && record.name.trim()) ||
    (typeof record?.title === 'string' && record.title.trim()) ||
    defaultChannelName(info);
  const group =
    (typeof record?.group === 'string' && record.group.trim()) ||
    DEFAULT_GROUP;
  const logo =
    (typeof record?.logo === 'string' && record.logo.trim()) ||
    (typeof record?.cover === 'string' && record.cover.trim()) ||
    undefined;
  const id =
    (typeof record?.id === 'string' && record.id.trim()) ||
    `${info.platform}_${info.roomId || 'room'}_${index}`;

  return { id, name, url, group, logo, tvgId: `${info.platform}_${info.roomId || ''}` || undefined };
}

/**
 * 把转接服务响应归一化为播放列表。
 * 支持 JSON 对象/数组、纯文本流地址、M3U 文本；导出供单测直接覆盖。
 */
export function normalizeRelayPayload(
  payload: unknown,
  info: PlatformLiveInfo,
  baseUrl: string
): LivePlaylistResponse {
  const channels: LiveChannel[] = [];
  const seen = new Set<string>();

  const add = (raw: unknown) => {
    const channel = toChannel(raw, info, channels.length, baseUrl);
    if (!channel || seen.has(channel.url)) return;
    seen.add(channel.url);
    channels.push(channel);
  };

  const takeM3u = (text: string) => {
    const parsed = parseM3u(text, baseUrl);
    for (const c of parsed) add({ ...c, group: c.group || DEFAULT_GROUP });
  };

  const walk = (value: unknown, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') {
      const text = value.trim();
      if (text.startsWith('#EXTM3U')) takeM3u(text);
      else add(text);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value !== 'object') return;

    const obj = value as Record<string, unknown>;
    for (const key of ['m3u', 'playlist', 'm3u8Text']) {
      const text = obj[key];
      if (typeof text === 'string' && text.trim().startsWith('#EXTM3U')) {
        takeM3u(text);
        return;
      }
    }
    // 直接对象：{url, name,...}
    add(obj);
    for (const key of ['streams', 'channels', 'list', 'items', 'data']) {
      if (obj[key] != null) walk(obj[key], depth + 1);
    }
  };

  walk(payload);
  if (channels.length === 0) {
    throw new Error('外部转接服务没有返回可播放的流地址');
  }

  return {
    name: defaultChannelName(info),
    channels,
    groups: groupsOf(channels),
  };
}

/** 调用外部转接服务并把响应转为播放列表 */
async function resolveViaRelay(roomUrl: string, info: PlatformLiveInfo): Promise<LivePlaylistResponse> {
  const template = relayConfigured();
  if (!template) {
    throw new Error(
      `${info.label}需要配置外部转接服务：请设置环境变量 PLATFORM_LIVE_RELAY（URL 模板含 {url}）`
    );
  }
  const target = buildRelayUrl(template, roomUrl);
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Accept: 'application/json, text/plain, */*',
  };
  const token = process.env.PLATFORM_LIVE_RELAY_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  // 转接服务由部署者配置，允许自建内网地址；连接层放行仍需 LIVE_ALLOW_PRIVATE=1
  const res = await fetchUpstream(target, {
    timeoutMs: RELAY_TIMEOUT_MS,
    retries: 0,
    allowPrivate: true,
    headers,
  });
  if (!res.ok) {
    throw new Error(`外部转接服务请求失败: HTTP ${res.status}`);
  }
  const text = await res.text();
  const trimmed = text.trim();
  let payload: unknown = trimmed;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      payload = JSON.parse(text);
    } catch {
      // 保持纯文本 URL
    }
  }
  return normalizeRelayPayload(payload, info, target);
}

interface BiliPlayInfo {
  code?: number;
  message?: string;
  data?: {
    live_status?: number;
    room_info?: { title?: string; user_cover?: string; keyframe?: string };
    playurl_info?: {
      playurl?: {
        stream?: Array<{
          protocol_name?: string;
          format?: Array<{
            format_name?: string;
            codec?: Array<{
              codec_name?: string;
              current_qn?: number;
              base_url?: string;
              url_info?: Array<{ host?: string; extra?: string }>;
            }>;
          }>;
        }>;
      };
    };
  };
}

/** B站 qn -> 可读画质；4K/2K 需要账号权限，未登录通常只有 250（超清） */
function qnLabel(qn?: number): string | undefined {
  if (!qn) return undefined;
  if (qn >= 20000) return '4K';
  if (qn >= 15000) return '2K';
  if (qn >= 10000) return '原画';
  if (qn >= 400) return '蓝光';
  if (qn >= 250) return '超清';
  if (qn >= 150) return '高清';
  return '流畅';
}

interface BiliCandidate {
  url: string;
  qn: number;
  codec: string;
}

function biliCandidates(stream: {
  format?: Array<{
    codec?: Array<{
      codec_name?: string;
      current_qn?: number;
      base_url?: string;
      url_info?: Array<{ host?: string; extra?: string }>;
    }>;
  }>;
}): BiliCandidate[] {
  const out: BiliCandidate[] = [];
  for (const format of stream.format ?? []) {
    for (const codec of format.codec ?? []) {
      const info = codec.url_info?.[0];
      if (!codec.base_url || !info?.host) continue;
      const url = `${info.host}${codec.base_url}${info.extra || ''}`;
      if (!isHttpUrl(url)) continue;
      out.push({ url, qn: Number(codec.current_qn) || 0, codec: codec.codec_name || '' });
    }
  }
  return out;
}

/** 同一条 stream 内优先 avc（浏览器兼容），再取 qn 最高的一条 */
function bestBiliCandidate(stream: Parameters<typeof biliCandidates>[0]): BiliCandidate | undefined {
  const all = biliCandidates(stream);
  if (all.length === 0) return undefined;
  const avc = all.filter((c) => c.codec === 'avc');
  const pool = avc.length > 0 ? avc : all;
  return pool.sort((a, b) => b.qn - a.qn)[0];
}

/**
 * 从 B站 playurl 响应中挑一条流：优先 FLV（HLS 节点在当前网络常挂起），
 * 同协议内优先 avc、再取 qn 最高。返回 qn 供调用方展示画质。
 */
export function pickBilibiliStream(
  data: BiliPlayInfo['data']
): { url: string; name?: string; logo?: string; qn?: number } | undefined {
  const streams = data?.playurl_info?.playurl?.stream ?? [];
  const logo = data?.room_info?.user_cover || data?.room_info?.keyframe;

  const flv = streams.find((s) => s.protocol_name === 'http_stream');
  const flvPick = flv ? bestBiliCandidate(flv) : undefined;
  if (flvPick) {
    return { url: flvPick.url, name: data?.room_info?.title, logo, qn: flvPick.qn };
  }
  const hls = streams.find((s) => s.protocol_name === 'http_hls');
  const hlsPick = hls ? bestBiliCandidate(hls) : undefined;
  if (hlsPick) {
    return { url: hlsPick.url, name: data?.room_info?.title, logo, qn: hlsPick.qn };
  }
  return undefined;
}

interface BiliRoomInfo {
  code?: number;
  data?: { title?: string; user_cover?: string; live_status?: number };
}

/** B站直播 qn：默认请求 4K（20000）；实际返回受账号 Cookie/大会员权限限制 */
function biliQn(): number {
  const n = parseInt(process.env.BILIBILI_QN || '20000', 10);
  if (!Number.isFinite(n) || n < 80) return 20000;
  return Math.min(20000, n);
}

/** B站接口请求头：可选 BILIBILI_COOKIE 用于解锁原画/2K/4K（SESSDATA 等） */
function biliHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Referer: 'https://live.bilibili.com/',
    Accept: 'application/json',
  };
  const cookie = process.env.BILIBILI_COOKIE?.trim();
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/** B站官方公开接口直连（高画质需要 BILIBILI_COOKIE；无 Cookie 通常只能拿到 720P） */
async function resolveBilibili(info: PlatformLiveInfo): Promise<LivePlaylistResponse> {
  const roomId = info.roomId;
  if (!roomId) throw new Error('B站直播间短链无法直接解析，请使用 live.bilibili.com/<房间号> 或配置外部转接服务');
  const api =
    'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo' +
    `?room_id=${encodeURIComponent(roomId)}&protocol=0,1&format=0,1,2&codec=0,1&qn=${biliQn()}&platform=web`;
  const infoApi = `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`;

  const [playRes, infoRes] = await Promise.allSettled([
    fetchUpstream(api, {
      timeoutMs: BILIBILI_TIMEOUT_MS,
      retries: 0,
      headers: biliHeaders(),
    }),
    fetchUpstream(infoApi, {
      timeoutMs: BILIBILI_TIMEOUT_MS,
      retries: 0,
      headers: biliHeaders(),
    }),
  ]);
  if (playRes.status !== 'fulfilled' || !playRes.value.ok) {
    const reason = playRes.status === 'rejected' ? playRes.reason : `HTTP ${playRes.value.status}`;
    throw new Error(`B站接口请求失败: ${reason instanceof Error ? reason.message : reason}`);
  }
  const json = (await playRes.value.json()) as BiliPlayInfo;
  if (json.code !== 0) throw new Error(`B站接口返回错误: ${json.message || json.code}`);
  if (json.data?.live_status !== 1) throw new Error('B站直播间当前未开播');

  let roomTitle: string | undefined;
  let roomCover: string | undefined;
  if (infoRes.status === 'fulfilled' && infoRes.value.ok) {
    try {
      const room = (await infoRes.value.json()) as BiliRoomInfo;
      roomTitle = room.data?.title;
      roomCover = room.data?.user_cover;
    } catch {
      // 房间信息只是锦上添花，解析失败不影响播放
    }
  }

  const picked = pickBilibiliStream(json.data);
  if (!picked) throw new Error('B站直播间没有可播放的 HLS/FLV 流');

  const baseName = picked.name || roomTitle || `B站直播 ${roomId}`;
  const quality = qnLabel(picked.qn);
  const channel: LiveChannel = {
    id: `bilibili_${roomId}`,
    name: quality ? `${baseName} · ${quality}` : baseName,
    url: picked.url,
    logo: picked.logo || roomCover,
    group: DEFAULT_GROUP,
    tvgId: `bilibili_${roomId}`,
  };
  return { name: `B站直播 ${roomId}`, channels: [channel], groups: [DEFAULT_GROUP] };
}

export async function resolvePlatformLive(
  roomUrl: string,
  info: PlatformLiveInfo
): Promise<LivePlaylistResponse> {
  const relay = relayConfigured();
  if (info.platform === 'bilibili' && info.roomId) {
    try {
      return await resolveBilibili(info);
    } catch (err) {
      if (!relay) throw err;
      // 内置解析失败（例如需要登录/地区限制）时再走外部转接
    }
  }
  return resolveViaRelay(roomUrl, info);
}
