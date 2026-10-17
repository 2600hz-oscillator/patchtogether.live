# Beads firmware port

The DSP and lookup tables are unmodified source by **Émilie Gillet**, from
[pichenettes/eurorack](https://github.com/pichenettes/eurorack/tree/f4cfa7697095a28d292bff758beb51deb49b5a86/beads)
commit `f4cfa7697095a28d292bff758beb51deb49b5a86` (October 2026 release).
Its stmlib gitlink is
[`e3bd7c9cc00e4364166f9905c0509b6ffd0535ec`](https://github.com/pichenettes/stmlib/tree/e3bd7c9cc00e4364166f9905c0509b6ffd0535ec).
Only the C++ dependency closure is vendored; upstream file headers retain the
MIT notices. `upstream-sha256.json` pins every vendored byte, including the
upstream README and derivative naming guidance. The faceplate credits Émilie.
The owner requested the Beads module name; this is a software port, not an
original Mutable Instruments product.

`flox activate -- task dsp:build` invokes `scripts/build-beads.mjs` through the
normal DSP build. Flox supplies Emscripten. No network fetch happens at build
time. The native sources live under `src/` so the existing local and CI DSP
cache keys invalidate when they change. The per-module fingerprint also includes
the compiled WASM and shared parameter contract. No generated binary is committed.

`bridge.cc` hosts the original Processor and Synth in separate state with separate
reverb buffers. A new WASM instance per module isolates memory and the upstream
global random generator. The original 12-sample processing quantum and native
48/32/24 kHz quality clocks are retained. For unequal host rates a 48-tap,
256-phase windowed-sinc converter filters in both directions; equal rates take a
sample-preserving path with one 12-sample block of latency. The callback does not
allocate. TEST selects the upstream portable stmlib arithmetic; its voice-steal
printf is discarded by a linker wrapper, without editing upstream source.

Browser adaptations:

- Auto selects Synth immediately when neither audio input has a cable. It uses
  cable presence, including a silent cable, instead of the hardware normalization
  detector and its ten-second timer. Audio and Wavetable are also explicit modes.
- The right input normals to the left only when unpatched. No liveness source is
  connected to either input. Mono buffer layout is an explicit switch.
- Freeze is a held level, ORed with its gate. Seed exposes External, Hold and Latch
  states. Gate edges are extracted per sample in the audio processor. The
  hardware ADC compensation delay is not needed.
- The four attenurandomizers retain the original distributions and CV behavior.
  A separate pitch jack adds ordinary V/oct, while pitch_cv feeds the original
  pitch attenurandomizer. Three individual mix CV jacks replace the assignable
  hardware mix input.
- Hardware gain control/calibration, nonvolatile recording backup, button-press
  gestures and the optional right-jack gate-output mode are not emulated.
  The two audio outputs always remain stereo. Original DSP gain laws, quality
  transitions and limiters are retained.

`src/beads.test.ts` runs the shipping worklet and compiled WASM, not a DSP mirror.
It compiles an isolated temporary WASM fixture with the shipping builder, so a
clean unit-test checkout does not depend on prebuilt dist files. It covers
source-byte integrity, dry/wet pitch across sample rates, anti-aliasing, silent versus absent inputs,
stereo separation, wet grains, freeze release, seed pulses/levels and control
sensitivity. Browser tests additionally exercise the real factory and cables,
which those native tests cannot see. VRT checks appearance, not audio correctness;
its baselines are authored only by Linux CI.
