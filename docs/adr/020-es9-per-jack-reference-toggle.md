# ADR-020: Give every ES-9 DC jack a modular / line reference toggle

- Status: Accepted (owner, 2026-09-14 — the words quoted under "Owner decision")
- Date: 2026-09-14
- Deciders: project owner
- Tags: dsp, semantics, es9, hardware, face
- Related: ADR-019 (audio unity is ±5 V; this ADR is the follow-up it names),
  ADR-004 (cv range convention)

## Owner decision (2026-09-14, verbatim)

Asked which reference ±1.0 should mean at the ES-9 DC jacks (±5 V Eurorack
nominal or +4 dBu line): **"can we do euroraxk nominal but add a toggle on the
card to set it to line per jack"** (recorded in ADR-019, "Owner decisions",
item 1). The owner said **per jack**. This ADR ships that toggle on all 14 DC
input jacks as asked, and on all 8 DC output jacks as the symmetric reading —
an output jack set to line drives ±1.736 V for ±1.0 rather than ±5 V.

## Context

ADR-019 made app ±1.0 ≙ ±5 V for the audio class in both directions, which
gave modular signals parity with every internal module and left line-level
gear where it was: +4 dBu (1.228 V RMS = 1.736 V peak) lands at 0.347
(−9.2 dBFS) under the ±5 V reference, and nothing in the rack can make it up
(MIXMSTRS caps at 1.0). ADR-019 proposed a bipolar per-jack dB trim as the
follow-up; the owner chose a two-position reference instead, which is the
smaller control (a property of the gear on the jack, set once) and needs no
number to remember.

## Decision

Each DC jack gains a second discrete param beside its class selector:
`in{1..14}_ref` and `out{1..8}_ref`, `0..1 discrete`, roster
`modular | line`, **default `0` = modular** — the exact ADR-019 behaviour.
Only the **audio** class reads it; cv, pitch and gate carry volts and are
untouched. The S/PDIF return and the USB 1-8 feeds are digital (×1) and
ignore it by the same jack-kind guards ADR-019 added.

The line reference is derived, never typed, in
`packages/dsp/src/lib/es9-bridge-core.ts`:

```
DBU_REF_VOLTS_RMS       = sqrt(0.6)                    = 0.774597 V RMS  (0 dBu = 1 mW into 600 Ω)
LINE_NOMINAL_VOLTS_RMS  = 0.774597 × 10^(4/20)         = 1.22765 V RMS   (+4 dBu)
LINE_NOMINAL_VOLTS_PEAK = 1.22765 × √2                 = 1.73616 V peak  (a sine's peak)
```

(ADR-019's "1.737 V" is a decimal-rounding artefact — 1.22765 rounded to 1.228
before ×√2 gives 1.7366 → 1.737; the exact product is 1.73616. The constant is
the derivation.)
Against `NOMINAL_VOLTS = 5` that is a 20·log10(5 / 1.73616) = **9.19 dB** gap.

### Multipliers (wire ±1.0 ≙ ±10 V, `VOLTS_FULL_SCALE`)

| direction | class | reference | multiplier | where |
|---|---|---|---|---|
| in, DC jack 1-14 raw `in{n}` port | audio | modular (default) | ×2 (10 / 5) | `rawInSample` |
| in, DC jack raw port | audio | line | ×5.760 (10 / 1.73616) | `rawInSample` |
| in twin `in{n}_cv`, class audio | audio | modular / line | ×2 / ×5.760 | `InScaler.process` |
| in twin, class cv / pitch | cv / pitch | any | ×2 / ×10 (ref ignored) | `InScaler.process` |
| in twin, class gate | gate | any | comparator, rise ≥ 2 V / fall < 1 V (ref ignored) | `InScaler.process` |
| in S/PDIF (channels 14/15) | — | ignored | ×1 | `rawInSample` guard |
| out jack 1-8 (channels 8-15) | audio | modular (default) | ×0.5 (5 / 10) → ±5 V for ±1.0 | `outSample` |
| out jack 1-8 | audio | line | ×0.17362 (1.73616 / 10) → ±1.736 V for ±1.0 | `outSample` |
| out jack | cv / pitch | any | ×0.5 / ×0.1 (ref ignored) | `browserToHwScale` |
| out jack | gate | any | ≥ 0.5 → +5 V (0.5 wire), else 0 V (ref ignored) | `browserToHwSample` |
| out USB 1-8 (channels 0-7) | — | ignored | ×1 | `outSample` guard |

### Face

The toggle sits beside its own jack's class selector (group by lane, never by
control type): `ES9_FACE` ranks `out1_class, out1_ref, out2_class, out2_ref, …`
and clusters one JACK PAIR per row (`class, ref, class, ref`), so both jack
bands are console grids of 4 and column j means the same thing in every row.
Three pages, no tab rail (below `DOCK_TAB_MIN_BANDS`).

## Consequences

**Good:**

- Line gear reaches unity with one press per jack; the residual ADR-019
  recorded (0.347) is exactly what the toggle removes (×2.88 = +9.19 dB).
- **No saved rack moves.** The ids are new and every default reproduces
  ADR-019 (the audio-runtime contract's "ship a new id whose default
  reproduces today"); contract-lock gains 22 lines and no existing line moves.
- A loopback with line on both ends is still identity (×0.17362 × ×5.760), so
  the cheap hardware verification stays meaningful.

**Bad / load-bearing:**

- The ref reaches `in{n}_cv` only when that twin's class is audio. A cv twin
  on a line-set jack still reads 0.347 for +4 dBu — by design (cv is volts),
  and pinned as the discriminator in the worklet and ART suites.
- Output line is the symmetric reading the owner did not name; it is 9.19 dB
  DOWN at the jack for ±1.0, which is what a line-level input wants.
- −10 dBV consumer gear (0.26 under line) is not covered; a third roster
  member (`consumer`, APPENDED — never renumbered) would be the extension.
- ADR-019's "per-jack trim" follow-up is superseded by this toggle.

## References

- `packages/dsp/src/lib/es9-bridge-core.ts` — `REF_MODULAR` / `REF_LINE`,
  `LINE_NOMINAL_VOLTS_*`, the `ref` argument on every scale function.
- `packages/dsp/src/es9-bridge.ts` — the worklet's `inRefs` / `outRefs`.
- `packages/web/src/lib/audio/modules/es9.ts` — `ES9_REF_*`,
  `es9RefsFromParams`, the 22 `_ref` params and the paired face.
- `packages/dsp/src/lib/es9-bridge-core.test.ts`,
  `packages/dsp/src/lib/es9-bridge.test.ts` — every multiplier cell.
- `art/scenarios/es9/level-parity.test.ts` — real factory + shipped dist:
  line in reads 1.0 / modular 0.347; line out drives 0.1736 / modular 0.5.
- `e2e/tests/es9-hardware.spec.ts` — opt-in (ES9_HW=1) loopback legs.
