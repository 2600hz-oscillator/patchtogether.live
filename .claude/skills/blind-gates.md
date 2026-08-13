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

---

## Moved here from CLAUDE.md (2026-08-12, #1493)

The RULE stays in CLAUDE.md; the measured evidence lives here so the numbers
exist in exactly one place.


## VALIDATE THE INSTRUMENT — a wrong metric reads exactly like a finding

> **Deeper treatment lives in the `blind-gates` skill** (`.claude/skills/`), with
> the negative-control discipline worked through case by case; the renderer/frame
> material is in `iterated-render-e2e`. **This section is the always-loaded
> summary — when the two disagree, the skill is the detail and this is the rule.**
> Keep the measured numbers in ONE place (the skill) so they can't drift.

The unifying failure of the 2026-07-28 backdraft session. **Four separate times
the measurement was wrong and its output looked authoritative.** None of them
announced themselves; each produced a confident, plausible, false conclusion.

- **Pearson correlation is invariant to global brightness**, and the sampled lags
  were *even* — so a genuine period-2 limit cycle read as `corr = 1.0` and the
  conclusion was "the servo doesn't oscillate". It did.
- **`getBoundingClientRect()` under xyflow's zoom transform** reported a 310 px
  overflow as 230 px. Sizing from it would have under-provisioned by ~25 %.
- **A wall-clock budget** is a different number of frames on every renderer, so
  "12 s" was ~700 frames locally and ~12 on CI (see the frame-count rule above).
- **A gate that reads only the def** cannot see a card contradicting it (below).

**Before believing a measurement, ask what it is invariant to.** A metric blind
to the very dimension under test will happily return a clean number. Cheap
defences, in rough order of value:

1. **Negative-control the instrument, not just the code** — perturb the thing it
   claims to measure and confirm the number moves. If it doesn't, the metric is
   wrong regardless of what the code does.
2. **Sample at co-prime / irregular offsets** when probing anything periodic; an
   even lag against a period-2 signal aliases to a constant.
3. **State the units in the assertion message** (`CSS px` vs `screen px`,
   `frames` vs `ms`). Half these bugs were unit confusions that a printed label
   would have exposed immediately.
4. **Reproduce under the environment that actually failed** before theorising —
   `E2E_SWIFTSHADER=1` settled two of these.
5. **Never sample a page-side quantity with a Playwright-side poll loop.** Added
   2026-08-02 (`workflow-master-transport`, shard 10). A `while (Date.now() <
   deadline) { await page.evaluate(read); await waitForTimeout(50) }` is one
   `page.evaluate` round-trip per sample **on the same main thread as the thing
   it measures** — so a loaded runner starves the subject and the sampler
   *together*, and a stalled thread can burn the whole 4 s window in two reads
   and then report "the clock never advanced" off a sample size of two.
   "Frozen" and "never looked" both print `Received: 1` and are
   indistinguishable from the output. **Move the accumulator INTO the page**
   (`page.evaluate` returning a Promise, sampling on a `setInterval` finer than
   the tick under test): it adds no protocol traffic, and the accumulated Set
   *survives* a stall, so a thread that freezes for 3 s and then runs still
   reports every value it computed. Report `samples` / `elapsedMs` / the values
   seen in the assertion message — that is what makes the next red run
   diagnosable instead of a coin flip. Measured: the reworked scan reads 200×
   in 4 s where the old loop managed a handful.

⚠ And the meta-tell: **"the result is genuinely different here" and "the
instrument reads differently here" look identical from the output alone.**
Establish which before acting; they need opposite fixes. ⚠ And when the fix is
to the INSTRUMENT, negative-control it in **both** directions before believing
it — force the subject frozen (the advance gate must go red) *and* force it
ever-running (the freeze gate must go red). Better still, make one of those a
PERMANENT leg of the test, so the instrument is negative-controlled on every
run rather than once at authoring time.


## A CARD can silently disagree with its DEF — every def-reading gate is blind to it

**Ask of any new gate: what is it structurally unable to see?** Two holes of this
exact shape were found on one card in one day.

**The bug (backdraft, 2026-07-28).** The def constrained `camTiltX/Y` to ±0.2 and
`camPosX/Y` to ±0.5. `BackdraftCard.svelte` passed literal `xMin={-1} xMax={1}`
to both `XyPad`s. That is **not** a display bug — the pads *wrote values the
contract forbids*, the model silently clamped them, and most of the stick's
travel did nothing. The control lied about its own range.

**Why nothing caught it:** `contract-lock`, `module-docs-lint` and the range
assertions **all read the DEF**. The e2e never touches the pad. So a card
disagreeing with its own def is invisible to the entire gate set, and the work
was honestly reported as "ranges constrained ✓" while the UI was still ±1.

- **A control's range must come from ONE place.** Export the range from the def
  module and have the card import it — never re-type the numbers in the card.
- **Guard it at the SOURCE level**, since no runtime gate sees it: grep the card
  for hardcoded ranges on any control whose def declares them. Precedent already
  in the repo: the `controlFamilies` → card-testid grep in
  `module-docs-lint.test.ts`, which exists for this same divergence class.
- The general rule: **a gate that reads only one side of a two-sided contract
  proves nothing about the other side.**

### A GUARD FOR THAT CLASS THAT IS OPT-IN IS ITSELF AN INSTANCE OF IT

**Audited 2026-08-02. Four gates, all green, all structurally unable to see the
bug class they exist to catch — because each applied a FILTER before the check
that quietly redefined the check's subject.** Coverage before → after:

| gate | the filter | saw | could not see |
|---|---|---|---|
| `mutate.guard`'s `RAW_PARAM_WRITE` | `\.params\[…\]` — **bracket only** | 3 | **96** dotted writes |
| `card-range-source`'s `RANGE_BOUND_CARDS` | an **opt-in filename list** | 7 cards | **186** cards |
| `module-docs-lint`'s edge check | `if (!p.edge) continue` | 63 ports | **299** gate ports |
| `faces-parity`'s `action` branch | *no probe at all* | 0 | **every** dead audition |

The self-tests were blind the same way (the raw-write self-test only ever fed
itself the bracket form), so nothing could have gone red. **Ask of any new gate:
what is it structurally unable to see — and would its green run look any
different if the answer were "everything"?**

The three inversions, applied to all four (details + measured numbers in the
`blind-gates` skill):

1. **Deny by default with a NAMED exemption per instance** — the exact
   `(file, key)` / `(module, port)` / `(card, param, field)` triple, never a
   filename, so a new defect in an already-listed file still reddens.
2. **Anchor to the ARTIFACT, not the list** — a ledger entry naming something
   that no longer exists is RED. A stale exemption is one nobody is watching.
3. ~~**Ratchet in BOTH directions**~~ — **superseded 2026-08-10.** Inversions 1
   and 2 stand; the count does not. Where the old advice was "cap the
   population and assert the cap has no slack", the rule is now **do not have a
   count**: name each instance, anchor the names to the artifact, and let the
   diff be the review. See "NEVER hand-type a population count" below.

Plus: **state the gate's scope inside the gate**, asserting what it still cannot
see — at zero, or in prose with the measured number if it genuinely cannot be
asserted.


### An ACTION-shaped cell needs a probe, exactly like a PANEL does

`ShellActionCell.probe` is **required**. An audition writes nothing to the graph
by design, so `readParam`/`readData` are structurally blind to it — the
observable is the **audition ledger** (`$lib/ui/modules/audition-ledger`), which
records per press whether the seam resolved a callable off the live engine handle
and called it. `delivered: false` is recorded, never dropped: "pressed and
reached nothing" must be distinguishable from "never pressed".

The predicate is negative-controlled in **both** directions in the unit lane on
every run (`audition-ledger.test.ts`), which is the permanent leg; the e2e side
was verified once by disconnecting karplus's `manualTrigger` read key and
watching `faces-parity` go red at the probe — with `toBeEnabled()` and `click()`
both still passing, which is the finding in one line.

**The sibling hole, same card, same day.** `card-control-overflow` only ever
spawned the module in its DEFAULT state, so controls revealed by a mode switch
were never measured — it missed a ~310 px overflow for hours. When a module has
modes, the sweep must enter them, and **assert the mode's controls are actually
mounted** so it cannot silently re-measure the default layout.

⚠ **That spec reports VIEWPORT-SCALED pixels, not CSS pixels** —
`measureOverflow` uses `getBoundingClientRect()` and xyflow applies a CSS
transform for viewport zoom. Pass/fail is scale-invariant (0 is 0), but every
*magnitude* is scaled: a 720 px card reads as ~530 at 0.736 zoom, and a ~310 px
CSS overflow prints as ~230. **Never size a card from the printed number**, and
never compare overflow figures across spawns unless the zoom matches.

