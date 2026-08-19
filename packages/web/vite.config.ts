import { execSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
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

// ---------------------------------------------------------------------------
// SERVER-BUILD DIET: drop the eager card-component glob from the SSR graph.
//
// Measured with `node scripts/measure-worker-bundle.mjs` (wrangler's own
// `--dry-run` reports the same figures): the Cloudflare Pages Worker was
// 3062.07 KiB gzipped against a 3072 KiB (3 MiB) free-plan ceiling — 9.93 KiB
// of headroom. 6.4 MB of the 12.3 MB raw bundle was ONE chunk, `Canvas.js`,
// reached by exactly one edge: `/r/[id]/+page.svelte` statically imports
// `$lib/ui/Canvas.svelte`, which imports the ~210-entry card map. Everything
// else heavy in the Worker (hls.js, butterchurn + presets, @grame/faustwasm,
// the video glitch renderers, module-docs.generated) hangs off that same edge.
//
// The server never renders a card. The patch graph is a Yjs doc backed by
// IndexedDB + the relay, so an SSR pass over `/r/[id]` has zero nodes and hands
// SvelteFlow a `nodeTypes` map it never indexes; `/rack` is `ssr = false` and
// its component is never invoked at all (SvelteKit still lists the node in the
// server manifest, which is why `ssr = false` alone does not shrink anything).
//
// So in the SSR build ONLY, `modules-card-components.ts` is replaced by an
// empty map. The client build is untouched — same glob, same chunks, same
// hydration — and the prerendered pages plus the SSR HTML of a Canvas-bearing
// route come out byte-identical (proven in the PR by prerendering `/rack` with
// SSR forced on, both with and without this plugin).
//
// Scope, stated inside the gate:
//   • SSR **build** only. `vite dev` and vitest keep the real glob, so the unit
//     lane exercises the real map and dev SSR matches production HTML.
//   • This file only. Any other importer of `./modules/*Card.svelte` would come
//     straight back into the Worker — `modules-card-components.ssr-stub.test.ts`
//     asserts the glob has exactly one home, and
//     `scripts/measure-worker-bundle.mjs --check` ratchets the Worker's gzipped
//     size so a new server-reachable card import fails loudly instead of
//     silently eating the margin.
//
// `PT_SSR_KEEP_CARDS=1` disables the plugin. That is the NEGATIVE CONTROL for
// the byte-identical claim, not a fallback: build a Canvas-bearing route with
// SSR forced on, once each way, and diff the emitted HTML. If the diff is ever
// non-empty the server HAS started rendering cards and this plugin is no longer
// safe. See `packages/web/scripts/prove-ssr-identical.sh`.
const CARD_COMPONENTS_MODULE = 'src/lib/ui/modules-card-components.ts';

/** The whole SSR replacement. Kept as a string so a test can assert on it. */
export const SSR_CARD_COMPONENTS_STUB =
  '// SSR build stub — see vite.config.ts ssrDropCardComponents().\n' +
  'export const componentByName = {};\n';

function ssrDropCardComponents(): Plugin {
  const WEB_DIR = fileURLToPath(new URL('.', import.meta.url));
  const TARGET = path.resolve(WEB_DIR, CARD_COMPONENTS_MODULE);
  let isBuild = false;
  return {
    name: 'patchtogether:ssr-drop-card-components',
    enforce: 'pre',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    load(id, options) {
      if (!isBuild || process.env.PT_SSR_KEEP_CARDS === '1') return null;
      // Vite 6+ exposes the environment; `options.ssr` is the older signal.
      const ssr = this.environment?.name === 'ssr' || options?.ssr === true;
      if (!ssr) return null;
      if (path.resolve(id.split('?')[0]) !== TARGET) return null;
      return SSR_CARD_COMPONENTS_STUB;
    },
  };
}

// ---------------------------------------------------------------------------
// WORKTREE IDENTITY ENDPOINT (`GET /__worktree`) — dev + preview servers only.
//
// #1597: Playwright's `reuseExistingServer` (and any warm-server dev loop)
// adopts WHATEVER answers on the target port. With several agent worktrees on
// one machine that server can belong to a SIBLING CHECKOUT — the run then
// exercises that tree's app while reporting (or ATTESTING) against this one,
// and nothing in the output distinguishes the two. A liveness probe cannot
// tell servers apart; this endpoint can: it names the checkout that BOOTED the
// server (and its commit at boot), so a pre-flight can REFUSE on mismatch
// instead of silently testing another worktree's code.
//
// Consumers: scripts/worktree-identity.ts (the attest runners' own-server
// verify) and scripts/dev-server.sh (`status` / `assert-up` / `start`
// ownership). Both fall back to lsof-cwd ownership when the endpoint is
// absent (a server booted from a tree that predates this plugin).
//
// Vite-server-only BY CONSTRUCTION: middlewares exist only on `vite dev` /
// `vite preview`, so a production deploy (adapter output) never exposes this.
// `root` is the PHYSICAL path (realpath) so a symlinked checkout compares
// equal to what the OS reports for the same tree.
function worktreeIdentity(): Plugin {
  const WEB_DIR = fileURLToPath(new URL('.', import.meta.url));
  const REPO_ROOT = realpathSync(path.resolve(WEB_DIR, '../..'));
  const startedAt = new Date().toISOString();
  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  } catch {
    /* not a git checkout / git unavailable — root is the refusal key, commit is informational */
  }
  const handler =
    (mode: 'dev' | 'preview') =>
    (req: { url?: string }, res: { setHeader(k: string, v: string): void; end(b: string): void }, next: () => void) => {
      if ((req.url ?? '').split('?')[0] !== '/__worktree') return next();
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify({ root: REPO_ROOT, commit, mode, pid: process.pid, startedAt }));
    };
  return {
    name: 'patchtogether:worktree-identity',
    // Registered directly (NOT as a post-internal return-function) so the
    // endpoint answers before SvelteKit's catch-all sees the request.
    configureServer(server) {
      server.middlewares.use(handler('dev'));
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler('preview'));
    },
  };
}

// COOP/COEP headers required for SharedArrayBuffer (Faust may want it).
// Phase 1 dev sets these; Phase 2 sets them in production via _headers.

/**
 * COEP on `vite preview` WORKER-SCRIPT responses — measured necessity
 * (#1953/#1976): `preview.headers` below never reaches STATIC ASSETS
 * (SvelteKit's sirv and the SSR middleware answer first; documents get
 * their COI headers from hooks.server.ts), so under `vite preview` the
 * `/_app/immutable/workers/*` scripts were served with NO Cross-Origin-
 * Embedder-Policy. A crossOriginIsolated page refuses to START a dedicated
 * worker whose SCRIPT RESPONSE lacks a compatible COEP: the load fails
 * with a plain error Event — silent without an onerror handler. That
 * killed BOTH bridge workers (vst + es9) in every preview/CI e2e run,
 * unnoticed until the vst specs became the first to assert on a live
 * worker.
 *
 * ⚠ SCOPED TO /_app/immutable/workers/ ON PURPOSE. The first version
 * stamped EVERY preview response and broke the product's route semantics:
 * only the /rack routes are isolated (hooks.server.ts), the LANDING is
 * deliberately NOT (third-party media), and landing-routing.spec.ts pins
 * that a landing→rack click is a full-page nav BETWEEN those two isolation
 * states — its "landing must be non-isolated" precondition went red on CI.
 * Worker scripts are the one asset class whose RESPONSE must carry COEP,
 * and they are only ever loaded from the isolated routes, so this scope
 * fixes the workers without touching any document's isolation. Dev is fine
 * (`server.headers` applies to all vite-dev responses) and prod is fine
 * (CF `_headers`); the DIRECT configurePreviewServer form installs before
 * the internal middlewares. Keep the value in sync with server.headers /
 * hooks.server.ts / packages/web/_headers.
 */
function coiPreviewWorkerHeaders() {
  return {
    name: 'coi-preview-worker-headers',
    configurePreviewServer(server: {
      middlewares: {
        use(fn: (req: { url?: string }, res: {
          setHeader(n: string, v: string): void;
        }, next: () => void) => void): void;
      };
    }) {
      server.middlewares.use((req, res, next) => {
        if (String(req.url ?? '').includes('/_app/immutable/workers/')) {
          res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [ensureModuleDocs(), ssrDropCardComponents(), worktreeIdentity(), coiPreviewWorkerHeaders(), sveltekit()],
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
