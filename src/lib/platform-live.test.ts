import { describe, expect, it } from 'vitest';
import { detectPlatformLive, platformLiveLabel } from './platform-live';
import { buildRelayUrl, normalizeRelayPayload, pickBilibiliStream } from './platform-live-resolver';

const INFO = { platform: 'douyin' as const, label: '抖音直播', roomId: '123456' };

describe('detectPlatformLive', () => {
  it('识别四家平台的直播间地址并提取房间号', () => {
    expect(detectPlatformLive('https://live.douyin.com/123456')).toMatchObject({
      platform: 'douyin',
      roomId: '123456',
    });
    expect(detectPlatformLive('https://www.huya.com/660000')).toMatchObject({
      platform: 'huya',
      roomId: '660000',
    });
    expect(detectPlatformLive('https://www.douyu.com/9999')).toMatchObject({
      platform: 'douyu',
      roomId: '9999',
    });
    expect(detectPlatformLive('https://live.bilibili.com/6?broadcast_type=0')).toMatchObject({
      platform: 'bilibili',
      roomId: '6',
    });
    expect(detectPlatformLive('https://b23.tv/abcdef')).toMatchObject({
      platform: 'bilibili',
      roomId: undefined,
    });
  });

  it('普通 M3U / 非直播页返回 null', () => {
    expect(detectPlatformLive('https://example.com/list.m3u')).toBeNull();
    expect(detectPlatformLive('https://www.bilibili.com/video/BV1xx')).toBeNull();
    expect(detectPlatformLive('not a url')).toBeNull();
    expect(platformLiveLabel('https://live.douyin.com/1')).toBe('抖音直播');
  });
});

describe('buildRelayUrl', () => {
  it('替换 {url} 占位符', () => {
    expect(
      buildRelayUrl('https://relay.example.com/resolve?room={url}&x=1', 'https://live.douyin.com/123')
    ).toBe(
      'https://relay.example.com/resolve?room=https%3A%2F%2Flive.douyin.com%2F123&x=1'
    );
  });

  it('没有占位符时自动追加 url 参数', () => {
    const out = buildRelayUrl('https://relay.example.com/resolve', 'https://www.huya.com/660000');
    expect(out).toContain('url=https%3A%2F%2Fwww.huya.com%2F660000');
  });
});

describe('normalizeRelayPayload', () => {
  const base = 'https://relay.example.com/resolve?url=x';

  it('支持纯流地址、JSON 对象与 streams 数组', () => {
    expect(normalizeRelayPayload('https://cdn.example/live.m3u8', INFO, base).channels[0]).toMatchObject({
      url: 'https://cdn.example/live.m3u8',
      name: '抖音直播 123456',
      group: '平台直播',
    });

    const single = normalizeRelayPayload(
      { url: 'https://cdn.example/a.flv', name: '房间A', group: '抖音', logo: 'https://img.example/a.jpg' },
      INFO,
      base
    );
    expect(single.channels[0]).toMatchObject({
      url: 'https://cdn.example/a.flv',
      name: '房间A',
      group: '抖音',
      logo: 'https://img.example/a.jpg',
    });

    const multi = normalizeRelayPayload(
      {
        streams: [
          { url: 'https://cdn.example/1.m3u8', name: '1' },
          { stream_url: 'https://cdn.example/2.m3u8', title: '2' },
          { url: 'https://cdn.example/1.m3u8' },
        ],
      },
      INFO,
      base
    );
    expect(multi.channels.map((c) => c.url)).toEqual([
      'https://cdn.example/1.m3u8',
      'https://cdn.example/2.m3u8',
    ]);
    expect(multi.groups).toEqual(['平台直播']);
  });

  it('支持 M3U 文本，忽略非法/空响应', () => {
    const playlist = normalizeRelayPayload(
      '#EXTM3U\n#EXTINF:-1 group-title="抖音",房间\nhttps://cdn.example/live.m3u8',
      INFO,
      base
    );
    expect(playlist.channels[0]).toMatchObject({ name: '房间', url: 'https://cdn.example/live.m3u8' });
    expect(playlist.groups).toEqual(['抖音']);

    expect(() => normalizeRelayPayload({ streams: [] }, INFO, base)).toThrow('没有返回可播放');
    expect(() => normalizeRelayPayload({ streams: ['ftp://bad'] }, INFO, base)).toThrow('没有返回可播放');
  });
});

describe('pickBilibiliStream', () => {
  it('优先 FLV avc', () => {
    const picked = pickBilibiliStream({
      playurl_info: {
        playurl: {
          stream: [
            {
              protocol_name: 'http_hls',
              format: [
                {
                  format_name: 'ts',
                  codec: [
                    {
                      codec_name: 'avc',
                      base_url: '/live/hls.m3u8?',
                      url_info: [{ host: 'https://hls.example', extra: 'h=1' }],
                    },
                  ],
                },
              ],
            },
            {
              protocol_name: 'http_stream',
              format: [
                {
                  format_name: 'flv',
                  codec: [
                    {
                      codec_name: 'avc',
                      base_url: '/live/flv.flv?',
                      url_info: [{ host: 'https://flv.example', extra: 'f=1' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    expect(picked?.url).toBe('https://flv.example/live/flv.flv?f=1');
  });

  it('没有 FLV 时回退 HLS，并拼接 host/base/extra', () => {
    const picked = pickBilibiliStream({
      room_info: { title: 'B站房间', user_cover: 'https://img.example/cover.jpg' },
      playurl_info: {
        playurl: {
          stream: [
            {
              protocol_name: 'http_hls',
              format: [
                {
                  format_name: 'ts',
                  codec: [
                    {
                      codec_name: 'avc',
                      base_url: '/live/1.m3u8?',
                      url_info: [{ host: 'https://cdn.example', extra: 'a=1' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    expect(picked).toEqual({
      url: 'https://cdn.example/live/1.m3u8?a=1',
      name: 'B站房间',
      logo: 'https://img.example/cover.jpg',
      qn: 0,
    });
  });

  it('只有 FLV 时返回 FLV', () => {
    const picked = pickBilibiliStream({
      playurl_info: {
        playurl: {
          stream: [
            {
              protocol_name: 'http_stream',
              format: [
                {
                  format_name: 'flv',
                  codec: [
                    {
                      codec_name: 'avc',
                      base_url: '/live/1.flv?',
                      url_info: [{ host: 'https://cdn.example', extra: 'b=2' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
    expect(picked?.url).toBe('https://cdn.example/live/1.flv?b=2');
  });
});
