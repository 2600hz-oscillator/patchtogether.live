# FACE SPEC — `drumseqz` (batch 4)

## 0. PROVENANCE

Measured against `main` at `ecc48f2e` (2026-08-09). **BANKED — not built.** The
faceplate pipeline is paused; nothing below is implemented.

**Verdict: PROMOTE**, archetype **clocked step SEQUENCER** (the four-track drum row).

Not in `STRICT_FACES`; no `face:` block. In `STRICT_DOCS` **and in
`STRICT_VRT_MODULES`** — so **any change to `DrumseqzCard.svelte` re-captures a
REQUIRED baseline**, which is the one cost fact worth carrying into the build.
18 params, 7 in, 9 out, one `controlFamily` (`drumseqz-pitch`,
`countParam: 'length'`) and one exposed button (`playStop → isPlaying`).

**Method — and it is different from the other seven.** `drumseqz` has **no worklet**:
it is a main-thread scheduler writing `ConstantSourceNode`s, so the offline
bundle-and-run harness used elsewhere does not apply. Everything below is measured by
running the def's **exported pure functions** (`bjorklund`, `applyEuclideanToTrack`,
`resolveStepVOct`) under esbuild with the `$lib` imports stubbed, plus source reading of
the scheduler. **Where a claim is read rather than executed, it says so.**

---

## 1. WHAT IT ACTUALLY DOES

Four independent 128-step tracks sharing one playhead, one BPM and one `length`. Each
track emits a `gate{N}` + `pitch{N}` pair. 16 steps are visible per page (8 pages).
Per-track: a Euclidean fill count, a root note, an octave. Global: bpm, length, swing,
gate length, octave, play/stop. Plus four `queue{N}_cv` inputs for hands-free pattern
switching.

---

## 2. THE CONTROLS THAT MATTER — 18 params + a 16-cell grid, and the cut is severe

| rank | control | why |
|---|---|---|
| 1 | `drumseqz-pitch-{n}` | **the step grid IS the module.** A sequencer face that ranks BPM above its own pattern is a tempo box. ⚠ A `family` key is legal at any rank — the rank-7 rule is for `panel` CELLS only. |
| 2 | `isPlaying` | the transport. Declared `expose playStop kind=button`. |
| 3 | `bpm` | 30..300. |
| 4 | `length` | 1..128 — **and it silently changes what every EUCLID knob means** (§4-B). |
| 5 | `swing` | 0..0.75. |
| 6 | `gateLength` | 0.1..0.95 duty. |
| 7 | `drumseqz-euclid-{n}` | the picture. First legal PANEL rank. |
| 8-11 | `trk1..4_euclid` | dock-only. **Write-only params — nothing at play time reads them** (§4-A). |
| 12-15 | `trk1..4_root` | dock-only. |
| 16 | `octave` | dock-only. **Exactly redundant with the four per-track octaves** (§4-C). |
| 17-20 | `trk1..4_octave` | dock-only. |

⚠ **Ranking the grid first is the one decision that matters here**, and it is only
possible because `drumseqz` declares a `controlFamily`. `curatedFace` resolves
`drumseqz-pitch-{n}` to `kind: 'family'`, which — unlike a `panel` cell — is selectable
at a lane tier. At `compact` the tile then shows the pattern and the transport, which is
what a rack full of sequencers needs to be readable at a glance.

**NO AUDITION.** The transport IS the audition, and it is a real param.

---

## 3. NOT INERT AT SPAWN — but it makes no sound

`isPlaying` defaults to **0**, so the playhead is stopped; the `pitch{N}` ConstantSources
sit at the resolved default V/oct and the gates at 0 (**read from the factory**, not
executed). The module produces a *steady* pitch CV and no gates until something presses
play or drives `play_cv`.

---

## 4. WHAT THE FACE MUST MAKE VISIBLE — three measured facts

### A. `trk{N}_euclid` is a WRITE-ONLY param — and a shipped LIVECODE example writes it

`applyEuclideanToTrack` is called from **exactly one place in the repo**:
`packages/web/src/lib/ui/modules/DrumseqzCard.svelte:138-140`, which does both halves —

```ts
set(`trk${t + 1}_euclid`)(k);                       // record the number
arr[t] = applyEuclideanToTrack(arr[t] ?? [], k);    // rewrite the CELLS
```

The pattern lives in `node.data.tracks`. **The scheduler never reads the euclid params.**
The only other place they are touched is the slot restore
(`drumseqz.ts:513`), which copies them into `live.params` as bookkeeping alongside the
`d.tracks` snapshot that carries the actual pattern.

**Consequence: writing `trk{N}_euclid` from anywhere other than that card button changes
a number and produces no rhythm.** That includes LIVECODE, MIDI-learn, the Push 2 card,
an automation lane — and a faceplate.

⚠ **And the repo already ships an example that does exactly that.**
`packages/web/src/lib/livecode/examples.ts:198`:

```ts
set('drums', 'trk1_euclid', 4); // four-on-the-floor kick on track 1
```

That line writes 4 and produces silence on track 1. It is a documented, shipped,
copy-pasteable instruction that does not work.

**This is a blocker for the face, not a footnote.** A faceplate that ranks four EUCLID
dials is four dead controls on the most prominent new surface in the app. Two ways out,
and they are different sizes:
1. **Make the param live** — have the scheduler derive the played pattern from
   `trk{N}_euclid` when it is non-zero, leaving `data.tracks` as the manual layer.
   That is a **behaviour change** to a sequencer (it changes what a saved patch plays)
   and needs an owner decision and its own PR.
2. **Take the euclid controls off the face** and leave them as card-only buttons.
   Cheap, honest, and it leaves the LIVECODE example broken.

**Recommendation: (1), as a separate PR, landing BEFORE the face.** Option 2 ships a
faceplate that is quietly less capable than the card it replaces.

### B. The EUCLID count is "hits per 16-step page", and LENGTH silently rescales it

`applyEuclideanToTrack` computes `bjorklund(k, PAGE_SIZE)` with `PAGE_SIZE = 16` and
tiles it across all `STEP_COUNT = 128` cells (`drumseqz.ts:158-169`). The playhead visits
`0 … length−1`. So the number of hits actually played is a truncation of the tile:

| length | k=1 | k=3 | k=4 | k=5 | k=7 | k=9 | k=11 | k=16 |
|---|---|---|---|---|---|---|---|---|
| 4 | 1* | 1* | 1 | 1* | 2* | 2* | 3* | 4 |
| 7 | 1* | 2* | 2* | 2* | 3* | 4* | 5* | 7 |
| 8 | 1* | 2* | 2 | 3* | 4* | 4* | 5* | 8 |
| 12 | 1* | 3* | 3 | **4*** | 5* | 7* | 8* | 12 |
| **16** | **1** | **3** | **4** | **5** | **7** | **9** | **11** | **16** |
| 20 | 2* | 4* | 5 | 6* | 9* | 11* | 14* | 20 |
| 24 | 2* | 5* | 6 | 8* | 11* | 13* | 16* | 24 |
| 32 | 2 | 6 | 8 | 10 | 14 | 18 | 22 | 32 |

`*` = the played count is not `k × (length/16)`. **At the default `length` of 16 every
column is exact**, which is why this has never surfaced: the module ships in the one
configuration where the knob means what it says.

Set EUCLID to 5 and LENGTH to 12 and you get **4 hits**. Set EUCLID to 7 and LENGTH to 4
and you get **2**. `docs.controls.trk1_euclid` says "1..16 spreads that many hits evenly
across the page" — which is true of the *page* and not of the *loop*, and the two are
the same thing only at the default.

*(`bjorklund` itself is **correct**: `bjorklund(4,16)`, `bjorklund(3,8)` and
`bjorklund(5,16)` all match their own docstring exactly. The formula
`(i·k) mod n < k` is a faithful even-distribution. A checked non-defect.)*

### C. There are two octave controls and they are exactly the same control

`resolveStepVOct(cell, root, trackOctave, globalOctave)` returns
`midiToVOct(midi ?? root) + trackOctave + globalOctave` (`drumseqz.ts:180-187`). *Measured*:

| trkOct | glbOct | result |
|---|---|---|
| 2 | 0 | **2.0000 V** |
| 0 | 2 | **2.0000 V** |
| 1 | 1 | **2.0000 V** |

Bit-identical. `octave` and `trk{N}_octave` are peers, not a coarse/fine pair, and
together they give **±4 octaves** on top of a root that already spans MIDI 33..114
(6.75 octaves).

**The full range that produces:**

| corner | V/oct | frequency |
|---|---|---|
| defaults (root 48) | 0.0000 | 130.81 Hz |
| min root, no octaves | −1.2500 | 55.00 Hz |
| max root, no octaves | 5.5000 | 5.92 kHz |
| **min corner** (33, −2, −2) | −5.2500 | **3.44 Hz** |
| **max corner** (114, +2, +2) | 9.5000 | **94.72 kHz** |

Across the 2050 `(root × trkOct × glbOct)` combinations: **1894 audible (92.4 %), 66
above 20 kHz (3.2 %), 90 below 20 Hz (4.4 %).** So 7.6 % of the pitch control space is
outside the audible band — modest, and worth a readout rather than a range change,
because a sequencer legitimately drives non-audio destinations.

---

## 5. THE FACE

```ts
// ⚠ NO `title`, NO `hint` — owner no-prose ruling, 2026-08-11. Everything
// explanatory goes in `docs` (right-click → annotate reads it); a faceplate
// states values. The band LABELS below carry what must paint unconditionally.
face: {
  order: [
    'drumseqz-pitch-{n}',                              // 1 — the pattern IS the module (a FAMILY, legal at a lane tier)
    'isPlaying', 'bpm', 'length', 'swing', 'gateLength',  // 2-6 = the rest of the lane budget
    'drumseqz-euclid-{n}',                             // panel: first legal rank is 7
    'trk1_euclid', 'trk2_euclid', 'trk3_euclid', 'trk4_euclid',
    'trk1_root', 'trk2_root', 'trk3_root', 'trk4_root',
    'octave', 'trk1_octave', 'trk2_octave', 'trk3_octave', 'trk4_octave',
  ],
  // ⚠ FIVE BANDS IS **NOT** THE TAB RAIL — this spec said it was, and it was
  // wrong when written. `dockTabPlan` rails at `bands.length >= 7`
  // (`DOCK_TAB_MIN_BANDS`), and pentemelodica — the face this shape was copied
  // from — has EIGHT. Five renders as one scrolling column, which means the
  // band hints below DO paint and PF-21 row packing DOES apply (a railed face
  // never packs). Re-plan the vertical budget on that basis, and note that a
  // sixth and seventh band would cross the cliff and delete every hint at once.
  pages: [
    { id: 'transport', label: '1 · transport',
      hint: 'BPM 30–300, or an external CLOCK. SWING shifts the off-steps up to 0.75; GATE sets the ' +
            'duty 0.10–0.95. PLAY / RESET / QUEUE 1-4 are all CV-drivable.',
      controls: ['isPlaying', 'bpm', 'swing', 'gateLength'] },
    { id: 'pattern', label: '2 · pattern — LENGTH decides what EUCLID means',
      hint: 'The grid is 128 cells; the playhead visits LENGTH of them. EUCLID writes a 16-step tile ' +
            'across all 128, so the hits you actually hear are that tile TRUNCATED: EUCLID 5 plays ' +
            '5 hits at LENGTH 16, 4 at LENGTH 12, 2 at LENGTH 7.',
      controls: ['drumseqz-pitch-{n}', 'drumseqz-euclid-{n}', 'length'] },
    { id: 'fills', label: '3 · euclidean fills',
      hint: 'Each slider REWRITES its row’s on/off flags and keeps the per-step notes. 0 leaves the ' +
            'hand-drawn row alone.',
      controls: ['trk1_euclid', 'trk2_euclid', 'trk3_euclid', 'trk4_euclid'] },
    { id: 'roots', label: '4 · roots — used when a lit step has no note',
      hint: 'MIDI 33–114. A lit step with its own note ignores the root entirely.',
      controls: ['trk1_root', 'trk2_root', 'trk3_root', 'trk4_root'] },
    { id: 'octaves', label: '5 · octaves — these ADD, and the global one is a fifth copy',
      hint: 'Track octave and global octave are peers: +2/0, 0/+2 and +1/+1 are bit-identical. ' +
            'Together they reach 3.44 Hz and 94.7 kHz at the corners.',
      controls: ['octave', 'trk1_octave', 'trk2_octave', 'trk3_octave', 'trk4_octave'] },
  ],
  glyph: 'none',   // §5-A

  hero: {
    cell:    'drumseqz-euclid-{n}',
    control: 'bpm',
    action:  'isPlaying',
    readouts: [
      { label: 'loop',  valueId: 'drumseqz-loop-bars' },
      { label: 'hits',  valueId: 'drumseqz-played-hits' },
      { label: 'range', valueId: 'drumseqz-pitch-range' },
    ],
  },

  // ⚠ NO SIDEBAR. The draft carried a `signal-flow` block; that KIND WAS
  // DELETED (#1468, owner ruling) — twelve modules declared hand-authored
  // stage lists that nothing verified against the DSP. `graph/types.ts`
  // states the rule: a chain picture must be DERIVED from something the
  // build can check, or it must not exist. An empty sidebar is correct.
}
```

⚠ **5-A · `glyph: 'none'` IS DELIBERATE.** `primaryAudioOutPortId` picks the first
**audio** output; `drumseqz` declares **none** — its nine outputs are `gate` and `pitch`.
A `'scope'` or `'meter'` here has nothing to tap. The attenumix §5-A hazard, in its
terminal form: rather than metering the wrong jack, there is no jack to meter.
**The hero picture carries the visual load instead.**

⚠ **Band 2's and band 5's labels are 42 and 51 characters** and both carry the finding.
Label clipping is invisible to `faces-parity` (`toHaveText` reads `textContent`, and a
CSS ellipsis leaves no trace). Measure both in the dock. Fallbacks:
`2 · pattern — LENGTH rescales EUCLID`, `5 · octaves — these ADD`.

⚠ `face.title` / `face.hint` paint only under annotations (`facePageHeader`
returns `null` before reading anything) and are not declared at all under the
no-prose ruling. Band LABELS paint unconditionally; band HINTS paint on any
non-railed dock face, which this one is (see the `pages` note above).

⚠ **`drumseqz-pitch-{n}` at rank 1 is legal; `drumseqz-euclid-{n}` at rank 7 is
required.** The first is a declared `controlFamily` → `kind: 'family'`; the second is a
PANEL cell, and `module-face-lint` refuses a panel selected at a lane tier while
`faceTierCap('full')` is 6. Twenty keys, so rank 7 is comfortable.

---

## 6. DERIVED READOUTS

### A. `drumseqz-loop-bars` — how long the loop actually is

```
seconds = length · 60 / bpm / 4        # 16ths
bars    = length / 16
```
**NEGATIVE CONTROL — `swing`.** The loop LENGTH must be invariant to swing (swing shifts
off-steps within the bar and does not change the bar). A readout that moved with swing
would be reporting the last interval. **SECOND CONTROL — an external `clock` patch:** when
CLOCK IN is driving, `bpm` is not the tempo and the readout must say so rather than print
a number the module is not using. ⚠ That requires knowing whether a cable is present —
**a patched-input query `FaceReadoutValue` cannot make today.** Until the reader widens,
label it `loop (internal)`.

### B. `drumseqz-played-hits` — the readout that IS §4-B

Prints, per track, the number of Euclid hits inside `0 … length−1`, e.g. `5 → 4`.
**NEGATIVE CONTROL — `length`.** A `paramId: 'trk1_euclid'` readout prints `5` at every
length while the played count measures 5 / 4 / 3 / 2 at length 16 / 12 / 8 / 7.
**SECOND CONTROL — the track's manual cells:** the readout must fall back to counting the
actual `data.tracks` row when `trk{N}_euclid` is 0, because at 0 the row is hand-drawn
and the euclid number is meaningless.
⚠ **This readout cannot be honest until §4-A is fixed.** Today the param and the pattern
can disagree arbitrarily — the card writes both together, but any other writer moves only
the param. **Printing a hit count derived from a param nothing reads would be a face
asserting a rhythm the module is not playing**, which is worse than the current silence.
**Ship this readout only with the §4-A fix.**

### C. `drumseqz-pitch-range` — the two octave knobs, resolved

Prints the lowest and highest note the current settings can emit, in Hz, e.g.
`55 Hz … 5.9 kHz`, greyed when outside 20 Hz–20 kHz.
**NEGATIVE CONTROL — swap `trk1_octave` and `octave`.** The readout must be **identical**
for `(+2, 0)`, `(0, +2)` and `(+1, +1)` — measured bit-identical at 2.0000 V — because
that identity is the fact being taught. A readout that distinguished them would be
inventing a difference. **SECOND — `trk{N}_root`:** it must move with the root.

---

## 7. THE BESPOKE CELL

**LEGITIMATE — `drumseqz-euclid-{n}`: the four rings.** Four concentric rings, one per
track, each with `length` slots, the Euclid hits filled, **the 16-step tile boundary
drawn as a spoke**, and the playhead sweeping all four. The tile boundary is the whole
picture: it makes "your loop is 12 and the fill is 16" a thing you *see* rather than a
thing you count.

---

## 8. ALREADY-WRONG

- **A · `trk{N}_euclid` is a write-only param** — read by no scheduler path, settable
  from four surfaces that all do nothing. §4-A. **Blocking for the face.**
- **B · a shipped LIVECODE example writes it.** `livecode/examples.ts:198`
  `set('drums', 'trk1_euclid', 4); // four-on-the-floor kick on track 1` produces
  silence. §4-A. This is user-facing documentation that is wrong.
- **C · `docs.controls.trk{N}_euclid`'s "spreads that many hits evenly across the page"**
  is true of the page and false of the loop at every `length` that is not a multiple of
  16. §4-B. `STRICT_DOCS`.
- **D · `octave` and `trk{N}_octave` are the same control.** §4-C. Not a bug — a design
  redundancy worth naming, because a player who finds one will not look for the other.
- **E · no audio output means no glyph.** §5-A. A face-introduced hazard, flagged early.
- **F · the card re-types the ranges**; `drumseqz` is not in `RANGE_BOUND_CARDS`.
- **`bjorklund` is CORRECT** against all three of its own docstring examples, and the
  `expose playStop kind=button` + `family drumseqz-pitch countParam=length` declarations
  are both present and consistent in `contract-lock.txt:982-983`. Checked non-defects.

---

## 9. THE THREE COSTS THAT ARE STRUCTURAL, NOT ARITHMETIC

- **⚠ `drumseqz` IS in `STRICT_VRT_MODULES`**, so **any change to
  `DrumseqzCard.svelte` re-captures a REQUIRED baseline** — and the §4-A fix
  touches the card. Budget that re-capture into the DSP-fix PR, not the face PR,
  so a red `vrt-strict` has exactly one cause.
- **ART: `art/scenarios/drumseqz/eucl-render.test.ts` exists with NO
  `art/baselines/drumseqz/`**, so it asserts properties only. **The §4-A fix is a
  behaviour change with no pinned audio protecting it** — write the regression
  test with the fix.
- **⚠ A `countParam: 'length'` family is 16 cells at the default and up to 128**
  if a test raises `length`. The `faces-parity` row must pin `length` at its
  default or it becomes the most expensive row in the suite.
