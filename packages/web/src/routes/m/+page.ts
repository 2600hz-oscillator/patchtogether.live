// The /m chooser — static, no engine. Client-rendered like the rest of the
// mobile prototype; prerender=false keeps the route on _worker.js so the
// beta gate runs (spec §1).
export const ssr = false;
export const csr = true;
export const prerender = false;
