# Build Pipeline

The full production build has three independent artifact families:

1. **DSP dist** — Faust `.dsp` → WASM, TS worklets → JS (`packages/dsp/dist/`).
2. **Web bundle** — SvelteKit + Vite → Cloudflare Pages output (`.svelte-kit/cloudflare`).
3. **WASM emulator assets** — Emscripten C → static assets (DOOM, SNES9X).

All commands run through Flox: `flox activate -- …`.

## Top-level build

```sh
flox activate -- task build       # dsp:build + vite build (production web bundle)
flox activate -- task build:web   # web build only (assumes DSP dist already present)
```

## 1. DSP dist

```sh
flox activate -- task dsp:build
```

Driven by `packages/dsp/scripts/build.mjs` and `build-worklet.mjs`:

- For each `.dsp` file: `faust2wasm` CLI → `.wasm` + `.json` metadata + `.sha`
  content hash.
- For each `.ts` worklet: esbuild → `.js` + sourcemap + `.sha`.
- `build-worklet.mjs` **pre-bundles AudioWorklet processors at DSP-build time** so
  Vite's downstream minifier never mangles them (Faust's runtime `.toString()`
  class-stitching breaks under minification — see [local-development.md](local-development.md)).

**Rebuild guard:** `scripts/dsp-src-hash.sh` fingerprints DSP sources + toolchain
and writes `packages/dsp/dist/.dsp-srchash`. `task dsp:build` no-ops when the
fingerprint is unchanged. Force a clean rebuild with `rm -rf packages/dsp/dist`
first. In CI this guard lets every downstream job skip recompile and reuse the
single `dsp-build` artifact (see [ci.md](ci.md)).

## 2. Web bundle (SvelteKit + Vite → Cloudflare Pages)

```sh
flox activate -- npm run build -w packages/web    # or: task build:web
```

- **SvelteKit sync** → `.svelte-kit/`, then **`vite build`** →
  `.svelte-kit/cloudflare/` (the Pages output dir declared in `wrangler.toml`'s
  `pages_build_output_dir`).
- **Adapter:** `@sveltejs/adapter-cloudflare` (`packages/web/svelte.config.js`).
  The app is effectively fully client-rendered; SvelteKit's hooks run as edge
  middleware. Runes mode is enabled (`compilerOptions.runes`).
- **COOP/COEP headers** for `SharedArrayBuffer` are set both in
  `packages/web/_headers` (production) and in `hooks.server.ts`'s
  `setCoopCoepHeaders` (dev + edge), as belt-and-suspenders.
- **Vite config** (`packages/web/vite.config.ts`) also widens `fs.allow` to
  include the hoisted `node_modules` so the app builds/serves correctly from agent
  git worktrees (which have no local `node_modules`).

### Build-time vs runtime env

`VITE_*` variables are **baked into the client bundle at build time** and cannot
be changed without a rebuild:

| Var | Effect |
| --- | --- |
| `VITE_SERVER_WS_URL` | Hocuspocus relay URL per tier (must match the deployed relay) |
| `VITE_E2E_HOOKS` | `1` exposes in-page test globals (`__patch`/`__ydoc`/…) — never on prod |
| `VITE_VIDEO_WORKER` | enable the WebGL video worker |

Runtime secrets (`CLERK_SECRET_KEY`, `DATABASE_URL`, `INVITE_SECRET`,
`BETA_GATE_*`) are read on the server at request time from the platform env (CF
Pages Variables + Secrets), **not** baked into the bundle. See
[secrets-and-accounts.md](secrets-and-accounts.md).

> **Common trap:** changing `VITE_SERVER_WS_URL` in the CF dashboard does nothing
> — it's a build-time inline. Each tier must be **built** with the correct WS URL
> or clients connect to the wrong relay.

## 3. WASM emulator assets

Require `emcc` (Emscripten) on `PATH`:

```sh
flox activate -- bash packages/web/native/build-doom-wasm.sh    # vendored doomgeneric → static/doom/doom.{js,wasm}
flox activate -- bash packages/web/native/build-snes9x-wasm.sh  # snes9x2005 core    → static/snes9x/snes9x.{js,wasm}
```

Built with `-sMODULARIZE -sEXPORT_ES6`. ROM/WAD data is loaded at runtime and is
gitignored (see [local-development.md](local-development.md)). These are optional
for routine web development — only rebuild when the emulator C sources change.

## Clean / reset

```sh
flox activate -- task clean        # remove dist/, .svelte-kit/, build/
flox activate -- task clean:deep   # also nuke node_modules + package-lock.json
```

## How CI builds (for reference)

CI builds each family **once** and shares the result:

- `dsp-build` job compiles Faust once, publishes the `packages/dsp/dist/**`
  artifact; every downstream job downloads it.
- `build-web` job builds the SvelteKit/Vite **preview** bundle with
  `VITE_E2E_HOOKS=1`, publishes it as `web-preview-dist`; e2e/VRT/collab jobs run
  against `vite preview` (:4173) instead of a dev server.

See [ci.md](ci.md) for the full pipeline.
