# When a gate cannot SEE what it gates

A green gate means "this instrument found nothing". That is only the same as
"nothing is wrong" if the instrument could have seen the problem. Four times in
one program (BACKDRAFT PURE TV, #1214/#1223) a gate was **structurally blind** to
the exact thing it existed to catch — and each time the blindness looked like a
pass, or worse, like a physics result.

**The question to ask of any green check: what class of failure is this
instrument incapable of reporting?** If you cannot answer, you do not yet know
what the green means.

---

## Pattern 1 — the metric is invariant to the signal

**Case.** CRITICAL mode's servo produces a **period-2/3 limit cycle**. It was
measured with Pearson correlation between frames at lags 40 and 100. Result:
`corr = 1.0000` at every setting, on a picture that was visibly pumping.
Conclusion drawn: "the servo does not oscillate." **Wrong.**

Two independent blindnesses stacked:
- Pearson correlation is **invariant to a global affine change**, so a
  whole-frame brightness pulse reads as perfectly correlated.
- The lags were both **EVEN**, and the cycle had period 2 — every sample landed
  on the same phase.

The physics was right the whole time; the instrument could not express it. The
fix was an **odd** lag plus a frame-mean **swing**, and the oscillation appeared
immediately (swing 0.00e+0 below the bifurcation, 3.54e-1 above).

**Rule.** Before trusting a null result, write down the transformation your
metric is invariant to, and check the effect you are hunting is not inside it.
For periodic phenomena, **never sample at a fixed lag that shares a factor with
the period** — vary the lag, or measure amplitude rather than correlation.

## Pattern 2 — the instrument reports different units than you think

**Case.** `card-control-overflow` reported a 228.8 px overflow. The real figure
was **~310 CSS px**. It measures via `getBoundingClientRect()`, and xyflow
applies a **CSS transform scale** for viewport zoom — so every number it prints
(`cardW`, `cardH`, overflow) is in **scaled screen pixels**.

This also produced a phantom bug: the card asked for 720×720 and measured
530×530, which was read as "something is clamping the node". Nothing was.
720 × 0.736 ≈ 530. Hours were nearly spent hunting a clamp that did not exist,
and sizing against the printed number would have under-provisioned by ~80 px.

**Rule.** For any measurement crossing a transform boundary (CSS transforms,
device-pixel-ratio, canvas scaling, sample-rate conversion), **state the units in
the assertion message** and convert explicitly. Two measurements are only
comparable if they were taken at the same scale — the same card measured 707 px
and 530 px wide in two spawns purely from different fit-view zooms.

## Pattern 3 — the gate never reaches the state that breaks

**Case.** `card-control-overflow` sweeps every module **at its default params**.
BACKDRAFT's default is `tvMode: 0`, and the new controls were behind
`{#if tvOn}`. So the gate that had caught a real 56.7 px overflow on that exact
module hours earlier **could not see** the controls added afterwards — which
overflowed by ~310 px and had done since the moment they were added.

**Rule.** When you add a control, a branch, or a mode that a sweep reaches only
at non-default params, **the sweep does not cover it**. Add an explicit case, and
have that case **assert the new thing is actually mounted** (e.g.
`expect(page.locator('[data-testid="…-cam-row"]')).toBeVisible()`) so it cannot
silently re-measure the default layout and pass.

## Pattern 4 — every gate reads the same source, so a second source drifts free

**Case.** The camera joysticks were constrained to ±0.2 / ±0.5 in the module
def, and the homography clamped to the same. `BackdraftCard.svelte` still passed
literal `xMin={-1} xMax={1}` to both `XyPad`s. The UI showed the wrong scale
**and wrote values the contract forbids** — a drag to 0.8 stored 0.8, which the
model then silently clamped to 0.2. Part of the stick did nothing.

Nothing caught it, because **every existing gate reads the DEF**: contract-lock,
the docs lint, the range assertions. The e2e never touched the pads. The card
was a second, unchecked source of truth.

**Rule.** When a value is restated anywhere outside its definition — a card, a
doc, a shader constant, a fixture — either **derive it from the definition** or
**pin the restatement in a test**. The repo already does this for
`controlFamilies` → card-testid; `V10` in `backdraft-tv.test.ts` does it for
control ranges by asserting the card source references the exported constants and
contains no hardcoded unit range.

---

## The negative control is the antidote

The one technique that caught all of this reliably: **make the gate go RED on
purpose, under conditions where the effect must be absent.**

- If a dynamics assertion cannot be satisfied with the **stochastic term
  switched off**, it is measuring noise. CRITICAL's limit cycle is asserted with
  the noise floor OFF, so the separation is not a ratio over a floor — below the
  bifurcation both metrics are **exactly `0.00e+0`**.
- Four candidate mechanisms for CRITICAL were falsified this way: raised gain
  ceiling, expanding spatial map, lagged local droop, hue rotation. All four
  converged **bit-exactly** with noise off. Without that control, all four would
  have "passed" on a ~4× margin over their own noise.
- A negative control is only meaningful if it is **non-degenerate**: E4's
  original control used `zoom: 1`, which made the legacy path a clipped step on
  which the peak-finder is undefined — it passed by accident. `zoom: 0.8` makes
  it exercise the real path.

**Ask of every new assertion: what would make this go red?** If the answer is
"nothing I can currently produce", the assertion is decoration.

## Related

- `skeptical-first-baseline.md` — do not trust a baseline you have not tried to
  break
- `testing-conventions.md` — lanes, flake protocol, `REPEAT=3`
- Memory `flaky-tests-can-be-unsound-not-just-flaky` — ask why the GREEN runs are
  green
