// The present sink is a pure client-side video surface: it receives a live
// MediaStream from its opener (same-origin window handle) and plays it. It has
// no engine, no audio, no SSR value — and SSR would break the browser-only
// MediaStream/fullscreen access. Match the canvas route's client-only config.
export const ssr = false;
export const csr = true;
export const prerender = false;
