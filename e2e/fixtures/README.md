# e2e/fixtures

Binary test fixtures consumed by Playwright specs, plus the `generate-*.mjs`
scripts that synthesize them (ffmpeg is not in this toolchain, so media is
recorded in headless Chromium via MediaRecorder — see each generator's header).

Every committed binary is REGENERABLE: it must have a checked-in generator (or,
for `lobby-clip.webm`, predate the rule and be documented where it is used).
Run the generator, commit the result, and state the size trade-off in the
generator header — `generate-lobby-clip-long.mjs` caps `videoBitsPerSecond`
explicitly for exactly this reason.

⚠ A fixture's DURATION is part of a spec's correctness budget, not a detail:
`lobby-clip.webm` is 4.004 s, which is SHORTER than some specs' own setup on a
loaded shard, and that gap produced the #1553 CI failures ("the clip simply
ended"). `collapse-keeps-playing.spec.ts` derives and ASSERTS its fixture
headroom against its own wait constants; do the same in any spec whose media
must outlive its waits, and prefer `lobby-clip-long.webm` (120 s) when in
doubt.
