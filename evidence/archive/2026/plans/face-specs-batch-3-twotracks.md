# FACE SPEC — `twotracks` — **BANKED. The module is UNFACED and the faceplate pipeline is paused.**

This spec was written for batch 3 and its verdict then was **do not face it yet**. Nothing
about that has been overturned; the module still has no `face:` block, and the spec is kept
because an unbuilt module's measurement is worth exactly as much as a built one's.

**Corrections against `main`, verified 2026-08-10:**
- ✅ **§5-A reel B's ECHOES knob was a permanent no-op — FIXED in #1313** (`290dcdb5`).
  `parameterDescriptors` declared a `decay_b` nothing read and omitted `echoes_b`, which
  `processReel` reads every block. `twotracks-worklet-params.test.ts` now walks the whole
  def→worklet map in both directions. **§5-B (`decay_b` vestigial) went with it.**
- ✅ **OUT L and OUT R were the same graph edge** — fixed in **#1323** (`16bf310e`).
- ✅ **§5-M zero `edge:` declarations — FIXED.** All six gate ports now carry
  `edge=trigger` (`contract-lock.txt:3442-3452`).
- ⚠ **Every param COUNT below is stale.** #1352 (`f3c2a966`) added RATE CV in for both decks,
  so "31 params" and the lane-budget arithmetic derived from it need re-deriving before use.
  The *ratios* (how many are inert until a take exists) were not re-measured.

---

## 1. WHAT IT ACTUALLY DOES

A **two-reel varispeed tape deck**, not an A/B player. One `AudioWorkletNode`
(`packages/web/src/lib/audio/modules/twotracks.ts:304-308`, 4 mono inputs, 1 stereo output) hosts
two independent `ReelState`s (`packages/dsp/src/twotracks.ts:294-353`), each with its own
**960 000-sample stereo ring buffer** (`:296-298`;
`packages/dsp/src/lib/twotracks-engine.ts:20` — exactly 20.000 s at 48 kHz), cursor, transport, EQ,
filter and scrub state. Reels are summed through a global A/B law and then one global LOFI stage
(`packages/dsp/src/twotracks.ts:923-1048`).

**"Tape codec" is NOT a tape model** — it is a *persistence* codec: `encodeTapeBytes` /
`decodeTapeBytes` (`twotracks.ts:87-115`) pack the recorded prefix as 16-bit interleaved PCM for
the performance `.zip`, consumed only by `Canvas.svelte:166, 3053, 3258`. No wow, no bias, no
saturation lives there.

**Transport — two drivers, and they are DIFFERENT machines.** Buttons go through
`transportButton` (`twotracks-engine.ts:186-205`): idle→REC **arms** (no recording); armed→PLAY
rolls and records from the top; play→REC **punches in at the playhead, no rewind**; rec→REC
punches out. Gates are per-sample rising edges at `TRIG_THRESHOLD = 0.5`: `rec_arm` → `armed`
(`packages/dsp/src/twotracks.ts:651-654`), `rec_start` → `rec`/`overdub` (`:658-670`),
`overdub_toggle` → **flips** the flag and swaps rec↔overdub live (`:674-679`). **ARMED is a frozen
pre-roll — it never self-advances** (`:681-683`).

**The A/B law is not a crossfade.** `ab ≤ 0.5`: gainA = 1, gainB = 2·ab. `ab > 0.5`:
gainA = 2(1−ab), gainB = 1 (`twotracks.ts:118-125`; `packages/dsp/src/twotracks.ts:281-288`).
**At 0.5 both are unity, so the bus is +6.02 dB versus either reel alone.** And the shipped
default `ab = 0` means **reel B is hard-muted at spawn** (`twotracks.ts:239`).

**The tape model, exactly** — all of it in the global LOFI block, gated `if (lofiMode > 0)`
(`packages/dsp/src/twotracks.ts:937`) and applied to the **summed** output:

| stage | law | LOW | HIGH | ERROR |
|---|---|---|---|---|
| saturation | `tanh(drive·x + offset)·outGain`, `outGain = 1/tanh(drive)` (`:948-951, 978`) | drive 1.2, off 0.01 | 2.0 / 0.03 | 2.0 / 0.03 |
| → small-signal gain | `drive·outGain` | **+3.164 dB** | **+6.336 dB** | +6.336 dB |
| → **DC at zero input** | `tanh(offset)·outGain` | **0.011995 (−38.4 dBFS)** | **0.031110 (−30.1 dBFS)** | same |
| HF loss | 1-pole `a = 1−e^(−2πfc/sr)` (`:954-955, 982-985`) | fc 8 kHz | 4 kHz | 4 kHz |
| hiss | LCG 1664525/1013904223 (`:988-991`) | ±0.002 (−58.8 dBFS RMS) | ±0.006 (−49.2) | ±0.010 (−44.8) |
| wow/flutter | `s ×= 1 + [wow·sin(2π·0.7t) + flut·cos(2π·7t)]` (`:961-1000`) | ±0.080 % pk | **±0.300 % pk** | same |
| chew (mode 3) | p = 5e-5/sample while idle; grain 20–80 ms (`:969-1042`) | — | — | **2.143 events/s, ~10.7 % duty** |

⚠ **The wow/flutter is AMPLITUDE modulation, not time-base** — there is no delay line, and the
comment admits it (`:995`). **Printing "WOW 0.30 %" on a faceplate would imply a pitch figure the
DSP does not produce.** Head-gap scrub loss *is* real and per-reel:
`fc = max(400, 20000/(1+2·v))` (`:595`), with `v` from the card's `|Δx|/width·50` capped at 10
(`TwotracksCard.svelte:280-282`) → **the minimum reachable fc is 952.4 Hz; the 400 Hz floor is
dead code** (it needs v > 24.5).

---

## 2. WHY IT IS A HARD FACE — the measured reasons

1. **12 of the params are structurally inert until a take exists.** `readInterp` on a zero-filled
   buffer returns 0, so EQ, filter, reso and cutoff **process silence**
   (`packages/dsp/src/twotracks.ts:709-763`) — and they are *structurally* incapable of touching
   the monitor path even with MONITOR on, because `reelOutSample(tape, src, …)` EQs only `tape`
   (`:783-784`). `rate`, `echoes`, `mode` and `overdub_flag` never execute (`rolling = false`).
   `a2b`/`b2a` are identity (the `crossPrev` buffers are zero). Exactly **three** things are live
   at spawn: `lofi` (which with zero input still emits **DC + hiss** — the only sound a bare
   twotracks makes), `monitor` (iff something is patched), and `ab` (only in combination with
   monitor, on reel B). A face is a control-surface ranking, and twelve of the ranks would be
   ranking controls that do nothing on a fresh spawn.
2. **The face-critical interactions are not params at all.** REC / PLAY / STOP, SAVE TAPE, seek and
   scrub-velocity all travel over the `MessagePort` (`TwotracksCard.svelte:211-248`), and
   **`scrubVelocity_*` is deliberately excluded from `def.params`** (`twotracks.ts:641-643`) — so a
   face plus `ModuleShell` would need plumbing no other faced module has needed. The rule is stated
   verbatim in `sidebar-panels.ts`: *"A panel READS; it does not own state."*
3. **It is two decks plus a mixer plus a lofi processor.** Every faced module so far has been
   ≤ ~10 controls with a single clear job.

**THE CASE FOR, stated fairly.** It is the only tape looper in the rack, it has **more genuinely
derivable numbers than most faced modules** (§4 lists eight, three with clean negative controls),
and it has **zero VRT coverage today** (`EXEMPT_FROM_VRT`, `e2e/vrt/vrt-exemptions.ts`) — a face
would be its first pixel gate ever. Its worst UX facts are all *arithmetic a face fixes for free*:
reel B silent at ab = 0, +6 dB at centre, a +8.7 dB overdub ceiling, and EQ that does nothing until
you record.

---

## 3. THE SHAPE IT SHOULD TAKE, when it is faced

- **Two tab bands, one per reel, plus a bus band.** Its param count puts it past
  `DOCK_TAB_MIN_BANDS = 7` (`dock-tabs-model.ts:46`), so it is a **tab rail** by construction —
  which is right for a two-deck module and should be embraced, not fought.
- **`face.title` = `Tape`**, and the three facts that make it usable — *reel B is muted at ab 0,
  both reels are unity at ab 0.5 (+6 dB), and none of the EQ or filter does anything until a take
  exists* — **cannot live in `face.hint`**: hints are ANNOTATION and OFF by default. The first two
  belong in a `readouts` sidebar block or a band label; the third is what inert-until-a-take
  styling on those knobs says at rest.
- **The hero is the tape**, not a knob: a waveform with the loop window, the playhead and the
  record head — the card already draws all of it (`TwotracksCard.svelte:342-419`).
- **Promote nothing from `node.data`.** Unlike samsloop, twotracks' non-param controls are
  *transport*, not settings, and a transport belongs on the legacy card until the platform grows
  an action-with-state affordance.

---

## 4. DERIVED READOUTS — eight, ranked

**(a) `twotracks-overdub-ceiling` — the best number in the module.** `applyDecay` multiplies the
window by `d = 0.1^(1/echoes)` on each wrap (`packages/dsp/src/twotracks.ts:801-803`;
`twotracks-engine.ts:30-33`) while `recordSpan` **adds** the new pass
(`twotracks-engine.ts:96-97`). Fixpoint `p∞ = a/(1−d)`:

| echoes | d | p∞/input | dB |
|---|---|---|---|
| 1 | 0.1000 | 1.111 | +0.92 |
| **3 (default)** | 0.4642 | 1.866 | **+5.42** |
| 5 | 0.6310 | 2.710 | **+8.66** |

*(INFERENCE — the fixpoint is derived, not written in the source.)*
**NEGATIVE CONTROL:** hold every knob still, engage OVERDUB and let it loop. The tape peak climbs
toward p∞ pass by pass while an ECHOES knob-readback prints a motionless "3". **Nothing on the
panel warns you that ECHOES 5 buys +8.7 dB of clipping risk.**

**(b) `twotracks-headroom` — and the worklet already computes the input.**
`peaks[p] = max|bufL[i]|` over a full partition of `[0, bufLen)`
(`packages/dsp/src/twotracks.ts:842-852`), read as `eng.read(node, 'peaksA')` (`twotracks.ts:538`).
`headroomDb = −20·log10(max(peaks))`; clip is `Math.round(l·0x7fff)` (`twotracks.ts:96`), 1 LSB =
−90.31 dBFS. ⚠ **`peaks` is LEFT-CHANNEL ONLY** — an R-heavy take reads falsely safe.
**NEGATIVE CONTROL:** raise the upstream VCO level and re-record. Headroom moves; **no twotracks
param moves.**

**(c) `twotracks-window-s` / `twotracks-loop-bpm`.**
`windowLen = (min(end, playable) − start)·960000` with
`playable = recordWindowLen(state, bufLen)` (`twotracks-engine.ts:227-238, 44-51`);
seconds = `windowLen/sr`; **period at speed = `windowLen/(sr·|rate|)`**; BPM = `60·|rate|·sr/windowLen`.
**NEGATIVE CONTROL (strong):** with `start`, `end` and `rate` frozen, press **STOP**. `playable`
flips from `tapeLen` (state `rec`) to `bufLen`, so the window *end* — and therefore the printed
duration — changes **on a state transition alone.** No knob readback can see that.

**(d) `twotracks-remaining` — mm:ss.** Total = `960000/sr`; remaining = `(960000 − bufLen)/sr`;
elapsed = `playheadNorm·960000/sr` (`twotracks-engine.ts:209-213`) — ⚠ **this is whole-tape**, so
a 0.2–0.8 loop reads 4.0 → 16.0 s, not 0 → 12 s. **A face must state which.**
**NEGATIVE CONTROL:** set `rate_a = 2` and record. `recordSpan` writes ~2 cells per sample
(`twotracks-engine.ts:76-105`, proven at `twotracks-engine.test.ts:136`), so the **tape burns
twice as fast** while the RATE readout sits at "2×" and says nothing about time.

**(e) speed as semitones.** `st = 12·log₂(|rate|)`; negative → 0 st reversed; 0 → frozen head.
**ips is pure convention — NOT in the source; do not present it as measured.**
**NEGATIVE CONTROL, and it is a real limitation rather than a passing test:** record at rate 2,
play at rate 1. The knob reads 1× and the tape sounds an octave **down**, because the record-time
rate is baked into the medium and **the module stores no `recordRate`.** **A truthful pitch
readout is impossible from the current state.** Say so rather than printing a number.

**(f) `twotracks-lofi` — make-up gain + noise floor.** `+3.164 / +6.336 dB`; hiss −58.8 / −49.2 /
−44.8 dBFS (§1). **NEGATIVE CONTROL:** it must read **exactly 0 at LOFI OFF**, because the whole
block is skipped (`packages/dsp/src/twotracks.ts:937`) — a naive "remember the last mode" display
would keep printing a depth.

**(g) `twotracks-bus-db` — a textbook metric-blindness case.**
`20·log10(gainA + gainB)` from `abGains` (`twotracks.ts:118-125`) → 0 dB at ab 0, **+6.02 dB at
0.5**. **NEGATIVE CONTROL:** sweep ab 0 → 0.5. `gainA` is **invariant at 1.0 the entire way** — so
the card's existing "A:100 %" readout (`TwotracksCard.svelte:558`) *literally cannot move across
half the control's travel* while the bus climbs 6 dB.

**(h) `twotracks-dropout-rate`.** `1/(1/CHEW_PROB/sr + meanGrain)` = **2.143 events/s, 10.7 %
duty** at 48 kHz (`packages/dsp/src/twotracks.ts:969-1020`). **NEGATIVE CONTROL:** it is
`sr`-dependent (`:1020`) — **1.986/s at 44.1 kHz for an identical button state.**

---

## 5. ALREADY-WRONG — still open on `main` (A, B and M are fixed; see the header)

- **C · `packages/web/src/lib/audio/modules/twotracks-transport.ts` (186 lines) IS DEAD CODE**, and
  **a sweep exemption cites its tests as functional justification**
  (`e2e/tests/per-module-per-port-behavioral.spec.ts:177-180`). Nothing imports it but its own
  355-line test (`module-manifest.ts:1390` explicitly excludes it), and it **contradicts the
  shipped worklet twice**: `computeDecayFactor = 0.90 − 0.40x` (`:172-175`) vs the real
  `0.1^(1/n)`; and its ARMED "waits for the cursor to cross start before recording" (`:27, 99-107`)
  vs the shipped frozen ARMED (`packages/dsp/src/twotracks.ts:681-683`). **The module is excused
  from the behavioral lane on the strength of tests for code that never runs.**
- **D · a stale exemption claim.** `per-module-per-port.spec.ts:190` cites
  "twotracks.spec.ts (record → play → SCOPE RMS assert)".
  `grep -i rms e2e/tests/twotracks.spec.ts` → **no matches.** The only audio assertion anywhere is
  `scopePeak > 0.01` in `e2e/tests/twotracks-perfzip.spec.ts:181-184`.
- **E · 48 kHz hardcoded twice** while `sampleRate` is exposed and unused (`twotracks.ts:536`): the
  seconds readout `bufLenA / 48000` (`TwotracksCard.svelte:534, 691`) and the WAV header
  `const sr = 48000` (`twotracks.ts:130`). On a 44.1 kHz context **the readout is 8.8 % wrong and
  exported WAVs play 8.8 % fast.**
- **F · `twotracks.ts:47` says "≈3.7 MB/reel stereo"; `:79` says "~7.7 MB/reel".**
  960 000 × 4 B × 2 ch = 7.68 MB — the first mistook per-channel for stereo.
- **G · five doc claims contradicted by the code.** `rec_start` "starts recording **from the head
  of the tape**" (`:258`) — the rewind is gated on `modeVal === 0`
  (`packages/dsp/src/twotracks.ts:662`) and mode defaults to **1**, so in the default mode it
  punches in wherever the cursor sits. `rec_arm` "arms so **the next pass** drops into record"
  (`:259`) — ARMED never self-advances. `playhead_{s}` "**scrub it** to jump within the take"
  (`:268`) — the param is **inert** (`:648`, `cardParamToWorkletParam` returns null); scrubbing
  goes over the port. `lofi` "adds wow/flutter/**bit-grit**" (`:290`) — there is no bit reduction
  anywhere, and its wow/flutter is amplitude, not pitch. `echoes` "how many times the recorded loop
  **re-circulates**" (`:264`) — it is a scalar decay applied only in overdub.
- **H · `module-manifest.ts:425` is two phases behind:** it documents "a **DECAY knob** that fades
  previous passes by **0.50–0.90×** per loop" (that param no longer exists; the real range is
  0.10–0.63) and says "**Phase 4 adds CV ins**" — rate CV in landed in #1352.
- **I · `overdub_flag` ↔ the worklet flag can desync.** The host pulses a *toggle* on any flag
  change (`twotracks.ts:476-484`) and a patched `overdub_a` gate toggles the same worklet flag
  directly (`packages/dsp/src/twotracks.ts:674-679`) with no write-back. **Drive the gate once and
  the card's OVERDUB button reads OFF while the reel records additively.**
- **J · the four ART scenarios re-implement the lofi chain by hand**
  (`art/scenarios/twotracks/twotracks-lofi-high.test.ts:30-62` duplicates
  `packages/dsp/src/twotracks.ts:948-1003` line for line) instead of importing it — **a mirror that
  cannot detect worklet drift.**
- **K · a unit mismatch on the canvas:** `posPxToNorm` divides by `clientWidth` (~215 CSS px,
  `TwotracksCard.svelte:190`) while `handleHit` and the scrub-velocity divisor are passed
  `canvas.width` (220 buffer px, `:264, 279`) — the 8 px hit radius and the velocity scale are both
  ~2 % off.
- **L · the card re-types every range**, with one live divergence: **`echoes` is
  `curve: 'discrete'` in the def (`twotracks.ts:251, :268`) but `curve="linear"` on the card
  (`TwotracksCard.svelte:516`)**, papered over by a `Math.round(v)` in `onchange`. ⚠ Before
  "fixing" the declaration, check the consumer: these are `<Knob>`, and `Knob.svelte` has no
  `discrete` branch — writing `curve="discrete"` would green a gate and change nothing.
- **N · persistence.** Recorded audio persists **only** through the performance `.zip`
  (`Canvas.svelte:3025-3058` → `load-tape`, `packages/dsp/src/twotracks.ts:490-512`); the plain
  `.imp.json` envelope carries no tape. And twotracks is **not** in
  `TRANSIENT_DATA_FIELDS_BY_TYPE` (`packages/web/src/lib/graph/persistence.ts:121-130`), so a plain
  save/load restores `bufLenA = N` against an **empty tape** — SAVE TAPE enabled, "12.3 s" printed
  — until the worklet's first playhead post corrects it (~11 ms).
