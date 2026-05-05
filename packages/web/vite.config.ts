import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// COOP/COEP headers required for SharedArrayBuffer (Faust may want it).
// Phase 1 dev sets these; Phase 2 sets them in production via _headers.
export default defineConfig({
  plugins: [sveltekit()],
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
