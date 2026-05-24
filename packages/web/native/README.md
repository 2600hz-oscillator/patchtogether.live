# packages/web/native — emcc-compiled WASM blobs

Vendored C sources that compile to WebAssembly and load into the web
bundle at runtime. Today: just `doomgeneric/` for the DOOM module.

## doomgeneric → `static/doom/doom.{js,wasm}`

`build-doom-wasm.sh` runs `emcc` over the vendored `doomgeneric/`
sources and writes the ES-module shim + WASM binary into
`packages/web/static/doom/`. The output is **.gitignored** (per
`packages/web/.gitignore`) — every developer + CI runner builds it
locally on demand.

### Quick start

```bash
flox activate -- bash packages/web/native/build-doom-wasm.sh
```

That produces `packages/web/static/doom/doom.js` (~60 KB) and
`doom.wasm` (~400 KB). First run takes ~60 s while emcc populates its
sysroot cache; subsequent runs are ~10 s.

Once those two files exist, spawning a DOOM module in the dev server
fetches them at runtime and renders gameplay. Without them the card
shows a `"DOOM WASM not built"` overlay (see
`src/lib/doom/doom-runtime.ts:loadDoomModule`).

### Requirements

- **Emscripten** — `emcc` 3.1.61+ (5.0.6 is what the flox manifest
  pins). The flox env has it pre-installed; outside flox, see
  <https://emscripten.org/docs/getting_started/downloads.html>.
- **bash 4+** — for `set -o pipefail`.

### Why no pre-built blob in git?

- WASM diffs are noise; LFS would help but the .wasm + .js still
  re-emit on every emscripten version bump.
- Build is deterministic enough that CI can produce it on demand
  (see `.github/workflows/ci.yml` → "Build DOOM WASM (emcc)" step).
- The actions/cache key is keyed on `build-doom-wasm.sh` +
  `doomgeneric/**` so the rebuild only fires when a contributor
  edits one of those.

### Multi-platform notes

- macOS arm64 + x86_64: works via flox/nixpkgs.
- Linux x86_64 + arm64: works via flox/nixpkgs (the CI runner path).
- Windows: not supported. Use WSL2 or just rely on CI.

### What about the shareware WAD?

`DOOM1.WAD` is a separate ~4 MB binary not bundled here. See
`packages/web/static/doom/DOWNLOAD_INSTRUCTIONS.md` for the one-liner.
