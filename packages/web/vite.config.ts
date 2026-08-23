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

// ---------------------------------------------------------------------------
// …AND THE SECOND OCCUPANT: `<Canvas>` ITSELF (#2088).
//
// Dropping the ~210 card components was never going to be enough, because the
// thing that IMPORTS them is itself the biggest single input in the Worker:
// `chunks/Canvas.js`, 5877 KiB raw in the bundle, dragging
// `milkdrop-preset-converter` (1236 KiB), `module-docs.generated.js` (1106 KiB),
// `@webamp/butterchurn` (425 KiB), `@grame/faustwasm` (159 KiB) and mediabunny
// (~470 KiB) behind it. That is what put the deployed Worker 177 KiB over
// Cloudflare's hard 3 MiB gzipped ceiling and turned every deploy red.
//
// ⚠ THE SAFETY ARGUMENT IS STRICTLY STRONGER THAN THE CARD ONE, and it is worth
// being precise about why. The card stub rests on a claim about CONTENT — that
// a server render has zero nodes, so the map is never indexed — which needed
// `prove-ssr-identical.sh` to test. This stub rests on a claim about REACHABILITY:
// after `src/routes/r/[id]/+page.ts` landed, **no route server-renders
// `<Canvas>` at all**. `/rack` has been `ssr = false` since it moved off `/`,
// `/r/[id]` now matches it, and those are the only two route modules that
// import the component (every other match under `src/routes/**` is a comment or
// a CSS selector). A component that is never rendered on the server cannot
// contribute a byte to server HTML, so there is no HTML to diff.
//
// ⚠ THE COMPONENT COULD NOT SURVIVE A NODE-HOSTED SSR ANYWAY — see
// `prove-ssr-identical.sh`: `Canvas.js` imports a named export
// `@grame/faustwasm` does not provide under Node's ESM resolution, so any
// Node-hosted SSR of a Canvas route is a 500. Production only ever worked
// because wrangler esbuild-bundles the Worker. Stubbing it on the server
// removes a dependency on that accident rather than creating a new risk.
//
// ⚠ IF SOMEONE LATER SERVER-RENDERS A CANVAS ROUTE, THIS STUB MUST GO — and the
// tell is not subtle: the route will render an empty `<div>` where the canvas
// belongs. `PT_SSR_KEEP_CARDS=1` disables BOTH stubs, which is the negative
// control for that, not a fallback.
const CANVAS_MODULE = 'src/lib/ui/Canvas.svelte';

/** The whole SSR replacement for `<Canvas>`. A component that renders nothing.
 *  Kept as a string so a test can assert on it, exactly like the card stub. */
export const SSR_CANVAS_STUB =
  '<!-- SSR build stub — see vite.config.ts ssrDropBrowserOnlyGraph(). -->\n' +
  '<script lang="ts">\n' +
  '  // Accept and ignore every prop: no route server-renders <Canvas>, so this\n' +
  '  // component exists only to keep the server graph type-correct and small.\n' +
  '  const _props = $props();\n' +
  '  void _props;\n' +
  '</script>\n';

// ---------------------------------------------------------------------------
// …AND THE THIRD OCCUPANT: THE `/dev/**` PLAYGROUND PAGES (#2094).
//
// After the two stubs above, the single largest ROUTE input left in the Worker
// was `entries/pages/dev/video-patch-drop/_page.svelte.js` (222 KiB), dragging
// `chunks/peakstate.js` behind it — a dev page, in the production Worker.
//
// Same REACHABILITY argument as the Canvas stub, resting on ONE flag:
// `src/routes/dev/+layout.ts` declares `ssr = false` for the whole subtree, so
// no server render of any /dev page component can occur, and a component that
// is never rendered on the server cannot contribute a byte to server HTML.
// ⚠ THAT FLAG IS THIS STUB'S PRECONDITION — `dev-routes-ssr-stub.test.ts` pins
// the pair, so deleting the layout flag reds the gate naming this coupling
// before the server ever renders a stub. The tell, if it ever regresses past
// the gate, is not subtle: every /dev page SSRs as an empty shell.
// `PT_SSR_KEEP_CARDS=1` disables all three stubs — the shared negative control.
const DEV_ROUTES_DIR = 'src/routes/dev';

function ssrDropBrowserOnlyGraph(): Plugin {
  const WEB_DIR = fileURLToPath(new URL('.', import.meta.url));
  const CARD_TARGET = path.resolve(WEB_DIR, CARD_COMPONENTS_MODULE);
  const CANVAS_TARGET = path.resolve(WEB_DIR, CANVAS_MODULE);
  const DEV_ROUTES_TARGET = path.resolve(WEB_DIR, DEV_ROUTES_DIR) + path.sep;
  let isBuild = false;
  return {
    name: 'patchtogether:ssr-drop-browser-only-graph',
    enforce: 'pre',
    configResolved(config) {
      isBuild = config.command === 'build';
    },
    load(id, options) {
      if (!isBuild || process.env.PT_SSR_KEEP_CARDS === '1') return null;
      // Vite 6+ exposes the environment; `options.ssr` is the older signal.
      const ssr = this.environment?.name === 'ssr' || options?.ssr === true;
      if (!ssr) return null;
      const resolved = path.resolve(id.split('?')[0]);
      if (resolved === CARD_TARGET) return SSR_CARD_COMPONENTS_STUB;
      if (resolved === CANVAS_TARGET) return SSR_CANVAS_STUB;
      // /dev/** pages: never server-rendered (routes/dev/+layout.ts ssr=false),
      // so the empty component keeps the server graph type-correct and small.
      // `.svelte` only — the +layout.ts carrying the flag must survive as-is.
      if (resolved.startsWith(DEV_ROUTES_TARGET) && resolved.endsWith('.svelte')) return SSR_CANVAS_STUB;
      return null;
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
  plugins: [ensureModuleDocs(), ssrDropBrowserOnlyGraph(), worktreeIdentity(), coiPreviewWorkerHeaders(), sveltekit()],
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
    // ⚠ MINIFY THE **SSR** BUILD (#2088). The Worker was shipping as
    // UNMINIFIED SOURCE, and nothing made that visible.
    //
    // Two defaults compose into the bug, neither wrong on its own:
    //   * Vite does not minify SSR builds by default (minification can break
    //     `Function.prototype.toString` tricks, and a server bundle is
    //     normally not size-constrained), and
    //   * `wrangler pages deploy` re-bundles `_worker.js` with esbuild but
    //     does NOT minify it either.
    // On Cloudflare the server bundle IS size-constrained — 3 MiB gzipped on
    // the free tier — so the two defaults meet at a hard ceiling.
    //
    // MEASURED, via `node scripts/measure-worker-bundle.mjs` (which reads
    // wrangler's own "Total Upload / gzip" number, i.e. the figure Cloudflare
    // actually enforces), same tree, same commit, only this flag moved:
    //
    //   | build            | raw KiB  | gzip KiB | vs 3072 KiB ceiling |
    //   |------------------|----------|----------|---------------------|
    //   | without (before) | 13163.42 |  3249.34 | −177.34  (OVER)     |
    //   | with    (after)  | 10557.10 |  2595.39 | +476.61  (under)    |
    //
    // −653.95 KiB gzipped, −20.1%. That is what turns a RED deploy green: the
    // failure in #2088 is `Your Worker exceeded the size limit of 3 MiB`, and
    // 3249.34 KiB is 177 KiB past it.
    //
    // ⚠ THIS IS THE THRESHOLD, NOT THE SUBJECT. It buys headroom; it does not
    // fix why a browser-only render graph is reachable from the server at all
    // (Canvas.js alone is 5877 KiB raw in the bundle, pulled in by
    // `/r/[id]/+page.svelte`). #2088 tracks that structural work; this flag
    // exists so the ceiling stops blocking every deploy while it happens.
    //
    // ⚠ MINIFICATION HAS BITTEN THIS REPO BEFORE — see the note above about
    // the Faust worklet that broke under minification. That hazard is already
    // sidestepped by pre-bundling the worklet at DSP build time, and the
    // prerender pass (which EXECUTES this SSR bundle at build time, over 392
    // module doc pages) is a real exercise of it on every build.
    minify: true,
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
