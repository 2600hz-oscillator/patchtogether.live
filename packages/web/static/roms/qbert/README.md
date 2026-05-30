# Q*Bert (Gottlieb 1982) — ROM download instructions

The QBERT module ships **without** the arcade ROMs in the repo. Like DOOM's
`DOOM1.WAD`, the ROM data is non-free + non-redistributable game content;
contributors drop their own copy locally and the cloud deploys gracefully
render a "ROM missing" prompt when the file is absent.

## For developers — place `qbert.zip` here

Run the setup task from the repo root:

```bash
flox activate -- task setup:qbert ROM=/path/to/qbert.zip
```

That copies `qbert.zip` into this directory. The zip is `.gitignore`d
(binary ROMs don't belong in git) so a stray commit can't land it.

At runtime the QBERT module fetches `/roms/qbert/qbert.zip`, extracts
it in-browser via `fflate`, and feeds the constituent ROM files
(`qb-rom0.bin` ... `qb-snd1.bin` per MAME's `gottlieb.cpp` `qbert` set)
into the Z80 emulator. If the fetch 404s OR if the zip extraction fails,
the card renders **"ROM missing — run `task setup:qbert`"** with no
crashes and no audio output.

## Where do I get qbert.zip?

This is not distributed by us. The MAME `qbert` set is the canonical
filename convention the loader expects. See:

- The MAME `qbert` driver: `src/mame/drivers/gottlieb.cpp`
- The ROM-set definitions: `src/mame/gottlieb.cpp` (ROM_START(qbert) /
  ROM_LOAD entries) — these document the expected filenames + addresses.

If your zip is from a different MAME set (e.g. `qbertqub`, `qberta`) the
loader still attempts to match the standard filenames. You'll see a
"ROM missing" card if the filename list doesn't include the main code
ROMs (`qb-rom0.bin`...`qb-rom2.bin`).

## Why is this gitignored instead of committed?

Q*Bert ROMs are not freely redistributable. We ship the **emulator
engine + plumbing** in the open repo; users provide their own legally-
sourced ROM. This mirrors what every MAME front-end ships.

## License attribution

Q*Bert hardware emulation references the MAME source
(`src/mame/drivers/gottlieb.cpp`, GPL-2.0+ which is AGPL-compatible).
See the header comment in `packages/web/src/lib/qbert/qbert-runtime.ts`
for the canonical cite + commit pointer.
