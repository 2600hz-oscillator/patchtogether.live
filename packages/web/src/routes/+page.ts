// The public landing / front door (the scratch canvas moved to /rack in the
// landing-page overhaul). Fully STATIC:
//   - prerender=true  → baked to HTML at build time, like /docs/*. Served as a
//                       plain file so anon/crawlers get a fast first paint and
//                       the beta gate lets `/` through (see hooks.server.ts
//                       BETA_GATE_PUBLIC_PATHS).
//   - ssr=true, csr=true → normal SvelteKit hydration.
//
// It reads NO auth state — no `homeAuth`, no Clerk. There is nothing
// request-specific to bake, so prerendering can't freeze a stale signed-in/out
// header: the header is a STATIC "Sign in" link → the login flow. A logged-in
// user only ever sees it if they navigate back to `/` (owner-accepted); their
// account chip lives on /rack and /dashboard, which are per-request.
export const prerender = true;
export const ssr = true;
export const csr = true;
