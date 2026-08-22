// scripts/vrt-capture-timeout.test.ts
//
// THE VRT CAPTURE'S `timeout-minutes` MUST OUTGROW ITS OWN POPULATION.
//
// ⚠ THE FAILURE MODE IS INVISIBLE, WHICH IS THE WHOLE REASON THIS FILE EXISTS.
// GitHub reports a `timeout-minutes` kill as **`cancelled`, not `failure`** —
// `vrt-update.yml` says so in its own comment — so a capture that ran out of
// budget looks exactly like somebody pressing cancel. It has now happened
// twice on one branch (batch-22 G3, 2026-08-22, both runs killed at exactly
// 75 min) and once before that (#2108's predecessor at 40 min, run
// 31450544563, killed at test 241 of 297 having written ~146 baselines it
// never got to commit).
//
// ── WHY A GATE RATHER THAN A BIGGER NUMBER ──────────────────────────────────
//
// This is the THIRD occurrence of one class: a fixed budget outgrown by the
// faceplate programme's steady addition of scenes. #2039 bumped the vrt-strict
// shard count, #2103 refreshed its cost artifact and split 6 -> 8, and both
// recorded the same conclusion — *adding capacity is what you do when the
// population outgrows the split; it is not a remedy for a budget that does not
// know the population.* The `ci.yml` matrix comment states the trigger
// explicitly: if it recurs a third time, automate rather than bump.
//
// So the literal is raised here AND made self-checking. The number in the YAML
// is still a literal (GitHub cannot compute `timeout-minutes` from a discovery
// step that has not run yet), but it can no longer go quietly stale: this test
// derives what the capture NEEDS from the committed baselines and reddens in a
// fast unit lane, minutes after a face lands, instead of an hour into a capture
// that dies without evidence.
//
// ── THE DERIVATION, AND WHERE EACH NUMBER COMES FROM ────────────────────────
//
//   population   COUNTED off `e2e/vrt/__screenshots__/**/*.png`, never typed.
//                Each capture scene writes a baseline, so the committed set is
//                the population's own artifact — 467 on this branch when this
//                was written, against 468 tests observed in the run that died,
//                i.e. the proxy is accurate to ~0.2 %. The figure is
//                illustrative only: the gate re-counts on every run, so it does
//                not go stale the way a written-down total would.
//
//   SECONDS_PER_TEST  MEASURED, not padded, and inherited rather than invented:
//                `vrt-update.yml`'s own 40 -> 75 derivation clocked 241 tests in
//                36.8 min of Playwright = 9.2 s/test. That is the only rate
//                measurement this repo has for this lane, so it is the one used.
//
//   SETUP_MINUTES     checkout + npm + DSP restore, ~3.5 min in that same note.
//
//   HEADROOM          1.5x, which is not a new policy: the 40 -> 75 bump chose
//                     "75 leaves ~50 % headroom for a slow runner" over a
//                     computed 49 min. Keeping the same factor keeps this gate
//                     honest to the decision it is protecting rather than
//                     quietly tightening it.
//
// ⚠ A POLICY THRESHOLD ON A DERIVED MEASUREMENT IS NOT A HAND-TYPED POPULATION
// COUNT. The population is read off the artifact; only the RATE and the
// HEADROOM are constants, and both carry their measurement here.
//
// ── WHAT THIS GATE CANNOT SEE ───────────────────────────────────────────────
//
//   * It assumes one baseline per scene. A scene that writes none (an exempt
//     face) or two would skew the proxy; the ~0.2 % agreement above is the
//     evidence that this is currently true, not a guarantee that it stays true.
//   * It cannot see a RATE change. If scenes get slower per-test — a heavier
//     module, a slower runner image — the population can be flat while the
//     capture still overruns. The rate constant would need re-measuring from a
//     real run, and this file names where that measurement comes from so the
//     next person knows what to re-derive rather than what to bump.
//   * It says nothing about a SCOPED capture (`GREP=...`), which renders a
//     subset and is the reason the batch-22 G3 blockage was unblocked at all.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { globSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = join(ROOT, '.github/workflows/vrt-update.yml');

/** Measured in vrt-update.yml's own 40 -> 75 derivation: 241 tests / 36.8 min. */
const SECONDS_PER_TEST = 9.2;
/** checkout + npm + DSP restore, from that same note. */
const SETUP_MINUTES = 3.5;
/** The factor the 40 -> 75 bump chose ("~50 % headroom for a slow runner"). */
const HEADROOM = 1.5;

/** The capture's population, COUNTED off the committed baselines. */
function baselineCount(): number {
  return globSync('e2e/vrt/__screenshots__/**/*.png', { cwd: ROOT }).length;
}

/** The `timeout-minutes` of the capture job, parsed out of the workflow. */
function captureTimeoutMinutes(): number {
  const src = readFileSync(WORKFLOW, 'utf8');
  // The FIRST `timeout-minutes:` in the file belongs to the capture job; the
  // later one is the small `revalidate` job. Anchored to the capture by taking
  // the first match, and asserted non-null so a restructure fails loudly rather
  // than silently reading the wrong job's ceiling.
  const m = /^\s*timeout-minutes:\s*(\d+)\s*$/m.exec(src);
  expect(m, 'no timeout-minutes found in vrt-update.yml — this gate is reading nothing').not.toBeNull();
  return Number(m![1]);
}

function requiredMinutes(population: number): number {
  return ((population * SECONDS_PER_TEST) / 60 + SETUP_MINUTES) * HEADROOM;
}

describe('#2108 — the VRT capture budget knows its own population', () => {
  it('has a population and a ceiling to compare (vacuity control)', () => {
    // Two absence checks would otherwise look identical to a pass: an empty
    // glob and an unparsed YAML both make the comparison trivially true.
    expect(baselineCount(), 'committed VRT baselines found').toBeGreaterThan(100);
    expect(captureTimeoutMinutes(), 'capture timeout-minutes parsed').toBeGreaterThan(0);
  });

  it('timeout-minutes covers the committed population at the measured rate', () => {
    const population = baselineCount();
    const need = requiredMinutes(population);
    const have = captureTimeoutMinutes();
    expect(
      have,
      `the VRT capture has ${population} baselines to render. At the measured ${SECONDS_PER_TEST}s/test `
        + `plus ${SETUP_MINUTES} min of setup, that is ${(need / HEADROOM).toFixed(1)} min of work and `
        + `${need.toFixed(1)} min with the ${HEADROOM}x headroom the 40->75 bump chose — but `
        + `timeout-minutes is ${have}. RAISE IT, or scope captures with GREP=<module>. ⚠ A capture `
        + 'killed by timeout-minutes reports as CANCELLED, not failure, and writes no baselines it '
        + 'did not already commit — which is why this is caught here rather than an hour into a run.',
    ).toBeGreaterThanOrEqual(need);
  });

  // ── The instrument's own negative control ────────────────────────────────
  it('the predicate REJECTS a ceiling that is too small', () => {
    // Without this, a formula that always returned 0 would look identical to a
    // healthy margin. Drive it with a population that must exceed any sane
    // ceiling, and with one that must not.
    expect(requiredMinutes(10_000)).toBeGreaterThan(1_000);
    expect(requiredMinutes(1)).toBeLessThan(10);
    // …and the real pair must actually have margin, not merely satisfy `>=`.
    const slack = captureTimeoutMinutes() - requiredMinutes(baselineCount());
    expect(
      slack,
      `only ${slack.toFixed(1)} min of slack above the derived need — the next face batch eats it`,
    ).toBeGreaterThan(0);
  });
});
