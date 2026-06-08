#!/usr/bin/env node
/**
 * Build packages/web/src/lib/ui/example-patches/gibribbon-demo.imp.json — the
 * GIBRIBBON (game demo) envelope. A complete audio→video signal chain that
 * DRIVES the GibRibbon game module from a sequenced MACROOSCILLATOR voice
 * analysed by SYNESTHESIA:
 *
 *   TIMELORDE ──2x──▶ MACSEQ ──pitch──▶ MACROOSCILLATOR ──out──▶ SYNESTHESIA(A)
 *        │              │  └─gate─▶ trig          (a_in)               │
 *        │              └─modelcv─▶ model_cv                4×env_slow ▼
 *        └──1x──────────────────────────────────────────────────▶ GIBRIBBON
 *                       MACSEQ.gate ───────────────────────────────▶ gate
 *               (a_band1..4_env_slow → cv1..cv4; TIMELORDE.1x → clock)
 *
 * Mirrors the shape of media-burn.imp.json / glitches.imp.json (PR #430): an
 * envelope JSON carrying `update` = base64(Y.encodeStateAsUpdate(ydoc)). The
 * runtime loader (loadEnvelopeIntoStore) decodes the update into a temp Y.Doc,
 * runs per-module migrations, then atomically swaps into the live store.
 *
 * Node `type`/`domain`/schemaVersions + PORT IDs are pinned 1:1 from the module
 * sources (NOT guessed):
 *   - timelorde      audio  schemaVersion 2  (timelorde.ts): out `2x` (8th),
 *                                            `1x` (quarter). undeletable.
 *   - macseq         audio  schemaVersion 1  (macseq.ts): in `clock`; out
 *                                            `pitch`/`gate`/`modelcv`/`clock`;
 *                                            per-step `data.steps[]` of
 *                                            {on, midi, model}. STEP_COUNT=128.
 *   - macrooscillator audio schemaVersion 1  (macrooscillator.ts): in
 *                                            `pitch`/`trig`/`model_cv`; out
 *                                            `out`/`aux`.
 *   - synesthesia    audio  schemaVersion 1  (synesthesia.ts): in `a_in`; the
 *                                            4 SLOW env CV outs for copy/ch A:
 *                                            `a_band{1..4}_env_slow`.
 *   - gibribbon      video  schemaVersion 1  (gibribbon.ts): in `cv1..cv4`
 *                                            (modsignal), `clock` (gate-typed
 *                                            1× tick), `gate` (beat).
 *
 * Run on-demand to regenerate:
 *   flox activate -- node scripts/build-gibribbon-demo-envelope.mjs
 */

import * as Y from 'yjs';
import { syncedStore, getYjsDoc } from '@syncedstore/core';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(
  __dirname,
  '..',
  'packages/web/src/lib/ui/example-patches/gibribbon-demo.imp.json',
);

// ── Pinned schemaVersions (mirror the module sources). ──────────────────────
const TIMELORDE_SCHEMA_VERSION = 2; // timelorde.ts
const MACSEQ_SCHEMA_VERSION = 1; // macseq.ts
const MACROOSCILLATOR_SCHEMA_VERSION = 1; // macrooscillator.ts
const SYNESTHESIA_SCHEMA_VERSION = 1; // synesthesia.ts
const GIBRIBBON_SCHEMA_VERSION = 1; // gibribbon.ts

// ── MACROOSCILLATOR model indices (mirror MODEL_NAMES in macseq.ts). ────────
const MODEL = {
  VA: 0,
  WAVESHAPE: 1,
  FM_2OP: 2,
  STRING: 6,
  KICK: 8,
  SNARE: 9,
  WAVETABLE: 11,
};

// ── MIDI note numbers (C4 = 60 convention, see note-entry.ts). ──────────────
//    c2=36 e2=40 c3=48 f3=53 a3=57 d2=38 d3=50 e3=52 — all inside macseq's
//    valid [33..114] range.
const N = { c2: 36, e2: 40, c3: 48, f3: 53, a3: 57, d2: 38, d3: 50, e3: 52 };
// Melodic note pool the product owner specified (excludes the kick/snare
// overrides below).
const NOTE_POOL = [N.c2, N.e2, N.c3, N.f3, N.a3, N.d2, N.d3, N.e3];

// MACSEQ step grid width (pinned to STEP_COUNT in macseq.ts).
const STEP_COUNT = 128;

// ── Program the 128-step pattern. ───────────────────────────────────────────
//   - KICK (model 8) on every 8th step (0, 8, 16, …) — pitch forced to c2.
//   - SNARE (model 9) on the ALTERNATING 8s (the back-beat: 4, 12, 20, …) —
//     pitch forced to c3.
//   - ~40% of the REMAINING steps left EMPTY (off).
//   - the rest cycle 2OP / STRING / WAVESHAPE voices with notes drawn from the
//     melodic pool.
// A small deterministic LCG drives the empty/voice/note choices so the demo is
// byte-stable across regenerations (no Math.random).
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    // xorshift32 — deterministic 0..1.
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 0xffffffff;
  };
}

const VOICE_CYCLE = [MODEL.FM_2OP, MODEL.STRING, MODEL.WAVESHAPE];

function buildSteps() {
  const rng = makeRng(0x61bb09); // fixed "GIBB" seed → byte-stable pattern
  const steps = [];
  let voiceCursor = 0;
  let noteCursor = 0;
  for (let i = 0; i < STEP_COUNT; i++) {
    if (i % 8 === 0) {
      // KICK on the down-beat 8s.
      steps.push({ on: true, midi: N.c2, model: MODEL.KICK });
      continue;
    }
    if (i % 8 === 4) {
      // SNARE on the back-beat (alternating 8s).
      steps.push({ on: true, midi: N.c3, model: MODEL.SNARE });
      continue;
    }
    // Remaining step: ~40% empty, else a cycling 2OP/STRING/WAVESHAPE voice.
    if (rng() < 0.4) {
      steps.push({ on: false, midi: N.c3, model: null });
      continue;
    }
    const model = VOICE_CYCLE[voiceCursor % VOICE_CYCLE.length];
    voiceCursor++;
    const midi = NOTE_POOL[noteCursor % NOTE_POOL.length];
    noteCursor++;
    steps.push({ on: true, midi, model });
  }
  return steps;
}

const steps = buildSteps();

// ── Layout (left→right signal flow). Coordinates scaled like media-burn. ─────
const POS = {
  timelorde:       { x: 0,    y: 40 },
  macseq:          { x: 340,  y: 40 },
  macrooscillator: { x: 720,  y: 40 },
  synesthesia:     { x: 1060, y: 40 },
  gibribbon:       { x: 1500, y: 40 },
};

// ── Node ids (stable). ──────────────────────────────────────────────────────
const ID = {
  timelorde: 'gib-demo-timelorde',
  macseq: 'gib-demo-macseq',
  macro: 'gib-demo-macrooscillator',
  synesthesia: 'gib-demo-synesthesia',
  gibribbon: 'gib-demo-gibribbon',
};

// ── Build the syncedStore + populate inside one transact (atomic update). ────
const store = syncedStore({ nodes: {}, edges: {} });
const ydoc = getYjsDoc(store);
// Pin the Yjs clientID so re-running this generator produces a BYTE-STABLE
// `update` blob (apart from `savedAt`). Y.Doc otherwise randomises clientID,
// which churns the committed .imp.json on every regen for no functional change.
ydoc.clientID = 0x61bb0d; // "GIBBOD" — arbitrary fixed id, scoped to this doc.

ydoc.transact(() => {
  // 1) TIMELORDE — system clock. Runs by default (running=1); a musical tempo.
  store.nodes[ID.timelorde] = {
    id: ID.timelorde,
    type: 'timelorde',
    domain: 'audio',
    position: POS.timelorde,
    params: { bpm: 120, running: 1, muteOutputs: 0 },
    data: {},
  };

  // 2) MACSEQ — 128-step sequencer. isPlaying=1 so it free-runs; length=128
  //    so the whole programmed pattern plays. The per-step pattern rides on
  //    node.data.steps (the live reader coerces it; see macseq.ts).
  store.nodes[ID.macseq] = {
    id: ID.macseq,
    type: 'macseq',
    domain: 'audio',
    position: POS.macseq,
    params: { bpm: 120, length: STEP_COUNT, octave: 0, gateLength: 0.5, isPlaying: 1 },
    data: { steps },
  };

  // 3) MACROOSCILLATOR — the voice MACSEQ plays. model is driven live by
  //    MACSEQ.modelcv → model_cv, so the static `model` param is just a
  //    sensible idle default. Healthy level so SYNESTHESIA sees signal.
  store.nodes[ID.macro] = {
    id: ID.macro,
    type: 'macrooscillator',
    domain: 'audio',
    position: POS.macrooscillator,
    params: {
      model: MODEL.FM_2OP,
      note: 0,
      harmonics: 0.4,
      timbre: 0.45,
      morph: 0.5,
      level: 0.85,
    },
    data: {},
  };

  // 4) SYNESTHESIA — analyses MACROOSCILLATOR on copy/channel A. Copy A in
  //    AUDIO mode (a_mode=0 → spectral bands). The 4 SLOW env-followers on A
  //    (a_band{1..4}_env_slow) become cv1..cv4 for GIBRIBBON. A master floor
  //    + per-band lift balances the 4 slow envelopes so EACH of cv1..cv4
  //    drives its game event (loop/jump/imp/zombie) at a playable rate (tuned
  //    against GIB_TUNING in gibribbon-events.ts).
  //
  //    RETUNED for the SYNESTHESIA #698 refactor (musical band edges
  //    200/1000/4000 Hz + a real envelope attack). The new wider band 2
  //    (200–1 kHz) and the steeper musical splits redistributed the voice's
  //    spectral energy: the kick/bass band (band1→cv1 loop) ran hot while the
  //    low-mid (band2→cv2 jump) and high-mid (band3→cv3 imp) bands fell well
  //    below GIB's 0.42 spawn threshold AND lost the per-tick "strongest
  //    channel" contest in chooseSpawn — so jump + imp went DEAD (0 spawns)
  //    while only loop + zombie fired. The old gains (master 1.35, gains
  //    [1.5,1.6,1.7,1.8]) were calibrated against the OLD (pre-#698) bands.
  //
  //    These gains were derived by rendering the demo's sequenced
  //    MACROOSCILLATOR voice through the REAL refactored synesthesia-dsp
  //    (renderSynesthesia) and balancing the four slow-env peaks (p90 ≈
  //    0.59/0.88/0.95/0.98) so the per-tick winner contest is near-even
  //    (cv1..4 ≈ 13/11/13/9 of the eligible ticks) and ALL FOUR event kinds
  //    spawn at a playable ~0.39 spawns/tick (loop/jump/imp/zombie ≈
  //    11/5/5/4 over a 64-tick bar — vs the old 13/0/0/10). band1 (kick) is
  //    pulled down and band2/band3 are lifted hardest because the kick band's
  //    energy is broadly present (high mean) while the low-mid/high-mid bands
  //    only peak transiently. cvSpawnThreshold in gibribbon-events.ts is left
  //    UNCHANGED — the gains alone re-balanced it. See the matching Phase-2
  //    calibration test in gibribbon-events.test.ts.
  store.nodes[ID.synesthesia] = {
    id: ID.synesthesia,
    type: 'synesthesia',
    domain: 'audio',
    position: POS.synesthesia,
    params: {
      a_mode: 0,
      a_master: 1.2,
      a_gain1: 1.4,
      a_gain2: 2.35,
      a_gain3: 3.9,
      a_gain4: 1.9,
    },
    data: {},
  };

  // 5) GIBRIBBON — the game. cv1..cv4 ← SYNESTHESIA A slow envelopes; clock ←
  //    TIMELORDE 1×; gate ← MACSEQ gate. All other inputs unpatched (the
  //    player drives ABXY).
  store.nodes[ID.gibribbon] = {
    id: ID.gibribbon,
    type: 'gibribbon',
    domain: 'video',
    position: POS.gibribbon,
    params: {},
    data: {},
  };

  // ── Edges. Canonical shape (graph/types.ts Edge):
  //   { id, source:{nodeId,portId}, target:{nodeId,portId}, sourceType, targetType }
  const edges = [
    // Transport: TIMELORDE 2× (8th) → MACSEQ clock; TIMELORDE 1× → GIBRIBBON clock.
    edge('e-tl-2x-macseq',  ID.timelorde, '2x',  ID.macseq,    'clock', 'gate', 'gate'),
    edge('e-tl-1x-gib',     ID.timelorde, '1x',  ID.gibribbon, 'clock', 'gate', 'gate'),
    // Sequenced voice: MACSEQ pitch/gate/modelcv → MACROOSCILLATOR.
    edge('e-ms-pitch-macro', ID.macseq, 'pitch',   ID.macro, 'pitch',    'pitch', 'pitch'),
    edge('e-ms-gate-macro',  ID.macseq, 'gate',    ID.macro, 'trig',     'gate',  'gate'),
    edge('e-ms-model-macro', ID.macseq, 'modelcv', ID.macro, 'model_cv', 'cv',    'cv'),
    // Voice → analysis: MACROOSCILLATOR out → SYNESTHESIA copy A in.
    edge('e-macro-syn', ID.macro, 'out', ID.synesthesia, 'a_in', 'audio', 'audio'),
    // Analysis → game: SYNESTHESIA A 4 slow envelopes → GIBRIBBON cv1..cv4.
    edge('e-syn-cv1', ID.synesthesia, 'a_band1_env_slow', ID.gibribbon, 'cv1', 'cv', 'modsignal'),
    edge('e-syn-cv2', ID.synesthesia, 'a_band2_env_slow', ID.gibribbon, 'cv2', 'cv', 'modsignal'),
    edge('e-syn-cv3', ID.synesthesia, 'a_band3_env_slow', ID.gibribbon, 'cv3', 'cv', 'modsignal'),
    edge('e-syn-cv4', ID.synesthesia, 'a_band4_env_slow', ID.gibribbon, 'cv4', 'cv', 'modsignal'),
    // Beat: MACSEQ gate → GIBRIBBON gate (biases which CV spawns on the beat).
    edge('e-ms-gate-gib', ID.macseq, 'gate', ID.gibribbon, 'gate', 'gate', 'gate'),
  ];
  for (const e of edges) store.edges[e.id] = e;
});

function edge(id, srcNode, srcPort, dstNode, dstPort, sourceType, targetType) {
  return {
    id,
    source: { nodeId: srcNode, portId: srcPort },
    target: { nodeId: dstNode, portId: dstPort },
    sourceType,
    targetType,
  };
}

// ── Envelope. moduleSchemas advertises the 5 types in the patch. ────────────
const envelope = {
  envelopeVersion: 1,
  savedAt: new Date().toISOString(),
  moduleSchemas: {
    timelorde: TIMELORDE_SCHEMA_VERSION,
    macseq: MACSEQ_SCHEMA_VERSION,
    macrooscillator: MACROOSCILLATOR_SCHEMA_VERSION,
    synesthesia: SYNESTHESIA_SCHEMA_VERSION,
    gibribbon: GIBRIBBON_SCHEMA_VERSION,
  },
  update: Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64'),
};

writeFileSync(OUT_PATH, JSON.stringify(envelope, null, 2));

// ── Report. ─────────────────────────────────────────────────────────────────
const onSteps = steps.filter((s) => s.on);
const kicks = steps.filter((s) => s.model === MODEL.KICK).length;
const snares = steps.filter((s) => s.model === MODEL.SNARE).length;
const empties = steps.filter((s) => !s.on).length;
const envKB = Math.round(JSON.stringify(envelope).length / 1024);
console.log(`Wrote ${OUT_PATH}`);
console.log(`  5 nodes (timelorde, macseq, macrooscillator, synesthesia, gibribbon), 11 edges, envelope ${envKB} kB`);
console.log(
  `  pattern: ${STEP_COUNT} steps — ${kicks} kick, ${snares} snare, ${empties} empty (${Math.round((empties / STEP_COUNT) * 100)}%), ${onSteps.length} gated`,
);
