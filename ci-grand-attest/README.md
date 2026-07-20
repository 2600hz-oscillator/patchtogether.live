# `ci-grand-attest/` — GRAND-INTEGRATION local-GPU attestations ("semaphore")

This folder holds **owner self-attestations** that the full workflow-mode
GRAND-INTEGRATION scenario was run **on a trusted local GPU machine** for a given
scenario-content state. Each file is named by the deterministic **grand
content-hash** and is committed alongside the PR that changed the scenario. It is
the third sibling of `ci-webgl-attest/` and `ci-collab-attest/` — read those
folders' READMEs for the shared honor-system framing. Design +
rationale: `.myrobots/plans/grand-integration-e2e-art-2026-07-19.md`.

## Why this exists

The scenario (owner's ask) builds up, in **workflow mode**, kick(ch1) ·
snare(ch2) · **tidy-vco MONO(ch3)** · sixstrum(ch4), each with notes in multiple
clips and playing; automation recorded + played back; the combined master also
through **synesthesia**; and a **recorderbox** capture of the combined stream. It
drives **TWO CI-hostile workloads at once**:

- **synesthesia is WebGL** — CI's SwiftShader software renderer can't fairly
  render it (the webgl-attest class), and
- **recorderbox needs a real H.264 encoder** — CI has no OS/hardware encoder and
  the software one lies (`VideoEncoder.isConfigSupported` returns true but emits
  zero chunks — recorderbox #687).

So the heavy scenario **never runs on CI**. Locally, on a trusted GPU machine, it
runs for real: real synesthesia band reaction, real recorderbox capture, the real
clip-player scheduler + real automation, per-instrument RMS via the master
mixer's post-fader taps. `task grand:attest` runs it, and CI verifies a cheap
content-hash of the committed attestation:

- **match** → the scenario substance is unchanged-or-attested → CI trusts the
  local heavy run. PASS.
- **no match** → the scenario substance changed without re-attesting on a real
  GPU → FAIL (once armed) with `run: flox activate -- task grand:attest`.

## What pins the audio — the OFFLINE ART, not recorderbox

The **deterministic audio pin** is the offline combined-master ART
(`art/scenarios/grand-integration/combined-master.test.ts` →
`art/baselines/grand-integration/combined-master.f32` + `.sha`), which runs on the
**normal CI ART lane** (no GPU, no encoder, bit-stable). It replays the SAME
shared clip fixture through the four instruments' pure-TS DSP cores + the pure
clip step math and sums them offline. Recorderbox's H.264/AAC (and even a raw-PCM
real-time capture) is encoder-/jitter-dependent and cannot be a `.sha` baseline —
so the real recorderbox capture is asserted **live** (capability-gated) in the
heavy attest but its **bytes are not pinned**. The attestation JSON records the
offline ART's `combinedMasterSha`, and the CI verify cross-checks it against the
committed baseline.

## What is HONEST about this (read before trusting it)

The **one robust property** is: *editing a hashed scenario-substance file forces
a re-attest or CI notices* — it removes the "I changed a DSP core / the fixture /
the driver and forgot to re-run the heavy scenario on a real GPU"
accidental-staleness failure mode for in-basis files.

It is **NOT anti-forgery and NOT a security control.** Every field in the JSON is
hand-writable. Acceptable **because the repo is contribution-locked to the owner**
(owner-only merge; fork-PR Actions require owner approval) → owner
self-attestation = single-trusted-actor model.

## The content-hash basis

Computed by `scripts/grand-attest-hash.sh` (→ `scripts/grand-attest-lib.ts`) over
the scenario's **audio-defining substance only** — NOT `git HEAD`, so it survives
squash-merge / rebase / amend:

- The four instrument DSP cores + every sub-lib their per-sample math flows
  through (`packages/dsp/src/lib/{kickdrum,snaredrum,snare-roll,tidy-vco,sixstrum,
  sixstrum-tuning,karplus,analog-delay-core,adsr-env,moog-vco,dsp-utils,oversample,
  rbj-biquad}-dsp.ts`) — the UNION of the four ART profiles' `.sha` pins.
- The **pure clip step math** (`clip-types.ts`, `clip-clock.ts`) — the
  offline↔browser fidelity anchor.
- The **shared clip fixture** (`e2e/fixtures/grand-integration/clips.ts` — seeds
  BOTH the browser spec and the offline ART) + the offline ART scenario + the
  pure clip driver (`art/setup/clip-driver.ts`).
- Toolchain pins: `e2e/package.json` (NARROWED to `@playwright/test` — the
  browser/H.264 engine) + `.flox/env/manifest.toml` (Node/Chromium toolchain).

**Excluded** (per the platform rule "editing a test/runner must not change an
attest hash"): the Playwright DRIVER spec (`e2e/tests/**`) and the runner
(`scripts/**`). Editing the spec or runner is hash-free; a change to what the
scenario actually EXERCISES (cores/fixture/driver/step-math) is what forces a
re-attest. (Note: the offline ART `.test.ts` IS deliberately in-basis because it
DEFINES the render — it is not a driver spec.)

A fail-closed guard unit test
(`packages/web/src/lib/audio/modules/grand-attest-basis.test.ts`, in the required
`unit` job) asserts the basis resolves to a non-trivial set, excludes the driver
spec + runner, narrows the package.json pin, and that the heavy spec still carries
the `@grand-attest` tag the runner greps — so the basis can't silently rot.

## How to (re-)attest (trusted GPU machine, otherwise idle)

```sh
flox activate -- task grand:attest:check    # do I even need to re-attest?
flox activate -- task grand:attest          # real-GPU run; regenerates the offline
                                            # ART baseline + writes <hash>.json
git add ci-grand-attest/<hash>.json art/baselines/grand-integration/ && git commit
```

The runner refuses SwiftShader / a busy machine (GPU co-tenants steal cycles from
the timing-sensitive synesthesia/recorderbox path — override on a dedicated runner
with `GRAND_ATTEST_ALLOW_BUSY=1`), runs the `@grand-attest` spec at `retries=0`,
and **refuses to write** unless every test genuinely passed (a skip means a
capability gate — e.g. H.264 — was FALSE, which must not happen on a trusted
machine). `REPEAT=3` for the pre-MR flake-check. `-- --dry-run` verifies the
wiring without the long run.

## Retention: prune-to-1

The runner prunes superseded `<hash>.json` files (webgl-style) — CI only ever
verifies the ONE hash the current basis computes to, and git retains full history.
The combined audio's own history travels via the ART baseline in git.

## Do NOT hand-edit these files

They are machine-written. Hand-editing defeats even the accidental-staleness
property. The only file that MUST exist for the verify job to stay green is the one
matching main's current grand content-hash.

## Migration / retirement

Retire this scheme the day a hosted real-GPU + H.264 CI runner exists (then run
the heavy scenario directly on CI, delete the `grand-attest` job,
`scripts/grand-attest*`, the `grand:attest*` Taskfile targets, and this folder —
one cleanup PR). The offline combined-master ART stays regardless (it is the
deterministic audio pin).
