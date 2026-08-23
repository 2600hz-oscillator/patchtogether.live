<!-- GENERATED FILE — DO NOT EDIT.
     Regenerate: `flox activate -- task face:inventory:accept`, then review the diff.
     Source: packages/web/src/lib/ui/workflow/face-migration-inventory.ts × the live
     module registry × STRICT_FACES. Pinned by face-migration-inventory.test.ts. -->

# Face migration status (LEG-01)

Every registered module carries exactly one **disposition**: what kind of work its v2 surface needs. A module is **done** when it declares a `face` and is promoted into `STRICT_FACES` — read off the def, never recorded here.

## Where the fleet stands

|  | count |
|---|---|
| registered modules | 198 |
| done (faced + promoted) | 133 |
| remaining (excludes organizational-native) | 62 |
| registered with NO disposition (must be zero) | 0 |
| inventory entries naming a dead def (must be zero) | 0 |

## By disposition

| disposition | what it means | modules | done |
|---|---|---|---|
| `generic-face` | author a `face` and rank the controls — no new platform capability | 143 | 133 |
| `blocked` | would be a face today but for the named capability, and nothing else | 1 | — |
| `bespoke-surface` | the primary interaction is not param-shaped — needs a purpose-built surface | 51 | — |
| `organizational-native` | rack furniture; not a migration at all | 3 | — |

## What each blocker buys

| blocker | issue | modules waiting |
|---|---|---|
| `needs-media-controller` | #1511 | 10 |
| `needs-note-entry-cell` | #1509 | 17 |

## `generic-face`

author a `face` and rank the controls — no new platform capability.

| module | domain | state | blockers |
|---|---|---|---|
| `4plexvid` | video | done | — |
| `acidwarp` | video | done | — |
| `adsr` | audio | done | — |
| `analogLogicMaths` | audio | done | — |
| `analogVco` | audio | done | — |
| `attenumix` | audio | done | — |
| `b3ntb0x` | video | done | — |
| `backdraft` | video | done | — |
| `bentbox` | video | done | — |
| `bluebox` | audio | done | — |
| `buggles` | audio | done | — |
| `cellshade` | video | done | — |
| `charlottesEchos` | audio | done | — |
| `chroma` | video | done | — |
| `chromakey` | video | done | — |
| `clap` | audio | done | — |
| `clouds` | audio | done | — |
| `cloudseed` | audio | done | — |
| `cofefve` | audio | done | — |
| `colorizer` | video | done | — |
| `colourofmagic` | video | done | — |
| `cube` | audio | done | — |
| `cvBuddy` | audio | done | — |
| `cvBuddyMini` | audio | done | — |
| `delay` | audio | done | — |
| `depolarizer` | audio | done | — |
| `destroy` | audio | done | — |
| `destructor` | video | done | — |
| `dockscope` | audio | done | — |
| `drummergirl` | audio | done | — |
| `dx7` | audio | done | — |
| `edges` | video | done | — |
| `fader` | video | done | — |
| `featurecv` | audio | done | — |
| `feedback` | video | done | — |
| `filter` | audio | done | — |
| `flipper` | audio | done | — |
| `fourplexer` | audio | done | — |
| `foxy` | audio | done | — |
| `frametable` | video | done | — |
| `freezeframe` | video | done | — |
| `gatemaiden` | audio | done | — |
| `grainsOfVision` | video | done | — |
| `graphicEq` | video | done | — |
| `illogic` | audio | done | — |
| `inwards` | video | done | — |
| `joystick` | audio | — | — |
| `karplus` | audio | done | — |
| `kickdrum` | audio | done | — |
| `lfo` | audio | done | — |
| `lines` | video | done | — |
| `luma` | video | done | — |
| `lumakey` | video | done | — |
| `lushgarden` | video | — | — |
| `macrooscillator` | audio | done | — |
| `mandelbulb` | video | done | — |
| `mandleblot` | video | done | — |
| `mapper` | video | done | — |
| `marbles` | audio | done | — |
| `meowbox` | audio | done | — |
| `milkdrop` | video | done | — |
| `mirrorpool` | video | done | — |
| `mixer` | audio | done | — |
| `mixmstrs` | audio | done | — |
| `monoglitch` | video | done | — |
| `moog902` | audio | done | — |
| `moog903a` | audio | done | — |
| `moog904a` | audio | done | — |
| `moog904b` | audio | done | — |
| `moog904c` | audio | done | — |
| `moog905` | audio | done | — |
| `moog907a` | audio | done | — |
| `moog911` | audio | done | — |
| `moog911a` | audio | done | — |
| `moog912` | audio | done | — |
| `moog914` | audio | done | — |
| `moog921a` | audio | done | — |
| `moog921b` | audio | done | — |
| `moog921Vco` | audio | done | — |
| `moog923` | audio | done | — |
| `moog960` | audio | — | — |
| `moog961` | audio | done | — |
| `moog962` | audio | done | — |
| `moog984` | audio | done | — |
| `moog992` | audio | done | — |
| `moog993` | audio | done | — |
| `moog994` | audio | done | — |
| `moog995` | audio | done | — |
| `moogCp3` | audio | done | — |
| `ninelives` | audio | done | — |
| `noise` | audio | done | — |
| `onetonine` | video | done | — |
| `outlines` | video | done | — |
| `peakstate` | video | done | — |
| `pentemelodica` | audio | done | — |
| `polarizer` | audio | done | — |
| `posterbox` | video | done | — |
| `qbrt` | audio | done | — |
| `quadralogical` | video | done | — |
| `rasterize` | audio | done | — |
| `reshaper` | video | done | — |
| `resofilter` | audio | done | — |
| `reverb` | audio | done | — |
| `ringback` | audio | done | — |
| `rings` | audio | done | — |
| `ruttetra` | video | done | — |
| `sampleHold` | audio | done | — |
| `samsloop` | audio | — | — |
| `scaler` | audio | done | — |
| `scope` | audio | — | — |
| `scoreboard` | video | done | — |
| `shapedramps` | video | done | — |
| `shapegen` | video | done | — |
| `shapes` | video | done | — |
| `shimmershine` | audio | done | — |
| `sidecar` | audio | done | — |
| `sixstrum` | audio | done | — |
| `slewSwitch` | audio | done | — |
| `snaredrum` | audio | done | — |
| `sourcery` | video | done | — |
| `spectrograph` | audio | done | — |
| `spirographs` | video | done | — |
| `stereovca` | audio | done | — |
| `swolevco` | audio | done | — |
| `synesthesia` | audio | — | — |
| `tempest` | video | done | — |
| `tidyVco` | audio | done | — |
| `tiler` | video | done | — |
| `timelorde` | audio | — | — |
| `tomtom` | audio | done | — |
| `treeohvox` | audio | done | — |
| `unityscalemathematik` | audio | done | — |
| `vca` | audio | done | — |
| `vdelay` | video | done | — |
| `vfpgaRunner` | video | — | — |
| `videocube` | video | — | — |
| `videoMixer` | video | done | — |
| `videoOut` | video | done | — |
| `warrensspectrum` | audio | done | — |
| `warrensvisions` | video | done | — |
| `wavecel` | audio | done | — |
| `wavesculpt` | audio | — | — |
| `wavetableVco` | audio | done | — |

## `blocked`

would be a face today but for the named capability, and nothing else.

| module | domain | state | blockers |
|---|---|---|---|
| `loopback` | video | — | `needs-media-controller` |

## `bespoke-surface`

the primary interaction is not param-shaped — needs a purpose-built surface.

| module | domain | state | blockers |
|---|---|---|---|
| `archivist` | video | — | `needs-media-controller` `needs-note-entry-cell` |
| `audioIn` | audio | — | `needs-media-controller` |
| `audioOut` | audio | — | — |
| `blood` | video | — | — |
| `cameraInput` | video | — | `needs-media-controller` |
| `cartesian` | audio | — | `needs-note-entry-cell` |
| `chromaconsole` | audio | — | — |
| `clipplayer` | audio | — | — |
| `clockedRunner` | audio | — | — |
| `controlSurface` | meta | — | `needs-note-entry-cell` |
| `doom` | video | — | — |
| `drumseqz` | audio | — | `needs-note-entry-cell` |
| `electraControl` | meta | — | `needs-note-entry-cell` |
| `es9` | audio | — | — |
| `frogger` | audio | — | — |
| `gamepad` | audio | — | — |
| `gibribbon` | video | — | — |
| `kria` | audio | — | — |
| `launchpadControlLeft` | meta | — | — |
| `livecode` | audio | — | — |
| `macseq` | audio | — | `needs-note-entry-cell` |
| `mappy` | video | — | — |
| `matrixMix` | meta | — | — |
| `midiclock` | audio | — | — |
| `midiCvBuddy` | audio | — | — |
| `midiLane` | audio | — | `needs-note-entry-cell` |
| `midiOutBuddy` | audio | — | — |
| `modtris` | audio | — | — |
| `moog956` | audio | — | — |
| `nibbles` | video | — | — |
| `numpadPlus` | audio | — | — |
| `outToLaunch` | video | — | — |
| `painter` | video | — | `needs-note-entry-cell` |
| `peertube` | video | — | `needs-media-controller` `needs-note-entry-cell` |
| `picturebox` | video | — | — |
| `polyseqz` | audio | — | `needs-note-entry-cell` |
| `pong` | audio | — | — |
| `push2Control` | meta | — | — |
| `recorderbox` | video | — | `needs-media-controller` `needs-note-entry-cell` |
| `score` | audio | — | — |
| `sequencer` | audio | — | `needs-note-entry-cell` |
| `skifree` | audio | — | — |
| `textmarquee` | video | — | `needs-note-entry-cell` |
| `toybox` | video | — | `needs-media-controller` `needs-note-entry-cell` |
| `tvLibrarian` | video | — | `needs-media-controller` |
| `twotracks` | audio | — | — |
| `videobox` | video | — | `needs-media-controller` |
| `videovarispeed` | video | — | `needs-media-controller` |
| `vstFx` | audio | — | `needs-note-entry-cell` |
| `vstInstrument` | audio | — | `needs-note-entry-cell` |
| `writeseq` | audio | — | `needs-note-entry-cell` |

## `organizational-native`

rack furniture; not a migration at all.

| module | domain | state | blockers |
|---|---|---|---|
| `cadillac` | meta | — | — |
| `group` | meta | — | — |
| `sticky` | meta | — | — |
