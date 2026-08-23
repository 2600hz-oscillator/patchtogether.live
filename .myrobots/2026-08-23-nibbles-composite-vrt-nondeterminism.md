# `composite-nibbles-length_cv-driven` — a VRT baseline that is nondeterministic, and the evidence for it

---

## ⚠ RESOLVED — and the hypothesis below was WRONG. Read this first.

The diagnosis was carried out on 2026-08-23. **Step 1 (classify the diff PNG
first) refuted section 4's cv-shadow-latch hypothesis in one look**, which is
exactly what that section asked it to do. Recorded rather than quietly edited,
because the value of the falsifiable framing is only visible if the falsification
is kept.

**What the two PNGs actually showed** (committed baseline vs the frame the full
sweep captured):

```
LEN 4 → LEN 5 · pellet (495,167) → (374,133) · snake moved
```

That is **NIBBLES GAME STATE**, not a SCOPE analyser offset. Section 4 predicted a
DC-offset shift with an unchanged trace shape; the real difference is a different
RNG draw plus a different number of elapsed game ticks.

**The mechanism**, from `nibbles.ts`: `initialSeed()` falls back to `Date.now()`
unless `__nibblesVrtSeed` is set, and the game steps whenever `frame.time`
advances (`dt` feeds `tickAccumS`, which drives `advanceGame()`). This spec pinned
neither. ⚠ The sibling spec `vrt-composite.spec.ts` never had the bug — its scenes
go through `vrt-composite-scenes.ts`, which has pinned `__nibblesVrtSeed` all
along. **Two composite specs, one pinned, one not.**

**The fix** pins both halves, for the NIBBLES pairs only: the engine clock
(`__videoEngineFreezeTime`, so `dt` is identically 0 and the snake never steps)
and the RNG (`__nibblesVrtSeed`, set BEFORE spawn — `maybeApplyVrtSeed` re-seeds
`state` on a later frame but does NOT repaint, so a post-spawn pin would leave the
original `Date.now()` frame on screen).

**MEASURED, both directions, byte-level:**

| tree | run A | run B | verdict |
|---|---|---|---|
| pre-fix | `2ed942ac…` | `62fc8ce5…` | **differ** |
| post-fix | `1425603 2…` | `14256032…` | **identical** |

⚠ Section 5 warned that a local repeat loop here would be vacuous "because the
scene usually passes". That warning was right about a *pass/fail* loop and wrong
about this one: comparing the captured PNGs **byte-for-byte** is far more
sensitive than the tolerance-gated comparison, and the defect reproduces on every
run at that resolution. Worth keeping as a technique — when a flake hides inside a
tolerance, drop the tolerance rather than repeating the gated check.

DOOM was excluded by name and by construction; see the closing section.

---


Written 2026-08-23 from the CAMERA promotion lane (#2148), which tripped over this
without causing it. No fix attempted here: this is the diagnosis a fix session
should start from, so it does not have to re-derive the contradiction.

Subject: `e2e/vrt/__screenshots__/vrt-composite-coverage.spec.ts/composite-nibbles-length-cv-driven.png`
Spec: `e2e/vrt/vrt-composite-coverage.spec.ts`

---

## 1. How it surfaced

A full VRT sweep (run 32642520432, dispatched from #2148) committed **three**
baselines where two were predicted. Two were the PR's own subject
(`face-cameraInput-compact.png`, `face-cameraInput-dock.png`). The third was this
file, and nothing in that branch touches nibbles or scope.

It was **restored rather than shipped**, following the repo's own doctrine —
stated for ART and identical in principle: *an entry you cannot attribute to a
known intentional change is a finding; stop rather than re-pin.*

## 2. The contradiction, which is the whole reason to believe this is nondeterminism

These two observations are about **the same tree and the same committed
baseline**:

| observation | verdict on this scene |
|---|---|
| `vrt-strict`, all 8 shards, on branch head `c544c74cf` | **PASS** — the only two failures in the entire lane were `A snapshot doesn't exist` for the two cameraInput baselines (shard 3 and shard 8) |
| the capture job in run 32642520432 | **FAIL** — it rewrote the baseline |

Both cannot be right about a deterministic scene.

### Why the capture's verdict is meaningful and not an artifact

`.github/workflows/vrt-update.yml` runs the sweep with
`--update-snapshots=changed`. That mode **only rewrites a comparison that
FAILED**. It is not `=all` (which in Playwright 1.59 rewrites everything and has
previously produced 22 unrelated baseline churns — the reason `task vrt:update`
pins `=changed`).

So the capture did not "refresh" this file as a side effect of running. It
compared, the comparison failed, and it wrote the new bytes. That makes
"the capture found it failing" a real measurement rather than a mode artifact.

### And the restored baseline is not stale

After restoring the previous content, `vrt-strict` went green on **all 8 shards**
again. So the committed baseline is one the scene can match — it simply does not
match it every time.

## 3. What the scene is

From the spec header and the pair table:

- Pair `nibbles-length_cv`: source `nibbles`, port `length_cv`, kind `cv`,
  `value: 0.85`, driven through the `extras.forcePulse()` test hook.
- **The consumer is `SCOPE.ch1`**, and that is not incidental — the file states
  that *every* composite pair lands on SCOPE deliberately, because SCOPE's
  analyser-driven canvas is the only consumer whose UI visibly reflects a bridged
  signal. A knob-based consumer would produce a vacuous diff.
- Two frames are captured per pair: `-idle` (before the CV fires) and `-driven`
  (after).

### The stated determinism mechanism, quoted from the spec

> Determinism: AudioContext is SUSPENDED after the fire, so the analyser-derived
> parts of each card freeze on their last buffer.

## 4. The prime suspect: *which* "last buffer" the suspend freezes on

The determinism argument rests on "freeze on their last buffer". That phrase
hides a race, and it is the best-supported hypothesis available without running
anything:

- The suspend is scheduled from the **test** (main thread / Playwright).
- The analyser's "last buffer" is whatever the **audio thread** most recently
  filled.
- Nothing synchronises those two. So *which* buffer is frozen varies by up to one
  analyser frame, run to run.

### The discriminating evidence — checked against what the capture actually wrote

The spec defines four non-DOOM baselines (two pairs × idle/driven). All four
exist on disk. **The capture rewrote exactly one of them:**

| baseline | kind | driven by | rewritten? |
|---|---|---|---|
| `composite-nibbles-length-cv-idle` | cv | — (before the fire) | no |
| `composite-nibbles-length-cv-driven` | **cv** | **`forcePulse(port, 0.85)`** | **YES** |
| `composite-nibbles-pellet-idle` | gate | — | no |
| `composite-nibbles-pellet-driven` | gate | `forceHold(port, true)` | no |

Two independent asymmetries fall out, and both point the same way:

1. **idle is stable, driven is not.** Before the fire the signal is quiescent, so
   successive analyser buffers are near-identical and freezing on buffer *N* or
   *N+1* looks the same. After the fire it is moving.
2. ⚠ **The GATE pair's driven frame is stable and the CV pair's is not** — and
   the spec explains why in its own words:

   > For gate pairs we use `forceHold(port, true)` to lock the source CSN at
   > `offset=1` indefinitely. `forcePulse()` (a 10 ms pulse) would be gone by the
   > time audio is suspended for the snapshot.

   So a **held, steady** driven state is reproducible, and the one pair still
   driven by a **transient** is the one that moves. The author had already
   identified `forcePulse` as too short to survive until the snapshot — and
   changed the GATE pairs to `forceHold` for exactly that reason — but the CV
   pair still fires `forcePulse(port, value)`.

### So the likely mechanism is the CV LATCH, not merely an analyser frame

If a 10 ms pulse is gone before the suspend, the driven CV frame should be
indistinguishable from idle — yet it is not, and it has its own baseline. The
thing making it non-empty is almost certainly the shadow latch:
`$lib/audio/cv-shadow`'s `read()` returns `combined ?? knobValue`, and `combined`
is cleared **only by a knob move**. Nothing clears it when the pump stops. So the
scene freezes whatever value the per-frame CV pump last sampled *during* the
10 ms window.

That makes the frozen value a function of where the pump's sampling instant fell
inside a 10 ms transient — which is precisely the quantity nothing in this test
synchronises. It also explains why the failure is occasional rather than
constant: most samples land somewhere the diff tolerance still absorbs.

**This is the hypothesis to test first**, and it is falsifiable: if it is right,
the `-driven` frame's trace offset should differ between a passing and a failing
run, while its shape stays the same.

### Corroborating record elsewhere in the tree

`dom-source-modules.ts` documents the same latch from the other side, and its
#1583 verify pass explicitly **corrected** an earlier, wrong description of it.
That file used to say an unmounted card "draws every display param at its KNOB,
ignoring any patched cv cable". The correction records that this is not what
happens: a param under CV **latches at its last modulated value** and does not
fall back to the knob. "Degrades to the knob" is a graceful story with a
self-limiting failure; "latches wherever the modulation happened to be" is the
stuck-value shape — and it is the one that ships.

That is the same variable this scene freezes, described independently and for a
different reason. It is corroboration rather than a second hypothesis.

## 5. Playbook for the fix session, in order

1. **Classify the diff PNG FIRST.** Do not theorise from the code before looking
   at what actually moved — this step exists because the two classes have
   different causes and different fixes, and the code reads the same either way.
   Is the difference a *position/offset* shift (the SCOPE trace is the same shape
   sitting at a different DC level) or a *content* difference (a different shape
   altogether)?
   ⚠ **The section-4 hypothesis predicts the first, specifically.** A latched CV
   sampled at a different instant inside the 10 ms pulse moves the trace's
   OFFSET while leaving its shape alone. If the diff instead shows a different
   waveform shape, section 4 is wrong and the analyser-buffer reading (which
   frame got frozen) is the better lead. Recording that prediction here so the
   next session can falsify it in one look rather than adopt it.
2. **Grep the pin's SETTERS, not just its readers.** Establish what actually
   pins time/state in this scene and whether anything writes it after the pin.
3. **Read freeze-failure labels** — they name the losing call site directly.
4. **Fix the SUBJECT, never the threshold.** Widening the diff tolerance would
   convert a real instability into a permanently weaker gate. The correct fixes
   are of the form "make the freeze deterministic": wait on the *observable*
   (the response having settled) before suspending, rather than on wall clock;
   or pin the analyser's contents the way other faces pin their generators.
5. ⚠ **Beware a vacuous local loop.** Repeating the scene locally can pass many
   times in a row and prove nothing — the whole point is that it usually passes.
   A local green is not evidence of a fix. Prefer a mechanism argument plus a
   negative control that can demonstrably produce the bad frame.

## 6. Standing constraint: the DOOM pairs in this file are off limits

`vrt-composite-coverage.spec.ts` also defines `doom-evt_kill` and
`doom-evt_door` (both `gatedOnDoomWasm`). **Any change in this file must exclude
them BY NAME and say so in the PR body.**

This is not politeness. `video/modules/doom.ts` calls `runtime.runTic()` inside
`surface.draw`, and `runTic` runs exactly one `dgpt_tick` — so DOOM's game clock
*is* the frame clock, and one rendered frame is one game tic. Re-timing anything
in DOOM's path re-specifies how far the marine walks, in a suite that then
asserts on where he ended up. The standing owner ruling is that DOOM is not to be
touched — code, specs, waits or timing — without specific approval. A silent
inclusion is the failure mode even when the change is otherwise correct.

## 7. Why nobody had noticed

The VRT capture scope is derived from the branch diff and is scoped by default
(#1795). Full sweeps are therefore rare. This one only went full because four
changed files in #2148 were renderable and named no module, so the derivation
fell back to the full sweep — loudly, and correctly. A scene that fails
occasionally and is only exercised by `vrt-strict` (where it usually passes) can
sit in this state indefinitely.

Worth noting for whoever schedules work: the same property means there may be
**other** occasionally-failing baselines that no scoped capture has ever
compared. This is the first one a full sweep happened to catch.
