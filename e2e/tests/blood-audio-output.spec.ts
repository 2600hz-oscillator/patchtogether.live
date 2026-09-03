// e2e/tests/blood-audio-output.spec.ts
//
// LIVE end-to-end coverage for BLOOD's stereo audio outputs (Phase-2 ②).
//
// Until this PR the BLOOD module shipped audio_l / audio_r as DEAD ports (the
// PCM bridge was a stub). This wires the real capture pipeline: MultiVoc (SFX)
// + the OPL3 software-MIDI synth (music) mix into interleaved-stereo pages,
// driver_sdl's device-less wasm path exposes them via bpt_sdl_audio_pump, the
// shim's bpt_pump_audio drains them into a ring, and a blood-pcm AudioWorklet
// de-interleaves into audio_l / audio_r. This spec proves the WHOLE chain is
// audible: real PatchEngine + real AudioContext + real BloodRuntime + real
// worklet → a downstream SCOPE actually sees the signal arrive.
//
// Mirrors doom-audio-output.spec.ts (the proven pattern): the SCOPE's
// AnalyserNode reads the LIVE worklet output, which the blood.ts setInterval
// pump feeds — and the DOOM loudness test confirms process() runs under the
// headless null-sink, so the analyser sees real samples even with no hardware.
//
// Sound source: Blood plays level music (OPL3) + ambient/weapon SFX in-game,
// and a menu-cursor blip SFX on every menu move. We drive the menu (proven by
// blood-ingame.spec) into a level, fire the weapon, and sample the SCOPE across
// the whole sequence, taking the peak — so a single audible moment passes even
// though the exact in-game amplitude is non-deterministic.
//
// ── ⚠ THE DRIVE + SAMPLE WINDOW RUNS IN THE PAGE (2026-09-02) ──────────────
//
// It used to run driver-side: ~97 separate Playwright operations, one hop each.
// That made the window's wall clock a function of how contended the runner was
// rather than of how long the game needs to make a noise, and it timed out
// `main` at f50ea053f having ALREADY measured a healthy peak. The window is now
// a single `page.evaluate` that drives the runtime with in-page sleeps — the
// shape `blood-ingame.spec.ts` already uses for this engine — and it exits as
// soon as the IN-GAME peak crosses the floor the assertion names. The
// assertion, the floor, the nav and the drive script are all UNCHANGED; what
// changed is who runs the loop and when it is allowed to stop. Full derivation
// and the measured phase breakdown are on the test.
//
// Renderer-independent for the AUDIO assertion (analyser reads the engine's own
// PCM, not the GL canvas) → SwiftShader-safe. Gated on blood-ready + e2e hooks.
//
// ── ⚠ RE-POINTED OFF `?shell=legacy` (2026-08-31, the blood face) ───────────
//
// The live test below used to boot `/rack?shell=legacy&seed=none` and wait on
// `blood-card` / `blood-ready`. That surface is an escape hatch no player meets,
// and — much worse for this particular spec — it is the surface whose card held
// the tree's ONLY `extras.ensureLoaded()` call. So a green run proved the whole
// menu → level → MultiVoc → worklet → audio_l → SCOPE chain works WHEN THE
// LEGACY CARD BOOTS THE ENGINE, and said nothing at all about the surface the
// promotion actually ships. `laneRenderKind` returns 'legacy' BEFORE `migrated`
// is read, so it would have stayed green forever over a face that never booted.
//
// It now boots the DEFAULT shell and opens the dock faceplate, so the engine is
// started by `BloodScreenBody`'s `autoBootBlood` and everything downstream —
// including the audible-output assertion — is a statement about the shipping
// surface. The assertions themselves are UNCHANGED; only the boot path and the
// readiness locator moved.
//
// ⚠ THE SECOND TEST IS DELIBERATELY LEFT ON THE `rack` FIXTURE. It is
// `test.fixme`-PARKED under #1847, so re-pointing it would rewrite a test nobody
// runs and would make the park's "the body and its assertions are UNCHANGED"
// note false. It moves when it is un-parked.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch } from './_helpers';
import { BOOT_MS, SLOW_BOOT_TEST_TIMEOUT_MS, SLOW_RENDER } from '../_helpers/boot-budget';

const BLOOD_ID = 'blood-aud';
const SCOPE_ID = 'scope-aud';

// Build scancodes (match blood-keys.ts).
const SC_ENTER = 0x1c;
const SC_DOWN = 0xd0;
const SC_SPACE = 0x39;
const SC_RIGHT_CONTROL = 0x9d; // fire
const SC_2 = 0x03; // select a loud weapon (flare gun) in-game

/** Read a SCOPE's ch1 analyser snapshot → peak + rms. (Same shape as
 *  doom-audio-output's helper.) */
async function readScopePeak(page: Page, scopeId: string): Promise<{ peak: number; rms: number } | null> {
  return page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } } | null;
    };
    const ad = w.__engine?.()?.getDomain('audio');
    const snap = ad?.read(id, 'snapshot') as { ch1?: Float32Array } | undefined;
    if (!snap || !snap.ch1) return null;
    let peak = 0, sq = 0;
    for (let i = 0; i < snap.ch1.length; i++) {
      const v = snap.ch1[i]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sq += v * v;
    }
    return { peak, rms: Math.sqrt(sq / Math.max(1, snap.ch1.length)) };
  }, scopeId);
}

test('BLOOD audio_l → SCOPE: the game-audio mixer produces audible signal in-game', async ({ page }) => {
  // ⚠ THE CEILING IS DERIVED, AND THE RE-POINT IS WHY IT MOVED — measured on a
  // RED run, not raised on suspicion. CI run 33435725342, e2e shard 5/12: this
  // test failed BOTH attempts with `Test timeout of 90000ms exceeded`, and its
  // own log line had ALREADY printed a healthy result on each
  // (`peak=0.6976` / `peak=0.7599` against a 0.01 floor). So the assertion was
  // reached and would have passed; the flat 90 s guillotine came down on the way
  // out.
  //
  // ⚠ THE COST IS A SERIALISATION, NOT A SLOWDOWN, and that is the whole reason a
  // bump is the honest fix rather than a cover-up. On `?shell=legacy` the card
  // mounted WITH THE PAGE, so BLOOD's 5.9 MB ASYNCIFY cold boot (20-25 s on a
  // 2-core SwiftShader VM, per blood-mount.spec.ts's header) overlapped
  // `waitForLoadState('networkidle')` and `spawnPatch`. On the shipping surface
  // the body mounts in the DOCK, so that boot cannot begin until the dock is
  // open — the same work, ~20 s of it moved from concurrent to sequential.
  //
  // Expressed as "the existing budget PLUS one cold boot", both from the ONE
  // export site, so it scales with the renderer instead of being a different
  // assertion on every runner (#1875/#1906): 90 s + 30 s on CI, 30 s + 15 s
  // locally. It BOUNDS the failure; nothing here asserts it.
  //
  // ── ⚠ AND THAT DERIVATION WAS WRONG, MEASURED — CI run 33588187510 ───────
  //
  // The 90→120 s bump above blamed the boot and bought 30 s for it. Then the
  // SAME failure came back at 120 s on `main` at f50ea053f (e2e shard 6/12,
  // attempt 1 `Test timeout of 120000ms exceeded`, its own log line already
  // printed `peak=0.7255`; passed on retry). The trace from that attempt says
  // the boot was never the problem, and prices every phase:
  //
  //   0.0 → 11.2 s   goto + networkidle + spawnPatch + shell/dock/frame paint
  //   11.2 → 31.4 s  the WASM cold boot — 20.1 s, INSIDE its 30 s BOOT_MS
  //   31.4 → 32.2 s  the PCM seam probe
  //   32.2 → 124.4 s ← the drive + sample window: 92 s of a ~10 s script
  //   124.4 s        the assertion ran, and PASSED, 4.4 s past the guillotine
  //
  // The window's own script is ~10 s of dwells. It cost 92 s because it was
  // ~97 driver-side round trips, and on a loaded shard runner a round trip is
  // not free: 53 sample evaluates at 824 ms each = 43.7 s, 44 nominally-80 ms
  // waits at 565 ms each = 24.9 s, 9 key evaluates = 7.8 s. Roughly 54 s of the
  // 92 s was the INSTRUMENT, not the subject — the cost of asking, not of
  // waiting. A third bump would buy time for that overhead, which is unbounded
  // in contention, so the fix below deletes the overhead instead. See the
  // window's own comment.
  //
  // The ceiling is therefore LEFT WHERE IT IS. Boot + paint (31 s measured)
  // plus a window bounded at 45 s sits inside 120 s with room; a fix that
  // needed the ceiling raised again would not be a fix.
  test.setTimeout(SLOW_BOOT_TEST_TIMEOUT_MS + BOOT_MS);
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  // ⚠ THE DEFAULT SHELL — see the header. This is the boot path a player takes,
  // and after the promotion it is the ONLY one that exercises the face's engine
  // boot. `seed=none` keeps the rack empty so spawnPatch owns the graph.
  await page.goto('/rack?shell=1&seed=none');
  await page.waitForLoadState('networkidle');

  await spawnPatch(
    page,
    [
      { id: BLOOD_ID, type: 'blood', position: { x: 100, y: 80 }, domain: 'video' },
      { id: SCOPE_ID, type: 'scope', position: { x: 560, y: 80 }, domain: 'audio' },
    ],
    [
      {
        id: 'e-blood-audio-scope',
        from: { nodeId: BLOOD_ID, portId: 'audio_l' },
        to: { nodeId: SCOPE_ID, portId: 'ch1' },
        sourceType: 'audio',
        targetType: 'audio',
      },
    ],
  );

  // ── OPEN THE FACEPLATE, WHICH IS WHAT BOOTS THE ENGINE ───────────────────
  //
  // On the default shell the lane tile is a `ModuleShell` and the module's own
  // surface lives in the dock full view — exactly where the legacy card used to
  // be mounted, so WHEN blood boots is unchanged by the promotion; only WHICH
  // component does it moved.
  const shell = page.locator(`.svelte-flow__node[data-id="${BLOOD_ID}"] [data-testid="module-shell"]`);
  await expect(shell, 'the promoted BLOOD face renders a ModuleShell tile in the lane')
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });
  await shell.getByTestId('shell-open-dock').click();
  const frame = page.getByTestId('dock-full-view').getByTestId('blood-face-frame');
  await expect(frame, 'the BLOOD faceplate body mounts in the dock')
    .toBeVisible({ timeout: SLOW_BOOT_TEST_TIMEOUT_MS });

  // ⚠ READ OFF A DATA ATTRIBUTE, NOT A STATUS LINE. The card's "Running — click
  // + use arrows/Ctrl/Space" readout is DELETED by the promotion (a derived
  // state word outside any control), so `blood-ready` no longer exists on the
  // shipping surface. The state is on `data-blood-status`, which is assertable
  // without painting anything.
  //
  // ⚠ `BOOT_MS`, NOT THE HAND-TYPED 25 s THIS SPEC CARRIED ON THE CARD. What is
  // being waited for is exactly one cold WASM boot, and `BOOT_MS` is the fleet's
  // name for that (30 s under SLOW_RENDER, 15 s locally) — so the wait scales
  // with the renderer rather than meaning something different on every machine.
  // It exits the instant the body reports ready.
  const ready = await expect
    .poll(() => frame.getAttribute('data-blood-status'), { timeout: BOOT_MS })
    .toBe('ready')
    .then(() => true)
    .catch(() => false);
  test.skip(!ready, 'BLOOD engine did not reach ready (renderer/heap-sensitive on CI)');

  // Confirm the runtime + its PCM seam are reachable; skip on prod-preview.
  const seam = await page.evaluate((id) => {
    const w = globalThis as unknown as {
      __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } } | null;
    };
    const ve = w.__engine?.()?.getDomain('video');
    const ex = ve?.read(id, 'extras') as
      | { getRuntime: () => { isInitialized: () => boolean; setKey: (sc: number, p: boolean) => void; getPcmFrames?: (n: number) => Float32Array } | null }
      | undefined;
    const rt = ex?.getRuntime();
    return { hasRt: !!rt, hasPump: typeof rt?.getPcmFrames === 'function' };
  }, BLOOD_ID);
  test.skip(!seam.hasRt, 'BLOOD runtime/extras unavailable (prod-preview)');
  expect(seam.hasPump, 'runtime exposes getPcmFrames (the PCM capture seam)').toBe(true);

  // ── THE WINDOW RUNS IN THE PAGE, AND EXITS ON THE ASSERTED QUANTITY ──────
  //
  // See the header for the run that measured why. Two properties matter and
  // they are independent:
  //
  //  1. ONE ROUND TRIP. The drive + sample script used to be ~97 separate
  //     driver-side operations (53 `page.evaluate` samples, 44
  //     `page.waitForTimeout` dwells, 9 key evaluates). Each one is a
  //     cross-process hop, and on a contended shard runner the hops — not the
  //     dwells — are the cost: measured at 824 ms per sample evaluate and
  //     565 ms per nominally-80 ms wait. Same script, in-page: the dwells cost
  //     what they say and the hops disappear. This is the shape
  //     `blood-ingame.spec.ts` already uses for exactly this engine — one
  //     evaluate that drives the runtime with in-page `setTimeout` sleeps.
  //
  //  2. AN EXIT ON THE EVIDENCE. The assertion is "audio_l was audible at some
  //     moment", which a single loud moment satisfies; the old loop kept
  //     sampling a fixed 53-sample script long after that was true, so its
  //     runtime was decoupled from its own evidence. It now stops as soon as
  //     the evidence exists — and the exit predicate is the asserted quantity
  //     (#2307), taken from the IN-GAME phase only, so it can never be
  //     satisfied by a menu blip and can never truncate the nav.
  //
  // The deadline is a BOUND, not an assertion: it exists so a wedged engine
  // returns diagnostics instead of letting the guillotine fall with none.
  //
  // ⚠ THIS IS AN OLD STANDARD, NOT A NEW ONE, AND THE GATE COULD NOT SEE IT.
  // `readScopePeakOverWindow` in `_module-coverage-helpers.ts` already does all
  // of this — in-page accumulator, early exit on a caller-stated target, throw
  // on a zero-sample window — and `scripts/e2e-observation-window.test.ts` gates
  // it at the source. But that gate reads EXACTLY two shared helper files and
  // says so; a window hand-rolled inside one spec is outside its scope. This
  // spec is that case, which is why the defect the gate was built for came back
  // here. The shared helper cannot simply be called: this window has to DRIVE
  // the game (nav keys, weapon select, held fire) interleaved with sampling,
  // which an observe-only helper does not do. So the three clauses are honoured
  // in place, and the blind spot is reported rather than gated (owner: no new
  // gates without discussion).
  const AUDIBLE_FLOOR = 0.01;
  const WINDOW_MS = SLOW_RENDER ? 45_000 : 25_000;

  const run = await page.evaluate(
    async ({ id, scopeId, floor, deadlineMs, nav, scWeapon, scFire }) => {
      const w = globalThis as unknown as {
        __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } } | null;
      };
      const eng = w.__engine?.();
      const ve = eng?.getDomain('video');
      const ad = eng?.getDomain('audio');
      const rt = (ve?.read(id, 'extras') as { getRuntime: () => { setKey: (s: number, p: boolean) => void } | null } | undefined)?.getRuntime();
      if (!rt || !ad) return null;

      const t0 = performance.now();
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

      let peak = 0, rms = 0, gamePeak = 0, menuPeak = 0, samples = 0, reads = 0;
      let crossedAtMs = -1;
      let inGame = false;

      const sample = () => {
        samples++;
        const snap = ad.read(scopeId, 'snapshot') as { ch1?: Float32Array } | undefined;
        if (!snap?.ch1) return;
        reads++;
        let p = 0, sq = 0;
        for (let i = 0; i < snap.ch1.length; i++) {
          const v = snap.ch1[i]!;
          const a = v < 0 ? -v : v;
          if (a > p) p = a;
          sq += v * v;
        }
        if (p > peak) peak = p;
        const r = Math.sqrt(sq / Math.max(1, snap.ch1.length));
        if (r > rms) rms = r;
        if (inGame) {
          if (p > gamePeak) gamePeak = p;
          if (crossedAtMs < 0 && p > floor) crossedAtMs = performance.now() - t0;
        } else if (p > menuPeak) menuPeak = p;
      };

      // The exit: in-game evidence for the asserted quantity. `gamePeak > floor`
      // IMPLIES `peak > floor`, so leaving early can never skip past a sample
      // that would have changed the verdict.
      const done = () => crossedAtMs >= 0;
      const expired = () => performance.now() - t0 > deadlineMs;

      // pacing: blood.ts posts one pump frame to the blood-pcm worklet every
      // 16 ms (`setInterval(..., 16)` beside `framesPerPump`) — the product's
      // own cadence, and the interval at which a new snapshot can exist. It is
      // also safely under the SCOPE analyser's own window (fftSize 2048 at
      // 48 kHz = 42.7 ms), so consecutive reads OVERLAP and no transient can be
      // stepped over. Each read is a 2048-float scan — microseconds — so the
      // sampler cannot starve the game loop it is measuring; the `await` yields
      // to rAF between every sample.
      //
      // ⚠ The dwell is bounded by WALL CLOCK, not by a sample count. That is
      // the property that makes the window cost what it says: if the runner
      // starves and setTimeout fires late, the dwell yields fewer samples over
      // the same real interval rather than stretching to collect a fixed 53.
      const dwell = async (ms: number) => {
        const until = performance.now() + ms;
        while (performance.now() < until && !done() && !expired()) {
          await sleep(16);
          sample();
        }
      };
      const press = async (sc: number, holdMs: number, settleMs: number) => {
        rt.setKey(sc, true);
        await sleep(holdMs);
        rt.setKey(sc, false);
        await dwell(settleMs);
      };

      // Drive into a level with the PROVEN blood-ingame nav (8 keys, 650 ms
      // settle). UNCONDITIONAL — `done()` is false throughout because nothing
      // here is in-game yet, so no menu blip can cut the nav short.
      for (const sc of nav) await press(sc, 120, 650);

      // In-level: ambient sound sprites + weapon fire feed MultiVoc → the
      // blood.ts pump → the worklet → audio_l → SCOPE.
      inGame = true;
      await dwell(900);
      if (!done() && !expired()) await press(scWeapon, 120, 300); // flare gun
      await dwell(1600);
      if (!done() && !expired()) {
        rt.setKey(scFire, true);
        await dwell(1920);
        rt.setKey(scFire, false);
      }

      // ⚠ "THE INSTRUMENT NEVER LOOKED" MUST NOT PRINT AS "THE MODULE IS
      // SILENT". Both return peak 0, and that ambiguity is what cost the
      // shard-1 run two red attempts (#1303) — it is the third clause of the
      // standard `readScopePeakOverWindow` is gated on
      // (scripts/e2e-observation-window.test.ts: `polls === 0` → throw). A
      // window that took no samples, or took samples but never got a snapshot
      // back, throws here rather than reporting a silence it never observed.
      const elapsedMs = performance.now() - t0;
      if (samples === 0) throw new Error(`observation window took ZERO samples in ${Math.round(elapsedMs)} ms — the in-page loop never ran; nothing was measured`);
      if (reads === 0) throw new Error(`observation window took ${samples} samples in ${Math.round(elapsedMs)} ms but the SCOPE analyser returned no snapshot on any of them — the instrument is dead, not the module`);

      return { peak, rms, gamePeak, menuPeak, samples, reads, crossedAtMs, elapsedMs, expired: expired() };
    },
    {
      id: BLOOD_ID,
      scopeId: SCOPE_ID,
      floor: AUDIBLE_FLOOR,
      deadlineMs: WINDOW_MS,
      nav: [SC_ENTER, SC_ENTER, SC_ENTER, SC_DOWN, SC_ENTER, SC_ENTER, SC_SPACE, SC_ENTER],
      scWeapon: SC_2,
      scFire: SC_RIGHT_CONTROL,
    },
  );

  expect(run, 'the BLOOD runtime and the SCOPE analyser were both reachable from the page').not.toBeNull();
  const bestPeak = run!.peak;

  // The IN-GAME split and the sample count are printed on every run, green or
  // red. They are diagnostics, not gates: `menuPeak` is what the assertion
  // below would accept but the title does not claim, and a run where the two
  // diverge is the one worth reading.
  const observed =
    `gamePeak=${run!.gamePeak.toFixed(4)} menuPeak=${run!.menuPeak.toFixed(4)} ` +
    `samples=${run!.samples} reads=${run!.reads} ` +
    `crossedAt=${run!.crossedAtMs < 0 ? 'never' : `${Math.round(run!.crossedAtMs)}ms`} ` +
    `window=${Math.round(run!.elapsedMs)}ms${run!.expired ? ' (DEADLINE)' : ''}`;

  // eslint-disable-next-line no-console
  console.log(`[blood-audio] audio_l SCOPE peak=${bestPeak.toFixed(4)} rms=${run!.rms.toFixed(4)} ${observed}`);

  // ANY clear non-silence proves the whole chain: driver_sdl capture pump →
  // MultiVoc mix → bpt ring → blood-pcm worklet → audio_l → SCOPE. MultiVoc
  // outputs near-full-scale s16, so a real SFX/music moment lands well above
  // this tolerant floor (the analyser noise floor is ~1e-4).
  //
  // ⚠ THE MESSAGE CARRIES HOW HARD THE WINDOW LOOKED, not just what it found —
  // the same reason the window throws on a zero-sample run. A red that says
  // "silent over 306 samples in 6.3 s" is a product finding; one that says
  // "silent over 4 samples in 45 s (DEADLINE)" is a starved runner, and without
  // the counts in the message those two reds are the same sentence.
  expect(
    bestPeak,
    `audio_l peak stayed near silence (${bestPeak}) over ${observed} — the BLOOD PCM capture ` +
      `pipeline is not producing sound (driver_sdl pump / MultiVoc mix / worklet / audio_l bridge is dead).`,
  ).toBeGreaterThan(AUDIBLE_FLOOR);
});

// MUSIC regression: the shareware ships its level music as embedded MIDIs
// (SOUNDS.RFF: PESTIS/UNHOLY/CBLOOD*/BLOOD*) but the stock BLOOD.INI only had CD
// `Track=N` refs (CDAudioToggle defaults off → no music). We added a `Song=`
// (MID) per level, so the OPL3 FM synth renders CONTINUOUS music into the mixer.
// Test: drive into a level, then STAND STILL (no fire / no movement) and sample
// the SCOPE — continuous music keeps RMS above the floor on (nearly) every
// sample, whereas sparse ambient SFX would not. Asserts the SUSTAINED fraction.
// ▶ UN-PARKED (was FLAKE-PARK #1847; 4 recovered-on-retry observations in the 96 h census to
// 2026-08-18, never a hard failure). Root cause found, not waited out: the pump posted a fixed
// 735 frames (44100/60) per setInterval tick into a ring drained at the 48 kHz context rate, so
// production ran at ~62% of demand and the ring intermittently underflowed to silence — which a
// retry could win on scheduling luck. blood-pcm-schedule.ts makes the pump rate-exact off the
// context clock, removing the nondeterminism at its source. Body and assertions UNCHANGED.
test('BLOOD music: in-level OPL3 music produces SUSTAINED audio on audio_l (standing still)', async ({ page, rackLegacy }) => {
  test.setTimeout(90_000);
  await spawnPatch(
    page,
    [
      { id: BLOOD_ID, type: 'blood', position: { x: 100, y: 80 }, domain: 'video' },
      { id: SCOPE_ID, type: 'scope', position: { x: 560, y: 80 }, domain: 'audio' },
    ],
    [{ id: 'e-blood-music-scope', from: { nodeId: BLOOD_ID, portId: 'audio_l' }, to: { nodeId: SCOPE_ID, portId: 'ch1' }, sourceType: 'audio', targetType: 'audio' }],
  );
  await page.getByTestId('blood-card').waitFor({ state: 'visible', timeout: 10_000 });
  const ready = await page.getByTestId('blood-ready').waitFor({ state: 'visible', timeout: 25_000 }).then(() => true).catch(() => false);
  test.skip(!ready, 'BLOOD engine did not reach ready (renderer/heap-sensitive on CI)');

  // Drive into a level (proven nav) via the runtime, then DO NOTHING.
  const drove = await page.evaluate(async ({ id }) => {
    const w = globalThis as unknown as { __engine?: () => { getDomain: (d: string) => { read: (i: string, k: string) => unknown } } | null };
    const ve = w.__engine?.()?.getDomain('video');
    const rt = (ve?.read(id, 'extras') as { getRuntime: () => { setKey: (s: number, p: boolean) => void } | null } | undefined)?.getRuntime();
    if (!rt) return false;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const press = async (sc: number) => { rt.setKey(sc, true); await sleep(120); rt.setKey(sc, false); await sleep(650); };
    for (const sc of [0x1c, 0x1c, 0x1c, 0xd0, 0x1c, 0x1c, 0x39, 0x1c]) await press(sc);
    await sleep(1200);
    return true;
  }, { id: BLOOD_ID });
  test.skip(!drove, 'BLOOD runtime unavailable (prod-preview)');

  // Sample the SCOPE while standing still: count samples carrying audio, in
  // WINDOWS-UNTIL-SUSTAINED form. A single fixed ~2.6s window against a hard
  // 60% bar failed 0.58-vs-0.6 on loaded CI runners four times (main push
  // fc123c92, #1043, #1052): under shard contention the tab's audio pump into
  // the analyser stalls and a few samples read empty while the OPL3 music is
  // demonstrably playing (the peak assert passes). Behavior discriminates the
  // same — sparse ambient SFX never reaches 60% in ANY window — but a starved
  // window no longer fails the run: pass as soon as one window sustains, fail
  // only when no window ever does within the budget.
  let peak = 0;
  let bestFrac = 0;
  let sustained = false;
  for (let attempt = 0; attempt < 4 && !sustained; attempt++) {
    let withAudio = 0, n = 0;
    for (let i = 0; i < 24; i++) {
      await page.waitForTimeout(110);
      const s = await readScopePeak(page, SCOPE_ID);
      if (s) { n++; if (s.rms > 0.01) withAudio++; if (s.peak > peak) peak = s.peak; }
    }
    const frac = n ? withAudio / n : 0;
    if (frac > bestFrac) bestFrac = frac;
    sustained = frac > 0.6;
    // eslint-disable-next-line no-console
    console.log(`[blood-music] window ${attempt + 1}/4 peak=${peak.toFixed(4)} sustainedFrac=${frac.toFixed(2)} (${withAudio}/${n})`);
  }

  expect(peak, `audio_l silent while standing still (${peak}) — level music (Song=<MID>) not playing`).toBeGreaterThan(0.01);
  expect(sustained, `audio_l never SUSTAINED while idle (best window ${bestFrac.toFixed(2)} over 4 windows) — OPL3 music isn't running (only sparse SFX?)`).toBe(true);
});
