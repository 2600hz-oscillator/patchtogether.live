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
- Our own portable PCM mixer (`i_pcmgen.c`) — replaces SDL_mixer-coupled
  upstream `i_sdlsound.c`; same `sound_module_t` interface. GPLv2.
- The **networking implementation** `net_*.c` — see the dedicated
  section below.

We **do not** vendor:
- Upstream platform shims for SDL2 / Allegro / Win32 / Xlib /
  emscripten/SDL — these pull in heavy runtime dependencies and the
  emscripten one in particular assumes browser-owned input + audio
  that we route through the patchtogether engine instead.
- IDE project files (`.sln`, `.vcxproj`, `.vcxproj.filters`).
- Per-platform Makefiles (we have our own `build-doom-wasm.sh`).

## Networking sources (`net_*.c`) — chocolate-doom provenance

doomgeneric upstream ships only the networking *headers* (`net_*.h`),
not the matching `.c` implementations (it deliberately excludes
multiplayer). To build true 4-player netplay we vendor the missing `.c`
files directly from **Chocolate Doom**, the same project doomgeneric
forked its engine from.

**Source: chocolate-doom tag `chocolate-doom-2.1.0`, commit
`d61a8018fd43137342a587b6e05a487e8c3a566b`**
(<https://github.com/chocolate-doom/chocolate-doom>, `src/net_*.c`).

We pinned 2.1.0 (not the latest 2.3.0) because doomgeneric's vendored
`d_loop.c` / `d_net.c` were forked from chocolate-doom's 2.1.0
generation: our `d_loop.c` differs from cd-2.1.0 by only the
doomgeneric `#if ORIGCODE` single-player patches (17 lines), but from
cd-2.3.0 by 126 lines (2.3.0 added `MAX_NETGAME_STALL_TICS` and the
`D_NonVanilla*` demo API that doomgeneric never picked up). The net
protocol headers (`net_defs.h` etc.) are byte-identical across
cd-2.1.0…2.3.0, and byte-identical to doomgeneric's vendored copies, so
the 2.1.0 `.c` are the faithful match for the headers + `d_loop.c`/`d_net.c`
already present here.

Vendored verbatim from cd-2.1.0 (each keeps its GPLv2 header):
- `net_client.c`, `net_server.c`, `net_io.c`, `net_packet.c`,
  `net_query.c`, `net_structrw.c`, `net_loop.c`, `net_common.c`
- Plus the two headers doomgeneric was missing that these `.c` need:
  `net_structrw.h`, `net_common.h`, and `aes_prng.h` (the latter only
  supplies the `prng_seed_t` typedef used by `net_structrw.h`; no
  `PRNG_*` function is called by any vendored `.c`, so `aes_prng.c` is
  NOT vendored).

We **do not** vendor (each pulls in deps we don't ship):
- `net_sdl.c` — SDL_net UDP transport. Our own transport (`net_pt.c`)
  arrives in a later slice; until then the only reference to its
  `net_sdl_module` symbol (from `net_query.c`'s unused master-server
  browser) is satisfied by a no-op stub (see below).
- `net_dedicated.c` — headless dedicated-server `main()`; not used.
- `net_gui.c` — textscreen/curses lobby UI. Its one referenced symbol
  (`NET_WaitForLaunch`, called from `d_loop.c`) is stubbed (see below).
- `net_petname.c` — random player-name generator; not referenced.

### Dependency stubs (`net_pt_stub.c`)

`net_pt_stub.c` is **our** code (GPLv2, patchtogether copyright), not
vendored. It exists solely so the vendored `net_*.c` + doomgeneric's
`d_loop.c` link in the multiplayer build without dragging in SDL2 or
the curses textscreen lib. It provides exactly two no-op placeholders:
- `net_sdl_module` — an inert `net_module_t` (InitClient/InitServer
  return false, RecvPacket returns "no packet", etc.). Referenced only
  by `net_query.c`'s master-server browser, which patchtogether.live
  does not use (peer discovery is via Yjs awareness).
- `NET_WaitForLaunch()` — empty; the DoomCard UI owns the lobby.

The vendored `net_*.c` themselves are **unmodified**.

### Build gating — `DOOM_MP=1` / `FEATURE_MULTIPLAYER`

The net sources are compiled **only** when `build-doom-wasm.sh` is run
with `DOOM_MP=1`, which also defines `-DFEATURE_MULTIPLAYER`. The
default (prod) build compiles none of them and is byte-for-byte the
existing single-player WASM (verified by sha256 of `doom.{wasm,js}`).
`dummy.c`'s `net_client_connected` / `drone` single-player stubs are
guarded with `#ifndef FEATURE_MULTIPLAYER` so the multiplayer build
takes the real definitions from `net_client.c` without a
duplicate-symbol link error.

## Vendor patches (divergence from upstream doomgeneric)

The vendored `.c` files are mostly verbatim from upstream. Surgical
patches applied to keep the WASM build small + portable:

- `i_sound.c`: commented out the `#include <SDL_mixer.h>` (legacy
  carry-over from chocolate-doom; unused within the translation unit
  itself, and including it would force a hard SDL build dependency
  even though no `Mix_*` symbol is called from this file). Behaviour
  is unchanged.

## The WAD

`DOOM1.WAD` (the shareware-episode game data) is **not** committed to
this repo. The build system fetches it at runtime per-user from
`/doom/DOOM1.WAD` (the user's browser caches it on first spawn). See
`packages/web/static/doom/DOWNLOAD_INSTRUCTIONS.md`. The shareware WAD
is freely redistributable under the terms documented at
<https://doomwiki.org/wiki/Shareware> and id Software's original
shareware license.
