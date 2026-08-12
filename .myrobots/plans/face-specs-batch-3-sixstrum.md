# FACE SPEC — `sixstrum` (batch 3) — **RE-DO of a SHIPPED face**

> ⚠ **STATUS CORRECTED 2026-08-04 — THE RE-DO SHIPPED.** sixstrum's face was re-cut in
> **#1332** (`2d111616`): the STRUM audition reached `SHELL_CELLS`, the hero took it, and
> §1's headline defect (*the shipped face could not play the instrument*) is **FIXED**.
> PF-20 (**PR #1301**) has MERGED (`c6ff9253`). The companion delta
> `.myrobots/plans/face-redo-sixstrum.md` was **deleted on 2026-08-04** — its one live
> proposal (the STRIP-is-for-playing / SIDEBAR-is-reference rule) shipped verbatim at
> `sixstrum.ts:256-257`, and its `note: '14 params'` half is moot because the shipped
> sidebar carries `signal-flow` + `readouts` and no `presets` block. **This file is the sole
> surviving record of that delta's four defects.**
>
> **STILL OPEN — this is why the file is kept:**
> - **§4-D · the BASS preset collapses three of six strings onto one pitch** (`tuning: 1,
>   register: −12, spread: 0.15` puts strings 1-3 under `KARPLUS_F0_MIN = 30 Hz`). A
>   shipped preset; a preset-value change, so an owner call.
>   **2026-08-12: still open, but no longer only recorded here** — the defect is
>   pinned verbatim in the def at `sixstrum.ts:298-305`, with the note that "the
>   model test fails the day the preset is fixed".
>
> **2026-08-12: the SEVEN defects in §6 below are the reason this file survives** —
> none of them is recorded in the source. §1's "tuning writes 14 params while
> advertising one" is now half-addressed: the def documents PRESET and TUNING as
> distinct, but `SixstrumCard.svelte:157` still labels the `tuning` fader "Mode"
> and routes it through `setMode`, which stamps all fourteen.
> - **§2 · `ENV DECAY` and `RELEASE` are inert at the shipped `sustain = 1`** — the def's
>   own band-5 hint now says so (`sixstrum.ts:224-226`), which documents it rather than
>   fixing it.
> - **§1 · `tuning` writes 14 params while advertising one**, so the same MIDI CC stamps 14
>   on the card and 1 in the shell.

**Status:** ~~SPEC + MOCKUP ONLY~~ **BUILT (the face) — the defect list is what remains.** PF-20 platform (PR #1301 — MERGED, `c6ff9253`). Citations file:line.

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

## 2–5 · DELETED 2026-08-12 (the re-do SHIPPED — #1332)

The re-ranking, the proposed `face` block, five of the six derived-readout
derivations and the bespoke-cell argument were deleted: sixstrum is in
`STRICT_FACES` and the shipped def is the record. The one readout kept below is
the one that was REJECTED, because the reason it was rejected is a live bug.

---

### F. Rejected — a "sounding strings" readout, and the reason is a bug
`active` counts `energy > 1e-4 || env.value > 1e-4` (`sixstrum-dsp.ts:412`). **With `sustain = 1`
and no MUTE or poly cable, nothing ever calls `triggerSoft(false)`, so `env.value` sticks at 1
forever** (`adsr-env.ts:85-87`) — after one barre, `active ≡ 6` permanently and the `1/√active`
normaliser is pinned at 0.408 (−7.8 dB) **even in silence.** A readout showing `6` forever would
be *echoing the bug*. If it ships at all it must read the **energy follower alone**, and its
negative control is: wait 10 s after a barre at RING 0.1 — the audio is gone, so the number must
fall. If it prints 6, the instrument is measuring the envelope, not the sound.

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
