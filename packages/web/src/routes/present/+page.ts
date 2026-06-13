// The present sink is a pure client-side canvas surface: its same-origin opener
// reaches this window's <canvas> directly and blits the OUTPUT card's live frame
// into it every animation frame. It has no engine, no audio, no SSR value — and
// SSR would have nothing to render. Match the canvas route's client-only config.
export const ssr = false;
export const csr = true;
export const prerender = false;
