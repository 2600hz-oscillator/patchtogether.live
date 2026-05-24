# Third-party notices — doomgeneric

This directory vendors **doomgeneric** by Wojciech Graj / ozkl
(<https://github.com/ozkl/doomgeneric>) which is itself a generic-platform
fork of **Chocolate Doom** (Simon Howard et al., <https://www.chocolate-doom.org/>)
which is itself a faithful reimplementation of id Software's **Doom**
(1993) source code released by id Software in 1997.

## License chain

| Component                            | License                       | Copyright                                            |
| ------------------------------------ | ----------------------------- | ---------------------------------------------------- |
| `doom` engine (renderer / game loop) | GPLv2                         | © 1993–1996 id Software, Inc.                        |
| `doom` engine (modernizations)       | GPLv2                         | © 2005–2014 Simon Howard (Chocolate Doom)            |
| `doomgeneric` platform abstraction   | GPLv2 (matches engine)        | © Wojciech Graj / ozkl                               |
| `doomgeneric_patchtogether.c` shim   | GPLv2 (matches engine)        | © 2026 patchtogether.live contributors               |

Full license text: see `LICENSE` in this directory (verbatim copy of the
GPL v2 from upstream doomgeneric).

## Why is this compatible with patchtogether.live's AGPL-3.0 main codebase?

The doomgeneric source compiles to a WebAssembly blob (`doom.wasm`) that
ships as a separate asset alongside the AGPL-3.0 web app. The web app
loads the WASM dynamically via `fetch()` + an ES-module shim
(`packages/web/static/doom/doom.js`) — there is no static linking, no
shared address space, no derived combined work. This is **aggregation**
in the FSF sense (cf. <https://www.gnu.org/licenses/gpl-faq.html#MereAggregation>):
two licensed works distributed together but independently usable. The
AGPL-3.0 web app is freely substitutable; the GPLv2 DOOM blob is freely
substitutable.

The DOOM module's TypeScript shim (`packages/web/src/lib/doom/`) and
Svelte card (`packages/web/src/lib/ui/modules/DoomCard.svelte`) talk to
the GPLv2 WASM only over the well-defined `dgpt_*` C-export interface
documented in `doomgeneric/doomgeneric_patchtogether.c`. They contain no
DOOM source code and remain under the project's AGPL-3.0.

## What we vendor vs. what we don't

We vendor:
- The doomgeneric core game-engine sources (~85 `.c` files + headers).
- The verbatim GPL v2 LICENSE file.
- The upstream README for attribution.
- Our own platform shim (`doomgeneric_patchtogether.c`).

We **do not** vendor:
- Upstream platform shims for SDL2 / Allegro / Win32 / Xlib /
  emscripten/SDL — these pull in heavy runtime dependencies and the
  emscripten one in particular assumes browser-owned input + audio
  that we route through the patchtogether engine instead.
- IDE project files (`.sln`, `.vcxproj`, `.vcxproj.filters`).
- Per-platform Makefiles (we have our own `build-doom-wasm.sh`).

## The WAD

`DOOM1.WAD` (the shareware-episode game data) is **not** committed to
this repo. The build system fetches it at runtime per-user from
`/doom/DOOM1.WAD` (the user's browser caches it on first spawn). See
`packages/web/static/doom/DOWNLOAD_INSTRUCTIONS.md`. The shareware WAD
is freely redistributable under the terms documented at
<https://doomwiki.org/wiki/Shareware> and id Software's original
shareware license.
