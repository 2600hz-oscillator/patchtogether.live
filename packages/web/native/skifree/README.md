# packages/web/native/skifree — SkiFree.js engine source

This directory vendors the upstream **skifree.js** game engine + a thin
embed wrapper we bundle for the SKIFREE module
(`packages/web/src/lib/audio/modules/skifree.ts` + `SkifreeCard.svelte`).

Unlike `sm64js/` (which keeps the decomp source OUTSIDE the repo and commits
only the prebuilt bundle), skifree.js is small + cleanly MIT-licensed, so we
vendor its source `js/` tree here and build our own bundle from it. The
committed, runtime-served artifacts are:

- `packages/web/static/skifree/skifree.bundle.js` — the esbuild IIFE bundle
  (~24 KB) of `embed.js` + the upstream `js/` classes. Loaded by the card as
  `<script src="/skifree/skifree.bundle.js">`; exposes `window.SkiFree`.
- `packages/web/static/skifree/sprite-characters.png`
- `packages/web/static/skifree/skifree-objects.png` — the two upstream sprite
  sheets, served verbatim. The game's `spriteInfo.js` references them by bare
  filename; the embed loads them from `/skifree/<file>`.

## Upstream + License

- Repo: <https://github.com/basicallydan/skifree.js>
- License: **MIT** — `license.md` (vendored here verbatim).
  Copyright (C) 2013 Daniel Hough. MIT is permissive — safe to vendor +
  redistribute as a bundle, attribution preserved (the module def's
  `ossAttribution: { author: 'skifree.js / Daniel Hough (MIT)' }`, this
  README, and `license.md`).
- Pinned commit:
  ```
  a812f944f7420ab53374b6b983ef3eb54f8a26ce
  ```
  (record the new commit here when bumping upstream.)
- The upstream's own runtime deps (Hammer.js touch + br-mousetrap keyboard)
  are NOT bundled — `embed.js` does not import the upstream `js/lib/input.js`
  (which pulls them in). We supply our own mouse + CV steering instead, so the
  bundle has zero third-party runtime deps beyond the game's own pure classes.

## What's vendored

`js/` is the upstream source tree, copied verbatim (no edits):

```
js/main.js              # upstream SPA entry — NOT bundled (kept for reference)
js/spriteInfo.js        # sprite-sheet atlas table
js/lib/{camera,constants,game,guid,infoBox,input,isMobileDevice,
        monster,skier,skiLift,snowboarder,sprite,spriteArray}.js
```

`embed.js` is OUR file (the esbuild entry). It re-uses the upstream classes
verbatim and exposes a clean controller API (`window.SkiFree.create`) bound to
a card-owned canvas, with:
- `setCursor(x, y)` — drive the skier (the CV path),
- `enableMouse(el)` / `disableMouse()` — native mouse steering (the focus path),
- an `onGate(evt)` callback fired on every crash / eaten event (the gate hook,
  via `skier.setHitObstacleCb`).

`embed.js` deliberately does NOT import `js/main.js` or `js/lib/input.js` so
none of the upstream's `getElementById` / `window.innerWidth` / Hammer /
Mousetrap assumptions leak into the embed.

## Regenerating the bundle (after editing embed.js or bumping upstream)

```bash
# 1. (bump only) Re-vendor the upstream js/ tree + license:
git clone https://github.com/basicallydan/skifree.js.git /tmp/skifree.js
cp -r /tmp/skifree.js/js/*                 packages/web/native/skifree/js/
cp    /tmp/skifree.js/license.md           packages/web/native/skifree/license.md
cp    /tmp/skifree.js/sprite-characters.png packages/web/static/skifree/
cp    /tmp/skifree.js/skifree-objects.png   packages/web/static/skifree/

# 2. Build the bundle (esbuild ships in the flox env):
flox activate -- esbuild packages/web/native/skifree/embed.js \
  --bundle --format=iife --define:global=globalThis --minify \
  --legal-comments=external \
  --outfile=packages/web/static/skifree/skifree.bundle.js

# 3. (bump only) Record the new upstream commit above.
```
