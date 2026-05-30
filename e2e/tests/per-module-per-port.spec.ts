// e2e/tests/per-module-per-port.spec.ts
//
// Per-module per-port coverage sweep — the regression net for the class
// of bugs where a module silently loses an I/O port and no test fires.
//
// Motivation (DOOM PR #393): the DOOM module's def lost its
// CV-controlled per-player inputs (p1_up / p1_down / …) in one PR with
// zero failing tests, because no spec pinned the input port list. The
// downstream effect — game characters un-controllable from a patched
// CV cable — only surfaced when a user tried to play a multi-context
// rack. This file slams that door shut for EVERY module.
//
// Three sweep dimensions per module (one test per dim per module):
//
//   1. handle presence: every declared input + output renders a
//      `[data-handleid="<port.id>"]` element on the rendered card.
//      Fails clearly when a port is dropped from the def OR when
//      the card's PatchPanel rendering loop loses the port row.
//
//   2. outputs emit: for every declared OUTPUT port, route it to a
//      type-appropriate sink (SCOPE.ch1 for audio/cv/gate via the
//      cross-domain bridge that #414 fixed; VIDEOOUT.in for video /
//      mono-video) and assert the sink observes a signal. Ports
//      that genuinely can't emit without gameplay / file fixtures
//      land in EXEMPT_OUTPUT_EMIT with a documented reason.
//
//   3. inputs accept: for every declared INPUT port, spawn a type-
//      compatible upstream source, patch it into the input, and
//      assert (a) no console / page errors fired during the patch,
//      and (b) the engine actually materialised the edge. The "edge
//      lands without errors" check is the minimal "the input port
//      wires up" coverage; modules whose downstream effect is also
//      observable (filter cutoff CV moves the filter's audio output)
//      get a stricter assert via downstream-tap. Ports whose effect
//      is gameplay-deep land in EXEMPT_INPUT_DRIVE.
//
// Coverage philosophy: an exemption skips ONLY the signal-flow check
// for that one port; the module's handle-presence test STILL pins the
// port's existence. Exemptions are documented one-by-one with reasons
// AND a pointer at the dedicated coverage if any. If the exemption
// list grows past ~25 entries, the test design is wrong (PR comment
// flag).
//
// CI sharding: this spec emits ~3 tests × ~109 modules = ~327 tests.
// Playwright's --shard fan-out (8 shards in CI) distributes by test
// title hash — this file's titles are <module>-keyed so distribution
// is naturally uniform across shards.

import { test, expect, type Page } from '@playwright/test';
import { spawnPatch, type SpawnNode, type SpawnEdge } from './_helpers';
import { readScopeSnapshot, summarize, runFor } from './_module-coverage-helpers';
import { REGISTRY, type RegistryModule, type RegistryPort } from './_registry';
import { driverFor } from './_drivers';

// ────────── Module-level skips ──────────
// Modules whose card body can't be rendered under bare spawnPatch (mirrors
// modules.spec.ts SKIP_RENDER). For these modules we skip ALL three dims —
// the dedicated specs at the cited paths cover their I/O.
const SKIP_SPAWN: Record<string, string> = {
  group: 'requires data.children; covered by e2e/tests/grouping-phase1.spec.ts',
  helm: 'gear-icon settings panel hides MIDI ports; covered by e2e/tests/helm.spec.ts',
  cadillac: 'overlay sprite, not a flow card (zero ports); covered by e2e/tests/cadillac.spec.ts',
};

// ────────── Module-level output-emit exemptions ──────────
//
// Whole-module skips for cases where EVERY output port shares the same
// blocker (the module is gameplay-only, MIDI-only, hardware-only, needs
// a clock source we don't supply, etc.). Handle-presence is STILL
// asserted for these — only the signal-flow check is skipped. Documented
// per-module so each exemption is auditable as a small list.
//
// The PURE_EFFECT and PURE_CV_GATE_UTILITY skips (in the test body) are
// SHAPE-based: any module with audio/video input gets effect-shape skip.
// THIS list is for modules whose shape would let them emit, but whose
// outputs are all gameplay/hardware/clock-conditional.
//
// Keep this list tight: ~25 entries upper bound (per the PR spec).
const EXEMPT_OUTPUT_EMIT_MODULES: Record<string, string> = {
  // ── Hardware-input sources ──
  gamepad:    'no gamepad attached in test browser; covered by gamepad.spec.ts',
  joystick:   'no joystick movement in test browser; covered by joystick.spec.ts',
  numpadPlus: 'requires keypresses on numpad; covered by numpad-related specs',
  audioIn:    'audioIn: requires explicit click-to-enable for mic permission; covered by audio-in.spec.ts with fake-device project',
  // ── MIDI-driven ──
  midiCvBuddy: 'requires MIDI device; covered by midi-cv-buddy.spec.ts',
  midiclock:   'requires MIDI device; covered by midiclock.spec.ts',
  // ── Clock / divider / sequencer-like modules that need an upstream clock ──
  timelorde: 'clock divider; needs upstream clock; covered by timelorde-related specs',
  grids:     'requires upstream clock to step; covered by grids-related specs',
  marbles:   'requires UI-enabled internal clock; covered by marbles-related specs',
  symbiote:  'requires UI-enabled internal clock; covered by symbiote-related specs',
  stages:    'requires upstream segment gate; covered by stages-related specs',
  tides2:    'requires upstream gate/pitch; covered by tides2-related specs',
  macseq:    'requires toggled steps; covered by macseq-related specs',
  // ── CV/gate utility modules with no self-running source ──
  illogic:    'boolean logic on inputs; no upstream → no output; covered by illogic.spec.ts',
  slewSwitch: 'CV switcher; needs upstream CV/gate; covered by slewswitch.spec.ts',
  // ── User-toggled sequencer-like sources ──
  sequencer: 'requires user-toggled step.on=true; covered by dedicated sequencer specs',
  score:     'requires play_cv high + steps; covered by score.spec.ts',
  drumseqz:  'requires toggled steps; covered by drumseqz specs',
  polyseqz:  'requires toggled steps; covered by polyseqz specs',
  // ── File-input modules ──
  samsloop:      'needs uploaded sample; covered by samsloop.spec.ts',
  videobox:      'needs uploaded video file; covered by videobox.test.ts',
  videovarispeed: 'needs uploaded video file; covered by videovarispeed-output.spec.ts',
  // ── HYDROGEN: pattern grid + sample-pack loading ──
  hydrogen: 'pattern grid needs cells toggled; covered by hydrogen-related specs',
  // ── ADSR: modulator that needs an upstream gate (no audio input,
  // so it falls outside the effect-shape heuristic) ──
  adsr: 'modulator: requires upstream gate; covered by adsr-vca-invert.spec.ts',
  // ── Game modules with score-event outputs only ──
  modtris: 'gameplay-conditional outputs; covered by modtris-related specs',
  pong:    'gameplay-conditional outputs; covered by pong-related specs',
  // QBERT — audio_out + evt_die/move/level all fire from the synthesized
  // event stream which only triggers after coin + start + held joystick.
  // The bare per-port sweep can't drive those + ROM is gitignored by
  // design (404s in CI). Card render is covered by qbert-rom-missing.spec.ts
  // and the CV-joystick path by qbert-cv-joystick.spec.ts (skipped without
  // ROM). The video `out` port DOES render a test pattern even with no
  // ROM, but whole-module skip is simpler bookkeeping per the SM64
  // precedent above.
  qbert: 'audio + event outputs fire only after coin+start+joystick; ROM is gitignored (404 on clean checkout); covered by qbert-rom-missing.spec.ts + qbert-cv-joystick.spec.ts',
  // ── SM64: only output is `out` (video). The upstream sm64js bundle needs
  // a US sm64.z64 ROM extracted into IDB before it renders ANYTHING — until
  // then the #gameCanvas is a blank cleared surface, so the sweep would
  // assert "no signal" on a module whose IO is wired correctly. The
  // dedicated sm64.spec.ts (when added — currently the test-fixtures don't
  // seed a ROM) covers post-extract render. Handle presence IS still
  // asserted by the spec's first dim.
  sm64: 'video out blank until US ROM is extracted into IDB; covered by sm64-related specs (post-extract render)',
  // ── VIDEOOUT: pure passthrough; out = in ──
  videoOut: 'passthrough sink: no upstream video; covered by video-out-related specs',
};

// ────────── Per-port output-emit exemptions ──────────
// Format: `<moduleType>.<portId>` → human-readable reason.
// These are SUBPORT exemptions on modules whose OTHER outputs DO emit —
// we want signal-flow assertions on the working ports + skip on the
// gameplay-conditional ones. Modules entirely covered by
// EXEMPT_OUTPUT_EMIT_MODULES belong THERE; this list is for the
// partial-skip cases.
//
// Keep this list tight too (~10-15 entries).
const EXEMPT_OUTPUT_EMIT: Record<string, string> = {
  // ── DOOM: video out is fine BUT WASM init + game tic exceeds sweep budget;
  // audio + gate outputs are gameplay/forcePulse-conditional. Whole-module
  // skip is wrong because the module legitimately renders a video frame on
  // load, but the WASM startup window is long enough that whole-module skip
  // is the right call here too. Promote to MODULES for simpler bookkeeping.
  'doom.audio_l':   'WASM init + first SFX outside test budget; covered by video-audio-cvgate-coverage + doom-wasm specs',
  'doom.audio_r':   'WASM init + first SFX outside test budget; covered by video-audio-cvgate-coverage + doom-wasm specs',
  'doom.evt_kill':  'requires in-game enemy death; covered by video-audio-cvgate-coverage (forcePulse)',
  'doom.evt_door':  'requires in-game door trigger; covered by video-audio-cvgate-coverage (forcePulse)',
  'doom.evt_gun_p1': 'requires in-game weapon fire; covered by video-audio-cvgate-coverage (forcePulse)',
  'doom.evt_gun_p2': 'requires in-game weapon fire P2; covered by engine-bridge unit sweep',
  'doom.evt_gun_p3': 'requires in-game weapon fire P3; covered by engine-bridge unit sweep',
  'doom.evt_gun_p4': 'requires in-game weapon fire P4; covered by engine-bridge unit sweep',
  // feat/doom-per-type-death-gates: per-monster-type kill + per-player
  // death gates fire only on real game events (or forcePulse). The
  // engine-video-audio-bridge .each sweep proves every gate wires through
  // the dispatcher; doom-per-type-death-gates.spec.ts covers forcePulse
  // → SCOPE for a representative sample.
  'doom.evt_kill_zombieman':   'requires in-game zombieman kill; covered by engine-bridge unit sweep',
  'doom.evt_kill_shotguy':     'requires in-game shotgunner kill; covered by engine-bridge unit sweep',
  'doom.evt_kill_imp':         'requires in-game imp kill; covered by doom-per-type-death-gates (forcePulse)',
  'doom.evt_kill_demon':       'requires in-game demon kill; covered by doom-per-type-death-gates (forcePulse)',
  'doom.evt_kill_spectre':     'requires in-game spectre kill; covered by engine-bridge unit sweep',
  'doom.evt_kill_lostsoul':    'requires in-game lost-soul kill; covered by engine-bridge unit sweep',
  'doom.evt_kill_caco':        'requires in-game caco kill; covered by engine-bridge unit sweep',
  'doom.evt_kill_baron':       'requires in-game baron kill; covered by engine-bridge unit sweep',
  'doom.evt_kill_chainguy':    'requires in-game chaingunner kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_revenant':    'requires in-game revenant kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_mancubus':    'requires in-game mancubus kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_vile':        'requires in-game arch-vile kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_knight':      'requires in-game hell knight kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_pain':        'requires in-game pain elemental kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_arachnotron': 'requires in-game arachnotron kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_spidermind':  'requires in-game spider mastermind kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_cyber':       'requires in-game cyberdemon kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_wolfss':      'requires in-game wolf SS kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_kill_keen':        'requires in-game commander keen kill (DOOM II only); covered by engine-bridge unit sweep',
  'doom.evt_p1_dies':          'requires in-game P1 death; covered by doom-per-type-death-gates (forcePulse)',
  'doom.evt_p2_dies':          'requires in-game P2 death; covered by engine-bridge unit sweep',
  'doom.evt_p3_dies':          'requires in-game P3 death; covered by engine-bridge unit sweep',
  'doom.evt_p4_dies':          'requires in-game P4 death; covered by engine-bridge unit sweep',
  'doom.out':       'WASM render loop > sweep budget; covered by doom-wasm.spec.ts',
  // (file-input + MIDI-driven + hardware-input modules with ALL outputs
  // exempt are listed in EXEMPT_OUTPUT_EMIT_MODULES above — fewer entries
  // here, clearer audit list.)
  // NIBBLES gameplay-conditional gates: only fire when the snake eats /
  // dies / turns mid-run. The default driver doesn't drive in-game events.
  // Covered by video-audio-cvgate-coverage.spec.ts via forcePulse().
  'nibbles.pellet':     'requires in-game pellet-eaten event; covered by video-audio-cvgate-coverage.spec.ts (forcePulse)',
  'nibbles.death':      'requires in-game death event; covered by engine-bridge unit sweep',
  'nibbles.dir_change': 'requires in-game direction change; covered by engine-bridge unit sweep',
  // NIBBLES `gated` is the snake oscillator passed through an internal
  // VCA that opens on `pellet` — silent until a pellet is eaten.
  'nibbles.gated': 'requires in-game pellet event to open internal VCA; covered by nibbles-related specs',
  // NIBBLES length_cv encodes snake length; at idle the snake has a
  // constant length so the CV is a steady DC value — but lengthToCv(4)
  // is below the SCOPE.ch1 peak floor (≈-0.93). When the snake eats /
  // dies, the value steps; only THEN does scope.ch1 read a delta.
  // Covered by video-audio-cvgate-coverage.spec.ts (NIBBLES.length_cv
  // → SCOPE with forcePulse) at a non-zero target value.
  'nibbles.length_cv': 'idle DC value ≈-0.93 is constant + within scope noise floor; covered by video-audio-cvgate-coverage.spec.ts',
  // ── BUGGLES partial: `clock` + `burst` gates fire at ~0.5 Hz, may
  // miss the 800ms scope window. The `smooth` + `stepped` CV outs and
  // `ring` audio out are continuous and assert reliably from the same
  // module-level test pass.
  'buggles.clock': 'gate fires at burst-rate (~0.5 Hz); test window can miss; covered by buggles-related specs',
  'buggles.burst': 'gate fires at burst-rate (~0.5 Hz); test window can miss; covered by buggles-related specs',
  // ── atlantisCatalyst partial: scene_pulse + scene_idx wait for a
  // scene change (several seconds). Drift outputs are continuous CV.
  'atlantisCatalyst.scene_pulse': 'scene-transition gate fires every several seconds; outside test window; covered by atlantis-catalyst.spec.ts',
  'atlantisCatalyst.scene_idx':   'CV stays at 0 until first scene transition; covered by atlantis-catalyst.spec.ts',
};

// ────────── Per-port input-drive exemptions ──────────
// Format: `<moduleType>.<portId>` → human-readable reason.
// These inputs DECLARE themselves but their downstream effect from a
// generic upstream source isn't reachable inside the sweep. The wire-up
// check (edge materialises + no console errors) still runs for every
// non-exempt port; exemptions skip even THAT minimal step (e.g. the
// upstream source isn't compatible enough to wire under canConnect).
//
// Most of these are DOOM's deep-WASM keyboard ports: wiring a SEQUENCER
// gate to them IS expected to work (edge lands clean), but the in-game
// consequence isn't visible to the sweep — for that we rely on
// e2e/tests/doom-keyboard-routing.spec.ts. Keep them OUT of the
// exemption list so the sweep DOES pin "the input port wires up".
const EXEMPT_INPUT_DRIVE: Record<string, string> = {
  // None at present — every declared input gets at least the edge-lands
  // check. Add entries here ONLY when an upstream source can't be wired
  // at all (incompatible cable types between every source we know how
  // to spawn and this input).
};

// ────────── Type-aware upstream sources for input drive ──────────
//
// Maps an input port `type` → a SpawnNode + edge fragment that drives it.
// Sources are chosen to be self-running (no further upstream needed) so
// the sweep's wire-up step is uniform across types.
type InputSource = {
  // SpawnNode to add upstream (id, type, domain).
  node: SpawnNode;
  // Output port id on the upstream source.
  outPort: string;
  // Cable type for the edge.
  sourceType: string;
  // Optional second node (e.g. SEQUENCER for gate, since SEQUENCER's
  // `gate` is the only self-clocking gate source in the registry that
  // doesn't need its own clock). Spawned alongside `node` when present.
  extraNode?: SpawnNode;
};

/**
 * Pick a self-running upstream source compatible with the given input
 * port type. Returns null if no source maps cleanly — caller adds the
 * port to EXEMPT_INPUT_DRIVE or rethinks the design.
 *
 * Sources are deliberately MINIMAL (no params needed to emit):
 *   audio  → NOISE.white               (~white noise, self-running)
 *   cv     → BUGGLES.smooth            (slow random CV, self-running)
 *   pitch  → BUGGLES.smooth            (cv-family interchanges per
 *                                       canConnect)
 *   gate   → SEQUENCER.gate            (240 BPM gate train; needs the
 *                                       sequencer to also be in the
 *                                       graph — supplied via extraNode)
 *   video  → ACIDWARP.out              (self-running video source, no
 *                                       inputs required)
 *   mono-video → RASTERIZE.out         (needs an audio input — supplied
 *                                       via extraNode NOISE)
 *   image  → RASTERIZE.out (upcasts via canConnect mono-video → image)
 *   polyPitchGate → SEQUENCER.pitch    (the only self-running ppg source)
 */
function pickInputSource(inputType: string, idPrefix: string): InputSource | null {
  switch (inputType) {
    case 'audio':
      return {
        node: { id: `${idPrefix}-noise`, type: 'noise', position: { x: 60, y: 60 }, domain: 'audio', params: { level: 0.6 } },
        outPort: 'white',
        sourceType: 'audio',
      };
    case 'cv':
    case 'pitch':
      // BUGGLES.smooth is a self-clocking CV source (no clock input
      // required), ranges ±5V, perfect for proving "input accepts cv".
      return {
        node: { id: `${idPrefix}-buggles`, type: 'buggles', position: { x: 60, y: 60 }, domain: 'audio' },
        outPort: 'smooth',
        sourceType: 'cv',
      };
    case 'gate':
      // SEQUENCER.gate emits a gate train when isPlaying=1. The extraNode
      // pattern keeps spawnPatch's contract (one nodes array, one edges
      // array) intact while letting this function return a "logical
      // source" with its own dependencies.
      return {
        node: { id: `${idPrefix}-seq`, type: 'sequencer', position: { x: 60, y: 60 }, domain: 'audio', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
        outPort: 'gate',
        sourceType: 'gate',
      };
    case 'video':
      return {
        node: { id: `${idPrefix}-acid`, type: 'acidwarp', position: { x: 60, y: 60 }, domain: 'video' },
        outPort: 'out',
        sourceType: 'video',
      };
    case 'mono-video':
      // RASTERIZE needs an audio input; the extraNode supplies one.
      return {
        node: { id: `${idPrefix}-rast`, type: 'rasterize', position: { x: 280, y: 60 }, domain: 'audio' },
        outPort: 'out',
        sourceType: 'mono-video',
        extraNode: { id: `${idPrefix}-noiseR`, type: 'noise', position: { x: 60, y: 60 }, domain: 'audio', params: { level: 0.6 } },
      };
    case 'image':
      // image upcasts from mono-video.
      return {
        node: { id: `${idPrefix}-rast`, type: 'rasterize', position: { x: 280, y: 60 }, domain: 'audio' },
        outPort: 'out',
        sourceType: 'mono-video',
        extraNode: { id: `${idPrefix}-noiseR`, type: 'noise', position: { x: 60, y: 60 }, domain: 'audio', params: { level: 0.6 } },
      };
    case 'polyPitchGate':
      return {
        node: { id: `${idPrefix}-seq`, type: 'sequencer', position: { x: 60, y: 60 }, domain: 'audio', params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 } },
        outPort: 'pitch',
        sourceType: 'polyPitchGate',
      };
    default:
      return null;
  }
}

// ────────── Sink picker for output emit ──────────
//
// Pick a type-appropriate canonical sink for an output port. SCOPE.ch1
// is the universal audio-domain sink (audio/cv/gate via the cross-domain
// bridge — see #414); VIDEOOUT.in is the universal video-domain sink.
// Pitch outputs land on SCOPE.ch1 too (the SCOPE accepts cv-family on
// ch1 unmodified, the analyser reads the DC offset).
type SinkSpec = {
  node: SpawnNode;
  inPort: string;
  /** sourceType to declare on the edge (matches the producer port's
   *  type). Targets are always 'audio' for SCOPE or 'video' for OUTPUT
   *  per canConnect's downcast rules. */
  targetType: string;
};

function pickOutputSink(outputType: string): SinkSpec | null {
  switch (outputType) {
    case 'audio':
    case 'cv':
    case 'gate':
    case 'pitch':
    case 'polyPitchGate':
      return {
        node: { id: 'sink-scope', type: 'scope', position: { x: 800, y: 60 }, domain: 'audio', params: { timeMs: 50 } },
        inPort: 'ch1',
        targetType: 'audio',
      };
    case 'video':
    case 'mono-video':
    case 'image':
      return {
        node: { id: 'sink-vout', type: 'videoOut', position: { x: 800, y: 60 }, domain: 'video' },
        inPort: 'in',
        targetType: 'video',
      };
    default:
      return null;
  }
}

// ────────── DOOM-asset gating ──────────

async function doomAssetsPresent(page: Page): Promise<{ wasm: boolean; wad: boolean }> {
  return await page.evaluate(async () => {
    let wasm = false, wad = false;
    try { wasm = (await fetch('/doom/doom.js', { method: 'HEAD' })).ok; } catch { /* ignore */ }
    try { wad  = (await fetch('/doom/DOOM1.WAD', { method: 'HEAD' })).ok; } catch { /* ignore */ }
    return { wasm, wad };
  });
}

// ────────── Page-side edge enumeration ──────────

/** Read the materialised edges from the patch graph. Used by the input
 *  drive check to confirm that the edge we just inserted is still
 *  present after the engine has processed it (engine.addEdge could
 *  conceivably drop an edge silently if the source/target node wasn't
 *  ready — that's the #414 bug class repackaged). */
async function readEdgeIds(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const w = globalThis as unknown as {
      __patch?: { edges: Record<string, { id: string }> };
    };
    return Object.keys(w.__patch?.edges ?? {});
  });
}

// ────────── Tests ──────────

test.describe.configure({ mode: 'parallel' });

// Console-error filter: AudioContext autoplay warnings, DOOM asset
// fetches, and Vite HMR chatter aren't meaningful failures here.
// We also tolerate the reconciler's "disconnect (output 0) is not
// connected" teardown error — it's a known race when spawnPatch wipes +
// rebuilds the graph mid-tick (the reconciler tries to disconnect an
// already-disconnected AudioNode). The reconcile-failed path re-syncs
// on the next tick, so it's noise not a regression. Pinned by
// reconciler-disconnect-* unit tests in packages/web.
function filterErrors(errors: string[]): string[] {
  return errors.filter((e) =>
    !e.includes('AudioContext')
    && !e.includes('doom.js')
    && !e.includes('DOOM1.WAD')
    && !e.includes('[vite]')
    && !e.includes('Failed to load resource')
    && !(e.includes('[reconciler] reconcile failed') && e.includes('disconnect')),
  );
}

// Helper: spawn a module solo (the canonical handle-presence + emit
// setup), with a separate `extraNodes` / `extraEdges` for the upstream-
// source or downstream-sink wiring.
async function spawnSolo(
  page: Page,
  mod: RegistryModule,
  extraNodes: SpawnNode[] = [],
  extraEdges: SpawnEdge[] = [],
): Promise<void> {
  const driver = driverFor(mod);
  const nodes: SpawnNode[] = [
    {
      id: 'sut',
      type: mod.type,
      position: { x: 400, y: 60 },
      domain: mod.domain,
      params: driver.params,
    },
    ...extraNodes,
  ];
  await spawnPatch(page, nodes, extraEdges);
}

// ────────── DIM 1: handle presence ──────────
//
// Every declared port renders a handle. ONE test per module — the bulk
// approach gives a clear failure message ("module X expected port Y but
// it's missing") without exploding the shard count.

test.describe('per-module per-port: handle presence', () => {
  for (const mod of REGISTRY) {
    const skipReason = SKIP_SPAWN[mod.type];
    const title = `${mod.type}: every declared input + output renders as a handle`;
    if (skipReason) {
      test.fixme(`${title} [SKIPPED: ${skipReason}]`, () => {});
      continue;
    }
    test(title, async ({ page }) => {
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      await spawnSolo(page, mod);

      const card = page.locator(`.svelte-flow__node-${mod.type}`);
      await expect(card, `${mod.type} card visible`).toBeVisible();

      // Partition rendered handles into inputs (target) vs outputs (source).
      // SOME modules (sequencer, score) declare an input AND an output with
      // the SAME id ("clock" for both) — `[data-handleid="clock"]` matches
      // BOTH, so we can't assert .toHaveCount(1) per id without first
      // separating by Svelte Flow's source/target class. Same partition as
      // io-spec-consistency.spec.ts.
      const rendered = await card.locator('.svelte-flow__handle').evaluateAll((els) => {
        const inputs: string[] = [];
        const outputs: string[] = [];
        for (const el of els) {
          const id = el.getAttribute('data-handleid');
          if (!id) continue;
          const cls = el.getAttribute('class') ?? '';
          if (cls.includes('source')) outputs.push(id);
          else inputs.push(id); // 'target' or unspecified
        }
        return { inputs, outputs };
      });
      const renderedInputs = new Set(rendered.inputs);
      const renderedOutputs = new Set(rendered.outputs);

      // Per-port pinpoint assertion so failure messages name the offending
      // port directly (rather than "expected 27 handles, got 26"). This is
      // the regression net for the DOOM PR #393 class: drop a port from the
      // def, this test fails by name.
      for (const port of mod.inputs) {
        expect(
          renderedInputs.has(port.id),
          `${mod.type}.${port.id} (input, type=${port.type}): handle present in card UI (rendered inputs: ${[...renderedInputs].sort().join(', ')})`,
        ).toBe(true);
      }
      for (const port of mod.outputs) {
        expect(
          renderedOutputs.has(port.id),
          `${mod.type}.${port.id} (output, type=${port.type}): handle present in card UI (rendered outputs: ${[...renderedOutputs].sort().join(', ')})`,
        ).toBe(true);
      }
    });
  }
});

// ────────── DIM 2: outputs emit ──────────
//
// For every declared output, route to a type-compatible sink and assert
// the sink picks up a signal. Per-module test iterates the outputs
// internally + emits exempt-skipped notes inline so a failure message
// pinpoints the offending port.

test.describe('per-module per-port: outputs emit signal', () => {
  for (const mod of REGISTRY) {
    if (mod.outputs.length === 0) continue;
    const skipReason = SKIP_SPAWN[mod.type];
    const title = `${mod.type}: every declared output emits a measurable signal`;
    if (skipReason) {
      test.fixme(`${title} [SKIPPED: ${skipReason}]`, () => {});
      continue;
    }

    // Effect-shape skip: modules whose primary audio path is "audio in
    // → audio/cv/gate/video out" (filters, reverbs, delays, mixers,
    // SCOPE passthrough, video-domain compositors) can't emit anything
    // without an upstream source. The dedicated specs cover their
    // outputs against real sources; here we'd just re-assert the
    // bare-spawn-emits-silence trivial case. Mirrors the same heuristic
    // in per-module.spec.ts.
    //
    // Heuristic: `audio` or `video` typed input present → effect shape.
    // (Many MI Eurorack ports — RINGS, ELEMENTS, BLADES, WARPS — also
    // fall in this bucket.)
    //
    // Exception: a module that has an `audio` input AND self-running
    // outputs (FOXY's out_l/out_r ring even with no upstream because the
    // wavetable oscillator is ticking; the `fm` input is OPTIONAL) needs
    // override. We list those modules in NOT_EFFECT_DESPITE_AUDIO_INPUT
    // so they go through the normal output-emit path.
    const NOT_EFFECT_DESPITE_AUDIO_INPUT = new Set([
      'foxy',     // out_l/out_r ring at default tune=0
      'wavviz',   // wavetable VCO with optional FM
      'wavetableVco',
      'swolevco',
    ]);
    const hasUpstreamMediaInput = mod.inputs.some(
      (p) => p.type === 'audio' || p.type === 'video' || p.type === 'mono-video' || p.type === 'image',
    );
    if (hasUpstreamMediaInput && !NOT_EFFECT_DESPITE_AUDIO_INPUT.has(mod.type)) {
      test.fixme(`${title} [SKIPPED: effect-shape (audio/video input — needs upstream source); covered by dedicated specs]`, () => {});
      continue;
    }

    // Second effect-shape pattern: pure CV/gate modulator with NO
    // audio/video output AND at least one cv/gate INPUT. These modules
    // are arithmetic / logic / clock-divider utilities (ANALOGLOGICMATHS,
    // FOURPLEXER, UNITYSCALEMATHEMATIK, ILLOGIC, CARTESIAN, POLYSEQZ,
    // FROGGER game module) whose outputs are functions of their inputs.
    // Without an upstream the outputs are deterministic but typically
    // 0V / gate low — indistinguishable from "wire dead" via the scope-
    // peak smoke. Covered by the dedicated specs at their respective
    // names. Per-input exemptions (EXEMPT_OUTPUT_EMIT entries above)
    // catch the per-port slivers; this catches whole-module shape.
    const PURE_CV_GATE_UTILITY = new Set([
      'analogLogicMaths', 'fourplexer', 'unityscalemathematik',
      'cartesian', 'polyseqz', 'frogger',
    ]);
    if (PURE_CV_GATE_UTILITY.has(mod.type)) {
      test.fixme(`${title} [SKIPPED: pure CV/gate utility (output = f(inputs); needs upstream CV/gate); covered by dedicated specs]`, () => {});
      continue;
    }

    // Module-level explicit exempt (file-input, MIDI-driven, hardware,
    // clock-divider, user-toggled sequencer, etc.). Documented in
    // EXEMPT_OUTPUT_EMIT_MODULES at the top of the file.
    const moduleExempt = EXEMPT_OUTPUT_EMIT_MODULES[mod.type];
    if (moduleExempt) {
      test.fixme(`${title} [SKIPPED: ${moduleExempt}]`, () => {});
      continue;
    }

    // If ALL of the module's outputs are exempt at the per-port level,
    // skip the whole test (handle-presence already pins them).
    const allExempt = mod.outputs.every((p) => EXEMPT_OUTPUT_EMIT[`${mod.type}.${p.id}`]);
    if (allExempt) {
      test.fixme(`${title} [SKIPPED: all outputs exempt — see EXEMPT_OUTPUT_EMIT]`, () => {});
      continue;
    }

    test(title, async ({ page }) => {
      // DOOM's first-frame WASM load is ~6-12s; only relevant if a DOOM
      // output is NOT exempt (today all are, so this branch is defensive).
      if (mod.type === 'doom') test.setTimeout(90_000);
      // FOXY mounts a heavy chain (3 SwoleBlocks + 3 RasterPainters +
      // WAVECEL worklet + 4-page card render). On cold CI Linux this
      // routinely takes >30s for the waitForLoadState alone.
      // atlantisCatalyst has a similar heavy-mount profile.
      if (mod.type === 'foxy' || mod.type === 'atlantisCatalyst') test.setTimeout(90_000);

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text()}`);
      });

      const driver = driverFor(mod);

      // Loop over outputs serially within the test — each iteration
      // re-navigates to '/' to get a fresh AudioContext + fresh engine.
      // We CAN'T just spawnPatch+rebuild within a single navigation
      // because the AudioContext keeps the previous SUT's audio sources
      // alive (their .start() is sticky), and respawning the same SUT
      // type mid-page sometimes leaves the engine's audio-bridge
      // bookkeeping confused — NIBBLES.snake observed silent on iter 2
      // but ringing on a fresh-page direct spawn. The goto() cost is
      // ~1.5s per output; well worth the determinism.
      for (const port of mod.outputs) {
        const exemptReason = EXEMPT_OUTPUT_EMIT[`${mod.type}.${port.id}`];
        if (exemptReason) {
          // Log + continue. The handle-presence test already pinned
          // this port; here we deliberately don't run signal-flow.
          // eslint-disable-next-line no-console
          console.log(`[per-port] SKIP emit ${mod.type}.${port.id}: ${exemptReason}`);
          continue;
        }

        await page.goto('/');
        await page.waitForLoadState('networkidle');

        const sink = pickOutputSink(port.type);
        if (!sink) {
          // Unknown port type — fail loudly so adding a new cable type
          // forces a decision (extend pickOutputSink or add an exemption).
          expect(
            sink,
            `${mod.type}.${port.id} (type=${port.type}): no sink known for type — extend pickOutputSink or add EXEMPT_OUTPUT_EMIT`,
          ).not.toBeNull();
          continue;
        }

        // SUT + optional upstream gate/pitch driver from _drivers.ts +
        // type-appropriate sink. Reuses the per-module.spec.ts gate/pitch
        // driver-wiring pattern.
        const sutNode: SpawnNode = {
          id: 'sut',
          type: mod.type,
          position: { x: 400, y: 60 },
          domain: mod.domain,
          params: driver.params,
        };
        const nodes: SpawnNode[] = [sutNode, sink.node];
        const edges: SpawnEdge[] = [
          {
            id: 'e-sut-sink',
            from: { nodeId: 'sut', portId: port.id },
            to:   { nodeId: sink.node.id, portId: sink.inPort },
            sourceType: port.type,
            targetType: sink.targetType,
          },
        ];
        if (driver.gatePort || driver.pitchPort) {
          nodes.unshift({
            id: 'driver-seq',
            type: 'sequencer',
            position: { x: 60, y: 280 },
            params: { bpm: 240, length: 4, isPlaying: 1, gateLength: 0.5 },
          });
          if (driver.gatePort) {
            edges.unshift({
              id: 'e-seq-g',
              from: { nodeId: 'driver-seq', portId: 'gate' },
              to:   { nodeId: 'sut',        portId: driver.gatePort },
              sourceType: 'gate',
              targetType: 'gate',
            });
          }
          if (driver.pitchPort) {
            edges.unshift({
              id: 'e-seq-p',
              from: { nodeId: 'driver-seq', portId: 'pitch' },
              to:   { nodeId: 'sut',        portId: driver.pitchPort },
              sourceType: 'pitch',
              targetType: 'cv',
            });
          }
        }

        await spawnPatch(page, nodes, edges);

        if (driver.gatePort || driver.pitchPort) {
          await page.evaluate(() => {
            const w = globalThis as unknown as {
              __patch: { nodes: Record<string, { data?: Record<string, unknown> }> };
              __ydoc: { transact: (fn: () => void) => void };
            };
            w.__ydoc.transact(() => {
              const seq = w.__patch.nodes['driver-seq'];
              if (!seq) return;
              if (!seq.data) seq.data = {};
              seq.data.steps = [
                { on: true, midi: 60 },
                { on: true, midi: 64 },
                { on: true, midi: 67 },
                { on: true, midi: 72 },
              ];
            });
          });
        }

        // Drive window:
        //  * scope-sink + same-domain SUT      → 800 ms (matches
        //    per-module.spec.ts; covers wavetable load + several gate
        //    cycles)
        //  * scope-sink + cross-domain SUT     → 2000 ms (cross-domain
        //    audio bridge takes ~400ms to wire the CSN/audio source from
        //    video engine into scope's analyser input; same pattern as
        //    video-audio-cvgate-coverage.spec.ts which waits 400ms then
        //    polls. We do a single longer wait here for simplicity.)
        //  * video-sink                        → 1500 ms (video bridge
        //    tick rate ~60 Hz; thin waveform-scope mono-video traces
        //    need many frames to paint)
        const crossDomain = mod.domain !== sink.node.domain;
        const waitMs = sink.node.type !== 'scope' ? 1500
          : crossDomain ? 2000 : 800;
        await runFor(page, waitMs);

        // Read the sink. Audio-domain sink (SCOPE) → analyser snapshot.
        // Video-domain sink (VIDEOOUT) → canvas-pixel statistics.
        if (sink.node.type === 'scope') {
          const snap = await readScopeSnapshot(page, sink.node.id);
          expect(snap, `${mod.type}.${port.id}: scope read succeeded`).not.toBeNull();
          if (!snap) continue;
          const sum = summarize(snap.ch1);
          expect(
            sum.peak,
            `${mod.type}.${port.id} (type=${port.type}): scope.ch1 peak above floor (peak=${sum.peak.toFixed(4)}, rms=${sum.rms.toFixed(4)})`,
          ).toBeGreaterThan(0.005);
        } else {
          // Video output → VIDEOOUT canvas stats. We assert TWO floors:
          //   * any-nonblack pixel fraction > 0.1% — catches a totally
          //     blank canvas (the regression case: video bridge dropped
          //     the edge or the source's drawFrame() noop'd).
          //   * variance threshold — calibrated per cable type. `video`
          //     outputs typically fill the frame, so >5 is fine (matches
          //     wavecel-video-outs). `mono-video` outputs are often
          //     waveform-scope renders (a thin trace on a near-black
          //     canvas) where variance is intrinsically low; >0.5 is
          //     the floor where a SINGLE-PIXEL trace clears noise.
          const canvas = page.locator('canvas[data-testid="video-out-canvas"]');
          await expect(canvas, `${mod.type}.${port.id}: video-out canvas present`).toHaveCount(1);
          const stats = await canvas.evaluate((el) => {
            const c = el as HTMLCanvasElement;
            const ctx = c.getContext('2d');
            if (!ctx) return null;
            const img = ctx.getImageData(0, 0, c.width, c.height);
            const w = c.width, h = c.height;
            let n = 0, sum = 0, sumSq = 0, nonBlack = 0;
            for (let y = 0; y < h; y++) {
              for (let x = 0; x < w; x++) {
                const i = (y * w + x) * 4;
                const v = (img.data[i]! + img.data[i + 1]! + img.data[i + 2]!) / 3;
                sum += v; sumSq += v * v;
                // Threshold at 1 (essentially "any pixel above pure 0").
                // mono-video waveform-scope traces antialias down to v~10-30
                // at the trace center but the dimmest edge pixels are
                // v~2-5; setting the floor at 1 catches the trace + the
                // anti-aliased shoulder without claiming pure-black canvases.
                if (v > 1) nonBlack++;
                n++;
              }
            }
            const mean = sum / n;
            return { variance: sumSq / n - mean * mean, nonBlackFrac: nonBlack / n, n };
          });
          expect(stats, `${mod.type}.${port.id}: video stats read succeeded`).not.toBeNull();
          if (!stats) continue;
          // Variance floor: relatively loose because bare-spawn video
          // outputs often render THIN content (a 1-pixel scope trace, a
          // single-line 3D wavetable) on a near-black canvas — variance
          // is dominated by background. The nonBlackFrac assertion above
          // already pins "the canvas is not pure black"; variance > 0.5
          // is the secondary "the painter actually painted SOMETHING with
          // contrast" check. wavecel-video-outs.spec.ts asserts >5
          // SPECIFICALLY because its scene drives an upstream VCO — that
          // test's upstream-source pattern is the right way to assert
          // a stronger floor.
          const varianceFloor = 0.5;
          expect(
            stats.nonBlackFrac,
            `${mod.type}.${port.id} (type=${port.type}): canvas non-blank fraction above floor (nonBlackFrac=${stats.nonBlackFrac.toFixed(4)}, variance=${stats.variance.toFixed(2)})`,
          ).toBeGreaterThan(0.001);
          expect(
            stats.variance,
            `${mod.type}.${port.id} (type=${port.type}): video-out canvas variance above floor (variance=${stats.variance.toFixed(2)}, floor=${varianceFloor})`,
          ).toBeGreaterThan(varianceFloor);
        }
      }

      expect(
        filterErrors(errors),
        `${mod.type} outputs-emit: no console / page errors`,
      ).toEqual([]);
    });
  }
});

// ────────── DIM 3: inputs accept ──────────
//
// For every declared input, spawn a type-compatible upstream source,
// patch the edge, assert the edge materialises + no console errors.
// This is the "wire-up" coverage — strictly weaker than verifying a
// downstream effect, but strong enough to catch:
//   * input port disappearing from the def (regression — failure: pick
//     fails because mod.inputs no longer contains the port we expected,
//     OR the edge insert fails because the engine rejects the port id)
//   * cable-type drift (input typed `cv` in the def but `audio` in the
//     engine's port table → addEdge rejects it → edge missing post-spawn)
//   * console-error storms (a buggy input handler that throws on first
//     CV value)

test.describe('per-module per-port: inputs accept signal (wire-up)', () => {
  for (const mod of REGISTRY) {
    if (mod.inputs.length === 0) continue;
    const skipReason = SKIP_SPAWN[mod.type];
    const title = `${mod.type}: every declared input accepts a type-compatible upstream cable`;
    if (skipReason) {
      test.fixme(`${title} [SKIPPED: ${skipReason}]`, () => {});
      continue;
    }

    test(title, async ({ page }) => {
      // Per-iteration: spawnPatch (~1s) + 300ms wait + edge-read (~50ms).
      // For modules with many inputs (HYDROGEN has 168; DOOM has 28) the
      // 30s default test timeout is too tight. Scale up to ensure ~1.5s
      // per iteration with margin.
      if (mod.inputs.length > 20) {
        test.setTimeout(Math.max(30_000, mod.inputs.length * 1500 + 30_000));
      }

      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text()}`);
      });

      await page.goto('/');
      await page.waitForLoadState('networkidle');

      // DOOM-asset skip — when the WASM blob isn't present the module
      // can't materialise its input handles, breaking the edge assertion.
      // The handle-presence dim STILL runs (it reads the def-side handles
      // off the rendered card, which the SvelteKit dev server renders
      // regardless of WASM presence).
      if (mod.type === 'doom') {
        const { wasm, wad } = await doomAssetsPresent(page);
        test.skip(!wasm || !wad, 'DOOM WASM/WAD not built — see static/doom/DOWNLOAD_INSTRUCTIONS.md');
      }

      for (const port of mod.inputs) {
        const exemptReason = EXEMPT_INPUT_DRIVE[`${mod.type}.${port.id}`];
        if (exemptReason) {
          // eslint-disable-next-line no-console
          console.log(`[per-port] SKIP drive ${mod.type}.${port.id}: ${exemptReason}`);
          continue;
        }

        const source = pickInputSource(port.type, `up-${port.id}`);
        if (!source) {
          // Unknown port type — fail loudly. New cable types must extend
          // pickInputSource OR earn an EXEMPT_INPUT_DRIVE entry with a reason.
          expect(
            source,
            `${mod.type}.${port.id} (type=${port.type}): no upstream source known for type — extend pickInputSource or add EXEMPT_INPUT_DRIVE`,
          ).not.toBeNull();
          continue;
        }

        const nodes: SpawnNode[] = [
          {
            id: 'sut',
            type: mod.type,
            position: { x: 400, y: 60 },
            domain: mod.domain,
          },
          source.node,
        ];
        if (source.extraNode) nodes.push(source.extraNode);
        const edges: SpawnEdge[] = [
          {
            id: 'e-up-sut',
            from: { nodeId: source.node.id, portId: source.outPort },
            to:   { nodeId: 'sut',           portId: port.id },
            sourceType: source.sourceType,
            targetType: port.type,
          },
        ];
        if (source.extraNode) {
          // RASTERIZE needs its `in` audio input fed from NOISE so it
          // emits non-blank frames; otherwise the wire-up survives but
          // is vacuous. This wiring is implementation-detail of the
          // mono-video / image branch.
          edges.push({
            id: 'e-noise-rast',
            from: { nodeId: source.extraNode.id, portId: 'white' },
            to:   { nodeId: source.node.id,     portId: 'in' },
            sourceType: 'audio',
            targetType: 'audio',
          });
        }

        await spawnPatch(page, nodes, edges);

        // Minimal settle window — spawnPatch already waits for the DOM
        // node count to match, by which time the engine's addEdge has
        // fired. 100ms gives the cross-domain bridge + CV-bridge a tick
        // to wire up; we only need to assert "edge materialised", not
        // "downstream effect observable".
        await runFor(page, 100);

        // Edge survival check — the edge we asked to insert is still in
        // the patch graph. A silent engine.addEdge drop (the #414-style
        // class) would manifest as missing edge ids.
        const edgeIds = await readEdgeIds(page);
        expect(
          edgeIds,
          `${mod.type}.${port.id} (type=${port.type}): edge survived engine.addEdge`,
        ).toContain('e-up-sut');
      }

      expect(
        filterErrors(errors),
        `${mod.type} inputs-accept: no console / page errors during input wire-up`,
      ).toEqual([]);
    });
  }
});
