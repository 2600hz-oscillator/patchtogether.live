// packages/web/src/lib/video/modules/peertube-query.ts
//
// PEERTUBE pure cores — Sepia-Search query building, response parsing, and the
// per-instance video → playable-stream resolution. NO network, NO DOM: every
// function here is a pure transform so it can be unit-tested hard (see
// peertube-query.test.ts) and reused by the card + the e2e route-mocks.
//
// WHY PEERTUBE WORKS WHERE archive.org VIDEO DOESN'T (verified — research GREEN):
// PeerTube serves `Access-Control-Allow-Origin: *` on the FINAL media hop (the
// master .m3u8 AND the fragmented-mp4 / mpeg-ts segments), and the federation
// runs under a `credentialless` COEP posture, so a `<video crossorigin=anonymous>`
// fed by hls.js (a) plays AND (b) yields an UNTAINTED WebGL2 texture — a real
// downstream `video` output, not play-only. Stereo audio likewise routes out
// clean (MediaElementSource → ChannelSplitter). ~1/6 instances misconfigure CORS
// (raw S3 with no ACAO) → the element taints / fails to load; the card degrades to
// "display unavailable" + auto-skips (never crashes / hangs).
//
// FEDERATED SEARCH: Sepia Search (sepiasearch.org) is the official meta-search
// index across the PeerTube fediverse; its API is CORS-open + anonymous. We
// search there, then resolve the chosen video's playable stream from ITS OWN
// instance's public API (`https://<host>/api/v1/videos/{uuid}`).

export const SEPIA_SEARCH_BASE = 'https://sepiasearch.org/api/v1/search/videos';

/** A parsed Sepia-Search result row (the subset of fields the card uses). */
export interface PeerTubeVideo {
  /** The video UUID (or shortUUID) — used to resolve the stream on its host. */
  uuid: string;
  /** Display title. */
  name: string;
  /** Duration in seconds (0 when unknown). */
  duration: number;
  /** Live stream (vs. VOD). We surface it but don't special-case playback. */
  isLive: boolean;
  /** NSFW flag from the index (we ALWAYS query nsfw=false, but keep the flag). */
  nsfw: boolean;
  /** The instance host the video lives on (e.g. `framatube.org`). Stream
   *  resolution + attribution both key off this. */
  host: string;
  /** Channel display name (attribution), when present. */
  channel: string;
  /** Absolute thumbnail URL (resolved against the host), or '' when absent. */
  thumbnailUrl: string;
}

/** Options for a search query. */
export interface SearchOpts {
  /** Page size (Sepia caps at 1..100; defaults to 24). */
  count?: number;
  /** Result offset for paging (defaults to 0). */
  start?: number;
}

/**
 * Build the Sepia-Search videos URL. CORS-open + anonymous, so the browser
 * fetches it directly (no proxy). We ALWAYS send `nsfw=false` (hard filter —
 * never expose adult content) and sort by relevance (`-match`).
 *
 * An empty term still yields a valid "browse" query (Sepia returns popular
 * recent videos), so the card's search box degrades gracefully.
 */
export function buildSearchUrl(query: string, opts: SearchOpts = {}): string {
  const params = new URLSearchParams();
  params.set('search', query.trim());
  params.set('count', String(clampCount(opts.count)));
  const startRaw = Math.floor(opts.start ?? 0);
  params.set('start', String(Number.isFinite(startRaw) ? Math.max(0, startRaw) : 0));
  // HARD NSFW filter — never relaxed (mirrors archivist's always-on
  // access-restricted exclusion).
  params.set('nsfw', 'false');
  params.set('sort', '-match');
  return `${SEPIA_SEARCH_BASE}?${params.toString()}`;
}

/** Clamp the page size to Sepia's 1..100 window (default 24). */
function clampCount(count: number | undefined): number {
  const n = Math.floor(count ?? 24);
  if (!Number.isFinite(n)) return 24;
  return Math.min(100, Math.max(1, n));
}

/** Shape of the Sepia-Search response we consume (subset; tolerant). */
export interface RawSearchResponse {
  total?: unknown;
  data?: Array<{
    uuid?: unknown;
    shortUUID?: unknown;
    name?: unknown;
    duration?: unknown;
    isLive?: unknown;
    nsfw?: unknown;
    account?: { host?: unknown } | null;
    channel?: { displayName?: unknown; name?: unknown; host?: unknown } | null;
    thumbnailPath?: unknown;
    thumbnailUrl?: unknown;
  }>;
}

/** Coerce an unknown into a finite non-negative number (else 0). */
function numOr0(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, v);
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v)) return Number(v);
  return 0;
}

/** Coerce an unknown into a trimmed string (else ''). */
function strOr(v: unknown, fallback = ''): string {
  return typeof v === 'string' && v.length > 0 ? v : fallback;
}

/**
 * Parse a Sepia-Search response into clean PeerTubeVideo rows, dropping any row
 * without BOTH a usable uuid AND a host (we can't resolve a stream without the
 * host). Tolerant of missing/odd fields. Resolves the thumbnail to an absolute
 * URL against the row's host when only a relative `thumbnailPath` is given.
 */
export function parseSearchResponse(raw: RawSearchResponse): PeerTubeVideo[] {
  const rows = raw?.data ?? [];
  const out: PeerTubeVideo[] = [];
  for (const r of rows) {
    const uuid = strOr(r.uuid) || strOr(r.shortUUID);
    const host = strOr(r.account?.host) || strOr(r.channel?.host);
    if (!uuid || !host) continue;
    const name = strOr(r.name, uuid);
    const channel = strOr(r.channel?.displayName) || strOr(r.channel?.name);
    const thumbnailUrl = resolveThumb(host, r.thumbnailUrl, r.thumbnailPath);
    out.push({
      uuid,
      name,
      duration: numOr0(r.duration),
      isLive: r.isLive === true,
      nsfw: r.nsfw === true,
      host,
      channel,
      thumbnailUrl,
    });
  }
  return out;
}

/** Resolve a thumbnail to an absolute URL: prefer an already-absolute
 *  `thumbnailUrl`, else join a relative `thumbnailPath` onto the host. */
function resolveThumb(host: string, urlRaw: unknown, pathRaw: unknown): string {
  const url = strOr(urlRaw);
  if (url) return url;
  const path = strOr(pathRaw);
  if (!path) return '';
  const p = path.startsWith('/') ? path : `/${path}`;
  return `https://${host}${p}`;
}

/** `total` from a raw response (0 when absent). */
export function parseTotal(raw: RawSearchResponse): number {
  return numOr0(raw?.total);
}

// ─────────────────────────────────────────────────────────────────────────
// Per-instance video → playable stream resolution
// ─────────────────────────────────────────────────────────────────────────

/** A host can be either a bare host (`framatube.org`) or a full origin
 *  (`https://framatube.org`). Normalize to a bare host (no scheme, no
 *  trailing slash) so URL building is consistent. */
export function normalizeHost(hostOrUrl: string): string {
  let h = hostOrUrl.trim();
  h = h.replace(/^https?:\/\//i, '');
  h = h.replace(/\/+$/, '');
  // Strip any path after the host.
  const slash = h.indexOf('/');
  if (slash >= 0) h = h.slice(0, slash);
  return h.toLowerCase();
}

/** Build the per-instance video-details URL (public, CORS-open). */
export function videoDetailsUrl(host: string, uuid: string): string {
  const h = normalizeHost(host);
  return `https://${h}/api/v1/videos/${encodeURIComponent(uuid)}`;
}

/** Build the human-facing watch URL (attribution link). */
export function watchUrl(host: string, uuid: string): string {
  const h = normalizeHost(host);
  return `https://${h}/w/${encodeURIComponent(uuid)}`;
}

/** Shape of the per-instance video-details response we consume (subset). */
export interface RawVideoDetails {
  name?: unknown;
  streamingPlaylists?: Array<{ playlistUrl?: unknown }> | null;
  files?: Array<{ fileUrl?: unknown; resolution?: { id?: unknown } | null }> | null;
}

/** A resolved, normalized playable stream. `hls` → a master .m3u8 (attach via
 *  hls.js); `mp4` → a direct progressive file (attach as a plain <video src>). */
export interface ResolvedStream {
  kind: 'hls' | 'mp4';
  url: string;
  name: string;
}

/**
 * Resolve the best playable stream from a per-instance video-details response.
 *
 * PREFERENCE: the HLS master playlist (`streamingPlaylists[0].playlistUrl`) —
 * an .m3u8 that hls.js attaches for adaptive playback + a CLEAN texture. If no
 * HLS playlist exists (older / webtorrent-only instances), fall back to the
 * highest-resolution progressive `files[].fileUrl` (a direct MP4), attached as a
 * plain `<video src>`. Returns null when neither is present → the card skips the
 * item (no hang).
 */
export function resolveStream(raw: RawVideoDetails): ResolvedStream | null {
  const name = strOr(raw?.name);
  const hls = strOr(raw?.streamingPlaylists?.[0]?.playlistUrl);
  if (hls) return { kind: 'hls', url: hls, name };

  const files = raw?.files ?? [];
  let best: { url: string; res: number } | null = null;
  for (const f of files) {
    const url = strOr(f?.fileUrl);
    if (!url) continue;
    const res = numOr0(f?.resolution?.id);
    if (!best || res > best.res) best = { url, res };
  }
  if (best) return { kind: 'mp4', url: best.url, name };
  return null;
}

/** Persisted shape on node.data (Yjs-CRDT). The card is the only writer. */
export interface PeerTubeData {
  /** Last search term (so a reopened card shows what was searched). */
  searchTerm: string;
  /** Optional user-entered instance host to bias resolution (or ''). */
  instanceHost: string;
  /** The selected video's host (where the stream lives), or null. */
  selectedHost: string | null;
  /** The selected video's uuid, or null. */
  uuid: string | null;
  /** The selected video's display name (so peers render a label), or null. */
  name: string | null;
  /** Card size. */
  width?: number;
  height?: number;
}

export const PEERTUBE_DATA_DEFAULTS: PeerTubeData = {
  searchTerm: '',
  instanceHost: '',
  selectedHost: null,
  uuid: null,
  name: null,
};

/** Format a duration (seconds) as m:ss / h:mm:ss for the results list. */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(totalSec) ? totalSec : 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}
