# Audio instruments that were wrong before the module was

Validate the instrument before indicting the module. Each entry below is a way
an audio probe returned a confident wrong answer in this repository.

## A filter applied before the check redefines the check's subject

The gate written to stop a sixth module defeating its mono normal detected
normals with one regex matching one spelling on one line: it found 7 of 13 and
reported "0 violations" — true about the 54 % it could see. Its negative
controls only ever fed it the shape it already matched.
`packages/web/src/lib/audio/mono-normal-scan.ts` is the fix, and the load-bearing
half is `auditCoverage`: every fallback expression in the tree that COULD be a
normal must be classified, so an unanticipated spelling reddens instead of
silently shrinking the population. Same failure as an opt-in filename list or an
`if (!p.edge) continue`. Ask what fraction of the population your matcher can
see, and prove it rather than asserting it.

## A metric can be blind to the dimension under test

- Broadband RMS is blind to a notch's width, to a sign flip, and to a DC offset
  larger than the signal; per-channel RMS is invariant to L/R correlation
  (mid/side is the stereo instrument); a mono-sum meter is blind to anti-phase.
- A probe placed at the filter's corner frequency is blind to a parameter that
  only shapes the skirt.
- A peak-find returns a partial when partials are louder than the fundamental.
- A relative assertion (this output vs itself) cannot see an absolute failure —
  two sibling sweeps being byte-identical, or a level 18 dB wrong.
- A coarse RMS bucket reports a transition's LEVEL, not its EDGE; read the first
  non-zero sample when the claim is about timing.
- A rising-edge counter cannot see a signal that starts HIGH, and a trigger line
  pinned high by `max(inTrig, strike)` can never present an edge at all.

## Drive the layer the user hears

- ART pinned a pure-TS envelope while the module ran the Faust one: the lane was
  green about a synth nobody plays, and its own end-of-release assertion was
  FALSE of the shipped module. `art/scenarios/adsr/profile.test.ts` now renders
  the committed `dist` bytes via `renderFaustOffline` and pins the `.dsp` source
  alone.
- A factory that gates on `livePatch.edges` makes every offline probe read live
  controls as dead.
- Main-thread `setTimeout` schedulers do not advance under `OfflineAudioContext`,
  so an offline render of a sequenced module measures silence, not the module.
- Headless Chromium's null audio sink cannot exhibit an output-buffer underrun.
  Read `packages/web/src/lib/audio/playback-stats.ts` and `worklet-guard.ts`
  (underrun counter, processorerror latch, tick-latency histogram) instead of
  inferring contention from elapsed time.
- On a symmetric multi-channel module, a probe that feeds one channel measures
  the patch, not the module.

## Controls

- A passing negative control proves the probe can move, not that it measures the
  right thing (AGENTS.md boundary 4). Prefer a positive control: reintroduce the
  defect and confirm red.
- Run both legs on every execution rather than once at authoring time, so the
  control cannot rot — `e2e/tests/stereo-mono-normal.spec.ts` and
  `art/scenarios/stereo-dual-mono/` both do this.
- A readout that cannot be honest is omitted, not estimated: never print a
  figure the DSP does not produce (amplitude modulation is not pitch; a take
  that stored no rate cannot report one).
