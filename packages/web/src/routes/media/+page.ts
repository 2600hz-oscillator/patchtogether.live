// The media-loader view at /media. Fully client-rendered like /rack and
// /present: it needs DataTransfer / FileSystemEntry traversal, object URLs,
// and media elements for metadata probing — all browser-only. SSR would have
// nothing to render (the library is per-page in-memory state).
//
// Beta gate: /media is deliberately NOT in hooks.server.ts's
// BETA_GATE_PUBLIC_PATHS carve-outs, so it sits behind the same basic-auth
// gate as /rack (the gate is default-deny; see hooks.server.test.ts).
export const ssr = false;
export const csr = true;
export const prerender = false;
