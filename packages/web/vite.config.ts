import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// COOP/COEP headers required for SharedArrayBuffer (Faust may want it).
// Phase 1 dev sets these; Phase 2 sets them in production via _headers.
export default defineConfig({
  plugins: [sveltekit()],
  // Faust's worklet generator (`@grame/faustwasm`) inlines its classes into a
  // dynamically-built worklet source via `SomeClass.toString()` + `.name` so
  // each AudioWorkletProcessor can reference them by their original identifier.
  // Vite/esbuild's default name-mangling renames the classes (FaustDspInstance
  // → `tt`, etc.); the inlined toString() source then references minified
  // names that Faust's template doesn't redeclare, and the worklet throws
  // `tt is not defined` inside AudioWorkletGlobalScope. keepNames preserves
  // the original identifiers in the bundle so the inlined source still resolves.
  esbuild: {
    keepNames: true,
  },
  build: {
    minify: 'esbuild',
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
