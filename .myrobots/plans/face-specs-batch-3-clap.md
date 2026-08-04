# FACE SPEC — `clap` (batch 3)

> ⚠ **STATUS CORRECTED 2026-08-04 — THE FACE SHIPPED.** clap was PROMOTED in **#1332**
> (`2d111616`) and is in `STRICT_FACES`. PF-20 (**PR #1301**) has MERGED (`c6ff9253`).
> **The face half of this spec is spent — read the shipped def, not this.** What is still
> worth keeping is §8:
> - ✅ **§6 / §8-B/C · WIDTH's loudness compensation had the wrong sign (18.06 dB)** —
>   **FIXED in #1313** (`290dcdb5`), normalised at the default width; the blind
>   amplitude-window gate was replaced with an RMS sweep at LEVEL −24 plus a COLOR
>   negative control. WIDTH 0.5 is bit-identical; WIDTH 0 is 13.8 dB quieter, WIDTH 1 is
>   5.1 dB louder.
> - ✅ **§8-A · the strike pad masks external triggers** and **§8-E · the k-rate latency** —
>   both now documented correctly on the def (`clap.ts:358`).
> - ⚠ **§8-D (COLOR is +4.5 dB and non-monotonic) and §7 (the card re-types every range as a
>   literal; clap is not in `RANGE_BOUND_CARDS`) were still OPEN** when this was checked.

**Status:** ~~SPEC + MOCKUP ONLY~~ **BUILT.** PF-20 platform (`feat/faceplate-platform-v2`, PR #1301 — MERGED, `c6ff9253`).
Citations are file:line; inferences labelled.

**Verdict: PROMOTE — the strongest candidate in the batch.** · archetype: **struck percussion
VOICE with a two-stage envelope machine** (the drum family: kickdrum · snaredrum · tomtom · clap).

Not in `STRICT_FACES` (`packages/web/src/lib/ui/workflow/strict-faces.ts:42-65`); no `face:` block —
which is ironic, because `packages/web/src/lib/graph/types.ts:599` cites **"tomtom/clap `strike`"**
as the canonical `momentary` example. The face API already anticipates this module. 10 params,
5 in / 1 out. contract-lock block = **17 lines** (`contract-lock.txt:443-459`: 1 meta + 5 in +
1 out + 10 param).

⚠ **The math is NOT in `packages/dsp/src/clap.ts`** (a 181-line worklet wrapper) but in
`packages/dsp/src/lib/clap-dsp.ts` (413 lines), as `clap.ts:21` states. Every measurement below
comes from bundling that core and running it at 48 kHz.

---

## 1. WHAT IT ACTUALLY DOES

A clap is **two envelopes on one noise source**: a burst train of N hard onsets, and a room tail
that starts at the *last* onset. Everything a player hears is the interaction of those two, and
the module currently exposes them as nine peer faders with no indication that four of them
change the same duration.

`clapStep`, `packages/dsp/src/lib/clap-dsp.ts:330-412`:

1. **STRIKE** — per-sample rising edge at 0.5 (`:337-341`). `strikeClap` (`:290-305`) **latches**
   `pulsesN = round(clamp(pulses,2,5))`, `spreadMsLatched`, `spreadSamp`, `accentLatch`,
   `vel = 1 + 0.8·accent`, and **resets rng/colorLp/svfLow/svfBand/tailLp to 0** — so every hit
   is bit-identical.
2. **Burst scheduler** (`:346-355`): `while (pulseK < pulsesN && sinceStrike >= pulseK·spreadSamp)
   { burstEnv = 1; if (pulseK === pulsesN−1) tailEnv = 1 + 0.6·accent; pulseK++ }`. **Pulse *k*
   fires at *k*·spread, and the ROOM TAIL fires at the LAST pulse, not at the strike.**
3. **Noise → COLOR** (`:358-364`): xorshift32 → one-pole at
   `clapColorFc = 9000·(700/9000)^color` (`:221-223`) → `×(1 + 2·color)` (`COLOR_COMP`, `:80`).
4. **BAND** (`:367-375`): Chamberlin SVF at `clapToneHz(tone, toneCv)`, damping
   `qB = 0.18 + 1.42·width` (`:216-218`), output `svfBand·3.0/√qB` (`BP_GAIN`, `:88`).
5. **Tail feed** (`:379-381`): one *extra* one-pole at the same `fcHz` — so the room genuinely
   tracks TONE one pole darker.
6. **Two VCAs + SNAP** (`:384-386`): `burst = band·burstEnv·√snap`;
   `tail = tailLp·tailEnv·1.15·√(1−snap)` — an equal-power crossfade.
7. **Envelopes** (`:392-397`): `burstMs = spreadMsLatched·(finalPulse ? 2 : 1)`
   (`FINAL_PULSE_RATIO = 2`, `:91`); the tail decays at `clapTailMs(tail, tailCv)`, **read live
   every sample** — unlike spread, which is latched.
8. **Bus** (`:400-411`): `pre = (burst+tail)·1.35·vel` → 2× oversampled
   `tanh((1+3·drive)·x)` gated at `drive > 0.001` → 20 Hz DC block → `10^(level/20)` → a **final
   `Math.tanh`**. Mono in, mono out (`packages/web/src/lib/audio/modules/clap.ts:62-64`,
   `:121-125`). No stereo anywhere.

**The design fact the current card hides:** SPREAD sets three different things (onset spacing,
each pulse's own decay, and when the room starts), and the total length of the voice is a
`max()` of two branches that SNAP crossfades between. Nine faders in three groups
(`packages/web/src/lib/ui/modules/ClapCard.svelte:79-97`) say none of that.

---

## 2. THE CONTROLS THAT MATTER — 10 params, and the lane cut is real

| rank | control | why |
|---|---|---|
| 1 | `spread` | the module's identity knob and the only one that changes **three** quantities (`clap-dsp.ts:347, 393, 350`). Latched at the strike, which is itself worth teaching. |
| 2 | `pulses` | the other half of the burst train; 2..5 discrete. Together with spread it *is* the clap. |
| 3 | `snap` | the equal-power burst↔room balance (`:384-386`) — and the control that silently decides the voice's total length (§4-C). |
| 4 | `tone` | SVF centre **and** the room's darkening pole (`:379`). One knob, two stages. |
| 5 | `tail` | the room's −60 dB time, the only envelope read **live** rather than latched. |
| 6 | `clap-strike-{n}` | the AUDITION. ⚠ ranked 6 deliberately — see below. |
| 7 | `width` | Q 5.56 → 0.63 … and **18.06 dB of RMS** (§6-B). Dock-only until that is fixed. |
| 8 | `drive` | tanh pre-gain 1→4; live at the shipped default 0.2, which clears the 0.001 bypass gate. |
| 9 | `color` | the noise pole. **Near-inert below ~0.2** and its default is 0.15 (§3). |
| 10 | `level` | −24..+12 dB; numerically inert at default (`10^0 = 1`). |

**LOSERS, named with the reason each lost:**
- **`width` loses rank 3** to `snap` because — measured — it is not the shape control its docs
  claim (`clap.ts:103`: *"it changes the shape of the noise, not the volume"*). It is an 18 dB
  fader (§6-B). Ranking a broken control third would teach the broken behaviour.
- **`color` loses to `drive`** because at its own shipped default it is a **+2 dB gain trim, not
  a colour control**: measured centroid moves only 2302 → 2141 Hz (−7 %) across color 0 → 0.15,
  while RMS rises +2.06 dB. Its useful travel starts around 0.2.
- **`level` is last** by the standing rule that a pure output trim never outranks a timbre.
- **`clap-strike-{n}` at 6, not 1.** The kickdrum face puts its audition in the **hero slot**
  (`kickdrum.ts` `face.hero.action` on the platform branch) and ranks it 7 — the first rank a
  lane cannot reach, because a button in a 46 px knob column is a bare `▸`. This face does the
  same: **rank 6 is the last lane slot**, and it goes to the audition rather than to `width`,
  because this module makes **no sound at all** until something strikes it. A lane tile with six
  knobs and no way to hear them is the tomtom/karplus complaint verbatim.

---

## 3. INERT AT SPAWN

The module is **silent at spawn** — `trigger_in` unpatched is held at 0 by the `ConstantSource`
fan (`clap.ts:130-133`), pinned by `packages/web/src/lib/audio/modules/clap.test.ts:176-180`.
All four CV jacks are exact no-ops at 0 (`clap-dsp.ts:181-208, 297, 350`). `level = 0` →
`10^0 = 1`, numerically inert. `color = 0.15` is *timbrally* near-inert (above). `drive = 0.2`
is **not** inert — it clears the `drive > 0.001` gate (`:403`) and measurably moves peak
(0.899 → 0.775) and RMS (+2.6 dB).

---

## 4. THE FACE

```ts
face: {
  title: 'Voice',
  hint:
    'Two envelopes on one band-passed noise source: a train of N hard onsets SPREAD apart, ' +
    'and a room tail that starts at the LAST onset — not at the strike. SNAP crossfades them, ' +
    'and in doing so decides how long the whole voice is.',

  order: [
    'spread', 'pulses', 'snap', 'tone', 'tail', 'clap-strike-{n}',   // ranks 1-6 = the lane budget
    'clap-hero-{n}',                                                  // panel: first legal rank is 7
    'width', 'drive', 'color', 'level',
  ],
  pages: [
    { id: 'burst', label: '1 · burst — the hands', hint: 'N onsets, SPREAD apart; each decays over SPREAD, the last over twice that',
      controls: ['clap-hero-{n}', 'clap-strike-{n}', 'pulses', 'spread'] },
    { id: 'noise', label: '2 · noise — the material', hint: 'one xorshift source through a COLOR pole, then a band-pass whose Q is WIDTH',
      controls: ['color', 'tone', 'width'] },
    { id: 'room',  label: '3 · room — the tail',    hint: 'fires at the LAST onset, one pole darker than the band, decaying over TAIL',
      controls: ['tail', 'snap'] },
    { id: 'out',   label: 'bus · drive · out',      hint: '2× oversampled tanh, a 20 Hz DC block, then the level — which runs INTO a final clipper, not past it',
      controls: ['drive', 'level'] },
  ],
  glyph: 'scope',
  momentary: ['strike'],   // the canonical example at graph/types.ts:599

  hero: {
    cell:    'clap-hero-{n}',
    control: 'spread',
    action:  'clap-strike-{n}',
    readouts: [
      { label: 'burst',  valueId: 'clap-burst-ms' },
      { label: 'room in', valueId: 'clap-room-onset-ms' },
      { label: 'voice',  valueId: 'clap-voice-ms' },
    ],
  },

  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'STRIKE',      role: 'generator', note: 'latches N + spread' },
      { label: 'NOISE',       role: 'generator', note: 'xorshift32' },
      { label: 'COLOR POLE',  role: 'bus', note: '9k → 700 Hz' },
      { label: 'BAND · WIDTH', role: 'bus', note: 'Q 5.6 → 0.6' },
      { label: 'BURST VCA',   role: 'bus', note: '√snap' },
      { label: 'ROOM POLE',   role: 'bus', parallel: true, note: 'one pole darker' },
      { label: 'ROOM VCA',    role: 'bus', note: '√(1−snap)' },
      { label: 'DRIVE 2×OS',  role: 'bus', note: 'tanh' },
      { label: 'DC BLOCK',    role: 'bus', note: '20 Hz' },
      { label: 'LEVEL → CLIP', role: 'bus', note: 'level runs INTO the tanh' },
    ] },
    { kind: 'presets', label: 'presets', entries: [ /* 808 · 909 dense · linn room · dry snap — the three that already exist as VRT composite scenes, e2e/vrt/vrt-clap.spec.ts:48-61 */ ] },
    { kind: 'readouts', label: 'filter', entries: [
      { label: 'bandwidth', valueId: 'clap-bandwidth-hz' },
      { label: 'Q',         valueId: 'clap-q' },
    ] },
  ],
}
```

**Why four bands.** They are the four stages of the DSP in its own order, and each merge I
considered would fuse two different ideas: `noise` + `room` share TONE but not a mechanism (one
is the band, the other a pole downstream of it); `burst` + `room` are the two envelopes and
merging them would hide that SNAP is what balances them. The `out` band exists to carry the
LEVEL→CLIP order, which is the same trap kickdrum's face was rewritten to fix.

---

## 5. DERIVED READOUTS

Let `S = clapSpreadMs(spread, spreadCv)`, `N = clapPulseCount(pulses)`, `T = clapTailMs(tail, tailCv)`.

### A. `clap-burst-ms` — the burst train, −60 dB
```
burst_ms = (N + 1) · S            # last onset at (N−1)·S (:347); final pulse decays over 2·S (:393)
```
*Measured envelope-exact:* N=3/S=10 → 39.98 ms (formula 40); N=3/S=4 → 15.96 (16); N=5/S=25 →
149.96 (150).
**NEGATIVE CONTROL: `pulses`.** A readout wired to the SPREAD knob is invariant to N, yet 2 → 5
pulses moves this from 30 to 60 ms at S = 10. **Second control: `spread_cv`** — a knob readback
cannot see it at all (+1 V → S = 24.62 ms, ×2.46), which is why the derivation must read the
live AudioParam, not `node.params`.

### B. `clap-room-onset-ms` — the pre-delay nobody named
```
room_onset_ms = (N − 1) · S
```
*Measured exactly:* at snap = 0, N = 5, S = 25 the output is **bit-zero (−600 dB) until
sample-ms 100**, then jumps to −4 dB. At SNAP = 0 this clap has a hard silent pre-delay that no
control on the panel is named after.
**NEGATIVE CONTROL:** PULSES and SPREAD both move it; **TAIL does not.** A readout that moved
with TAIL would be measuring the wrong envelope.

### C. `clap-voice-ms` — the total, and the best negative control on this module
```
voice_ms = max( snap > 0 ? (N+1)·S : 0 ,
                snap < 1 ? (N−1)·S + T : 0 )
```
*Measured at defaults:* snap 0 → 181 ms · 0.5 → 174 · 0.9 → 151 · **1.0 → 45 ms**.
**NEGATIVE CONTROL — `snap`.** A `paramId: 'tail'` readout prints "150 ms" at every one of those
settings while the module makes 45 ms of sound at snap = 1. That is the kickdrum-TAIL trap in a
different module, and it is why this readout is `valueId`, not `paramId`.
**Second control — `level`.** Against a fixed −60 dBFS floor, measured absolute T60 is
112 / 142 / 178 / 185 / 208 ms at level −24 / −12 / 0 / +6 / +12 → **2.67 ms/dB measured vs
`T/60 = 2.50` predicted**. Ninety-six milliseconds of tail length live on the LEVEL fader alone.
**Third — `accent_in`**: `vel`(1.8) × `tailEnv`(1.6) = +9.2 dB → measured 171 → 185 ms, and no
param moves at all.
⚠ **Honesty term (verified, not assumed):** rendered −60 dB length exceeds the formula by up to
14 ms because of the **20 Hz DC blocker** (`clap-dsp.ts:409`;
`packages/dsp/src/lib/dsp-utils.ts:37`), `R = e^(−2π·20/48000)` → −1.092 dB/ms, own T60 = 55 ms.
The measured post-burst residue slope is exactly −1 dB/ms. The readout prints the **envelope**
figure and the sidebar states the DC-block term; printing the render figure without saying why
would be a number nobody could reproduce.

### D. `clap-bandwidth-hz` / `clap-q`
```
Q  = 1 / (0.18 + 1.42·width)                    # clap-dsp.ts:216-218
BW = clapToneHz(tone, toneCv) · (0.18 + 1.42·width)
```
Defaults: Q = 1.12, BW = 890 Hz. **NEGATIVE CONTROL:** move **TONE**. Q is tone-invariant and must
not move; BW must (400 Hz → 356 Hz; 3000 Hz → 2670 Hz). **Publishing both is the instrument's own
negative control** — a derivation that moves both, or neither, is falsified on the spot.

---

## 6. BESPOKE CELL, AND THE BUG THIS FACE SHOULD NOT SHIP OVER

**LEGITIMATE — `clap-hero-{n}`: the burst-train envelope graph.** N onset ticks at `k·S`, each
with its own `S`-long decay (the last `2·S`), the room envelope rising at `(N−1)·S` and decaying
over `T`, both scaled by `√snap` / `√(1−snap)`, on a warped time axis, plus a −60 dB rule. Every
number in §5 becomes a picture. This is the kickdrum-hero pattern exactly and it is the one thing
def introspection cannot synthesise.

**⚠ `width` — DO NOT SHIP A FACE THAT RANKS THIS AS A SHAPE CONTROL.** `clap-dsp.ts:86-88` claims
`1/√q` "keeps narrow/wide comparably loud". A band-pass's peak gain is already `1/q`, so raw
noise RMS is already `∝ 1/√q`; dividing by `√q` **again** (`:375`) makes it `∝ 1/q`.
**Measured unsaturated (level −24): RMS −26.97 dB at width 0 → −45.03 dB at width 1 = 18.06 dB.**
The compensation has the wrong sign; it should be `×√q`. **And the gate that should have caught
it is blind by construction:** `packages/dsp/src/lib/clap-dsp.test.ts:328-334` asserts only
`pN > 0.15 && pB > 0.15 && both < 1` — an amplitude *window*, invariant to an 18 dB RMS gap
because the final `tanh` pins width 0 at 0.9998. Textbook CLAUDE.md instrument failure.
**Recommendation: land the sign fix (a DSP PR, owner-audition, ART re-pin) before or with the
face**, and rank `width` third once it is a shape control.

---

## 7. RANGES AND CURVES — no changes, one card fix

No range or curve change is proposed; all ten keep the def's declarations
(`clap.ts` params block). **The card re-types every one as a literal** — e.g.
`ClapCard.svelte:80` `min={4} max={25} … curve="log"`, `:87` `min={400} max={3000}`,
`:97` `min={-24} max={12}` — while `defaultFor()` *is* def-sourced (`:27`). All nine currently
agree, which is the hazard rather than the reprieve. **Ship the `paramSpec()` conversion in the
same PR** and add `clap` to `RANGE_BOUND_CARDS`
(`packages/web/src/lib/ui/modules/card-range-source.test.ts:71-78`).

---

## 8. ALREADY-WRONG

- **A · the strike pad MASKS external triggers, and the doc says the opposite.** `clap.ts:109`
  claims *"external triggers keep working while it's held"*. `packages/dsp/src/clap.ts:171` does
  `trig = Math.max(inTrig, strike)`, which pins the line high so no rising edge can occur.
  *Measured:* pad held, external pulse at 100 ms → peak in 100–160 ms = **0.000162** vs 0.774
  early. **`tomtom.ts:205` documents the identical circuit correctly** ("incoming trigger edges
  are masked until you let go") — copy tomtom's wording. Same false claim also at
  `packages/dsp/src/clap.ts:31`.
- **B · WIDTH's loudness compensation has the wrong sign** — §6. 18.06 dB.
- **C · the WIDTH gate cannot fail** — §6.
- **D · COLOR "not a volume knob" is overstated.** Measured unsaturated at tone 1000:
  −40.17 / −38.19 / −35.65 / −36.33 dB at color 0 / 0.15 / 0.5 / 1 — **+4.5 dB and
  non-monotonic**; at tone 400 it is +5.8 dB monotonic; above 0.5 at tone 3000 it *falls* 2.8 dB.
  `COLOR_COMP` is calibrated for broadband RMS while the audible path is narrowband at TONE.
- **E · the pad's k-rate latency is undocumented.** `strike` is k-rate, so it is sampled once per
  128-sample block = **2.67 ms**. `tomtom.ts:205` documents this; `clap.ts:109` does not.
- **No dead controls.** All ten params reach the DSP.

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+2 lines** — `clap family clap-hero kind=cell prefix=clap-hero` and `clap family clap-strike kind=other prefix=clap-strike`. ⚠ `strike` is already a ParamDef (`momentary`), so the audition is a **press-param**, not a family — in which case it is **+1 line** only. Confirm against `face.momentary` handling in `module-face-lint` before committing to either. |
| **ART** | none from the face. **The §6 WIDTH fix is a real audio change** needing owner audition and, if a `.f32` pin exists by then, `task art:update`. |
| **VRT — the expensive one in this batch** | clap has `vrt.spec.ts/{darwin,linux}/clap.png` **plus three composite scenes** — `clap-909-dense`, `clap-linn-room`, `clap-dry-snap` (`e2e/vrt/vrt-clap.spec.ts:48-61`), **both platforms captured, zero entries in `EXEMPT_BASELINE_PAIRS`**. A card change invalidates **8 PNGs**. The face itself adds `face-clap-compact` + `face-clap-dock` × 2 = **4 more**. Budget 12 baselines, not 4. |
| **e2e** | +1 `faces-parity` row (11 cells) in the REQUIRED lane. |
