import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// COOP/COEP headers required for SharedArrayBuffer (Faust may want it).
// Phase 1 dev sets these; Phase 2 sets them in production via _headers.
export default defineConfig({
  plugins: [sveltekit()],
  // Faust's worklet generator (`@grame/faustwasm`) inlines its classes into a
  // dynamically-built worklet source via `SomeClass.toString()` + `.name` so
  // each AudioWorkletProcessor can reference them by their original identifier.
  // Minifying renames those classes (FaustDspInstance → `tt`); the inlined
  // .toString() bodies then reference renamed identifiers Faust's template
  // doesn't redeclare, and the worklet throws `tt is not defined` inside
  // AudioWorkletGlobalScope.
  //
  // We tried `esbuild.keepNames: true` first but that emits `__name(target,
  // name)` helpers that called Object.defineProperty on non-objects during
  // SvelteKit's module init in the Cloudflare Worker, breaking deploy
  // validation. Cleaner workaround: disable minification entirely. Bundle is
  // ~30% larger but Faust survives and the Worker boots cleanly. Revisit
  // once @grame/faustwasm ships a worklet path that doesn't depend on
  // .toString()-stitching.
  build: {
    minify: false,
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: {
      // Allow serving compiled DSP artifacts from packages/dsp/dist
      allow: ['..', '../..'],
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
