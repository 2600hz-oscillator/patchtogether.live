import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// COOP/COEP headers required for SharedArrayBuffer (Faust may want it).
// Phase 1 dev sets these; Phase 2 sets them in production via _headers.
export default defineConfig({
  plugins: [sveltekit()],
  // Default esbuild minification. Faust's worklet stitching that previously
  // broke under minification is now sidestepped by pre-bundling the worklet
  // at DSP build time (packages/dsp/scripts/build-worklet.mjs); the parent
  // thread still uses @grame/faustwasm's MonoAudioWorkletNode wrapper but
  // doesn't depend on .toString() at runtime.
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
