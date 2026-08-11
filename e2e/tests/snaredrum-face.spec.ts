// e2e/tests/snaredrum-face.spec.ts
//
// SNARE DRUM's CURATED FACE, driven for real under `?shell=1`. Three claims
// only a browser can settle, and none of them is "the DOM re-labelled itself":
//
//   1. THE HIT AUDITION MAKES SOUND. `snaredrum-hit` is a family cell with no
//      backing ParamDef, so every def-reading gate (contract-lock,
//      module-face-lint, module-docs-lint) is structurally blind to whether it
//      does anything at all — a dead button passes all three. This presses the
//      real cell and listens at a SCOPE tap on the module's own output, with
//      its OWN negative control: it first proves the tap reads SILENCE with
//      nothing patched into trigger_in. A silent-before / loud-after pair fails
//      on a dead button AND on a tap that was never measuring this module.
//
//   2. THE ROLL AUDITION SUSTAINS WHILE HELD **AND STOPS WHEN RELEASED**. This
//      is the headline capability of the module and the one thing a click-style
//      audition could not express. Both halves are asserted, and the SECOND is
//      the important one: a gate opened by a pad that never closes it is a drum
//      that rolls forever, in the audio graph, where nothing reverts it.
//
//   3. THE HARD SWITCH CHANGES THE GRAPH. faces-parity proves the cell is
//      operable; this proves the operation reaches `__patch` — the durable,
//      shared, undoable state — rather than only the pixel.
//
// AUDIO-AVAILABILITY: audio-only, no WebGL and no renderer tolerance needed.
//
// ⚠ THE OBSERVATION WINDOW IS A **POLL COUNT**, NOT A WALL-CLOCK BUDGET — the
// CLAUDE.md frame-count rule applied to the instrument that is actually
// renderer-dependent here. The AUDIO is genuinely wall-clock (an AudioContext
// advances on its own thread at a fixed sample rate) but the POLLS are not:
// each is a `page.evaluate` round-trip on the main thread, so "poll for 900 ms"
// is a different assertion on every machine. `?shell=1` mounts the video-zone
// defaults, software-rasterized on CI, on that same thread — so the render loop
// is paused outright (installRenderSmokeHooks: this spec asserts nothing about
// a rendered frame) and every window is expressed in POLLS with a wall-clock
// cap that only BOUNDS THE FAILURE.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { installRenderSmokeHooks } from './_render-smoke';
import { readScopeSnapshot, summarize } from './_module-coverage-helpers';

test.describe.configure({ mode: 'parallel' });

const SLOW_RENDER = process.env.E2E_SWIFTSHADER === '1' || !!process.env.CI;

/** Polls per observation window. The QUANTITY THE TEST IS ABOUT: each poll is
 *  one `readScopeSnapshot` and the scope's ring is ~200 ms, so 8 polls span the
 *  decay of a snare hit on any machine. */
const POLLS_PER_WINDOW = 8;
/** Wall-clock cap per window — a bound on the failure, never the gate. */
const WINDOW_CAP_MS = SLOW_RENDER ? 20_000 : 6_000;

/** A poll whose RMS clears this counts as "audio has started". Value-based, so
 *  it is renderer-independent by construction — the same 0.01 the existing
 *  `snaredrum-roll.spec.ts` real-chain poller uses. */
const START_FLOOR = 0.01;

interface Hold {
  /** Max-hold peak across the window (liveness — robust to a trough). */
  peak: number;
  /** Max-hold RMS. */
  rms: number;
  /** MIN RMS across the windows scored AFTER audio started (continuity). */
  minRms: number;
  /** Polls taken. */
  polls: number;
  /** Polls that counted toward `minRms` (i.e. after the first audible one). */
  scored: number;
}

/**
 * Poll the scope tap over exactly `POLLS_PER_WINDOW` polls (or until the cap),
 * optionally running `onTick` before each poll so an action lands INSIDE the
 * observed window. Returns the poll count so the caller can assert the window
 * was really observed rather than assuming it.
 *
 * ⚠ `minRms` IS ONLY ACCUMULATED ONCE AUDIO HAS STARTED, and that is not a
 * fudge — it is the difference between the two things the continuity assertion
 * must tell apart. The scope's analyser ring is ~200 ms, so the FIRST poll
 * after `mouse.down()` reads a ring still mostly full of PRE-ROLL SILENCE: a
 * STARTUP TRANSIENT, not a gap. Scoring it made the assertion a race against
 * how fast the main thread got from the pointer event to `openGate`, which is
 * exactly the quantity that differs between a real GPU and SwiftShader —
 * measured, as a 1-in-3 failure at `minRms = 0.00038` under
 * `E2E_SWIFTSHADER=1`. The `started` gate is a VALUE threshold, so it is
 * renderer-independent; `scored` is reported so "the roll never started" cannot
 * pass vacuously as "no gaps observed". Same discipline (and the same floor) as
 * the existing snaredrum-roll real-chain poller.
 */
async function hold(page: Page, scopeId: string, onTick?: (i: number) => Promise<void>): Promise<Hold> {
  const deadline = Date.now() + WINDOW_CAP_MS;
  let peak = 0;
  let rms = 0;
  let minRms = Infinity;
  let polls = 0;
  let scored = 0;
  let started = false;
  let i = 0;
  while (polls < POLLS_PER_WINDOW && Date.now() < deadline) {
    if (onTick) await onTick(i);
    const snap = await readScopeSnapshot(page, scopeId);
    if (snap) {
      const s = summarize(snap.ch1);
      if (s.peak > peak) peak = s.peak;
      if (s.rms > rms) rms = s.rms;
      if (s.rms > START_FLOOR) started = true;
      if (started) {
        if (s.rms < minRms) minRms = s.rms;
        scored++;
      }
      polls++;
    }
    i++;
    await page.waitForTimeout(60);
  }
  return { peak, rms, minRms: Number.isFinite(minRms) ? minRms : 0, polls, scored };
}

test('snaredrum face: the dock HIT and HOLD-TO-ROLL pads audition an UNPATCHED snare, and HARD writes the graph', async ({ page }) => {
  // ⚠ SIZED, NOT FLAT (ci-swiftshader-video-e2e-timeouts). Playwright's 30 s
  // default is the whole budget for a test whose topbar wait alone is allowed
  // 30 s, and faces-parity documents a 13.2 s cold `/rack` compile under
  // SwiftShader on this route. A failure bound only.
  test.setTimeout(SLOW_RENDER ? 150_000 : 75_000);

  await installRenderSmokeHooks(page);
  await page.goto('/rack');
  await expect(page.getByTestId('workflow-topbar')).toBeVisible({ timeout: 30_000 });
  await page.locator('.svelte-flow__pane:visible').first().waitFor({ state: 'visible' });

  // NOTHING is patched into trigger_in or gate_in — that is the whole point.
  // The only wire is the module's own output into a scope tap. WIRE is pushed
  // up so the roll's shared bed is well excited (the same setting the existing
  // real-chain roll spec uses).
  await spawnPatch(
    page,
    [
      { id: 'sd',  type: 'snaredrum', position: { x: 360, y: 60 },  domain: 'audio', params: { level: 0, wire: 0.85 } },
      { id: 'scp', type: 'scope',     position: { x: 820, y: 320 }, domain: 'audio', params: { timeMs: 200 } },
    ],
    [{ id: 'e1', from: { nodeId: 'sd', portId: 'audio_l' }, to: { nodeId: 'scp', portId: 'ch1' } }],
  );

  const shell = page.locator('.svelte-flow__node[data-id="sd"] [data-testid="module-shell"]');
  await expect(shell).toBeVisible();
  await shell.getByTestId('shell-open-dock').click();
  const faceplate = page.getByTestId('dock-full-view');
  await expect(faceplate).toBeVisible();

  // ── NEGATIVE CONTROL, in-test: an unpatched, un-struck snare is SILENT. If
  // this window were already loud, every "loud after" assertion below would
  // prove nothing about the pads. ──
  const silence = await hold(page, 'scp');
  expect(
    silence.polls,
    `the SCOPE tap was polled ${POLLS_PER_WINDOW}× during the silence window (units: POLLS, not ms)`,
  ).toBe(POLLS_PER_WINDOW);
  expect(silence.peak, 'an unpatched snare makes no sound until it is struck').toBeLessThan(0.01);

  // ── 1. THE HIT PAD. Strikes are COUNTED, not timed: a single strike whose
  // decay falls between two polls reads as a dead button, so strike on the
  // first poll and every third after it, then assert how many landed. ──
  const hitPad = faceplate.getByTestId('shell-cell-snaredrum-hit');
  await expect(hitPad, 'the HIT audition cell is a real enabled button').toBeEnabled();
  let hits = 0;
  const struck = await hold(page, 'scp', async (i) => {
    if (i % 3 === 0) {
      await hitPad.click();
      hits++;
    }
  });
  expect(struck.polls, `polled ${POLLS_PER_WINDOW}× during the HIT window (units: POLLS)`).toBe(POLLS_PER_WINDOW);
  expect(hits, 'more than one hit landed inside the observed window (units: CLICKS)').toBeGreaterThan(1);
  expect(struck.peak, 'HIT fires a real snare hit at the module output').toBeGreaterThan(0.05);

  // ── 2. THE ROLL PAD, genuinely HELD. `mouse.down()` … poll … `mouse.up()` is
  // the only way to exercise `gate_in`'s declared edge:'gate' semantics; a
  // click would open and close it inside one event loop turn. ──
  const rollPad = faceplate.getByTestId('shell-cell-snaredrum-roll');
  await expect(rollPad, 'the ROLL audition cell is a real enabled button').toBeEnabled();
  await rollPad.scrollIntoViewIfNeeded();
  const box = (await rollPad.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(rollPad, 'the ROLL pad is a MOMENTARY pad and reports that it is held').toHaveAttribute(
    'aria-pressed',
    'true',
  );

  const rolling = await hold(page, 'scp');
  await page.mouse.up();
  await expect(rollPad, 'and it reports the release').toHaveAttribute('aria-pressed', 'false');

  expect(rolling.polls, `polled ${POLLS_PER_WINDOW}× during the ROLL window (units: POLLS)`).toBe(POLLS_PER_WINDOW);
  expect(rolling.peak, 'holding ROLL runs the two-hand engine').toBeGreaterThan(0.05);
  // CONTINUITY, the claim a one-shot audition could never make: once the roll is
  // running, EVERY window carries energy. A pulsed retrigger would drop some
  // to ~0. `scored` is asserted FIRST so "the roll never started" cannot pass
  // as "no gaps were observed" — a minimum over the empty set is not a claim.
  expect(
    rolling.scored,
    `most of the ${POLLS_PER_WINDOW} ROLL windows were scored for continuity (units: POLLS) — ` +
      `a roll that never started, or that died immediately, scores almost none`,
  ).toBeGreaterThanOrEqual(POLLS_PER_WINDOW - 2);
  expect(
    rolling.minRms,
    `every SCORED window carried energy — a held roll SUSTAINS ` +
      `(a gap would mean the gate is being re-struck, not held)`,
  ).toBeGreaterThan(0.001);

  // ── 3. …AND IT STOPS. The most important assertion in this file: a gate the
  // pad opens and never closes is a drum that rolls forever, with no undo and
  // no peer to notice. The tail rings out naturally, so allow the wire bed and
  // the in-flight voices a settling window before measuring silence. ──
  await page.waitForTimeout(SLOW_RENDER ? 2500 : 1200);
  const after = await hold(page, 'scp');
  expect(after.polls, `polled ${POLLS_PER_WINDOW}× after the release (units: POLLS)`).toBe(POLLS_PER_WINDOW);
  expect(
    after.peak,
    'RELEASING the ROLL pad stops the roll — a leaked gate would still be rolling here',
  ).toBeLessThan(0.01);

  // ── 4. The HARD switch is a real GRAPH write, not a pixel. ──
  const readHard = () =>
    page.evaluate(
      () => (globalThis as unknown as { __patch: { nodes: Record<string, { params: Record<string, number> }> } })
        .__patch.nodes['sd']!.params['hard'] ?? 0,
    );
  expect(await readHard(), 'HARD rests OFF (the shipping clean-warm default)').toBe(0);
  await faceplate.locator('[data-testid="control-hard"]').click();
  await expect
    .poll(readHard, { message: 'flipping HARD commits to the shared patch graph' })
    .toBe(1);
});
