# Batch 7 handoff — what the batch-7 ship lane learned (2026-08-19)

Written for whoever picks up the faceplate queue next. Every figure here is
either MEASURED (stated with its method) or DERIVED-BY-READING (labelled). The
batch-6 rule holds and was earned again: **re-measure the load-bearing figures,
and treat every prescription as a hypothesis about a gate you have not run yet.**

## 1. What shipped

| module | PR | state |
|---|---|---|
| `moog984` | #1943 | **MERGED** |
| `treeohvox` | #1945 | **MERGED** (31 checks green on its final SHA `64c29e344`) |
| `b3ntb0x` | #1950 | **DRAFT, blocked on #1949** (VRT scene weight) |
| `bentbox` | — | **NOT STARTED** — see §6 |
| `moog905` (Q21 filler) | — | not reached |

Also handled at the end of the batch: **#1939 (`feat/outlines-face`)**, which both
merges re-conflicted. Its main-merge is complete, verified and green, parked on
**`chore/outlines-face-merged-tree`** (`e59b8cf31`) rather than pushed, because a
`vrt-update` capture was still in flight on that branch and a merge commit on
top of the tip it checked out risks the bot's baseline push being rejected. Full
completion recipe is a comment on #1939. Attest verified UNMOVED at `a37dbdda…`
on the merged tree, both before and after the treeohvox merge.

⚠ **#1952 (main red) is RETIRED** — the coordinator reports the class was
already root-caused as webgl-smoke's timeout-kill-reporting-as-CANCELLED
(#1854/#1917) and fixed by #1948 (timeout 10 → 20 min), now merged. My filing
was a duplicate; recorded here so nobody re-investigates it. ⚠ **It does NOT
retire #1949**, which is a different budget — `vrt.config.ts`'s per-TEST
`timeout: 90_000` in the capture workflow, not the job's `timeout-minutes`. The
distinction is written on #1949 so it is not closed as a duplicate.

Issues filed: **#1942** (moog984 face), **#1944** (treeohvox face), **#1946**
(b3ntb0x TBC defect), **#1947** (b3ntb0x dead sampler), **#1949** (the VRT
scene-weight blocker), plus a correcting comment on **#1940**.

## 2. ⚠ THE BATCH-6 FAILURE MODE FIRED AGAIN, EXACTLY AS DOCUMENTED

The generated inventory's count auto-merged **cleanly and wrongly** during the
`moog984 → treeohvox` rebase: both sides said `66`, the truth with both
promotions was `67`, and git took it without a conflict.

`task face:inventory:accept` caught it before the push. **The batch-6 rule is
correct and should be treated as mandatory, not advisory.** It has now fired
across two consecutive batches.

## 3. Three inherited PRESCRIPTIONS that were not expressible or not right

Same pattern as batch 6 — measurements survive, prescriptions do not.

1. **`face.paramCells: 'toggle'` (rolling index, finding #5) DOES NOT EXIST.**
   The declarable set is `'grid' | 'color' | 'fader'` (`graph/types.ts:802`,
   `DeclaredParamCell` adds only `'xy'`, which a module may not write).
   `'toggle'` is DERIVED from `looksLikeToggle`, which requires
   **`curve === 'discrete'`** — so the recommended free fix for the
   boolean-declared-linear defect is unavailable, and the real fix (`curve`) is
   the one that costs a re-attest. Do not plan around the free version.
2. **#1940's "they diverge as soon as `sync_crush ≠ 1` or `bias ≠ 0`" is half
   right.** The ripple gain is exactly `S·(1+2E)·(1+0.8d)` — **bias-independent**,
   with `sync_crush` only scaling it uniformly. The real divergence is in the
   NON-ripple terms (`bend_d` multiplies the bias term by `(1+0.8d)`;
   `enhance` touches it not at all). Full derivation and method in the #1940
   comment. The ×5.40 and the `1.6·d·E` cross term both reproduced exactly.
3. **The "b3ntb0x binds a sampler it never samples" claim is mis-scoped**, and
   acting on it as written would break the module. The BEND program samples
   `uEncode` four times and two of them are the `neighborAvg` everything else is
   built on. It is the **DECODE** program that binds and never reads (#1947).

## 4. Gates that bit, and are NOT in the faceplate skill's run list

Both were found by CI or by a dispatch, not by the documented loop. **Add them
to your local pass.**

- **`manual-strike-wiring.test.ts`** — a pinned inventory of every shell cell
  reaching the audition seam. Registry-driven off `shell-cells.ts`, so **any**
  face adding an ACTION cell auto-enrols. treeohvox's gate cell reddened the
  unit lane on CI.
- **`console-grid.test.ts`** — a pinned membership list of every band the
  console-grid rule claims, plus a single-console-band negative control. Any
  face declaring ≥2 equal-sized stacked clusters enrols. It found
  `moog984/crosspoints=4` by itself, which was the independent confirmation
  that the grid engaged.

Also worth knowing: **`module-face-lint` will refuse a newly switch-shaped
param** until you classify it momentary vs latching
(`ACKNOWLEDGED_LATCHING`) — so a `curve → discrete` fix always comes with a
second edit.

## 5. ⚠ THE OPEN BLOCKER: b3ntb0x's VRT scenes cost more than the cap (#1949)

This is the one thing standing between #1950 and merge, and it needs a decision
I deliberately did not make.

**Measured on linux capture dispatches, after fixing a genuine determinism bug:**

| scene | duration | outcome |
|---|---|---|
| `face-b3ntb0x-compact` | **55.6 s** | ✓ passes, snapshot written |
| `face-b3ntb0x-dock` | **~92 s** | ✘ over the 90 s cap, *after* writing its actual |

Local real-GPU: **20.1 s** for the pair.

**It converges** — both scenes write their actual — so `vrt.config.ts`'s
diagnosis for a >90 s scene ("not converging, which is a determinism finding")
does not fit, and its instruction not to raise the cap still binds. The compact
scene does not render the new dock body at all and still costs 55.6 s against
the population's own p90 of 19.6 s, so **the weight is the module's, not the
faceplate's**. Options are enumerated in #1949; option 3 (don't roster it) is
not available without also not promoting, because `vrt-meta` asserts roster ==
`STRICT_FACES` both directions.

### The determinism bug it was hiding, which IS fixed and is reusable

The first dispatch timed out on **both** scenes with zero baselines. Cause: the
module animates by construction and its only freeze seam was
`globalThis.__b3ntb0xFreezeTimeSec` — **a flag the face VRT harness never
sets**. `freezeFaceVideo` writes `params.freeze` through the Y.Doc. That is the
**#1941 shape** (a pin gated on a flag nothing sets), and the brief's "grep the
setters" instruction is exactly what found it.

> **For any future video face: check the module has a `freeze` PARAM, not just
> some freeze mechanism.** The shape is `spirographs` / `backdraft` /
> `grainsOfVision`: a `ParamDef` (0..1, default 0), `noUserControl` with
> `writer: 'internal'`, absent from `face.order`, and `if ((params.freeze ?? 0)
> >= 0.5) return;` at the top of `draw`. Pinning TIME alone is not enough where
> a persistence/feedback path feeds the previous frame back.

## 6. `bentbox` — NOT started, and what is already known

It is the sibling of b3ntb0x and the pair was specced together, but **they are a
FAMILY, not a superset pair**: the param-id intersection is exactly four, and of
bentbox's 12 bending knobs **zero** exist on b3ntb0x. So b3ntb0x's face is not a
template for it beyond the mechanics.

What transfers directly:

- the `fullViewBody` + SCREEN-toggle shape (copy `b3ntb0x/shell-extension.ts`
  and `B3ntb0xOutputBody.svelte`; `BentboxCard.svelte` carries the same four
  card-only affordances per #1896);
- the #1935 gate requirements;
- **the freeze-param check in §5 — do this FIRST**, before spending a dispatch;
- the attest-cost asymmetry: on a video def `face`/`docs`/`controlFamilies`/
  `noUserControl` are free, `params` is not.

## 7. Attest — REPORTED, not run (per the brief)

`feat/b3ntb0x-face` moves the WebGL basis hash. **Verified by measurement, in
three steps, rather than trusting the transparency doc:**

```
main                    95381b437d70879d586ce4ea490675b8c6f47da5e36489a4af41116228fb191f
+ mirror curve change   948575177a1d6f3a41f18b28349b89419e273120f5490ce9d4bf3ac24d9888bb
+ noUserControl         948575177a1d…9888bb   (UNCHANGED — transparent)
+ the whole face        948575177a1d…9888bb   (UNCHANGED — transparent)
+ freeze param + guard  cfd25bd0017f3f847bb886c1048cd6b8aa7f79ac10d5a0048a6624a8929dae7a
```

Two movers, both real code. The `curve` change is **pixel-neutral by
construction** (`if (uMirrorX > 0.5)` — every writable value already sat on the
same side). `moog984` and `treeohvox` are audio and cost NIL.

## 8. The spec bank does NOT need a refill wave

Counted off the artifact rather than estimated. `docs/design/face-migration.generated.md`
after this batch: `generic-face` is **141 total / 67 done**, so **74 buildable
modules remain** with no platform work — plus 3 `blocked` and 49
`bespoke-surface`. The constraint on the next batch is build throughput and the
owner decisions below, not spec supply.

## 9. Owner decisions outstanding (none of them invented here)

1. **#1949** — the b3ntb0x VRT scene-weight question. Blocks #1950.
2. **#1946** — b3ntb0x's TBC default makes its own documented headline gesture
   impossible. The face takes the surface-only option (no pixels moved); any of
   the other options changes what the module looks like.
3. **The tab-rail threshold.** b3ntb0x's honest page count is **6** against
   `DOCK_TAB_MIN_BANDS = 7`, with no page padded to reach it. The 2026-08-18
   ruling says a control-heavy module gets a tabbed face AND says not to pad —
   so the lever is the threshold, and moving it is a baseline-moving decision.
   **Raised, not settled.** This is the same shape as ruttetra's open question,
   and it is recorded as a question on purpose.
4. **`ruttetra` remains HELD** — untouched by this batch, as briefed. If you
   believe a ruling landed, you are wrong; ask the orchestrator.
