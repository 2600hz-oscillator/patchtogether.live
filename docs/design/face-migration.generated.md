<!-- GENERATED FILE — DO NOT EDIT.
     Regenerate: `flox activate -- task face:inventory:accept`, then review the diff.
     Source: packages/web/src/lib/ui/workflow/face-migration-inventory.ts × the live
     module registry × STRICT_FACES. Pinned by face-migration-inventory.test.ts. -->

# Face migration status (LEG-01)

Every registered module carries exactly one **disposition**: what kind of work its v2 surface needs. A module is **done** when it declares a `face` and is promoted into `STRICT_FACES` — read off the def, never recorded here.

## Where the fleet stands

|  | count |
|---|---|
| registered modules | 197 |
| done (faced + promoted) | 188 |
| remaining (excludes organizational-native) | 6 |
| registered with NO disposition (must be zero) | 0 |
| inventory entries naming a dead def (must be zero) | 0 |

## By disposition

| disposition | what it means | modules | done |
|---|---|---|---|
| `generic-face` | author a `face` and rank the controls — no new platform capability | 188 | 188 |
| `blocked` | would be a face today but for the named capability, and nothing else | 0 | — |
| `bespoke-surface` | the primary interaction is not param-shaped — needs a purpose-built surface | 6 | — |
| `organizational-native` | rack furniture; not a migration at all | 3 | — |

## What each blocker buys

| blocker | issue | modules waiting |
|---|---|---|
| `needs-media-controller` | #1511 | 2 |

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
| `audioIn` | audio | done | — |
| `audioOut` | audio | done | — |
| `b3ntb0x` | video | done | — |
| `backdraft` | video | done | — |
| `bentbox` | video | done | — |
| `blood` | video | done | — |
| `bluebox` | audio | done | — |
| `buggles` | audio | done | — |
| `cameraInput` | video | done | — |
| `cartesian` | audio | done | — |
| `cellshade` | video | done | — |
| `charlottesEchos` | audio | done | — |
| `chroma` | video | done | — |
| `chromaconsole` | audio | done | — |
| `chromakey` | video | done | — |
| `clap` | audio | done | — |
| `clockedRunner` | audio | done | — |
| `clouds` | audio | done | — |
| `cloudseed` | audio | done | — |
| `cofefve` | audio | done | — |
| `colorizer` | video | done | — |
| `colourofmagic` | video | done | — |
| `controlSurface` | meta | done | — |
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
| `electraControl` | meta | done | — |
| `es9` | audio | done | — |
| `fader` | video | done | — |
| `featurecv` | audio | done | — |
| `feedback` | video | done | — |
| `filter` | audio | done | — |
| `flipper` | audio | done | — |
| `fourplexer` | audio | done | — |
| `foxy` | audio | done | — |
| `frametable` | video | done | — |
| `freezeframe` | video | done | — |
| `frogger` | audio | done | — |
| `gamepad` | audio | done | — |
| `gatemaiden` | audio | done | — |
| `gibribbon` | video | done | — |
| `grainsOfVision` | video | done | — |
| `graphicEq` | video | done | — |
| `illogic` | audio | done | — |
| `inwards` | video | done | — |
| `joystick` | audio | done | — |
| `karplus` | audio | done | — |
| `kickdrum` | audio | done | — |
| `kria` | audio | done | — |
| `launchpadControlLeft` | meta | done | — |
| `lfo` | audio | done | — |
| `lines` | video | done | — |
| `livecode` | audio | done | — |
| `loopback` | video | done | — |
| `luma` | video | done | — |
| `lumakey` | video | done | — |
| `lushgarden` | video | done | — |
| `macrooscillator` | audio | done | — |
| `mandelbulb` | video | done | — |
| `mandleblot` | video | done | — |
| `mapper` | video | done | — |
| `mappy` | video | done | — |
| `marbles` | audio | done | — |
| `matrixMix` | meta | done | — |
| `meowbox` | audio | done | — |
| `midiclock` | audio | done | — |
| `midiCvBuddy` | audio | done | — |
| `midiLane` | audio | done | — |
| `midiOutBuddy` | audio | done | — |
| `milkdrop` | video | done | — |
| `mirrorpool` | video | done | — |
| `mixer` | audio | done | — |
| `mixmstrs` | audio | done | — |
| `modtris` | audio | done | — |
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
| `moog956` | audio | done | — |
| `moog960` | audio | done | — |
| `moog961` | audio | done | — |
| `moog962` | audio | done | — |
| `moog984` | audio | done | — |
| `moog992` | audio | done | — |
| `moog993` | audio | done | — |
| `moog994` | audio | done | — |
| `moog995` | audio | done | — |
| `moogCp3` | audio | done | — |
| `nibbles` | video | done | — |
| `ninelives` | audio | done | — |
| `noise` | audio | done | — |
| `numpadPlus` | audio | done | — |
| `onetonine` | video | done | — |
| `outlines` | video | done | — |
| `outToLaunch` | video | done | — |
| `painter` | video | done | — |
| `peakstate` | video | done | — |
| `peertube` | video | done | — |
| `pentemelodica` | audio | done | — |
| `picturebox` | video | done | — |
| `polarizer` | audio | done | — |
| `pong` | audio | done | — |
| `posterbox` | video | done | — |
| `ptzcam` | audio | done | — |
| `push2Control` | meta | done | — |
| `qbrt` | audio | done | — |
| `quadralogical` | video | done | — |
| `rasterize` | audio | done | — |
| `recorderbox` | video | done | — |
| `reshaper` | video | done | — |
| `resofilter` | audio | done | — |
| `reverb` | audio | done | — |
| `ringback` | audio | done | — |
| `rings` | audio | done | — |
| `ruttetra` | video | done | — |
| `sampleHold` | audio | done | — |
| `samsloop` | audio | done | — |
| `scaler` | audio | done | — |
| `scope` | audio | done | — |
| `score` | audio | done | — |
| `scoreboard` | video | done | — |
| `seqtris` | audio | done | — |
| `shapedramps` | video | done | — |
| `shapegen` | video | done | — |
| `shapes` | video | done | — |
| `shimmershine` | audio | done | — |
| `sidecar` | audio | done | — |
| `sixstrum` | audio | done | — |
| `skifree` | audio | done | — |
| `slewSwitch` | audio | done | — |
| `snaredrum` | audio | done | — |
| `sourcery` | video | done | — |
| `spectrograph` | audio | done | — |
| `spirographs` | video | done | — |
| `stereovca` | audio | done | — |
| `swolevco` | audio | done | — |
| `synesthesia` | audio | done | — |
| `tempest` | video | done | — |
| `tempolock` | audio | done | — |
| `textmarquee` | video | done | — |
| `tidyVco` | audio | done | — |
| `tiler` | video | done | — |
| `timelorde` | audio | done | — |
| `tomtom` | audio | done | — |
| `treeohvox` | audio | done | — |
| `tvLibrarian` | video | done | — |
| `twotracks` | audio | done | — |
| `unityscalemathematik` | audio | done | — |
| `vca` | audio | done | — |
| `vdelay` | video | done | — |
| `vfpgaRunner` | video | done | — |
| `videobox` | video | done | — |
| `videocube` | video | done | — |
| `videoMixer` | video | done | — |
| `videoOut` | video | done | — |
| `videovarispeed` | video | done | — |
| `vstFx` | audio | done | — |
| `vstInstrument` | audio | done | — |
| `warrensspectrum` | audio | done | — |
| `warrensvisions` | video | done | — |
| `wavecel` | audio | done | — |
| `wavesculpt` | audio | done | — |
| `wavetableVco` | audio | done | — |

## `blocked`

would be a face today but for the named capability, and nothing else.

_none_

## `bespoke-surface`

the primary interaction is not param-shaped — needs a purpose-built surface.

| module | domain | state | blockers |
|---|---|---|---|
| `archivist` | video | — | `needs-media-controller` |
| `clipplayer` | audio | — | — |
| `doom` | video | — | — |
| `toybox` | video | — | `needs-media-controller` |
| `trails` | audio | — | — |

## `organizational-native`

rack furniture; not a migration at all.

| module | domain | state | blockers |
|---|---|---|---|
| `cadillac` | meta | — | — |
| `group` | meta | — | — |
| `sticky` | meta | — | — |
