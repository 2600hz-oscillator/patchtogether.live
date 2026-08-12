# face re-do — qbrt

> ⚠ **PLATFORM CORRECTIONS SINCE THIS WAS WRITTEN — 2026-08-12 janitorial sweep.**
> - **The `signal-flow` sidebar kind was DELETED** (#1468, removed with its twelve
>   adopters). `packages/web/src/lib/graph/types.ts:798` now reads "THERE IS NO
>   `signal-flow` KIND, and re-adding one is the mistake this note prevents."
>   **Any `signal-flow` sidebar block proposed below is VOID** — the surviving
>   kinds are the three in `FaceSidebar.svelte`.
> - **PF-22 freed the hero rank** (#1480): `face.hero.cell` no longer consumes a
>   LANE rank, so a `panel` may now rank FIRST. Any argument below that a module
>   cannot be faced because a panel's first legal rank is 7 is OBSOLETE.
> - **A card↔face PRIMITIVE-PARITY gate now exists** (#1480,
>   `card-primitive-parity.test.ts`): ranking a param whose card binds it to a
>   primitive the platform has no cell kind for now FAILS, naming the
>   `(module, param, primitive)` triple. `XyPad` and `NoteEntry` are the two
>   declared gaps.
> - **`qbrt.ping` now DECLARES `edge: 'trigger'`** (`qbrt.ts:73`), and the
>   undeclared-edge ledger this file's banner points at was deleted with the whole
>   mechanism (#1442). That citation is void.
> - **The faceplate pipeline is PAUSED by owner directive.** This spec is BANKED,
>   not cancelled and not blocked.


> ⚠ **STATUS CORRECTED 2026-08-04 — read `face-redo-INDEX.md` §0 before building.**
> PF-20 (**PR #1301**) **HAS MERGED** (`c6ff9253`); every "unmerged branch" citation below
> now resolves on `main`. **`face.title` and `face.hint` do NOT paint by default** —
> `facePageHeader()` returns `null` before reading anything unless annotate mode is on
> (`packages/web/src/lib/ui/workflow/dock-faceplate-model.ts:90`), and the owner ruled on
> 2026-08-03 that `face.title` stays annotation-only. **§4's "with zero prose painted the
> dock shows … the module hint (`face.hint` still paints)" is FALSE** — re-derive that
> read-through. PF-21 dock ROW PACKING (`9bf12df7`) also landed after this was written.
> **This re-do is NOT built** — the shipped `face` still declares no `hero` and no
> `sidebar`. Live backlog.
> ⚠ Ledger defect #12 (`ping` declares no `edge:`) is **still open in the def**
> (`qbrt.ts:32` still calls it a CONTRACT GAP), but the *gate blindness* is fixed — the
> undeclared-edge ledger (`packages/web/src/lib/docs/undeclared-edge-ledger.ts:57`) now
> tracks it by name.

**Verdict: REAL REWORK** — the shipped face ranks four knobs correctly and says nothing about the module: qbrt genuinely is **two instruments sharing four knobs** (an always-on stereo insert filter, and a struck resonator needing no oscillator); the second instrument is **unreachable from every surface in the repo**; and the two numbers a player most needs — how long it rings, how much louder the peak is — are **derivable from the DSP and printed nowhere**.

Platform: `origin/feat/faceplate-platform-v2` (PR #1301 — **MERGED**, `c6ff9253`). Every `file:line` re-derived against the code, never copied from a plan (round-2's DSP citations are off by 1–2 lines; its BLOCKER is false — §9).

---

## 1. WHAT THE MODULE ACTUALLY DOES

Signal path in the DSP's real order (`packages/dsp/src/qbrt.dsp:63-72`): `l + click` and `r + click` each enter an identical `svf(fcSm, qPing, mSm, ·)`, which computes **four taps in parallel** — `lp/bp/hp` via `fi.reson*` plus `notch = x − bp` (`:41-45`) — and crossfades adjacent pairs by `mSm·3` (`:46-52`).

- **Two IDENTICAL, INDEPENDENT channels** off one knob set (`qbrt.dsp:63-64`): no cross-feed, no mid/side, no shared state. Strictly dual-mono — and nothing on the rear card shows it.
- **Not an SVF.** `qbrt.dsp:2`'s name is wrong and the def says so (`qbrt.ts:8-14`). Verified in the stdlib: `filters.lib:2185-2194` (`resonlp`); **`filters.lib:2228` — `resonhp(fc,Q,gain,x) = gain*x - resonlp(...)`**, so the def's "resonhp is itself `x − lp`" claim (`qbrt.ts:9`) is CORRECT; `filters.lib:2263-2272` (`resonbp`); `filters.lib:1869-1879` (`tf2s`, prewarped bilinear ⇒ `fc` lands exactly at the digital corner).
- **All four taps share ONE denominator** `D(s) = (s/ωc)² + (s/ωc)/Q + 1`. The most load-bearing fact here: MODE cannot change the ring's length or pitch, only its shape and level. This is the must-not-move leg in §5.
- **The morph is CONTINUOUS** — taps at exactly 0, ⅓, ⅔, 1, real linear blends between ⇒ `landmarks`, never `options` (§7).
- **Q is NOT gain-compensated.** `qBase = clamp(resonance,0,0.99)*20 + 0.7` (`qbrt.dsp:67`) → Q 0.7…20.5, and the `gain` argument to every `fi.reson*` is the literal `1.0` (`:41-43`). `|H(jωc)|` at MODE 0 is exactly Q ⇒ **+23.3 dB at the shipped default**, +26.2 dB at the top. **RESONANCE is the loudest control on the module and its dial prints `0.70`.**
- **PING does two things at once** (`qbrt.dsp:14, 23-34, 68-71`): a rising edge across 0.5 fires (a) `clickEnv` — one-pole from 1.0, **fixed** per-sample coefficient `0.98`, ×1.5, summed into **both filter inputs** (the ring goes through the same filter your audio does — NOT a parallel voice); and (b) `qPingEnv` — one-pole with coefficient `exp(−1/(pingDecay·SR))`, ×30, ADDED to `qBase`, so Q jumps to as much as 50.5 and relaxes.
- **It never self-oscillates** — a two-pole section is unconditionally stable at any Q. PING is the only way to make this filter sing, and the module has never carried a strike affordance anywhere.

| control | what it changes about the SOUND | inert at spawn? |
|---|---|---|
| `cutoff` | the insert's corner frequency **AND** the pitch the resonator rings at | no |
| `resonance` | sharpness, ring length, **and up to +26 dB of level** at the corner | no |
| `mode` | which tap — plus 2.7 dB of gain swing at default Q, 12 dB at Q 0.7 | no |
| `pingDecay` | how long the +30 Q boost is held — shapes an excitation nothing is firing | **YES** |

**Measurable facts worth printing** (derived in §5): the ring's −60 dB length is **82 ms at the defaults** while PING DEC reads **150 ms**; the gain at cutoff is **+23.3 dB**, uncompensated; the excitation's fixed constants are a ≈1.03 ms (τ @48 kHz) click and +30 Q; and the 4th tap only NULLS at `resonance ≈ 0.015`, since `notch = x − bp` ⇒ `|H(jωc)| = |1 − 1/Q|·Q`, zero iff Q = 1 (`qbrt.dsp:45, 67`) — exactly what `qbrt.ts:184` claims. Every number in that docs paragraph checks out.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

The ranking (`qbrt.ts:132`) and the two-band split (`qbrt.ts:134-135`) are right. Everything PF-20 added is absent, and two things are actively wrong.

1. **No `title`, `hint`, `hero`, `sidebar` or page `hint`s** — authored before the platform existed. The committed `face-qbrt-dock.png` is a title bar, a **flatlined black scope rectangle**, three knobs, one knob, and ~75 % of the faceplate width empty.
2. **The audition exists on NO surface.** `QbrtCard.svelte` is 41 lines — stripe, `ModuleTitle`, `PatchPanel`, four `Fader`s (`:30-33`); no `<button>`, `<select>`, `oncontextmenu`. The handle (`qbrt.ts:214-242`) exposes `setParam`/`readParam`/`dispose` and **no `read()`**, so `engine.read(node,'manualTrigger')` (`engine.ts:762-765`) returns `undefined`. Untriggerable from card, dock and Push 2 alike.
3. **The glyph is a dead rectangle on a fresh spawn.** `glyph:'scope'` (`qbrt.ts:137`) taps the L output; an unpatched insert emits silence. The def itself asks for a param-derived response curve instead (`qbrt.ts:127-130`) — §5 explains why the answer is the audition, not a second picture.
4. **`resonance` prints `0.70`.** Under PF-20 the dock ALWAYS prints a value under every dial (`knob-vocabulary-model.ts:110-112`), making this the most-read wrong number on the faceplate — on a module named for Q whose def spends a paragraph translating the range (`qbrt.ts:182`).
5. **`mode` prints `0.00`** — a four-tap morph whose taps are named nowhere in the repo.
6. **The `ping` PortDef declares no `edge`** (`qbrt.ts:73-86`) though `qbrt.dsp:14` is a textbook rising-edge detector; self-documented as a known gap at `qbrt.ts:32-35`. → §7.3 / §9.1.
7. **Stale arithmetic:** `qbrt.ts:119` reads `full (8): all four`. The full cap is **six** (`curated-face.ts:46, 76`), and after this PR it is five cells, not four.

---

## 3. THE ~8 CONTROLS THAT MATTER — qbrt has FOUR params, so this is a five-key roster

| rank | key | why it earns the rank (an argument that would be WRONG elsewhere) |
|---|---|---|
| 1 | `cutoff` | the ONLY control that is two things at once — the insert's corner **and** the resonator's tuning (`qbrt.dsp:66`, `:41-43`). On a filter that could self-oscillate RESONANCE would compete for rank 1; this one cannot, so it does not. Takes the mini tile outright. |
| 2 | `resonance` | **not gain-compensated** (`qbrt.dsp:67` + literal `1.0` gain at `:41-43`), so it is sharpness, ring length AND up to +26 dB of level at once. On a Q-compensated filter it is a timbre knob and ranks below MODE. Takes the 2nd compact cell. |
| 3 | `mode` | decides WHICH of four responses you hear — and unlike `filter`'s discrete `options` mode this is a continuous morph you ride, with a real 2.7 dB gain swing at default Q. Below RESONANCE because 2.7 ≪ 26 dB. First key off the compact tile. |
| 4 | `qbrt-ping-{n}` | **the audition, ABOVE the knob it makes meaningful.** `pingDecay` is the one control inert at spawn and the audition is what ends that inertness, so ranking the cure above the symptom is Step-3's own rule. Module-specific: on kickdrum EVERY control is inert at spawn (the same argument ranks it 1st there); on delay none is (it would not apply). |
| 5 | `pingDecay` | last **on evidence**: across its whole 100× range it moves the ring only 38 → 92 ms at the default cutoff/resonance, while one 2-octave CUTOFF move takes it 82 → 246 ms. It is the weakest of the three inputs to the thing it is named for (§5). |

**THE LOSERS, NAMED:** none past rank 5 — all five keys sit inside the 6-cell lane budget (`curated-face.ts:46`), so nothing on qbrt is dock-only. Ladder as a sentence: *mini* = CUTOFF; *compact* = CUTOFF + RES (cap 2 with a glyph, `curated-face.ts:76`); *full* = all five in the 3×2 plate; *dock* = all five plus hero, strip and sidebar.

**Glyph arithmetic, re-derived** (`module-shell-model.ts:289-290, 331-344`): `laneBodyPlan(5, true, 'full')` → 5 > `LANE_ROW_MAX_CELLS_WITH_GLYPH`(2) → plate; `cellCount = min(5,6) = 5`; `rows = ceil(5/3) = 2`; `glyph = hasGlyph && rows <= 1` → **false**. Already false at 4 cells, so the 5th rank costs **no glyph**; it still paints at mini, at compact and as the dock hero.

**ZERO new ParamDefs.** The four params are 1:1 with the DSP's four `hslider`s (`qbrt.dsp:6-11` ↔ `qbrt.ts:100-103`) — no un-exposed capability, a finding rather than a shortfall. The remaining constants (`0.98`, `1.5`, `+30`) are fixed by design; exposing any is a Faust recompile and must never ride a face wave.

---

## 4. BAND STRUCTURE + THE ANNOTATION PROSE

```ts
pages: [
  { id: 'filter', label: 'filter · dual mono',
    hint: 'Left and right are identical two-pole banks on one shared knob set — no cross-feed, '
        + 'no mid/side matrix — so the stereo image you patch in survives untouched. RESONANCE is '
        + 'not gain-compensated: the peak at CUTOFF grows roughly in step with Q, so a high setting '
        + 'is both sharper and markedly louder.',
    controls: ['cutoff', 'resonance', 'mode'] },
  { id: 'ping',   label: 'ping · resonator',
    hint: 'Each rising edge injects a broadband click into BOTH filter inputs and slams the internal '
        + 'Q up by +30, that boost then relaxing with PING DEC. The filter rings at CUTOFF and '
        + 'settles — a pluck. This filter never self-oscillates, so PING is the only way to make it '
        + 'sing, and the ring is not level-compensated.',
    controls: ['qbrt-ping-{n}', 'pingDecay'] },
]
```

After the hero promotes `cutoff` and `qbrt-ping-{n}` (§5), band 1 paints RES + MODE and band 2 paints PING DEC. Neither hint can be dead metadata: `dockTabPlan` needs `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:46`) and qbrt has 2, so the face is never tabbed and the lint's dead-hint clause (`module-face-lint.test.ts:1140-1147`) is satisfied by construction.

**Does it read correctly with EVERY hint hidden? Yes.** With zero prose painted the dock shows: `Filter · Resonator` + the module hint (`face.hint` still paints) → a big CUTOFF dial beside a `▸ PING` button → a strip reading `RING 82 ms · AT CUTOFF +23.3 dB · STRIKE ≈1 ms · Q +30` → a band *filter · dual mono* holding `RES Q 14.7` and `MODE LP` → a band *ping · resonator* holding `PING DEC 0.150 s` → a sidebar drawing the chain and offering five complete presets. Both band labels are **names**, not sentences; `dual mono` is a qualifier in the house `·` style, deliberately **redundant** with the sidebar's closing stage note (`no cross-feed`), so trimming the label to `filter` would not make the face wrong. One-line revert.

**`ping · resonator` is UNCHANGED, on purpose.** `rear-card-model.ts:288-291` makes the `ping` page's REAR band take the CURATED group's label while the FRONT band takes `page.label`, so renaming one alone desynchronises the two faces of one band — and `rear-card-model.test.ts` has zero qbrt pins, so nothing catches it (round-2 shipped exactly that desync). Leaving both strings alone removes the surface entirely.

**Rear:** keep ids `signal`/`ping` (`qbrt.ts:151-152`); relabel only `signal` → `stereo in · dual mono`. Never rename the `filter` page id to `signal` — the voice-slot claim fires unconditionally (`rear-card-model.ts:262-269`) and that band would render twice, invisibly to the totality gate. `audioRate` stays EMPTY: all four knobs are `si.smoo`-ed inside the DSP (`qbrt.dsp:6-11`) and the Faust wrapper block-samples once per 128-frame quantum (`qbrt.ts:21-25`), so not one CV jack is audio-rate.

---

## 5. THE HERO + THE READOUT STRIP

### hero.cell — NO bespoke picture, and the reason is structural as well as editorial

The generic glyph is `scope` (`qbrt.ts:137`) and it stays **unsuppressed**, because a face with no `hero.cell` keeps its glyph band (`types.ts:693-700`). A param-derived |H(f)| response curve is the picture this module wants (`qbrt.ts:127-130` says so) — and it is **structurally unavailable**: `module-face-lint` refuses a `panel` SELECTED at any lane tier (`module-face-lint.test.ts:550-566, 576-585`) and `faceTierCap('full')` is 6 (`curated-face.ts:46, 76`), so a panel's first legal rank is **7**, needing six other keys. qbrt has five. → §9.5 (a platform gap, not a qbrt one).

That is not a loss: **the audition is the better fix for the dead glyph.** Pressing `▸ PING` makes the scope trace the ring, so the two land as a matched pair and the module's identity paints itself on demand instead of needing a second picture.

### hero.control = `cutoff` · hero.action = `qbrt-ping-{n}`

The hero slot's job is "the module's biggest control and its audition" (`types.ts:693-696`). qbrt's two identities are exactly CUTOFF and PING, so putting those two side by side is the face stating the thesis where a player looks first. `heroFacePlan` REMOVES both from their bands (`dock-faceplate-model.ts:127-159`); `heroFacePlanIsTotal` (`:171-186`) is what makes that safe.

⚠ **TASTE CALL, one-line revert.** Promoting the action leaves band 2 holding ONE control. Delete `hero.action` and band 2 becomes `[▸ PING][PING DEC]`; nothing else moves (`pages[1]` already lists the action first).

### THE READOUT STRIP — three entries, full-width under the hero rail

```ts
readouts: [
  { label: 'ring',      valueId: 'qbrt-ring' },   // 82 ms at the defaults
  { label: 'at cutoff', valueId: 'qbrt-peak' },   // +23.3 dB at the defaults
  { label: 'strike',    text: '≈1 ms click · Q +30' },
]
```

**No fourth entry, and that is the point:** every other quantity qbrt has is a knob, and the dock already prints every knob's value under its own dial. A strip that reprints them is noise.

**`qbrt-ring` — the formula.** The ring is the impulse response of `D(s)`, poles at `s = ωc·(−1/(2Q) ± j√(1 − 1/(4Q²)))` (`filters.lib:2185-2194`, `:1869-1879`), so amplitude decays at `α = ωc/(2Q)` Np/s. Q is **time-varying** during a ping — `qPing = qBase + ev·30`, `ev = exp(−t/τp)` (`qbrt.dsp:23-27, 67-69`) — so the −60 dB time is the root of `∫₀ᵀ ωc/(2·Q(u)) du = ln 1000`, which has a closed form:

```
Q0 = 20·resonance + 0.7      ωc = 2π·cutoff      B = 30      τ = pingDecay
K  = 2·Q0·ln(1000) / (ωc·τ)
X  = Q0 / ((Q0 + B)·e^K − B)          // always in (0,1) ⇒ TOTAL, no NaN branch
ringSeconds = −τ·ln(X)
```

At the defaults (1000 Hz / 0.7 / 0.15 s): K = 0.2155, X = 0.5776, **t₆₀ = 82.3 ms**. Frozen-coefficient (adiabatic) approximation — valid because Q relaxes over ~150 ms while the ring is at 1 kHz; state and cap that claim in the model's header.

**NEGATIVE CONTROL** (permanent, in a new `qbrt-face-model.test.ts`) — **moves, invisible to a `pingDecay` readback:** `cutoff` 1000 → 250 Hz takes the ring 82 → **246 ms** (3×) while a knob readback prints `150 ms` both times; second leg, `resonance` 0.7 → 0.2 takes it 82 → **63 ms**. **MUST NOT move:** `mode` 0 → 1 must leave the number **byte-identical** — all four taps share one denominator (`qbrt.dsp:41-45` + `filters.lib:2228`). This is the kickdrum `tail` trap failing *in the module's favour*: the nearest knob, `pingDecay`, is the **weakest** of the three inputs — across its whole 100× range it moves the ring only 38 → 92 ms — so `{ paramId: 'pingDecay' }` would print neither the answer nor even the dominant term.

**`qbrt-peak` — the formula.** `|H(jωc)|` through the same crossfade the DSP computes (`qbrt.dsp:46-52`), with the STEADY-state Q (`qBase`), because this describes the filter you patch through, not the transient strike:

```
Q = 20·resonance + 0.7;  m3 = 3·mode;  seg = min(2, floor(m3));  t = m3 − seg
seg 0 (lp→bp):   |H| = Q·√(t² + (1−t)²)
seg 1 (bp→hp):   |H| = √((Q(1−t) + t)² + (Q·t)²)
seg 2 (hp→x-bp): |H| = √((1 − t·Q)² + Q²(1−t)²)
dB = 20·log10(|H|)
```

(from `lp(jωc) = −jQ`, `bp(jωc) = Q`, `hp = 1 − lp`, `notch = x − bp`.) Defaults → **+23.35 dB**, and every number the def's prose already claims falls out of it: +26.2 dB at resonance 0.99 (`qbrt.ts:182` says "+26"); **−10.46 / 0 / +22.73 dB** at mode 1 for resonance 0 / 0.065 / 0.7 (`qbrt.ts:184` says "−10.5", "flat by 0.065", "≈ +23"). Four independent cross-checks, all hold. **NEGATIVE CONTROL:** `mode` 0 → 0.5 moves it +23.35 → **+20.63 dB** (12 dB of swing at resonance 0), which a `resonance` readback cannot see. **MUST NOT move:** `cutoff` and `pingDecay` — a two-pole section is scale-invariant so cutoff only relocates the peak, and the ping boost is transient and outside this readout by construction.

The two derived values are **negative controls for each other** — RING moves on cutoff/resonance/pingDecay and is invariant to mode; PEAK moves on resonance/mode and is invariant to cutoff/pingDecay. Swap the implementations by accident and four assertions go red at once.

**The candidate held to the bar and REJECTED — RING FREQUENCY.** `fd = fc·√(1 − 1/(4Q²))`. At the shipped default (Q 14.7, falling from 44.7) that is **999.42 … 999.94 Hz against a 1000 Hz cutoff — 0.06 % off**. It diverges meaningfully only at Q ≲ 2, where `α = ωc/2Q` makes the "ring" a sub-millisecond impulse response rather than a ring. So the perturbation that moves it (`resonance`) exists only where the readout is meaningless: **it is `cutoff` wearing a formula — registry abuse.** A face wanting the ring's pitch declares `{ label: 'rings at', paramId: 'cutoff' }` and says so. This strip prints neither, because `cutoff` is the hero dial directly above and already prints itself.

---

## 6. THE SIDEBAR — `signal-flow` + `presets`

```ts
sidebar: [
  { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'L · R IN',         role: 'bus',       note: 'audio you patch' },
      { label: 'PING',             role: 'generator', parallel: true, note: 'click → the SAME input' },
      { label: 'TWO-POLE BANK ×2', role: 'bus',       note: 'lp · bp · hp, computed in parallel' },
      { label: 'MODE MORPH',       role: 'bus',       note: 'crossfade of adjacent taps' },
      { label: 'L · R OUT',        role: 'bus',       note: 'dual mono — no cross-feed' },
  ]},
  { kind: 'presets', label: 'presets', entries: [
      { id: 'insert', label: 'INSERT',     note: 'ping off', values: { cutoff: 1200, resonance: 0.45,  mode: 0,     pingDecay: 0.15 } },
      { id: 'tom',    label: 'TOM',        note: '571 ms',   values: { cutoff:  120, resonance: 0.85,  mode: 0,     pingDecay: 0.35 } },
      { id: 'wood',   label: 'WOOD',       note: '141 ms',   values: { cutoff:  440, resonance: 0.75,  mode: 1 / 3, pingDecay: 0.08 } },
      { id: 'pew',    label: 'PEW',        note: '44 ms',    values: { cutoff: 2400, resonance: 0.95,  mode: 1 / 3, pingDecay: 0.5  } },
      { id: 'notch',  label: 'TRUE NOTCH', note: 'Q = 1',    values: { cutoff: 1000, resonance: 0.015, mode: 1,     pingDecay: 0.15 } },
  ]},
]
```

**Why the flow diagram is honest.** The click sums into the SAME filter input the audio uses (`qbrt.dsp:63-64` — `svf(…, l + click)`), so drawing it inline between IN and the filter would teach that your signal passes *through* the click. ⚠ **INFERENCE + taste call:** `parallel: true` renders a dashed branch joining the spine, visually right — but the field's own doc defines `parallel` as "taps the bus earlier and rejoins it further down" (`types.ts:736-748`) and this is a side-INJECTION, not a tap-and-rejoin. A platform vocabulary gap, not a qbrt lie; revert is `parallel: false` plus a `note` reading "summed in".

**Why presets and not a `readouts` block.** Every value is in range and every entry is a **COMPLETE** 4-param recall — the partial-recall trap is impossible on a four-param module. The roster is the cheapest demonstration of the two-instruments thesis: `INSERT` is the filter; the middle three are the resonator at three pitches and lengths (571 / 141 / 44 ms, computed with §5's formula, so the RING readout is legible on arrival); `TRUE NOTCH` is the one resonance (Q = 1 exactly) at which MODE 1 actually nulls — provable from `qbrt.dsp:45, 67`, unreachable by twiddling. A `readouts` block would duplicate the strip, so none is declared.

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

1. **`landmarks` on `mode`** (PF-10; contract-transparent — `contract-signature.ts:64-70` projects only `id/min/max/curve/defaultValue/units`): `[{0,'LP'},{1/3,'BP'},{2/3,'HP'},{1,'X-BP'}]`, values off `qbrt.dsp:46-52`. **NOT `options`:** the blends ARE the feature, and `param-vocabulary.test.ts` requires `curve:'discrete'` for `options` while `mode` is `linear` (`qbrt.ts:102`) — declaring `options` reddens the unit lane immediately. **`X-BP`, not `NOTCH`**, because `NOTCH` is a lie at every resonance above ≈ 0.065 (§1); ASCII hyphen, never U+2212 (VRT pins a webfont). ⚠ Accepted: `nearestByValue` ties go to the first entry, so mode 0.5 prints `BP`.
2. **`format` on `resonance`** (PF-3; a FUNCTION, so it structurally cannot reach the projection — `types.ts:406-410`): `(v) => 'Q ' + (0.7 + 20 * v).toFixed(1)` → `Q 14.7`. The dial then prints the number the DSP actually uses instead of a meaningless `0.70`. ⚠ **VRT price round-2 missed:** `knobReadout` is gated on format/options/landmarks being present (`knob-vocabulary-model.ts:86-90`), so this gives the **compact lane tile** a readout line it lacks today — `face-qbrt-compact.png` MOVES. Since `linux/face-qbrt-compact` is drained and re-captured in this PR anyway (§8), the marginal cost is ≈ 0. **One-line revert: delete `format` and compact must NOT move.** ⚠ `0.7` and `20` are MIRRORED from `qbrt.dsp:67` and cannot be imported from Faust — required guard, on the kickdrum `splitHz: 120` source-grep precedent: a unit assertion that reads `qbrt.dsp` as text and fails if `* 20.0 + 0.7` changes; the same guard covers §5's `B = 30` (`qbrt.dsp:69`) and the click's `0.98` (`:33`).
3. **`edge: 'trigger'` on the `ping` PortDef** — the one real contract line (§8). Included rather than deferred because this is already a contract PR, and shipping a `manualTrigger` audition against a port that refuses to declare its edge is exactly the card-disagrees-with-def class. Delete the CONTRACT GAP paragraph (`qbrt.ts:32-35`) in the same commit. `module-docs-lint`'s edge gate clears with no prose edit: `docs.inputs.ping` (`qbrt.ts:163-164`) already opens "The excitation TRIGGER … Each rising edge" and later "Only the RISING edge matters".
4. **No range or curve changes.** All four params keep their declared bounds.

**Card range grep (CLAUDE.md's one-source-of-truth rule), every hit reported.** `QbrtCard.svelte:30-33` re-types **all twelve** range numbers as literals, and `:14-17` reads the defaults by **POSITIONAL INDEX** (`qbrtDef.params[0]!.defaultValue`) while already importing `qbrtDef` at `:5`. All twelve **AGREE** with `qbrt.ts:100-103` today — a HAZARD, not a live bug. The positional index is the worse half: reordering the def's params silently rebinds every default with no error anywhere. Boy-scout fix here with `paramSpec` from `card-kit`, which THROWS on an unknown id (`KarplusCard.svelte:33-56`, whose comment is this CLAUDE.md rule written out). **Scope it to the NUMBERS only** — do not source `label`, or the card's `Resonance`/`Ping Decay` become `Res`/`Ping Dec` and the REQUIRED strict-lane baseline moves for a cosmetic.

---

## 8. COST

**Contract-lock: +1 line, 1 modified line; the qbrt block goes 14 → 15** (`contract-lock.txt:2563-2576`). MODIFIED `:2567` — `qbrt in ping gate` → `… edge=trigger`; `portLine` appends `edge=` after type/param/cvScale/accepts and `edge` is not in the sort key (`contract-signature.ts:78-88`), so the line stays put. ADDED after the last `qbrt param …` line (order meta → in → out → param → stereo → expose → family, `contract-signature.ts:105-127`): `qbrt family qbrt-ping kind=other prefix=qbrt-ping`. **Contract-TRANSPARENT, verified against the projection:** the entire `face` block (title, hint, hero, readouts, sidebar, presets, pages, labels), `landmarks`, `format`, every `docs` edit. Same-commit doc edits, mandatory: add `docs.controls['qbrt-ping-{n}']` (`module-docs-lint.test.ts:173-177`; qbrt is in `STRICT_DOCS` at `strict-docs.ts:239`) and delete the CONTRACT GAP paragraph; then `task docs:accept` and review the diff.

**VRT.**
- **MOVES, REQUIRED lane:** `vrt.spec.ts/{darwin,linux}/qbrt.png`. The legacy card gains a PING button because `module-docs-lint.test.ts:232-247` greps every declared `testidPrefix` against `allCardSource()` (`:76-88`, all of `packages/web/src/lib/ui/**/*.svelte`). `qbrt` is in `STRICT_VRT_MODULES` (`vrt-exemptions.ts:890`) and neither baseline is exempt. ⚠ Correcting round-2: `VRT_STRICT=1` narrows the run to `vrt.spec.ts` ONLY (`vrt.config.ts:32, 97`), so this card scene is the only part of the PR in the blocking gate.
- **MOVES, informational lane:** `face-qbrt-dock.png` (title + hint rows, hero rail, readout strip, sidebar column, band relabel, mode ticks + `LP`, res `Q 14.7`) and `face-qbrt-compact.png` (the res `format` readout — §7.2).
- **MUST NOT MOVE:** any rear scene — `workflow-rear-card.spec.ts:48-52` covers only tidyVco/vca/dx7/sixstrum — and there is no qbrt annotated legend. A surprise diff there is a FINDING, not a re-pin.
- **DRAIN FIRST, DISPATCH SECOND.** COMMIT 1, pushed alone: delete `'linux/face-qbrt-compact'` and `'linux/face-qbrt-dock'` (`vrt-exemptions.ts:1061-1062`) **and** lower BOTH ratchets by 2 in the same commit — `SHARED_LINUX_PAIR_CEILING` 91 → 89 (`vrt-meta.test.ts:333`) and `LINUX_DEFICIT_CEILING` 148 → 146 (`:562`). ⚠ Correcting round-2 again: both are now asserted in **both** directions (`:524-530`, `:611-623`), so draining without lowering is **RED**, not silent. COMMIT 2: `gh workflow run vrt-update.yml -f ref=<branch> -f platform=linux`, UNSCOPED. `linux/qbrt` exists and will FAIL → rewritten; the two face pairs are MISSING → always written. A green dispatch that commits nothing is a red flag.
- **Structural:** `workflow-shell-faces.spec.ts:57` `{ type:'qbrt', pages: 2 }` — unchanged.

**e2e.** faces-parity qbrt cells 4 → 5 (+1 × ~0.8 s). One new `e2e/tests/qbrt-ping-audition.spec.ts`, **mandatory** because faces-parity's `action` branch asserts only `toBeEnabled()` + a press (`faces-parity.spec.ts:554-556`) and would pass a dead button.

**CI wall-time ≈ +12 s** = 0.8 s (the 5th parity cell) + ~10–14 s (one `?shell=1` boot, spawn, dock open, ~400 ms capture) + ~0 (unit-lane only for landmarks/format/labels/docs). Well under the 2-minute bar; state it in the PR body and confirm ON CI, not locally.

**ART / attest: NIL, confirmed not assumed.** There is no `art/scenarios/qbrt/` (checked), and qbrt is not one of the five `docsStrippedRepoSourceSha` defs — so no `docs-hash-ignore` markers, and a face edit is free. Zero `.dsp` edit ⇒ no Faust recompile, no `.f32` movement; the audition is entirely host-side. qbrt is an AUDIO def (not in the WebGL basis). Do NOT append to `e2e/tests/_drivers.ts`, do NOT edit `_helpers.ts` (import `spawnPatch`), and do NOT write the literal `@collab` in the new spec (the collab basis tag-grep matches the @-form).

**Build cost beyond the def:** a pure `qbrt-face-model.ts` (~60 lines) + 2 entries in `face-readout-values.ts` + a `qbrt-ping-{n}` `action` cell in `shell-cells.ts` (one line, `onFire: (nodeId) => { fireManualStrike(nodeId); }` — the `kickdrum-strike-{n}` shape at `shell-cells.ts:378`) + a `read('manualTrigger')` on the qbrt handle firing a `ConstantSource` summed into `merger` input 2 alongside the existing keep-alive (`qbrt.ts:192-199`; the `karplus.ts:326-329, 369-376` shape) + one card button. **No platform change** — `fireManualStrike` resolves the engine itself via `getActiveEngine()` (`engine-ref.ts:23-25`, `manual-strike-actions.ts:147`) and is null-safe, so the docs-sandbox mount (`interactive-doc-modules.ts:154`) needs no guard either.

---

## 9. DEFECTS FOUND IN SHIPPED CODE (follow-ups, NOT spec content)

1. **`ping` declares no `edge`, and the gate that should notice is ONE-SIDED.** `qbrt.ts:73-86` vs `qbrt.dsp:14`. Cost: the jack renders without the trigger glyph and the port is invisible to the trigger/gate vocabulary. **No test can catch it** — `module-docs-lint.test.ts:214` reads `if (!p.edge) continue;`, so the gate only checks ports that ALREADY declare an edge and a MISSING declaration is structurally invisible. Fixed by §7.3; the one-sided gate is its own item.
2. **`QbrtCard.svelte:14-17` binds defaults by POSITIONAL INDEX** into `qbrtDef.params`, and `:30-33` re-types twelve range numbers. All twelve AGREE today ⇒ a hazard, not a live bug — but a param reorder silently rebinds every default with no error, and no def-reading gate can see it (the exact CLAUDE.md class). Fix: `paramSpec` (§7).
3. **`docs.inputs.ping` overstates the click's decay by ~7×.** `qbrt.ts:164` says it decays "to nothing in ~1 ms". The `0.98` per-sample coefficient (`qbrt.dsp:33`) gives τ = −1/(SR·ln 0.98) = **1.03 ms @48 kHz** (the 1/e time constant) and **7.1 ms to −60 dB**. The 96 kHz halving claim IS correct. Cost: the wrong mental model of the excitation width. Prose fix.
4. **`qbrt.dsp:2`'s `declare description` is wrong twice** — "Stereo state-variable filter" (it is four parallel `fi.reson*` biquads, `filters.lib:2185/2228/2263`) and "LP→BP→HP→**Notch**" (a notch only at resonance ≈ 0.015). The def header corrects both (`qbrt.ts:8-14`, `:184`); the `.dsp` was never updated, so the wrong description ships in the generated `qbrt.json`. No gate reads it.
5. **PLATFORM (against the unmerged branch): a face with ≤ 5 ranked controls cannot declare a `hero.cell` at all.** The panel rule requires rank ≥ 7 (`module-face-lint.test.ts:550-566` + `faceTierCap('full') = 6`), but `face.hero.*` is documented DOCK-ONLY (`types.ts:636-640`). The rank-7 proxy only holds for a face with six other controls — a coincidence of kickdrum's 25-key roster, which is precisely what the rule's own comment (`:544-548`) warns against relying on. Fix (~3 lines + a negative control): have `curatedFace` exclude `def.face.hero.cell` at lane tiers **by declaration**, so the panel rule stops depending on roster size. qbrt does not need it here.

---

## 10. VERIFICATION GATE

```sh
flox activate -- task test:one -- qbrt-face-model     # ⇦ the derived-readout negative controls
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- dock-faceplate-model
flox activate -- task test:one -- shell-cells
flox activate -- task test:one -- manual-strike-wiring
flox activate -- task test:one -- param-vocabulary
flox activate -- task test:one -- knob-vocabulary-model
flox activate -- task test:one -- rear-card-model
flox activate -- task test:one -- module-docs-lint
flox activate -- task test:one -- curated-face
flox activate -- task test:one -- vrt-meta            # after the drain commit — BOTH directions
flox activate -- task docs:check && flox activate -- task docs:accept   # review the 2-line diff
flox activate -- task typecheck

flox activate -- task e2e:serve
REPEAT=3 flox activate -- npx --workspace e2e playwright test faces-parity --grep qbrt
REPEAT=3 flox activate -- task e2e:one -- qbrt-ping-audition
REPEAT=3 flox activate -- task e2e:one -- workflow-shell-faces
REPEAT=3 flox activate -- task vrt:one -- qbrt         # inspect BOTH card PNGs
flox activate -- task e2e:stop
```

**The negative controls `qbrt-face-model.test.ts` must carry permanently** — ring: `cutoff` 1000 → 250 Hz ⇒ 82 → 246 ms (a `pingDecay` readback prints 150 ms both times); `resonance` 0.7 → 0.2 ⇒ 82 → 63 ms; `mode` 0 → 1 ⇒ **byte-identical**. Peak: `mode` 0 → 0.5 ⇒ +23.35 → +20.63 dB; `cutoff` ×4 and `pingDecay` ×3 ⇒ **byte-identical**. Plus the source-grep guard: `qbrt.dsp` still contains `* 20.0 + 0.7`, `ev * 30.0` and `igen * 0.98`.

**The audition spec's 0.005 threshold is a measured precedent, not a guess:** `coverage-groups-6-7-8-9.spec.ts:122` already asserts exactly that on qbrt's L output at cutoff 400 / resonance 0.8 / pingDecay 0.1 (`:89-123`). The **before**-assert (peak ≈ 0 before the press) is what makes the instrument non-blind — without it a scope tap reading another node's audio passes a dead button. `fireTrigger`'s default 5 ms triangle (`gate-trigger.ts:35, 53-69`) sits above `GATE_HI` for ~2.4 ms, so `qbrt.dsp:14`'s per-sample detector fires exactly once and re-arms; no `createEdgeCounter` is involved (that rule is for main-thread AnalyserNode rescans).
