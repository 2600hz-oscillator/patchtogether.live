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
