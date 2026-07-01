import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    // Cloudflare Pages adapter. The app is fully client-rendered (the patch
    // canvas + audio engine are all browser-side), so every route is excluded
    // from Cloudflare Functions — what ships is a static HTML/JS/CSS bundle.
    adapter: adapter({
      routes: {
        include: ['/*'],
        exclude: ['<all>'],
      },
    }),
    prerender: {
      // Module-face PNGs (/docs/module-faces/<id>.png) are GENERATED from the
      // VRT-annotated baselines (docs:faces, sourced from e2e/vrt/__annotated__,
      // LFS) and may be absent in a partial/local checkout. A missing decorative
      // face image must NOT fail the whole prerender (it was hard-killing the
      // prod build — e.g. the collab-attest build — since #891). Degrade those
      // 404s to a warning; everything else still fails the build.
      handleHttpError: ({ path, referrer, message }) => {
        if (path.startsWith('/docs/module-faces/')) {
          console.warn(`[prerender] missing doc face (non-fatal): ${path}${referrer ? ` (from ${referrer})` : ''}`);
          return;
        }
        // The landing page (and shared nav) link to the Clerk-gated auth/app
        // routes (/sign-in, /sign-up, /dashboard). Those are fully client-
        // rendered, and in any build env WITHOUT Clerk secrets (CI + the CF
        // Pages preview build) hooks.server.ts renders them as a diagnostic
        // 503 — which the prerender crawler follows and would hard-fail on.
        // They are never prerendered content, so degrade their crawl errors to
        // a warning (this turned fatal the moment the landing added a link from
        // / to /sign-in, breaking the preview build with no site to review).
        if (/^\/(sign-in|sign-up|dashboard)(\/|$)/.test(path)) {
          console.warn(`[prerender] skipping client-only auth route (non-fatal): ${path}${referrer ? ` (from ${referrer})` : ''}`);
          return;
        }
        throw new Error(message);
      },
    },
  },
  compilerOptions: {
    runes: true,
  },
};

export default config;
