# packages/web/native/sm64js — Super Mario 64 (sm64js) bundle source

This directory documents the upstream sm64js repo we depend on for the
SM64 module. **Unlike `doomgeneric/`, we DO NOT vendor the upstream
source tree here.** sm64js is ~3 MB of decompiled Nintendo derivative
sources; the working sources stay outside the repo (default checkout
location: `../sm64js/` next to `inet.modular/`). What we commit is the
**prebuilt webpack bundle** at `packages/web/static/sm64js/sm64js.bundle.js`
(LFS-tracked — see repo root `.gitattributes`).

## Upstream

- Repo: <https://github.com/sm64js/sm64js>
- License: WTFPL (`LICENSE` in the upstream root) — the upstream owner
  has explicitly cleared distribution under "do what the fuck you want".
- Pinned commit:
  ```
  04c1a984117ebb8d0e7b0d5d2e3424367f69b92d
  ```
  (regenerate the bundle when bumping; record the new commit here.)
- Engine: pure-JS port of the SM64 decomp (no Emscripten / no WASM).
  Renders via WebGL into `<canvas id="gameCanvas">`. The bundle ships
  every model + texture loader + level script as JS modules; the actual
  Nintendo-owned texture bytes are extracted at runtime from a user-
  supplied US `.z64` ROM and persisted in IndexedDB.

## Why no vendored source?

1. sm64js is an actively-developed third-party project; vendoring would
   freeze us at a snapshot and double the disk-size of the repo for
   contributors who never edit it.
2. The build is one webpack invocation upstream — we don't need to
   modify any source to integrate it (see "How we use the bundle"
   below); a clean black-box wrapper is the right interface.
3. The decomp work is a derivative of the original SM64 sources, which
   has its own legal contour. Keeping the SOURCE outside the repo (we
   commit only the BUNDLE, which the upstream WTFPL-licenses) keeps
   that contour stable.

## How we use the bundle

The SM64 module (`packages/web/src/lib/audio/modules/sm64.ts`):

1. Injects a minimal DOM scaffold into its card (`#gameCanvas`,
   `#fullCanvas`, `#mapSelect`, `#startbutton`, `#rom`, `#romSelect`,
   `#romFile`, `#romMessage`, `#mainContent`, `#slider`, `#fps`,
   `#maxFps`, `#timing-total`).
2. Stubs the jQuery / Bootstrap globals the bundle expects (just enough
   for `$('[data-toggle="popover"]').popover(...)` + `$('#elem').clone()`
   / `.detach()` to no-op cleanly).
3. Loads `/sm64js/sm64js.bundle.js` via `<script>` tag — the bundle's
   `WebGLInstance` singleton runs at eval time, binding to the
   `#gameCanvas` we provided.
4. Monkey-patches `playerInputUpdate` to a no-op (the bundle exports
   this from `player_input_manager.js`) and writes
   `window.playerInput = { stickX, stickY, buttonDown* }` directly from
   our CV/gate edge state each scheduler tick.
5. Calls the bundle's `produce_one_frame()` once per scheduler tick.

The ROM-extraction flow is the upstream's:
`romTextureLoader.js:checkForRom()` looks up `IDB.get('assets')`; if a
texture-extracted blob exists it boots the game; otherwise it unhides
`#rom` (the upload dropzone) and disables `#startbutton`. The user
drops a `.z64` once → upstream extracts → blob persists in
`IDB.set('assets', msgpack.encode(data))`. Subsequent spawns boot
straight to a running game.

## Regenerating the bundle (when bumping upstream)

```bash
# 1. Check out (or update) upstream alongside inet.modular/.
git -C ../sm64js pull              # or git clone https://github.com/sm64js/sm64js.git ../sm64js

# 2. Build inside flox (Node 18+).
flox activate -- bash -c 'cd ../sm64js && npm install --no-audit --no-fund && NODE_OPTIONS=--openssl-legacy-provider npm run build'

# 3. Vendor the dist files.
cp ../sm64js/dist/main-*.js          packages/web/static/sm64js/sm64js.bundle.js
cp ../sm64js/dist/main-*.LICENSE.txt packages/web/static/sm64js/sm64js.bundle.LICENSE.txt
cp ../sm64js/dist/template.css       packages/web/static/sm64js/template.css

# 4. Record the upstream commit in this README under "Pinned commit".
git -C ../sm64js rev-parse HEAD
```

`NODE_OPTIONS=--openssl-legacy-provider` is needed because upstream's
webpack 4 pinning predates OpenSSL 3.

## IDB test fixture

The end-to-end test reads `e2e/fixtures/sm64-idb.bin` (LFS-tracked) —
an `idb-keyval` `'assets'` value (msgpack-encoded `{textureVersion: N,
<asset-name>: <Buffer>, ...}`) that the test seeds into IndexedDB to
boot the game without a ROM-upload step.

The fixture cannot be regenerated without a real ROM. To regenerate:

```bash
# 1. Put your US sm64.z64 next to inet.modular/ as /tmp/sm64.z64.
# 2. Run the extractor (Playwright-driven, headed, ~30 s).
flox activate -- node scripts/extract-sm64-idb.mjs /tmp/sm64.z64

# Output → e2e/fixtures/sm64-idb.bin
```

The script:
- spins up dev server,
- spawns an SM64 module,
- programmatically submits the ROM file via the card's upload affordance,
- waits for `IDB.get('assets')` to resolve to a non-null msgpack blob,
- writes the raw bytes to `e2e/fixtures/sm64-idb.bin`.

If `e2e/fixtures/sm64-idb.bin` is absent, the e2e test SKIPS gracefully
with a clear log line ("skipped: sm64-idb.bin not committed — run
scripts/extract-sm64-idb.mjs after providing a ROM").
