<!-- GENERATED FILE — DO NOT EDIT.
     Regenerate: `flox activate -- task face:inventory:accept`, then review the diff.
     Source: packages/web/src/lib/ui/workflow/face-migration-inventory.ts × the live
     module registry × STRICT_FACES. Pinned by face-migration-inventory.test.ts. -->

# Face migration status (LEG-01)

Every registered module carries exactly one **disposition**: what kind of work its v2 surface needs. A module is **done** when it declares a `face` and is promoted into `STRICT_FACES` — read off the def, never recorded here.

## Where the fleet stands

|  | count |
|---|---|
| registered modules | 196 |
| done (faced + promoted) | 52 |
| remaining (excludes organizational-native) | 141 |
| registered with NO disposition (must be zero) | 0 |
| inventory entries naming a dead def (must be zero) | 0 |

## By disposition

| disposition | what it means | modules | done |
|---|---|---|---|
| `generic-face` | author a `face` and rank the controls — no new platform capability | 141 | 52 |
| `blocked` | would be a face today but for the named capability, and nothing else | 3 | — |
| `bespoke-surface` | the primary interaction is not param-shaped — needs a purpose-built surface | 49 | — |
| `organizational-native` | rack furniture; not a migration at all | 3 | — |

## What each blocker buys

| blocker | issue | modules waiting |
|---|---|---|
| `needs-media-controller` | #1511 | 12 |
| `needs-note-entry-cell` | #1509 | 15 |

## `generic-face`

author a `face` and rank the controls — no new platform capability.

| module | domain | state | blockers |
|---|---|---|---|
| `4plexvid` | video | — | — |
| `acidwarp` | video | — | — |
| `adsr` | audio | done | — |
| `analogLogicMaths` | audio | done | — |
| `analogVco` | audio | done | — |
| `attenumix` | audio | done | — |
| `b3ntb0x` | video | — | — |
| `backdraft` | video | done | — |
| `bentbox` | video | — | — |
| `bluebox` | audio | done | — |
| `buggles` | audio | done | — |
| `cellshade` | video | — | — |
| `charlottesEchos` | audio | done | — |
| `chroma` | video | — | — |
| `chromakey` | video | — | — |
| `clap` | audio | done | — |
| `clouds` | audio | done | — |
| `cloudseed` | audio | done | — |
| `cofefve` | audio | done | — |
| `colorizer` | video | — | — |
| `colourofmagic` | video | — | — |
| `cube` | audio | done | — |
| `cvBuddy` | audio | — | — |
| `cvBuddyMini` | audio | — | — |
| `delay` | audio | done | — |
| `depolarizer` | audio | — | — |
| `destroy` | audio | done | — |
| `destructor` | video | — | — |
| `dockscope` | audio | — | — |
| `drummergirl` | audio | done | — |
| `dx7` | audio | done | — |
| `edges` | video | — | — |
| `fader` | video | — | — |
| `featurecv` | audio | done | — |
| `feedback` | video | — | — |
| `filter` | audio | done | — |
| `flipper` | audio | — | — |
| `fourplexer` | audio | — | — |
| `foxy` | audio | — | — |
| `freezeframe` | video | — | — |
| `gatemaiden` | audio | — | — |
| `grainsOfVision` | video | — | — |
| `graphicEq` | video | — | — |
| `illogic` | audio | done | — |
| `inwards` | video | — | — |
| `joystick` | audio | — | — |
| `karplus` | audio | done | — |
| `kickdrum` | audio | done | — |
| `lfo` | audio | done | — |
| `lines` | video | — | — |
| `luma` | video | — | — |
| `lumakey` | video | — | — |
| `lushgarden` | video | — | — |
| `macrooscillator` | audio | done | — |
| `mandelbulb` | video | — | — |
| `mandleblot` | video | — | — |
| `mapper` | video | — | — |
| `marbles` | audio | done | — |
| `meowbox` | audio | done | — |
| `milkdrop` | video | — | — |
| `mirrorpool` | video | — | — |
| `mixer` | audio | done | — |
| `mixmstrs` | audio | done | — |
| `monoglitch` | video | — | — |
| `moog902` | audio | — | — |
| `moog903a` | audio | — | — |
| `moog904a` | audio | — | — |
| `moog904b` | audio | — | — |
| `moog904c` | audio | — | — |
| `moog905` | audio | — | — |
| `moog907a` | audio | done | — |
| `moog911` | audio | — | — |
| `moog911a` | audio | — | — |
| `moog912` | audio | — | — |
| `moog914` | audio | done | — |
| `moog921a` | audio | done | — |
| `moog921b` | audio | done | — |
| `moog921Vco` | audio | — | — |
| `moog923` | audio | — | — |
| `moog960` | audio | — | — |
| `moog961` | audio | — | — |
| `moog962` | audio | — | — |
| `moog984` | audio | — | — |
| `moog992` | audio | — | — |
| `moog993` | audio | — | — |
| `moog994` | audio | — | — |
| `moog995` | audio | — | — |
| `moogCp3` | audio | — | — |
| `ninelives` | audio | done | — |
| `noise` | audio | done | — |
| `onetonine` | video | — | — |
| `outlines` | video | — | — |
| `peakstate` | video | — | — |
| `pentemelodica` | audio | done | — |
| `polarizer` | audio | — | — |
| `posterbox` | video | — | — |
| `qbrt` | audio | done | — |
| `quadralogical` | video | — | — |
| `rasterize` | audio | — | — |
| `reshaper` | video | — | — |
| `resofilter` | audio | done | — |
| `reverb` | audio | done | — |
| `ringback` | audio | done | — |
| `rings` | audio | done | — |
| `ruttetra` | video | — | — |
| `sampleHold` | audio | — | — |
| `samsloop` | audio | — | — |
| `scaler` | audio | — | — |
| `scope` | audio | — | — |
| `scoreboard` | video | — | — |
| `shapedramps` | video | — | — |
| `shapegen` | video | — | — |
| `shapes` | video | — | — |
| `shimmershine` | audio | done | — |
| `sidecar` | audio | done | — |
| `sixstrum` | audio | done | — |
| `slewSwitch` | audio | done | — |
| `snaredrum` | audio | done | — |
| `sourcery` | video | — | — |
| `spectrograph` | audio | — | — |
| `spirographs` | video | — | — |
| `stereovca` | audio | — | — |
| `swolevco` | audio | — | — |
| `synesthesia` | audio | — | — |
| `tempest` | video | — | — |
| `tidyVco` | audio | done | — |
| `tiler` | video | — | — |
| `timelorde` | audio | — | — |
| `tomtom` | audio | done | — |
| `treeohvox` | audio | — | — |
| `unityscalemathematik` | audio | done | — |
| `vca` | audio | done | — |
| `vdelay` | video | — | — |
| `vfpgaRunner` | video | — | — |
| `videoMixer` | video | — | — |
| `videoOut` | video | done | — |
| `warrensspectrum` | audio | done | — |
| `warrensvisions` | video | — | — |
| `wavecel` | audio | — | — |
| `wavesculpt` | audio | — | — |
| `wavetableVco` | audio | done | — |

## `blocked`

would be a face today but for the named capability, and nothing else.

| module | domain | state | blockers |
|---|---|---|---|
| `frametable` | video | — | `needs-media-controller` |
| `loopback` | video | — | `needs-media-controller` |
| `videocube` | video | — | `needs-media-controller` |

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
| `writeseq` | audio | — | `needs-note-entry-cell` |

## `organizational-native`

rack furniture; not a migration at all.

| module | domain | state | blockers |
|---|---|---|---|
| `cadillac` | meta | — | — |
| `group` | meta | — | — |
| `sticky` | meta | — | — |
