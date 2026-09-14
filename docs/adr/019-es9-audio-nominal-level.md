# ADR-019: ES-9 audio unity is ±5 V (Eurorack nominal), not the ±10 V full scale

- Status: Accepted (owner, 2026-09-14 — answers quoted under "Owner decisions")
- Date: 2026-09-14
- Deciders: project owner
- Tags: dsp, semantics, es9, hardware
- Related: ADR-004 (CV range convention — leaves audio LEVEL undefined)

## Owner decisions (2026-09-14, verbatim)

Put to the owner as three questions; the answers, verbatim:

1. Reference (±5 V Eurorack nominal vs +4 dBu line): **"can we do euroraxk
   nominal but add a toggle on the card to set it to line per jack"** — so
   this ADR's ±5 V reference stands, and the line-gear half of the report is
   answered by a PER-JACK modular/line reference toggle on the face (a new
   id per jack, default = modular, so no saved rack moves), built as the
   follow-up PR rather than the dB trim proposed below.
2. Saved racks: **"Re-interpret (Recommended)"** — the audio class's existing
   value is re-interpreted as described under Consequences; no `audio_ref`
   switch.
3. The two new tests (dsp worklet unit test, `es9` ART level-parity
   scenario): **"Approve both (Recommended)"**.

The questions as they were put, kept for the record:

**This ADR fixed HALF of the report at the time it was written.** Modular (±5 V) audio reaches parity
with the internal mixer; **line-level gear is still quiet after it**: +4 dBu
lands at 0.35 peak (−9.2 dBFS), −10 dBV at 0.09 (−21 dBFS). Line gear only
reaches parity with the per-jack trim follow-up (below), or with a different
reference than the one chosen here. Two yes/no answers are needed on the PR:

1. **Reference: ±5 V (this ADR) or line level?** One scale cannot make both
   hit ±1.0. Numbers for the alternative, +4 dBu ≙ ±1.0 (×5.76 in, ×0.174
   out), from the same `VOLTS_FULL_SCALE = 10`:

   | source / sink | ±5 V reference (this ADR) | +4 dBu reference |
   |---|---|---|
   | ±5 V modular audio in | 1.00 (0 dBFS) | 2.88 (+9.2 dBFS) |
   | +4 dBu line in | 0.35 (−9.2 dBFS) | 1.00 |
   | −10 dBV consumer in | 0.09 (−21 dBFS) | 0.26 (−11.8 dBFS) |
   | internal ±1.0 out, at the jack | ±5 V (Eurorack nominal) | ±1.74 V (−9.2 dB into a modular input) |
   | cv class relation | identical scale to `cv` | audio and cv differ by ×2.88 |

   ±5 V is chosen because modular is the product's stated case, it is the
   `cv` class's scale already (ADR-004), and the output direction then drives
   hardware at nominal instead of 9 dB under it. Either reference still needs
   the trim for the other kind of gear.
2. **Saved racks are re-interpreted** (Consequences, first bullet): the audio
   class's existing value `0` / absent changes level, which the audio-runtime
   contract forbids without an explicit decision. The contract's alternative
   is a NEW id whose default reproduces today — e.g. a module-level
   `audio_ref` selector (0 = full scale ±10 V, today; 1 = nominal ±5 V),
   default 0 — which keeps every saved rack as it is but ships the reported
   bug as the default for new racks too, and puts a switch on the face that
   nobody would ever set back to 0. Rejected here; available if the answer to
   the re-interpretation is no.

Status moved to Accepted on the answers quoted at the top of this section.

## Context

The ES-9 bridge moves RAW hardware-full-scale floats on the wire: ±1.0 ≙ ±10 V
at a DC-coupled jack (`packages/web/src/lib/audio/es9/es9-protocol.ts`, helper
`docs/DESIGN.md` — the manual's "approximately ±10 V" for 0 dBFS; assumed, not
metered). The worklet converts volts ↔ app units per the user's per-jack CLASS
(`packages/dsp/src/lib/es9-bridge-core.ts`): cv ×2 (±5 V → ±1), pitch ×10,
gate through a comparator. The AUDIO class was ×1: app ±1.0 ≙ ±10 V.

Every internal module runs at ±1.0 peak. So a ±5 V Eurorack audio signal
arrived at the raw `in{n}` port as 0.5 (−6 dB), +4 dBu line level (1.737 Vpk)
as 0.174 (−15 dB), −10 dBV as 0.045 (−27 dB) — and MIXMSTRS caps channel,
return and master volume at 1.0, so nothing in the rack could make it up.
Owner report, 2026-09-14: "es-9 is really really quiet, it seems like. audio
patched into it from modular or line level gear is just waaaay quieter than
our internal mixer." The output direction was the mirror image: internal ±1.0
drove a jack at ±10 V, twice Eurorack nominal.

## Decision

**App ±1.0 audio ≙ ±5 V at a DC-coupled jack, in BOTH directions** — the same
scale as the cv class (`NOMINAL_VOLTS = 5`). The wire does not change
(`VOLTS_FULL_SCALE = 10` stays; the helper app is untouched), nor do the gate
conventions (+5 V high; rise ≥ 2 V, fall < 1 V — physical volts that merely
share the number 5 and are deliberately NOT derived from `NOMINAL_VOLTS`).

Digital channels are the exception and pass ×1 both ways, because there
0 dBFS really is 1.0: the S/PDIF return (input channels 14/15) and the USB 1-8
feeds (output channels 0-7: main/phones/S-PDIF/ES-5 under the default routing).
`rawInSample` / `outSample` in `es9-bridge-core.ts` carry those jack-kind
guards; the worklet feeds its underrun fade from the EMITTED (scaled) level.

Reference chosen: ±5 V (Eurorack nominal, VCV's voltage standard, our cv
class), not a line-level reference — see "Open owner decisions" for the
numbers of the alternative. Line gear still lands at −9.2 dBFS (+4 dBu) /
−21 dBFS (−10 dBV) after this change — a per-jack trim (bipolar,
≈ −12..+24 dB, default 0, applied to the audio port only) was the proposed
follow-up. The owner chose a per-jack modular / line REFERENCE toggle instead,
which shipped as ADR-020 and supersedes the trim.

## Consequences

**Good:**

- A ±5 V modular signal reads ±1.0 at `in{n}`, parity with an internal VCO.
- A hardware loopback (out → in) is identity (×0.5 out, ×2 in), which makes
  the only cheap hardware verification meaningful; a ±10 V input reads ±2.0
  (float, harmless until the destination limiter).
- Internal ±1.0 now drives hardware at ±5 V instead of overdriving it at ±10 V;
  the ±10 V DAC rail is reached at ±2.0 in-graph (a MIXER sum clips LESS than
  before, not more).

**Bad / load-bearing:**

- **Saved racks are re-interpreted.** A saved rack is a bare
  `Record<string, number>` with no migration substrate and no id to append,
  and `out{n}_class = 0` (audio) is the default — so this is a deliberate
  re-interpretation of an existing param value, which the audio-runtime
  contract otherwise forbids. Effect on every saved rack that contains the
  (single-instance, owner-only) es9 module: audio `in{n}` ports +6 dB;
  `in{n}_class = 0` twins +6 dB (still equal to the audio port); every jack
  with `out{n}_class` absent or 0 emits ±5 V for ±1.0 instead of ±10 V
  (−6 dB at the jack). cv/pitch/gate jacks, usb1-8, spdif_l/r are unchanged.
  The old default WAS the reported bug, and the owner is the only user of the
  hardware; the owner's explicit acceptance is recorded on the PR.
- **`in{n}_class = audio` is now scale-identical to `cv`**; the two differ
  only by underrun policy (fade vs hold) and port type. The ±10 V → ±1
  reading is reachable through no port.
- **Loop-gain neutral for a send/return topology** (×0.5 out, ×2 in, vs ×1/×1
  before): only EXTERNAL sources get louder. Line gear reaching the rack
  through AUDIO IN (getUserMedia on the ES-9's first pair) is not this module
  and does not change.
- **Future capture** (`docs/design/es9-multitrack-capture.md`) plans helper-
  side BWF at WIRE scale; a take captured there plays back 6 dB under what the
  graph heard unless the capture path applies the same ×2 on DC jacks.
- **The helper repo's plan table** (`patchtogether.es9/docs/
  inet-modular-es9-module-plan.md`, `| audio | raw | raw |`) is stale; it is a
  pinned submodule and moves in its own repo. `DESIGN.md` stays true (wire
  unchanged; scaling lives in the browser).
- Any ADC DC offset on the audio path doubles with ×2 — the ES-9 config
  tool's ADC DC-block is the remedy (pre-existing).
- The ±10 V full scale is still assumed. The hardware-verify DC-meter step
  (constant +1.0 into an audio-class jack must read +5.0 V) is the one place
  it can be pinned; if it is not ±10 V, `VOLTS_FULL_SCALE` is the single
  constant to correct.

## References

- `packages/dsp/src/lib/es9-bridge-core.ts` — `NOMINAL_VOLTS`,
  `hwToBrowserScale` / `browserToHwScale`, `rawInSample` / `outSample`.
- `packages/dsp/src/es9-bridge.ts` — the worklet applying them per channel.
- `packages/dsp/src/lib/es9-bridge-core.test.ts`,
  `packages/dsp/src/lib/es9-bridge.test.ts` — the level pins (red on the old
  constant: raw in1 0.5 vs 1.0 for a 0.5 wire sine).
- `art/scenarios/es9/level-parity.test.ts` — the real factory + shipped dist
  worklet under OfflineAudioContext, parity with an internal VCO.
- `e2e/tests/es9-hardware.spec.ts` — opt-in (ES9_HW=1) loopback identity.
- ADR-004 — cv is ±1 ≙ ±5 V; this ADR gives audio the same scale.
