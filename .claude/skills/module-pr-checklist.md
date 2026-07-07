---
name: module-pr-checklist
description: Local test discipline for any PR that adds or modifies a module. Run the module's tests locally BEFORE pushing (unit, per-module e2e smoke, VRT, ART), the npm-ci + dsp:build + emit-manifest prerequisite, the mandatory _drivers.ts override for every gate/envelope-triggered AUDIO module, the package-lock rule, and read-CI-before-push.
---

# Module PR checklist (local test discipline)

When a PR adds or modifies a module, run that module's tests **locally
before pushing**. CI is a 15-20 min round-trip; locally it's seconds.
The user has explicitly asked for this discipline — don't push-then-check.

See also: `running-tests`, `module-development`, `testing-conventions`.

## Prerequisite: install + build the DSP first (fresh worktrees especially)

```sh
flox activate -- npm ci
flox activate -- task dsp:build
```

A fresh checkout or worktree has **no `packages/dsp/dist`**. Without it,
e2e gives false WASM-resolve failures (module cards `import '...?url'`
against `packages/dsp/dist/`, and the worklet bundles 404) that look like
module bugs but are just a missing build. Always `npm ci && task
dsp:build` before running e2e in a fresh tree.

The per-module e2e smoke also reads `e2e/.generated/registry-manifest.json`
to enumerate modules. `task test` (and the `task ci` chain) emit it;
standalone, run `flox activate -- task test:emit-manifest` so the spec
sees your new module's ports. A stale/missing manifest makes the spec
enrol or skip the wrong set of modules.

## Run the module's tests locally before pushing

Scope to your module — don't run the whole suite for fast feedback:

```sh
# Unit (def shape, param ranges, DSP math, CV-scale registry)
flox activate -- task test -- run <name>

# Per-module output-alive e2e smoke (spawn + emits-signal)
flox activate -- task e2e -- e2e/tests/per-module.spec.ts -g <modtype>

# Full per-module smoke (every module) when you touch shared test infra
# (_drivers.ts, _helpers.ts, _registry, the spec itself). Keep --workers
# LOW locally (2): high -workers spawns many headless Chromes that race
# cold Vite chunk fetches and produce contention flakes (and leak
# chrome-headless-shell + spike CPU) — that's machine load, not a defect.
flox activate -- task e2e -- e2e/tests/per-module.spec.ts --workers=2

# VRT — only if your module has a card baseline
flox activate -- task vrt -- --grep <modtype>

# ART — only if your module has a deterministic-DSP scenario
flox activate -- task art -- run <name>
```

Iterate until green locally. **Read the results** — don't push on a guess.

## REQUIRED for every gate/envelope-triggered AUDIO module: a `_drivers.ts` override

`e2e/tests/per-module.spec.ts` drives each module via `driverFor(mod)`
(`e2e/tests/_drivers.ts`). A module is enrolled for the audio-output-alive
check iff it has `hasAudioOutput` (an `audio`-typed output port), is not on
the spec's `SKIP_OUTPUT_ALIVE` list, and has no `audio`-typed INPUT (those
are processors/effects, auto-skipped). For an enrolled module the **default
driver wires only its first output into a scope — NO upstream sequencer.**

A gate/envelope-triggered voice (drum hit, 303, modal / plucked voice)
with **no override** therefore never gets its gate fired, so it's silent
and the output-alive smoke fails `peak=0` — or worse, *flakes*: fails
attempt 1, then "passes" on retry when timing noise nudges it over the
0.005 floor.

This is a **latent gap that compiles, type-checks, and passes every other
layer** — it only shows up (sometimes intermittently) in the per-module
e2e smoke. It bit TREE.oh.VOX (#446) and the since-retired chowkick (#462).

When adding a gate/pitch-triggered AUDIO module, add an OVERRIDES entry:

```ts
mymodule: {
  outputPort: 'audio_out',     // the AUDIO output to route into SCOPE.ch1
  gatePort:   'gate_in',       // input that opens the env / fires the
                               //   voice (a SEQUENCER gate is auto-wired)
  pitchPort:  'pitch_in',      // (if it needs a pitch to sound; SEQUENCER
                               //   pitch is auto-wired here)
  params: { cutoff: 2500, decay: 800 }, // seed knobs so a gated note
                               //   clears the 0.005 peak floor in the
                               //   ~800ms drive window
},
```

Use the module def's actual port `id`s (read its `inputs`/`outputs`).
Modules that **self-run** need **no** entry — don't add needless ones.
That includes oscillators at default tune, noise, a free-run LFO/drum
mode, and CV utilities whose output is alive at idle (e.g.
analogLogicMaths' `sum`/`min`/`max` emit immediately with no gate). Pure
**CV/gate sources** that report `hasAudioOutput=false` (self-clocked
MACSEQ / MARBLES / GRIDS, an LFO) are **not enrolled** by the audio-alive
check at all (CV/gate alive checks are a deferred slice). Audio-input
**effects** are auto-skipped. None of those need an override.

Adding the override is a **required step in adding a module**, same tier
as the 6 shared registry files in the `module-development` skill. After
adding it, run `task test:emit-manifest` then the scoped smoke to confirm.

## Never regenerate package-lock.json from scratch

If a dependency changes, run:

```sh
flox activate -- npm install --package-lock-only
```

Deleting and regenerating `package-lock.json` from scratch **drops the
platform-specific optional deps** (esbuild/rollup native binaries for the
OSes you didn't build on), which breaks CI on those platforms. Only ever
update it in place.

## Read CI results before pushing the next change

When a CI job fails: pull the specific failing test from the log,
reproduce it **locally** with a scoped target, fix, re-run scoped to
confirm green, then push. Don't ping-pong push-and-wait. Never label a
failure "flake" without root-causing it — and pair the fix with a
regression test (or a comment explaining why one can't exist).
