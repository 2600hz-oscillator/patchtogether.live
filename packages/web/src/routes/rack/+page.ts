// The scratch canvas at /rack (moved off `/` in the landing-page overhaul).
// It is fully client-rendered: it needs AudioContext, AudioWorklet,
// SharedArrayBuffer, and other browser-only APIs. SSR adds no value here and
// would break imports of browser-only DSP runtimes. Cross-origin isolation is
// enforced globally (packages/web/_headers `/*` + vite server/preview headers)
// and reinforced for `/rack` in hooks.server.ts ISOLATED_EXACT.
export const ssr = false;
export const csr = true;
export const prerender = false;
