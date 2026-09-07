# Modules with no faceplate — measured 2026-08-18

`189` module defs. `51` have a face. **`138` do not.**

## How this was derived (re-run it, do not trust this list's age)

Authoring a `face` on a def IS the promotion — `strict-faces.ts` says so, and
`module-face-lint.test.ts` asserts STRICT_FACES **equal** to the set of defs
declaring a `face`, in both directions. So "unfaced" is not a curated list
anywhere; it is the complement of that set and has to be computed.

Method: parse the `STRICT_FACES` Set out of
`packages/web/src/lib/ui/workflow/strict-faces.ts` (stripping comments first —
the file is mostly prose and the batch notes quote module names), collect every
`type:` declared in `lib/{audio,video}/modules/*.ts`, and subtract.

Instrument checks that were run, because a scan like this fails silently:
- Every STRICT_FACES entry resolves to a real def — **0 stale entries**.
- Files that look like defs (`ModuleDef` / `defineModule` / `export const *Def`)
  but yielded no `type:` — **3**, all benign: two barrel `index.ts` and
  `moog-filterbank-factory.ts`, which is a DSP helper (`buildFilterBank`); its
  `type:` is a `BiquadFilterType`, not a module type. No module is minted by a
  factory, so nothing is hidden from the scan.
- Remaining files with no def signal at all — **77**, helpers/models
  (`clip-*.ts`, `analog-vco-scope.ts`, …), correctly excluded.


## ⚠ Two entries on the video list are not free to pick up

- **`doom`** — standing owner ruling: *"do not fuck with doom in any way without
  specific approval"*, and that covers the module, its specs, its waits and its
  timing. `video/modules/doom.ts` calls `runtime.runTic()` inside `surface.draw`,
  so **DOOM's game clock IS the frame clock** — one rendered frame is one game
  tic. A faceplate is not obviously a timing change, but it re-hosts the surface
  that drives that loop. **Do not start a DOOM face without asking.**
- **`videoOut`** — in flight right now (#1821), including a right-click detach
  overlay and bridge-on-delete. Do not double-assign it.

## The number that actually matters here

**`backdraft` is the ONLY faced video module.** The face programme is 50/51 audio;
video is one module in. Every video priority on the board — the videoOut face
(#1821), lane thumbnails for promoted video modules (#1785), the drop-to-patch
gesture's per-module coverage (#1819) — lands on a surface that has essentially
no faces yet. That is a sequencing fact worth knowing before planning the next
wave, not a defect.

## Unfaced — video (`68`)

`4plexvid` `acidwarp` `archivist` `b3ntb0x` `bentbox` `blood` `cameraInput` `cellshade` `chroma` `chromakey` `colorizer` `colourofmagic` `destructor` `doom` `edges` `fader` `feedback` `frametable` `freezeframe` `gibribbon` `grainsOfVision` `graphicEq` `hit` `inwards` `lines` `loopback` `luma` `lumakey` `lushgarden` `mandelbulb` `mandleblot` `mapper` `mappy` `milkdrop` `mirrorpool` `monoglitch` `nibbles` `onetonine` `outlines` `outToLaunch` `painter` `peakstate` `peertube` `picturebox` `posterbox` `quadralogical` `recorderbox` `reshaper` `ruttetra` `scoreboard` `shapedramps` `shapegen` `shapes` `sourcery` `spirographs` `tempest` `textmarquee` `tiler` `toybox` `tvLibrarian` `vdelay` `vfpgaRunner` `videobox` `videocube` `videoMixer` `videoOut` `videovarispeed` `warrensvisions`


## Unfaced — audio (`70`)

`audioIn` `audioOut` `cartesian` `chromaconsole` `clipplayer` `clockedRunner` `cvBuddy` `cvBuddyMini` `depolarizer` `dockscope` `drumseqz` `es9` `flipper` `foxy` `frogger` `gamepad` `gatemaiden` `joystick` `kria` `livecode` `macseq` `midiclock` `midiCvBuddy` `midiLane` `midiOutBuddy` `modtris` `moog902` `moog903a` `moog904a` `moog904b` `moog904c` `moog905` `moog911` `moog911a` `moog912` `moog921Vco` `moog923` `moog956` `moog960` `moog961` `moog962` `moog984` `moog992` `moog993` `moog994` `moog995` `moogCp3` `numpadPlus` `polarizer` `polyseqz` `pong` `rasterize` `sampleHold` `samsloop` `scaler` `scope` `score` `sel` `sequencer` `skifree` `spectrograph` `stereovca` `swolevco` `synesthesia` `timelorde` `treeohvox` `twotracks` `wavecel` `wavesculpt` `writeseq`


## Already faced, for contrast (`51`)

**video (1)** `backdraft`


**audio (50)** `adsr` `analogLogicMaths` `analogVco` `attenumix` `bluebox` `buggles` `charlottesEchos` `clap` `clouds` `cloudseed` `cofefve` `cube` `delay` `destroy` `drummergirl` `dx7` `featurecv` `filter` `illogic` `karplus` `kickdrum` `lfo` `macrooscillator` `marbles` `meowbox` `mixer` `mixmstrs` `moog907a` `moog914` `moog921a` `moog921b` `ninelives` `noise` `pentemelodica` `qbrt` `resofilter` `reverb` `ringback` `rings` `shimmershine` `sidecar` `sixstrum` `slewSwitch` `snaredrum` `tidyVco` `tomtom` `unityscalemathematik` `vca` `warrensspectrum` `wavetableVco`
