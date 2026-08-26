# VRT zero-tolerance: the measurement, and what it decided

Owner premise (2026-08-25): a Svelte component tree can render deterministically
every time, so every pixel of VRT tolerance is hiding a bug rather than
accommodating physics. *"VRTs are useless if they can't be pixel perfect every
time … i would never have consciously allowed even a 1px tolerance"*, and *"the
same PR should add updated VRTs and also move maxDiff and threshold to 0"*.

## Tolerances before / after

|  | before | after |
|---|---|---|
| `DOCK_MAX_DIFF` (`e2e/vrt/_shell-faces.ts`) | 1500 px | **0** |
| `COMPACT_MAX_DIFF` (same file, documented INERT) | 150 px | **0** |
| `threshold` (`e2e/vrt/vrt.config.ts`) | 0.1 = 26/255 | **0** |
| `maxDiffPixelRatio` (same) | 0.01 | **0** |

## Phase 1 — does the scene REPRODUCE? (the question the baseline cannot answer)

`e2e/vrt/vrt-determinism-probe.spec.ts` boots each face TWICE on ubuntu CI
through the gate's own scene code and diffs BOOT 1 against BOOT 2 at threshold
1/255. The baseline is out of the loop entirely, so a non-zero row cannot mean
"the baseline is stale" — only "this scene does not reproduce". Negative AND
positive controls on every row; a storage-wipe control (cookies / localStorage /
sessionStorage / IndexedDB / CacheStorage) rules out a pair matching by
inheriting state.

**Every face scene but THREE was bit-exact across two cold boots.**

```
scene                diff@1  diff@26  maxCh  old budget  over?
spirographs-dock       2711     1950    243        1500  YES  <- live latent flake
pong-dock                72       72    237        1500  no
spirographs-compact      25       10    120         150  no
```

So the tolerance was not absorbing renderer physics. It was absorbing **two
unpinned simulations**, one of which was already outside the budget it lived
under.

## The two fixes

* **spirographs** — has a `freeze` ParamDef, which buys intra-boot stillness
  only: `draw` returns before `const timeSec = frame.time`, so the freeze holds
  *whichever* frame the harness caught, and every centre is
  `advanceCenter(base, r, W, H, timeSec)`. Fixed with
  `simPin: __videoEngineFreezeTime = 1.0` — INWARDS' half of the split, since
  `resolveSpiros` rebuilds `base` from constants each call (no ping-pong FBO, no
  accumulator, no RNG). The ParamDef stays: it is in `params`, hence in the
  attest basis and contract-lock.
* **pong** — DOES declare a `freeze` param (correcting the working assumption at
  the start of the task; the write does not land on an undeclared key). Its
  `simPin` pinned only the serve RNG; the court accumulates one step per
  scheduler tick, so the frame depends on how many ticks ran before the suspend.
  Fixed the lushgarden way: under `__pongVrtSeed` the factory steps 48 ticks at
  construction and then stops ticking — time-invariant, not frozen.

## The doctrine that pointed the wrong way

`_shell-faces.ts`'s 4plexvid note said a `freeze` ParamDef was *"the template"*
and *"Do NOT reach for `simPin`"* — and it named **spirographs** as that
template, the module the measurement caught at 2711 px *with* its freeze param.
Corrected in the same diff, keeping the durable half (a `freeze` ParamDef costs
an owner-machine re-attest and a contract re-pin because `params` is in the
attest basis; `simPin` costs neither, because e2e files are excluded from the
attest hash).

## Local verification (darwin), and one honest caveat

Both scenes, both tiers, after the fixes: `diff@1=0`, DETERMINISTIC, controls
green.

The instrument was then checked in both directions on the same machine:

* pong-dock with the court pin REMOVED (seed still pinned) read **0 px locally**
  — this machine happened to land the same tick count twice, so the local probe
  is not a sensitive instrument for that defect here. The CI row (72 px) is.
* pong-dock with the SEED removed as well read **72 px, maxDelta 237, box
  14×15** — the same signature as the CI row, which is what proves the probe can
  see this defect at all rather than being blind to pong.

## What zeroing the tolerance actually found (2026-08-26)

Boot-vs-baseline at zero is a *different question* from boot-vs-boot, and it found
things the determinism probe could not. `vrt-strict` on `d3c8ac849`: **21 failing
scenes**, of which 3 are this PR's own sim pins. Re-running the same shards on the
same SHA: **19 reproduce with byte-identical pixel counts, 2 do not** —
`face-matrixMix-compact` (541 px → passed) and `face-mirrorpool-compact` (335 →
339 px). Both were reported BIT-EXACT by the two-boot probe: two boots in one
browser session cannot see a 1-in-N instability.

### outlines — a preview that had STOPPED DRAWING (fixed, `dba15d09d`)

Two independent defects, both in the pinned path only:

1. `sim.setParams(liveSpawnParams())` ran **after** the `VRT_PIN_STEPS` warm-up.
   `OutlinesSim`'s constructor default is `rate: 0`; `mapRateIntervalMs(0)` is
   `null` (clock off), so `step()` zeroes `rateAccumMs` and nothing spawns. The
   module's `rate: 0.5` arrived too late, and every later frame ran at `dtMs = 0`,
   so the clock could never accumulate. Zero shapes, permanently.
2. The `freeze` early-return sat **before** the warm-up, so a freeze write landing
   before the first draw meant the warm-up never ran at all.

Verified: the preview now draws the same three shapes the committed **compact**
baseline carries, 814 px identically on 3 consecutive local runs.

⚠ **`face-outlines-dock`'s baseline is the broken one.** It was re-captured at
`740bac121` DURING the broken window and is an all-black preview that has been
passing ever since. The compact baseline survived only because its comparison
PASSED and `--update-snapshots` cannot rewrite a passing-but-stale baseline. This
is the concrete precedent for "never re-capture a regression away" — it already
happened once, and the tolerance is why nobody could tell.

### the "box glyph" — NOT tofu

Three faces shared a byte-identical 42×9 signature, first read as a tofu box.
Checked instead of assumed: fonts are pinned and loaded (`document.fonts.status
= "loaded"`, `check(…, '▶')` true), and there is **no text at that position** —
no `.flow` element exists. It is the module's audio **output jack**
(`.jk.out`, `--cable-audio`), hollow by the output convention and ~5 device px
because a lane tile is captured at zoom 0.45. `railFit`'s own arithmetic
reproduces it from measured values: railW 190 − pad 20 − (pill 68 + gap 5) =
budget 97; `railDotsW(5)` = 80 ≤ 97 so all five dots render; leftover 12 <
`RAIL_FLOW_MIN_W` 32 so the flow label drops. The current render shows MORE than
the baseline did. Trigger: `740bac121` again — the same commit that narrowed
moog912's faceplate.

⚠ Worth gating (reported, not built): `railFit` is a width-dependent branch with
no coverage at the tile's real zoom, so a layout change anywhere silently changes
which ports the rail shows.

## Known consequence, deliberately not solved

At `threshold: 0` a local macOS VRT run fails on last-significant-bit text
shimmer — measured `dx7-dock` 17 px, `mirrorpool-compact` 8 px,
`moog903a-compact` 4 px, `scaler-compact` 4 px, all maxDelta 1-2, all 0 at the
old 26/255, none reproducing on linux. Linux CI is and always was the authority.
No platform carve-out was added; `task vrt:docker` is the local loop.
