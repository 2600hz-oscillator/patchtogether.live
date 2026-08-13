# DSP correctness bugs — what is STILL waiting on the owner

The blind analysis found 7 verified DSP correctness bugs. **Five are closed** and
their entries are deleted: `rbj-biquad` Q-not-in-cache-key (#1366), `wavesculpt`
`master_gain` dead knob (#1368), `toybox` `wouldCreateCycle` false-positive
(#1367), and three that went MOOT when `helm` (#1013) and `elements` (#1033)
were deleted out from under them. The CI-schema item is closed too —
`scripts/apply-db-schema.sh` now reads the DIRECTORY, so 002/003/004 are applied
on every lane.

Three things survive. Two need a decision that was never made; one is a latent
defect that was measured, reported and deliberately left.

---

## 1. `macrooscillator` hihat phase-wrap DC latch — NEEDS THE OWNER'S CALL

**Re-verified 2026-08-12: still the single-subtraction wrap.**
`HihatEngine.tick` (`packages/dsp/src/macrooscillator.ts:1038-1039`):

```ts
this.phases[i] += (freq * ratio) / sr;
if (this.phases[i] >= 1) this.phases[i] -= 1;
```

Above ~5.4 kHz × ratio the square latches to DC, collapsing high-ratio partials.
`HIHAT_RATIOS` tops out at **8.21**. Fixing it changes the hihat timbre at high
pitch/ratio — **ear-dependent, so it is not mine to ship silently.**

⚠ **The identical pattern also sits at `:445-446` in a second engine** (still
present). Whoever takes the decision should check whether that one is reachable
at the same increments before fixing only the hihat.

## 2. Relay silent-loss on the final store — NEEDS AN ENGINEERING DISCUSSION

Narrower than the blind report framed it: the swallow is **deliberate
crash-prevention**, and Hocuspocus re-stores on the next debounce while the doc
is loaded. The real gap is the **last-client-leaves final store**.

`packages/server/src/db.ts:225` still swallows and still logs
`persist FAILED (transient — relay stays up, will retry)`. Fixing it trades
crash-safety against durability, which is why it was never done unilaterally.
**The discussion this asks for has not happened.**

## 3. `rbj-biquad` — the residue that was reported and left unfixed

#1366 fixed the arity bug (a two-slot key guarding a three-input function) by
adding `k3`. **Re-verified 2026-08-12, both of these are still true** in
`packages/dsp/src/lib/rbj-biquad.ts`:

- **`sr` is absent from all five cache guards** (`:77`, `:95`, `:113`, `:131`,
  `:147`). Latent only because `sr` is fixed per context today.
- **`k1`/`k2` carry different meanings per updater**, so the guards collide
  across updater kinds. Measured: `updateLowShelf(250, 4)` followed by
  `updateHighShelf(250, 4)` returns **the low shelf verbatim**. Latent only
  because no biquad is currently shared between updaters.

Both become real the moment a biquad is shared or a second sample rate appears.

---

**Worth keeping from the closed items, because it is the reason the bug hid:**
the Q-cache defect was invisible to any fc-centred probe. Both Q values read
≈+6 dB *at fc*; the audible error was **1.85 dB at 299 Hz**. A probe placed
where the filter is defined by its parameter is blind to a parameter that only
shapes the skirt.
