// e2e/vrt/vrt-composite-scenes.ts
//
// Composite-state VRT scenes — a NEW category alongside the per-card scenes
// in vrt-scenes.ts.
//
// What's different from the per-card VRT in vrt.spec.ts:
//   * Two (or more) module cards in the same scene, wired with a patch cord.
//   * The screenshot captures BOTH cards at once (so a reviewer SEES the
//     upstream module driving the downstream module, side-by-side).
//   * The downstream module's state is the regression-locked observable —
//     the upstream module's job is to put the downstream into a known state.
//
// First composite: NIBBLES.length_cv → SCOPE.ch1, swept across 5 levels
// (CV min / 25% / 50% / 75% / max). Uses the deterministic
// `__nibblesForceLength` hook in nibbles.ts to pin the emitted CV without
// depending on the live game state. SCOPE's ch1 trace shifts visibly between
// the 5 snapshots (CV mode draws a horizontal line whose Y position is the
// DC value of the incoming CV); the side-by-side framing makes the cause
// (NIBBLES + the patch cord) explicit.
//
// History: an earlier draft of this scene used QBRT as the downstream
// consumer instead of SCOPE — but QBRT's visible state (cutoff slider
// position) reflects the user-dialed slider, NOT the CV-modulated
// underlying AudioParam, so the 5 QBRT snapshots looked identical and the
// VRT was effectively asserting nothing. SCOPE is the right consumer: its
// trace literally IS the incoming CV (drawn against time), so a sweep of
// the CV produces a sweep of the trace's Y position — a real visible
// regression gate.
//
// The infra here unlocks any future module pair where a signal-flow change
// visibly affects a downstream control / display — see PR body Phase-2
// notes. Scope discipline: this PR adds the NIBBLES→SCOPE sweep ONLY; no
// other composite scenes are queued here.

import type { Page } from '@playwright/test';
import { spawnPatch } from '../tests/_helpers';

// NIBBLES_MAX_LENGTH (= 119) lives in
// `packages/web/src/lib/video/modules/nibbles.ts`. We don't import it from
// here because the source file pulls SvelteKit `$lib/...` aliases that
// Playwright's plain TS transform doesn't resolve. If that constant ever
// changes the `nibbles.test.ts` "spirograph-VRT lengths" unit test fails
// first (it pins the resulting CV values explicitly), and the sweep
// lengths below must be recomputed.

/** A composite VRT scene = a setup function that drives the page to a
 *  deterministic two-card state ready for screenshot capture. */
export interface CompositeVrtScene {
  /** Stable id — drives the screenshot filename (`<id>.png`) and the
   *  gallery's clickable entry. Use kebab-case. */
  id: string;
  /** Human label for the gallery (shows under the thumbnail). */
  label: string;
  /** One-line description shown as a blurb in the gallery card. */
  blurb: string;
  /** Set up the rack: spawn modules + patch cables + apply any harness
   *  hooks. The page is already on `/` with the dev globals available. */
  setup: (page: Page) => Promise<void>;
  /** SvelteFlow node-card selectors the spec must wait for before snapping.
   *  Defaults to the NIBBLES→SCOPE pair (the original composite) when omitted,
   *  so existing scenes keep working unchanged. */
  cardSelectors?: string[];
}

// ---- NIBBLES → SCOPE 5-step CV sweep -------------------------------------
//
// Per-spec: pin lengths that map to (length - 59.5) / 59.5 ≈ -1.0 / -0.5 /
// 0.0 / +0.5 / +1.0 (mid = NIBBLES_MAX_LENGTH / 2 = 59.5). The lengths
// below are the closest integer values that hit those CV targets; the unit
// test in packages/web/src/lib/video/modules/nibbles.test.ts pins the
// resulting CV values so the mapping is locked.
//
//   length=1    → CV ≈ -0.983  (CV min — length clamped at floor)
//   length=30   → CV ≈ -0.496  (CV 25%)
//   length=60   → CV ≈ +0.008  (CV 50%)
//   length=89   → CV ≈ +0.496  (CV 75%)
//   length=119  → CV ≈ +1.000  (CV max — NIBBLES_MAX_LENGTH itself)

/** Build a setup function that:
 *  1. Sets `__nibblesForceLength` to a known length BEFORE the modules
 *     spawn (so the CV pins at boot too — no game tick required).
 *  2. Spawns NIBBLES + SCOPE side-by-side. SCOPE.ch1Range = 1 (CV mode,
 *     per PR #418) so the trace scales ±5 V correctly.
 *  3. Patches NIBBLES.length_cv → SCOPE.ch1 (audio input on the audio
 *     domain; the video→audio audio bridge handles cv → audio).
 *  4. Settles a couple of frames so the SCOPE analyser reads a stable
 *     sample of the incoming DC CV.
 */
function setupAt(length: number): (page: Page) => Promise<void> {
  return async (page) => {
    // Pin the NIBBLES RNG seed + force-length BEFORE spawnPatch so:
    //   1. The on-card game render is BYTE-IDENTICAL across all 5 snapshots
    //      (same seed = same snake spawn + same food placement). The only
    //      thing that should differ between the 5 baselines is SCOPE's
    //      ch1 trace Y position (the regression we're locking in — the
    //      CV value drives where the horizontal line is drawn).
    //   2. The forced length pins the length_cv emit value so the CV → SCOPE
    //      ch1 analyser sees a deterministic DC sample.
    // Both hooks are documented in nibbles.ts (`__nibblesVrtSeed` for the
    // game render + `__nibblesForceLength` for the CV path).
    await page.evaluate((len) => {
      const w = globalThis as unknown as {
        __nibblesVrtSeed?: number;
        __nibblesForceLength?: number;
      };
      w.__nibblesVrtSeed = 0xC0DE;
      w.__nibblesForceLength = len;
    }, length);

    await spawnPatch(
      page,
      [
        // NIBBLES (video domain, publishes audio sources for length_cv).
        { id: 'nib', type: 'nibbles', position: { x: 80, y: 80 }, domain: 'video' },
        // SCOPE — placed to the RIGHT of NIBBLES so the screenshot framing
        // shows the patch direction left → right. ch1Range = 1 (CV display
        // mode, per PR #418) so the ±1 CV input renders to a clean
        // horizontal line whose Y position tracks the CV value.
        {
          id: 'sc',
          type: 'scope',
          position: { x: 560, y: 80 },
          domain: 'audio',
          params: { ch1Range: 1 },
        },
      ],
      [
        // length_cv (video, type=cv) → ch1 (audio, type=audio). The
        // cross-domain video→audio audio bridge (engine.ts:
        // addCrossDomainAudioBridge) handles sourceType=cv → audio targets;
        // it .connect()s NIBBLES' ConstantSourceNode straight into SCOPE's
        // ch1 GainNode input + analyser path.
        {
          id: 'e_len_ch1',
          from: { nodeId: 'nib', portId: 'length_cv' },
          to: { nodeId: 'sc', portId: 'ch1' },
          sourceType: 'cv',
          targetType: 'audio',
        },
      ],
    );

    // The patch is established. Let a couple of frames land so the SCOPE
    // analyser fills + the DC sample stabilises before we snap. We
    // also re-pin the hook here as a belt-and-braces — spawnPatch clears the
    // graph then re-creates it, and depending on factory timing the boot-
    // time pickup may have missed (the post-spawn draw covers it but only
    // after at least one rAF lands).
    await page.evaluate((len) => {
      (globalThis as unknown as { __nibblesForceLength?: number }).__nibblesForceLength = len;
    }, length);

    // A few rAFs so the forced-length push lands + the analyser tap has a
    // chance to average a stable sample.
    for (let i = 0; i < 4; i++) {
      await page.evaluate(
        () => new Promise<void>((r) => requestAnimationFrame(() => r())),
      );
    }
    // Plus a short wait so the SCOPE analyser samples catch the new CV.
    await page.waitForTimeout(150);

    // SUSPEND the AudioContext so the game tick (advanced via
    // requestAnimationFrame's frame.time which the engine derives from
    // ac.currentTime) freezes — keeps the on-card NIBBLES render
    // pixel-stable across runs, regardless of wall-clock skew between
    // spawn and screenshot. Mirrors the pattern used by other VRT scenes
    // (RUTTETRA / RASTERIZE / FOXY). The CV value already lives on the
    // ConstantSourceNode's offset; suspending the context doesn't reset
    // it (web audio holds the last scheduled value), so the SCOPE
    // analyser's most-recent buffered samples stay at the pinned target.
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
      const eng = w.__engine?.();
      if (!eng) return;
      try { await eng.ctx.suspend(); } catch { /* already suspended / closed */ }
    });
    // One more rAF so the last pre-suspend frame finishes rendering.
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => r())),
    );
  };
}

// ---- VCO → SEQUENCER → SCOPE : baked-in gate-sampled S&H -------------------
//
// Shows the new S&H toggle's effect on the pitch CV, side-by-side: a SEQUENCER
// playing a SPARSE pattern (a note then a rest) → a SCOPE's ch1 (the pitch CV
// trace) AND → an analogVco's pitch, with the VCO's sine → ch2 (the audible
// waveform). Captured at a moment landing in a REST:
//   • S&H ON  → the pitch CV (ch1) HOLDS the note's V/oct across the rest
//     (the trace sits high), and the sequencer card's S&H badge is lit.
//   • S&H OFF → the pitch CV (ch1) collapses to 0 on the rest (trace centred),
//     and the badge is grey.
// The two baselines together make the held-vs-continuous difference visible.
//
// Determinism: a slow BPM + a fixed run window lands the suspend inside a rest;
// the AudioContext is then SUSPENDED so the held ConstantSourceNode offset (and
// thus the SCOPE analyser's last buffered samples) stays pixel-stable.

function setupSnhSeqScope(snh: number): (page: Page) => Promise<void> {
  return async (page) => {
    await spawnPatch(
      page,
      [
        // Slow BPM (60) so each 16th step ≈ 0.25 s — long enough that a fixed
        // run window reliably lands the suspend inside the rest step.
        {
          id: 'seq',
          type: 'sequencer',
          position: { x: 60, y: 70 },
          params: { bpm: 60, length: 2, isPlaying: 1, gateLength: 0.4, octave: 0, snh },
        },
        { id: 'vco', type: 'analogVco', position: { x: 470, y: 70 } },
        {
          id: 'sc',
          type: 'scope',
          position: { x: 760, y: 70 },
          domain: 'audio',
          params: { ch1Range: 1 },
        },
      ],
      [
        // pitch (polyPitchGate) → SCOPE ch1: the held pitch CV trace.
        {
          id: 'e_pitch_sc',
          from: { nodeId: 'seq', portId: 'pitch' },
          to: { nodeId: 'sc', portId: 'ch1' },
          sourceType: 'polyPitchGate',
          targetType: 'audio',
        },
        // pitch → VCO pitch (the real source chain).
        {
          id: 'e_pitch_vco',
          from: { nodeId: 'seq', portId: 'pitch' },
          to: { nodeId: 'vco', portId: 'pitch' },
          sourceType: 'polyPitchGate',
          targetType: 'pitch',
        },
        // VCO sine → SCOPE ch2 (the audible waveform alongside the CV).
        {
          id: 'e_vco_sc',
          from: { nodeId: 'vco', portId: 'sine' },
          to: { nodeId: 'sc', portId: 'ch2' },
          sourceType: 'audio',
          targetType: 'audio',
        },
      ],
    );

    // Sparse pattern: step 0 = C5 (gate on), step 1 = rest.
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes['seq'].data = {
          steps: [
            { on: true, midi: 72, chord: 'mono' }, // gated note
            { on: false, midi: 72, chord: 'mono' }, // rest
          ],
        };
      });
    });

    // Run a fixed window so the playhead reaches the REST step, then suspend.
    // 60 BPM, 2 steps, 16th → 0.25 s/step, 0.5 s/loop. ~0.7 s lands in a rest.
    await page.waitForTimeout(700);
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
      const eng = w.__engine?.();
      if (!eng) return;
      try { await eng.ctx.suspend(); } catch { /* already suspended */ }
    });
    // One rAF so the last pre-suspend frame finishes rendering.
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => r())),
    );
  };
}

const SNH_SEQ_SCOPE_CARDS = [
  '.svelte-flow__node-sequencer',
  '.svelte-flow__node-analogVco',
  '.svelte-flow__node-scope',
];

const SNH_COMPOSITE_SCENES: CompositeVrtScene[] = [
  {
    id: 'snh-seq-scope-on',
    label: 'VCO→SEQUENCER→SCOPE: S&H ON (mid-hold)',
    blurb:
      'Sequencer (sparse pattern, S&H ON) → SCOPE ch1: the pitch CV HOLDS the ' +
      'note across the rest (trace stays high); ch2 = the VCO sine.',
    setup: setupSnhSeqScope(1),
    cardSelectors: SNH_SEQ_SCOPE_CARDS,
  },
  {
    id: 'snh-seq-scope-off',
    label: 'VCO→SEQUENCER→SCOPE: S&H OFF (continuous)',
    blurb:
      'Same sparse pattern with S&H OFF → SCOPE ch1: the pitch CV collapses to ' +
      '0 on the rest (trace centred); the legacy continuous behavior.',
    setup: setupSnhSeqScope(0),
    cardSelectors: SNH_SEQ_SCOPE_CARDS,
  },
];

// ---- SEQUENCER → ADSR → SCOPE : sustain level on the scope ---------------
//
// The canonical envelope patch, made visible: a sequencer's GATE drives an
// ADSR, whose ENV output is shown on a SCOPE in AUDIO display mode (±1 fills
// the half-height — the right axis for a unipolar 0..1 envelope). With the
// gate held high and a fast decay, the envelope settles at its SUSTAIN
// level, so the scope draws a FLAT horizontal line whose height literally IS
// the sustain value — a phase-ROBUST DC trace (no time-domain phase
// dependence, unlike a raw waveform). Two baselines pin cause→effect:
//   • sustain 0.2 → flat line ≈ 0.2·halfHeight above centre (just above mid)
//   • sustain 0.8 → flat line ≈ 0.8·halfHeight above centre (near the top)
// The min↔max PAIR is the bug-catcher: if the ADSR ignored its sustain param
// both frames would be IDENTICAL; if the env were stuck at 0 / 1 both would
// sit at centre / top; if suspend landed mid-attack the line would not be
// flat. Any of those regressions is visible by eye in the pair. (Pure-DSP
// coverage of the envelope shape lives in adsr.test.ts; this scene locks the
// SCOPE *rendering* of a held sustain level — the composite-state observable.)
//
// Determinism: a SINGLE gated step at the BPM-30 floor pulses the gate
// (~0.475 s high per 0.5 s loop; gateLength ≤ 0.95 always closes before the
// next step, so there is no legato), and a SHORT decay (10 ms) gives a long
// flat sustain plateau (95% duty) each cycle. We suspend after a fixed 700 ms
// window — the same mechanism the S&H scene uses (proven stable on darwin AND
// linux) — which lands in a settled sustain plateau on both platforms despite
// their different audio-engine boot latencies (darwin: 2nd loop; linux CI,
// ~300 ms slower boot: 1st gate). The skeptical-first-baseline pass surfaced
// that a 300 ms suspend caught the linux transient, and that BOTH a canvas
// frame-stability poll and an analyser-value poll failed to write a fresh
// linux baseline under CI — so the fixed window matched to S&H is the path
// that actually yields clean cross-platform baselines (see git history).

function setupAdsrSustainScope(sustain: number): (page: Page) => Promise<void> {
  return async (page) => {
    await spawnPatch(
      page,
      [
        {
          id: 'seq',
          type: 'sequencer',
          position: { x: 60, y: 70 },
          domain: 'audio',
          // BPM at the 30 floor → 0.5 s/step (the longest single-step gate
          // window available); gateLength near-max so the gate holds high
          // through the whole step bar the closing gap.
          params: { bpm: 30, length: 1, isPlaying: 1, gateLength: 0.95, octave: 0 },
        },
        {
          id: 'adsr',
          type: 'adsr',
          position: { x: 470, y: 70 },
          domain: 'audio',
          // Fast decay (10 ms) so the env settles to `sustain` quickly after
          // the gate rises — a long, frame-stable sustain plateau for the
          // settle-poll below to lock onto.
          params: { attack: 0.005, decay: 0.01, sustain, release: 0.3 },
        },
        // SCOPE in AUDIO display mode (default ch1Range = 0, ±1 fills the
        // half-height) — the natural axis for a unipolar 0..1 envelope, and
        // far more diagnostic than CV mode (±5 V) where 0.2↔0.8 would differ
        // by only ~18 px.
        { id: 'sc', type: 'scope', position: { x: 760, y: 70 }, domain: 'audio' },
      ],
      [
        // seq GATE → ADSR gate — the real envelope-trigger chain.
        {
          id: 'e_gate',
          from: { nodeId: 'seq', portId: 'gate' },
          to: { nodeId: 'adsr', portId: 'gate' },
          sourceType: 'gate',
          targetType: 'gate',
        },
        // ADSR env (cv) → SCOPE ch1 (audio input) — the observable.
        {
          id: 'e_env_ch1',
          from: { nodeId: 'adsr', portId: 'env' },
          to: { nodeId: 'sc', portId: 'ch1' },
          sourceType: 'cv',
          targetType: 'audio',
        },
      ],
    );

    // A SINGLE gated step so the gate rises once and holds high (no per-step
    // retrigger before the suspend).
    await page.evaluate(() => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        w.__patch.nodes['seq'].data = {
          steps: [{ on: true, midi: 60, chord: 'mono' }],
        };
      });
    });

    // Run a fixed window, then suspend — the SAME proven mechanism the S&H
    // scene above uses (it has stable darwin AND linux baselines). 700 ms lands
    // in a settled SUSTAIN plateau on BOTH platforms despite their different
    // audio-engine boot latencies: on darwin (fast boot) the playhead is mid-
    // way through the 2nd 0.5 s loop; on linux CI (~300 ms slower boot) it is
    // mid-way through the 1st gate — both well past the ~50 ms attack+decay and
    // before the gate closes (gateLength 0.95 = 95% duty, so a 6% gate-gap is
    // the only bad phase, which neither platform's latency hits).
    //
    // History (see git log): a fixed 300 ms suspend caught the linux transient
    // (sloped trace); a canvas frame-stability poll and an analyser-value poll
    // BOTH failed to write a fresh linux baseline under CI (waitForFunction
    // never satisfied → silent no-op). The fixed window matched to the proven
    // S&H scene is the mechanism that actually produces clean baselines on both.
    await page.waitForTimeout(700);

    // SUSPEND so the held env (and the SCOPE analyser's last buffered samples)
    // freeze pixel-stable, then one rAF so the final frame finishes rendering.
    await page.evaluate(async () => {
      const w = globalThis as unknown as { __engine?: () => { ctx: AudioContext } | null };
      const eng = w.__engine?.();
      if (!eng) return;
      try { await eng.ctx.suspend(); } catch { /* already suspended */ }
    });
    await page.evaluate(
      () => new Promise<void>((r) => requestAnimationFrame(() => r())),
    );
  };
}

const ADSR_SUSTAIN_CARDS = [
  '.svelte-flow__node-sequencer',
  '.svelte-flow__node-adsr',
  '.svelte-flow__node-scope',
];

const ADSR_SUSTAIN_SCENES: CompositeVrtScene[] = [
  {
    id: 'adsr-sustain-low',
    label: 'SEQUENCER→ADSR→SCOPE: sustain LOW (0.2)',
    blurb:
      'A held gate drives an ADSR (sustain 0.2); SCOPE ch1 (audio mode) shows ' +
      'the env as a flat line just above centre — the held sustain level.',
    setup: setupAdsrSustainScope(0.2),
    cardSelectors: ADSR_SUSTAIN_CARDS,
  },
  {
    id: 'adsr-sustain-high',
    label: 'SEQUENCER→ADSR→SCOPE: sustain HIGH (0.8)',
    blurb:
      'Same patch with sustain 0.8; SCOPE ch1 shows the env as a flat line ' +
      'near the top. The min↔max pair proves the sustain param drives the ' +
      'trace height (identical frames would mean the param is ignored).',
    setup: setupAdsrSustainScope(0.8),
    cardSelectors: ADSR_SUSTAIN_CARDS,
  },
];

/** All composite VRT scenes. Iterated by `vrt-composite.spec.ts`. */
export const COMPOSITE_VRT_SCENES: CompositeVrtScene[] = [
  {
    id: 'nibbles-cv-min',
    label: 'NIBBLES→SCOPE: CV min (length=1)',
    blurb: 'NIBBLES.length_cv ≈ −0.98 → SCOPE ch1 trace at its lowest Y.',
    setup: setupAt(1),
  },
  {
    id: 'nibbles-cv-25',
    label: 'NIBBLES→SCOPE: CV 25% (length=30)',
    blurb: 'NIBBLES.length_cv ≈ −0.50 → SCOPE ch1 trace 25% above the floor.',
    setup: setupAt(30),
  },
  {
    id: 'nibbles-cv-50',
    label: 'NIBBLES→SCOPE: CV 50% (length=60)',
    blurb: 'NIBBLES.length_cv ≈ +0.01 → SCOPE ch1 trace near zero (centre).',
    setup: setupAt(60),
  },
  {
    id: 'nibbles-cv-75',
    label: 'NIBBLES→SCOPE: CV 75% (length=89)',
    blurb: 'NIBBLES.length_cv ≈ +0.50 → SCOPE ch1 trace 75% above the floor.',
    setup: setupAt(89),
  },
  {
    id: 'nibbles-cv-max',
    label: 'NIBBLES→SCOPE: CV max (length=119)',
    blurb: 'NIBBLES.length_cv = +1.00 → SCOPE ch1 trace at its highest Y.',
    setup: setupAt(119),
  },
  ...SNH_COMPOSITE_SCENES,
  ...ADSR_SUSTAIN_SCENES,
];
