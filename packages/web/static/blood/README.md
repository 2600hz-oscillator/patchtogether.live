# Blood game data — bundled shareware + optional full-game override

The BLOOD module **boots out-of-box**: this directory ships the **1997 Blood
SHAREWARE** data set ("The Way of All Flesh", episode 1), so the card renders
without any picker on the beta-gated deploys. The full game stays a user-supplied
*override* (its data is not redistributable).

> The owner explicitly authorised shipping the shareware here; everything in this
> repo is beta-gated / pre-public / non-commercial. License implications are the
> owner's call (see "Legal status" below).

## What's bundled (the committed shareware set)

Committed under `packages/web/static/blood/` (un-ignored in `.gitignore`,
LFS-tracked via `.gitattributes`):

```
BLOOD.RFF      # shareware main resource (~3.2 MB; the FULL game's is ~10 MB+)
GUI.RFF        # UI resources
SOUNDS.RFF     # sound resources
SURFACE.DAT    # surface/material table
TABLES.DAT     # engine lookup tables
VOXEL.DAT      # voxel table
SHARE000.ART   # SHAREWARE tile art (the full game ships TILES000.ART instead)
```

Plus the built engine artifacts `blood.js` + `blood.wasm` (deterministic from the
pinned NBlood commit — see `build-blood-wasm.sh`; carry no game IP).

The `SHARE000.ART` filename (vs the full game's `TILES000.ART`) and the small
`BLOOD.RFF` are the shareware giveaways. The shareware `BLOOD.RFF` contains 8
single-player maps (E1M1–E1M8) and **no dedicated BloodBath/deathmatch maps**
(shareware BloodBath reuses the episode maps).

### Source

Extracted from the official 1997 retail-shareware CD image
("BLOOD: Spill Some! — Retail Shareware"),
<https://archive.org/details/blood-31197> (`BLOOD31197.iso`), unpacked from the
InstallShield 3 `DATA.Z` archive on the disc. All extracted file sizes match the
archive's table-of-contents exactly.

## Full-game override (optional)

To play **all episodes**, supply data from a copy of the full game you own:

```bash
flox activate -- task setup:blood BLOOD_ASSETS=/path/to/your/blood/install
```

…or use the **"Load full Blood data…"** picker on the card (it caches your files
in IndexedDB so you only pick once). The full game is sold today as **One Unit
Whole Blood** and **Blood: Fresh Supply** (GOG / Steam). Full-game data is
`.gitignore`d — only the specific shareware files above are un-ignored.

## Legal status

- **IP owner:** Warner Bros. Games (via Monolith Productions). GT Interactive
  (later Infogrames → Atari) held only publishing rights.
  <https://en.wikipedia.org/wiki/Blood_(video_game)>
- The 1997 Blood shareware ("The Way of All Flesh") circulates widely as
  abandonware. Unlike id's DOOM shareware, it has no explicit free-redistribution
  grant; shipping it here is a deliberate owner decision for this beta-gated,
  non-commercial preview — **not** a claim that it is freely redistributable.
- The **full game's** data is never shipped or auto-fetched — it is the
  user-supplied override only.
- The **engine** (NBlood, GPL-2.0 + the Build engine under Ken Silverman's
  BUILDLIC) ships as the separate WASM blob; see
  `packages/web/native/nblood/PHASE0-STATUS.md` for the licensing analysis. We
  never vendor or reference the leaked 1996 Blood source.
