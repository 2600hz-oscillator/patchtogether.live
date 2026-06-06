# SNES9X — SNES ROM setup instructions

The SNES9X module ships **without** any SNES ROM in the repo. Like DOOM's
`DOOM1.WAD` and the SM64 / QBERT ROMs, SNES ROM data is non-free +
non-redistributable game content; contributors supply their own copy
locally and the cloud deploys gracefully render a "ROM missing — load a
ROM" prompt when the file is absent. The module also supports loading a
ROM directly via the in-card file picker (DOOM-style), so the static-dir
copy is only a convenience for autoloading + e2e.

## For developers — place a ROM here

Run the setup task from the repo root (accepts `.sfc`, `.smc`, or a `.zip`
containing one):

```bash
flox activate -- task setup:snes9x ROM="/path/to/Super Mario World (USA).zip"
```

That extracts/copies the ROM into this directory as `game.sfc`. The file
is `.gitignore`d (binary ROMs don't belong in git) so a stray commit can't
land it.

At runtime the SNES9X module attempts to fetch `/roms/snes9x/game.sfc`. If
present, it autoloads. If absent (the default clean-checkout / cloud-deploy
state), the card shows a **"LOAD A ROM"** dropzone + file picker — the user
picks a `.sfc`/`.smc` from their disk and the game boots locally (the ROM
never leaves the browser).

## Where do I get a ROM?

This is not distributed by us — provide your own legally-sourced SNES ROM.
The first supported game is **Super Mario World (USA)** — its game-event
CV/GATE output definitions are populated (see the right-click
"see output definition for CV/GATES" panel). Other ROMs run + render +
play audio; their game-event outputs are inert until a per-ROM output
definition is added to the registry.

## Why is this gitignored instead of committed?

SNES ROMs are not freely redistributable. We ship the **emulator core
(WASM) + plumbing** in the open repo; users provide their own ROM. This
mirrors what every emulator front-end ships, and the DOOM / SM64 / QBERT
modules already in this repo.

## Emulator core + license

The emulator is the **snes9x2005 (CAT SFC)** libretro core, vendored under
`packages/web/native/snes9x/` and compiled to WebAssembly by
`packages/web/native/build-snes9x-wasm.sh`. The core is the libretro
team's **MIT** relicense of snes9x2005 (see
`packages/web/native/snes9x/copyright`) — MIT is AGPL-compatible, the same
convention as the vendored doomgeneric. The WASM build output
(`static/snes9x/snes9x.{js,wasm}`) is gitignored + built on demand
(`flox activate -- task setup:snes9x:build`).

The SNES WRAM is exposed to JavaScript via the bridge's `snes_get_wram()`
(= `retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM)`), which is what powers
the module's game-event CV/GATE outputs — see
`packages/web/src/lib/snes9x/smw-events.ts`.
