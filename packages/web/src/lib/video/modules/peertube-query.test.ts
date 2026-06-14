// packages/web/src/lib/video/modules/peertube-query.test.ts
//
// Pure-core unit tests for the PEERTUBE Sepia-Search query/parse + per-instance
// stream-resolution logic. NO network: every input is a literal / FIXTURE, every
// assertion is on a pure transform. (Live Sepia/instance calls live only in the
// route-mocked e2e.)

import { describe, it, expect } from 'vitest';
import {
  SEPIA_SEARCH_BASE,
  buildSearchUrl,
  parseSearchResponse,
  parseTotal,
  normalizeHost,
  videoDetailsUrl,
  watchUrl,
  resolveStream,
  formatDuration,
  type RawSearchResponse,
  type RawVideoDetails,
} from './peertube-query';

describe('buildSearchUrl', () => {
  it('builds a well-formed Sepia-Search URL with count/start + relevance sort', () => {
    const url = buildSearchUrl('blender', { count: 12, start: 24 });
    expect(url.startsWith(`${SEPIA_SEARCH_BASE}?`)).toBe(true);
    expect(url).toContain('search=blender');
    expect(url).toContain('count=12');
    expect(url).toContain('start=24');
    expect(url).toContain('sort=-match');
  });

  it('ALWAYS sends nsfw=false (hard filter — never relaxed)', () => {
    expect(buildSearchUrl('anything')).toContain('nsfw=false');
    expect(buildSearchUrl('', { count: 100 })).toContain('nsfw=false');
  });

  it('clamps count to the Sepia 1..100 window (default 24)', () => {
    expect(buildSearchUrl('x')).toContain('count=24');
    expect(buildSearchUrl('x', { count: 9999 })).toContain('count=100');
    expect(buildSearchUrl('x', { count: 0 })).toContain('count=1');
    expect(buildSearchUrl('x', { count: -5 })).toContain('count=1');
  });

  it('trims the term + tolerates an empty browse query', () => {
    expect(buildSearchUrl('  nature  ')).toContain('search=nature');
    expect(buildSearchUrl('   ')).toContain('search=');
  });

  it('URL-encodes a multi-word / special-char term (spaces as +, & escaped)', () => {
    const url = buildSearchUrl('free software & you');
    // URLSearchParams encodes spaces as '+' and '&' as '%26'.
    expect(url).toContain('search=free+software+%26+you');
    // round-trips back to the original term.
    const got = new URL(url).searchParams.get('search');
    expect(got).toBe('free software & you');
  });

  it('clamps a negative/non-finite start to 0', () => {
    expect(buildSearchUrl('x', { start: -10 })).toContain('start=0');
    expect(buildSearchUrl('x', { start: NaN })).toContain('start=0');
  });
});

describe('parseSearchResponse / parseTotal', () => {
  const raw: RawSearchResponse = {
    total: 137,
    data: [
      {
        uuid: 'abc-1', name: 'Big Buck Bunny', duration: 635, isLive: false, nsfw: false,
        account: { host: 'framatube.org' },
        channel: { displayName: 'Blender' },
        thumbnailPath: '/static/thumbnails/abc-1.jpg',
      },
      {
        // shortUUID fallback for uuid; host from channel; absolute thumbnailUrl wins.
        shortUUID: 'sh0rt', name: 'Live News', duration: 0, isLive: true, nsfw: false,
        account: null,
        channel: { name: 'news', host: 'tube.example' },
        thumbnailUrl: 'https://cdn.example/t.jpg',
      },
      // dropped: no host anywhere → can't resolve a stream.
      { uuid: 'no-host', name: 'orphan', account: null, channel: null },
      // dropped: no uuid/shortUUID.
      { name: 'no-id', account: { host: 'tube.example' } },
    ],
  };

  it('parses rows, drops host-less + id-less, falls back name→uuid', () => {
    const vids = parseSearchResponse(raw);
    expect(vids.map((v) => v.uuid)).toEqual(['abc-1', 'sh0rt']);
    expect(vids[0].name).toBe('Big Buck Bunny');
    expect(vids[0].host).toBe('framatube.org');
    expect(vids[0].duration).toBe(635);
    expect(vids[0].channel).toBe('Blender');
    // relative thumbnailPath resolved against the host
    expect(vids[0].thumbnailUrl).toBe('https://framatube.org/static/thumbnails/abc-1.jpg');
  });

  it('uses shortUUID + channel.host + absolute thumbnailUrl when account is absent', () => {
    const v = parseSearchResponse(raw)[1];
    expect(v.uuid).toBe('sh0rt');
    expect(v.host).toBe('tube.example');
    expect(v.isLive).toBe(true);
    expect(v.channel).toBe('news');
    expect(v.thumbnailUrl).toBe('https://cdn.example/t.jpg');
  });

  it('parseTotal returns total or 0; tolerates a missing data array', () => {
    expect(parseTotal(raw)).toBe(137);
    expect(parseTotal({})).toBe(0);
    expect(parseSearchResponse({})).toEqual([]);
  });
});

describe('normalizeHost', () => {
  it('strips scheme, trailing slash, path, and lowercases', () => {
    expect(normalizeHost('framatube.org')).toBe('framatube.org');
    expect(normalizeHost('https://FramaTube.org/')).toBe('framatube.org');
    expect(normalizeHost('http://tube.example/w/abc')).toBe('tube.example');
    expect(normalizeHost('  https://tube.example  ')).toBe('tube.example');
  });
});

describe('URL builders', () => {
  it('videoDetailsUrl points at the per-instance public API + encodes the uuid', () => {
    expect(videoDetailsUrl('framatube.org', 'abc-1')).toBe(
      'https://framatube.org/api/v1/videos/abc-1',
    );
    expect(videoDetailsUrl('https://Tube.Example/', 'a b')).toBe(
      'https://tube.example/api/v1/videos/a%20b',
    );
  });
  it('watchUrl points at the human watch page', () => {
    expect(watchUrl('framatube.org', 'abc-1')).toBe('https://framatube.org/w/abc-1');
  });
});

describe('resolveStream', () => {
  it('PREFERS the HLS master playlist (kind=hls)', () => {
    const raw: RawVideoDetails = {
      name: 'My Clip',
      streamingPlaylists: [{ playlistUrl: 'https://framatube.org/static/hls/abc/master.m3u8' }],
      files: [{ fileUrl: 'https://framatube.org/static/web-videos/abc-720.mp4', resolution: { id: 720 } }],
    };
    const s = resolveStream(raw);
    expect(s).toEqual({
      kind: 'hls',
      url: 'https://framatube.org/static/hls/abc/master.m3u8',
      name: 'My Clip',
    });
  });

  it('falls back to the HIGHEST-resolution progressive MP4 when no HLS playlist', () => {
    const raw: RawVideoDetails = {
      name: 'Old Clip',
      streamingPlaylists: [],
      files: [
        { fileUrl: 'https://tube.example/v/abc-480.mp4', resolution: { id: 480 } },
        { fileUrl: 'https://tube.example/v/abc-1080.mp4', resolution: { id: 1080 } },
        { fileUrl: 'https://tube.example/v/abc-720.mp4', resolution: { id: 720 } },
      ],
    };
    const s = resolveStream(raw);
    expect(s?.kind).toBe('mp4');
    expect(s?.url).toBe('https://tube.example/v/abc-1080.mp4');
  });

  it('returns null when neither an HLS playlist nor a progressive file exists', () => {
    expect(resolveStream({ name: 'x', streamingPlaylists: [], files: [] })).toBeNull();
    expect(resolveStream({})).toBeNull();
  });

  it('ignores a streamingPlaylist with an empty playlistUrl + falls through to files', () => {
    const raw: RawVideoDetails = {
      name: 'edge',
      streamingPlaylists: [{ playlistUrl: '' }],
      files: [{ fileUrl: 'https://tube.example/v/abc.mp4', resolution: { id: 360 } }],
    };
    const s = resolveStream(raw);
    expect(s?.kind).toBe('mp4');
    expect(s?.url).toBe('https://tube.example/v/abc.mp4');
  });
});

describe('formatDuration', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(635)).toBe('10:35');
    expect(formatDuration(3661)).toBe('1:01:01');
  });
  it('tolerates a non-finite / negative duration', () => {
    expect(formatDuration(NaN)).toBe('0:00');
    expect(formatDuration(-5)).toBe('0:00');
  });
});
