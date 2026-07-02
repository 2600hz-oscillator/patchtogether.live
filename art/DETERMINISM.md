# Determinism matrix — ART + E2E + VRT

What's pinned, where, and how to pin a new test's state to the same matrix. Updated as new determinism knobs land.

The bar: a test that depends on a value the matrix doesn't pin is FLAKE-PRONE. Either pin the value here (add a row to the matrix), or document why the test can tolerate the variance (e.g. "asserts peak > 0.005, not an exact sample").

---

## Pinned knobs

| Knob | Value | Where it's set | Consumed by | Notes |
|---|---|---|---|---|
| Sample rate | 48000 Hz | `art/setup/render.ts:15` (`SAMPLE_RATE`) | Every ART scenario | All offline renders use this. Browser AudioContext may use 44100/48000 depending on platform; specs that care about absolute timing assert in samples NOT seconds. |
| Audio epoch | `AudioContext.currentTime` at the moment the engine binds | (implicit — not yet overridable) | E2E pair-patch + per-module specs | Two runs in the same Playwright session see the same epoch; cross-session epochs differ. Specs that assert wall-time-aligned timing must avoid cross-session comparisons. |
| Sequencer steps | 4-note major chord (MIDI 60/64/67/72) | Convention: any patch with a node id `seq` gets seeded automatically in `e2e/tests/integration.spec.ts` and `per-module.spec.ts` | Cross-module integration + per-module output-alive | Override by setting node.data.steps in your spec's `await page.evaluate(...)` block AFTER `spawnPatch`. |
| Sequencer BPM | 240 (per-module driver), 120 (integration default) | `e2e/tests/_drivers.ts:171` (per-module), `e2e/tests/_pair-patches.ts` (integration) | Same | 240 BPM = ~63 ms per 16th, so a 1-second test window sees ~16 gate pings. |
| Random seed (per-module) | None pinned (specs accept variance via thresholds, not exact match) | n/a | per-module + integration | Modules that consume `Math.random` (noise, buggles, drummergirl noise OSC, hydrogen sample-trigger jitter, modtris/pong piece bag) produce non-deterministic absolute values. Assertions use thresholds (`peak > 0.005`), not equality. |
| Random seed (ART audio profiles) | `0xC0FFEE` (`PROFILE_NOISE_SEED`) | `art/setup/drivers.ts` (`seededNoise`, and passed to seedable cores, e.g. chowkick's `makeNoiseState`) | Every ART audio-profile scenario | Profile renders MUST be bit-identical run-to-run (they pin raw `.f32` baselines), so any RNG-based core is driven from an explicit xorshift32 seed — never `Math.random`. Driver phase/epoch are pinned to sample 0. |
| Chaos seed | `CHAOS_SEED` env var; per-run randomised when unset | `e2e/chaos/chaos.config.ts` | Chaos runner only | Out of scope for ART/E2E/VRT; chaos has its own deterministic-replay machinery. |
| Time freeze (rAF) | NOT yet implemented | (proposed in slice 3) | Will unlock VRT for `bentbox / pong / modtris / wavesculpt / cameraInput` | Adding a `__pauseRaf` dev hook + Cards opting into freeze-friendly render is its own slice. |

---

## Conventions tests should follow

### "Read at peak window, not exact sample"

Audio assertions in ART + E2E should target the RMS or peak of a measurement window, not a specific sample index. The 200-ms scheduler lookahead + AudioContext startup jitter makes single-sample assertions fragile across runs and platforms.

```ts
// Good — tolerant of timing jitter:
const sum = summarize(snap.ch1);
expect(sum.peak).toBeGreaterThan(0.005);

// Bad — depends on exact sample alignment:
expect(snap.ch1[480]).toBeCloseTo(0.123, 3);
```

ART-specific assertions can be tighter (offline render IS deterministic at the sample level for a fixed sample rate); E2E assertions never should be.

### "Seed the seq when needed"

Patches that include a `SEQUENCER` node and depend on it firing must seed at least one ON-step. The default sequencer state is "no steps on" — silent. Conventions:

- In `per-module.spec.ts` and `integration.spec.ts`: any node with id `seq` auto-gets 4 ON-steps seeded after spawnPatch. Override by writing your own steps after spawn.
- In bespoke specs: seed explicitly with `await page.evaluate(...)` writing to `__patch.nodes.seq.data.steps`.

### "Wait long enough for wavetable loads"

Modules with worklets that load tables / FLAC samples / WAV samples async (HYDROGEN, SAMSLOOP, MACROOSCILLATOR's WT models) need ≥800 ms after spawn for first audio. Use `await runFor(page, 800)` from `_module-coverage-helpers.ts`.

### "Don't compare audio peak across platforms"

Linux CI runs node-web-audio-api in chromium's SwiftShader environment; darwin local runs against real CoreAudio. Absolute audio amplitudes differ by 0.5-2 dB depending on the platform's output gain staging. Specs that compare audio cross-platform should use RATIOS (peak / baseline-peak), not absolute peaks.

---

## Adding a new determinism knob

When a test you write turns out to be flake-prone:

1. **Identify the source of variance**. Run the test 20 times locally with `task e2e -- --repeat-each=20 path/to/spec.spec.ts`. If it fails ≥1 time, pin the underlying knob.
2. **Pin it AT THE SOURCE**. Don't paper over with `expect.toBeCloseTo(.. , 0)` — fix the actual non-determinism.
3. **Add a row to the matrix above** with the new knob's value, location, and consumers.
4. **Document the convention** in "Conventions" if it's a new pattern (e.g. "always wait N ms after spawning X-type modules").

---

## Known sources of non-determinism (NOT yet pinned)

- **AudioContext start jitter** — first audio block emerges ~5-20 ms after context resumes. ART avoids this by using OfflineAudioContext (no start delay). E2E specs assert at thresholds, not exact times.
- **WebGL2 / Swiftshader pixel jitter** — different shader compilers emit slightly different output. VRT tolerances (20% per channel, 5% pixel ratio) absorb this.
- **Yjs transaction timestamps** — `ydoc.transact` uses `Date.now()` for the local clock. Tests that compare Yjs state across runs must mask or strip the timestamp.
- **Free-running animation canvases** (PONG, MODTRIS, BENTBOX, WAVESCULPT, CAMERA-INPUT) — listed in `e2e/vrt/vrt-exemptions.ts:EXEMPT_FROM_VRT`. Will be unlocked when the rAF-freeze hook lands (slice 3 of the test-coverage push).
- **MIDI device list** — varies across CI runners. HELM + MIDICLOCK + MIDI-CV-BUDDY specs mock the MIDIAccess API; cards depending on device state are EXEMPT_FROM_VRT until a deterministic stub lands.
