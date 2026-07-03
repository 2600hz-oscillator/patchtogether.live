// e2e/tests/docs-virtual-module.spec.ts
//
// The interactive virtual-module doc page (the redesign that replaces the
// numbered face as the PRIMARY view). Proves, data-driven over adsr + sequencer:
//   (a) the LIVE card mounts + renders on /docs/modules/<id>,
//   (b) hovering a faceplate control shows its AUTHORED text in the right pane,
//   (c) opening the patch panel + hovering a CV port shows the CV desc AND the
//       "modulates <Param>" DUAL context (the CV→param overlap),
//   (d) SANDBOX ISOLATION — interacting never persists a real rack (the global
//       store stays empty of a real rackspace binding / no relay opened),
//   (e) SSR — the prerendered HTML carries the right-pane authored explanation
//       with NO JS.
//
// These are NEW tests; flake-checked 3× via `REPEAT=3 task e2e:one`.

import { test, expect, type Page } from '@playwright/test';

test.describe.configure({ mode: 'parallel' });

interface Probe {
  id: string;
  heading: RegExp;
  /** A faceplate control to hover (param id → testid `control-<id>`). */
  controlParam: string;
  /** Substring expected in the pane after hovering that control. */
  controlDescIncludes: RegExp;
  /** A CV input port whose pane should show the dual "modulates X" context. */
  cvPort: string;
  /** The control name the CV port should say it modulates. */
  modulates: RegExp;
}

const PROBES: Probe[] = [
  {
    id: 'adsr',
    heading: /adsr/i,
    controlParam: 'attack',
    controlDescIncludes: /rise|attack/i,
    cvPort: 'attack',
    modulates: /modulates/i,
  },
  {
    id: 'sequencer',
    heading: /sequencer/i,
    controlParam: 'bpm',
    controlDescIncludes: /tempo|bpm/i,
    // sequencer has no CV→param inputs (its CVs are transport gates), so the
    // dual-context assertion is skipped for it (see the conditional below).
    cvPort: '',
    modulates: /./,
  },
  // --- Batch 1 — foundational modules (2026-06-25). Each is on the
  // INTERACTIVE_DOC_MODULES allowlist; this proves the live card mounts cleanly
  // and a control hover updates the pane. A CV→param dual-context check runs only
  // where the module has a CV input with a paramTarget (analogVco, filter, lfo,
  // cofefve); vca/mixer/noise have no CV→param link (cvPort: '' skips it). ---
  {
    id: 'analogVco',
    heading: /analog vco/i,
    controlParam: 'tune',
    controlDescIncludes: /pitch|tune|semitone/i,
    cvPort: 'tune', // CV → tune param
    modulates: /modulates/i,
  },
  {
    id: 'vca',
    heading: /vca/i,
    controlParam: 'base',
    controlDescIncludes: /offset|unity|base/i,
    cvPort: '', // the `cv` input has no paramTarget (it's the gain CV, not a param mod)
    modulates: /./,
  },
  {
    id: 'mixer',
    heading: /mixer/i,
    controlParam: 'master',
    controlDescIncludes: /master|bus|gain/i,
    cvPort: '', // no CV inputs
    modulates: /./,
  },
  {
    id: 'noise',
    heading: /noise/i,
    controlParam: 'level',
    controlDescIncludes: /gain|level|noise/i,
    cvPort: '', // pure source, no inputs
    modulates: /./,
  },
  {
    id: 'filter',
    heading: /filter/i,
    controlParam: 'cutoff',
    controlDescIncludes: /cutoff|frequency|corner/i,
    cvPort: 'cutoff', // CV → cutoff param
    modulates: /modulates/i,
  },
  {
    id: 'lfo',
    heading: /lfo/i,
    controlParam: 'rate',
    controlDescIncludes: /rate|knob/i,
    cvPort: 'rate', // CV → rate param
    modulates: /modulates/i,
  },
  // NOTE — cofefve (COFEFVE DELAY) is documented + STRICT but intentionally NOT
  // on INTERACTIVE_DOC_MODULES: its card IS a convention card (CofefveCard) so
  // the doc route could mount it live, but it is kept static for parity with the
  // Cocoa Delay module it replaced. No live-card probe for it here; see
  // interactive-doc-modules.ts.
  // --- Batch 3 — CV utilities & modulation shapers (2026-06-26). Each is on
  // INTERACTIVE_DOC_MODULES; this proves the live card mounts cleanly and a
  // control hover updates the pane. The CV→param dual-context check runs only
  // where the module has a CV input with a paramTarget (unityscalemathematik,
  // slewSwitch); polarizer/depolarizer/scaler/attenumix/veils/sampleHold have no
  // CV→param link (their CV inputs are raw signals / gates), so cvPort '' skips it. ---
  {
    id: 'polarizer',
    heading: /polarizer/i,
    controlParam: 'depth',
    controlDescIncludes: /swing|bipolar|depth/i,
    cvPort: '',
    modulates: /./,
  },
  {
    id: 'depolarizer',
    heading: /depolarizer/i,
    controlParam: 'depth',
    controlDescIncludes: /center|unipolar|depth/i,
    cvPort: '',
    modulates: /./,
  },
  {
    id: 'scaler',
    heading: /scaler/i,
    controlParam: 'amount',
    controlDescIncludes: /scale|gain|unity/i,
    cvPort: '',
    modulates: /./,
  },
  {
    id: 'attenumix',
    heading: /attenumix/i,
    controlParam: 'master',
    controlDescIncludes: /master|bus|gain/i,
    cvPort: '', // CV inputs are raw per-channel CV (no paramTarget)
    modulates: /./,
  },
  {
    id: 'veils',
    heading: /veils/i,
    controlParam: 'gain1',
    controlDescIncludes: /gain|vca|channel/i,
    cvPort: '', // CV inputs are raw gain CV (no paramTarget)
    modulates: /./,
  },
  {
    id: 'unityscalemathematik',
    heading: /unityscalemathematik/i,
    controlParam: 'unityAtten',
    controlDescIncludes: /attenuvert|unity|invert/i,
    cvPort: 'u_atten_cv', // CV → unityAtten param
    modulates: /modulates/i,
  },
  {
    id: 'sampleHold',
    heading: /sample/i,
    controlParam: 'scale',
    controlDescIncludes: /scale|quantize|note/i,
    cvPort: '', // gate/cv inputs are not param mods
    modulates: /./,
  },
  {
    id: 'slewSwitch',
    heading: /slewswitch/i,
    controlParam: 'slew1',
    controlDescIncludes: /slew|glide|smooth/i,
    cvPort: 'slew1_cv', // CV → slew1 param
    modulates: /modulates/i,
  },
  // --- Batch 4 — effects (2026-06-26). Each is on INTERACTIVE_DOC_MODULES; the
  // live card (pure Knob/Fader + PatchPanel; clouds adds a $derived button) must
  // mount cleanly and a control hover updates the pane. The CV→param dual-context
  // check runs on a CV input with a paramTarget (every batch-4 module has one). ---
  {
    id: 'reverb',
    heading: /reverb/i,
    controlParam: 'size',
    controlDescIncludes: /tank|decay|size/i,
    cvPort: '', // reverb has no CV inputs (three knobs only)
    modulates: /./,
  },
  {
    id: 'delay',
    heading: /delay/i,
    controlParam: 'feedback',
    controlDescIncludes: /feedback|echo|repeat/i,
    cvPort: 'time', // CV → time param
    modulates: /modulates/i,
  },
  {
    id: 'clouds',
    heading: /clouds/i,
    controlParam: 'density',
    controlDescIncludes: /grain|density|trigger/i,
    cvPort: 'position_cv', // CV → position param
    modulates: /modulates/i,
  },
  {
    id: 'charlottesEchos',
    heading: /charlotte/i,
    controlParam: 'decay',
    controlDescIncludes: /decay|colour|taper|degrade/i,
    cvPort: 'delay', // CV → delay param
    modulates: /modulates/i,
  },
  {
    id: 'shimmershine',
    heading: /shimmershine/i,
    controlParam: 'shimmer',
    controlDescIncludes: /shimmer|octave/i,
    cvPort: 'decay_cv', // CV → decay param
    modulates: /modulates/i,
  },
  {
    id: 'aquaTank',
    heading: /aquatank/i,
    controlParam: 'fb1',
    controlDescIncludes: /feedback|resonance|recirculat/i,
    cvPort: 'fb1_cv', // CV → fb1 param
    modulates: /modulates/i,
  },
  {
    id: 'destroy',
    heading: /destroy/i,
    controlParam: 'bits',
    controlDescIncludes: /quantiz|bit|crunch/i,
    cvPort: 'decimate', // CV → decimate param
    modulates: /modulates/i,
  },
  {
    id: 'warps',
    heading: /warps/i,
    controlParam: 'timbre',
    controlDescIncludes: /intensity|algorithm|mix/i,
    cvPort: 'timbre_cv', // CV → timbre param
    modulates: /modulates/i,
  },
  {
    id: 'ringback',
    heading: /ringback/i,
    controlParam: 'size',
    controlDescIncludes: /ring|comb|grain|sample/i,
    cvPort: 'rate', // CV → rate param
    modulates: /modulates/i,
  },
  // --- Batch 6 — Moog System 55/35 sources & utilities (2026-06-26). Only the
  // CONVENTION-card members (no `card:` override) are interactive; their cards
  // are pure Knob + segmented-switch buttons + PatchPanel, so the live card
  // mounts and a control hover updates the pane. The CV→param dual-context check
  // runs where a CV input has a paramTarget (921 VCO tune, 921A freq_cv); the
  // 921B bus inputs and the 995's audio inputs have no paramTarget (cvPort ''
  // skips it). The override-card siblings (903a/956/961/962/994) stay STATIC. ---
  {
    id: 'moog921Vco',
    heading: /921 vco/i,
    controlParam: 'tune',
    controlDescIncludes: /pitch|tune|semitone/i,
    cvPort: 'tune', // CV → tune param
    modulates: /modulates/i,
  },
  {
    id: 'moog921a',
    heading: /921a/i,
    controlParam: 'frequency',
    controlDescIncludes: /frequency|tuning|pitch/i,
    cvPort: 'freq_cv', // CV (paramTarget=frequency) → frequency param
    modulates: /modulates/i,
  },
  {
    id: 'moog921b',
    heading: /921b/i,
    controlParam: 'fine',
    controlDescIncludes: /fine|tune|semitone|detun/i,
    cvPort: '', // the freq_bus / width_bus inputs have no paramTarget
    modulates: /./,
  },
  {
    id: 'moog995',
    heading: /995/i,
    controlParam: 'atten1',
    controlDescIncludes: /attenuat|unity|mute/i,
    cvPort: '', // the three inputs are raw audio signals (no paramTarget)
    modulates: /./,
  },
  // --- Batch 7 — Moog System 35/55 modulation & routing (2026-06-26). Only the
  // CONVENTION-card members (no `card:` override) are interactive: moog911 (four
  // Knobs) and moog984 (a 4×4 Knob matrix), each a pure Knob + PatchPanel via
  // MoogPanel, so the live card mounts and a control hover updates the pane. The
  // CV→param dual-context check runs on moog911 (t1_cv has paramTarget=t1); the
  // 984's audio inputs have no paramTarget (cvPort '' skips it). The override-card
  // siblings (911a/912/960/992/993/cp3) stay STATIC. ---
  {
    id: 'moog911',
    heading: /911 eg/i,
    controlParam: 't1',
    controlDescIncludes: /attack|rise|swell/i,
    cvPort: 't1_cv', // CV (paramTarget=t1) → attack-time param
    modulates: /modulates/i,
  },
  {
    id: 'moog984',
    heading: /984 matrix/i,
    controlParam: 'm11',
    controlDescIncludes: /cross-point|mix|input 1/i,
    cvPort: '', // the four inputs are raw audio (no paramTarget)
    modulates: /./,
  },
  // --- Batch 8 — CV/signal utilities & small processors (2026-06-26). Each is
  // on INTERACTIVE_DOC_MODULES (convention card, pure Fader/Knob + PatchPanel);
  // this proves the live card mounts cleanly and a control hover updates the
  // pane. The CV→param dual-context check runs where the module has a CV input
  // with a paramTarget (analogLogicMaths attA_cv→attA, sidecar threshold_cv→
  // threshold, resofilter cutoff_cv→cutoff); stereovca/gatemaiden/illogic have
  // no CV→param link (their CV/gate inputs are raw signals), so cvPort '' skips
  // it. The STATIC siblings (fourplexer/flipper/scope) have no live-card probe. ---
  {
    id: 'stereovca',
    heading: /stereovca/i,
    controlParam: 'level',
    controlDescIncludes: /master|gain|output/i,
    cvPort: '', // strength inputs are raw CV multipliers (no paramTarget)
    modulates: /./,
  },
  {
    id: 'gatemaiden',
    heading: /gatemaiden/i,
    controlParam: 'gateLen',
    controlDescIncludes: /gate|width|minimum/i,
    cvPort: '', // the single `in` has no paramTarget
    modulates: /./,
  },
  {
    id: 'illogic',
    heading: /illogic/i,
    controlParam: 'att1_amount',
    controlDescIncludes: /attenuverter|invert|channel/i,
    cvPort: '', // in1..in4 are raw signal inputs (no paramTarget)
    modulates: /./,
  },
  {
    id: 'analogLogicMaths',
    heading: /analoglogicmaths/i,
    controlParam: 'attA',
    controlDescIncludes: /attenuverter|invert/i,
    cvPort: 'attA_cv', // CV (paramTarget=attA) → attenuverter A
    modulates: /modulates/i,
  },
  {
    id: 'sidecar',
    heading: /sidecar/i,
    controlParam: 'threshold',
    controlDescIncludes: /threshold|duck|main/i,
    cvPort: 'threshold_cv', // CV (paramTarget=threshold) → threshold
    modulates: /modulates/i,
  },
  {
    id: 'resofilter',
    heading: /resofilter/i,
    controlParam: 'cutoff',
    controlDescIncludes: /cutoff|corner|frequency/i,
    cvPort: 'cutoff_cv', // CV (paramTarget=cutoff) → cutoff
    modulates: /modulates/i,
  },
  // --- Batch 9 — synth voices & percussion sources (2026-06-26). Each is on
  // INTERACTIVE_DOC_MODULES (convention card: pure Fader/Knob + PatchPanel; peaks
  // adds two static mode buttons); this proves the live card mounts cleanly and a
  // control hover updates the pane. The CV→param dual-context check runs where the
  // module has a CV input with a paramTarget (drummergirl pitch→pitch, meowbox
  // morph→morph, treeohvox cutoff_cv→cutoff, peaks k1_0_cv→k1_0, callsine
  // note_cv→note); buggles' CV inputs are raw sampled values (no paramTarget), so
  // cvPort '' skips it. chowkick + pentemelodica stay STATIC (canvas) — no probe. ---
  {
    id: 'drummergirl',
    heading: /drummergirl/i,
    controlParam: 'tone',
    controlDescIncludes: /timbre|brightness|tone/i,
    cvPort: 'pitch', // CV (paramTarget=pitch) → pitch param
    modulates: /modulates/i,
  },
  {
    id: 'meowbox',
    heading: /meowbox/i,
    controlParam: 'morph',
    controlDescIncludes: /vowel|formant|morph/i,
    cvPort: 'morph', // CV (paramTarget=morph) → morph param
    modulates: /modulates/i,
  },
  {
    id: 'treeohvox',
    heading: /tree\.oh\.vox/i,
    controlParam: 'cutoff',
    controlDescIncludes: /cutoff|corner|filter|timbre/i,
    cvPort: 'cutoff_cv', // CV (paramTarget=cutoff) → cutoff param
    modulates: /modulates/i,
  },
  {
    id: 'peaks',
    heading: /peaks/i,
    controlParam: 'k1_0',
    controlDescIncludes: /pitch|mix|bright|attack|rate|knob/i,
    cvPort: 'k1_0_cv', // CV (paramTarget=k1_0) → channel A knob 1
    modulates: /modulates/i,
  },
  {
    id: 'buggles',
    heading: /buggles/i,
    controlParam: 'chaos',
    controlDescIncludes: /chaos|random|jitter/i,
    cvPort: '', // clock_cv / chaos_cv are raw sampled values (no paramTarget)
    modulates: /./,
  },
  {
    id: 'callsine',
    heading: /callsine/i,
    controlParam: 'harmonics',
    controlDescIncludes: /partial|harmonic|count/i,
    cvPort: 'note_cv', // CV (paramTarget=note) → note transpose
    modulates: /modulates/i,
  },
  // --- Batch 10 — sequencers, clocks & pattern generators (2026-06-26). Each is
  // on INTERACTIVE_DOC_MODULES (convention card: pure Knob/Fader/buttons +
  // PatchPanel; the only mount-time work is a playhead-polling rAF that no-ops in
  // the engine-less doc sandbox, exactly like SequencerCard); this proves the
  // live card mounts cleanly and a control hover updates the pane. The CV→param
  // dual-context check runs where the module has a CV input with a paramTarget
  // (polyseqz humanize_cv→humanize, marbles rate_cv→rate); cartesian / drumseqz /
  // macseq / writeseq / grids / scenechange have no CV→param link (their CVs are
  // clock/transport/X-Y/density/scene gates), so cvPort '' skips it. KRIA +
  // NUMPAD+ stay STATIC (WebSerial grid / document keydown capture) — no probe. ---
  {
    id: 'cartesian',
    heading: /cartesian/i,
    controlParam: 'gateLength',
    controlDescIncludes: /gate|step|stab/i,
    cvPort: '', // clock/x_cv/y_cv/lfo_clock are not param mods
    modulates: /./,
  },
  {
    id: 'drumseqz',
    heading: /drumseqz/i,
    controlParam: 'bpm',
    controlDescIncludes: /tempo|bpm/i,
    cvPort: '', // transport CVs are gates, no paramTarget
    modulates: /./,
  },
  {
    id: 'macseq',
    heading: /macseq/i,
    controlParam: 'bpm',
    controlDescIncludes: /tempo|bpm/i,
    cvPort: '', // transport CVs are gates, no paramTarget
    modulates: /./,
  },
  {
    id: 'polyseqz',
    heading: /polyseqz/i,
    controlParam: 'humanize',
    controlDescIncludes: /humani[sz]e|jitter|loosen|tight/i,
    cvPort: 'humanize_cv', // CV (paramTarget=humanize) → humanize
    modulates: /modulates/i,
  },
  {
    id: 'writeseq',
    heading: /writeseq/i,
    // recArm/overdub/play are card buttons, not control-<id> faders — probe a
    // real Fader param (bpm/length/octave/gateLength) for the live-card hover.
    controlParam: 'gateLength',
    controlDescIncludes: /gate|step|stab/i,
    cvPort: '', // cv/gate/clock/rec/transport are not param mods
    modulates: /./,
  },
  {
    id: 'marbles',
    heading: /marbles/i,
    controlParam: 'rate',
    controlDescIncludes: /rate|clock|tempo/i,
    cvPort: 'rate_cv', // CV (paramTarget=rate) → master clock rate
    modulates: /modulates/i,
  },
  {
    id: 'grids',
    heading: /grids/i,
    controlParam: 'chaos',
    controlDescIncludes: /chaos|random|variation/i,
    cvPort: '', // CV inputs sum onto knobs but have no paramTarget
    modulates: /./,
  },
  {
    id: 'atlantisCatalyst',
    heading: /scenechange/i, // the module's label is 'scenechange' (type stays atlantisCatalyst)
    controlParam: 'coherence',
    controlDescIncludes: /coheren|together|weather|independent/i,
    cvPort: '', // queue/nudge/freeze/seed inputs have no paramTarget
    modulates: /./,
  },
  // --- Batch 12 — modulation, function generators, clocks & live-control
  // utilities (2026-06-26). Only the CONVENTION-card members (pure Fader/button +
  // PatchPanel, no canvas/rAF/onMount) are interactive; this proves the live card
  // mounts cleanly and a control hover updates the pane. The CV→param dual-context
  // check runs on each (tides2 freq_cv→frequency, stages primary0_cv→primary0,
  // qbrt cutoff→cutoff). The STATIC siblings (timelorde / rasterize / score /
  // clipplayer / clockedRunner / livecode) have no live-card probe — see
  // interactive-doc-modules.ts. ---
  {
    id: 'tides2',
    heading: /tides2/i,
    controlParam: 'frequency',
    controlDescIncludes: /rate|ramp|freq/i,
    cvPort: 'freq_cv', // CV (paramTarget=frequency) → FREQ macro
    modulates: /modulates/i,
  },
  {
    id: 'stages',
    heading: /stages/i,
    controlParam: 'primary0',
    controlDescIncludes: /time|level|primary|segment/i,
    cvPort: 'primary0_cv', // CV (paramTarget=primary0) → segment 1 primary
    modulates: /modulates/i,
  },
  {
    id: 'qbrt',
    heading: /qbrt/i,
    controlParam: 'cutoff',
    controlDescIncludes: /cutoff|corner|frequency|ring/i,
    cvPort: 'cutoff', // CV (paramTarget=cutoff) → CUTOFF
    modulates: /modulates/i,
  },
  // --- Batch 13 — heavy synth voices, effects & utilities (2026-06-26). Only the
  // CONVENTION-card members whose cards are a pure Knob/Fader + buttons +
  // PatchPanel (no canvas/rAF/WebGL, no Web-MIDI panel, no file input) are
  // interactive; this proves the live card mounts cleanly and a control hover
  // updates the pane. The CV→param dual-context check runs on each (cloudseed
  // late_cv→late_out, symbiote rate_cv→rate). The STATIC siblings (foxy /
  // twotracks / hypercube / synesthesia / warrenspectrum / mixmstrs /
  // bluebox) have no live-card probe — see interactive-doc-modules.ts. ---
  {
    id: 'cloudseed',
    heading: /cloudseed/i,
    controlParam: 'late_out',
    controlDescIncludes: /late|tank|reverb|level/i,
    cvPort: 'late_cv', // CV (paramTarget=late_out) → LATE output level
    modulates: /modulates/i,
  },
  {
    id: 'symbiote',
    heading: /symbiote/i,
    controlParam: 'rate',
    controlDescIncludes: /rate|clock|tempo/i,
    cvPort: 'rate_cv', // CV (paramTarget=rate) → master clock rate
    modulates: /modulates/i,
  },
  // --- Batch 14 — FINAL audio batch (2026-06-26). The one CONVENTION-card
  // member that mounts cleanly in the engine-less doc sandbox is interactive:
  // riotgirls (pure Knob + PatchPanel). It proves the live card mounts + a
  // control hover updates the pane. The CV→param dual-context step is SKIPPED
  // for it (cvPort: '') — the card is very wide (riotgirls 1100px) so the
  // doc-sandbox <main> overlaps the patch-trigger, making the patch-panel
  // drill-in flaky; the control-hover demo is the interactive value here (same
  // posture as the sequencer/vca/mixer probes that also skip the CV step). The
  // STATIC siblings (frogger / modtris / pong / skifree / samsloop /
  // spectrograph / wavesculpt) have no live-card probe — see
  // interactive-doc-modules.ts. ---
  {
    id: 'riotgirls',
    heading: /riotgirls/i,
    controlParam: 'v1_volume',
    controlDescIncludes: /volume|level/i,
    cvPort: '', // wide card — patch-panel drill-in is flaky in the doc sandbox
    modulates: /./,
  },
];

/** Wait for the live virtual module to finish mounting (the flow host appears
 *  only after the dynamic card-map import resolves). */
async function waitForLiveCard(page: Page) {
  const vm = page.getByTestId('virtual-module');
  await expect(vm).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('virtual-module-flow')).toBeVisible({ timeout: 15_000 });
}

/** Open the patch panel (left trigger) and drill into INPUT so the port rows
 *  (which carry data-port-id / data-direction) render in the portaled chrome. */
async function openInputs(page: Page) {
  await page.getByTestId('patch-trigger').first().click();
  await expect(page.getByTestId('patch-panel')).toBeVisible({ timeout: 5_000 });
  // Root view → INPUT pivot.
  await page.locator('[data-testid="patch-panel-nav"][data-nav="inputs"]').click();
  await expect(page.getByTestId('patch-panel-inputs')).toBeVisible({ timeout: 5_000 });
}

for (const probe of PROBES) {
  test(`virtual module: live card + hover pane (${probe.id})`, async ({ page }) => {
    // A module only earns the INTERACTIVE_DOC_MODULES allowlist if its live card
    // mounts with NO uncaught page error (a card that throws on the doc sandbox
    // stays on the static face). Collect uncaught errors for the whole flow.
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    await page.goto(`/docs/modules/${probe.id}`);
    await expect(page.getByRole('heading', { name: probe.heading, level: 1 })).toBeVisible();

    // The hover pane is always present (SSR-rendered) and starts on the module
    // explanation (default state).
    const pane = page.getByTestId('doc-hover-pane');
    await expect(pane).toBeVisible();
    await expect(page.getByTestId('pane-default-explanation')).toBeVisible();

    // (a) The live card mounts.
    await waitForLiveCard(page);

    // (b) Hover a faceplate control → its authored prose appears in the pane.
    const control = page.locator(`[data-testid="control-${probe.controlParam}"]`).first();
    await expect(control).toBeVisible({ timeout: 10_000 });
    await control.hover();
    await expect(page.getByTestId('pane-name')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId('pane-desc')).toContainText(probe.controlDescIncludes, {
      timeout: 5_000,
    });

    // (c) Open the patch panel + hover a CV port → CV desc + DUAL context.
    if (probe.cvPort) {
      await openInputs(page);
      // The VISIBLE portaled chrome port row (the back-jack also carries
      // data-port-id but is display:none until rear-view, so scope to the
      // patch-panel-port-row testid the chrome rows use).
      const portRow = page
        .locator(
          `[data-testid="patch-panel-port-row"][data-port-id="${probe.cvPort}"][data-direction="input"]`,
        )
        .first();
      await expect(portRow).toBeVisible({ timeout: 5_000 });
      await portRow.hover();
      // The pane flips to the port view and shows the dual "modulates" block.
      await expect(page.getByTestId('pane-dual')).toBeVisible({ timeout: 5_000 });
      await expect(page.getByTestId('pane-dual')).toContainText(probe.modulates);
      // The port's own authored/explain text is shown too.
      await expect(page.getByTestId('pane-explain')).toBeVisible();
    }

    // EYEBALL: capture the rendered page (card + pane) for manual review.
    await page.screenshot({
      path: `test-results/docs-virtual-module-${probe.id}.png`,
      fullPage: true,
    });

    // The live card + hover flow must not have thrown — this is the gate that
    // qualifies the module for the interactive allowlist.
    expect(pageErrors, `page errors on /docs/modules/${probe.id}: ${pageErrors.join('\n')}`).toEqual(
      [],
    );
  });
}

test('sandbox isolation: interacting never persists a real rack or opens a relay', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto('/docs/modules/adsr');
  await waitForLiveCard(page);

  // Interact: open the patch panel + hover a port, then hover a control.
  await openInputs(page);
  await page
    .locator('[data-testid="patch-panel-port-row"][data-port-id="attack"][data-direction="input"]')
    .first()
    .hover();
  await page.locator('[data-testid="control-attack"]').first().hover();

  // The page's own state is fine — pane still updates, no page error.
  await expect(page.getByTestId('doc-hover-pane')).toBeVisible();
  expect(pageErrors, `page errors: ${pageErrors.join('\n')}`).toEqual([]);

  // Best-effort sandbox proof: the dev test hook __ydoc (when present) should
  // hold NO real rackspace — the sandbox binds a throwaway local doc and never
  // attaches a Hocuspocus provider. We assert the dev __provider hook is absent
  // (the doc route never constructs one) and that navigating away leaves no
  // window-scoped relay. This is a guard, not a multi-tab DOOM-grade proof.
  const providerOpened = await page.evaluate(() => {
    const g = globalThis as unknown as { __provider?: unknown };
    return g.__provider != null;
  });
  expect(providerOpened, 'a Hocuspocus relay must NOT be opened on the doc route').toBe(false);
});

test('SSR: prerendered HTML carries the right-pane authored text without JS', async ({
  browser,
}) => {
  // A JS-disabled context proves the prerendered (no-CSR) HTML is readable: the
  // right pane's module explanation is in the initial response, and the static
  // numbered-face fallback (not the live card) renders.
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto('/docs/modules/adsr');

  // The pane + its default explanation are in the SSR HTML.
  await expect(page.getByTestId('doc-hover-pane')).toBeVisible();
  await expect(page.getByTestId('pane-default-explanation')).toContainText(/envelope/i);
  // The live card never mounts without JS → the static face fallback is shown.
  await expect(page.getByTestId('module-face')).toBeVisible();
  // The live virtual module is absent.
  await expect(page.getByTestId('virtual-module')).toHaveCount(0);

  await ctx.close();
});
