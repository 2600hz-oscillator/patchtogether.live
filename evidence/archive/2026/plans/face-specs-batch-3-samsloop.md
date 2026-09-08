# FACE SPEC — `samsloop` (batch 3)

> **Two owner rulings, 2026-08-11, apply to this file** (verbatim at
> `rings.ts:585-590` and `:645-650`): *"we should prefer almost zero AI authored
> text, and all future faceplate work should reflect that"* and *"lets stop doing
> these and clean up the existing ones, get rid of them. lose the signal flow
> diagrams."* Every proposed `hint` and the `signal-flow` sidebar block have been
> **deleted** from §4. Do not re-author them. Measurements belong in
> `docs.controls` (the `rings.ts:592-596` precedent), not on the panel.

## 0. STATUS — **UNBUILT. THE OWNER GATE IS NOW HALF-LIFTED; IT NEEDS AN OWNER RE-CHECK.**

**Verdict: DO NOT PROMOTE AS SPECIFIED** — but the reason has changed twice and
the current reason is narrower than the file used to say.

**The owner gate (2026-08-03), verbatim:** *"samsloop-class modules: build the
platform shell cell FIRST. A file-loader / recorder shell cell that reaches the
dock is a platform PR. Until it exists, an agent's only correct answer for
samsloop is **do not promote** — promoting it removes the only ways to get audio
in."* (`.myrobots/2026-08-03-SESSION-STATE.md` §4.4; `.claude/skills/module-faceplates.md`
names samsloop-class modules as out of scope.)

⚠ **HALF OF THAT GATE HAS LANDED.** A generic `kind: 'file'` shell cell exists and
reaches the dock — `packages/web/src/lib/ui/workflow/shell-cells.ts:179`
(`ShellFileCell`) and `:367-373` (`dx7-syx-input-{n}`, the live consumer). **No
recorder cell exists** — grep for one in `shell-cells.ts` returns nothing. So the
file-loader half is done and the recorder half is not. **This needs an owner
re-check**: is the gate satisfied by the loader alone, or does the recorder cell
still block?

**Still open regardless of that answer:** §4 needs **THREE `ParamDef`s promoted
out of `node.data`** (a contract change) before the face is even expressible.

✅ **The two P0-class bugs this spec was originally gated on ARE FIXED.**
`#1316` (`bbba5b5d`) — `stopRecording` wrote `node.data.sample.bytesB64` while the
factory read `fileBytesB64` / `samples`, so a recorded sample never played; the
fix is reader-side, so already-saved racks recover. `#1353` (`1b05b590`) —
START/END were dead because the factory cached the length of a TRANSFERRED,
detached buffer, so every recording persisted `sampleLength: 0`.

archetype: **one-shot / loop SAMPLE PLAYER with a bolted-on stereo recorder.**

⚠ **Framing correction:** samsloop is **not** a looper in the overdub sense. No
overdub, no feedback path, no layering, no undo, no clock quantisation. The
worklet's entire state is `buffer`, `cursor`, `playing`, `pendingTrigger`,
`lastTrig`, `rateScale` (`packages/dsp/src/samsloop.ts:107-129`).

Not in `STRICT_FACES`; no `face:` block. 4 params, 4 in / 1 **mono** out.
contract-lock block = **10 lines**. In `STRICT_DOCS` (`strict-docs.ts:283`).

---

## 1. WHAT IT ACTUALLY DOES

**Record path:** patched audio → the `samsloop-tap` worklet (2 in / 1 silent out,
`packages/web/src/lib/audio/modules/samsloop.ts:948-952`) which posts raw
128-frame L/R blocks to the main thread **only while enabled**
(`packages/dsp/src/samsloop-tap.ts:58, 85`). The card accumulates Float32
(`SamsloopCard.svelte:281-293`), auto-stops on the exact byte budget (`:334-337`),
then does **one** Yjs write of downsampled + quantised + interleaved PCM as
base64 (`:368-399`).

**Playback:** a worklet-private `Float32Array` replaced wholesale by `loadSample`
(`packages/dsp/src/samsloop.ts:138-153`), read with two-point linear interpolation
(`:179-183`), cursor advanced by `rate * rateScale` where
`rateScale = bufferRate/contextRate` (`:150-153, 256`).

**Transport — two booleans, and it is idle by default:**

| from | event | to | cite |
|---|---|---|---|
| idle | `trig` rising edge (prev < 0.5, cur ≥ 0.5) | playing, cursor ← `start` (fwd) or `end−1` (rev) | `samsloop.ts:235-239` |
| idle | `{type:'trigger'}` port message | playing, same reset, applied at the top of the next block | `:158, 220-225` |
| playing | cursor ≥ end, mode 1 | playing (fmod wrap) | `:260-266` |
| playing | cursor ≥ end, mode 0 | **idle + silent** | `:267-271` |
| playing | cursor < start, mode 1 / 0 | wrap / idle | `:272-283` |
| any | `loadSample` / `reset` | idle, cursor ← 0, pendingTrigger cleared | `:142-145, 159-164` |

**The rate law is a pure fractional-read varispeed (Doppler)** — no granular, no
time-stretch. **semitones = 12·log₂(|rate|)**, ART-pinned
(`art/scenarios/samsloop/varispeed-spectrum.test.ts`: "rate = 2 … doubles the
fundamental" / "rate = 0.5 … halves"), and **sign is direction only, not pitch**
("rate = −2 doubles the fundamental (pitch direction is independent of playback
direction)"). `rate = 0` freezes (`samsloop.ts:16`).

---

## 2. THE CONTROLS THAT MATTER — and the four params are not the module

| rank | control | why |
|---|---|---|
| 1 | `rate` | the sole pitch / speed / direction control, and the only a-rate modulatable param (`samsloop.ts:94`). |
| 2 | `mode` | LOOP vs 1-SHOT. **Load-bearing but latent** — the output is byte-identical until the first window crossing (`:260-284`). |
| 3 | `start` | window floor + the forward trigger reset point (`:213, 222, 237`). |
| 4 | `end` | window ceiling + the reverse reset point. |
| 5 | `samsloop-trigger-{n}` | the audition — an engine `read('manualTrigger')` seam (`samsloop.ts:1135-1139`), **not** a param. |
| 6-8 | `recRate`, `recBits`, `recChannels` | **NOT PARAMS TODAY.** They live in `node.data` (`samsloop.ts:198-200`; `SamsloopCard.svelte:795-848`) with no CV, no MIDI-learn and no presence in contract-lock — see §6. |

**LOSERS: there is nothing to cut and that is the finding.** Four params is under
the six-cell lane budget. **The problem is the opposite of a ranking problem** —
the module's real control surface is a file input, a waveform canvas, a REC
button, a byte-budget readout, a DOWNLOAD and three `node.data` switches, none of
which `face` can express (§6).

---

## 3. INERT AT SPAWN — almost everything

`process()` early-returns `out.fill(0)` on an empty buffer at
**`packages/dsp/src/samsloop.ts:194-197` — before** params are read (`:199-214`),
before the pending-trigger apply (`:220-225`) and before trig edge detection
(`:233-241`).

**With no sample: `rate`, `mode`, `start`, `end`, the `trig` jack AND the TRIGGER
button are all 100 % inert.** A TRIGGER pressed pre-load is not even queued —
`loadSample` clears `pendingTrigger` (`:145`). With nothing patched,
`audio_l_in`/`r_in` are inert twice over (the tap returns on `!enabled`, default
false, and again on `!lRaw`).

**Live at spawn:** the LOOP/1-SHOT toggle; the CHAN/BITS/RATE toggles, which move
the `N.NNs max` readout (`SamsloopCard.svelte:194, 866`); the file input; REC
(which fails with an inline error until the engine handle exists, `:238-246`); the
"NO SAMPLE LOADED" placeholder. DOWNLOAD is disabled (`:871`). The End fader
spawns with `max = Math.max(1, sampleLength) = 1` (`:915`) while holding the value
`1e6`.

---

## 4. THE FACE

```ts
face: {
  title: 'Sample player',

  order: [
    'rate', 'mode', 'start', 'end', 'samsloop-trigger-{n}',   // 1-5, inside the lane budget
    'samsloop-wave-{n}',                                      // the picture (panel ⇒ rank ≥ 7 rule; see §7)
    'recRate', 'recBits', 'recChannels',                      // ⚠ NEW ParamDefs — §6
  ],
  pages: [
    { id: 'play',   label: '1 · playback',
      controls: ['samsloop-wave-{n}', 'samsloop-trigger-{n}', 'rate', 'mode'] },
    { id: 'window', label: '2 · window',
      controls: ['start', 'end'] },
    { id: 'rec',    label: '3 · recorder',
      controls: ['recChannels', 'recBits', 'recRate'] },
  ],
  glyph: 'meter',

  hero: {
    cell: 'samsloop-wave-{n}', control: 'rate', action: 'samsloop-trigger-{n}',
    readouts: [
      { label: 'loop',  valueId: 'samsloop-loop-s' },
      { label: 'pitch', valueId: 'samsloop-semitones' },
      { label: 'fill',  valueId: 'samsloop-fill' },
    ],
  },
  sidebar: [
    { kind: 'readouts', label: 'budget', entries: [
      { label: 'max length', valueId: 'samsloop-budget-s' },
      { label: 'source rate', valueId: 'samsloop-src-rate' },
      { label: 'implied bpm', valueId: 'samsloop-bpm' },
    ] },
  ],
}
```

---

## 5. DERIVED READOUTS

### A. `samsloop-loop-s` — loop length in seconds
```
W = end_clamped − start_clamped                                # samsloop.ts:213-214
T = W / ( |rate| · node.data.sampleRate )                      # rateScale = bufRate/ctxRate ⇒ ctxRate CANCELS
```
**NEGATIVE CONTROL 1:** load the same clip as a 48 kHz WAV, then as a 22.05 kHz
WAV. `end − start` **doubles** for the 48 k source (it is decimated to 24 k,
`samsloop.ts:463-468`) while the 22.05 k source is untouched — **yet T is
identical.** A readout that omitted `sampleRate` prints a 2:1 lie, and a knob
readback of `end − start` moves when the truth does not.
**NEGATIVE CONTROL 2:** move RATE +1 → +2. `end − start` is unchanged; T halves.

### B. `samsloop-semitones` — the pitch shift
```
st = 12 · log₂( |rate| )      # frozen display at rate 0 (samsloop.ts:16)
```
**NEGATIVE CONTROL:** flip +1 → −1. Direction and cursor readouts all change;
**semitones must stay 0** (the ART pin asserts the reverse-unity fundamental is
unchanged). Naive `12·log₂(rate)` returns NaN — **the `|·|` is load-bearing and
the negative control is what proves it is there.**
⚠ **Second control this readout CANNOT satisfy today:** put DC into `rate_cv`. The
audible pitch moves while `node.params.rate` **and** `readParam`
(`SamsloopCard.svelte:942-946` → `samsloop.ts:1120-1122` → `AudioParam.value`) both
stay put. **INFERENCE (Web Audio semantics):** `.value` is intrinsic-only, so a
CV-aware semitone readout is not derivable at all — the worklet has **no outbound
port traffic** (`packages/dsp/src/samsloop.ts:133` sets only `onmessage`). Ship the
readout labelled as the *knob* pitch until that changes.

### C. `samsloop-bpm` / `samsloop-budget-s` / `samsloop-fill`
```
BPM        = 60·N·|rate|·sampleRate / (end − start)            # N beats per window
fill_decode = sampleLength / 1_500_000                          # samsloop.ts:163, 1026-1028
fill_record = sample.byteLength / SAMSLOOP_RECORD_BUDGET_BYTES  # IMPORT it, do not inline
                                                                # (was 250_000; 3_000_000 since #1422)
fill_upload = fileSize / 2_097_152                              # samsloop.ts:120; card:516
```
**NEGATIVE CONTROL (BPM):** drag ONLY the End fader inward by half. Every rate
readback is unchanged; BPM **doubles**.
**NEGATIVE CONTROL (fill):** the same 10 s as a 48 kHz WAV vs a 22.05 kHz WAV.
`fileSize` and the decoded fill move by **different ratios** (2.18× vs ~1.09×) —
which is precisely what proves the readout is reading decoded PCM rather than file
bytes. ⚠ **Three different denominators exist; pick one per path and say which**,
or the number is a coin flip.

### D. NOT DERIVABLE — flag it rather than fake it
**Playhead position and a PLAYING / IDLE lamp.** `playing` and `cursor` are
worklet-private (`packages/dsp/src/samsloop.ts:110-116`) and **the worklet posts
nothing back.** Both need a new outbound message. A face that drew a playhead
without one would be drawing a guess.
**Beats at host tempo** likewise needs a global transport read, and samsloop has
**no clock port and no quantisation anywhere.**

---

## 6. THE PLATFORM / CONTRACT PROBLEM — read this before scheduling the work

`sidebar-panels.ts`'s hard rule is **"A panel READS; it does not own state."** The
`presets` block is the only sidebar kind that *writes*, and it writes **params**
through `setNodeParam`.

**Samsloop's recorder is none of those things.** REC/STOP, the file input,
DOWNLOAD, the seek and the CHAN/BITS/RATE bank all write `node.data` or send port
messages (`SamsloopCard.svelte:211-248, 392-399, 410-455, 795-848`). So:

1. **Promote `recRate`, `recBits`, `recChannels` to real ParamDefs** (`discrete`,
   with `ParamDef.options` for the names). They then become ordinary face cells
   with MIDI-learn and undo, and the byte budget becomes a param-pure derived
   readout. **Contract cost: +3 lines.**
   ⚠ Their values currently live in `node.data`; the migration is "new params take
   their default, the stale `data` keys survive and are ignored", which is the
   safe direction, but it **does change the recorder's settings on existing
   racks** unless the defaults match whatever `node.data` currently defaults to.
   Read `samsloop.ts:198-200` and match them exactly.
2. **REC / STOP / DOWNLOAD stay on the legacy card** for this batch — no face
   affordance exists and inventing one here would be a bespoke sidebar. ⚠ **LOAD
   may no longer belong on that list**: `ShellFileCell` now exists
   (`shell-cells.ts:179`, consumed by `dx7-syx-input-{n}` at `:367-373`). See §0.
3. **The audition ships as an `action` cell** through `getActiveEngine()`
   (`packages/web/src/lib/audio/engine-ref.ts:23`) → `read(node, 'manualTrigger')`.
   **Not blocked** — round 2's specs twice invented a platform prerequisite here
   that does not exist.

---

## 7. BESPOKE CELL

**LEGITIMATE — `samsloop-wave-{n}`:** the waveform with the START..END window
highlighted. The card already draws it (`SamsloopCard.svelte:616-737`,
peak-per-pixel across three sources — decoded upload, legacy PCM, recorded bytes —
with the loop band at `:711-716`). No def introspection synthesises a picture of
audio the user recorded.
⚠ **It cannot draw a playhead** (§5-D) and must not pretend to.
⚠ **A panel's first legal rank is 7 and this face ranks it 6th in reading order.
Rank it 7th and let the audition take 5, or the lint fails**; the pages array is
unaffected either way.

---

## 8. ALREADY-WRONG

- ✅ **A · a recorded sample never plays — FIXED in #1316** (`bbba5b5d`), with
  #1353 (`1b05b590`) fixing dead START/END from the same root (a detached
  transferred buffer persisting `sampleLength: 0`). Recorded because the whole
  spec was gated on it. **Note the coverage gap it exposed and which may still be
  open: nothing asserted audio from a recording.**
- **B · the microphone does not exist.** `samsloop.ts:5-6`, `:541-549` and `docs`
  (`:899`) all claim microphone capture. There is **no `getUserMedia`** in the card
  or anywhere in samsloop's code.
- **C · no drag-and-drop.** `docs` (`:899`) claims it; the card has zero
  `ondrop`/`ondragover` (`VideoboxCard.svelte:712` and
  `VideoVarispeedCard.svelte:1128` do).
- **D · START/END are not draggable on the waveform.** `docs` (`:899, :918-921`)
  says "waveform marker" / "draggable"; the canvas has **no pointer handlers** —
  start and end come from two Faders (`SamsloopCard.svelte:895-921`).
- **E · CV depth is documented at half its real value.** `linear` scaling is
  `knob + cv·(max−min)/2` (`packages/web/src/lib/audio/cv-scale.ts:17, 57-62`) =
  `cv·2` for [−2,2], so ±1 V is **±200 %**, not the "±1 unit / ±100 %" of
  `samsloop.ts:43-46`, `docs` (`:904`) and `module-manifest.ts:368`. Worse,
  `scaleCv` clamps the effective value to `[paramMin, paramMax]` **before** the
  delta and bakes that into the LUT (`cv-scale.ts:61-62, 203-206`), so the
  worklet's advertised ±3 headroom (`packages/dsp/src/samsloop.ts:94`) is
  **unreachable through this jack** — except as a stale-LUT artifact after moving
  the knob post-patch **(INFERENCE; mechanism documented at `cv-scale.ts:118-124`)**.
- **F · `end`'s max (1e6) is below the decoded cap (1.5e6).** `samsloop.ts:894` vs
  `:163`. The card writes `params.end = samples.length` **directly**
  (`SamsloopCard.svelte:528`), bypassing `setNodeParam` (which clamps nothing
  anyway, `packages/web/src/lib/graph/mutate.ts:99-112`) — so the value sits
  **outside its own contract**, and any def-respecting consumer truncates the last
  third of a long sample.
- **G · dead and wrong type.** `SamsloopRecordedSample` declares `bytes: number[]`
  (`packages/web/src/lib/audio/modules/samsloop-record.ts:60-75`) against the
  shipped `bytesB64: string` (`samsloop.ts:214-227`); **zero importers repo-wide**,
  and a sibling comment at `:313` still says `node.data.sample.bytes`.
- **H · off-by-8× comment:** `samsloop-record.ts:27-29` calls
  `SAMSLOOP_MAX_FILE_BYTES` "250 KB"; it is **2 MB** (`samsloop.ts:120`).
- **I · the edge lint is structurally blind here:** `trig` declares no `edge:`
  while its doc (`:902`) is pure trigger vocabulary, and
  `module-docs-lint.test.ts:217` does `if (!p.edge) continue`.
- **J · the card re-types ranges, and one is a live MIDI hazard.** Start/End use
  `min={0} max={Math.max(1, sampleLength)}` (`SamsloopCard.svelte:898, 915`) rather
  than the def's `0..1e6`; **Rate uses `min={0} max={1}` (`:927-928`) while
  `paramId="rate"` stays attached**, so **MIDI-learn binds in knob units against a
  param declared −2..2.** The backdraft class in its most consequential form.

**Verified NOT present:** the videovarispeed multi-slot persistence bug shape. The
one-sample invariant (`samsloop.ts:10-18`) means no per-slot byte map exists and
both write paths set a single key. There *is* a genuine boundary-restore hazard and
it is **already fixed** — non-WAV re-decode at a different context rate yields a
different length, so `rescaleBoundaries` proportionally remaps start/end
(`:685-706`, applied `:1009-1025`).

---

## 9. COST

| | |
|---|---|
| **contract-lock** | **+6 lines**: 3 new `param` (`recRate`, `recBits`, `recChannels`) + 2 `family` (`samsloop-wave` kind=cell, `samsloop-trigger` kind=other) + 1 modified (`samsloop in trig gate` → `… edge=trigger`). 10 → 16. `ParamDef.options` on the three is contract-transparent. All three need `docs.controls` keys (STRICT_DOCS). |
| **ART** | none from the face. |
| **VRT** | one scene, **canvas MASKED** (`samsloop: [{ selector: 'canvas' }]`, `e2e/vrt/vrt-exemptions.ts:57`). Not in `STRICT_VRT_MODULES`. ⚠ The hero waveform panel is a canvas — **it will need a live-surface mask or a deterministic empty-buffer render**, or `face-samsloop-dock` flakes. |
| **e2e** | +1 `faces-parity` row (10 cells), plus a bespoke audition spec with a before/after negative control. |
