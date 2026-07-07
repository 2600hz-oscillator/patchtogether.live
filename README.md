# patchtogether.live

Multiplayer browser-native modular synthesizer. Audio + video domains. Patches are CRDT-shared (Yjs); rendering is local (Web Audio + WebGL2).

> Status: Stage B (multi-user). 30 audio modules · 15 video modules · cross-domain CV bridge.

In-app docs: <https://patchtogether.live/docs>.

## Quick start

This project uses [Flox](https://flox.dev) for the toolchain (Node 22, Faust 2.85.5, esbuild, go-task, gh, git-lfs) and [go-task](https://taskfile.dev) as the single command surface. Every command runs as `flox activate -- task <target>`.

```bash
flox activate -- task setup     # one-time: npm install + Playwright Chromium
flox activate -- task dev       # SvelteKit dev server (DSP built once up-front)
flox activate -- task dev:full  # + DSP file watcher in parallel
flox activate -- task ci        # full PR-gate suite (typecheck + unit + ART + E2E)
flox activate -- task           # list every available target
```

Multi-user dev needs a Hocuspocus server alongside:

```bash
flox activate -- task server:dev   # ws://localhost:1235  (1234 = BitwigStudio OSC)
```

If you stay inside one `flox activate` shell, drop the `flox activate --` prefix.

## Run locally as a standalone demo (no network)

The public canvas at `/` is architected so it boots with no network
dependency: SvelteKit serves it from your localhost dev server, all 30
audio + 15 video modules render in-process (Web Audio + WebGL2), and the
runtime-fetched assets (wavetable WAVs, TR-808 samples, glitch image,
SM64 bundle) ship inside the repo under `packages/web/static/`. Use it as
a fallback demo path when you're offline.

### One-time prep (while you're still online)

You'll need Flox and `npm` installed before you go offline:

```bash
# Flox — https://flox.dev/docs/install-flox/
curl -L https://downloads.flox.dev/by-env/stable/osx/flox.pkg -o /tmp/flox.pkg && sudo installer -pkg /tmp/flox.pkg -target /
# npm comes with the Node 22 that Flox activates; nothing extra to install here.
```

Then clone + warm the toolchain + pre-build the DSP + fetch the optional
DOOM shareware WAD in one shot:

```bash
git clone https://github.com/2600hz-oscillator/patchtogether.live.git
cd patchtogether.live
flox activate -- task setup:standalone
```

`setup:standalone` runs `npm install` (lockfile-pinned, so subsequent runs
are offline-safe), builds the Faust + TS DSP worklets to
`packages/dsp/dist/`, and best-effort downloads `DOOM1.WAD` to
`packages/web/static/doom/`. Optional: while still online, run
`bash packages/web/native/build-doom-wasm.sh` to compile the DOOM WASM
runtime (requires `emcc` on PATH — see the script header for the
Emscripten install link).

### Going offline

Disconnect the network, then:

```bash
flox activate -- task dev
```

Open <http://localhost:5173/> in any modern browser. The canvas loads,
the module palette lists every registered module, audio + video engines
spin up, and patches make sound.

### What you can + can't do offline

Works offline (single-machine, single-user):

- Spawning any of the 30 audio / 15 video modules from the palette
- Patching cables, including the cross-domain CV bridge
- Saving + loading patches via "Save Perf" / "Load Perf" (browser local storage)
- Loading any of the bundled example patches
- Switching to most skins (the default skin uses local fonts)
- SM64 + DOOM modules — once their assets are present (see prep above);
  DOOM also needs a ROM-less but local `DOOM1.WAD`.

Doesn't work offline (visible but harmlessly inert):

- The "Sign in" link routes to `/dashboard`, which returns 503 with a
  clear "Auth not configured" message. Same for `/sign-in`, `/sign-up`,
  `/r/[id]` (multiplayer rooms), and `/api/saved-groups`. Clicking
  these does nothing destructive — you stay on the public canvas.
- Multiplayer (Yjs sync over Hocuspocus) — the public canvas at `/`
  never attaches a network provider, so this is silently absent rather
  than retry-spamming the console.
- A handful of optional skins (LCARS, MATRIXCOWBOY, DINER, VINTAGE)
  pull their display font from `fonts.googleapis.com`. Offline they
  fall back to the system monospace; the rest of the skin still
  applies. Default skin uses only locally-bundled fonts.

### Troubleshooting

- **Browser shows a blank page**: confirm the dev server printed
  `Local: http://localhost:5173/` and that you haven't pointed at a
  different port. SvelteKit's client runtime is served by the dev
  server itself; if vite isn't up, the page is blank.
- **A module spawns but shows a "asset not found" overlay**: the
  underlying asset is missing from `packages/web/static/`. For DOOM:
  run `setup:standalone` while online, or follow
  `packages/web/static/doom/DOWNLOAD_INSTRUCTIONS.md` manually. For
  LFS-tracked bundles that still show a pointer, re-run `git lfs pull`
  while online.
- **Console warns about a failed WebSocket / `wss://...`**: only
  happens on `/r/[id]`, which you can't reach offline anyway. The
  public canvas at `/` doesn't open a WebSocket at all.
- **"Cross-origin-isolated" appears `false`**: a third-party browser
  extension is stripping COOP/COEP headers. Try an Incognito window.

## Stack

- **Web** — SvelteKit 2 / Svelte 5 on Cloudflare Pages (Workers runtime). Canvas built on `@xyflow/svelte`.
- **Audio** — Web Audio + AudioWorklet. Most DSP is Faust 2 → WASM (`packages/dsp/src/*.dsp`); a handful of modules ship as hand-written `AudioWorkletProcessor`s in TS (`packages/dsp/src/*.ts`) for clock arithmetic, lookahead schedulers, or in-JS state (LFO, Wavetable VCO, TIMELORDE, CHARLOTTE'S ECHOS, DX7).
- **Video** — WebGL2 fragment shaders. Each video module ships its own GLSL + a `VideoModuleDef` factory.
- **Multiplayer** — Yjs doc accessed through SyncedStore. A Hocuspocus server on Fly.io brokers updates and persists snapshots to Postgres. Per-rackspace cap: 4 (1 owner + 3 others). Anonymous join via HMAC invite link (`/r/[id]?invite=<code>`); bare `/r/[id]` requires Clerk sign-in.
- **Persistence** — Neon Postgres, three branches (`production` / `autotest` / `dev`). The web tier on Cloudflare Workers can only reach Postgres through Neon's HTTP `neon` template tag — `pg` sockets and the WebSocket `Pool` both fail under Workers. The Hocuspocus server (Fly Node) uses standard `pg.Pool` over TCP.

## Modules

45 modules total, registered across two per-domain catalogs (`packages/web/src/lib/audio/module-registry.ts` and `.../video/module-registry.ts`). The full I/O + param tables are auto-generated from the registries and published at <https://patchtogether.live/docs/modules>; right-clicking any module on the canvas opens its per-module docs page in a new tab.

### Audio (30)

| category   | modules |
|------------|---------|
| sources    | analogVco, wavetableVco, vizvco, swolevco, drummergirl, meowbox, dx7, noise |
| modulation | adsr, lfo, sequencer, cartesian, score, drumseqz, polyseqz, timelorde, buggles |
| filters    | filter, qbrt |
| effects    | reverb, charlottesEchos, destroy |
| utilities  | mixer, mixmstrs, vca, scope, illogic |
| output     | audioOut |

`timelorde` and `mixmstrs` are singletons (one per rackspace).

Polyphony rides on the `polyPitchGate` cable (10 audio channels packing 5 voice pairs of `(pitch, gate)`). DX7 and POLYSEQZ use it natively; SEQUENCER / CARTESIAN can drive it via their poly outputs. See `packages/web/src/lib/audio/poly.ts`.

### Video (15)

| category   | modules |
|------------|---------|
| sources    | lines, inwards, picturebox, shapes, shapedramps, cameraInput |
| effects    | destructor, chroma, luma, colorizer, feedback |
| utilities  | videoMixer |
| output     | monoglitch, ruttetra, videoOut |

Cable types: `image` (still RGB), `mono-video` (1-channel animated), `video` (RGB animated), `keys` (1-channel still). Free upcasts: `keys -> mono-video`, `image -> video`, `keys -> image`, `mono-video -> video`. See `canConnect` in `packages/web/src/lib/graph/types.ts`.

### Cross-domain CV

Audio-side `cv` cables can terminate on a video module's CV input. The cross-domain bridge in `PatchEngine` reads the audio CV at frame rate and pushes it into `VideoEngine.setParam`. `cameraInput` is webcam-local (the captured stream stays in your browser tab); collaborators see a `user X has CAMERA active` awareness badge but not the video itself.

### CV range convention

The `cv` cable type carries a bipolar **−1..+1** modulation signal where ±1 sweeps the target param through its full natural range. Per-port `cvScale` hints (`linear` / `log` / `discrete` / `passthrough`) live on each input `PortDef`; `AudioEngine.addEdge` interposes the right `GainNode` / `WaveShaperNode` so an LFO at ±1 actually drives the target slider edge-to-edge. The invariant is enforced by `e2e/tests/cv-range-uniformity.spec.ts`. See `packages/web/src/lib/graph/types.ts:CvScaleHint` and `.myrobots/plans/cv-range-standard.md`.

## Layout

```
packages/web        SvelteKit app (Svelte 5, @xyflow/svelte canvas, Web Audio, WebGL2)
packages/web/src/routes/docs/   in-app docs site (statically prerendered)
packages/web/src/lib/audio/     audio engine + module registry + AudioModuleDefs
packages/web/src/lib/video/     video engine + module registry + VideoModuleDefs
packages/dsp        Faust .dsp + TS AudioWorklets → built to packages/dsp/dist
packages/server     Hocuspocus + Clerk JWT verify + 4-conn capacity (Stage B+)
db/                 Neon Postgres schema (apply in order)
art/                Audio Regression Tests (offline render → FFT/PCM assertions)
e2e/                Playwright end-to-end tests (full app, real Web Audio + WebGL2)
```

Patch graph is the canonical state — a `Y.Doc` with `nodes` + `edges` + per-user `layouts`. A `PatchEngine` reconciler diffs the live graph against per-domain rendering engines (`AudioEngine`, `VideoEngine`) and issues add / remove / setParam calls. New domains plug in by registering another engine — no changes to the graph layer.

## Deploy

Three tiers, fan-out from this repo:

| tier     | URL                              | trigger                                  | beta gate         |
|----------|----------------------------------|------------------------------------------|-------------------|
| prod     | `patchtogether.live`             | `package.json:.version` bump on `main`   | off               |
| autotest | `autotest.patchtogether.live`    | every push to `main`                     | `beta:robotsonly` |
| dev      | `dev.patchtogether.live`         | every push to `main`                     | `beta:2600hz`     |

PR previews land at `pr-N.patchtogether-live-autotest.pages.dev` (autotest project) so the test Clerk env is reachable. Each tier maps to its own Cloudflare Pages project, Fly Hocuspocus app, and Neon Postgres branch. See `.github/workflows/deploy.yml`, `db/README.md`, and `/docs/deploy`.

## Testing

Three layers in CI today, plus port-surface consistency gates:

- **Unit** — Vitest, fast, scoped per workspace. `flox activate -- task test`.
- **ART** — Audio Regression Tests. Offline render of compiled DSP through `node-web-audio-api` → Float32 PCM → FFT / harmonic / silence-floor assertions, plus byte-exact `.f32` baselines pinned in Git LFS where deterministic. `flox activate -- task art` to run; `task art:update` to regenerate baselines. Scenarios in `art/scenarios/`.
- **E2E** — Playwright headless Chromium against the real SvelteKit app (Vite dev or `vite preview` when `E2E_USE_PREVIEW=1`). `flox activate -- task e2e`. The `@smoke`-tagged subset doubles as the post-deploy live check on autotest (`task ci:smoke:live`).

Three port-surface consistency gates run inside the unit + e2e layers:

- `module-manifest.test.ts` — published manifest input/output ids match each registered `ModuleDef`.
- `cv-range-uniformity.spec.ts` — every `cv` input declares a `cvScale` hint; LFO at ±1 sweeps the slider edge-to-edge.
- `io-spec-consistency.spec.ts` — every UI `<Handle>`'s `data-handleid` matches the module def's port ids.

The PR gate (`flox activate -- task ci`) runs typecheck + unit + ART + E2E inside Flox so the toolchain matches local. Postgres 17 is a CI service container.

- **VRT** — Visual Regression Tests. Playwright `toHaveScreenshot` against every registered module card; baselines under `e2e/vrt/__screenshots__/vrt.spec.ts/{platform}/` (LFS-tracked) where `{platform}` is `linux` / `darwin` / `win32` (matches `process.platform`). The per-platform layout lets devs on macOS pass against `darwin/*.png` while CI on Linux passes against `linux/*.png` — same suite, no cross-platform AA flake. `flox activate -- task vrt` to run; `task vrt:update` to refresh the baselines for whichever platform you're on (commit both subdirs when you ship); `task vrt:gallery` to rebuild the side-by-side HTML report under `docs/vrt/`. CI publishes the latest gallery to GitHub Pages on push to `main` (see "VRT gallery on GitHub Pages" below for the one-time admin enablement). Modeled on the doomviz VRT pattern; non-blocking initially while baselines settle. When CI VRT fails: download the `vrt-test-results` + `vrt-gallery` artifacts from the run, eyeball the diff PNGs, and either re-run `task vrt:update` (intentional UI change) or fix the regression.

### VRT gallery on GitHub Pages (one-time admin step)

The VRT gallery publishes to GitHub Pages after every push to `main` via `.github/workflows/pages.yml`. This requires Pages to be enabled at the repo level — until that toggle is flipped, every `pages.yml` run fails at `actions/configure-pages@v5` with `Pages site failed. Please verify that the repository has Pages enabled`.

To enable (repo admin, one-time):

1. Go to <https://github.com/2600hz-oscillator/patchtogether.live/settings/pages>.
2. Under **Build and deployment → Source**, select **GitHub Actions**.
3. Save.

After enablement the gallery is live at <https://2600hz-oscillator.github.io/patchtogether.live/> (the `docs/index.html` redirect lands you on `/vrt/`).

Until then, the gallery is uploaded as a `vrt-gallery` artifact on every CI run and can be downloaded from the run page.

## Decisions

Architectural decisions with non-obvious tradeoffs live as ADRs (MADR
format) under [`docs/adr/`](./docs/adr/README.md). Start there for the
*why* behind the patch-graph layer, multiplayer lifecycle, cross-domain
bridges, CV ranges, persistence formats, and rackspace join semantics.

## Conventions

- Comments explain **why**, not what. If the code is self-evident, no comment.
- New commits — never `git commit --amend`. If a hook fails, fix and create a new commit.
- Force-push only with `--force-with-lease`. Never `--force` on `main`.
- Hocuspocus binds 1235, not 1234 (BitwigStudio reserves 1234 for OSC on the dev machine).
- For DB code in CF Workers: only Neon's HTTP `neon` template tag works. Anything that needs atomicity has to be a single SQL statement, typically a CTE — see `packages/web/src/lib/server/rackspaces.ts`.

## License

See [LICENSE](./LICENSE).
