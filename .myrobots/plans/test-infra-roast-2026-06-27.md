# Test-infrastructure adversarial review — 2026-06-27

_8 domain critics, 73 raw findings, synthesized + honesty-discounted._

> **This is an EVIDENCE doc. It is superseded as a description of CURRENT STATE
> — do not quote its numbers as today's. It is kept for the falsifiable
> mechanisms below, the still-unpaid items, and the honesty pass at the bottom.**
>
> Re-verified 2026-08-12:
>
> | finding | today |
> |---|---|
> | the ART Moog-batch stubs (the headline) | **FIXED.** Stubs deleted, md5-uniqueness guard added (**#940**); ART grew to real `.f32` baselines. **But the generator that produced them is unchanged — see below.** |
> | "MilkdropCard escapes the fail-closed WebGL basis" | **FIXED** — `packages/web/src/lib/video/webgl-attest-coverage.test.ts` exists and fails on any WebGL-rendering source outside the basis |
> | "the blocking VRT gate covers no faceplates" | **FIXED (#1483)** — `workflow-shell-faces.spec.ts` moved into `VRT_STRICT`'s testMatch (`ci.yml:2690` area). Before that, every `face-*` baseline was gated only by the informational `vrt` job, so no faceplate regression could block a merge |
> | "@collab never runs on PR" | **PARTLY FIXED** — a dedicated non-sharded `collab (@collab multi-context)` job now exists at `ci.yml:985` with a 40-min ceiling and a documented cost model. The sharded matrix still `--grep-invert "@collab\|@capacity\|BEHAVIORAL input coverage"` at `ci.yml:863` |
> | "retries=1 launders flakes" | **NOT FIXED** — still `retries: process.env.CI ? 1 : 0`, now at `e2e/playwright.config.ts:130`, with a "WHAT retries=1 STILL COSTS" comment at `:119` |
> | "555 waitForTimeout sleeps" | **NOT FIXED — WORSE.** **648** under `e2e/` today (555 at the roast, 639 at the 2026-08-04 triage) |
> | "STRICT_VRT_MODULES = 26 entries" | now **49** (`e2e/vrt/vrt-exemptions.ts:1050,1082`) |
> | "vrt-meta.test.ts:95 rubber-stamps darwin-only baselines" | **DEAD.** `e2e/vrt/vrt-meta.test.ts` no longer exists, and neither does the platform dimension — there is ONE baseline set, authored by linux CI |
>
> ⚠ The "heavy WebGL specs run in a serialized `e2e-video` lane" framing is
> **wrong as of #839**: that lane was deleted, so exclusion means no PR coverage
> at all.

## The falsifiable headline, and why it still matters

> VERIFIED: `art/setup/render.ts:66-68` returns `Math.sin(2π*440…)` **ignoring
> `opts.moduleName`**; 11 `.f32` baselines shared md5 `8313a1e783…` and 2 shared
> `fc3e2d8e…` (stub-vs-itself for moog902/904a/904b/911/921a/921b/921-vco/cp3 +
> pentemelodica + polyhelm + analog-vco).

**The guard exists; the generator does not.** #940 added md5-uniqueness and
deleted the collided baselines, but `render.ts:66-68` still returns a 440 Hz
sine regardless of the module asked for. The stubs cannot silently return in
that exact form, but nothing has replaced the thing that made them.

Two more archetypes from the same pass, both still instructive:

- *"resofilter reads cutoff=800 back as 800 (tautological)"* — the canonical
  shape of a readback assert that cannot fail.
- **`spawnPatch` writes edges DIRECTLY into the Yjs store**, bypassing
  `canConnect` / `engine.addEdge` (`e2e/tests/_helpers.ts`), *"so it can't even
  catch the engine-rejects-edge bug it claims to."* The per-port sweep's primary
  input coverage rests on this.

And one live contradiction: the WebGL attest README claims `retries=0 to surface
flakes honestly`, but `task webgl:attest` runs `retries=1 / MAX_FLAKY=1` and
writes the attestation after a flaky recovery.

## STILL OPEN

**Highest-value unpaid item in this file — narrow `filterErrors()`.**
`e2e/tests/per-module-per-port.spec.ts:927` still reads
`&& !e.includes('Failed to load resource')`. That string is precisely what a
404'd worklet/shader/sample emits — the most common way a DSP/GL module ships
silent or dead. **~73 specs whose entire safety net is `errors.toEqual([])`
cannot see a dead worklet.** Narrow the filter to specific known-noise URLs (the
optional DOOM WAD) and stop swallowing the blanket string.

Also open:

- **Surface CI retry counts as a first-class signal** — fail the run (or alert)
  when any test passes only on retry.
- **Replace `waitForTimeout`-before-assert with `expect.poll` on the real
  condition** (RMS / edge / render), and `networkidle` with a deterministic
  `__appReady` signal. This one is actively regressing: 555 → 639 → **648**.
- **The three large cross-cutting nets**, each tied to a *proven prod incident*
  and each worth a dedicated check before assuming it is still missing:
  (1) a committed prior-version Y.Doc snapshot fixture + load/round-trip test
  against real Hocuspocus+Postgres — #566 and #812 were silent data loss;
  (2) a heap-budget soak lane asserting no synced ydoc writes during pure
  modulation frames + bounded `usedJSHeapSize` / edge-SVG count — the TOYBOX
  leak (#719) was **+140 MB/min, found in PROD**;
  (3) stored-XSS tests threading hostile labels/patches/URLs through the real
  A→peer collab path, plus a CSP-presence assert — a multiplayer app where peers
  render each other's content had zero sanitization test.
- **Extract per-sample worklet math into pure lib cores** (the
  adsr-env / moog-ladder pattern) and unit-test the numeric behaviour. Partly
  served by the ART backfill campaign. ⚠ The original proposal's second half —
  *"track worklet-entries-with-a-core-test (22/70) as a ratcheting metric"* — is
  a **dead proposal**: hand-typed population counts are banned repo-wide. Assert
  a property, not a count.

## Discounted (mean-but-not-true — the honesty pass)

This section pre-rejects eight plausible-sounding findings. It is the part of
this file most likely to save a future agent a wasted session.

- **'preflightSolo lists Spotify / misses Blender'** — a cheap shot. The denylist only affects whether the owner's local run starts; it has zero bearing on attestation validity. Low priority.
- **'vitest single-fork forfeits multi-core speedup / order-coupling risk'** — speculative (the roaster's own confidence). `singleFork` is plausibly a deliberate determinism choice for shared registry singletons; not a real pain point today.
- **'EXPECTED_NODE_TYPES has 85 blank lines of cruft' / 'EXPECTED_HEAVY_SPEC_COUNT changelog archaeology'** — the cosmetic framing is overblown; the lists DO catch accidental drops/de-registration, just redundantly. Minor maintenance, not a coverage hole.
- **'Zero accessibility coverage / data-testid monoculture'** — true but a11y is a known queued deep-dive, not a core correctness/regression risk; the severity framing inflates it relative to the silent-DSP and silent-multiplayer holes.
- **'Certifies Apple M5 — the narrowest possible renderer slice'** — partially overstated: an M5 is still a REAL GPU, which is the entire stated point vs CI's SwiftShader. The fair, narrower point (doesn't cover D3D11/Vulkan, so document the scope) survives; 'narrowest possible' does not.
- **'Pyramid inversion: the bulk of CI wall-time is wasted on unit-testable facts'** — directionally right but overstated; integrated e2e of the gesture→mutate→sync→engine chain has genuine value the unit layer can't replace. Treat as a rebalancing goal, not waste.
- **'resofilter's tautological cutoff readback' and 'cube two configs share an md5'** — valid but single-spec, low blast-radius; subsumed by the broader 'add real output reads / md5-uniqueness guard' actions.
- **'compareBuffers tier C perceptual is a permanent stub'** — real but it's an unbuilt aspirational feature, not active false confidence; exact-RMS churn is a nuisance, not a correctness hole. Bundle into the ART real-render work.
