# face re-do — sixstrum · **DELTA ONLY**

**Verdict:** ALREADY SPEC'D — do not re-spec. The full re-do is
`.myrobots/plans/face-specs-batch-3-sixstrum.md` on branch `origin/docs/face-specs-batch-3`
(**PR #1304**, spec-only, unmerged). This file records only what the **two platform corrections**
change about that spec.

Read the source spec first:
`flox activate -- git show origin/docs/face-specs-batch-3:.myrobots/plans/face-specs-batch-3-sixstrum.md`

---

## 0. WHAT #1304 PROPOSES (the baseline this delta modifies)

- `title: 'Instrument'`, `hint:` the LATCHED-PITCH sentence.
- `hero`: `cell: 'sixstrum-strings-{n}'`, `control: 'ring'`, `action: 'sixstrum-strum-{n}'`,
  `readouts: [ rings for (valueId sixstrum-t60-ms), chord (valueId sixstrum-chord),
  roll (valueId sixstrum-strum-ms) ]`.
- FIVE bands, **each carrying a `hint`**.
- `sidebar`: `signal-flow` (10 stages) · `presets` (guitar/bass/harp) · **a second `readouts`
  block** labelled `strings` (`sixstrum-s1-hz`, `sixstrum-damp-hz`, `sixstrum-notch-partial`,
  `sixstrum-burst-ms`).

---

## 1. CORRECTION 1 — the readout row moves BELOW the graphic

**Zero def edits.** `hero.readouts` is a declaration; the shell owns where it paints.

**But sixstrum is the ONE face in the set that now has TWO readout surfaces**, and the correction
makes that a real design question rather than an incidental one. Before the correction the hero
readouts were a narrow side column and the sidebar `readouts` block was the reference table —
two different shapes, no confusion. After it, both are horizontal-ish lists of label→number pairs,
one full-width under the graph and one in the 288 px column, and **nothing in the design says which
number a player is meant to read where.**

**The rule this delta adds, and it should go in the face comment:**

> **The STRIP is what you read WHILE PLAYING; the sidebar `readouts` block is REFERENCE.**
> A strip entry must change under the hand — it answers "what did that knob just do to the
> instrument". A sidebar entry answers "what is this instrument", and it is allowed to be static
> for minutes at a time.

Applied to #1304's seven derived values:

| value | strip or sidebar | why |
|---|---|---|
| `rings for` (`sixstrum-t60-ms`) | **STRIP** | it is RING's and MATERIAL's *joint* answer, and both are hero-rank knobs. The number moves constantly. |
| `chord` (`sixstrum-chord`) | **STRIP** | changes on every CHORD-CV note and on every QUALITY click — the most volatile line on the module. |
| `roll` (`sixstrum-strum-ms`) | **STRIP** | moves with SPREAD, which is rank 7 and the knob a new user turns first. |
| `string 1` (`sixstrum-s1-hz`) | **SIDEBAR** (unchanged) | it is the instrument's identity, not a gesture. **But see §3 — it is the readout that finds the BASS-preset bug, so it must not be dropped.** |
| `damping at` (`sixstrum-damp-hz`) | **SIDEBAR** (unchanged) | reference for MATERIAL; the strip already carries MATERIAL's audible consequence as `rings for`. |
| `pick notch` / `burst` | **SIDEBAR** (unchanged) | next-strike-only quantities. By construction they cannot move under the hand. |

So the strip stays **three entries** and #1304's hero declaration is unchanged. **The delta is the
RULE, not the list** — and the rule is what stops the next author widening the strip to seven
because it now has room.

**One addition worth considering, and I am NOT recommending it:** a fourth entry
`{ label: 'strings', valueId: 'sixstrum-active-strings' }` (how many of six are actually
sounding). It is derivable and it would make the poly/strum-mode split visible. It is **rejected
here** because it needs the ENGINE, not the params — `FaceReadoutValue` is params-only today
(`face-readout-values.ts:45`) — and a params-only version would print 6 forever, which is the
blind-metric trap with a new label.

---

## 2. CORRECTION 2 — band hints become ANNOTATION, hidden by default

sixstrum's five hints are the most information-dense in the set. Band by band, with the brief's
test (*does this face read correctly with every hint hidden?*):

| band | hint (still authored) | survives without it? |
|---|---|---|
| `1 · instrument` | *"the preset stamps fourteen values at once"* | **NO — and this one matters.** A single `Selector` that silently writes 14 params is exactly the "one param id, two write semantics" divergence #1304 §1(i) reports as a shipped bug. **REPAIR: put the count in the SIDEBAR preset block's `note` field** (`note: '14 params'` on each entry). `FacePreset.note` paints by default; it is one word per row and it is not prose. |
| `2 · strings` | *"MATERIAL below ~0.10 pins the ring at 0.78 s whatever RING says"* | **YES, and better than the prose did.** The strip's `rings for` derivation IS this fact: hold RING at 10 s, turn MATERIAL to 0, and the printed number collapses to 0.775 s while the dial still says 10. That is the sentence, made observable instead of asserted. This is the single best illustration in the whole re-do of why the corrections are an improvement and not a loss. |
| `3 · strum hand` | *"one gesture rolls across six strings over the STRUM window"* | **YES.** The `roll` strip entry prints `12.6 ms · 2.5 ms per string`. |
| `4 · pick` | *"measured in periods, so its length in ms halves every octave up"* | **PARTLY.** The sidebar's `burst` entry prints the resolved ms, so the *number* survives; the *why* does not. Acceptable — that is annotation's job. |
| `5 · envelope · body · out` | *"at the shipped SUSTAIN 1.0 two of its four stages never run"* | **NO, and it is a GENUINE LOSS.** Nothing else on the faceplate says ENV DECAY and RELEASE are inert. **Do NOT repair it with a label.** The honest repair is the DSP/def fix #1304 already files (`sixstrum.ts:278` admits the decay branch never runs; RELEASE never fires because nothing calls `triggerSoft(false)` outside a MUTE edge). A face that renames an inert knob is a face that lies politely. Ship the inertness as a **defect** (§3) and let annotation carry the explanation until it is fixed. |

**Net: three of five hints survive the hiding, one survives partially, and the one that does not
is pointing at a shipped bug rather than at a design flaw.**

**⚠ The `face.hint` (page-level) is NOT affected** and it is where sixstrum's single most
important fact lives — *the pitch is LATCHED at the strike*. #1304 put it there rather than in a
band hint. Under correction 2 that placement turns out to have been the load-bearing decision in
the whole spec, and it should be called out in the face comment so nobody "tidies" it down into a
band.

---

## 3. DEFECTS — carried forward, not re-found

All of these are #1304's findings; they are listed here only so the re-do index can count them
once. None is spec content; each is its own PR.

1. **The shipped face cannot play the instrument** — the STRUM audition never reached
   `SHELL_CELLS`, and two repo comments assert that it did
   (`shell-cells.ts:320`, `manual-strike-actions.ts:9`).
2. **The BASS preset collapses three of six strings onto one pitch** — `tuning:1, register:−12,
   spread:0.15` puts strings 1-3 below `KARPLUS_F0_MIN = 30 Hz` and the clamp flattens them.
3. **`ENV DECAY` and `RELEASE` are inert at the shipped defaults** (see §2 band 5).
4. **`tuning` writes 14 params while advertising one**, so the same MIDI CC stamps 14 on the card
   and 1 in the shell.

---

## 4. COST OF THIS DELTA

Beyond #1304's own costed plan: **`+3` `note:` strings on the preset entries** (§2 band 1) and
**one paragraph of face comment** (§1's strip-vs-sidebar rule). Contract 0, VRT already moving,
CI ≈ 0.
