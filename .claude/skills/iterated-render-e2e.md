# E2E for ITERATED render modules — count frames, never milliseconds

A module whose output is a function of its own previous output (BACKDRAFT,
FEEDBACK, TOYBOX, the video-feedback family) needs **N rendered frames** to reach
the state you want to assert on. BACKDRAFT's nest, for instance, builds **one
level per frame**.

**A millisecond budget silently becomes a different number of frames on every
renderer.** That is the single most expensive mistake in this area, and it has
now been made twice on the same spec.

## The numbers, measured

| renderer | fps on a backdraft patch |
|---|---|
| real GPU (local) | **~60** |
| SwiftShader, single worker | **7.9** |
| SwiftShader on CI, 10 e2e shards in parallel | **~0.5–2** |

So a 12 s wait is ~700 frames locally and **~12 frames on CI**. A nest that needs
~80 frames "never settled", and the spec timed out — while being completely
correct.

**CI is ~2.5× slower for CPU-bound unit work, but ~7.6× slower for WebGL before
shard contention.** Do not carry the unit-lane figure across.

## RULE 1 — drive the frames yourself

Pause the engine's rAF loop and step it, with the simulation clock pinned. The
frame count becomes exact and renderer-independent by construction, and the
wall-clock cost collapses to the renderer's true fill rate.

```ts
w.__videoEnginePause = true;
const vid = w.__engine().getDomain('video');
for (let n = 0; n < steps; n++) {
  w.__videoEngineFreezeTime = start + (n + 0.5) / 60;   // pin the clock
  vid.step();
}
```

Read pixels from the node's own output texture (`vid.outputTexture(id)` +
`readPixels`) rather than the canvas — it skips compositing and is what
`backdraft-render-smoke.spec.ts` already does.

**Do not wait on `requestAnimationFrame` either.** rAF throttles under load and
stops entirely if the page is backgrounded; polling from the test side is worse
still, because it **aliases** — a 2–3 frame limit cycle sampled every ~120 ms
lands on the same phase every time and reports a swing of **0** on a visibly
pumping picture. That was a real 1-in-3 flake.

## RULE 2 — frames are the budget, so spend them deliberately

The spec renders every frame it asks for. Costs compound fast across tests.

- Ask what the **deepest** thing any assertion actually reads. BACKDRAFT's
  assertions reach level 5, so 45 frames is ample and 100 was unaffordable
  belt-and-braces.
- **Recovery/settling windows cannot be cut as hard as build windows.** After a
  servo has been driving hard, the nest rebuilds one level per frame from a
  *disturbed* state — cutting that window from 160 to 90 frames left 2 resolved
  bands and failed on merit, not flake.
- Give simulation-bound tests an explicit generous timeout. A compute-bound test
  should not inherit a default tuned for pure-function assertions.

## RULE 3 — you cannot buy speed by rendering smaller (for geometry assertions)

Tempting and **already tried, twice**: `vid.setResolution(384, 288)` is ~7×
fewer fragments. It breaks the band-count assertions, and so does 512×384.

The reason is physical, not tolerance: a nest's resolvable depth **is** set by
resolution — `k_res = ln(2px / W) / ln(s)`. Shrink the framebuffer and the deeper
bands fall under a pixel and genuinely stop existing. **This is not a threshold
to relax.** Recorded here so it is not retried a third time.

(Lower resolution is still fine for assertions that are not about spatial
detail — mean level, temporal behaviour, presence/absence.)

## RULE 4 — a new expensive spec is a new tenant in its shard

Playwright shards by file. A heavy new spec can push its **neighbours** past
their default 30 s/60 s budgets, so the failures appear in specs you did not
touch and which are green on main. #1223's spec did exactly this to
`backdraft-full-output.spec.ts` (Full Screen) and `backdraft.spec.ts` (FREEZE).

When that happens, the fix is **not** raising the neighbours' timeouts — that is
tolerating a flake and it degrades CI health for every other PR. Reduce the new
spec's footprint, or remove load from the shard for a real reason.

## RULE 5 — verify under the renderer that actually fails

`E2E_SWIFTSHADER=1` forces Chromium's WebGL onto the software renderer, which is
what CI uses. A spec that passes 3× on a real GPU tells you nothing about CI.

```sh
flox activate -- env E2E_SWIFTSHADER=1 npx --workspace e2e playwright test \
  tests/my-spec.ts --workers=1 --repeat-each=3 --reporter=line
```

**And check whether it is slowness or a different result.** Those need opposite
fixes, and it is a five-minute check: under SwiftShader BACKDRAFT converged to
the *identical* attractor (10 bands, room 1.000, ladder
1.000/0.741/0.631/0.561/0.506 against a predicted 1.000/0.739/0.629/0.559/0.505)
— it was 7.6× slower, not different. That justified a bigger frame budget; a
*different* attractor would have meant a renderer bug instead.

## RULE 6 — pin defaults, not literals that currently equal them

A spec pinning `bezel: 0.4` broke when the fader was re-centred: 0.4 still
existed but now meant a **thinner** border (`tb` 0.06 → 0.048), which resolved
fewer bands and failed an unrelated assertion. Pin `DEFAULTS`/`pdef()`, or say in
a comment that the literal tracks a default.

## Related

- `blind-gates.md` — instruments that cannot see what they gate
- `running-tests.md` · `testing-conventions.md`
- Memory `ci-swiftshader-video-e2e-timeouts` — scale timeouts by input/capture
  count, never flat
- Memory `capability-dependent-e2e-local-vs-ci`

---

## Moved here from CLAUDE.md (2026-08-12, #1493)

The RULE stays in CLAUDE.md; the measured evidence lives here so the numbers
exist in exactly one place.


### NEVER express a renderer-dependent wait in MILLISECONDS — count FRAMES

The single highest-yield rule for WebGL/video e2e, and the one that has bitten
most often. A wall-clock budget silently becomes a **different number of frames
on every renderer**, so it is not one assertion — it is a different assertion
per machine.

Measured on backdraft PURE TV (#1214): **7.9 fps** under `E2E_SWIFTSHADER=1`
vs ~60 fps on a real GPU — **~7.6× before shard contention**, and CI runs *ten*
e2e shards in parallel on top of that. A 12 s budget was ~700 frames locally and
**~12** on the runner. The effect needs ~80 frames to build (the nest advances
exactly one level per frame), so the test could not pass on CI at any wall-clock
value that still looked sane locally.

- **Wait on a frame count in the page via rAF** (`waitFrames(n)`), not
  `waitForTimeout`. That is renderer-independent *by construction* rather than
  by tuning, and needs no per-machine calibration.
- Keep a wall-clock cap only to **bound the failure**, never as the gate — and
  bound frame-capture loops by time *as well as* count (40 frames at 8 fps is
  5 s of pure frame time, which is its own timeout).
- ⚠ **The ~2.5× "CI is slower" figure is a UNIT-LANE number** (vitest default
  5000 ms; locally-2 s tests timed out at 5.5–6.3 s). It is far too optimistic
  for anything touching WebGL. Do not carry it across.
- Reproduce under the renderer that actually failed — `E2E_SWIFTSHADER=1`
  exists for exactly this and is what caught both this and the gate-bridge
  pathology in #1192.

**Establish WHY before touching any budget.** "Slower on CI" and "the result is
genuinely different on CI" need opposite fixes, and only the first is a timing
problem. #1214 proved sameness first — 10 bands both renderers, brightness
ladder 1.000/0.741/0.631/0.561/0.506 vs 1.000/0.739/0.629/0.559/0.505 — and
only then treated it as a pacing bug.


### The helper lives in ONE place, and a new sleep is a LINT ERROR (#1523)

`waitFrames(page, n)` and `settle(page)` are exported from **`e2e/_helpers/frames.ts`**
and from nowhere else. `e2e/vrt/_shell-faces.ts` re-exports them so its existing
callers are unchanged. Do not hand-roll another
`new Promise(r => requestAnimationFrame(r))` in a spec — before this consolidated,
the tree carried a dozen slightly different settles and no two agreed on how many
frames "settled" meant.

Both are ONE `page.evaluate` for the whole wait. A per-frame round trip is protocol
traffic on the same main thread it is waiting for; on a loaded runner it costs
several times what it measures (the #1303 trace: a single `waitForTimeout(60)`
taking 392 ms).

**`page.waitForTimeout` under `e2e/` is now denied by default.** The rule is
`local/wait-for-timeout-needs-why`
(`scripts/lint/rules/wait-for-timeout-needs-why.mjs`), NAMED and blocking — it is
deliberately absent from `STAGED_RULES`, so a finding fails `task lint`, which is
`$LINT` in the required `ci` umbrella. Three ways out, in order of preference:

1. **RENDER/PAINT readiness** → `waitFrames(page, n)`.
2. **STATE/DOM readiness** → an auto-retrying `await expect(locator)…`, or
   `expect.poll` on the real subject. Usually the wait and the assertion turn out
   to be the same statement, and merging them removes the guess entirely.
3. **A genuine PRODUCT-SIDE interval** — a debounce the app defines, a decay tail,
   a gate width, a MIDI pacing gap. Keep the wait, and say so ON the call site:

   ```ts
   // pacing: mirrors DEFAULT_GATE_LEN_S = 50 ms in
   // packages/web/src/lib/audio/gate-trigger.ts — the pulse must be wider than
   // one product gate width or the detector can miss it between audio blocks.
   await page.waitForTimeout(60);
   ```

   The marker is `pacing:` and the prose must clear 40 characters — the same
   `why.length` bar every other named exemption in this repo carries. A marker
   with no substance behind it is refused (there is a permanent control for it).

The waits that predate the rule live in `e2e/waitfortimeout-ledger.generated.txt`
— **generated, never hand-edited**. `flox activate -- task lint:waits:accept`
regenerates it and REFUSES TO ADD A LINE, so it can only shrink; a ledger entry
that no longer names a live call site fails `task lint`. That is the burn-down
ratchet: convert or annotate, re-run accept, commit the shrunk artifact, and read
the removals in the diff as the measurement.

⚠ **DOOM is carved out of the burn-down permanently, by owner ruling
(2026-08-17): _"do not fuck with doom in any way without specific approval"_.**
Its ~49 entries stay in the ledger, so **the ledger's floor is not zero** — the
payoff campaign (#1787) finishes with them still listed, and nothing may assert
an empty ledger or a remaining count.

The reason is worth carrying, because it generalises: `video/modules/doom.ts`
calls `runtime.runTic()` from inside `surface.draw`, and `runTic` runs exactly
one `dgpt_tick`. **DOOM's game clock IS the frame clock — one rendered frame is
one game tic.** So `waitForTimeout(1200)` while a key is held is ~72 game tics
on a local GPU and ~9 under SwiftShader. That is not a settle margin with slack
in it: converting it changes **how far the marine walks**, in a suite whose
assertions are about where he ended up. Whenever a wait feeds a simulation that
advances per frame rather than per millisecond, "mechanical refactor" and
"behavioural change" are the same edit — find that out BEFORE you touch it.

If a later sweep's scope would include DOOM specs, exclude them **by name with
the reason attached**, and say so in the PR body. A silent inclusion is the
failure mode even when the conversion is correct.
