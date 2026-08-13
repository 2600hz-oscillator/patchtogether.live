# face re-do — karplus

> **LIVE BACKLOG — not built.** The shipped `face` declares `order`/`pages`/`glyph`/`rear`
> and no `hero`, no `sidebar`, no readout strip. `face.title` does NOT paint by default —
> `facePageHeader()` returns `null` unless annotate mode is on
> (`dock-faceplate-model.ts:90`), owner ruling 2026-08-03.
>
> ⚠ **Owner ruling 2026-08-11** (verbatim at `packages/web/src/lib/audio/modules/rings.ts:585-590`,
> `:645-650`): *"we should prefer almost zero AI authored text, and all future faceplate work
> should reflect that"* and *"lets stop doing these and clean up the existing ones, get rid of
> them. lose the signal flow diagrams."* The page hints and the `signal-flow` sidebar block
> this spec proposed are struck; what they carried is kept as measurements in §1 and §9.

**Verdict: REAL REWORK** — the ranking, the bands and the audition are already right and stay
byte-identical; what this face is missing is the hero + readout strip, and the one thing it has
instead — a `scope` glyph on a module that is MUTE until something strikes it — is a flat line in
every dock baseline it ships. Proposal: promote DECAY + the PLUCK into the hero, add a bespoke
PARTIAL-LADDER picture, and print three DERIVED numbers (ring · damping · exciter) that turn three
abstract knobs into physical units.

---

## 1. WHAT THE MODULE ACTUALLY DOES

An extended Karplus–Strong (CCRMA EKS) string. There is **no oscillator and no envelope
generator**: a seeded noise burst is fired into a recirculating fractional delay line and
everything you hear is that burst dying. The whole per-sample chain is `karplusStep`
(`packages/dsp/src/lib/karplus-dsp.ts:376-472`), in this order:

1. **strike edge** (`:388-396`) — per-sample `prev<0.5 && cur>=0.5`; reseeds the burst RNG, resets
   the colour pole, latches ACCENT and latches the burst length `max(2, round(burst·sr/f0))`
   samples (`:392`). The ring-over is deliberately NOT cleared.
2. **exciter** (`:400-419`) — xorshift noise → COLOR one-pole at `200·50^color` Hz (`:405-410`),
   energy-normalised `1/√burst` (`:415-417`).
3. **pick comb** (`:422-427`) — `e[n] − e[n−β·N]`, a second cofefve `DelayChannel`, feed-forward on
   the EXCITER only. Zeros at every `(1/β)`-th partial: β = 0.2 nulls partials 5/10/15…, β = 0.5
   nulls the even harmonics.
4. **the loop** — delay tap (`:430-433`) → BRIGHT damping one-pole at `fc = f0·2^(0.5+5.5·B)`,
   capped at `0.45·sr` (`:286-288`) → two STIFF dispersion allpasses (`:442-450`) → an f0-tracked
   DC blocker at `f0/20` (`:453-457`) → `× g` back into the line (`:466-468`).
5. **the loop gain** (`:462-466`) — `ρ = 0.001^(1/(f0·t60))` (Jaffe–Smith) divided by the loop
   stages' own magnitude at f0, then **clamped to `KARPLUS_G_MAX = 1.1`** (`:99`). That clamp is
   the single most consequential fact on the faceplate — §5.
6. **output** (`:471`) — `return tap * 10^(level/20)`, where `tap` was read at `:430`, **BEFORE**
   the damping filter at `:437`. ⚠ **The output is a PARALLEL branch off the line, not the chain's
   end** — you hear the raw line tap, which is why the docs call it "the brightest point of the
   loop" (`karplus.ts:271`). Any diagram drawn inline after `× g` would teach the opposite.

Pitch: `karplusF0` (`:362-365`) clamps TUNE to 55–1760, multiplies by `2^pitchCv`, then clamps to
`KARPLUS_F0_MIN = 30` … `_MAX = 4200` (`:88-89`). **With no cable in `pitch` the outer clamp is
unreachable** — 55 > 30 and 1760 < 4200 — so it only bites under a patched 1 V/oct. `pitch` is the
one input read RAW per sample (`packages/dsp/src/karplus.ts:150`); all eight knob CVs pass an
80 Hz `WtParamSmoother` (`:99`), which is what `face.rear.audioRate: ['pitch']` says.

**Load-bearing vs incidental.** DECAY and BRIGHT are the instrument (there is no other envelope,
and BRIGHT decides both the material AND — through the g-cap — whether DECAY is telling the
truth). COLOR + BURST are the exciter and the second-biggest character move. POS is a per-hit
comb. LEVEL is the only trim on a voice with **no output bound at all** (`:471` is a bare gain —
no ceiling, no tanh, unlike kickdrum/snaredrum).

**Inert at spawn — settled, because the shipped face test asserts one of these and not the other:**
- `stiffness` (default 0) **IS inert**: `karplusStiffA` returns exactly 0 (`:137`), the allpasses
  degenerate to unit delays and `karplusDelayTarget` subtracts exactly 2 samples for them. A
  topology no-op. `karplus-face.test.ts:125-129` pins this.
- `position` (default 0.2) is **NOT inert**, and nothing says otherwise. At β = 0.2 the comb nulls
  partials 5, 10, 15… of every hit (`:422-427`), which is audible at the default patch. Ranked 8th
  because it is "a per-step CV target, not a knob you ride" — that argument stands and the rank
  keeps, but do **not** restate it as inertness.
- `level` (0 dB → `10^0 = 1`) is numerically inert but is the module's only loudness control.

---

## 2. WHAT THE CURRENT SHIPPED FACE GETS WRONG

The face (`packages/web/src/lib/audio/modules/karplus.ts:182-238`) is **largely right**. Its
ranking (`:183-197`), its two bands (`:198-201`) and its rear (`:228-237`) all survive this re-do
unchanged. The genuine gaps:

- **No `hero`, no `sidebar`, no readout strip.** The dock renders the pre-platform layout: a
  capped glyph band, then two bands of bare knobs.
- **The `glyph: 'scope'` is a flat line exactly when you look at it.** karplus has no exciter, so
  an unpatched, unplucked karplus is MUTE, not quiet; `workflow-shell-faces.spec.ts:16-22` states
  outright that no audio flows in those scenes, so the committed dock baseline shows the flat
  centreline. Same argument `types.ts` makes for the dx7 `'algorithm'` glyph literal ("a 64 px
  scope trace … FLATLINES whenever nothing is gated") — with more force here, because on karplus
  *nothing is ever gated by default*. And four of the eight knobs (BRIGHT, POS, STIFF, COLOR) have
  purely SPECTRAL effects a time-domain trace could not show even when it is live.
- **Three knobs print in units nobody can act on.** BRIGHT reads `0.70` where the number that
  matters is *4.5 kHz, tracking the note*; BURST reads `1.00` where it is *4.5 ms, also tracking
  the note*; DECAY reads `2.00 s`, true until BRIGHT drops below ~0.11 and then a lie (§5).
- The `:160-169` glyph comment and the `:110-115` "order and pages disagree on purpose" block were
  both corrected in round 2 and need no edit.

Nothing here is a re-ranking. **If you were expecting a redesign of the knob layout, there isn't
one, and that is the correct answer.**

---

## 3. THE ~8 CONTROLS THAT MATTER

| rank | key | why it earns this rank (an argument that is WRONG for another module) | what it costs below |
|---|---|---|---|
| 1 | `decay` | This module has NO envelope generator. The ring-out *is* the note's shape — there is nothing else to shape it with. (Wrong for tomtom/kickdrum: they have layer envelopes AND a decay knob.) | — |
| 2 | `brightness` | The material — and the ONE knob that can shorten a note behind DECAY's back through the `G_MAX` clamp (`karplus-dsp.ts:466`). It is rank 2 because it silently overrides rank 1. | — |
| 3 | `tune` | Which note when nothing is patched to 1 V/oct. A set-once transpose in a rack: the note usually arrives on the pitch in, so it loses to the two knobs you ride. | pushes COLOR/BURST down |
| 4 | `color` | The pick's tone: a 200 Hz felt mallet ↔ a 10 kHz hard pick. On a string, HOW you hit it is the second axis of the instrument. | — |
| 5 | `burst` | Its length, in PERIODS — tick ↔ pluck ↔ scrape. Measured in periods rather than ms, so it is the one control whose real effect changes with the note. | — |
| 6 | `level` | `out` is a bare gain (`:471`) with no ceiling anywhere, and the two knobs that cause the loudness swing — DECAY and BRIGHT — are ranks 1 and 2 **in the same tile**. A lane that can create the problem and not correct it is an incomplete performance surface. (Wrong for kickdrum, which ends in a true-peak `tanh`.) | takes rank 6 from POS |
| 7 | `karplus-strike-{n}` | The defining affordance, ranked FIRST OUT of the lane. `ModuleShell` paints a lane `action` as a bare `▸` with no caption, so promoting it buys a mystery glyph and costs LEVEL its slot. Rank 7 buys a captioned `pluck` button under a band header that names it — and now, the hero slot. | — |
| 8 | `karplus-string-{n}` | NEW panel (§5). It sits behind the audition because that is the faceplate's reading order: hear it, then see what it is. | — |
| 9 | `position` | Its own docs ask for a per-step S&H rather than a hand on the knob (`karplus.ts:256`), and it colours each hit rather than the ring-out (`:281`). A sound-design choice, not a ride knob. | — |
| 10 | `stiffness` | The only genuinely inert-at-spawn control (`a = 0` exactly), and its travel LEAVES the instrument ("detuned metallic clang and bell", `:283`). A destination you set, not one you ride. | — |

**THE LOSERS, NAMED.** `position` and `stiffness` lose the lane, above, with module-specific
arguments. Nothing else exists to lose: the worklet exposes exactly the eight def params
(`karplus.test.ts` pins `parameterDescriptors.length === karplusDef.params.length`), so there is
**zero un-exposed DSP capability** to promote. That is a finding, not a shortfall.

---

## 4. BAND STRUCTURE

The RANKING is the shipped one with the new panel spliced in at 8 — one added key, nothing
re-ranked:

```ts
order: [
  'decay', 'brightness', 'tune', 'color', 'burst', 'level',   // ranks 1-6 = the WHOLE lane budget
  'karplus-strike-{n}',        // 7 — the first rank a lane cannot reach, deliberately
  'karplus-string-{n}',        // 8 — the new panel
  'position', 'stiffness',
],
pages: [
  { id: 'string', label: 'string · ring',
    controls: ['karplus-string-{n}', 'tune', 'decay', 'brightness', 'stiffness'] },
  { id: 'pick',   label: 'pick · strike · out',
    controls: ['karplus-strike-{n}', 'color', 'burst', 'position', 'level'] },
],
```

The BANDS are unchanged from shipped except that the hero PROMOTES three keys out of them (it does
not copy them — `heroFacePlan`, `dock-faceplate-model.ts:127`).

**The three facts that would have been prose all have a second, numeric home.** "There is no
envelope generator" is carried by DECAY sitting in the hero as the module's biggest control. "The
loop-gain cap shortens the note" is carried by the `ring` readout printing 0.29 s while DECAY reads
10.0 s. "BURST is in periods" is carried by the `exciter` readout printing 4.5 ms. Band labels stay
names — `string · ring`, `pick · strike · out`.

Page ids `string`/`pick` collide with neither `voice` nor `signal`, so the rear leading-band
double-render scar stays clear.

---

## 5. THE HERO + THE READOUT STRIP

### THE PICTURE — `hero.cell: 'karplus-string-{n}'`, a new PF-14 panel. LEGITIMATE.

**But only half of the obvious picture is.** A *delay-line block diagram* — line, damping filter,
allpasses, feedback arrow — is **decoration**: it teaches the algorithm, and (under the 2026-08-11
ruling) the platform will not be drawing algorithms at all.

What only this module can draw is the **PARTIAL LADDER**: the string's actual resonances on a log
frequency axis — each partial at its **real** frequency (stretched by STIFF through the same
allpass phase-delay law `karplusDelayTarget` uses, `karplus-dsp.ts:344-359`), not at `k·f0`; the
BRIGHT damping rolloff as the envelope over them, with the `0.45·sr` cap visible where it bites;
the POS comb nulls notched into the excitation weighting; and the COLOR exciter pole as a fainter
second envelope. All four otherwise-invisible knobs move it, and a hero `cell` SUPPRESSES the dock
glyph automatically (`ModuleShell.svelte:353`) — the outcome we want, since that glyph is the flat
line of §2.

**Cost:** one Svelte component + one `shell-cells.ts` panel spec + `+1` contract-lock family line
(`kind=cell`, the `kickdrum-hero` shape) + one faces-parity cell. A panel must declare a `probe`;
use the kickdrum precedent — a **span toggle** (partials 1–8 / 1–24, a private view setting) with
`{ kind: 'text', testid: 'karplus-ladder-axis', expect: 'changed' }`, i.e. drive the button and
assert the axis labels moved.

**ONE-LINE REVERT if you disagree:** drop `hero.cell` and the `karplus-string` family. The hero
keeps DECAY + PLUCK + the strip, the `scope` glyph comes back as the dock hero, and the contract
delta goes to zero.

### `hero.control: 'decay'` · `hero.action: 'karplus-strike-{n}'`

DECAY because it is rank 1 for a reason no other voice shares — it *is* the envelope — and because
the `ring` readout directly under it is the number that says whether the dial is currently
telling the truth. The pairing is the argument. The PLUCK because karplus is the one voice in the
rack that is **MUTE**, not quiet, until something strikes it.

### THE READOUT STRIP — three entries, all DERIVED

All three read the DURABLE param values only: `readoutValue` (`ModuleShell.svelte:368`) calls
`params.paramVal(pid)`, deliberately **not** the live AudioParam. So no readout here can see a
patched CV, and any derivation must be a pure function of `{tune, decay, brightness, burst}` +
a NOMINAL sample rate. Model module: `packages/web/src/lib/ui/modules/karplus-face-model.ts`,
importing the exported laws from `../../../../../dsp/src/lib/karplus-dsp` by relative path (the
`kickdrum-face-model.ts` precedent) and resolving def defaults for untouched params.

`export const KARPLUS_FACE_SR = 48000;` — the readouts have a sample-rate invariance the DSP does
not. Measured deviation 44.1 kHz vs 48 kHz: **0.00 %** at the defaults, 0.06 % at
tune 220 / BRIGHT 0, worst realistic corner **2.07 %** (tune 1760, DECAY 10, BRIGHT 0.05). State
it in the model header; do not chase it.

```ts
readouts: [
  { label: 'ring',    valueId: 'karplus-ring-s' },
  { label: 'damping', valueId: 'karplus-damping-hz' },
  { label: 'exciter', valueId: 'karplus-exciter-ms' },
],
```

**(a) `karplus-ring-s` — the −60 dB ring AFTER the loop-gain clamp.** The one that matters.

```
f0    = clamp(clamp(tune,55,1760) · 2^0, 30, 4200)          # karplus-dsp.ts:362-365
comp  = karplusDampingMag(aLp, w0) · karplusDcBlockMag(dcR, w0)   # :465
g     = clamp(min(0.99995, karplusLoopRho(f0, decay)) / max(0.5, comp), 0, 1.1)   # :464-466
ring  = ln(0.001) / (f0 · ln(g · comp))
```

Traced line for line to `karplusStep:462-466`. Below BRIGHT ≈ 0.11 the clamp binds and the note
decays **sooner than the knob says**.

*NEGATIVE CONTROL (must move; a `paramId:'decay'` readback cannot):* hold DECAY = 10 s,
TUNE = 220, move BRIGHT 0.30 → 0.05. Modelled: **10.000 s → 0.603 s**. The knob prints "10.0 s"
at both.
*SECOND LEG (must NOT move):* hold DECAY = 2 s, BRIGHT = 0.7, sweep TUNE 110 → 1760. Modelled:
**2.000 s at every step** — exact, because the ρ law is frequency-compensated by construction.
A derivation that wobbled here would be modelling the wrong thing.
*THIRD LEG (must move; the knob cannot):* BRIGHT = 0, DECAY = 10, TUNE 110 → 880 gives
**0.580 s → 0.075 s**. This is the docs' own claim (`karplus.ts:277`: "about 0.3 s at A3 and
0.07 s at A5") reproduced from the code: modelled 0.291 s / 0.075 s. The prose is accurate.

**(b) `karplus-damping-hz` — where the loop low-pass actually sits.**
`fc = min(0.45·sr, f0 · 2^(0.5 + 5.5·brightness))` (`karplus-dsp.ts:286-288`). At the defaults,
**4486 Hz = 20.4 × f0**.
*NEGATIVE CONTROL:* hold BRIGHT = 0.7, move TUNE 110 → 880 — fc moves **2243 → 17 946 Hz** (the
knob readback prints `0.70` throughout). *Must-not-move leg:* DECAY 0.1 → 10 leaves it identical.
*Bonus, and the reason it earns the strip:* at TUNE 1760 the readout pins at **21 600 Hz** for
BRIGHT 0.7 *and* BRIGHT 1.0 — it makes defect **D2** (§9) visible on the panel.

**(c) `karplus-exciter-ms` — the burst in real time.**
`ms = 1000 · max(2, round(burst · sr/f0)) / sr` (`karplus-dsp.ts:392`). Defaults: **4.54 ms**.
*NEGATIVE CONTROL:* hold BURST = 1, move TUNE 220 → 880 — **4.54 → 1.15 ms**, while the knob
prints `1.00` (periods) throughout. *Must-not-move leg:* BRIGHT and DECAY change nothing.

**REJECTED — the sounding pitch after the clamp.** With no cable in `pitch`, `pitchCv` is 0 and
`55..1760 ⊂ 30..4200`, so the outer clamp is **mathematically unreachable** from the params alone;
and `readoutValue` cannot see the pitch input, so the readout would be invariant to the only input
that could make it differ. There is no perturbation that separates it from `{ paramId: 'tune' }` —
so it *is* `{ paramId: 'tune' }`. **Dropped, not demoted.**

**REJECTED — partial stretch in cents.** It is genuinely derived (STIFF ∧ BRIGHT ∧ TUNE) and it
does pass the bar, but (i) it needs a root-find where the other three are closed forms, and
(ii) at STIFF = 0 it prints **−12.1 c**, not 0 (defect D1) — a fresh spawn would open with what
reads as a fault report. Ship it only after D1 is settled.

**Permanent home for all three negative controls:**
`packages/web/src/lib/ui/modules/karplus-face-model.test.ts` (new), the
`kickdrum-face-model.test.ts` shape — each leg an `it(...)`, run on every unit sweep.

---

## 6. THE SIDEBAR — `presets` only

The `signal-flow` block this spec originally proposed (BURST → COLOR LP → PICK COMB → DELAY LINE →
DAMPING LP → DISPERSION → DC BLOCK → × g, with OUT × LEVEL flagged `parallel: true`) is **struck by
the 2026-08-11 owner ruling.** Its one correctness payload — the output is tapped PRE-damping — is
recorded as §1 item 6 instead, which is where it should have been.

**Presets — six, each a COMPLETE 8-param recall** (there are only eight params, so "complete" is
free here, unlike kickdrum's 25). Every value verified in range and every `ring` figure below
modelled through §5(a), so no preset's DECAY value is a lie:

| id | label | note | tune | decay | bright | pos | stiff | color | burst | level | modelled |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `nylon` | NYLON | soft | 220 | 1.6 | 0.45 | 0.18 | 0.02 | 0.35 | 1 | 0 | ring 1.60 s · damp 1.73 kHz |
| `steel-harp` | STEEL HARP | ringing | 330 | 5 | 0.9 | 0.12 | 0.05 | 0.8 | 0.8 | −3 | ring 5.00 s · damp 14.4 kHz |
| `koto` | KOTO | hollow | 294 | 0.8 | 0.7 | 0.32 | 0.1 | 0.7 | 0.6 | 0 | ring 0.80 s · null at 3.1·f0 |
| `felt-mallet` | FELT MALLET | dark | 110 | 0.9 | 0.15 | 0.5 | 0 | 0.1 | 0.2 | +3 | ring 0.90 s · damp 276 Hz |
| `bell` | BELL | metallic | 660 | 6 | 0.7 | 0.06 | 0.75 | 0.9 | 0.3 | −4 | ring 6.00 s · +403 c on p3 |
| `scrape` | SCRAPE | bowed | 165 | 3 | 0.6 | 0.25 | 0.15 | 0.85 | 4 | −2 | ring 3.00 s · burst 24.3 ms |

`scrape` exists because BURST's 0.1 ↔ 4 travel is otherwise undiscoverable — no other preset
leaves 1.0. **Taste call, one-line revert:** drop the `scrape` entry and the roster is five, the
kickdrum count.

No `custom` block: `stereo-crossover` is the only registered panel and karplus is mono. No
`readouts` block: the strip already carries the three numbers and a second column of the same
values is the "labelled void" the lint warns about.

---

## 7. RANGE / CURVE / VOCABULARY CHANGES

**None proposed.** All eight ranges stay exactly as declared (`karplus.ts:75-82`).

**Card grep for re-typed ranges — CLEAN.** `KarplusCard.svelte:48-57` builds every control's
`min`/`max`/`curve`/`units` from `paramSpec(karplusDef, …)`, and the faders bind them (`:129-132`,
`:138-140`, `:167`). Only the 3–4 char labels (`Dec`, `Brt`, `Stf`) stay card-side, deliberately
and with a written argument (`:42-47`). **Zero** literal range or mapping props.

**Considered and NOT taken:** `format: fmtAmount` on `brightness` / `color` / `stiffness` (they
print bare `0.70` today). Contract-lock does not serialise `format`
(`contract-signature.ts:106-109` emits only `min..max curve default= unit=`), so it is a
**zero-contract** change — but it moves the dock face baseline *and* forces `formatValue={…}` onto
the faders, which moves `vrt.spec.ts/karplus.png` too. Keep this re-do's blast radius to the face
scenes; take it as its own PR.

---

## 8. COST

- **contract-lock: +1 line.** `karplus family karplus-string kind=cell prefix=karplus-string`
  sorts before the existing `karplus family karplus-strike …` at `contract-lock.txt:1450`.
  Everything else in this spec is **ZERO** — `serializeModuleContract` has no `face` branch. Zero
  if you take the §5 revert.
- **VRT — MOVES:** `face-karplus-dock` (a hero rail, a full-width readout strip, a sidebar column
  and two rewritten bands — the whole face). **MUST NOT MOVE:** `face-karplus-compact` (ranks 1–2
  are untouched and the hero is dock-only); `vrt.spec.ts/karplus.png` and the three
  `vrt-karplus-tomtom-states` scenes (the LEGACY card, which this spec does not touch — treat a
  diff there as a finding, not a re-pin). **karplus is NOT in `STRICT_VRT_MODULES`** and
  `workflow-shell-faces.spec.ts` is not in `STRICT_MATCH` (`vrt.config.ts:36`), so none of these is
  in the REQUIRED `vrt-strict` lane. ⚠ The dock baseline EXISTS and will be STALE, which is the
  case `--update-snapshots` **cannot** rewrite: `git rm` it first, then let the linux capture job
  author the replacement.
- **Structural gate: unchanged.** `workflow-shell-faces.spec.ts:59` stays `{ type: 'karplus',
  pages: 2 }` — the hero is a SLOT, not a band.
- **Dock overflow: RE-MEASURE, do not predict.** The committed figure is 106 px
  (`vrt-exemptions.ts:1078`). A hero rail plus a readout strip adds height, and a sidebar narrows
  the editor column so bands may wrap and add more. The round-2 fact-check showed the "88 px per
  band" model is contradicted by three of the twelve rows on that same line — do not use it.
- **e2e: faces-parity karplus 9 → 10 cells.** The added cell is a `panel`, so the sweep drives its
  probe rather than dragging a knob; the per-face budget `FACE_FIXED_MS + FACE_PER_CELL_MS ×
  cells.length` (`faces-parity.spec.ts:97-98, 680`) grows automatically. No new bespoke spec is
  needed — **`e2e/tests/karplus-face.spec.ts` already exists** and already asserts an audible RMS
  from the real shell PLUCK plus a silent-before negative control.
- **CI wall-time: ≈ +2 s.** One extra faces-parity cell on a SwiftShader runner (`FACE_PER_CELL_MS
  = 1800` is the *bound*; a probe click measures far under it) plus a few ms of pure-unit lint and
  the new `karplus-face-model.test.ts`. Nothing added to the VRT scene count.
- **ART / attest: NIL, confirmed not assumed.** `art/scenarios/karplus/profile.test.ts:118,166`
  pins `dspSourceSha(...)` over `packages/dsp/**` — not a `docsStrippedRepoSourceSha` over the
  def — so a `face` edit cannot move `art/baselines/karplus/{out,melody}.f32`. karplus is an audio
  def, so not in the WebGL basis, and not a collab basis file.

---

## 9. DEFECT LEDGER

**D1 · STILL OPEN — `docs.controls.stiffness` claims a perfectly harmonic string; it is not one, at
any BRIGHT.** `karplus.ts:284` reads verbatim *"0 = a perfectly harmonic string"*. The allpass half
of that sentence is exactly right; the harmonicity half is not. The loop's phase-delay budget is
compensated **only at f0** (`karplusDelayTarget:344-359`), and both the DC blocker's lead and the
damping pole's delay fall off with frequency, so upper partials do not land on `k·f0`. Modelled
from the exported phase-delay laws at STIFF = 0, TUNE = 220, 48 kHz — partials 2/3/5/8, in cents
from harmonic:

| BRIGHT | p2 | p3 | p5 | p8 |
|---|---|---|---|---|
| 0 | +28.9 | +56.6 | +90.2 | +114.3 |
| 0.2 | −2.9 | +4.0 | +18.5 | +33.5 |
| 0.7 *(default)* | −10.2 | −12.1 | −12.9 | −12.9 |
| 1 | −10.2 | −12.2 | −13.1 | −13.5 |

Pitch-invariant to within 0.2 c across 55–1760 Hz, which says the *tracking* design works — the
offset is systematic, not a tuning failure, and the fundamental itself stays exact (**0.0000 c** at
every STIFF, confirming the 1 V/oct claim). **Cost to a user:** at BRIGHT 0 a "harmonic" string is
a whole semitone sharp on partial 8 — a real timbre, just not the documented one. **What could
catch it:** nothing does. `karplus-dsp.sonic-range.test.ts:237-243` measures the partial-3 peak
only as a *monotone walk* under STIFF and only asserts `≥ +45 c at max` — it never checks the
STIFF = 0 baseline, so a non-zero offset there is invisible by construction. (The model reproduces
that test's bound: +64.6 c at STIFF 1, and the def header's partial-5 ladder +6/+34/+75/+130 c
against modelled −6/+22/+73/+139 — the same shape, so the model is **cross-validated against two
independent measurements already in the repo**.) **Fix is a DOCS edit, not a DSP one** — the
behaviour is musically sane; the sentence overclaims.

**D2 · STILL OPEN — the top of the BRIGHT knob is DEAD above ~1 kHz, and the docs say the
opposite.** `karplusBrightnessCutoffHz` caps at `Math.min(0.45 * sr, …)`
(`packages/dsp/src/lib/karplus-dsp.ts:287`), so `fc` saturates. Solving
`f0·2^(0.5+5.5·B) = 0.45·sr`, the knob is inert above:

| tune | 48 kHz | 44.1 kHz |
|---|---|---|
| 440 | B > 0.930 | B > 0.908 |
| 880 | B > 0.749 | B > 0.726 |
| 1760 | B > 0.567 | B > 0.545 |

`docs.controls.brightness` (`karplus.ts:280`) still says *"the knob means the same thing at every
pitch"*, which is true across most of the range and false at the top. **Cost:** at A6 the top 43 %
of the knob does nothing, and *how much* does nothing depends on the device's sample rate.
**Catchable:** a three-line unit assertion on `karplusBrightnessCutoffHz` at `(1760, 0.7)` vs
`(1760, 1.0)`; the proposed `damping` readout also makes it visible on the panel.

**D3 · `KarplusCard.svelte` def-bound but outside the guard. ✅ FIXED.** It is now in **both**
`RANGE_BOUND_CARDS` (`card-range-source.test.ts:248`) and `MAPPING_BOUND_CARDS` (`:279`), with the
enrolment note recording that it was found already-bound rather than converted — the comment
stripper is what made the artifact anchor able to demand it.

**D4 · STILL OPEN (partly) — the dock PLUCK's press animation fires even when nothing was
plucked.** `fireManualStrike` returns a boolean and the legacy card honours it
(`KarplusCard.svelte:72-76`, "the flash follows the TRUTH"); the shell cell still discards it —
`onFire: (nodeId) => { fireManualStrike(nodeId); }` (`shell-cells.ts:645`) — and `<Button>` runs
its press animation unconditionally. What DID land is the *gate*: `ShellActionCell.probe` is now
required and the audition ledger records `delivered`, with the cell's own comment at
`shell-cells.ts:646-651` naming this defect as the one the missing probe cost most. So a dead
audition is now catchable; the lying flash is not fixed.

**D5 · STILL OPEN — the same hole karplus's face closed is still open on its sibling.**
`SHELL_CELLS.sixstrum` registers only `sixstrum-preset-{n}`, and `sixstrum.ts`'s `face.order` ranks
no audition — yet sixstrum has the identical `read('manualTrigger')` seam, an on-card STRUM button,
and is in `STRICT_FACES`. Not a karplus defect; reported because the answer differs between the two
modules.

**D6 · PLATFORM shortfall, recorded not scheduled.** `FaceFlowStage` has no way to express that
loop stages are a *loop*; the flag would be *"the honest platform follow-up; not this PR"*. Moot
while the 2026-08-11 ruling stands (there are no flow diagrams to draw), kept because it is the
one thing the block kind structurally could not say.

---

## 10. VERIFICATION GATE

```sh
# 1. the model + its three permanent negative controls (the new file)
REPEAT=3 flox activate -- task test:one -- karplus-face-model
# 2. the face pins + the platform lint (hero totality, readout ids, sidebar blocks)
flox activate -- task test:one -- karplus-face
flox activate -- task test:one -- module-face-lint
flox activate -- task test:one -- shell-cells
flox activate -- task test:one -- dock-faceplate-model
# 3. the contract + docs accept loop — confirm the diff is EXACTLY the one family line
flox activate -- task docs:accept && flox activate -- git diff packages/web/src/lib/docs/contract-lock.txt
# 4. the card guard
flox activate -- task test:one -- card-range-source
# 5. the shell, for real: the panel probe + the audition RMS
flox activate -- task e2e:serve
flox activate -- npx --workspace e2e playwright test faces-parity --grep karplus
REPEAT=3 flox activate -- task e2e:one -- tests/karplus-face.spec.ts
# 6. VRT — git rm the STALE dock baseline FIRST (a sub-tolerance diff commits nothing)
flox activate -- git rm e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/face-karplus-dock.png
flox activate -- task vrt:one -- karplus          # local smoke: does it render, does it throw
flox activate -- task e2e:stop
flox activate -- task typecheck
flox activate -- task vrt:commit                  # linux capture authors the baseline
```

⚠ **`git status` for untracked PNGs after every VRT run in this window** — a `git rm`-ed baseline
is silently recreated as an untracked file by the next plain run. Confirm `face-karplus-compact`
and the four legacy-card baselines came back **unchanged** — a diff on any of them is a finding,
not a re-pin.
