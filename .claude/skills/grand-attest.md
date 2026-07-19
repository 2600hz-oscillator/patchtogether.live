# Running the GRAND-INTEGRATION attestation (`task grand:attest`)

The grand attest is a **local, real-GPU + real-H.264** gate — the third sibling of
`webgl:attest` and `collab:attest`. It runs the FULL workflow-mode
grand-integration scenario (kick·snare·tidy-mono·sixstrum through the clip player,
automation recorded + played back, the combined master through synesthesia, a
capability-gated recorderbox capture), hashes the scenario's **audio-defining
substance** (the four instrument DSP cores + sub-libs, the pure clip step math,
the shared clip fixture, the offline ART + driver, toolchain pins), REGENERATES
the offline combined-master ART baseline, and writes `ci-grand-attest/<hash>.json`.
**CI runs only the cheap VERIFY** (`grand:attest:verify`, no GPU/DB/LFS) — it
confirms the committed json's hash matches the current basis.

Design + rationale: `.myrobots/plans/grand-integration-e2e-art-2026-07-19.md` +
`ci-grand-attest/README.md`.

You re-attest whenever you change a basis file — one of the four DSP cores
(`packages/dsp/src/lib/{kickdrum,snaredrum,tidy-vco,sixstrum}-dsp.ts` + their
sub-libs), the clip step math (`clip-types.ts`/`clip-clock.ts`), the shared
fixture (`e2e/fixtures/grand-integration/clips.ts`), the offline ART
(`art/scenarios/grand-integration/…`), the driver (`art/setup/clip-driver.ts`),
or a toolchain pin. `flox activate -- task grand:attest:check` tells you if a
re-attest is needed; `-- --list` prints the full basis.

## RULE 1 — a real GPU + a real H.264 encoder are REQUIRED

The scenario drives synesthesia (WebGL — the runner refuses SwiftShader and
probes the real ANGLE renderer) AND recorderbox (H.264 — the spec's capability
gate must be TRUE; a SKIP means no encoder, and the runner REFUSES to write on any
skip). Run on a machine with both (a Mac with Metal + a hardware H.264 encoder is
the reference). CI has neither — that is exactly why this is a local attest.

## RULE 2 — run on an OTHERWISE-IDLE machine

The synesthesia (GPU) + recorderbox (encoder) + audio-graph path is
timing-sensitive. The runner's pre-flight REFUSES if a heavy GPU co-tenant (a
browser / native GL app) is burning CPU or the load is high — a co-tenant steals
GPU cycles and false-fails a timing-sensitive step. Quit heavy browsers/GL apps,
then re-run. Override on a dedicated/trusted runner only: `GRAND_ATTEST_ALLOW_BUSY=1`.

## RULE 3 — the audio is pinned by the OFFLINE ART, not recorderbox

`task grand:attest` regenerates `art/baselines/grand-integration/combined-master.f32`
+ `.sha` (the deterministic pin) and records the `.sha` in the attestation JSON.
The recorderbox capture is asserted LIVE (bytes not pinned — an encoder-dependent
bitstream can't be a `.sha` baseline). **Commit BOTH** the `ci-grand-attest/<hash>.json`
AND the regenerated `art/baselines/grand-integration/` files. Re-pin the ART `.sha`
LAST (memory `art-sha-pin-regenerate-last`); on a pure re-pin confirm only the
`.sha`/`.f32` under `grand-integration/` moved.

## RULE 4 — retries=0; a flake is root-caused, not re-run

The runner uses `retries=0` (a flake on a trusted quiet machine is exactly the
signal not to mask). `REPEAT=3 flox activate -- task grand:attest` is the pre-MR
3× flake-check. Diagnose a flake (run-bug vs test-bug); never just re-run.

## The flow

```sh
flox activate -- task grand:attest:check          # need a re-attest?
flox activate -- task grand:attest                # real-GPU run + regen ART + write json
# (REPEAT=3 flox activate -- task grand:attest     # the 3× flake-check)
git add ci-grand-attest/<hash>.json art/baselines/grand-integration/
git commit
```

`-- --dry-run` verifies the preflight/probe/run/writer wiring without the long run.

## Treadmill (like webgl/collab)

Re-attest is the LAST step after rebasing onto main: `git fetch origin && git
merge origin/main`, resolve, THEN `task grand:attest` so the pinned hash matches
the final content. The verify job starts **informational** (in the umbrella's
`needs:`+`env:` but not the failing `if`); the owner arms it required later.

## What does NOT need a re-attest

Editing the Playwright DRIVER spec (`e2e/tests/grand-integration.attest.spec.ts`),
the helpers (`e2e/tests/_grand-helpers.ts`), or the runner (`scripts/grand-attest*`)
is **hash-free** (platform rule: tests/runners don't change attest hashes). Only a
change to the audio-defining substance re-attests. (The offline ART `.test.ts` IS
in-basis because it defines the render.)
