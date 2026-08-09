# FACE SPEC — `bluebox` (batch 3)

> # BUILT 2026-08-09 — branch `face/bluebox`, PR #1431.
>
> **This document is now a RECORD, not a plan.** Where the code and this spec disagree,
> **the code is right.** Everything below is preserved as written; the corrections are here,
> because several of the errors are instructive.
>
> ## What was STALE, item by item
>
> 1. **§7-A — `OUTPUT_NORM = 1.0` HAD ALREADY BEEN FIXED.** It is `0.25` on `main` and has
>    been since **2026-08-03 (#1316)**. Every headline number in §4-B and §7-A is the
>    **pre-fix** figure and is now wrong by −12.04 dB. RE-MEASURED against the real processor
>    class on 2026-08-09: one digit peaks **0.1250 (−18.06 dBFS)**, four digits **0.4865**,
>    all twelve **1.3304 (+2.48 dBFS)** — and **full scale arrives at EIGHT digits**, not two.
>    ⚠ The 2026-08-04 staleness banner below said "the def has not been touched since
>    2026-08-01", which was true of the DEF and false of the WORKLET — and the worklet is the
>    file #1316 changed. *A staleness check that reads one of a module's two files reports
>    confidently about the wrong one.*
> 2. **§4-B's negative control is ARITHMETICALLY WRONG, and that is the interesting part.**
>    It claims holding `2` then also `5` takes the peak "0.5 → **0.75**, not → 1.0" because
>    they share column 1336. It goes to **1.0**. The coherent peak is `P · (tone activations)`,
>    and a collapse moves amplitude *between* slots without changing the total — **sharing
>    cannot move the peak at all**. So `headroom` is not a second witness for the `+=`; it is
>    precisely the readout that is BLIND to it, which is what makes it `level`'s negative
>    control and `level` its. The shipped face uses it that way and pins the correction.
> 3. **§4-B conflates two different counts.** `{1,4}` and `{1,5}` make four tone
>    *activations* each; they light **3 vs 4** distinct oscillators. That difference IS the
>    collapse, so the face publishes it as one readout — `tones lit: 3 of 4`.
> 4. **§4-A's headroom is a BOUND, not a prediction, and the spec did not say so.** Ten
>    incommensurate sines do not all phase-align inside any window a player waits through:
>    measured 1.3304 against a 1.4375 bound at twelve keys, exact at one. Correct as "will
>    not exceed"; wrong as "is".
> 5. **§3's `glyph: 'meter'` flag can be closed: it works as hoped.** VuMeter on `out`, unlit
>    at spawn because every key defaults to 0, so the compact tile is pixel-deterministic
>    (flake-checked 3× `--repeat-each` plus 3 independent processes).
> 6. **§5's `dtmf-grid` custom sidebar panel was NOT built, deliberately.** Its information —
>    which keys light which oscillator — is the *inverse* of the hero bank, so it ships as a
>    label mode ON the bank (`Hz` ↔ `keys`) instead of a second component and a second
>    registry entry. That toggle doubles as the panel's required operability probe.
> 7. **§6-CHANGE-1 and §6-CHANGE-2 both SHIPPED** (`curve: 'discrete'` ×12, `edge: 'gate'`
>    ×12). CHANGE-2 carried a cost the spec did not mention: all twelve ports were in
>    `undeclared-edge-ledger.ts`, so declaring `edge` meant draining them **and** lowering
>    `UNDECLARED_EDGE_CEILING` 289 → 277 in the same commit. CHANGE-1 carried one the spec
>    also missed — see §NEW-B.
> 8. **§8's VRT row is wrong about the drain.** `bluebox`'s `EXEMPT_FROM_VRT` entry covers the
>    LEGACY CARD and did **not** need draining; the face scenes are separate
>    (`face-bluebox-{compact,dock}` in `workflow-shell-faces.spec.ts`) and enrol by one line
>    in `e2e/vrt/_shell-faces.ts`. Also: the dock scene is captured **UNFOLDED** now (the
>    whole faceplate), not clamped to the top ~425 px.
> 9. **§7-B, §7-C and §7-E are REAL and were all fixed here.** §7-B measured: **707 samples =
>    14.73 ms** to hard zero, identical for a one-tone and a two-tone key. §7-D and §7-F stand
>    as filed (§7-F in a different form — see §NEW-B).
>
> ## NEW-A · The thing the spec could not have known, and it inverts the face's data path
>
> **A durable-param reader on this module is CONSTANT ZERO FOREVER.** Not "blind to a press" —
> zero, always. Every param is `face.momentary`, so a press writes the ENGINE ONLY
> (`$lib/audio/momentary-params`), *and* a durable write from any other route — the
> group/instrument bar, a MIDI-learned CC, an automation lane, a preset recall, the legacy
> card — is **scrubbed back to rest within a frame** by `ModuleShell`'s own
> `clearStuckMomentaryParams` `$effect`, which reads `node.params` and therefore re-fires on
> every write. MEASURED through the real dock: `btn_1 = 1` via `__ydoc.transact` reads back 0.
>
> `ModuleShell.readoutValue` is durable-only by deliberate platform design, so a
> `face.hero.readouts` entry here would print `silent` on every render of its life. The ENGINE
> handle does see it (measured: `readParam(node,'btn_1')` is 0 / **1 while held** / 0), so the
> hero PANEL polls the engine on rAF (memoized on a 12-bit held mask) and **owns the five
> numbers**. One source, one component — rather than a live picture beside three dead labels.
> **Platform follow-up: a live-engine reader for `FaceReadout`.**
>
> A GATE CABLE remains invisible and always will be from the host side: those twelve inputs
> are worklet NODE inputs, not AudioParam connections.
>
> ## NEW-B · `curve: 'discrete'` blanked the Push 2 card, and the gate mis-explained it
>
> Discrete ⇒ `looksLikeSwitch` ⇒ `face.momentary` ⇒ skipped at every push-card tier (an
> encoder cannot press a key), making bluebox the first module with params but nothing to
> turn. Two `push-card-schema.test.ts` assertions went red while describing the wrong thing —
> one compared the blank-card set against `params.length === 0`, an equality that only held
> while no module's entire param list was press-pads. Both now derive the real predicate.
> **Not a regression:** the old generic tier put eight of twelve keys on encoders as
> continuous 0..1 dials, dropped 9/0/BLUEBOX/REDBOX (this is §7-F, in its live form), and
> wrote a *durable* held-key value into the Y.Doc — the exact data-integrity bug
> `momentary-params` exists to prevent. A keypad wants the Push's 64 PADS; different surface,
> real follow-up.
>
> ## NEW-C · The `face.order` answer, since the spec deliberately left it open
>
> The spec's position was "ranks exist only because the lint demands them". The shipped face
> goes one step further: it **ranks by LAYOUT**, and the property that buys is that **every
> prefix of the ranking is still a recognisable keypad fragment**. The order is DERIVED from
> `BLUEBOX_BUTTON_NAMES` rather than typed, and asserted. The one genuinely principled
> alternative — the **minimal bank cover** `{1,5,9,0,BLUEBOX,REDBOX}`, which really is the
> smallest set of keys lighting all ten oscillators — was checked and rejected: in a lane tile
> it reads as a broken phone, and it is no more true.
>
> ## As-built, where it differs from §3
>
> `hero.cell` is `'bluebox-tonebank-{n}'` (not `bluebox-bank`); there is no `hero.control`, no
> `hero.action` and **no `hero.readouts`** (NEW-A). Bands are `1 · the bell grid` and
> `2 · in-band — the two no receiver decodes`. The sidebar's `readouts` block is three FIXED
> facts. Model + permanent negative controls + the processor pin:
> `packages/web/src/lib/ui/modules/bluebox-face-model{,.test}.ts`.
> **No DSP change, no ART re-pin** — the one worklet constant the model needs
> (`BUTTON_VOICE_AMP × OUTPUT_NORM`) is mirrored and anchored by MEASURING the shipping
> processor, because moving it into the shared lib would re-pin `bluebox/out.sha` inside a
> faceplate PR.

---

**Status (as originally written):** SPEC + MOCKUP ONLY. Designed against the PF-20 platform on
> ⚠ **STATUS CORRECTED 2026-08-04.** PF-20 (**PR #1301**) **HAS MERGED** (`c6ff9253`) — read
> the def on `main`, not `origin/feat/faceplate-platform-v2`. **bluebox is UNBUILT: this is
> LIVE BACKLOG, not stale.** `packages/web/src/lib/audio/modules/bluebox.ts` has not been
> touched since 2026-08-01, so the measurements below still stand. Two platform facts landed
> after this was written: **PF-21 dock ROW PACKING** (`9bf12df7`), and **`face.title` /
> `face.hint` are ANNOTATION-ONLY** — `facePageHeader()` returns `null` unless annotate mode
> is on (`dock-faceplate-model.ts:90`; owner decision 2026-08-03).

`feat/faceplate-platform-v2` (PR #1301 — MERGED, `c6ff9253`). Every claim about current behaviour
carries a file:line; inferences are labelled.

**Verdict: PROMOTE — but the face is a KEYPAD, not a knob rank, and that changes what
`face.order` can honestly mean.** · archetype: **DIALER — twelve momentary keys into one
ten-slot sine bank.**

Not in `STRICT_FACES` (`packages/web/src/lib/ui/workflow/strict-faces.ts:42-65`), no `face:`
block. 12 params, 12 gate inputs, 1 mono output. contract-lock block = **26 lines**
(`packages/web/src/lib/docs/contract-lock.txt:302-327`: 1 meta + 12 in + 1 out + 12 param) —
**24 of those 26 lines are one repeated shape.**

---

## 1. WHAT IT ACTUALLY DOES

**There is no oscillator per key.** There is one fixed bank of ten sine oscillators whose
amplitudes are driven by which keys are held. That single architectural fact is the whole
module, it is currently invisible on every surface, and it is what the face exists to show.

1. **Tone table, load time.** `DTMF_TABLE` pins the Bell/ITU-T Q.23 grid — rows 697 / 770 /
   852 / 941, columns 1209 / 1336 / 1477 (`packages/dsp/src/lib/bluebox-dsp.ts:42-65`);
   `BLUEBOX_TONES = [2600]` (`:59`); `REDBOX_TONES = [1700, 2200]` (`:65`).
2. **Unique-frequency dedup.** All twelve buttons' tone lists are poured into a `Set` and
   sorted: `UNIQUE_FREQS = [697, 770, 852, 941, 1209, 1336, 1477, 1700, 2200, 2600]`,
   `NUM_FREQS = 10` (`packages/dsp/src/bluebox.ts:120-137, 131-132`).
3. **Held-key resolution, PER SAMPLE.** Zero all ten `ampTarget` (`bluebox.ts:205`); for each
   of the twelve buttons read the a-rate param `btn_<name>` **and** audio-input channel 0,
   OR them at a hard `>= 0.5` (`bluebox.ts:210-216`); if on,
   `ampTarget[f] += BUTTON_VOICE_AMP` for **each** frequency that button lights
   (`bluebox.ts:219-221`). **That `+=` is the entire story.** Two keys that share a column
   stack into the same bank slot at 0.5 instead of two independent 0.25 voices.
4. **One-pole amplitude ramp.** `a += rampK·(tgt − a)`, `rampK = 1 − exp(−1/samples)`,
   `samples = (CLICK_RAMP_MS/1000)·sr`, `CLICK_RAMP_MS = 1.0` (`bluebox.ts:183-184, 99,
   226-230`). This is an **exponential AR envelope with τ = 1 ms**, not a linear ramp.
   *(Measured by the research pass against the real processor class: attack 97.7 % at 3 ms,
   flat by ~8 ms; on release the output reaches hard zero **14.73 ms** after the key lifts.)*
5. **Free-running phase.** `p += freq/sr`, wrap, `if (a > 1e-7) sample += a·sin(2πp)`
   (`bluebox.ts:235-240`). **Phase advances unconditionally, even at zero amplitude** — so
   the same key pressed at two different moments produces two different waveforms
   (*measured: `max|Δwaveform| = 0.497`*). Undocumented anywhere.
6. **Output.** `out[i] = sample * OUTPUT_NORM`, and `OUTPUT_NORM = 1.0` (`bluebox.ts:242,
   113`) — **there is no normalisation at all.** See §6.

---

## 2. THE CONTROLS THAT MATTER — all twelve, and the ranking is a lie I will not tell

Every param is `min 0, max 1, curve 'linear', default 0` (`bluebox.ts:112-119`), and
`bluebox.ts:216` thresholds at 0.5. **So `curve: 'linear'` is a lie about resolution: 0.00 →
0.49 are one state and 0.50 → 1.00 are the other.** There is not one continuous control on
this module. Twelve binary switches are being rendered as twelve knobs.

**⚠ THE HONEST PROBLEM WITH `face.order` HERE, stated rather than papered over.** `order` is
a *priority ranking for tiers that show a subset* (`curated-face.ts:49-60`; the DX7 plan
§3.2 states the convention). The lane budget is six
(`LANE_PLATE_MAX_CELLS`, `curated-face.ts:46,65`) and the compact tile is two
(`faceTierCap('compact', true) = LANE_ROW_MAX_CELLS_WITH_GLYPH`, `curated-face.ts:76-79`).
**There is no principled answer to "which six of a telephone keypad matter most."** Ranking
`1 2 3 4 5 6` is declaration order wearing a justification. Ranking the two phreak keys first
is worse — they are the rarest.

The face therefore takes an explicit position: **the lane tiers do not carry keys as their
information; the GLYPH does.** Ranks exist because `module-face-lint` requires every param to
be ranked for a `STRICT_FACES` member, and they are declared in keypad reading order with a
comment saying exactly this. The lane's job is to show the tone bank lighting up; the dock's
job is to be a keypad.

**Losers, named:** nothing is cut. What loses is the *idea* that a keypad can be ranked —
and the alternative design it loses to is putting the module's information in the glyph and
the hero instead of in a rank.

---

## 3. THE FACE

```ts
face: {
  title: 'Dialer',
  hint:
    'Twelve momentary keys into ONE bank of ten sine oscillators. A digit lights a ROW tone ' +
    'and a COLUMN tone; two keys that share a tone stack into the same oscillator, which is ' +
    'why some pairs are louder than others. Nothing is normalised — two digits is already 0 dBFS.',

  // ⚠ THIS RANKING IS DECLARATION ORDER AND SAYS SO. There is no principled
  // "which six keys matter most" on a telephone keypad; a rank here would be a
  // justification invented after the fact. The lane's information is the GLYPH
  // (the ten-slot bank), not a subset of the keys. Ranks exist because
  // module-face-lint requires every param of a STRICT_FACES member to be ranked.
  order: [
    'btn_1','btn_2','btn_3','btn_4','btn_5','btn_6',
    'btn_7','btn_8','btn_9','btn_0','btn_bluebox','btn_redbox',
    'bluebox-bank-{n}',            // rank 13 — a panel's first legal rank is 7
  ],
  pages: [
    { id: 'keypad', label: '1 · keypad',  hint: 'the Bell grid — each digit lights one ROW tone and one COLUMN tone, summed',
      controls: ['bluebox-bank-{n}','btn_1','btn_2','btn_3','btn_4','btn_5','btn_6','btn_7','btn_8','btn_9','btn_0'] },
    { id: 'inband', label: '2 · in-band', hint: 'single tones outside the DTMF grid: 2600 alone, and the 1700 + 2200 pair',
      controls: ['btn_bluebox','btn_redbox'] },
  ],
  glyph: 'meter',   // see §5 — and see the ⚠ below, this is a REQUEST, not a fact

  hero: {
    cell: 'bluebox-bank-{n}',
    readouts: [
      { label: 'level',    valueId: 'bluebox-rms' },
      { label: 'headroom', valueId: 'bluebox-headroom' },
      { label: 'decodes',  valueId: 'bluebox-decode' },
    ],
  },

  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'KEYS',        role: 'generator', note: '≥ 0.5' },
      { label: 'TONE BANK',   role: 'bus', note: '10 slots, += 0.25' },
      { label: 'AR RAMP',     role: 'bus', note: 'τ 1 ms' },
      { label: 'FREE PHASE',  role: 'bus', parallel: true, note: 'never reset' },
      { label: 'SINE SUM',    role: 'bus', note: 'no normalise' },
      { label: 'OUT',         role: 'bus', note: 'mono' },
    ] },
    { kind: 'custom', label: 'bell grid', panelId: 'dtmf-grid',
      props: { rows: '697,770,852,941', cols: '1209,1336,1477' } },
    { kind: 'readouts', label: 'bank', entries: [
      { label: 'keys held',  valueId: 'bluebox-keys' },
      { label: 'tones lit',  valueId: 'bluebox-tones' },
      { label: 'release',    text: '≈ 15 ms' },
    ] },
  ],
}
```

⚠ **`glyph: 'meter'` is a request the platform may not honour as written, and I am flagging
it rather than asserting it.** `glyphBinding` resolves a glyph against the primary audio
output (`packages/web/src/lib/ui/workflow/shell-glyph-live.ts:96,126`), so `'meter'` gives a
VuMeter on `out` — which is *correct and useful here* (headroom is the module's real hazard),
but it is not the ten-slot bank. Painting the bank in the lane would need a new glyph kind,
which the DX7 program demotes for good reason (`.myrobots/plans/dx7-and-faces-design-program-2026-07-27.md`,
the DEMOTED table). **So: `'meter'` ships, the bank lives in the dock hero, and the lane
tile's honest information is "how hot is it".** That is the right trade given §6.

---

## 4. DERIVED READOUTS — and this module has the best negative control in the batch

Let `n_f` = the number of currently-held keys whose tone list contains frequency `f` (exactly
what `bluebox.ts:220` accumulates) and `A = BUTTON_VOICE_AMP = 0.25` (`bluebox.ts:105`).

### A. `bluebox-rms` — output RMS

```
RMS = sqrt( ½ · Σ_f (A · n_f)² )          # the ten frequencies are mutually incommensurate,
                                          # so the cross-terms average to zero
```

*Verified against the shipping worklet class to 4 dp on 5/5 cases: `5` → 0.2500;
`1,4` → 0.4331; `1,5` → 0.3536; `2,5,8,0` → 0.7906; all twelve → 1.4250.*

**NEGATIVE CONTROL — `{1,4}` versus `{1,5}`.** Both hold **exactly two keys**. Both light
**four tone slots**. Both peak at ≈ 1.0 (0.9988 vs 0.9819). Every naive readback returns the
**identical** number for both — "keys held = 2", "Σ btn_* = 2", "tone slots = 4", even
"peak". The true RMS differs by **1.76 dB**, because `1` and `4` share column 1209 and
`bluebox.ts:220`'s `+=` doubles that slot to 0.5, giving it 4× the power of two independent
0.25 voices. **This readout is the only surface on which the module's headline architectural
claim (`bluebox.ts:42-47`) becomes observable to a player.**

### B. `bluebox-headroom` — the safety number, and it is not decoration

```
peak = Σ_f A·n_f = 0.25 · T,   T = Σ_{held b} |tones(b)|      # OUTPUT_NORM = 1.0, bluebox.ts:113
headroom_dB = −20·log10(peak)
```

Exact because the mutually-prime frequencies sweep every relative phase within ~1 s.
*Measured:* `1,4` → 0.9988; `1,2,3` → **1.4858 (+3.44 dBFS)**; `2,5,8,0` → **1.9456
(+5.78 dBFS)**; all twelve → **5.3174 (+14.51 dBFS)**.

**One digit = −6 dBFS. Two digits = exactly 0 dBFS. Three digits clips.**

**NEGATIVE CONTROL:** hold `2` and then also hold `5`. Both are single keys, both light two
slots — but they share column 1336, so the peak goes 0.5 → **0.75**, not → 1.0. A readout
that counted keys (or that summed each key's own contribution independently) prints the same
number for `{2,5}` and `{1,5}`; the derived headroom differs by 2.5 dB. Second leg: hold
`bluebox` (2600 Hz), which shares no slot with anything — the peak moves by exactly one
`A`, and a shared-slot model that predicted otherwise is falsified.

### C. `bluebox-decode` — domain truth, as text

Partition the lit slots into rows {697,770,852,941} and columns {1209,1336,1477}. A real Bell
receiver accepts **exactly one row and exactly one column**. Print the resolved digit, or
`— 2 cols`.

**NEGATIVE CONTROL:** add `btn_bluebox` to a held digit. Key count moves (2→3), headroom
moves (+1.9 dB), RMS moves — and validity is **unchanged**, because 2600 Hz is outside the
DTMF band entirely (`bluebox-dsp.ts:59` vs `:42-53`). Conversely `{1,4}` (two rows, one
column) is invalid while a "unique frequencies = 3" readout reads the same as a valid single
digit. Any readout that is a function of *counts* cannot distinguish these; only one that
partitions by band can.

### D. Rejected — and worth stating

A "release tail" readout. It is a **constant** (τ = 1 ms fixed at `bluebox.ts:99`, 14.73 ms
to hard zero) with no param that moves it. It ships as `text: '≈ 15 ms'` in the sidebar,
which is what a fixed fact deserves. Printing a constant through the derived registry would
be decoration wearing a mechanism.

---

## 5. BESPOKE CELL vs PLATFORM

**LEGITIMATE — `bluebox-bank-{n}`, the ten-slot tone bank.** Ten vertical bars, one per
`UNIQUE_FREQS` entry, height = `0.25·n_f`, labelled with the frequency, row tones and column
tones tinted differently, the phreak tones a third colour, and a clip line at 1.0. **This is
the only picture that makes `+=` visible**, and no def introspection synthesises it — it is
derived from `BUTTON_FREQ_INDICES` (`bluebox.ts:144-150`), which is DSP data.

**LEGITIMATE — `dtmf-grid`, a `custom` sidebar panel.** A 4×3 grid annotated with its row and
column frequencies. It is generic in exactly the way `stereo-crossover` is generic (the
picture is a labelled matrix; the frequencies are declared `props`), so it registers in
`sidebar-panels.ts` and takes its numbers from the block, not from a hardcoded table.

**NOT LEGITIMATE, explicitly rejected:** a bespoke keypad component. The keys are twelve
ordinary param cells; the platform renders them. What the *def* should do instead is make
them look like what they are — see §6.

---

## 6. RANGES, CURVES, AND THE TWO CHANGES THIS FACE ASKS FOR

**CHANGE 1 — `curve: 'linear'` → `curve: 'discrete'` on all twelve params.** Today
`looksLikeToggle` requires `curve === 'discrete'`
(`packages/web/src/lib/ui/group-controls.ts:46-47`), so the auto-expose path picks
`kind: 'knob'` (`group-controls.ts:84`) and **every key surfaces on a group bar as a
continuous 0..1 knob with two audible positions.** The def's header celebrates that
auto-expose (`bluebox.ts:37-40`) without noticing what it produces. With `discrete`, PF-2's
`'toggle'` cell kind renders them as switches at every tier — which is what they are.
**Contract cost: 12 modified lines in `contract-lock.txt` (`linear` → `discrete`), 0 added.**
⚠ These are `0..1 discrete default 0`, i.e. exactly `looksLikeSwitch` shape — so they must
also be classified in `face.momentary` (they are momentary: `BlueboxCard.svelte:49-61`
writes 1 on `pointerdown` and 0 on `pointerup`), or `module-face-lint`'s switch-classification
ratchet fails.

**CHANGE 2 — declare `edge: 'gate'` on all twelve gate ports.** They are textbook
level-sensitive consumers and the docs prose already says so verbatim
(`bluebox.ts:132,137,144` "Level-sensitive, not edge-triggered"), but **no port declares
`edge:`** (`contract-lock.txt:303-314` shows bare `bluebox in gate_N gate`), and
`module-docs-lint`'s edge-vocabulary gate short-circuits on `if (!p.edge) continue`
(`packages/web/src/lib/audio/modules/module-docs-lint.test.ts:217`) — so that prose is
asserted by nothing. **Contract cost: 12 modified lines (`+ edge=gate`), 0 added.**

**No min/max/default changes.** The card does not re-type numeric ranges (there are none),
but it **does** re-type the port cable type: `cable: 'gate' as const`
(`packages/web/src/lib/ui/modules/BlueboxCard.svelte:101-104`) one line above a correct
`portsFromDef(blueboxDef.outputs)` (`:105`). `portsFromDef` exists precisely so a card cannot
disagree with its def (`card-kit.ts:57-65`, whose comment cites the backdraft incident at
`:71-77`). Same defect class, one field over; fix it in the same PR.

---

## 7. ALREADY-WRONG

- **A · `OUTPUT_NORM = 1.0` contradicts three separate comments, and the module clips at two
  digits.** `bluebox.ts:52` promises "mono sum, **normalized so 4 held buttons don't clip**";
  `:101-104` says "**NORM below divides by 4** … so the worst case stays inside [−1,1]";
  `:107-112` says "**we scale by 1/4**". The code multiplies by **1.0** (`:113`). *Measured:*
  four held digits peak at **1.9456 (+5.78 dBFS)**, all twelve at **5.3174 (+14.51 dBFS)**.
  The guarantee fails at **two** digits, not four. The `:107-112` arithmetic is also wrong on
  its own terms (`12×2×0.25` over-counts — BLUEBOX emits one tone; the true coherent bound is
  5.75, which is what the measurement asymptotes to). **This is the single biggest defect on
  the module and §4-B exists to mitigate it.**
- **B · "no envelope, no attack, no decay" is false.** Asserted at `bluebox.ts:20-23`, `:8-9`,
  `packages/web/src/lib/docs/module-manifest.ts:365`, and `docs.explanation`
  (`bluebox.ts:151`). It is a one-pole with τ = 1 ms and **14.73 ms of exponential release**
  to hard zero — a short AD tail, not a ramp.
- **C · a CV wiring that does not exist.** `bluebox.ts:30-32` claims "the engine wires CV
  cables targeting the same paramTarget to these params via the cv-scale fast path used
  elsewhere". **No port declares `paramTarget`** (`bluebox.ts:107-110`) and the factory makes
  every input a plain node connection (`bluebox.ts:180-182`).
- **D · Bell twist is 0 dB.** Real DTMF generators apply ~+2 dB forward twist (column louder
  than row); here both get an identical `BUTTON_VOICE_AMP` (`bluebox.ts:220`). Not a bug —
  but a face that says "the Bell grid" should not imply spec fidelity it does not have.
- **E · card re-types the port cable type** — §6.
- **F · the Push 2 card silently drops four keys.** No `PUSH_CARD_CONTROLS` entry
  (`packages/web/src/lib/control/push2/push-card-config.ts`), so the generic tier takes
  declaration order and `PUSH_CARD_SLOTS = 8` — keys **1-8 only**; 9, 0, BLUEBOX and REDBOX
  never reach the hardware.

---

## 8. COST

| | |
|---|---|
| **contract-lock** | **+1 line** (`bluebox family bluebox-bank kind=cell prefix=bluebox-bank`) **+ 24 MODIFIED lines** if §6's two changes ship with it (12 `linear`→`discrete`, 12 `+ edge=gate`). Net line count 26 → 27. `task docs:accept`, then review the diff line by line — a 24-line modification is exactly the kind of accept a reviewer must read rather than rubber-stamp. |
| **ART** | none — no `.dsp` or worklet edit. §6 changes only `ParamDef.curve` and `PortDef.edge`, both host-side metadata; the worklet's `>= 0.5` threshold (`bluebox.ts:216`) is untouched, so no sample moves. |
| **VRT — the trap** | **`bluebox` is in `EXEMPT_FROM_VRT`** (`e2e/vrt/vrt-exemptions.ts:259` for the const, entry at `:732`) — an **unconditional both-platform skip**, not a per-platform pair. So the legacy card has **zero pixel coverage today** and `--update-snapshots` writes nothing for it while that entry stands. A face means: drain the `EXEMPT_FROM_VRT` entry **first, in its own pushed commit**, then capture. New scenes: `face-bluebox-compact` + `face-bluebox-dock` × 2 platforms = **4 baselines**, plus the two legacy-card baselines the drain unblocks. |
| **e2e** | +1 `faces-parity` row (13 cells) in the REQUIRED lane. ⚠ faces-parity drives every cell; a momentary switch's drive branch must press *and release*, or a held key leaks into the next assertion. |
