// /m/cam — glitch cam. Fully client-rendered (AudioContext, WebGL2,
// getUserMedia); prerender=false keeps the route on _worker.js so the beta
// gate runs. Copy of the /rack flags (spec §1).
export const ssr = false;
export const csr = true;
export const prerender = false;
