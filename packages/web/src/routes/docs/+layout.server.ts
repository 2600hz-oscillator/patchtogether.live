// Prerender every /docs/* page at build time. They are pure-static — manifest
// data is baked in at build time via lib/docs/modules-manifest.ts; no runtime
// auth or DB access is needed. The beta gate explicitly carves /docs/* out
// (see hooks.server.ts) so anonymous users can read the docs.

export const prerender = true;
export const ssr = true;
