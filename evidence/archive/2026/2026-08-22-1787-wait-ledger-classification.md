# #1787 — the waitForTimeout ledger, classified call site by call site

Evidence record, 2026-08-22. Not instruction: verify any claim below against the
tree before acting on it. The numbers here are a MEASUREMENT taken at one commit
(`564b3746`, the state of `e2e/waitfortimeout-ledger.generated.txt` before this
lane's first batch) and they are reproducible, not hand-counted — see *How to
re-derive* at the bottom. They will be stale the moment a sibling lane lands a
conversion, which is the point of re-deriving rather than trusting the table.

The per-site verdicts live beside this file in
`2026-08-22-1787-wait-ledger-verdicts.tsv` — one row per ledger entry:

    <ledger key>\t<bucket>\t<RISKY|->\t<reason; PACING rows name the product constant>

## What the ledger held

    ledger total          429
    DOOM (exempt)          14
    payable population    415

Every one of the 415 payable entries carries exactly one verdict: the merge
checked both directions (no verdict names a key the ledger lacks, no ledger key
lacks a verdict) and found no duplicates. `task lint` was green at that commit,
so no entry was stale either — the ledger and the tree agreed.

## The buckets

    STATE    282   the wait stands in for an observable → expect / expect.poll
    PACING    69   a real product-side interval → keep the wait, annotate it
    PAINT     64   the wait buys rendered frames → waitFrames(page, n)
    DEAD       0   ← see below; the bucket did not survive verification

Roughly **83% is real debt** (STATE + PAINT) and **17% is legitimate timing that
was simply never written down** (PACING). #1787 filed an estimate of 20/50/29;
the read-every-site pass moved PAINT down and STATE up, and PACING landed at
about half the estimate because a site only counts as PACING here if the product
constant it mirrors could actually be FOUND and cited. "It feels like a debounce"
was not accepted.

### ⚠ DEAD went 4 → 0 — the classifier was wrong, and two of the four were traps

The first pass produced four `DEAD` verdicts ("a following `expect.poll` already
does this wait's work"). Every one was read against the source before deletion.
**None was a safe deletion, and two would have produced a green, blind test** —
the exact failure CLAUDE.md's instrument rule names, met inside the instrument
built to find it.

- `midi-learn-note.spec.ts :: … a gate INPUT row binds a NOTE :: waitForTimeout(30) #1`
  is a **SUSTAINED-NEGATIVE**. A *different* note (50) is injected and the
  binding must STILL be note 48. The following
  `expect.poll(...).toMatchObject({note: 48})` is already true at t=0, so it
  converges instantly and proves nothing. **The wait IS the assertion**: it is
  the only thing giving a would-be re-bind time to happen. Delete it and the
  test passes vacuously and would certify the re-capture bug it exists to catch.
- `rings.spec.ts :: … model switch (MODAL ↔ SYMPATHETIC) :: waitForTimeout(300) #1`
  — the claim was that `pollScopePeak(…, 0.01, 3000)` subsumes it. It does not:
  the scope is **still ringing from MODAL** when the model switches, so the poll
  can return the MODAL decay tail. The wait separates the two measurements.
  (That test was ALSO unsound for a second, independent reason — `peak > 0.01`
  is a property both models share, so it could not fail on a `model` that never
  reached the engine. **Fixed in the batch that touched it**: the switch is now
  a checked step, an `expect.poll` on the engine's own `model` value,
  negative-controlled in both directions. What it still cannot see — engine →
  worklet AudioParam, i.e. whether the DSP really renders a different resonator
  — is stated at the call site and raised with the owner.)
- `shapegen.spec.ts` and `textmarquee.spec.ts` are real debt but **STATE**, not
  deletions: both are the write-through-`__ydoc.transact`-then-read-`__patch`
  shape that PR #1788 already converted on cellshade to a single
  `expect.poll(...).toEqual({...})`. A bare delete works *today* only because
  SyncedStore applies synchronously; the poll survives that changing.

The lesson worth carrying: **"a later poll covers this" is only true when the
poll converges on a condition that is FALSE at the moment the wait begins.** For
a negative assertion the poll is true immediately and covers nothing. Ask of any
"redundant wait" verdict: *what would this poll do if the bug were present?*

## ⚠ DOOM — 14 entries, permanently exempt

Owner ruling 2026-08-17, verbatim: *"do not [touch] doom in any way without
specific approval."* Not classified, not read, not counted toward the payable
set. The mechanism is why it generalises: `video/modules/doom.ts` calls
`runtime.runTic()` inside `surface.draw`, and `runTic` runs exactly one
`dgpt_tick` — **DOOM's game clock IS the frame clock**, so a wait specifies how
far the game advances, and converting it is a behavioural change wearing a
mechanical refactor's clothes.

Across 8 files: `doom-aspect`, `doom-cheat-gates`, `doom-identity-crossview`,
`doom-launch`, `doom-mp-latejoin-freeze`, `doom-mp-lockstep-sharedstate`,
`doom-per-type-death-gates`, `doom-session-survives-card-collapse`.

**The ledger's floor is therefore not zero, by design.** Nothing may assert an
empty ledger, a remaining count, or a completion condition.

## ⚠ BLOOD is DOOM-shaped — the finding this pass produced

`packages/web/src/lib/video/modules/blood.ts:379` calls `runtime.runFrame()`
once per `surface.draw()`. That is the same frame-locked tic mechanism CLAUDE.md
documents for DOOM: one rendered frame is one game tic. Its 7 ledger entries
(`blood-audio-output.spec.ts` ×5, `blood-mount.spec.ts` ×2) gate real game
advancement, so converting them re-specifies how far the game gets — exactly the
class DOOM is carved out for. **Treat BLOOD as untouchable without specific
owner approval, alongside DOOM.** It is not covered by the existing ruling
because nobody had looked; this record is the looking.

## RISKY — 22 sites where a frame count is not a free refactor

The second label marks a wait feeding a simulation that advances PER FRAME
rather than per millisecond. These are not forbidden, but they are not
mechanical: changing the window changes how far the simulation gets, so each
needs its assertion re-read before conversion.

       5  e2e/tests/blood-audio-output.spec.ts      (frame-locked game tic — see above)
       3  e2e/tests/vfpga-p3-composite.spec.ts      (per-frame register / ping-pong fabric)
       3  e2e/tests/vfpga-p4-early-hd.spec.ts       (same fabric)
       3  e2e/vrt/vrt-scenes.ts                     (BACKDRAFT scene + shared applyVrtScene settle)
       2  e2e/tests/blood-mount.spec.ts             (frame-locked game tic — see above)
       2  e2e/tests/video-controls.spec.ts          (FEEDBACK — per-frame ping-pong accumulator)
       2  e2e/vrt/mirrorpool-composite.spec.ts      (ping-pong wave sim + frame-counter rain)
       1  e2e/tests/toybox-disk-loading.spec.ts     (TOYBOX feedback-node ping-pong)
       1  e2e/vrt/vrt-frame-stability.spec.ts       (parametrised over VRT_SCENES, incl. BACKDRAFT/TOYBOX)

Explicitly checked and ruled OUT (they look like the class and are not):
frogger (real-time `SchedulerClock`, `TICK_MS = 25`, decoupled from render
rate), nibbles and outlines (both integrate on real elapsed `dt` per draw, not a
fixed tic), gibribbon, cellshade, colourofmagic, quadralogical, ruttetra,
synesthesia, wavesculpt, and gl-feedback-loop.

## The PACING constants that were actually found

A site earns `PACING` only with a citation. The ones this pass located:

    WCOL_PAN_MS = 220          packages/web/src/lib/ui/Canvas.svelte:1733
    FLIP_MS = 360              packages/web/src/lib/ui/Canvas.svelte:8764 (→ _module-card.css)
    TAP_RESET_MS = 2000        packages/web/src/lib/electra/tap-tempo.ts:27
    LOOKAHEAD_S = 0.2          packages/web/src/lib/audio/modules/clipplayer.ts:281
    SCHEDULER_TICK_MS = 25     packages/web/src/lib/audio/scheduler-clock.ts
    BRIDGE_MS = 42             foxy.ts (4 sites)
    SEAM_GLIDE_S = 0.012       clip-automation-engine.ts (2 sites)
    POLL_MS = 200              samsloop.ts:931 (5 sites)
    stepDur = 60/bpm/4         kria.ts:376 (the vrt-composite-scenes group)
    fftSize = 2048 refill      scope.ts:174-175
    PUMP/ticker 33 ms          PictureboxCard.svelte:106, GibribbonCard.svelte
    clip-launch debounce 220   ClipplayerCard.svelte:361
    RATE_DEFAULT / GROW_IN_S   lushgarden-scene.ts
    one-pole ~7 Hz `si.smoo`   packages/dsp/src/filter.dsp

## Where the taxonomy does not fit cleanly

Recorded so the next pass does not re-litigate them:

- **Sustained-negative assertions** ("wait, then assert nothing changed"):
  `expect.poll` converges on a POSITIVE condition, so it cannot express "this
  stayed false for a while". Where the absent thing is an app animation, the
  honest answer is PACING naming that animation's duration; where it is a
  Svelte effect or an rAF-driven pass, it is a frame count. Sites:
  `timelorde-tap-tempo` ×2, `workflow-surfaces`, `workflow-lane-add-safety`,
  `workflow-viewport-nav` GUARD, `unpatch-patch-point` ("stays gone", "opens NO
  menu"), `midi-learn-note` (the mis-classified one above).
  **This is the highest-risk class in the whole ledger** — it is the one where a
  plausible-looking conversion silently removes the assertion, and it is where
  the classifier itself failed. Treat every "assert X is still Y" site as guilty
  until the poll is shown to be false at t=0.
- **GC-finalizer settles** (`patch-load-leak`, `samsloop-memory-bench`): the
  comment argues wall-clock is correct and it probably is, but finalizer timing
  is a V8 characteristic, not a `packages/` constant, so PACING's citation
  requirement cannot be met. Left as STATE pending a better idea.
- **Meta/infrastructure waits** (`e2e/chaos/lib/driver.ts` `applyIntent`,
  `e2e/tests/_module-coverage-helpers.ts` `runFor`): the wait IS the parameter,
  supplied by a caller. The four-bucket taxonomy does not describe them.
- **`e2e/vrt/**` carries its own hazard** beyond the buckets: changing WHEN a
  screenshot is taken can move a baseline, and baselines are authored only by
  linux CI. Convert VRT waits in their own batch, never mixed with functional
  specs.

## How to re-derive

    flox activate -- task lint          # proves the ledger is anchored both ways
    flox activate -- task lint:waits:accept   # regenerate; it REFUSES to grow

Bucket totals come from the committed TSV, not from counting by hand:

    cut -f2 .myrobots/2026-08-22-1787-wait-ledger-verdicts.tsv | sort | uniq -c
    cut -f3 .myrobots/2026-08-22-1787-wait-ledger-verdicts.tsv | sort | uniq -c

⚠ Cut the COLUMN. `grep -c RISKY` over the whole file returns 27, not 22 — five
reason strings say "ruled out RISKY", and a grep cannot tell a verdict from
prose about a verdict. That is this repo's instrument rule in miniature, met
while writing this very section: the wrong instrument returned a confident,
plausible, wrong number, and only a negative control (what are the other five?)
distinguished it from a finding.
