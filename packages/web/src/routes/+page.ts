// The canvas is fully client-rendered: it needs AudioContext, AudioWorklet,
// SharedArrayBuffer, and other browser-only APIs. SSR adds no value here and
// would break imports of browser-only DSP runtimes.
export const ssr = false;
export const csr = true;
export const prerender = false;
