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
| done (faced + promoted) | 37 |
| remaining (excludes organizational-native) | 156 |
| registered with NO disposition (must be zero) | 0 |
| inventory entries naming a dead def (must be zero) | 0 |

## By disposition

| disposition | what it means | modules | done |
|---|---|---|---|
| `generic-face` | author a `face` and rank the controls — no new platform capability | 140 | 37 |
| `blocked` | would be a face today but for the named capability, and nothing else | 3 | — |
| `bespoke-surface` | the primary interaction is not param-shaped — needs a purpose-built surface | 50 | — |
| `organizational-native` | rack furniture; not a migration at all | 3 | — |

## What each blocker buys

| blocker | issue | modules waiting |
|---|---|---|
| `needs-extension-registry` | #1512 | 50 |
| `needs-media-controller` | #1511 | 12 |
| `needs-note-entry-cell` | #1509 | 15 |

## `generic-face`

author a `face` and rank the controls — no new platform capability.

| module | domain | state | blockers |
|---|---|---|---|
| `4plexvid` | video | — | — |
| `acidwarp` | video | — | — |
| `adsr` | audio | done | — |
| `analogLogicMaths` | audio | — | — |
| `analogVco` | audio | done | — |
| `attenumix` | audio | done | — |
| `b3ntb0x` | video | — | — |
| `backdraft` | video | — | — |
| `bentbox` | video | — | — |
| `bluebox` | audio | done | — |
| `buggles` | audio | — | — |
| `cellshade` | video | — | — |
| `charlottesEchos` | audio | — | — |
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
| `destroy` | audio | — | — |
| `destructor` | video | — | — |
| `dockscope` | audio | — | — |
| `drummergirl` | audio | done | — |
| `dx7` | audio | done | — |
| `edges` | video | — | — |
| `fader` | video | — | — |
| `featurecv` | audio | — | — |
| `feedback` | video | — | — |
| `filter` | audio | done | — |
| `flipper` | audio | — | — |
| `fourplexer` | audio | — | — |
| `foxy` | audio | — | — |
| `freezeframe` | video | — | — |
| `gatemaiden` | audio | — | — |
| `grainsOfVision` | video | — | — |
| `graphicEq` | video | — | — |
| `illogic` | audio | — | — |
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
| `mixmstrs` | audio | — | — |
| `monoglitch` | video | — | — |
| `moog902` | audio | — | — |
| `moog903a` | audio | — | — |
| `moog904a` | audio | — | — |
| `moog904b` | audio | — | — |
| `moog904c` | audio | — | — |
| `moog905` | audio | — | — |
| `moog907a` | audio | — | — |
| `moog911` | audio | — | — |
| `moog911a` | audio | — | — |
| `moog912` | audio | — | — |
| `moog914` | audio | — | — |
| `moog921a` | audio | — | — |
| `moog921b` | audio | — | — |
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
| `slewSwitch` | audio | — | — |
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
| `unityscalemathematik` | audio | — | — |
| `vca` | audio | done | — |
| `vdelay` | video | — | — |
| `vfpgaRunner` | video | — | — |
| `videoMixer` | video | — | — |
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
| `archivist` | video | — | `needs-extension-registry` `needs-media-controller` `needs-note-entry-cell` |
| `audioIn` | audio | — | `needs-extension-registry` `needs-media-controller` |
| `audioOut` | audio | — | `needs-extension-registry` |
| `blood` | video | — | `needs-extension-registry` |
| `cameraInput` | video | — | `needs-extension-registry` `needs-media-controller` |
| `cartesian` | audio | — | `needs-extension-registry` `needs-note-entry-cell` |
| `chromaconsole` | audio | — | `needs-extension-registry` |
| `clipplayer` | audio | — | `needs-extension-registry` |
| `clockedRunner` | audio | — | `needs-extension-registry` |
| `controlSurface` | meta | — | `needs-extension-registry` `needs-note-entry-cell` |
| `doom` | video | — | `needs-extension-registry` |
| `drumseqz` | audio | — | `needs-extension-registry` `needs-note-entry-cell` |
| `electraControl` | meta | — | `needs-extension-registry` `needs-note-entry-cell` |
| `es9` | audio | — | `needs-extension-registry` |
| `frogger` | audio | — | `needs-extension-registry` |
| `gamepad` | audio | — | `needs-extension-registry` |
| `gibribbon` | video | — | `needs-extension-registry` |
| `kria` | audio | — | `needs-extension-registry` |
| `launchpadControlLeft` | meta | — | `needs-extension-registry` |
| `livecode` | audio | — | `needs-extension-registry` |
| `macseq` | audio | — | `needs-extension-registry` `needs-note-entry-cell` |
| `mappy` | video | — | `needs-extension-registry` |
| `matrixMix` | meta | — | `needs-extension-registry` |
| `midiclock` | audio | — | `needs-extension-registry` |
| `midiCvBuddy` | audio | — | `needs-extension-registry` |
| `midiLane` | audio | — | `needs-extension-registry` `needs-note-entry-cell` |
| `midiOutBuddy` | audio | — | `needs-extension-registry` |
| `modtris` | audio | — | `needs-extension-registry` |
| `moog956` | audio | — | `needs-extension-registry` |
| `nibbles` | video | — | `needs-extension-registry` |
| `numpadPlus` | audio | — | `needs-extension-registry` |
| `outToLaunch` | video | — | `needs-extension-registry` |
| `painter` | video | — | `needs-extension-registry` `needs-note-entry-cell` |
| `peertube` | video | — | `needs-extension-registry` `needs-media-controller` `needs-note-entry-cell` |
| `picturebox` | video | — | `needs-extension-registry` |
| `polyseqz` | audio | — | `needs-extension-registry` `needs-note-entry-cell` |
| `pong` | audio | — | `needs-extension-registry` |
| `push2Control` | meta | — | `needs-extension-registry` |
| `recorderbox` | video | — | `needs-extension-registry` `needs-media-controller` `needs-note-entry-cell` |
| `score` | audio | — | `needs-extension-registry` |
| `sequencer` | audio | — | `needs-extension-registry` `needs-note-entry-cell` |
| `skifree` | audio | — | `needs-extension-registry` |
| `textmarquee` | video | — | `needs-extension-registry` `needs-note-entry-cell` |
| `toybox` | video | — | `needs-extension-registry` `needs-media-controller` `needs-note-entry-cell` |
| `tvLibrarian` | video | — | `needs-extension-registry` `needs-media-controller` |
| `twotracks` | audio | — | `needs-extension-registry` |
| `videobox` | video | — | `needs-extension-registry` `needs-media-controller` |
| `videoOut` | video | — | `needs-extension-registry` |
| `videovarispeed` | video | — | `needs-extension-registry` `needs-media-controller` |
| `writeseq` | audio | — | `needs-extension-registry` `needs-note-entry-cell` |

## `organizational-native`

rack furniture; not a migration at all.

| module | domain | state | blockers |
|---|---|---|---|
| `cadillac` | meta | — | — |
| `group` | meta | — | — |
| `sticky` | meta | — | — |
