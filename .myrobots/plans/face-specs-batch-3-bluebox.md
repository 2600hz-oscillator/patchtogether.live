# bluebox — face record: the MEASUREMENTS, and what is still open

**BUILT 2026-08-09 — PR #1431.** The face is live in the def; the layout tables, the cell
rationale and the `face` block that used to occupy most of this file have been deleted from here.
What remains is the measurement record and the ledger.

**Where the code and this document disagree, the code is right.**

---

## 0 · SHIPPED vs PROPOSED

- `hero.cell` is `'bluebox-tonebank-{n}'` (not `bluebox-bank`); there is **no `hero.control`, no
  `hero.action` and no `hero.readouts`** — see NEW-A.
- Bands are `1 · the bell grid` and `2 · in-band — the two no receiver decodes`.
- The sidebar's `readouts` block is three FIXED facts.
- **§5's `dtmf-grid` custom sidebar panel was NOT built, deliberately.** Its information — which
  keys light which oscillator — is the *inverse* of the hero bank, so it ships as a label mode ON
  the bank (`Hz` ↔ `keys`) instead of a second component and a second registry entry. That toggle
  doubles as the panel's required operability probe.
- `glyph: 'meter'` shipped and works as hoped: VuMeter on `out`, unlit at spawn because every key
  defaults to 0, so the compact tile is pixel-deterministic (flake-checked 3× `--repeat-each` plus
  3 independent processes).
- Both def changes shipped: `curve: 'discrete'` ×12 and `edge: 'gate'` ×12. The edge change carried
  a cost the spec did not mention — all twelve ports were in `undeclared-edge-ledger.ts`, so
  declaring `edge` meant draining them **and** lowering that ledger's ceiling 289 → 277 in the same
  commit. (That ceiling is since gone; the episode is why counts of this shape are now forbidden.)
- Model + permanent negative controls + the processor pin live in
  `packages/web/src/lib/ui/modules/bluebox-face-model{,.test}.ts`. **No DSP change, no ART
  re-pin** — the one worklet constant the model needs (`BUTTON_VOICE_AMP × OUTPUT_NORM`) is
  mirrored and anchored by MEASURING the shipping processor, because moving it into the shared lib
  would re-pin `bluebox/out.sha` inside a faceplate PR.

⚠ **Owner ruling 2026-08-11** (verbatim at `packages/web/src/lib/audio/modules/rings.ts:585-590`,
`:645-650`): *"we should prefer almost zero AI authored text, and all future faceplate work should
reflect that"* and *"lets stop doing these and clean up the existing ones, get rid of them. lose the
signal flow diagrams."* The `signal-flow` sidebar block this spec proposed (KEYS → TONE BANK →
AR RAMP → FREE PHASE → SINE SUM → OUT) is struck; its numbers are §1 below.

---

## 1 · WHAT IT ACTUALLY DOES

**There is no oscillator per key.** There is one fixed bank of ten sine oscillators whose
amplitudes are driven by which keys are held. That single architectural fact is the whole module,
it was invisible on every surface, and it is what the face exists to show.

1. **Tone table, load time.** `DTMF_TABLE` pins the Bell/ITU-T Q.23 grid — rows 697 / 770 / 852 /
   941, columns 1209 / 1336 / 1477 (`packages/dsp/src/lib/bluebox-dsp.ts:42-65`);
   `BLUEBOX_TONES = [2600]` (`:59`); `REDBOX_TONES = [1700, 2200]` (`:65`).
2. **Unique-frequency dedup.** All twelve buttons' tone lists are poured into a `Set` and sorted:
   `UNIQUE_FREQS = [697, 770, 852, 941, 1209, 1336, 1477, 1700, 2200, 2600]`, `NUM_FREQS = 10`.
3. **Held-key resolution, PER SAMPLE.** Zero all ten `ampTarget`; for each of the twelve buttons
   read the a-rate param `btn_<name>` **and** audio-input channel 0, OR them at a hard `>= 0.5`;
   if on, `ampTarget[f] += BUTTON_VOICE_AMP` for **each** frequency that button lights.
   **That `+=` is the entire story.** Two keys that share a column stack into the same bank slot at
   0.5 instead of two independent 0.25 voices.
4. **One-pole amplitude ramp.** `a += rampK·(tgt − a)`, `rampK = 1 − exp(−1/samples)`,
   `CLICK_RAMP_MS = 1.0`. An **exponential AR envelope with τ = 1 ms**, not a linear ramp.
   Measured against the real processor class: attack 97.7 % at 3 ms, flat by ~8 ms; on release the
   output reaches hard zero **707 samples = 14.73 ms** after the key lifts, **identical for a
   one-tone and a two-tone key**.
5. **Free-running phase.** `p += freq/sr`, wrap, `if (a > 1e-7) sample += a·sin(2πp)`. **Phase
   advances unconditionally, even at zero amplitude** — so the same key pressed at two different
   moments produces two different waveforms (measured: `max|Δwaveform| = 0.497`). Undocumented
   anywhere.
6. **Output.** `out[i] = sample * OUTPUT_NORM` — and `OUTPUT_NORM` is **`0.25`**
   (`packages/dsp/src/bluebox.ts:138`), fixed by #1316 on 2026-08-03.

**Every param is `min 0, max 1, default 0` and the worklet thresholds at 0.5.** So the original
`curve: 'linear'` was a lie about resolution: 0.00 → 0.49 are one state and 0.50 → 1.00 are the
other. There is not one continuous control on this module — twelve binary switches were being
rendered as twelve knobs. Fixed by the `discrete` + `momentary` change.

---

## 2 · THE CORRECTED NUMBERS — these supersede everything below

**§7-A's `OUTPUT_NORM = 1.0` had already been fixed** when this spec was written. Every headline
figure in the original §4-B and §7-A is the **pre-fix** number and is wrong by −12.04 dB.
RE-MEASURED against the real processor class on 2026-08-09:

| held | peak | dBFS |
|---|---|---|
| one digit | **0.1250** | −18.06 |
| four digits | **0.4865** | — |
| all twelve | **1.3304** | +2.48 |

**Full scale arrives at EIGHT digits, not two.**

⚠ **The meta-finding, and it is the transferable one.** The 2026-08-04 staleness banner on this
file said "the def has not been touched since 2026-08-01" — **true of the DEF and false of the
WORKLET**, and the worklet is the file #1316 changed. *A staleness check that reads one of a
module's two files reports confidently about the wrong one.*

Two further corrections to the original arithmetic:

- **§4-A's headroom is a BOUND, not a prediction, and the spec did not say so.** Ten incommensurate
  sines do not all phase-align inside any window a player waits through: measured **1.3304 against
  a 1.4375 bound** at twelve keys, exact at one. Correct as "will not exceed"; wrong as "is".
- **§4-B conflates two different counts.** `{1,4}` and `{1,5}` make four tone *activations* each;
  they light **3 vs 4** distinct oscillators. That difference IS the collapse, so the face
  publishes it as one readout — `tones lit: 3 of 4`.

---

## 3 · THE DERIVED READOUTS, and the negative control that was WRONG

Let `n_f` = the number of currently-held keys whose tone list contains frequency `f`, and
`A = BUTTON_VOICE_AMP = 0.25`.

**`bluebox-rms`** — `RMS = sqrt( ½ · Σ_f (A · n_f)² )`; the ten frequencies are mutually
incommensurate, so the cross-terms average to zero. *Verified against the shipping worklet class to
4 dp on 5/5 cases* (pre-#1316 scaling: `5` → 0.2500; `1,4` → 0.4331; `1,5` → 0.3536;
`2,5,8,0` → 0.7906; all twelve → 1.4250).

**THE NEGATIVE CONTROL — `{1,4}` versus `{1,5}`.** Both hold **exactly two keys**. Both light
**four tone slots**. Both peak at ≈ 1.0 (0.9988 vs 0.9819, pre-fix scaling). Every naive readback
returns the **identical** number for both — "keys held = 2", "Σ btn_* = 2", "tone slots = 4", even
"peak". The true RMS differs by **1.76 dB**, because `1` and `4` share column 1209 and the `+=`
doubles that slot to 0.5, giving it 4× the power of two independent 0.25 voices. **This readout is
the only surface on which the module's headline architectural claim becomes observable.**

**⚠ NEGATIVE RESULT — §4-B's `bluebox-headroom` negative control was ARITHMETICALLY WRONG, and
that is the interesting part.** It claimed that holding `2` then also `5` takes the peak
"0.5 → **0.75**, not → 1.0" because they share column 1336. **It goes to 1.0.** The coherent peak
is `P · (tone activations)`, and a collapse moves amplitude *between* slots without changing the
total — **sharing cannot move the peak at all.** So `headroom` is not a second witness for the
`+=`; it is precisely the readout that is **BLIND** to it, which is exactly what makes it `level`'s
negative control and `level` its. The shipped face uses it that way and pins the correction.

**`bluebox-decode`** — partition the lit slots into rows {697,770,852,941} and columns
{1209,1336,1477}; a real Bell receiver accepts **exactly one row and exactly one column**. Print
the resolved digit or `— 2 cols`. *Negative control:* add `btn_bluebox` to a held digit — key count
moves, headroom moves, RMS moves, and validity is **unchanged**, because 2600 Hz is outside the
DTMF band entirely. Conversely `{1,4}` (two rows, one column) is invalid while a "unique
frequencies = 3" readout reads the same as a valid single digit. **Any readout that is a function
of counts cannot distinguish these; only one that partitions by band can.**

**REJECTED — a "release tail" readout.** It is a **constant** (τ = 1 ms fixed, 14.73 ms to hard
zero) with no param that moves it. It ships as `text: '≈ 15 ms'` in the sidebar, which is what a
fixed fact deserves. Printing a constant through the derived registry would be decoration wearing a
mechanism.

---

## 4 · NEW-A · A durable-param reader on this module is CONSTANT ZERO FOREVER

Not "blind to a press" — **zero, always.** Every param is `face.momentary`, so a press writes the
ENGINE ONLY (`$lib/audio/momentary-params`), *and* a durable write from any other route — the
group/instrument bar, a MIDI-learned CC, an automation lane, a preset recall, the legacy card — is
**scrubbed back to rest within a frame** by `ModuleShell`'s own `clearStuckMomentaryParams`
`$effect`, which reads `node.params` and therefore re-fires on every write. MEASURED through the
real dock: `btn_1 = 1` via `__ydoc.transact` reads back **0**.

`ModuleShell.readoutValue` is durable-only by deliberate platform design, so a `face.hero.readouts`
entry here would print `silent` on every render of its life. The ENGINE handle does see it
(measured: `readParam(node,'btn_1')` is 0 / **1 while held** / 0), so the hero PANEL polls the
engine on rAF (memoized on a 12-bit held mask) and **owns the five numbers**. One source, one
component — rather than a live picture beside three dead labels.
**Platform follow-up: a live-engine reader for `FaceReadout`.**

A GATE CABLE remains invisible and always will be from the host side: those twelve inputs are
worklet NODE inputs, not AudioParam connections.

## 5 · NEW-B · `curve: 'discrete'` blanked the Push 2 card, and the gate mis-explained it

Discrete ⇒ `looksLikeSwitch` ⇒ `face.momentary` ⇒ skipped at every push-card tier (an encoder
cannot press a key), making bluebox the first module with params but nothing to turn. Two
`push-card-schema.test.ts` assertions went red **while describing the wrong thing** — one compared
the blank-card set against `params.length === 0`, an equality that only held while no module's
entire param list was press-pads. Both now derive the real predicate.

**Not a regression:** the old generic tier put eight of twelve keys on encoders as continuous 0..1
dials, dropped 9/0/BLUEBOX/REDBOX, and wrote a *durable* held-key value into the Y.Doc — the exact
data-integrity bug `momentary-params` exists to prevent. A keypad wants the Push's 64 PADS;
different surface, real follow-up.

## 6 · NEW-C · The `face.order` answer

The spec's position was "ranks exist only because the lint demands them" — there is no principled
answer to "which six of a telephone keypad matter most", and the lane's information is the GLYPH,
not a subset of the keys. The shipped face goes one step further: it **ranks by LAYOUT**, and the
property that buys is that **every prefix of the ranking is still a recognisable keypad fragment**.
The order is DERIVED from `BLUEBOX_BUTTON_NAMES` rather than typed, and asserted. The one genuinely
principled alternative — the **minimal bank cover** `{1,5,9,0,BLUEBOX,REDBOX}`, which really is the
smallest set of keys lighting all ten oscillators — was checked and rejected: in a lane tile it
reads as a broken phone, and it is no more true.

---

## 7 · DEFECT LEDGER

| # | item | verdict |
|---|---|---|
| **A** | `OUTPUT_NORM = 1.0` contradicted three separate comments and the module clipped at two digits | ✅ **FIXED** (#1316, 2026-08-03) — `packages/dsp/src/bluebox.ts:138` is `0.25`. §2 has the corrected measurements. |
| **B** | "no envelope, no attack, no decay" is **false** — a one-pole with τ = 1 ms and 14.73 ms of exponential release to hard zero, i.e. a short AD tail | ✅ fixed with the face |
| **C** | a CV wiring that does not exist — the def claimed "the engine wires CV cables targeting the same paramTarget … via the cv-scale fast path", but **no port declares `paramTarget`** and the factory makes every input a plain node connection | ✅ fixed with the face |
| **D** | **Bell twist is 0 dB.** Real DTMF generators apply ~+2 dB forward twist (column louder than row); here both get an identical `BUTTON_VOICE_AMP`. Not a bug — but a face that says "the Bell grid" should not imply spec fidelity it does not have. | recorded |
| **E** | card re-typed the port cable type (`cable: 'gate' as const`) one line above a correct `portsFromDef(blueboxDef.outputs)` — the same defect class as backdraft, one field over | ✅ fixed with the face |
| **F** | **the Push 2 card silently drops four keys** | ⛔ **STILL OPEN — CONFIRMED.** There is **no bluebox entry** in `packages/web/src/lib/control/push2/push-card-config.ts`, so the generic tier takes declaration order against `PUSH_CARD_SLOTS = 8`: keys **1-8 only**; 9, 0, BLUEBOX and REDBOX never reach the hardware. (NEW-B changed *how* it fails — the card is now blank rather than eight wrong encoders — but the four keys are still unreachable.) |

**VRT, corrected.** The original §8 was wrong about the drain: `bluebox`'s `EXEMPT_FROM_VRT` entry
covers the LEGACY CARD and did **not** need draining; the face scenes are separate
(`face-bluebox-{compact,dock}` in `workflow-shell-faces.spec.ts`) and enrol by one line in
`e2e/vrt/_shell-faces.ts`. The dock scene is captured **UNFOLDED** (the whole faceplate), not
clamped to the top ~425 px.

⚠ **faces-parity drives every cell; a momentary switch's drive branch must press *and release*,**
or a held key leaks into the next assertion.
