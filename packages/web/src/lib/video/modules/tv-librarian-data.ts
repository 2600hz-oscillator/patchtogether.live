// packages/web/src/lib/video/modules/tv-librarian-data.ts
//
// PURE data layer for the TV LIBRARIAN module. No DOM, no network calls here —
// just the dataset URLs, a TOLERANT parser (the famelack README warns the JSON
// schema "may change without notice", so we validate the shape we need and
// IGNORE unknown fields), and the country/channel selection helpers (filter,
// next, random, stream-URL pick). All network I/O lives in the card so this
// file is trivially unit-testable.
//
// Dataset: github.com/famelack/famelack-data (MIT). Fetched at RUNTIME (we do
// NOT bundle it). Per the README, for production a cache/mirror is recommended;
// v1 hotlinks GitHub raw (ACAO:* — verified) with a graceful failure path.
//
// Attribution: "Data sourced from Famelack (famelack.com)"; the underlying
// stream directory is iptv-org-derived. See the docs page for the full
// legal-mitigation posture.

/** Base for the raw (uncompressed) JSON tree on GitHub. */
export const FAMELACK_RAW_BASE =
  'https://raw.githubusercontent.com/famelack/famelack-data/main/tv';

/** URL of the country metadata map (ISO code → name/capital/channelCount). */
export function countriesMetadataUrl(base: string = FAMELACK_RAW_BASE): string {
  return `${base}/raw/countries_metadata.json`;
}

/** URL of one country's channel list. The metadata keys are UPPERCASE ISO
 *  codes (e.g. "US"); the per-country FILES are lowercase (e.g. "us.json"). */
export function countryChannelsUrl(code: string, base: string = FAMELACK_RAW_BASE): string {
  return `${base}/raw/countries/${code.toLowerCase()}.json`;
}

/** One country entry from countries_metadata.json. We keep only what the
 *  picker needs; unknown fields (capital/timeZone) are tolerated + dropped. */
export interface CountryMeta {
  /** UPPERCASE ISO-3166 alpha-2 (the metadata map key). */
  code: string;
  name: string;
  channelCount: number;
}

/** One channel. Mirrors the famelack per-channel object, keeping only the
 *  fields we consume. `nanoid` is the stable id; `category` is NOT in the
 *  per-country file (it's conveyed by category files) so it's optional. */
export interface Channel {
  nanoid: string;
  name: string;
  /** First (preferred) HLS stream URL, or null if the channel is youtube-only
   *  / has no usable .m3u8. */
  streamUrl: string | null;
  /** ISO-639-3 language codes (may be empty). */
  languages: string[];
  /** Lowercase ISO country code. */
  country: string;
  isGeoBlocked: boolean;
  /** youtube-only entries have no direct stream but may carry youtube_urls. */
  youtubeOnly: boolean;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/** Pick the first usable HLS (.m3u8) stream URL from a channel's stream_urls.
 *  Returns null when there's no .m3u8 (youtube-only or empty). Exported for the
 *  unit test — the stream-pick rule is load-bearing. */
export function pickStreamUrl(streamUrls: unknown): string | null {
  if (!Array.isArray(streamUrls)) return null;
  // Prefer an explicit .m3u8; the dataset is ~100% HLS so this is the norm.
  for (const u of streamUrls) {
    if (typeof u === 'string' && u.includes('.m3u8')) return u;
  }
  // Fall back to the first string URL if present (rare raw .m3u, etc.).
  for (const u of streamUrls) {
    if (typeof u === 'string' && u.length > 0) return u;
  }
  return null;
}

/**
 * TOLERANTLY parse the countries_metadata.json payload into a sorted list of
 * countries that actually HAVE channels. Unknown / malformed entries are
 * skipped, never thrown — a schema drift degrades gracefully (fewer countries)
 * instead of breaking the whole module.
 */
export function parseCountriesMetadata(raw: unknown): CountryMeta[] {
  if (!raw || typeof raw !== 'object') return [];
  const out: CountryMeta[] = [];
  for (const [code, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const name = asString(o.country);
    if (!name) continue;
    const count = typeof o.channelCount === 'number' ? o.channelCount : 0;
    const hasChannels = o.hasChannels === true || count > 0;
    if (!hasChannels) continue;
    out.push({ code: code.toUpperCase(), name, channelCount: count });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * TOLERANTLY parse one country's channel-list payload (an array of channel
 * objects). Entries missing a name are dropped; everything else is normalized.
 * Unknown fields are ignored.
 */
export function parseChannels(raw: unknown): Channel[] {
  if (!Array.isArray(raw)) return [];
  const out: Channel[] = [];
  for (const v of raw) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const name = asString(o.name);
    const nanoid = asString(o.nanoid) ?? name; // fall back to name as id
    if (!name || !nanoid) continue;
    const streamUrl = pickStreamUrl(o.stream_urls);
    const youtubeUrls = asStringArray(o.youtube_urls);
    out.push({
      nanoid,
      name,
      streamUrl,
      languages: asStringArray(o.languages),
      country: (asString(o.country) ?? '').toLowerCase(),
      isGeoBlocked: o.isGeoBlocked === true,
      youtubeOnly: streamUrl === null && youtubeUrls.length > 0,
    });
  }
  return out;
}

export interface ChannelFilterOpts {
  /** Drop geo-blocked channels entirely (default false → keep + flag in UI). */
  hideGeoBlocked?: boolean;
  /** Drop channels that have no playable HLS stream (default true — a
   *  youtube-only entry can't feed our untainted-texture path in v1). */
  requirePlayable?: boolean;
}

/**
 * Apply the v1 playability/geo filters to a channel list. Default policy:
 * keep geo-blocked entries (the card MARKS them, doesn't hide them — honoring
 * `isGeoBlocked` visibly is part of the legal posture) but DROP youtube-only
 * entries that can't produce a clean texture.
 */
export function filterChannels(channels: Channel[], opts: ChannelFilterOpts = {}): Channel[] {
  const { hideGeoBlocked = false, requirePlayable = true } = opts;
  return channels.filter((c) => {
    if (requirePlayable && c.streamUrl === null) return false;
    if (hideGeoBlocked && c.isGeoBlocked) return false;
    return true;
  });
}

/**
 * The channel AFTER `currentNanoid` in `channels`, wrapping to the first. When
 * the current id isn't found (or is null), returns the first channel. Returns
 * null for an empty list. Used by the `next` trigger input + the Next button.
 */
export function nextChannel(channels: Channel[], currentNanoid: string | null): Channel | null {
  if (channels.length === 0) return null;
  if (!currentNanoid) return channels[0]!;
  const idx = channels.findIndex((c) => c.nanoid === currentNanoid);
  if (idx < 0) return channels[0]!;
  return channels[(idx + 1) % channels.length]!;
}

/**
 * A deterministic-with-injected-rng random channel pick (DIFFERENT from the
 * current one when possible). `rng` defaults to Math.random; tests inject a
 * fixed value. Returns null for an empty list.
 */
export function randomChannel(
  channels: Channel[],
  currentNanoid: string | null,
  rng: () => number = Math.random,
): Channel | null {
  if (channels.length === 0) return null;
  if (channels.length === 1) return channels[0]!;
  // Pick among the OTHERS so "random" reliably changes the channel.
  const pool = currentNanoid ? channels.filter((c) => c.nanoid !== currentNanoid) : channels;
  const list = pool.length > 0 ? pool : channels;
  const i = Math.min(list.length - 1, Math.max(0, Math.floor(rng() * list.length)));
  return list[i]!;
}

/** Compact display string for a channel's languages (ISO-639-3, uppercased). */
export function languageLabel(languages: string[]): string {
  if (!languages || languages.length === 0) return '';
  return languages.map((l) => l.toUpperCase()).join('/');
}
