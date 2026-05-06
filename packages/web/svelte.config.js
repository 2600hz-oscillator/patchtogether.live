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
  },
  compilerOptions: {
    runes: true,
  },
};

export default config;
