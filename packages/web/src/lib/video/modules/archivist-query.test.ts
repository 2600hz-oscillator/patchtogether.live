// packages/web/src/lib/video/modules/archivist-query.test.ts
//
// Pure-core unit tests for the ARCHIVIST archive.org query/parse/file-pick
// logic. NO network: every input is a literal, every assertion is on a pure
// transform. (Live archive.org calls live only in the route-mocked e2e.)

import { describe, it, expect } from 'vitest';
import {
  ARCHIVE_MEDIATYPE,
  buildQueryString,
  buildSearchUrl,
  parseSearchResponse,
  parseNumFound,
  pickRandomDoc,
  parseMetadata,
  pickBestFile,
  concreteTypeFromMediatype,
  buildDownloadUrl,
  buildFileUrl,
  buildDetailsUrl,
  hasCleanOutput,
  type RawSearchResponse,
  type RawMetadataResponse,
  type ArchivistDoc,
} from './archivist-query';

describe('buildQueryString', () => {
  it('maps video → mediatype:movies (archive.org token)', () => {
    const q = buildQueryString({ term: 'nasa', mediatype: 'video' });
    expect(q).toContain('mediatype:movies');
    expect(q).toContain('nasa');
  });

  it('uses the literal token for image + audio', () => {
    expect(buildQueryString({ term: 'x', mediatype: 'image' })).toContain('mediatype:image');
    expect(buildQueryString({ term: 'x', mediatype: 'audio' })).toContain('mediatype:audio');
    expect(ARCHIVE_MEDIATYPE.video).toBe('movies');
  });

  it('omits the mediatype clause for "any"', () => {
    const q = buildQueryString({ term: 'jazz', mediatype: 'any' });
    expect(q).not.toContain('mediatype:');
    expect(q).toContain('jazz');
  });

  it('ALWAYS excludes access-restricted items', () => {
    for (const mt of ['image', 'audio', 'video', 'any'] as const) {
      expect(buildQueryString({ term: '', mediatype: mt })).toContain(
        'NOT access-restricted-item:true',
      );
    }
  });

  it('adds a year-range clause when both bounds set', () => {
    const q = buildQueryString({ term: 'a', mediatype: 'video', yearFrom: 1970, yearTo: 1989 });
    expect(q).toContain('year:[1970 TO 1989]');
  });

  it('open-ended year range uses * for the missing bound', () => {
    expect(buildQueryString({ term: 'a', mediatype: 'audio', yearFrom: 1990, yearTo: null })).toContain(
      'year:[1990 TO *]',
    );
    expect(buildQueryString({ term: 'a', mediatype: 'audio', yearFrom: null, yearTo: 2000 })).toContain(
      'year:[* TO 2000]',
    );
  });

  it('drops a non-finite / invalid year', () => {
    const q = buildQueryString({ term: 'a', mediatype: 'audio', yearFrom: NaN, yearTo: null });
    expect(q).not.toContain('year:');
  });

  it('an empty term still yields a valid browse query', () => {
    const q = buildQueryString({ term: '   ', mediatype: 'audio' });
    expect(q).toBe('mediatype:audio AND NOT access-restricted-item:true');
  });
});

describe('buildSearchUrl', () => {
  it('builds a well-formed advancedsearch URL with the field set + json output', () => {
    const url = buildSearchUrl({ term: 'cats', mediatype: 'image' }, { rows: 10, random: true });
    expect(url.startsWith('https://archive.org/advancedsearch.php?')).toBe(true);
    expect(url).toContain('output=json');
    expect(url).toContain('rows=10');
    // sort[]=random present
    expect(decodeURIComponent(url)).toContain('sort[]=random');
    // requested fields
    const dec = decodeURIComponent(url);
    for (const fl of ['identifier', 'title', 'year', 'mediatype']) {
      expect(dec).toContain(`fl[]=${fl}`);
    }
  });

  it('omits random sort when not requested', () => {
    const url = buildSearchUrl({ term: 'x', mediatype: 'audio' }, { rows: 5 });
    expect(decodeURIComponent(url)).not.toContain('sort[]=random');
  });
});

describe('parseSearchResponse / parseNumFound', () => {
  const raw: RawSearchResponse = {
    response: {
      numFound: 1974,
      start: 0,
      docs: [
        { identifier: 'a', title: 'Alpha', mediatype: 'image', year: 1999 },
        { identifier: 'b', title: 'Beta', mediatype: 'audio', year: '1985' }, // string year
        { identifier: 'c', mediatype: 'movies' }, // no title → fall back to id
        { title: 'no-id' }, // dropped (no identifier)
      ],
    },
  };

  it('parses rows, drops id-less, falls back title→id, coerces string year', () => {
    const docs = parseSearchResponse(raw);
    expect(docs.map((d) => d.identifier)).toEqual(['a', 'b', 'c']);
    expect(docs[0].year).toBe(1999);
    expect(docs[1].year).toBe(1985);
    expect(docs[2].title).toBe('c'); // title fell back to identifier
  });

  it('parseNumFound returns numFound or 0', () => {
    expect(parseNumFound(raw)).toBe(1974);
    expect(parseNumFound({})).toBe(0);
  });

  it('tolerates a missing response object', () => {
    expect(parseSearchResponse({})).toEqual([]);
  });
});

describe('pickRandomDoc', () => {
  const docs: ArchivistDoc[] = [
    { identifier: 'a', title: 'a', mediatype: 'image' },
    { identifier: 'b', title: 'b', mediatype: 'image' },
    { identifier: 'c', title: 'c', mediatype: 'image' },
  ];

  it('is deterministic with an injected RNG', () => {
    expect(pickRandomDoc(docs, () => 0)?.identifier).toBe('a');
    expect(pickRandomDoc(docs, () => 0.5)?.identifier).toBe('b');
    expect(pickRandomDoc(docs, () => 0.999)?.identifier).toBe('c');
  });

  it('clamps an RNG of exactly 1 to the last index', () => {
    expect(pickRandomDoc(docs, () => 1)?.identifier).toBe('c');
  });

  it('returns null for an empty list', () => {
    expect(pickRandomDoc([], () => 0)).toBeNull();
  });
});

describe('parseMetadata', () => {
  const raw: RawMetadataResponse = {
    server: 'ia600504.us.archive.org',
    dir: '/13/items/foo',
    metadata: { title: 'Foo Title', identifier: 'foo', 'access-restricted-item': 'false' },
    files: [
      { name: 'foo.jpg', format: 'JPEG', source: 'original' },
      { name: '__ia_thumb.jpg', format: 'Item Tile', source: 'original' },
      { name: 'foo_meta.xml', format: 'Metadata', source: 'metadata' },
    ],
  };

  it('extracts server/dir/title/identifier + files', () => {
    const m = parseMetadata(raw);
    expect(m.server).toBe('ia600504.us.archive.org');
    expect(m.dir).toBe('/13/items/foo');
    expect(m.title).toBe('Foo Title');
    expect(m.identifier).toBe('foo');
    expect(m.restricted).toBe(false);
    expect(m.files).toHaveLength(3);
  });

  it('flags restricted items (boolean true)', () => {
    expect(parseMetadata({ metadata: { 'access-restricted-item': true } }).restricted).toBe(true);
    expect(parseMetadata({ metadata: { 'access-restricted-item': 'true' } }).restricted).toBe(true);
    expect(parseMetadata({ is_dark: true }).restricted).toBe(true);
  });

  it('falls back to the given id when metadata.title/identifier absent', () => {
    const m = parseMetadata({ files: [] }, 'fallbackid');
    expect(m.identifier).toBe('fallbackid');
    expect(m.title).toBe('fallbackid');
  });
});

describe('pickBestFile', () => {
  it('IMAGE: prefers a real jpg over a system thumbnail', () => {
    const f = pickBestFile(
      [
        { name: '__ia_thumb.jpg', source: 'original' },
        { name: 'photo_thumb.jpg', source: 'derivative' },
        { name: 'photo.jpg', source: 'original' },
      ],
      'image',
    );
    expect(f?.name).toBe('photo.jpg');
  });

  it('IMAGE: prefers jpg > png > gif by rank', () => {
    expect(pickBestFile([{ name: 'a.png' }, { name: 'a.jpg' }], 'image')?.name).toBe('a.jpg');
    expect(pickBestFile([{ name: 'a.gif' }, { name: 'a.png' }], 'image')?.name).toBe('a.png');
  });

  it('AUDIO: prefers mp3 over flac/wav (lighter + seekable)', () => {
    const f = pickBestFile(
      [
        { name: 'song.flac', source: 'original' },
        { name: 'song.mp3', source: 'derivative' },
        { name: 'song.wav', source: 'original' },
      ],
      'audio',
    );
    expect(f?.name).toBe('song.mp3');
  });

  it('VIDEO: prefers mp4 over webm/ogv (format unknown — historical container order)', () => {
    const f = pickBestFile(
      [{ name: 'clip.ogv' }, { name: 'clip.webm' }, { name: 'clip.mp4' }],
      'video',
    );
    expect(f?.name).toBe('clip.mp4');
  });

  it('VIDEO: prefers an h.264 derivative over an MPEG-4-Part-2 .mp4 original (the "hang on Loading" fix)', () => {
    // The bug: ranking only by container ext picks the un-decodable MPEG-4
    // ORIGINAL .mp4 (DivX/Xvid), the <video> errors, the card hangs. The
    // format-aware picker must pick the real h.264 derivative instead.
    const f = pickBestFile(
      [
        { name: 'movie_3mb.mp4', format: 'MPEG4', source: 'original' }, // NOT playable
        { name: 'movie.mp4', format: 'h.264', source: 'derivative' }, // playable
      ],
      'video',
    );
    expect(f?.name).toBe('movie.mp4');
  });

  it('VIDEO: falls back to a theora .ogv when the only .mp4 is an un-decodable original', () => {
    // This_Is_Poland-style item: the .mp4 is an MPEG-4 original; only the .ogv
    // is a real (theora) derivative. The picker must skip the bad .mp4.
    const f = pickBestFile(
      [
        { name: 'film_3mb.mp4', format: 'MPEG4', source: 'original' },
        { name: 'film.ogv', format: 'Ogg Video', source: 'derivative' },
      ],
      'video',
    );
    expect(f?.name).toBe('film.ogv');
  });

  it('VIDEO: rejects HEVC and rejects a bare-MPEG4 original even though they are .mp4', () => {
    // HEVC has no reliable software decode (fails on CI/many machines); a bare
    // "MPEG4" original is MPEG-4 Part 2. With ONLY these, there is nothing
    // playable → null → the card advances to the next item.
    expect(
      pickBestFile(
        [
          { name: 'a.mp4', format: 'HEVC', source: 'original' },
          { name: 'b.mp4', format: 'MPEG4', source: 'original' },
        ],
        'video',
      ),
    ).toBeNull();
  });

  it('VIDEO: prefers IA 512Kb/HiRes MPEG4 derivatives (h.264) over a bare-MPEG4 original', () => {
    const f = pickBestFile(
      [
        { name: 'x.mp4', format: 'MPEG4', source: 'original' }, // un-decodable
        { name: 'x_512kb.mp4', format: '512Kb MPEG4', source: 'derivative' }, // h.264
      ],
      'video',
    );
    expect(f?.name).toBe('x_512kb.mp4');
  });

  it('VIDEO: never picks a non-HTML5 container (.mpeg/.avi/.mov) — returns null', () => {
    expect(
      pickBestFile(
        [
          { name: 'old.mpeg', format: 'MPEG2', source: 'original' },
          { name: 'old.avi', format: 'Cinepack', source: 'original' },
          { name: 'old.mov', format: 'h.264 HD', source: 'original' },
        ],
        'video',
      ),
    ).toBeNull();
  });

  it('VIDEO: prefers a derivative over an original when format + ext tie', () => {
    const f = pickBestFile(
      [
        { name: 'orig.mp4', format: 'h.264', source: 'original' },
        { name: 'deriv.mp4', format: 'h.264', source: 'derivative' },
      ],
      'video',
    );
    expect(f?.name).toBe('deriv.mp4');
  });

  it('skips metadata-source + sidecar files', () => {
    const f = pickBestFile(
      [
        { name: 'x_files.xml', source: 'metadata' },
        { name: 'x.afpk', source: 'derivative' },
        { name: 'x_spectrogram.png', source: 'derivative' },
        { name: 'x.mp3', source: 'derivative' },
      ],
      'audio',
    );
    expect(f?.name).toBe('x.mp3');
  });

  it('returns null when no playable file of the type exists', () => {
    expect(pickBestFile([{ name: 'doc.pdf' }, { name: 'note.txt' }], 'image')).toBeNull();
    expect(pickBestFile([{ name: 'song.mp3' }], 'video')).toBeNull();
  });
});

describe('concreteTypeFromMediatype', () => {
  it('maps archive tokens to our concrete types', () => {
    expect(concreteTypeFromMediatype('image')).toBe('image');
    expect(concreteTypeFromMediatype('audio')).toBe('audio');
    expect(concreteTypeFromMediatype('etree')).toBe('audio'); // Live Music Archive
    expect(concreteTypeFromMediatype('movies')).toBe('video');
  });
  it('returns null for unhandled types', () => {
    expect(concreteTypeFromMediatype('texts')).toBeNull();
    expect(concreteTypeFromMediatype('software')).toBeNull();
  });
});

describe('URL builders', () => {
  it('buildDownloadUrl encodes id + each path segment', () => {
    expect(buildDownloadUrl('my id', 'a b.mp3')).toBe(
      'https://archive.org/download/my%20id/a%20b.mp3',
    );
  });
  it('buildDownloadUrl preserves nested-dir slashes (encoding each segment)', () => {
    expect(buildDownloadUrl('id', 'OST/Track 1.mp3')).toBe(
      'https://archive.org/download/id/OST/Track%201.mp3',
    );
  });
  it('buildFileUrl uses server+dir when present, else falls back to /download/', () => {
    const meta = parseMetadata({
      server: 'ia1.us.archive.org',
      dir: '/0/items/foo',
      metadata: { identifier: 'foo' },
      files: [],
    });
    expect(buildFileUrl(meta, 'song.mp3')).toBe('https://ia1.us.archive.org/0/items/foo/song.mp3');
    const noServer = parseMetadata({ metadata: { identifier: 'foo' }, files: [] });
    expect(buildFileUrl(noServer, 'song.mp3')).toBe('https://archive.org/download/foo/song.mp3');
  });
  it('buildDetailsUrl points at the item details page', () => {
    expect(buildDetailsUrl('foo')).toBe('https://archive.org/details/foo');
  });
});

describe('hasCleanOutput (per-type CORS verdict)', () => {
  it('image + audio have clean downstream outputs; video is play-only', () => {
    expect(hasCleanOutput('image')).toBe(true);
    expect(hasCleanOutput('audio')).toBe(true);
    expect(hasCleanOutput('video')).toBe(false);
  });
});
