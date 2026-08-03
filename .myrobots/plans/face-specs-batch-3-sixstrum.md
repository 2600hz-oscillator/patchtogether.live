# FACE SPEC — `sixstrum` (batch 3) — **RE-DO of a SHIPPED face**

**Status:** SPEC + MOCKUP ONLY. PF-20 platform (PR #1301, unmerged). Citations file:line.

**Verdict: RE-DO, and the current face is worse than the batch's un-faced modules in one specific
way — the instrument cannot be played from it at all.** · archetype:
**INSTRUMENT** (voice + strummer + chord voicer in one), not a voice.

**Already in `STRICT_FACES`** (`packages/web/src/lib/ui/workflow/strict-faces.ts:54`) and
`STRICT_DOCS`. 19 params, 22 in / 1 out, 1 existing control family. contract-lock block =
**44 lines** (`contract-lock.txt:2919-2962`: 1 meta + 22 in + 1 out + 19 param + 1 family).

---

## 1. WHAT THE CURRENT FACE GETS WRONG

Read from the committed baseline
`e2e/vrt/__screenshots__/workflow-shell-faces.spec.ts/darwin/face-sixstrum-dock.png` (1220×425),
the shipped `face:` block (`packages/web/src/lib/audio/modules/sixstrum.ts:137-176`) and the DSP.
The PNG shows: a `SIXSTRUM` header with the sub-line **`SOURCES`**, a flat dark scope glyph, band
`STRUM · DAMP` with three bare knobs, band `STRING` with four bare knobs — **and then the image
ends.**

**(a) THE AUDITION IS GONE — the module is unplayable under `?shell=1`.** The legacy card has the
`⟋` STRUM button (`packages/web/src/lib/ui/modules/SixstrumCard.svelte:188-194`) driving
`read('manualTrigger')` (`sixstrum.ts:378-385`). `SHELL_CELLS.sixstrum` registers **only**
`sixstrum-preset-{n}` (`packages/web/src/lib/ui/workflow/shell-cells.ts:356-371`), and
`face.order` has no strike key. With nothing patched, the dock offers twenty controls over a voice
that cannot be sounded. **Two comments in the repo assert the opposite** —
`shell-cells.ts:320` ("*while tomtom, karplus and sixstrum can all be auditioned*") and
`packages/web/src/lib/audio/manual-strike-actions.ts:9` (lists sixstrum among modules answering
the seam). Both are false for the shell.

**(b) HALF THE HERO PLATE IS INAUDIBLE WITHOUT A RE-PLUCK.** Ranks 1-6 today are
`strumSpread, ring, material, pickTone, muteDepth, register` (`sixstrum.ts:139-144`). The pitch is
**latched at the strike**: `targetCv = baseCv + register/12 + detune[i]`
(`packages/dsp/src/lib/sixstrum-dsp.ts:342`) is written into `heldPitchCv[i]` **only at a strike**
(`:352, 376, 386`) and the voice reads the held value (`:398`). **So REGISTER, TUNING, QUALITY,
SPREAD and the CHORD root do nothing to a sounding string.** `pickTone` is likewise next-strike
only (the burst LPF, `packages/dsp/src/lib/karplus-dsp.ts:405-409`); `strumSpread` is
next-*gesture* only and **fully dead in poly mode** (the strum branch is `else`-only,
`sixstrum-dsp.ts:346/358`); `muteDepth` needs one of twelve rear jacks
(`muteTarget = damp ≥ 0.5 ? 1 : 0`, `:404`). **Only `ring` and `material` move a ringing string.**
Combined with (a): three of six hero knobs change nothing you can hear, on a module you cannot
strike.

**(c) DISCRETE PARAMS PRINT NUMBERS, NOT NAMES.** `paramCellKind` routes to
`segmented`/`selector` **only when `p.options` exists**
(`packages/web/src/lib/ui/workflow/shell-control-kind.ts:133-135`), and `knobReadout` returns
`null` without `options`/`landmarks`/`format`
(`packages/web/src/lib/ui/controls/knob-vocabulary-model.ts:84-89`). **sixstrum declares none of
the three on any param** (verified: zero matches for `options|landmarks|format` in
`sixstrum.ts`). So `DIR`, `TUNING` and `CHORD` render as bare dials in the dock — `quality = 5`
where the legacy card prints `sus4` (`SixstrumCard.svelte:50-54, 156, 181, 185`). **The def even
confesses it** — *"a name readout for the two discrete params is a shell follow-up"*
(`sixstrum.ts:124-125`) — **but it is three, not two**, and `quality` is 8-wide so it wants a
`Selector`, not a `Segmented` (`SEGMENTED_MAX_OPTIONS` = 6, `shell-control-kind.ts:42, 135`).

**(d) NOTHING ON THE PLATE CARRIES A UNIT OR A VALUE.** The PNG shows label-only cells;
`KnobConic` shows its value on hover/drag only (`knob-vocabulary-model.ts:14-20`). RING is in
**seconds**, REGISTER in **semitones**, LEVEL in **dB** (`sixstrum.ts:85, 86, 101`) and none of it
reaches the eye.

**(e) THE TITLE HINT IS A TAXONOMY WORD.** `roleLine = def.category`
(`packages/web/src/lib/ui/modules/module-shell-model.ts:262-264`) = `'sources'`
(`sixstrum.ts:40`). The faceplate's one line of prose says **SOURCES**. It does not say
"six-string plucked instrument".

**(f) BAND LABELS NAME THE FURNITURE.** `strum · damp`, `string`, `pick`, `tuning · chord`,
`envelope`, `body · out` (`sixstrum.ts:165-176`) are group nouns. Nothing says *the string's ring
IS the sustain*, or that the `envelope` page is **half inert at the shipped defaults** (§2).

**(g) THE VRT GATE SEES 2 OF 6 PAGES.** `.faceplate` is `max-height: min(60vh, 680px)` with
`.faceplate-scroll` as the overflow container
(`packages/web/src/lib/ui/dock/DockFullView.svelte:299, 310-313`); the element screenshot clips at
425 px. `pick`, `tuning · chord`, `envelope` and `body · out` — **including the PRESET selector,
the only shell control that is not a knob** — are below the fold and pixel-unprotected.
`toHaveCount(6)` (`e2e/vrt/workflow-shell-faces.spec.ts:227`) is structural only, and
`DOCK_MAX_DIFF = 1500` is 0.29 % of the visible pixels. **Linux is exempt for both scenes anyway**
(`e2e/vrt/vrt-exemptions.ts:1049-1050`), and the legacy card has **no VRT baseline at all**
(`:336`).

**(h) CONTROL-LOSS LEDGER vs the legacy card.** LOST: the STRUM audition; the
`tuningName`/`dirName`/`qualityName` readouts; the card's per-string `Str n` rear grouping (the
face's two function clusters are arguably better, but different). GAINED: a real preset
`Selector` (`shell-cells.ts:364-370`) the card only had as a discrete fader.

**(i) CARD ↔ DEF DIVERGENCE, verified, and it is the semantic form.**
`SixstrumCard.svelte:157` declares `paramId="tuning"` and `readLive={live('tuning')}`, but
`onchange={setMode}` → `applySixstrumPreset` → `setNodeParam` **× 14**
(`packages/web/src/lib/ui/modules/sixstrum-preset-actions.ts:45-49, 87-90`). **On the card that
control writes fourteen params while advertising one**, and `readLive` reads back only `tuning`,
so its live position is a lie about the other thirteen. MIDI-learn binds on `(moduleId, paramId)`
and calls the same `onchange` — **so the same CC binding stamps 14 params on the card and 1 param
in the shell**, because the shell has no `SHELL_PARAM_WRITES` override for sixstrum
(`packages/web/src/lib/ui/workflow/shell-param-writes.ts:77-89` lists only cloudseed). One param
id, two write semantics, **no gate can see it.** The card also re-types every range
(`SixstrumCard.svelte:135-139, 145-148, 169-173, 179-186, 200`) — they match today, nothing
enforces it.

---

## 2. THE CONTROLS THAT MATTER — re-ranked on ONE test: does it move a ringing string?

Classes from the DSP: **L** = live on a sounding string · **NS** = next-strike only (the pitch
latch, `sixstrum-dsp.ts:342, 352`) · **NG** = next-gesture only · **inert** at shipped defaults.

| rank | control | class | why |
|---|---|---|---|
| 1 | `ring` | **L** | `kp.decay` → `ρ` → loop gain, per sample (`karplus-dsp.ts:462-466`). The instrument's sustain. |
| 2 | `material` | **L** | note-tracking damping cutoff `f0·2^(0.5+5.5·B)` (`karplus-dsp.ts:287`) — the primary bright↔dark, and it **caps RING** (§3-A). |
| 3 | `sixstrum-strum-{n}` | — | **the audition, RECOVERED.** Rank 3, not 16 as round 2 proposed: on an instrument that cannot self-sound, the strike is not a design-time affordance, it is the *first* thing a hand reaches for. |
| 4 | `sixstrum-preset-{n}` | NS | the 14-param recall. Rank 4 keeps it in the six-cell plate and out of the one-cell mini tile, where a one-click destructive stamp would be the only control at the coarsest zoom. |
| 5 | `body` | **L** | post-sum wet mix (`sixstrum-dsp.ts:422-425`), always does something (default 0.35, `0 = dry`). |
| 6 | `level` | **L** | pre-body gain in dB. |
| — | *lane budget ends* | | |
| 7-9 | `strumSpread`, `strumDir`, `tuning` | NG / NG / NS | the strum hand and the instrument. |
| 10-12 | `register`, `quality`, `spread` | NS | latched at the strike. |
| 13-15 | `pickTone`, `pickGrain`, `pickPos` | NS | the pick. |
| 16 | `stiffness` | **L** | in-loop allpass (`karplus-dsp.ts:442-450`) — live, but a fine trim. |
| 17 | `muteDepth` | L-but-inert | needs a MUTE cable. |
| 18-21 | `attack`, `sustain`, `release`, `envDecay` | mixed | see the losers. |

**LOSERS, named with the code path:**
- **`strumSpread` loses rank 1** (it holds it today). It is next-gesture only **and completely
  dead in poly mode**, and it is the first knob a new user turns expecting a sound.
- **`envDecay` is DEAD LAST and it is genuinely inert:** at `sustain = 1` the Decay branch hits
  `|value − susTarget| < 1e-4` on its **first tick** and jumps to Sustain
  (`packages/dsp/src/lib/adsr-env.ts:74-84`). **Zero samples of decay ever run.** The def admits
  it (`sixstrum.ts:278`).
- **`release` loses too, for a subtler reason:** nothing calls `triggerSoft(false)` in
  strum/chord mode except a MUTE rising edge (`sixstrum-dsp.ts:393`). **With only STRUM patched,
  the amp envelope never leaves Sustain**, so RELEASE is inert as well.
- **`quality` loses to `tuning`**: it is gated on `chordConnected` (`:285`) — inert until a CHORD
  cable lands.
- **`register` loses the plate** (it is rank 6 today): a ±24-semitone transpose changes *which
  instrument you have*, not how you play it, and it is latched.
- **`strumDir` loses**: at `strumSpread = 0` all three directions are **bit-identical**
  (`:373` gives `d = 0` for every string).

---

## 3. THE FACE

```ts
face: {
  title: 'Instrument',
  hint:
    'Six Karplus-Strong strings, a strum hand and a chord voicer. The pitch is LATCHED at the ' +
    'strike, so REGISTER, TUNING, CHORD and SPREAD change the NEXT note, not the one ringing — ' +
    'and MATERIAL caps how long RING can actually hold.',

  order: [
    'ring','material','sixstrum-strum-{n}','sixstrum-preset-{n}','body','level',   // 1-6 lane budget
    'sixstrum-strings-{n}',                                                         // the picture
    'strumSpread','strumDir','tuning','register','quality','spread',
    'pickTone','pickGrain','pickPos','stiffness','muteDepth',
    'attack','sustain','release','envDecay',
  ],
  pages: [
    { id: 'tuning', label: '1 · instrument',
      hint: 'guitar, bass or harp — the open string set AND the body filter bank; the preset stamps fourteen values at once',
      controls: ['sixstrum-strings-{n}','sixstrum-preset-{n}','tuning','register','quality'] },
    { id: 'string', label: '2 · strings',
      hint: 'RING is the sustain and MATERIAL is the brightness — but the loop-gain cap means MATERIAL below ~0.10 pins the ring at 0.78 s whatever RING says',
      controls: ['ring','material','stiffness','spread'] },
    { id: 'strum',  label: '3 · strum hand',
      hint: 'one gesture rolls across six strings over the STRUM window; an unpatched string follows the nearest patched strum at or below it',
      controls: ['sixstrum-strum-{n}','strumSpread','strumDir','muteDepth'] },
    { id: 'pick',   label: '4 · pick',
      hint: 'the excitation burst — measured in periods, so its length in milliseconds halves every octave up',
      controls: ['pickTone','pickGrain','pickPos'] },
    { id: 'output', label: '5 · envelope · body · out',
      hint: 'the amp ADSR sits UNDER the string decay and at the shipped SUSTAIN 1.0 two of its four stages never run',
      controls: ['attack','envDecay','sustain','release','body','level'] },
  ],
  glyph: 'scope',

  hero: {
    cell: 'sixstrum-strings-{n}',
    control: 'ring',
    action: 'sixstrum-strum-{n}',
    readouts: [
      { label: 'rings for', valueId: 'sixstrum-t60-ms' },
      { label: 'chord',     valueId: 'sixstrum-chord' },
      { label: 'roll',      valueId: 'sixstrum-strum-ms' },
    ],
  },
  sidebar: [
    { kind: 'signal-flow', label: 'signal flow', stages: [
      { label: 'STRUM',        role: 'generator', note: 'rolls 1→6' },
      { label: 'PICK BURST',   role: 'generator', note: 'noise, N periods' },
      { label: 'COLOR LPF',    role: 'bus', note: 'PICK TONE' },
      { label: 'PICK COMB',    role: 'bus', parallel: true, note: 'position notch' },
      { label: '6 × K-S LOOP', role: 'bus', note: 'damping · stiffness' },
      { label: 'MUTE CHOKE',   role: 'bus', parallel: true, note: 'per string' },
      { label: 'ADSR',         role: 'bus', note: 'shared shape' },
      { label: 'SUM ÷√N',      role: 'bus', note: 'active voices' },
      { label: 'LEVEL',        role: 'bus', note: 'dB' },
      { label: 'BODY',         role: 'bus', note: 'two band-passes' },
    ] },
    { kind: 'presets', label: 'presets', entries: [ /* guitar · bass · harp — the existing 14-param stamps, sixstrum-preset-actions.ts:45-49 */ ] },
    { kind: 'readouts', label: 'strings', entries: [
      { label: 'string 1',    valueId: 'sixstrum-s1-hz' },
      { label: 'damping at',  valueId: 'sixstrum-damp-hz' },
      { label: 'pick notch',  valueId: 'sixstrum-notch-partial' },
      { label: 'burst',       valueId: 'sixstrum-burst-ms' },
    ] },
  ],
}
```

**PF-1 vocabulary, and it kills three duplicate tables.** `tuning` (0..2) → `guitar/bass/harp`
(the names live in `sixstrum-preset-actions.ts:34` today), `strumDir` (0..2) →
`down/up/alt` (`SixstrumCard.svelte:50`), `quality` (0..7) → `maj/min/dom7/maj7/min7/sus4/pow5/oct`
(`SixstrumCard.svelte:51`). `param-vocabulary.test.ts` requires
`options.length === round(max−min)+1` → 3/3/8 exactly, and `defaultValue` to hit a real option →
0 in all three. Contract-transparent. **⚠ Ranks 9/10/12 mean none of the three can reach a lane
tier**, so the `if (tier !== 'dock') return 'knob'` branch is unreachable for them on this face —
do not claim a lane-tier visual change.

**⚠ PAGE-ID / REAR-GROUP-ID RULE, and the rule as usually stated is wrong.**
`rear-card-model.ts:287-291`: for each page, a curated group whose id **equals** the page id
CLAIMS that page's slot and `usedGroupIds.add(g.id)` stops the extra-groups loop from re-emitting
it. That is a designed merge. The double-render happens only when the curated group id is
`'voice'` or `'signal'`, because the voice-slot claim (`:262-269`) fires unconditionally.
sixstrum's only curated rear group is `{ id: 'voice' }` (`sixstrum.ts:195`) and no page id is
`voice` or `signal` — **keep it that way.**

---

## 4. DERIVED READOUTS

All must read the **live AudioParam** (`readParam`, `sixstrum.ts:373-375`), not `node.params` —
seven CV ports move the param without moving the stored knob (`sixstrum.ts:71-80`). **That is
itself a universal negative control for this module.**

### A. `sixstrum-t60-ms` — how long a string ACTUALLY rings. NOT a RING readback.
```
comp  = |H_lp(a(f0,B), ω0)| · |H_dc(R(f0), ω0)|        # karplus-dsp.ts:298-299, 334-338
ρ     = 0.001^(1/(f0·ring))                            # :279
g     = clamp(ρ / max(0.5, comp), 0, 1.1)              # KARPLUS_G_MAX, :466
t60   = ln(0.001) / ( f0 · ln(g·comp) )
```
**Measured:** defaults (E2, material 0.55, ring 2.5) → **2.500 s** (it matches the knob).
Material 0 at E2 → **0.775 s at any ring ≥ 0.78 s**; material 0 at E4 → **0.195 s**. The loop-gain
cap releases above material ≈ 0.103 (E2) / 0.111 (E4).

**NEGATIVE CONTROL:** hold RING at 10 s and sweep MATERIAL 0.55 → 0.00. **A RING readback never
moves; the derived number collapses 10 s → 0.775 s.**
**Second leg, and it is the sharper one:** at material 0, sweep RING 1 → 10. The knob moves 10×
and the derived number must be **frozen**. A derivation that tracks the knob there is falsified.

### B. `sixstrum-strum-ms` — the roll window
```
window_ms   = strumSpread · SS_STRUM_SPREAD_MAX_S · 1000 = strumSpread · 45   # sixstrum-dsp.ts:58, 292
per_string  = window/(SS_STRINGS − 1) = strumSpread · 9 ms                     # :373
```
Default 0.28 → **12.6 ms · 2.5 ms per string**.
**NEGATIVE CONTROL:** patch `strum_cv` (`sixstrum.ts:75`). The AudioParam moves and the Y.Doc knob
does not — a `node.params`-sourced readout is **frozen while the sound rolls**.
**Second, cheaper leg:** flip DIR. The derived window must **not** move (`dir` only permutes
`order`, `:366-372`), so a readout that reacts to DIR is instrumented wrong.

### C. `sixstrum-chord` — the resolved chord as note names
```
voiceChord(60 + chordCv·12, qualityForIndex(quality), tuningForIndex(tuning))   # sixstrum-tuning.ts:122-130
each string + round(register) semitones                                          # sixstrum-dsp.ts:342
unpatched CHORD ⇒ openStrings(tuning)                                            # :285
```
Default: `E2 A2 D3 G3 B3 E4`.
**NEGATIVE CONTROL (the strongest available on this module):** move the CHORD **root CV** with
every knob still. **Nothing in param space changes at all — a knob readback *cannot* move** —
while the derived line goes `C E G C E C` → `D F# A D F# D`. Second leg: `quality` 0 → 5 shows
`0` → `5` on a knob and `maj` → `sus4` derived.

### D. `sixstrum-s1-hz` — string 1's fundamental, **and it finds a shipped bug**
```
f0 = clamp( 220 · 2^((open₁ − 57)/12 + register/12 + PAT[0]·spread·14/1200), 30, 4200 )
     # sixstrum-dsp.ts:46, 55, 297, 317, 342; karplus-dsp.ts:88-89, 362-364
```
Default = **82.24 Hz** (E2 −3.5 ¢) — exactly the −3.5 ¢ that
`packages/web/src/lib/audio/default-pitch-accuracy.test.ts:34` already pins.
**NEGATIVE CONTROL:** turn **SPREAD** (a "richness" knob nobody reads as pitch) 0.25 → 1.00.
Register and tuning readbacks are still; the derived f0 moves 82.24 → 81.75 Hz.

**⚠ THE BUG THIS READOUT FINDS.** The shipped **BASS preset**
(`sixstrum-preset-actions.ts:47`: `tuning: 1, register: −12, spread: 0.15`) puts strings 1-3 at
**15.42 / 20.59 / 27.49 Hz — all below `KARPLUS_F0_MIN = 30`** (`karplus-dsp.ts:88`), so
`karplusF0`'s clamp (`:364`) **collapses three of six bass strings onto the identical 30 Hz
pitch.** Strings 4-6 land at 36.72 / 49.04 / 65.49 Hz. **The shipped BASS voice is a three-note
unison plus three notes.**

### E. `sixstrum-burst-ms` / `sixstrum-notch-partial` / `sixstrum-damp-hz`
`burst_ms = pickGrain · 1000/f0` (`karplus-dsp.ts:392`) — 12.13 ms at E2, 3.03 ms at E4.
**NEGATIVE CONTROL:** REGISTER +12 halves the ms while the GRAIN knob reads `1.00` — the def's own
"measured in periods so the attack reads the same at every pitch" (`sixstrum.ts:274`) is
*precisely* why the ms is invisible.
`notch_partial = 1/β` (`karplus-dsp.ts:424-427`): β 0.17 → partial **5.88**; β 0.5 → **2.00**
(even harmonics cancelled, confirming `sixstrum.ts:268`). **PAIRED NEGATIVE CONTROL:** REGISTER
moves the *Hz* form and must **not** move the *partial-index* form. Publish the index; a readout
that drifts with REGISTER is proven wrong.
`damp_hz = f0 · 2^(0.5 + 5.5·material)` (`karplus-dsp.ts:287`): 949 Hz at E2 / material 0.55.

### F. Rejected — a "sounding strings" readout, and the reason is a bug
`active` counts `energy > 1e-4 || env.value > 1e-4` (`sixstrum-dsp.ts:412`). **With `sustain = 1`
and no MUTE or poly cable, nothing ever calls `triggerSoft(false)`, so `env.value` sticks at 1
forever** (`adsr-env.ts:85-87`) — after one barre, `active ≡ 6` permanently and the `1/√active`
normaliser is pinned at 0.408 (−7.8 dB) **even in silence.** A readout showing `6` forever would
be *echoing the bug*. If it ships at all it must read the **energy follower alone**, and its
negative control is: wait 10 s after a barre at RING 0.1 — the audio is gone, so the number must
fall. If it prints 6, the instrument is measuring the envelope, not the sound.

---

## 5. BESPOKE CELL

**LEGITIMATE — `sixstrum-strings-{n}`:** six horizontal string lines, each carrying its resolved
note name, its energy, its own `t60` bar and a mute lamp, with the strum roll drawn as a diagonal
across them. It makes §4-A, §4-C and §4-F visible at once, and it is the one picture no def
introspection produces. **The `strings` glyph stays demoted** (it needs a worklet→main
`postMessage` plus a `read()` seam); this panel derives everything from params instead.

---

## 6. RANGES, AND WHAT ELSE IS ALREADY WRONG

**No range or curve change.** The card re-types all nineteen; they match today (§1-i).

- **A · "a string with no patched strum at or below it is simply never struck"**
  (`sixstrum.ts:226`) **is unreachable in the shipped engine.** The factory permanently connects a
  `ConstantSource` to worklet input 2 = `strum1` (`sixstrum.ts:334-337`), which the same file calls
  a keep-alive (`:331-333`), so `inputs[2]` is never a zero-length array and `last` is `0` from
  `i = 0` onward (`packages/dsp/src/sixstrum.ts:156-160`). **(INFERENCE on Chrome's connected-input
  delivery; the def's own comment (b) — "an unpatched string normals to strum #1" — asserts it
  independently.)** It also contradicts `sixstrum.ts:319-323` ("NO silence keep-alives on the
  inputs") **fourteen lines above the keep-alive**, and the unit test drives `empty15()`
  (`sixstrum.test.ts:79, 129`) — so **the tested model is not the shipped topology.**
- **B · DIR = ALTERNATE only alternates if string 1's own strum fires.**
  `if (dir === 2 && i === 0) s.altFlip = !s.altFlip` (`sixstrum-dsp.ts:367`). Patch only `strum4`
  — the doc's own two-group example (`sixstrum.ts:226`) — and ALTERNATE is **inert for that
  group.** Undocumented.
- **C · "the falling edge frees the string to ring again"** (`sixstrum.ts:233`). The falling edge
  releases the karplus damp and the choke (`sixstrum-dsp.ts:404-406, 462`), but the amp envelope
  was put into **Release** at the rising edge (`:393`) and never returns — it can only continue
  decaying (`adsr-env.ts:87-94`). **The string cannot ring back up.**
- **D · `sixstrum.ts:124-125`** says "a name readout for the **two** discrete params" — there are
  three.
- **E · `shell-cells.ts:320` and `manual-strike-actions.ts:9`** both claim sixstrum is auditionable
  in the shell (§1-a).
- **F · `sixstrum.ts:264`** frames the loop-gain cap as "the extreme corner". It is a **cliff**:
  below material ≈ 0.10 the RING knob is dead over ~92 % of its range (§4-A).
- **G · the BASS preset's `F0_MIN` collapse** (§4-D) — a shipped preset, three strings on one pitch.

---

## 7. COST

| | |
|---|---|
| **contract-lock** | **+2 lines** — `sixstrum family sixstrum-strum kind=other prefix=sixstrum-strum` (sorts after `sixstrum-preset`) and `sixstrum family sixstrum-strings kind=cell prefix=sixstrum-strings`. 44 → 46. `ParamDef.options` on the three discretes is **contract-transparent** (`contract-signature.ts:108-111` emits `id min..max curve default=X unit=Y` only). Both families need `docs.controls` keys (STRICT_DOCS). |
| **card gate** | ⚠ `module-docs-lint.test.ts:232-247` greps every declared `testidPrefix` against `allCardSource()`. `sixstrum-strum` already exists at `SixstrumCard.svelte:192` ✔; **`sixstrum-strings` does not**, so either the card gains that testid or the family is `kind: 'cell'` and the rule is checked against how PF-14 panel families are handled — **verify before committing to the family kind.** |
| **ART** | none. No DSP edit. §6-G (the BASS preset) is a **preset-value** change, not a DSP change, but it *is* an audible change to a shipped recall — owner call. |
| **VRT** | three darwin scenes; **two move.** `darwin/face-sixstrum-compact` should be **pixel-identical** (ranks 1-2 stay `ring`+`material`… ⚠ **no — this re-do changes rank 1 from `strumSpread` to `ring`, so the compact tile DOES move**; regenerate and look at it). `darwin/face-sixstrum-dock` moves substantially (5 bands, new labels, two Segmenteds, one Selector, a new action). `darwin/rear-sixstrum` moves — the rear's page-derived CV bands take their ids/labels/**order** from `face.pages` (`rear-card-model.ts:285-300`); `holeCount` stays 23 so `workflow-rear-card.spec.ts` is unchanged. **Linux drains available:** `linux/face-sixstrum-compact` (`vrt-exemptions.ts:1049`), `linux/face-sixstrum-dock` (`:1050`), `linux/rear-sixstrum` — draining all three lowers the vrt-meta linux-deficit ceiling by 3 **in the same commit**, then dispatch unscoped. |
| **structural pins that MUST move in the same commit** | `e2e/vrt/workflow-shell-faces.spec.ts` `{ type: 'sixstrum', pages: 6 }` → **5**; and `e2e/tests/p1-batch2-faces.spec.ts:60` **PINS the six page labels as an exact array** (`['strum · damp','string','pick','tuning · chord','envelope','body · out']`) — round 2's spec never mentioned that file. |
| **e2e** | `faces-parity` goes 20 → 22 driven cells (+2 families), and three params move from `dragKnob` to a Segmented/Selector click, which is **cheaper**. Net ≈ +0.5 s. |
