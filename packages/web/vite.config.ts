import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';

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

// Product version, inlined into the client bundle at build time so the topbar
// brand heading can render `patchtogether v<version>` with no runtime fetch.
// Sourced from the ROOT package.json — the "patchtogether.live" product version
// (the web package.json is a 0.0.0 placeholder). Exposed to app code as the
// compile-time constant `__APP_VERSION__` via the `define` below (typed in
// src/app.d.ts). Unlike BUILD_INFO's deploy stamp (VITE_APP_VERSION, unset ⇒
// 'dev' on a local build), this is always a real X.Y.Z from the tagged package,
// which the version-heading e2e asserts against verbatim.
const APP_VERSION: string = require('../../package.json').version;

// `src/lib/docs/module-docs.generated.ts` is a gitignored BUILD ARTIFACT (LoC
// campaign row 4 — it used to be committed): the render module the prerendered
// /docs/modules/[id] page + Canvas's has-docs check import. The sanctioned
// Taskfile paths (`task build` / `build:web` / `dev` / `typecheck`) regenerate
// it via the `docs:ensure` dep, and the unit lane regenerates it via
// vitest.setup.docs.ts + the module-docs-ensure spec. This plugin is the
// LAST-RESORT seam for direct
// `vite dev` / `vite build` boots that bypass Task (e.g. a local `npx
// playwright test` whose webServer runs `npm run dev` on a fresh checkout):
// when the artifact is MISSING it shells out to the same vitest-driven
// generator; a missing file would otherwise be an import error at the first
// transform (and a prerender build failure). Presence-only on purpose — the
// full regenerate-always freshness pass belongs to the Task/vitest seams, and
// `vite preview` never runs build hooks so the prebuilt-bundle CI shards
// (E2E_USE_PREVIEW) don't pay this.
function ensureModuleDocs(): Plugin {
  const WEB_DIR = fileURLToPath(new URL('.', import.meta.url));
  const GENERATED = path.join(WEB_DIR, 'src/lib/docs/module-docs.generated.ts');
  return {
    name: 'patchtogether:ensure-module-docs',
    enforce: 'pre',
    buildStart() {
      if (existsSync(GENERATED)) return;
      // eslint-disable-next-line no-console
      console.log('[docs:ensure] module-docs.generated.ts missing — generating (vitest module-docs-ensure)');
      execSync('npx vitest run --config vitest.config.ts module-docs-ensure', {
        cwd: WEB_DIR,
        stdio: 'inherit',
      });
      if (!existsSync(GENERATED)) {
        throw new Error(
          '[docs:ensure] generation ran but src/lib/docs/module-docs.generated.ts is still missing — ' +
            'run `flox activate -- task docs:ensure` and check its output.',
        );
      }
    },
  };
}

// COOP/COEP headers required for SharedArrayBuffer (Faust may want it).
// Phase 1 dev sets these; Phase 2 sets them in production via _headers.
export default defineConfig({
  plugins: [ensureModuleDocs(), sveltekit()],
  // Inline the product version as a compile-time constant (see APP_VERSION
  // above). Applies in both `dev` (serve) and `build`, so the topbar heading
  // renders the real X.Y.Z locally, in e2e, and in the deployed bundle.
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  // Default esbuild minification. Faust's worklet stitching that previously
  // broke under minification is now sidestepped by pre-bundling the worklet
  // at DSP build time (packages/dsp/scripts/build-worklet.mjs); the parent
  // thread still uses @grame/faustwasm's MonoAudioWorkletNode wrapper but
  // doesn't depend on .toString() at runtime.
  build: {
    // Source maps are emitted ONLY when VITE_SENTRY_SOURCEMAPS=1 (the
    // deploy.yml Sentry release step sets it, gated on SENTRY_AUTH_TOKEN).
    // 'hidden' = generate the .map files but DON'T append a
    // `//# sourceMappingURL=` comment, so the deployed bundle never advertises
    // (or serves) maps to the public — they exist purely for sentry-cli to
    // upload, then the step deletes them before `pages deploy`. With the flag
    // unset (local dev, CI, every deploy before the token is wired) this is
    // `false`, so the default build output is byte-for-byte unchanged.
    sourcemap: process.env.VITE_SENTRY_SOURCEMAPS === '1' ? 'hidden' : false,
  },
  optimizeDeps: {
    // Pre-bundle deps that Vite's startup dep-scanner can't reach. The
    // scanner crawls *static* imports from the SvelteKit entry but does NOT
    // expand `import.meta.glob(...)` (Vite's glob plugin rewrites those later,
    // during transform, after the scan). The module-card map
    // (`modules-card-map.ts`) and the audio/video/meta module barrels now load
    // every card / def via eager `import.meta.glob` instead of the old
    // hand-maintained static import lists in Canvas.svelte. `@xyflow/svelte`'s
    // sub-package `@xyflow/system` is reachable ONLY through those glob-imported
    // card components, so without this hint it's discovered on the FIRST page
    // load → Vite force-re-optimizes deps mid-flight and triggers a full client
    // reload. On a loaded CI runner (multiple e2e shards × workers sharing one
    // dev server) that reload lands while a test's dynamic route import is
    // in flight, surfacing as a 504 "Outdated Optimize Dep" +
    // "Failed to fetch dynamically imported module …/nodes/3.js" and a flaky
    // failure (notably macseq.spec — the macrooscillator never gets a chance
    // to emit audio because the page reloaded out from under the test).
    // Including it here puts it in the initial optimize pass, so there's no
    // late re-optimization and no reload race. Keep in sync with any new dep
    // that becomes reachable only via the module/card globs.
    include: ['@xyflow/system'],
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      // `credentialless` (not `require-corp`): keeps the dev page cross-origin
      // isolated for SharedArrayBuffer/Faust WASM threads while letting no-cors
      // third-party media (ARCHIVIST's archive.org <video>/<audio>/<img>) load.
      // Mirrors hooks.server.ts + packages/web/_headers — keep all three in sync.
      'Cross-Origin-Embedder-Policy': 'credentialless',
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
      // See server.headers above — credentialless keeps SAB while allowing
      // no-cors archive.org media to load.
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
});
