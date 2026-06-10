# Local Development

This repo uses **Flox** to provide a reproducible toolchain and **go-task**
(`Taskfile.yml`) to orchestrate everything. Every command runs inside the Flox
environment: `flox activate -- <cmd>`.

## Toolchain (provided by Flox)

`.flox/env/manifest.toml` pins the toolchain, including (verify exact versions in
the manifest):

- Node 22.x
- Faust (DSP compiler) — used by the DSP build
- esbuild, go-task, git-lfs, emscripten (for the WASM emulator builds)

> **Why Flox:** running git/npm/task outside Flox can make git-LFS operations
> hang and may use a wrong Node version. Always wrap in `flox activate --`.

## One-time setup

```sh
flox activate -- task setup              # npm install (workspaces) + Playwright Chromium
flox activate -- task setup:standalone   # offline prep: npm warmup + dsp:build + DOOM WAD fetch
```

Optional ROM-backed modules (user supplies their own ROM; gitignored):

```sh
flox activate -- task setup:qbert ROM=~/qbert.zip      # Q*Bert arcade module
flox activate -- task setup:snes9x ROM=~/game.sfc      # SNES ROM, then setup:snes9x:build
```

## Running locally

```sh
flox activate -- task dev          # SvelteKit dev server on :5173 (builds DSP once up front)
flox activate -- task dev:full     # dev server + Faust DSP file-watcher in parallel
flox activate -- task server:dev   # Hocuspocus relay on :1235 (needed for multi-user)
```

For multiplayer testing you need both `task dev` and `task server:dev` running.
The relay defaults to port **1235** (not 1234 — that port is reserved on this
machine for a DAW).

### Single-test dev loop (fast)

A long-lived server lets you iterate e2e/VRT specs without rebooting per run:

```sh
flox activate -- task e2e:serve                 # boot dev server (:5173) + leave it up
flox activate -- task e2e:one  -- tests/foo.spec.ts   # one spec against the warm server
flox activate -- task vrt:one  -- adsr          # one VRT card by grep
flox activate -- task e2e:status                # is the server up?
flox activate -- task e2e:stop                  # tear down (don't leak dev servers)

# Target the production preview build instead of dev:
flox activate -- E2E_PREVIEW=1 task e2e:serve   # vite preview on :4173
```

`dev-server.sh` (`scripts/dev-server.sh`) tracks a PID file + port lockfile and
does belt-and-suspenders cleanup to avoid orphan servers.

## The DSP / Faust artifact story

The audio modules are written in **Faust** (`packages/dsp/src/*.dsp`) plus
TypeScript AudioWorklet glue (`packages/dsp/src/*.ts`). The build produces a
`packages/dsp/dist/` bundle that the web app consumes.

```sh
flox activate -- task dsp:build    # compile Faust + TS worklets → packages/dsp/dist/
```

What happens (`packages/dsp/scripts/build.mjs` + `build-worklet.mjs`):

1. **Per `.dsp` file:** the `faust2wasm` CLI emits `.wasm` + `.json` metadata +
   a `.sha` content hash.
2. **Per `.ts` worklet:** esbuild bundles to `.js` + sourcemap + `.sha`.
3. **`build-worklet.mjs`** pre-bundles the AudioWorklet processors in Node so
   Vite's downstream minifier never touches them. (Faust stitches processor
   classes at runtime via `.toString()`; minifier renaming breaks that, so the
   worklet bundles are pre-baked and excluded from downstream minification.)

### Rebuild guard

`scripts/dsp-src-hash.sh` fingerprints all DSP sources + toolchain versions and
writes `packages/dsp/dist/.dsp-srchash`. If nothing changed, `task dsp:build`
no-ops. To force a clean rebuild:

```sh
rm -rf packages/dsp/dist                 # nuke the dist (forces full recompile)
flox activate -- task dsp:build
```

> Run a clean `rm -rf packages/dsp/dist && task dsp:build` when you specifically
> want to catch a stale-artifact / SHA mismatch (the kind of failure that only
> shows up on a fresh CI checkout). Do NOT use `dsp:fetch-dist` for that — it
> copies a prebuilt dist instead of compiling this worktree's sources.

### Faust-less worktrees

Agent worktrees often lack a Faust install. `task dsp:ensure` handles this:

```sh
flox activate -- task dsp:ensure       # reuse current dist if up to date;
                                       # else compile with Faust if available;
                                       # else copy a prebuilt dist from the primary checkout
flox activate -- task dsp:fetch-dist   # explicitly copy prebuilt dist (local dev only)
```

The `*:one` audio targets depend on `dsp:ensure`, so single-test runs work even
before Faust is set up. **CI is unaffected** — it always compiles via the
dedicated `dsp-build` job.

## WASM emulator modules

DOOM and SNES9X modules are Emscripten-compiled C → static assets. These require
`emcc` on `PATH` (provided by Flox's emscripten, or your own emsdk):

```sh
flox activate -- bash packages/web/native/build-doom-wasm.sh    # → static/doom/doom.{js,wasm}
flox activate -- bash packages/web/native/build-snes9x-wasm.sh  # → static/snes9x/snes9x.{js,wasm}
```

DOOM loads `DOOM1.WAD` (shareware) from `/doom/DOOM1.WAD` at runtime. It's fetched
by `task setup:standalone` and is **gitignored**. If missing, the DOOM module shows
an "asset missing" overlay at runtime (safe, not fatal). See
`packages/web/static/doom/DOWNLOAD_INSTRUCTIONS.md` to fetch manually. ROMs follow
the user-supplied + gitignored pattern (never committed).

## Local Postgres (optional)

Most local work doesn't need a DB — the relay falls back to in-memory mode when
`DATABASE_URL` is unset, and web falls back to a localhost dev DB. To stand up a
local Postgres on the non-standard port **54320** (avoids 5432 collisions), see
[integrations/neon-postgres.md](integrations/neon-postgres.md) ("Local dev").

## Common Taskfile targets

| Target | Purpose |
| --- | --- |
| `task setup` | npm install + Playwright |
| `task dev` / `task dev:full` | dev server (+ DSP watcher) |
| `task server:dev` | Hocuspocus relay on :1235 |
| `task dsp:build` / `dsp:ensure` / `dsp:fetch-dist` | DSP bundle |
| `task build` / `task build:web` | production build (see [build.md](build.md)) |
| `task typecheck` | svelte-check across all workspaces |
| `task test` / `art` / `e2e` / `vrt` / `vrt:strict` | test layers (see [testing.md](testing.md)) |
| `task clean` | remove build artifacts (`dist/`, `.svelte-kit/`, `build/`) |
| `task clean:deep` | nuke `node_modules` + `package-lock.json` |
| `task sync-secrets -- <tier> [--apply]` | push tier secrets (see [secrets-and-accounts.md](secrets-and-accounts.md)) |

## Worktree hygiene

Hard cap of **10** git worktrees (abandoned agent checkouts accumulate fast).
Before creating one, run `flox activate -- task worktree:guard` — it prunes
abandoned worktrees and exits non-zero (listing what needs a human) if still over
the cap. See the repo `CLAUDE.md` for the full policy.
