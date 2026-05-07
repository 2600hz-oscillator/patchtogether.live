// Docs subtree opts in to static prerendering. Pages here have no auth or
// db dependency: every byte ships at build time and the runtime never has
// to render them on demand. SSR is on so the catalog HTML lands in the
// initial response (search engines, no JS = still readable).
export const prerender = true;
export const ssr = true;
export const csr = true;
