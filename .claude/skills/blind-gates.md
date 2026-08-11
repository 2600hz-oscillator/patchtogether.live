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

## Pattern 5 — the gate is OPT-IN, so the case nobody enrolled is the case it misses

**Case (2026-08-02, the four-gate sweep).** Four gates in this repo were audited
for what they were *structurally unable to see*. Every one had the same shape:
a filter applied BEFORE the check, which quietly redefined the check's subject.
Measured coverage, before → after:

| gate | the filter | saw | could not see |
|---|---|---|---|
| `mutate.guard`'s `RAW_PARAM_WRITE` | `\.params\[…\]` — **bracket only** | 3 writes | **96** dotted (`node.params.mode = m`) |
| `card-range-source`'s `RANGE_BOUND_CARDS` | an **opt-in filename list** | 7 cards | **186** cards |
| `module-docs-lint`'s edge check | `if (!p.edge) continue` | 63 ports | **299** gate ports |
| `faces-parity`'s `action` branch | *(no probe at all)* | 0 effects | **every** dead audition |

**The tell in each case was that nothing had ever failed.** A gate whose green
run means "no instances of the shape I look for" reads identically to one whose
green run means "no instances exist" — and only the second is what anyone
believes when they read it.

**Three inversions that fix it, in preference order:**

1. **Deny by default, with a NAMED exemption per instance.** Not a filename —
   the exact `(file, key)` / `(module, port)` / `(card, param, field)` triple, so
   a *new* defect in an *already-listed* file still reddens. An opt-in list
   cannot do this; it exempts a whole file forever.
2. **Anchor the metric to the ARTIFACT, not the list.** Ground truth is the raw
   write in the tree, the gate-cable port on the def, the divergence in the card.
   The exemptions must then *explain* each one. An entry naming something that no
   longer exists is RED — a stale exemption is an exemption nobody is watching,
   and it silently re-exempts the next regression on that key.
3. ~~**Ratchet in BOTH directions.**~~ **SUPERSEDED 2026-08-10 — do not add a
   count at all.** The advice was right about ceilings (`actual <= CEILING`
   alone can only trip by growing, so a drain that forgets to lower the number
   passes in silence and leaves slack that absorbs the next regression) and
   wrong about the premise. A hand-typed population count is a merge hazard **by
   construction**: sibling branches each compute it correctly for their own tree
   and write the identical literal, so it auto-merges cleanly and wrongly — no
   conflict, no red test. Measured 3-of-3 on the edge ledger, and 3-of-3 again
   on `card-range-source.test.ts` (base `9 / 7`; three concurrent faces wrote
   `10 / 8`, `11 / 9`, `11 / 9`; merged truth `12 / 10`).
   **Instead:** an unconditional `toEqual([])`; or a named deny-by-default list
   whose `why` lives in the TYPE so `tsc` refuses the undeclared form; or a
   property DERIVED from the artifact; or a GENERATED golden on the
   `task *:accept` loop. Full rule, and the narrow exception for genuinely
   unpayable debt, in CLAUDE.md → "NEVER hand-type a population count".

**And state the gate's SCOPE inside the gate.** Every one of these now asserts
what it still cannot see (`Object.assign(node.params, …)`; a control with no
`paramId`; a whole-bag `params = {…}`), either at zero or ratcheted. An unstated
scope reads as full coverage — that is the whole pattern, one level up.

### Pattern 5b — the LEDGER that inverts the gate becomes the next blind spot

**Case (2026-08-02 → 2026-08-09, the edge ledger).** Row 3 of the table above
was fixed correctly: `if (!p.edge) continue` became deny-by-default. But the 299
ports it had been skipping were then **parked in a ledger with a hand-typed
count** instead of being declared. Every consequence below followed from that
one decision, and none of them was visible from a green run.

- **295 of the 299 already had authored prose naming the answer.** This was not
  299 unknowns; it was ~295 known answers that had never been typed into the
  contract, plus a handful needing a DSP read. When the whole sweep was finally
  done it took one session and moved **283 lines of `contract-lock.txt`, every
  one of them the old line plus one `edge=` token** — no ambiguity anywhere,
  6 prose contradictions found, 0 behaviour changes.
- **The hand-typed ceiling auto-merged WRONG in 3 of 3 parallel branches.**
  Three face PRs drained from the same base and each wrote its own literal
  (288, 277, 287) when the truth was the UNION of the drains (275). Two of the
  three collided in the comment block, which is the *only* reason git surfaced
  it — the third merged **cleanly and wrongly**, shipping a ceiling with slack,
  and slack in a `<=` ratchet is absorbed silently by the next regression.
- **The number needed a paragraph of warning comments to explain.** A number
  that needs a warning label is the wrong mechanism.

**The three rules, in order:**

1. **Pay mechanically-payable debt; never inventory it.** A ledger of *known
   answers* is deferred typing, not engineering — and it is worse than the
   typing, because every agent that touches the area now pays a re-count tax.
   Before writing an exemption list, ask: *does the answer already exist
   somewhere in the tree?* If it does, the list is the wrong artifact.
2. **A ratchet is legitimate ONLY for debt that genuinely cannot be paid now** —
   it needs hardware, an owner decision, a re-attest window. Even then the count
   is **DERIVED from the artifact**, never a typed literal in a shared file: a
   literal is a merge hazard *by construction*, independent of anyone's care.
3. **Any migration counter ships with its DELETION CRITERIA stated in the
   file** — the condition under which the mechanism is removed. Otherwise the
   scaffolding outlives the building, and the thing everyone reads as "we are
   tracking this" means "nobody has looked since it was written."

And when the debt is finally paid, **delete the mechanism** — the list, the
count, the both-directions ratchet, the stale-entry anchor. Do not leave a
replacement counter behind; at zero it measures nothing and can only go stale.
The check that remains is the unconditional one, plus a permanent negative
control (see below) that calls the *same predicate* the demand clause calls —
a re-typed copy in the self-test is how the previous one went blind.

### The corollary: fixing a card prop can be a GREEN GATE OVER A LIVE BUG

Four cards pass `curve="linear"` on a param the def declares `discrete`. Writing
`curve="discrete"` would turn the gate green and change **nothing**: all four are
`<Knob>`, and `Knob.svelte` has no `discrete` branch — `Fader.svelte` and the
shell's `knob-conic-model.ts` both do. **Before "fixing" a declaration to satisfy
a gate, check the consumer reads it.** Otherwise the gate now certifies the bug.

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
