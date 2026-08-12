# face re-do — ringback

> **LIVE BACKLOG — not built.** The shipped `face` declares `order`/`pages`/`glyph`/`rear`
> and no `hero`, no `sidebar`, no readout strip. `face.title` does NOT paint by default —
> `facePageHeader()` returns `null` unless annotate mode is on
> (`dock-faceplate-model.ts:90`), owner ruling 2026-08-03.
>
> ⚠ **Owner ruling 2026-08-11** (verbatim at `packages/web/src/lib/audio/modules/rings.ts:585-590`,
> `:645-650`): *"we should prefer almost zero AI authored text, and all future faceplate work
> should reflect that"* and *"lets stop doing these and clean up the existing ones, get rid of
> them. lose the signal flow diagrams."* The two band hints and the `signal-flow` sidebar block
> are struck; what they carried is folded into §1.

**Verdict: MECHANICAL ONLY.** The shipped face is right — the ranking, the pages, the glyph, the
rear card, the ranges and the card are all correct and *measured*, and this spec changes **none of
them**. What it adds is a hero with a two-entry derived readout strip, a `presets` sidebar, and one
small vocabulary fix that the platform's "the dock always prints a value" correction newly exposes.

---

## 1. WHAT THE MODULE ACTUALLY DOES

**One paragraph, musically.** Every other short-delay effect in the rack is trying to be *clean* —
COFEFVE and CHARLOTTE'S ECHOS colour their repeats, SHIMMERSHINE diffuses them, DELAY is
deliberately transparent. RINGBACK is the only one whose entire mechanism is a **MISMATCH**: a
varispeed cursor writes the input into *whole integer cells* and reads those same cells back with
*fractional linear interpolation* at the same position, and everything you hear is the difference
between the two operations. The verb is not "set a time and a feedback"; it is "detune the write
against the read until the signal breaks the way you want".

**The per-sample path, in the DSP's real order** (`packages/dsp/src/lib/ringback-core.ts:125-138`):

1. `n = clampSize(size)` — the ring length, **ROUNDED to a whole number of cells** (`:88-91`).
2. `wet = ringRead(buf, cursor, n)` — the **interpolated read happens FIRST**, at the current
   cursor, so it returns the *previous lap's* content (`:129`, `:46-57`).
3. `ringWriteSpan(buf, cursor, cursor+rate, input + fb*wet, n)` — the write, into every integer
   cell the head sweeps, always at least one (`:132`, `:66-85`).
4. `cursor = (cursor + rate) % n` (`:134`).
5. `out = (1-mix)*input + mix*wet` — a **LINEAR** dry/wet (`:137`, `:104-107`). ⚠ **The DRY copy is
   the raw input and never enters the ring** — turning MIX down does not clean the ring up, it
   fades in an untouched copy.

⚠ **READ precedes WRITE at the same cursor.** Anything that described this as write→read would
teach a zero-latency ring, which is the opposite of the mechanism.

**What each control genuinely changes about the SOUND** (not its label):

| control | what it does to the sound |
|---|---|
| `rate` | the cursor's advance in **cells per input sample**. Below 1, `1/rate` consecutive input samples land in the same cell and only the last survives — the wet path is decimated to `rate × SR` with **no anti-alias filter anywhere**. At and above 1 nothing is discarded, but the write smears across several cells. |
| `size` | the ring length. Small → a high comb tone; large → a grainy smear. **Rounded by the DSP.** |
| `feedback` | how much read-back re-enters the ring on write. Each **LAP** multiplies by this, so the tail is geometric, hard-clamped strictly below 1 (`ringback-core.ts:42, 94-96`). |
| `mix` | dry/wet. Ships at **1 — fully wet**, which is unusual for an insert. |

**The measurable facts worth printing.** The quantity a player actually hears is the ring's **LAP**
— `clampSize(size) / rate` input samples, the period of the comb — and the def already says in
prose that no per-param formatter can express it (`ringback.ts:99-105`). The *duration* of the
regenerated tail is `lapsToSilence(feedback) × lap`, three params. Both are §5.

**Nothing is inert at spawn**, and it is *pinned*: `ringback-crush-model.test.ts:532-544` moves each
of the four defaults in turn and asserts the output deviates by > 0.01, precisely so the VCA face's
REACHABILITY argument cannot be borrowed here. Timbral sensitivity, measured on the real per-sample
core over a C4 saw: **rate 5.05× · size 4.76× · mix 3.28× · feedback 2.18×** (`:515-530`).

**A "stereo" fact the module's surfaces overstate.** Both `RingChannel`s run *identical* params and
a mono input is mirrored to both (`packages/dsp/src/ringback.ts:72, 95-96`), so a mono source gives
`L === R` — RINGBACK adds no width. (The separate defect that the two output *jacks* did not carry
separate channels is FIXED — §9.1.)

**Card.** `RingbackCard.svelte` is 101 lines: four `Knob`s whose min/max/defaultValue/curve/units/
format all come from `paramSpec(ringbackDef, …)` (`:31-34, 59-70`). **Zero re-typed range
numbers** — the only literals are CSS. It is in both `RANGE_BOUND_CARDS` and `MAPPING_BOUND_CARDS`.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

Largely: **nothing.** `face.order` is derived from a measured sensitivity ranking and *checked
against the DSP* rather than argued in a comment (`ringback-crush-model.test.ts:515-530`);
`glyph: 'scope'` is an empirical claim with a two-directional instrument negative control (`:477-513`
— an RMS meter moves 3.96 dB across RATE's whole range while the waveform's roughness moves 5.05×);
the rear card's three bands and its four `~` ticks are pinned (`:445-467`) and the `audioRate` claim
is checked against the worklet's *read pattern*, not just its descriptors (`:325-348`). The genuine
gaps are all platform-shaped — the face was authored before the platform existed:

1. **No `hero`, and the committed baseline shows the cost.** In the committed
   `face-ringback-dock` PNG the dock's first band is a ~216 px scope glyph sitting alone in a
   ~1160 px band — **roughly 80 % of the top band is empty**. That is a measurement off the
   committed PNG, not pixel arithmetic.
2. **No readout strip**, on the one module in the rack whose defining quantity (the LAP) is a
   *ratio of two params* that no per-param formatter can express.
3. **SIZE prints no readout at all today** — the platform already overturns that
   (`e2e/tests/ringback-face.spec.ts` asserts `64.0 smp` at the dock and `toHaveCount(0)` in the
   lane). That is mechanical and correct; §7 refines the *string*.

`order` and `pages` are identical here, and that is deliberate and explained (`ringback.ts:161-165`)
— the signal flows ring-then-blend, which is also the priority order. Do not "fix" one to match the
other.

---

## 3. THE CONTROLS THAT MATTER

**This module has FOUR params.** There is no top-8 and no cut line — every control is on every dock
face. The ranking decides only the lane tiers, and it is already derived rather than declared.

| rank | key | why it earns the rank (an argument that would be wrong elsewhere) | what it costs below |
|---|---|---|---|
| 1 | `rate` | the mismatch **is** the module; it is also the single param the output waveform is most sensitive to (5.05×, measured over the real core). An RMS meter is nearly blind to it, which is why the glyph is a scope and not the FX-family default. | takes the mini tile's one cell. |
| 2 | `size` | `rate` and `size` are not two knobs but one sound: the ring laps every `size/rate` samples, so the comb pitch is their **ratio** and neither is readable without the other. Putting both on the compact tile is what makes the tile playable. | costs the compact tier its third cell (2 beside a glyph, 3 without) — the ranking's central purchase. |
| 3 | `feedback` | shapes the crush (it is summed *into* the write, `ringback-core.ts:132`) rather than deciding how much of it you hear. | ranks 3 and 4 are tier-identical (the plate holds 6), so this only decides the 3×2 layout. |
| 4 | `mix` | ranked last **for the plate's sake**: the three controls that shape the crush take row one and the one that decides how much you hear sits alone on row two. | none. |

**THE LOSERS, NAMED.** None. Four params, four ranks, and the two that did not reach the compact
tile (`feedback`, `mix`) lost on a *measured* margin — sensitivity rank 2 (`size`, 4.76×) beats rank
3 (`mix`, 3.28×) by 45 %, and `ringback-crush-model.test.ts:529` pins that gap at > 1.2× so a
re-rank has to re-argue the property rather than edit a literal.

**The counter-argument, restated because it is real and already rejected in code.** The module
spawns fully wet, so one could rank `mix` first on REACHABILITY grounds — the way the VCA face does.
That does not transfer: the VCA spawns at `base = 0`, silent, with every other cell inert, whereas
nothing here is inert at spawn (`:532-544`). A mini tile whose one control is the bypass can only
make the module quieter. **If you disagree: move `'mix'` to the front of `order` and change nothing
else.**

---

## 4. BAND STRUCTURE

Unchanged from what ships (`ringback.ts:227-230`) — two bands, ids `ring` and `output`, neither
colliding with the curated rear group id `signal` (`:252`), so the leading rear band is claimed
once. Two bands is far under `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:46`), so this face is
never tabbed.

```ts
pages: [
  { id: 'ring',   label: 'crush ring',   controls: ['rate', 'size', 'feedback'] },
  { id: 'output', label: 'output blend', controls: ['mix'] },
],
```

⚠ `rate` **stays listed in `pages[0].controls`** even though the hero promotes it. `heroFacePlan`
can only MOVE a key some band already claims; leaving it off would drop it into the defensive
`__unpaged` band. After promotion band 1 renders `size, feedback` and band 2 renders `mix` — 3 in
bands + 1 in the hero = 4, the multiset faces-parity asserts.

`crush ring` and `output blend` are *names* that say what the group is. Both facts that would
otherwise have been prose have a permanent numeric home: the SIZE ÷ RATE ratio is the **LAP
readout** (§5), and "the dry never enters the ring" is §1 step 5.

---

## 5. THE HERO + THE READOUT STRIP

**No bespoke `hero.cell` PICTURE.** The generic `scope` glyph is what this module would otherwise
use, and it is **not suppressed** — `heroGlyph = hasGlyph && !(view === 'dock-full' && hero?.cell)`
(`ModuleShell.svelte:353`) — so a hero with **no `cell`** keeps the scope in the picture bay and
fills the rest of the rail. A bespoke "ring diagram" panel would cost a ~400-line component (cf.
`KickdrumHeroPanel.svelte`, 401 lines), a `shell-cells.ts` registration and a rank-7 key, to show
what the scope already shows. Not earned for a four-knob effect. *Caveat:* the scope flatlines on a
silent rack (visible in the baseline) — true of every FX glyph, a platform property rather than a
ringback defect.

**`hero.control: 'rate'`** — rank 1, the mismatch itself, and the param the picture beside it is
most sensitive to. Promotion puts a 64 px dial with a 17 px readout beside the trace it drives.

**`hero.action`: NONE.** RINGBACK is an insert with no internal source and no trigger — there is
nothing to audition. (`getActiveEngine()` at `engine-ref.ts:23` is reachable from a plain `.ts`
module, so this is *not* a platform blocker; the module simply has nothing to play.)

### THE READOUT STRIP — full-width, directly beneath the graphic

Two entries. Both are **DERIVED**, and both exist because the *honest* per-param formatters this
module already ships are structurally unable to express them.

```ts
readouts: [
  { label: 'lap',  valueId: 'ringback-lap'  },   // 128 smp at the defaults
  { label: 'tail', valueId: 'ringback-tail' },   // 735 smp at the defaults
],
```

#### `ringback-lap` — the ring's LAP, in input samples

**FORMULA:** `clampSize(size) / clamp(rate)`. Traced: `RingChannel.step` sets `n = clampSize(size)`
(`ringback-core.ts:126`) and advances `cursor = (cursor + rate) % n` (`:134`), and `step` is called
**once per input sample** (`packages/dsp/src/ringback.ts:86-96`) — so the cursor returns to its
start after exactly `n / rate` input samples. The `clampSize` **round** (`:88-91`) is part of the
formula, not a nicety: a dial at 63.7 runs as 64 cells and the readout must say what the DSP does.
Formatting: `< 10` → one decimal (`0.5 smp` at the floor); `< 10000` → integer (`128 smp`); above →
`82k smp` (the ceiling is `4096 / 0.05 = 81920`).

**THE NEGATIVE CONTROL — three legs, permanent in `ringback-crush-model.test.ts` (new group 6):**
- *A* — hold `rate`, move `size` 64 → 256: must move (128 → 512 smp). A `paramId: 'rate'` readback
  is **blind** here.
- *B* — hold `size`, move `rate` 0.5 → 1: must move (128 → 64 smp). A `paramId: 'size'` readback is
  **blind** here.
- *C (must NOT move)* — sweep `feedback` 0 → 0.98 and `mix` 0 → 1: byte-identical. This proves the
  function reads exactly the two params it names.

#### `ringback-tail` — how long the regeneration survives, in input samples

**FORMULA:** `max(1, ln(0.001)/ln(feedback)) × lap`. The geometric decay is already modelled
(`ringback-crush-model.ts:152-156`); this uses the **continuous** lap count, not the rounded
`ringLapsToSilence`, because that rounding exists for the knob caption's 7-glyph budget (`:158-168`)
and reusing it would quantise the tail in 128-sample steps. At `feedback ≤ 0` the crushed copy is
heard for exactly one lap before it is overwritten, consistent with the shipped `1 PASS` caption
(`:180`). At the defaults: `5.742 × 128 = 735 smp`.

**WHY THIS IS THE STRONGEST DERIVED READOUT HERE.** The FEEDBACK dial already prints `6 LAPS`. That
caption *reads* like "how long it rings" and is **INVARIANT to SIZE and RATE**, which genuinely
change the answer — the kickdrum `tail`/`sub_decay` trap, already shipped on this module's own dial.
The formatter did the only honest thing available to it (it says LAPS, and its doc explains why,
`:143-147`); the strip is where the missing factor arrives.

**THE NEGATIVE CONTROL — three legs, same location:**
- *A* — move `size` 64 → 256 with `feedback` fixed: the tail must move (735 → 2940 smp) **while
  `formatRingbackFeedback` still returns exactly `6 LAPS`**. This is the leg that distinguishes the
  two models, and it must be asserted against the shipped formatter's output, not just a number.
- *B* — move `feedback` 0.3 → 0.9: must move (735 → 8400 smp).
- *C (must NOT move)* — sweep `mix` 0 → 1: byte-identical. `mix` is downstream of the ring
  (`ringback-core.ts:137`) and cannot change how long it rings.

#### Why no third entry, and why no Hz

A third entry would be repetition: `rate` prints `SR/2.0` at 17 px in the hero dial directly above,
and `mix`/`feedback` print their own vocabulary under their dials in the bands below. **TASTE CALL,
one-line revert:** if the spawn-fully-wet surprise deserves the most-read line, append
`{ label: 'wet', paramId: 'mix' }` and change nothing else.

**Hz is REJECTED on a real constraint, not a preference.** A `FaceReadoutValue` is
`(read: (paramId) => number | undefined) => string` (`face-readout-values.ts`) — pure, no DOM,
engine or context — so the hardware **sample rate is unreachable**, and there is no nominal-SR
constant in `$lib/audio` to borrow (the only literals are `dx7-render.ts:45`'s opt default and
`midi-timing.ts:32`'s render quantum). Hardcoding 48 kHz is wrong by ~1.5 semitones on 44.1 kHz
hardware. Samples are exact and SR-independent. **If the reader is ever widened to carry a context
sample rate, `375 Hz @48k` becomes available — a follow-up, not a blocker.**

**The other candidate, settled: RINGBACK HAS NO BIT DEPTH.** `ringWriteSpan` stores Float32
values unmodified (`ringback-core.ts:80-84`) — there is **no amplitude quantisation anywhere** in
this module. The "bitcrushed" character is *entirely* time-domain. An "effective bit depth" readout
would be a fabricated quantity. The sample-rate *corner* does exist, but it is exactly what
`formatRingbackRate` already prints on the hero dial as `SR/2.0` (`ringback-crush-model.ts:131-136`).

---

## 6. THE SIDEBAR — `presets` only

The `signal-flow` block this spec proposed is **struck by the 2026-08-11 owner ruling.** Its two
correctness payloads — READ precedes WRITE at the same cursor, and DRY is a parallel branch that
never enters the ring — are §1 steps 2/3 and 5.

**`presets` — the one genuinely new declaration, and the argument for it is a measured fact the UI
currently cannot reach.** The module is at its **smoothest at INTEGER rates** (normalised roughness
0.290 / 0.256 / 0.235 / 0.221 at 1 / 2 / 3 / 4, against the dry saw's own 0.255) and rough in
between (0.805 at 1.25) — measured, and stated in `ringback-crush-model.ts:120-129`. The dial is
**not detented and has no tick to aim at**; today that finding is reachable only by reading the doc
page. A preset roster is the surface that makes it playable. Four params means every entry is a
**complete** recall by construction:

```ts
{
  kind: 'presets',
  label: 'presets',
  entries: [
    { id: 'sr-half',  label: 'SR/2 CRUSH',    note: 'ships here', values: { rate: 0.5,  size: 64,   feedback: 0.3,  mix: 1   } },
    { id: 'clean-comb', label: 'CLEAN COMB',  note: 'rate 1',     values: { rate: 1,    size: 64,   feedback: 0.45, mix: 1   } },
    { id: 'octave-down', label: 'OCTAVE DOWN', note: 'rate 2',    values: { rate: 2,    size: 256,  feedback: 0.5,  mix: 1   } },
    { id: 'grain-smear', label: 'GRAIN SMEAR', note: 'long ring', values: { rate: 0.35, size: 2048, feedback: 0.55, mix: 0.7 } },
    { id: 'metal-drone', label: 'METAL DRONE', note: 'ringing',   values: { rate: 0.05, size: 8,    feedback: 0.96, mix: 1   } },
  ],
}
```

Every value is inside its declared range (`RINGBACK_RATE` 0.05..4, `RINGBACK_SIZE` 2..4096,
`RINGBACK_FEEDBACK` 0..0.98, `RINGBACK_MIX` 0..1 — `ringback-crush-model.ts:68-86`), which
`module-face-lint`'s preset clause checks. **If you disagree: drop the block** — `sidebarPlan`
returns `null`, the editor goes full-width, and nothing else in this spec moves.

**`custom` / `stereo-crossover`: NO — and it is kickdrum-specific in substance.** The registry
comment calls it "generic across any def that declares a crossover frequency + a width param"
(`sidebar-panels.ts`), and RINGBACK has **neither**. There is no crossover, no M/S stage and no
width anywhere in the core; both channels run identical params
(`packages/dsp/src/ringback.ts:95-96`). **`readouts` sidebar block: NO** — it would duplicate the
strip.

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

**Ranges, curves, options, landmarks: ZERO changes.** They live in exactly one place already —
`$lib/audio/ringback-crush-model`, which sources `size` and `feedback` from the DSP core's own clamp
constants (`ringback-crush-model.ts:41-45, 71-83`), and the def *and* the card both import it. The
worklet's third copy is parsed out of `packages/dsp/src/ringback.ts` and compared
(`ringback-crush-model.test.ts:254-303`), with a negative control that perturbs the source and
confirms the check moves (`:288-296`).

**Card grep for re-typed range numbers: ZERO found.** `RingbackCard.svelte:31-34` builds four
`paramSpec` objects off `ringbackDef` and passes `pRate.min` / `.max` / `.defaultValue` / `.curve` /
`.units` / `.format` through (`:59-70`). Not agreement-by-maintenance — agreement by construction.

**ONE vocabulary change, and it is created by the platform correction itself.** `size` deliberately
declares no `format` (`ringback.ts:99-105`), on the argument that the quantity a player hears is
`size/rate`. That argument is about the **comb pitch**, not the ring **length** — and the dock now
prints a number for `size` regardless (`knobValueReadout`, `knob-vocabulary-model.ts`). So the
choice is no longer "print or not"; it is "print the raw ladder" vs "print what the DSP runs". The
DSP **rounds** (`ringback-core.ts:88-91`), so a dial at 63.7 would print `63.7 smp` beside a ring
that is 64 cells — the exact surface-disagrees-with-model class the platform exists to end, worst
at small sizes where 0.5 samples is 5–25 % of the ring. Add:

```ts
export function formatRingbackSize(size: number): string {
  return `${clampSize(size)} smp`;      // what the ring ACTUALLY runs
}
```

…and give `size` `format: formatRingbackSize`. **`format` is UI vocabulary and
contract-transparent** — `contract-signature` reads only id/min/max/curve/defaultValue/units
(`ringback.ts:94-97`) — so this costs zero contract-lock lines. ⚠ **This changes
`e2e/tests/ringback-face.spec.ts`'s assertion from `'64.0 smp'` to `'64 smp'`** — that edit is part
of this work, not a surprise. *Alternative, stated:* leave `size` formatless; the divergence is
≤ 0.5 samples and only visible mid-drag.

---

## 8. COST

- **contract-lock delta: ZERO.** `face` is UI metadata with no branch in `contract-signature.ts`;
  `format` is likewise contract-transparent (`ringback.ts:94-97`). No new `ParamDef`, `PortDef`,
  `ControlFamily` or `edge:`.
- **VRT.** `face-ringback-dock` **moves** — a hero rail + a strip is far over `DOCK_MAX_DIFF = 1500`
  and probably a **height** change, which Playwright hard-fails on before it computes a ratio. The
  baseline is committed, so **`git rm` it first** (`--update-snapshots` cannot rewrite a baseline it
  does not fail on) and let the linux capture job author the replacement.
  **Must NOT move:** `face-ringback-compact` (the hero is dock-only) and `vrt.spec.ts/ringback.png`
  (the card is untouched apart from the `size` format string, which `RingbackCard.svelte:29-30`
  documents as **zero-pixel** — `Knob` renders its value tag only inside `{#if dragging || hovering}`
  and no VRT scene hovers). **A diff on either is a FINDING, not a re-pin.**
  **No required-lane baseline moves:** `workflow-shell-faces.spec.ts` is in `FULL_MATCH` only, not
  `STRICT_MATCH` (`e2e/vrt/vrt.config.ts:37`), and `ringback` is not in `STRICT_VRT_MODULES`.
  ⚠ `face-ringback-dock` is one of the two scenes that aborted the 2026-08-09 regen on the
  `AudioContext is 'running', not 'suspended', at CAPTURE time` guard. The sweep is ONE job — that
  scene failing means nothing is committed. Fix whatever leaves the context running before
  dispatching.
- **e2e.** faces-parity cell count **UNCHANGED** — 4 params, and `hero` promotes rather than copies
  (`heroFacePlanIsTotal`). `workflow-shell-faces.spec.ts:68`'s `{ type: 'ringback', pages: 2 }`
  structural gate is unchanged. `ringback-face.spec.ts` gains hero + strip assertions and the
  `64 smp` string edit; no new spec file.
- **CI wall-time: ≈ 0.** Unit additions are pure arithmetic in an existing spec file (< 50 ms); the
  e2e adds assertions to tests that already boot.
- **ART: NIL — confirmed, not assumed.** `art/scenarios/ringback/profile.test.ts:24-25` pins
  `dspSourceSha` over the **worklet entry + the core lib** only; the web def is not in that basis,
  so a `face:` edit cannot move `out.sha`.
- **Attest: NIL.** An AUDIO def — the WebGL basis is video defs, the collab basis is
  persistence/store/snapshot/mutate/duplicate/doom-sync.
- **Push 2: NIL, stated because CLAUDE.md flags the class.** `ringback` has no `PUSH_CARD_CONTROLS`
  entry, so its card is generic-tier resolved from the live def — but this spec adds **no param**,
  so it cannot re-rank.
- **Docs: NIL.** No new port/param/family ⇒ `contract-lock.txt`, `module-docs-lint` completeness and
  `STRICT_DOCS` unchanged. The `size` docs entry (`ringback.ts:275`) already explains the rounding.

---

## 9. DEFECT LEDGER

**9.1 · `out_l` and `out_r` were the SAME two-channel output. ✅ FIXED — AND SO IS TWOTRACKS.**
Both output ports used to map to `{ node: worklet, output: 0 }` while the worklet was built with
`outputChannelCount: [2]`, so: patching **only** `out_l` delivered **both** channels (which is why
it shipped); patching `out_l` and `out_r` into two mono destinations downmixed each to `(L+R)/2`,
**collapsing the stereo image to mono at both jacks**; and patching both into one destination summed
the pair with itself (+6 dB). `ringback.ts:295-310` now builds a `ctx.createChannelSplitter(2)` with
a comment quoting the finding nearly verbatim, and the outputs map is `splitter/0` + `splitter/1`
(`:329-330`).

⚠ The spec's other half — *"inherited from TWOTRACKS — fix both or neither"* — was unverified at the
time and is **now VERIFIED: TWOTRACKS IS ALSO FIXED.** `twotracks.ts:373` builds
`ctx.createChannelSplitter(2)` and `:596-598` maps `out_l` → `splitter/0`, `out_r` → `splitter/1`.
Its comment (`:355-372`) is the fuller write-up — it records that the INPUT side was always right
(reel A takes worklet inputs 0/1, reel B 2/3), which is what makes it an output-side mistake rather
than a mono design, and it closes with *"Same failure and same fix as RINGBACK — see ringback.ts."*
Both halves are paid.

*Kept for the next reader:* the reason nothing caught it. `per-module-per-port` only asserts an edge
materialises; the ART profile renders **one** channel and says so
(`art/scenarios/ringback/profile.test.ts:17-20`); no unit test read the outputs map. A test that
would: a factory unit test asserting the two entries resolve to **distinct** `(node, output)` pairs,
plus an e2e patching a hard-panned stereo source through RINGBACK into two analysers and asserting
they differ. And the reason it survived review: both `RingChannel`s run identical params and a mono
input is mirrored (`packages/dsp/src/ringback.ts:72`), so a **mono** source gives `L === R` and the
bug is inaudible.

**9.2 · NEGATIVE RESULT, recorded so the next reader does not re-open it.** `mixSample` is a
**linear** dry/wet (`ringback-core.ts:104-107`) where DELAY was moved to equal-power in #1174. That
is correct here for the shipped defaults: the wet path is a *near-copy* of the dry delayed by `size`
samples (**1.3 ms at the default 64**), so the two are strongly correlated and equal-power would
**boost** the midpoint. At the top of the SIZE range (4096 ≈ 85 ms) they decorrelate and the
argument weakens — but the module ships at `mix = 1`, so the midpoint is rarely visited.
**No change.**

---

## 10. VERIFICATION GATE

```sh
# 1. the model: readouts, lane fit, def↔worklet ranges, the a-rate claim, the face,
#    and the TWO NEW derived readouts with their three-leg negative controls (§5)
flox activate -- task test:one -- ringback-crush-model
REPEAT=3 flox activate -- task test:one -- ringback-crush-model     # flake-check the NEW group
# 2. the platform gates the new declarations answer to
flox activate -- task test:one -- module-face-lint      # hero ranked/promoted-once; presets in range
flox activate -- task test:one -- dock-faceplate-model  # hero split totality
flox activate -- task test:one -- card-range-source     # the card still re-types nothing
# 3. typecheck — svelte-check is stricter than vitest
flox activate -- task typecheck
# 4. e2e against ONE warm server
flox activate -- task e2e:serve
REPEAT=3 flox activate -- task e2e:one -- tests/ringback-face.spec.ts   # incl. the '64 smp' edit (§7)
flox activate -- npx --workspace e2e playwright test faces-parity --grep ringback
flox activate -- npx --workspace e2e playwright test per-module-per-port --grep ringback
# 5. VRT — the baseline exists and will fail on DIMENSIONS, so remove it first
flox activate -- git rm e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-ringback-dock.png
flox activate -- task vrt:one -- face-ringback      # local smoke; then `git status` for untracked PNGs
flox activate -- task e2e:stop
flox activate -- task vrt:commit
```

**The two assertions that must come back GREEN-UNCHANGED**, and which are findings if they do not:
`face-ringback-compact` (the hero is dock-only) and `vrt.spec.ts/ringback.png` (the legacy card's
value tag renders only on hover, so the `size` format edit is zero-pixel).

**The negative control a reviewer should run by hand before believing the strip:** open the dock,
move **SIZE** only, and confirm the `tail` readout moves while the FEEDBACK dial still reads
`6 LAPS`. If `tail` sits still, it has been wired to `feedback` and the whole derivation is a knob
relabelled.
