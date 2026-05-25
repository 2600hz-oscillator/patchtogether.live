import { createRequire } from 'node:module';
import path from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Where node_modules actually resolves from. In a normal checkout this is the
// repo root (already covered by the '..'/'../..' allow entries below). In a
// git worktree under .claude/worktrees/<name>/ the worktree has no node_modules
// of its own — deps hoist to the MAIN checkout's node_modules several levels up
// — and Vite's dev server would 403 on @sveltejs/kit's client runtime (blank
// page, hydration never runs). Resolving the dir here + adding it to fs.allow
// makes `npm run dev` (and the e2e suite that drives it) work from a worktree
// too, while staying a harmless no-op in a normal checkout (the path is already
// inside the allow list there).
const require = createRequire(import.meta.url);
const HOISTED_NODE_MODULES = path.dirname(
  path.dirname(require.resolve('@sveltejs/kit/package.json')),
);

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
      // Allow serving compiled DSP artifacts from packages/dsp/dist, plus the
      // hoisted node_modules dir (covers the git-worktree case — see above).
      allow: ['..', '../..', HOISTED_NODE_MODULES],
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
