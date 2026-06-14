// packages/web/src/lib/video/modules/tv-librarian-data.test.ts
//
// Pure data-layer tests for TV LIBRARIAN. No network, no DOM — exercises the
// tolerant parser + the country/channel selection helpers against fixture JSON
// shaped exactly like the famelack dataset (uppercase metadata keys, lowercase
// per-channel country, optional youtube-only entries, geo-blocked flags).

import { describe, expect, it } from 'vitest';
import {
  parseCountriesMetadata,
  parseChannels,
  pickStreamUrl,
  filterChannels,
  nextChannel,
  randomChannel,
  languageLabel,
  countriesMetadataUrl,
  countryChannelsUrl,
  type Channel,
} from './tv-librarian-data';

// ---- Fixtures (the exact famelack shapes) ----
const METADATA_FIXTURE = {
  US: { country: 'United States', capital: 'Washington', hasChannels: true, channelCount: 3 },
  AD: { country: 'Andorra', capital: 'Andorra la Vella', hasChannels: true, channelCount: 1 },
  AG: { country: 'Antigua and Barbuda', capital: "St. John's", hasChannels: false, channelCount: 0 },
  XX: { capital: 'nowhere', hasChannels: true }, // malformed: no country name
};

const CHANNELS_FIXTURE = [
  {
    nanoid: 'aaa', name: 'Zed News',
    stream_urls: ['https://x/playlist.m3u8'], youtube_urls: [],
    languages: ['eng'], country: 'us', isGeoBlocked: false,
  },
  {
    nanoid: 'bbb', name: 'Alpha Sports',
    stream_urls: ['https://y/master.m3u8'], youtube_urls: [],
    languages: ['eng', 'spa'], country: 'us', isGeoBlocked: true,
  },
  {
    nanoid: 'ccc', name: 'Tube Only',
    stream_urls: [], youtube_urls: ['https://youtube.com/embed/x'],
    languages: ['eng'], country: 'us', isGeoBlocked: false,
  },
  { /* malformed: no name → dropped */ nanoid: 'ddd', stream_urls: ['https://z.m3u8'] },
];

describe('tv-librarian dataset URLs', () => {
  it('builds the metadata URL', () => {
    expect(countriesMetadataUrl('https://base')).toBe('https://base/raw/countries_metadata.json');
  });
  it('lowercases the country code in the per-country file URL (metadata keys are UPPERCASE)', () => {
    expect(countryChannelsUrl('US', 'https://base')).toBe('https://base/raw/countries/us.json');
    expect(countryChannelsUrl('gb', 'https://base')).toBe('https://base/raw/countries/gb.json');
  });
});

describe('parseCountriesMetadata', () => {
  it('keeps only countries WITH channels, uppercases codes, sorts by name, drops malformed', () => {
    const out = parseCountriesMetadata(METADATA_FIXTURE);
    expect(out.map((c) => c.code)).toEqual(['AD', 'US']); // Andorra < United States; AG has no channels; XX malformed
    expect(out[0]).toEqual({ code: 'AD', name: 'Andorra', channelCount: 1 });
  });
  it('returns [] for garbage input (no throw — graceful schema drift)', () => {
    expect(parseCountriesMetadata(null)).toEqual([]);
    expect(parseCountriesMetadata('nope')).toEqual([]);
    expect(parseCountriesMetadata(42)).toEqual([]);
  });
  it('treats a positive channelCount as hasChannels even if the flag is absent', () => {
    const out = parseCountriesMetadata({ FR: { country: 'France', channelCount: 5 } });
    expect(out).toEqual([{ code: 'FR', name: 'France', channelCount: 5 }]);
  });
});

describe('pickStreamUrl', () => {
  it('prefers a .m3u8 URL', () => {
    expect(pickStreamUrl(['https://a/x.mp4', 'https://b/y.m3u8'])).toBe('https://b/y.m3u8');
  });
  it('falls back to the first string URL when no .m3u8 (rare raw .m3u)', () => {
    expect(pickStreamUrl(['https://a/x.m3u'])).toBe('https://a/x.m3u');
  });
  it('returns null for empty / non-array / no usable url', () => {
    expect(pickStreamUrl([])).toBeNull();
    expect(pickStreamUrl(undefined)).toBeNull();
    expect(pickStreamUrl([123])).toBeNull();
  });
});

describe('parseChannels', () => {
  it('normalizes channels, marks youtube-only, drops nameless entries, ignores unknown fields', () => {
    const out = parseChannels(CHANNELS_FIXTURE);
    expect(out.map((c) => c.nanoid)).toEqual(['aaa', 'bbb', 'ccc']); // ddd dropped (no name)
    expect(out[0]).toMatchObject({ name: 'Zed News', streamUrl: 'https://x/playlist.m3u8', isGeoBlocked: false, youtubeOnly: false });
    expect(out[1]).toMatchObject({ isGeoBlocked: true });
    expect(out[2]).toMatchObject({ streamUrl: null, youtubeOnly: true });
  });
  it('returns [] for non-array input', () => {
    expect(parseChannels({})).toEqual([]);
    expect(parseChannels(null)).toEqual([]);
  });
});

describe('filterChannels', () => {
  const parsed = parseChannels(CHANNELS_FIXTURE);
  it('drops youtube-only (no playable stream) by default, keeps geo-blocked (marked in UI)', () => {
    const out = filterChannels(parsed);
    expect(out.map((c) => c.nanoid)).toEqual(['aaa', 'bbb']); // ccc (youtube-only) dropped, bbb (geo) kept
  });
  it('can additionally hide geo-blocked when asked', () => {
    const out = filterChannels(parsed, { hideGeoBlocked: true });
    expect(out.map((c) => c.nanoid)).toEqual(['aaa']);
  });
});

describe('nextChannel', () => {
  const list = filterChannels(parseChannels(CHANNELS_FIXTURE)); // [aaa, bbb]
  it('wraps to the first after the last', () => {
    expect(nextChannel(list, 'bbb')?.nanoid).toBe('aaa');
  });
  it('advances by one', () => {
    expect(nextChannel(list, 'aaa')?.nanoid).toBe('bbb');
  });
  it('returns the first when current is null or unknown', () => {
    expect(nextChannel(list, null)?.nanoid).toBe('aaa');
    expect(nextChannel(list, 'zzz')?.nanoid).toBe('aaa');
  });
  it('returns null for an empty list', () => {
    expect(nextChannel([], 'x')).toBeNull();
  });
});

describe('randomChannel', () => {
  const list: Channel[] = filterChannels(parseChannels(CHANNELS_FIXTURE)); // [aaa, bbb]
  it('picks from the OTHERS so it reliably changes channel (deterministic rng)', () => {
    // current=aaa, pool=[bbb], rng=0 → bbb
    expect(randomChannel(list, 'aaa', () => 0)?.nanoid).toBe('bbb');
    // current=bbb, pool=[aaa], rng=0.99 → aaa
    expect(randomChannel(list, 'bbb', () => 0.99)?.nanoid).toBe('aaa');
  });
  it('with no current selection, picks from the full list', () => {
    expect(randomChannel(list, null, () => 0)?.nanoid).toBe('aaa');
  });
  it('returns the only channel when there is exactly one', () => {
    expect(randomChannel([list[0]!], 'aaa', () => 0.5)?.nanoid).toBe('aaa');
  });
  it('returns null for an empty list', () => {
    expect(randomChannel([], null)).toBeNull();
  });
});

describe('languageLabel', () => {
  it('uppercases + joins with slash', () => {
    expect(languageLabel(['eng', 'spa'])).toBe('ENG/SPA');
  });
  it('is empty for no languages', () => {
    expect(languageLabel([])).toBe('');
  });
});
