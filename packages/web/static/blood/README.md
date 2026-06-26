# Blood game data — user-provided asset instructions

The (planned) BLOOD module ships **without** any Blood game data in the repo.
Unlike DOOM — whose shareware `DOOM1.WAD` id Software **explicitly licensed
for free redistribution**, so we can fetch it on demand — **Blood's data is
proprietary and is NOT freely redistributable** (see "Legal status" below).
You must supply your own files from a copy of the game you own.

This mirrors the QBERT / SNES9X "user-provided ROM" pattern, not the DOOM
"we fetch the shareware WAD for you" pattern.

## Required files

Drop the data files from your **One Unit Whole Blood** / **Blood: Fresh
Supply** (the GOG/Steam release bundles the original DOS data) install into
this directory:

```
packages/web/static/blood/
  BLOOD.RFF      # main resource file (sounds, sequences, palettes, ...)
  TILES000.ART   # art tiles 0 (… TILES001.ART, TILES002.ART, … as present)
  GUI.RFF        # UI resource file
  SOUNDS.RFF     # sound resource file
  *.MAP          # the episode maps (E1M1.MAP … shipped inside BLOOD.RFF on
                 #   some releases; standalone .MAP on others)
  *.DAT          # any sequence / definition DATs the release ships
```

> The exact file set varies by release (1.21 full vs One Unit Whole Blood vs
> Fresh Supply's bundled DOS data). The module's loader (Phase 1) will report
> precisely which files it could not find. NBlood's own documentation
> (the upstream README + the `*.GRP`/`*.RFF` notes) is the canonical list of
> what a given Blood release provides; match that.

## Install via the setup task (recommended)

From the repo root:

```bash
flox activate -- task setup:blood BLOOD_ASSETS=/path/to/your/blood/install
```

That validates the directory contains at least `BLOOD.RFF` and copies the
recognised data files here. The files are **`.gitignore`d** (only this
`README.md` is tracked) so a stray `git add` can't commit copyrighted data.

## SHA-1 checksums (for validation)

Checksums depend on the exact release you own; the most common references are:

| File         | Release                      | SHA-1                                      |
| ------------ | ---------------------------- | ------------------------------------------ |
| `BLOOD.RFF`  | One Unit Whole Blood (v1.21) | _TODO: pin once the Phase-1 loader exists_ |
| `BLOOD.RFF`  | Fresh Supply (DOS data)      | _TODO_                                     |

> These are intentionally left as TODO for the Phase-0 spike — pinning them
> requires a legally-owned copy to hash, and the loader that validates them
> doesn't exist yet. Phase 1 fills them in (the same way DOOM's
> `DOWNLOAD_INSTRUCTIONS.md` pins `DOOM1.WAD`'s SHA-1).

## Where to buy

Blood is sold today as **One Unit Whole Blood** and **Blood: Fresh Supply**:

- GOG: <https://www.gog.com/en/game/blood_fresh_supply> (Fresh Supply
  includes the original DOS *One Unit Whole Blood* as a bonus).
- Steam: *Blood: Fresh Supply* (the original DOS *One Unit Whole Blood* was
  re-listed on Steam in 2023).

## Legal status — why we do NOT ship or auto-fetch Blood data

- **IP owner:** Warner Bros. Games (via its Monolith Productions subsidiary)
  owns the Blood trademark and intellectual property. GT Interactive (later
  Infogrames → Atari) only ever held *publishing* rights, not the IP.
  <https://en.wikipedia.org/wiki/Blood_(video_game)>
- **No free-redistribution grant for the data:** id Software's DOOM shareware
  license *explicitly* permits free redistribution of `DOOM1.WAD` — which is
  why this repo can fetch it for you. **No equivalent affirmative grant
  exists for Blood's shareware or full data.** The Blood shareware episode
  ("The Way of All Flesh", `SHARE000.ART`) circulates on Archive.org / ModDB
  in a legally-gray "abandonware" status, and period shareware license files
  commonly *restricted* third-party redistribution (e.g. no CD-compilation
  inclusion without permission). We treat it as **not redistributable by us**.
- **Therefore:** the project never ships Blood data, never pre-fetches it from
  any CDN, and CI never downloads it. The BLOOD module renders a graceful
  "Blood data missing — run `task setup:blood`" card when the files are
  absent (same as QBERT / SNES9X).
- The **engine** (NBlood, reverse-engineered, GPL-2.0 + the Build engine
  under Ken Silverman's BUILDLIC) is shipped/loaded as a separate WASM blob;
  see `packages/web/native/nblood/PHASE0-STATUS.md` for the licensing analysis.
  We **never** vendor or reference the leaked 1996 Blood source.
