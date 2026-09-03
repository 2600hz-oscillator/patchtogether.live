# S0 re-measures — `feat/legacy-removal` branch point

**Status:** ⚠ EVIDENCE, NOT INSTRUCTION (`.myrobots/` per AGENTS.md).
**Measured at:** branch point `feat/legacy-removal` = `origin/main` @ `fad354576`
(the basis `build-brief.md` and `plan.md` state), 2026-09-03.
**Scope:** the non-owner-gated S0 items only — the fixture-implicit spec list, the
toybox card-only-testid re-diff, the attest pin verification, and the
boot-serialization ceiling. Owner-gated items (DOOM approval, Q9/Q10/Q11) are not
measured here.

Every number below was derived mechanically from the tree, never hand-typed. The
derivation scripts are throwaway (scratchpad); the method is written out per item so
the next builder can re-derive rather than trust.

---

## M1 — Fleet re-measure (confirms the brief)

| | brief | measured | verdict |
|---|---:|---:|---|
| `lib/ui/modules/*Card.svelte` | 196 | **196** | ✅ |
| total LoC | 58,875 | **58,875** | ✅ |
| survivors that MOVE (`GroupCard` 569 + `StickyCard` 162) | 2 / 731 | **2 / 731** | ✅ |
| deletable fleet | 194 / 58,144 | **194 / 58,144** | ✅ |

```sh
ls packages/web/src/lib/ui/modules/*Card.svelte | wc -l      # 196
cat packages/web/src/lib/ui/modules/*Card.svelte | wc -l     # 58875
```

---

## M2 — The fixture-implicit spec list, and a SECOND blind spot

### The denominator

| | plan v2.1 | measured | note |
|---|---:|---:|---|
| spec files total | 551 | **552** | `e2e/tests` is 510, not 509 |
| explicit non-comment `shell=legacy` | 311 | **310** | |
| — of those, navigating | 302 | **302** | ✅ |
| **fixture-implicit** (`rack` fixture destructured, ZERO `shell=legacy` text) | ~110 | **113** | full list below |
| **INVERSION DENOMINATOR** (union) | ~412 | **423** | |

Derivation: a spec is fixture-implicit when it imports from `_fixtures` AND
destructures `rack` in a `async ({ … })` fixture bag AND its comment-stripped source
contains no `shell=legacy`. Comment stripping matters: 6 of the 12 helper files the
plan lists carry the string **only in prose**, so they need a doc edit, not a code
edit.

| helper | carries the string in |
|---|---|
| `e2e/tests/_fixtures.ts` | **code** (the `rack` fixture goto) |
| `e2e/tests/_per-module-per-port-shared.ts` | **code** |
| `e2e/tests/_toybox-fixture-helpers.ts` | **code** |
| `e2e/tests/carl-rackspace.helpers.ts` | **code** |
| `e2e/tests/support/rack-session.ts` | **code** (`LEGACY_RACK_URL`) |
| `e2e/vrt/vrt-exemptions.ts` | **code** |
| `e2e/tests/_helpers.ts` | comment only |
| `e2e/tests/_module-coverage-helpers.ts` | comment only |
| `e2e/tests/_per-port-drivers.ts` | comment only |
| `e2e/tests/support/face-screen-render-suite.ts` | comment only |
| `e2e/tests/support/faces-parity-suite.ts` | comment only |
| `e2e/vrt/_shell-faces.ts` | comment only |

### The S2 family split — the useful number

The brief's S2 decision table wants (a) URL-only vs (b) card-DOM. Measured over the
423:

| family | count |
|---|---:|
| **(b) reaches card DOM** | **152** |
| — directly (a `*-card` testid / `.mod-card` string in the spec) | 122 |
| — **only through a helper** (the SECOND blind spot, below) | 30 |
| **(a) URL-only** | **271** |

**This materially shrinks S2's long pole**: the rewrite work is ~152 specs, not ~412.
The other 271 are `goto`/fixture-line changes.

### ⚠ The second blind spot (new — not in the plan)

The plan found one blind spot (the fixture destructure). There is a second of the same
shape one level further out: **three helper files reach card DOM**, so a spec that
imports one is card-coupled with no card string of its own.

| helper | reached by |
|---|---|
| `e2e/tests/_card-overflow.ts` | `e2e/tests/io-spec-consistency.spec.ts` — the only TESTS-lane member |
| `e2e/vrt/vrt-scenes.ts` | 30 VRT specs |
| `e2e/vrt/_fonts.ts` | (subset of the above) |

The 30 VRT members are S3's problem and the plan's scene-family table already covers
them by name. The one that matters for **S2** is `io-spec-consistency.spec.ts`: it is
in the `#1847` park list AND it reaches card DOM through `_card-overflow.ts`, so its
park reconciliation is a family-(b) rewrite, not an unpark-and-repoint.

**Method note for the next builder:** both blind spots are the same instrument failure
— grepping the spec text for the coupling instead of resolving what the spec
*executes*. A third level (a helper importing a card-reaching helper) was checked and
is empty today; re-run the transitive check after S1, because S1 adds imports.

### The 113 fixture-implicit files

```
tests/4plexer  adsr-poly-midilane  adsr-vca-invert  audio-controls  aut-patch-panel
automation-cv-record*  backdraft-pure-tv  blood-audio-output*  blood-ingame*  bluebox*
buggles  cable-drag-section-expand  cable-z-order*  clap  click-pickup-cable
clip-automation*  clip-prob-default  clipplayer-card-erase*  clipplayer-card-parity*
clipplayer-clip-delete  clipplayer-clip-view-grid*  clipplayer-controls
clipplayer-custom-scale  clipplayer-rate-reset  clipplayer-right-click-menu
clipplayer-songmode  clipplayer-transport-no-controller*  clipplayer  clouds-face
clouds  cloudseed  cofefve  coverage-group-2-sources  coverage-groups-3-4-5
cv-range-uniformity  docs*  dx7-syx-load  es9-hardware  es9-per-leg-patching
fader-midi-assign  fader*  filter-cv-depth  foxy  illogic  insert-on-cable  joystick*
karplus  keyboard-nav  kickdrum  kria  launchpad-arp  launchpad-clip-launch
launchpad-keys-record  launchpad-perf-controls  launchpad-scene-repeats
lfo-modulation-visible  live-glyphs  midi-cv-buddy  midi-lane  midi-learn
mixmstrs-stereo-expand  modulation  module-annotate  multi-output  nested-module-menu
node-context-menu  noise  note-entry  painter*  palette  param-edit-undo
patch-convenience  patch-panel  patch-to-cascade  pentemelodica
perf-tempo-under-modulation  picturebox-limits  poly-chord  push2-clip-launch
reshaper-shapedramps  resofilter  ringback  rings  sample-hold
samsloop-poly-source-chain  save-group-and-naming*  scaler-cv-connect  scope-tuner
scope-xy-intensity  score  seqtris  shapegen-clock*  shapegen*  sidecar  sixstrum-poly
skins  snaredrum-roll  stereo-autowire  stereo-only-channel  swolevco  tempo-stability
tidy-vco  tomtom  topbar-buttons  toybox-control-surface*  ui-refresh  vfpga-floorplan*
vfpga-p2-cells  vfpga-p4-early-hd*  vfpga-patchpanel-presets*  vfpga-runner
voice-chain-art  voice-pitch-accuracy
```

`*` = the 21 that also reach card DOM (family (b)). The plan named 10 of these; the 11
it did not name are `automation-cv-record`, `blood-audio-output`, `blood-ingame`,
`clip-automation`, `clipplayer-card-erase`, `clipplayer-card-parity`,
`clipplayer-clip-view-grid`, `clipplayer-transport-no-controller`, `docs`, `joystick`,
`save-group-and-naming`.

---

## M3 — Toybox card-only-testid re-diff (post-#2331): RESOLVED, no S1(d) additions

The two testids the plan flagged as possibly card-only **both live in
`lib/ui/modules/toybox/ToyboxConsole.svelte`**, the ONE component that the card mounts
with `layout="card"` and the faceplate body `ToyboxConsoleBody.svelte` mounts with
`layout="face"`:

| testid | home | face reachable? |
|---|---|---|
| `toybox-video-relink` | `ToyboxConsole.svelte:3089` | ✅ yes |
| `toybox-preset-error` | `ToyboxConsole.svelte:2704` | ✅ yes |

`ToyboxCard.svelte` is 126 LoC and owns **no control at all** — the rack tile frame,
the stripe, `ModuleTitle` and the `PatchPanel`. Its only card-exclusive testid is
`toybox-card` (the frame itself), which is a selector concern for the 3 specs that use
it, not a functional-parity hole.

**Verdict: neither testid joins S1(d).** S1(d) stays exactly two items — the clipplayer
recovery prompt and the samsloop REC refusal.

---

## M4 — WebGL attest pin: confirmed clean, with one S1 constraint

```
$ flox activate -- task webgl:attest:check
WebGL content hash: 2f505b423083261ce6161bc2ac0d668727aadcd4276fb6f31c864c103f56b073
✓ A matching attestation exists (ci-webgl-attest/2f505b42….json). No re-attest needed.
```

```
$ flox activate -- bash scripts/webgl-attest-hash.sh --list | wc -l
220
$ … | grep -c 'Card\.svelte'
0
$ … | grep 'lib/ui'
packages/web/src/lib/ui/modules/cube/CubeVizSurface.svelte
packages/web/src/lib/ui/modules/wavesculpt/WavesculptVizSurface.svelte
```

Confirms the plan §1.7: **220 basis files, ZERO cards** — the fleet deletion does not
move the hash. The pin is valid at the branch point and at current `main` (same
commit).

⚠ **Constraint this puts on S1, stated because it is easy to trip:**
`WavesculptVizSurface.svelte` is in the basis and `wavesculpt` is one of the 7
producers being extracted. Keeping the *path* stable is not enough — the *content* is
hashed. The wavesculpt extraction must leave that file byte-identical, or the branch
buys a re-attest. Same for `CubeVizSurface.svelte` if the GroupCard/host rework
brushes it.

---

## M5 — Boot-serialization ceiling: MEASURED, and much smaller than feared

The standing note is "re-pointing a spec off legacy serializes cold boots — the dock
mount no longer overlaps page load". Measured on this worktree's dev server
(`task e2e:serve`, warm), 5 alternating reps after a warm-up of each arm.

**First measurement — nav only, empty rack (the fixture's own cost):**

| arm | min | median | max |
|---|---:|---:|---:|
| `/rack?shell=legacy&seed=none` | 1202 | 1219 | 1231 |
| `/rack?seed=none` | 1207 | 1219 | 1224 |

**Median ratio 1.000.** The fixture nav itself costs the same either way — with an
empty rack there is nothing to mount in either shell, so there is no overlap to lose.

**Second measurement — the honest one: boot AND REACH the module's own DOM.** Arm A is
the legacy shape (card is in the lane); arm B is the re-pointed shape (face tile in the
lane, so the spec must open the dock full view to reach module-internal DOM):

| arm (`adsr`) | min | median | max |
|---|---:|---:|---:|
| A — legacy lane, `.mod-card.adsr-card` visible | 1264 | 1272 | 1281 |
| B — default shell + `shell-open-dock` → `dock-full-view` | 1278 | **1294** | 1311 |

**Median ratio 1.017. Worst-case ratio (B max / A min) 1.037.**

### The ceiling, stated for S2

- **Per boot-and-reach cycle: +22 ms median, +47 ms worst case (+1.7% / +3.7%).**
- Applied to the plan's measured cost share (the legacy-string specs carry 14,468 of
  24,521 CPU-s), a uniform +3.7% on the re-pointed set is **≈ +535 CPU-s ≈ +45 s per
  shard** across 12 shards — well inside the lane, and it is an *upper* bound because
  271 of the 423 (family (a)) never open a dock at all and pay only the +0.0% nav
  delta.
- The cost is **per reach, not per spec**: a spec that opens the dock once pays it
  once; a spec that opens N module surfaces pays it N times. The family-(b) specs are
  where it lands.

### ⚠ What this instrument structurally cannot see

State it plainly rather than let the number travel further than it earned:

1. **Warm dev server, one worker, no contention.** CI runs 4 workers/shard against a
   preview build. The absolute numbers do not transfer; only the *ratio* is the claim,
   and even that assumes contention scales both arms equally.
2. **One node, one module type.** A spec that opens a heavy face (toybox, vfpga) pays
   a mount cost this `adsr` probe does not contain.
3. **It does not model re-binning.** The shard planner packs at *stale* costs until the
   re-pin, so a shard can time out from mis-packing at a ratio far below 1.037. The
   plan's rule stands unchanged: a post-re-bin failure is the fixture/contention class,
   never a re-run.
4. **`seed=none` racks only.** A spec booting a SEEDED rack does have module mount
   overlapping page load, and that is the one shape where the "lost overlap" claim
   could be real. No such spec was measured because the fixture pool is `seed=none`;
   if S2 meets one, measure it rather than reuse this ratio.

The CI measurement run (brief S5 step 1) remains the real instrument. This ceiling is
for deciding whether to *expect* trouble — the answer is no — not for accepting a
timing artifact.

---

## Carry-forward for S1/S2

1. S1(d) is exactly two items (M3).
2. Wavesculpt extraction must not touch `WavesculptVizSurface.svelte`'s bytes (M4).
3. S2's rewrite pole is 152 specs, not 423 (M2).
4. `io-spec-consistency.spec.ts` is a family-(b) member via `_card-overflow.ts` and its
   `#1847` park must be reconciled as a rewrite (M2).
5. Re-run the transitive card-reaching-helper check after S1 (M2).
6. No timing artifact needs pre-emptive re-pinning for the boot change (M5).
