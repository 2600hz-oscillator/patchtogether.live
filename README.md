# patchtogether.live

Multiplayer browser-native modular synthesizer. Performers patch a shared rack live in their browser; the patch graph is a Yjs CRDT brokered by a Hocuspocus server, audio runs locally in Web Audio. Authoring is collaborative; rendering is local.

> Status: Stage B (multi-user) shipping. 19 audio modules. Visual modules planned post-Phase-5.

Docs: <https://2600hz-oscillator.github.io/patchtogether.live/> (auto-deployed from `docs/` on every push to `main`).

## Architecture

- **Auth.** Clerk for signed-in users. Anonymous join via HMAC-derived invite link (`/r/[id]?invite=<code>`); bare `/r/[id]` requires sign-in.
- **Sync.** Yjs doc accessed through SyncedStore. A Hocuspocus server on Fly.io brokers updates between participants (cap: 4 per rackspace, 1 owner + 3 others) and persists snapshots to Postgres.
- **Persistence.** Neon Postgres, one project, three branches (`production` / `autotest` / `dev`). The web tier on Cloudflare Workers can only reach Postgres through Neon's HTTP `neon` template tag — `pg` sockets and the WebSocket Pool both fail in Workers (`@neondatabase/serverless` HTTP is the only path that works). Hocuspocus on Fly runs Node and uses standard `pg.Pool` over TCP.
- **Patch graph.** Single domain dispatcher (`PatchEngine`) reconciles the shared graph into per-domain rendering engines. Today: audio. Multi-domain shape from day 1 so visual modules drop in without re-plumbing.

## DSP authoring

Two flavors of audio module sit behind a uniform `AudioModuleDef` registry:

- **Faust → WASM** for most generators / filters / effects. `.dsp` source in `packages/dsp/src/*.dsp`, compiled by `faust2wasm` to WebAssembly + an AudioWorkletProcessor wrapper. Build with `task dsp:build`.
- **TS AudioWorklets** for modules that need clock arithmetic, lookahead schedulers, or buffer state in JS land. LFO, Wavetable VCO, TIMELORDE, CHARLOTTE'S ECHOS — `packages/dsp/src/*.ts`.

Each module's web-side def lives in `packages/web/src/lib/audio/modules/*.ts` and registers via `module-registry.ts`. The factory wires `ChannelMerger` / `Splitter` so per-port mono signals route into the right Faust / worklet input channels.

## Developer workflow

This project uses **[Flox](https://flox.dev)** to pin the toolchain (Node 22, Faust 2.85.5, esbuild, go-task, git-lfs, gh) and **[go-task](https://taskfile.dev)** as the single command surface. Every command runs as `flox activate -- task <target>`.

```bash
flox activate -- task setup     # one-time: npm install + Playwright Chromium
flox activate -- task dev       # SvelteKit dev server (DSP built once up-front)
flox activate -- task dev:full  # + DSP file watcher in parallel
flox activate -- task ci        # full PR-gate suite (typecheck + unit + ART + E2E)
flox activate -- task           # list every available target
```

Multi-user dev requires a Hocuspocus server too:

```bash
flox activate -- task server:dev   # ws://localhost:1235  (1234 = BitwigStudio OSC)
```

If you stay inside `flox activate` (one shell), drop the `flox activate --` prefix.

## Layout

```
packages/web        SvelteKit app (Svelte 5, @xyflow/svelte canvas, Web Audio)
packages/dsp        Faust .dsp + TS AudioWorklets → built to packages/dsp/dist
packages/server     Hocuspocus + Clerk JWT verify + capacity (Stage B+)
db/                 Neon Postgres schema (apply in order)
art/                Audio Regression Tests (offline render → FFT/PCM assertions)
e2e/                Playwright end-to-end tests (full app, real Web Audio)
docs/               Astro docs site, deployed to GitHub Pages
```

## Deploy

Three tiers, fan-out from this repo:

| tier     | URL                              | trigger                                  | beta gate         |
|----------|----------------------------------|------------------------------------------|-------------------|
| prod     | `patchtogether.live`             | `package.json:.version` bump on `main`   | off               |
| autotest | `autotest.patchtogether.live`    | every push to `main`                     | `beta:robotsonly` |
| dev      | `dev.patchtogether.live`         | every push to `main`                     | `beta:2600hz`     |

PR previews land at `pr-N.patchtogether-live-autotest.pages.dev` (autotest project) so the test Clerk env is reachable. Each tier maps to its own Cloudflare Pages project, Fly Hocuspocus app, and Neon Postgres branch. See `.github/workflows/deploy.yml` and `db/README.md`.

## Testing

Four layers, by ascending integration scope:

- **Unit** — Vitest, fast, scoped per workspace. `task test`.
- **ART** — Audio Regression Tests. Offline render of compiled DSP → Float32 PCM, then FFT / harmonic / silence-floor assertions, plus byte-exact `.f32` baselines pinned in Git LFS where deterministic. Scenarios in `art/scenarios/`. `task art` to run, `task art:update` to regenerate baselines.
- **VRT** — Visual Regression Tests. **Planned, not yet implemented.** See `.myrobots/plans/testing-strategy.md`. The harness directory `vrt/` does not exist yet.
- **E2E** — Playwright headless Chromium against a real Vite dev server (or `vite preview` when `E2E_USE_PREVIEW=1`). `task e2e`. The `@smoke`-tagged subset doubles as the post-deploy live check on autotest.

The PR gate runs typecheck + unit + ART + E2E inside Flox so the toolchain matches local. Postgres 17 is a CI service container.

## Module catalog

19 audio modules currently registered. Full per-module I/O diagrams + param tables are auto-generated from the registry and published with the docs site: <https://2600hz-oscillator.github.io/patchtogether.live/modules/>.

## License

See [LICENSE](./LICENSE).
