// packages/web/src/lib/audio/modules/score.ts
//
// SCORE — sheet-music sequencer module. Renders 1..MAX_PAGES (4) pages of
// 4 rows × 4 bars each (4/4 fixed) as SVG and emits pitch / gate / env /
// clock CV. Internal ADSR (Faust adsr.wasm worklet) shapes the env output,
// scaled by the dynamic marker active at each tick (forward-fill: mf
// default, levels pp..ff).
//
// Scheduler model is the same two-clocks lookahead the Sequencer + Cartesian
// modules use: a Worker-driven scheduler-clock subscription reads node.params
// /data live, advances a 16th-rate tickIndex, and schedules pitch / gate /
// env events on the audio thread up to LOOKAHEAD_S ahead. External `clock`
// input overrides the internal BPM (rising-edge advance). The Worker tick
// keeps firing under main-thread blocking; the 200 ms lookahead absorbs any
// resulting backlog without audible jitter.
//
// Tie semantics: when a note is the start (or middle) of a tie chain we
// emit a SINGLE held gate covering the full chain duration. Only the LAST
// note in the chain triggers the gate-off. Mid-chain notes update pitch but
// keep the gate high — a single ADSR envelope shapes the entire span.
//
// Stop-bar + loop: when the playhead reaches the optional stop-music marker
// (or the end of the last allocated page when no marker is set) the engine
// either (a) stops if `loop` is false, or (b) wraps back to bar 0 if `loop`
// is true.
//
// Inputs:
//   clock (gate): external clock; rising edges advance one 16th. Unpatched = internal BPM drives.
//   attack / decay / sustain / release (cv, log/linear, paramTarget=…): displaces the internal ADSR stage.
//
// Outputs:
//   pitch (pitch): V/oct of the current note.
//   gate (gate): held high during note duration (ties hold across notes).
//   env (cv): the internal ADSR envelope, scaled by the active dynamic marker.
//   clock (gate): chained 16th-rate clock-out.
//
// Params:
//   bpm (linear 30..300, default 120): internal tempo.
//   attack / decay / release (log 0.001..10 s) + sustain (linear 0..1): internal ADSR shape.
//   isPlaying (discrete 0..1, default 0): transport state.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch } from '$lib/graph/store';
import { instantiateFaustModule } from '$lib/audio/faust-runtime';
import { midiToVOct } from '$lib/audio/note-entry';
import wasmUrl from '@patchtogether.live/dsp/dist/adsr.wasm?url';
import metaUrl from '@patchtogether.live/dsp/dist/adsr.json?url';
import workletUrl from '@patchtogether.live/dsp/dist/adsr.worklet.js?url';
import {
  BARS_PER_PAGE,
  DEFAULT_PAGES,
  DYNAMIC_SCALE,
  MAX_PAGES,
  TICKS_PER_BAR,
  coerceScoreData,
  dynamicAt,
  slotEmitPlan,
  tickWidth,
  tieChainFrom,
  tieRoleFor,
  type ScoreData,
  type ScoreNote,
} from './score-data';
import {
  createTransportCv,
  pickQueuedSlotFromEvents,
  TRANSPORT_CV_PORT_DEFS,
} from './transport-cv';
import {
  coerceSlots,
  coerceSlotKey,
  isInputPortConnected,
  shouldSequencerRun,
} from './transport-helpers';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import { createPlayheadTracker, createPlayheadTrackerOf } from './playhead-tracker';

const ADSR_PREFIX = '/ADSR';

// ⚠ ONE COERCION, SHARED WITH EVERY RENDERER. This used to be a twelve-line
// copy, and the legacy card and the quicksave snapshot each carried their own —
// three restatements of the same `pages` clamp and the same `stopBar` shape
// test. The faceplate's staff panel would have been the fourth, and a placement
// surface that disagreed with the playback surface about how many pages exist is
// the drift `score-data.ts`'s scheduler-grid note is about, one layer up.
function readScoreData(nodeId: string): ScoreData {
  return coerceScoreData(livePatch.nodes[nodeId]?.data);
}

export const scoreDef: AudioModuleDef = {
  type: 'score',
  palette: { top: 'Audio modules', sub: 'sequencers' },
  domain: 'audio',
  label: 'score',
  category: 'modulation',
  inputs: [
    { id: 'clock', type: 'gate', edge: 'trigger' },
    // CV scaling per docs/adr/004-cv-range-convention.md (mirrors ADSR's
    // own param scaling — SCORE forwards these directly to its embedded
    // ADSR worklet).
    { id: 'attack', type: 'cv', paramTarget: 'attack', cvScale: { mode: 'log' } },
    { id: 'decay', type: 'cv', paramTarget: 'decay', cvScale: { mode: 'log' } },
    { id: 'sustain', type: 'cv', paramTarget: 'sustain', cvScale: { mode: 'linear' } },
    { id: 'release', type: 'cv', paramTarget: 'release', cvScale: { mode: 'log' } },
    // Shared transport CV inputs (PR feat/sequencer-transport-quicksave):
    //   play_cv      → toggles isPlaying on rising edge
    //   reset_cv     → resets tickIndex to 0 on rising edge
    //   queue1..4_cv → queues slot N on rising edge
    ...TRANSPORT_CV_PORT_DEFS,
  ],
  outputs: [
    { id: 'pitch', type: 'pitch' },
    { id: 'gate', type: 'gate', edge: 'gate' },
    { id: 'env', type: 'cv' },
    { id: 'clock', type: 'gate', edge: 'trigger' },
  ],
  params: [
    { id: 'bpm', label: 'BPM', defaultValue: 120, min: 30, max: 300, curve: 'linear' },
    { id: 'attack', label: 'A', defaultValue: 0.005, min: 0.001, max: 10, curve: 'log', units: 's' },
    { id: 'decay', label: 'D', defaultValue: 0.1, min: 0.001, max: 10, curve: 'log', units: 's' },
    { id: 'sustain', label: 'S', defaultValue: 0.7, min: 0, max: 1, curve: 'linear' },
    { id: 'release', label: 'R', defaultValue: 0.3, min: 0.001, max: 10, curve: 'log', units: 's' },
    { id: 'isPlaying', label: 'Play', defaultValue: 0, min: 0, max: 1, curve: 'discrete' },
  ],

  // Module-grouping Phase 4 — Play/Stop is the canonical group-exposable.
  exposableControls: [
    { id: 'playStop', label: 'Play', kind: 'button', paramId: 'isPlaying' },
  ],
  // Instruments v1 — the score sheet is an atomically-exposable surface.
  exposesSequence: true,

  docs: {
    explanation:
      "A sheet-music sequencer — you write notes onto an actual staff and SCORE plays it back as pitch + gate + envelope CV. The page is up to 4 pages of four rows by four bars in 4/4; click on the staff to place notes with the toolbar's note-value tools (whole down to sixteenth, plus eighth-note triplets), add sharps/flats, tie notes together to hold them across beats, and drop dynamic markings (pp..ff) that scale the envelope's loudness. A playhead walks the score from its own BPM (or from an external clock patched into CLOCK IN, one rising edge per 16th); notes sound on the full 48-tick-per-bar grid, so triplets land between the 16ths rather than being rounded onto them. It carries a built-in ADSR envelope (the A/D/S/R knobs and CV inputs) that shapes the ENV output for each note; tied notes hold a single envelope across the whole tie. An optional stop-music marker ends or (with loop on) wraps the piece. The four pitch/gate/env/clock outputs drive a voice exactly like the step SEQUENCER, but the pattern is real notation rather than a step grid.",
    inputs: {
      clock:
        "External clock: each rising edge advances the playhead one 16th-note. Notes placed between 16ths (eighth-note triplets) still sound, at their exact fraction of the pulse. While patched the internal BPM is ignored; unpatch to fall back to the BPM clock.",
      attack:
        "CV that displaces the built-in ADSR's ATTACK time (log-scaled around the knob) — modulate it to make notes swell faster or slower.",
      decay: "CV that displaces the ADSR's DECAY time around the knob.",
      sustain: "CV that displaces the ADSR's SUSTAIN level around the knob.",
      release: "CV that displaces the ADSR's RELEASE time around the knob.",
      play_cv: "A rising edge toggles play/stop (each pulse flips the transport state).",
      reset_cv: "A rising edge snaps the playhead back to the top of the piece and restarts.",
      queue1_cv: "A rising edge queues saved pattern slot 1: it finishes the current pass, then switches to slot 1 and plays from the top (does nothing if slot 1 is empty).",
      queue2_cv: "A rising edge queues saved pattern slot 2 — applied at the end of the current pass, then plays slot 2 from the top.",
      queue3_cv: "A rising edge queues saved pattern slot 3 — applied at the end of the current pass, then plays slot 3 from the top.",
      queue4_cv: "A rising edge queues saved pattern slot 4 — applied at the end of the current pass, then plays slot 4 from the top.",
    },
    outputs: {
      pitch: "The current note's pitch as V/oct — emitted as each note is played, following the notes and accidentals you wrote on the staff.",
      gate: "Goes high while a note sounds and low between notes; a tie holds the gate high across the whole tied span (one held note) so a single envelope shapes the entire tie. Patch it into an envelope or VCA.",
      env: "The built-in ADSR envelope CV, scaled by the dynamic marking in force at that point in the score (pp..ff) — a ready-made loudness contour you can patch straight into a VCA.",
      clock: "A short pulse on every 16th-note advance — the chained clock-out; patch it into another sequencer's CLOCK IN to keep them in step.",
    },
    controls: {
      bpm: "BPM — the internal tempo the playhead walks the score at (each step is a 16th note); used only when nothing is patched into CLOCK IN.",
      attack: "ATTACK — the built-in ADSR's rise time, how quickly each note swells in (also reachable via the ATTACK CV input).",
      decay: "DECAY — the ADSR's fall time from the peak down to the sustain level after the attack.",
      sustain: "SUSTAIN — the ADSR's held level while a note's gate stays high.",
      release: "RELEASE — the ADSR's fade time after a note's gate releases.",
      isPlaying: "PLAY — the transport state: 1 plays from the playhead, 0 stops and forces the gate low. Starting playback returns the playhead to the top.",
      "score-note-{n}":
        "The STAFF itself — click an empty position to write a note of the current VALUE there, click a note to select it, and click the selected note again to delete it. Drag a note to move it: sideways changes when it sounds, up and down changes its pitch. Each note plays as V/oct on the PITCH output with a gate, in score order, as the playhead reaches it. A note that will not fit — the bar is full, it overlaps a neighbour, or the pitch is outside C4..C6 — is refused and the bar flashes.",
      "score-tie-{n}":
        "Ties the SELECTED note to the next note in the piece, and unties it again — turning it off is the only way there is to remove a tie. A tie makes the two into one held note: the gate stays high across the whole span and a single envelope shapes it, with only the last note in a chain releasing the gate. With NOTHING selected it is legato mode: leave it on and each note you write is tied to the one before it.",
      "score-dyn-{n}":
        "The dynamic marking sitting exactly at the SELECTED note (pp, p, mf, f, ff), or none. From where a marking sits onward it scales the ENV output's loudness, forward-filled until the next one, with mf in force before any marking at all. It shows the marking placed HERE rather than the level in force here — those are different facts, and picking the level already in force would silently add a second marking. With NOTHING selected it arms a level for the notes you write next, and a marking is only actually placed where it would change something.",
      "score-value-{n}":
        "Which note value the NEXT click on the staff writes: whole, half, quarter, eighth, triplet or sixteenth. It is the one setting that applies to the gesture you are about to make rather than to the note you have selected. Triplets sound on the full 48-tick grid, between the sixteenths, rather than being rounded onto them.",
      "score-accidental-{n}":
        "The accidental carried by the SELECTED note: sharp, natural, flat, or none. `key` means the note has no accidental of its own and follows the key signature; `natural` explicitly cancels the key signature on that one note, and a note you mark here keeps its spelling when the key signature changes. With NOTHING selected it arms the accidental for the notes you write next — so you can spell a note as you place it rather than going back to fix it.",
      "score-key-{n}":
        "The key signature, from seven flats to seven sharps, named by its major key. Changing it respells every note that carries no accidental of its own and leaves the ones you marked alone — so it is a bulk default you set once at the start, not a transpose.",
      "score-stop-{n}":
        "The stop-music double bar. `here` puts it at the SELECTED note, which is where the piece ends; with nothing selected it goes where the written music ends. `none` removes it and the piece plays to the end of its last page. What HAPPENS at that point is LOOP's decision, so the two are one idea in two controls. Drag the double bar on the staff to move it.",
      "score-loop-{n}":
        "What happens when the playhead reaches the end of the piece — the stop bar if one is set, otherwise the end of the last page. On, it wraps back to the top and keeps going; off, it stops and the transport returns to stopped.",
      "score-pages-{n}":
        "How long the piece is, in pages of sixteen bars each, from one to four. Shrinking it is NON-DESTRUCTIVE: notes on a page that is no longer allocated stay in the patch and simply stop sounding, and growing back brings them back. The sequence length the playhead walks comes from this, so an unwanted page is sixteen bars of silence on every pass.",
      "score-slots-{n}":
        "Four quicksave slots holding whole snapshots of the piece — every note, tie, dynamic, the key, the length, the loop flag, the stop bar and the five knob values. Arm SAVE, LOAD or QUEUE and then click a slot: SAVE writes, LOAD switches instantly, QUEUE switches at the end of the current pass. The four QUEUE 1..4 CV inputs queue the same slots from a patch cable, so this is where the patterns those inputs play come from. RESET drops any queued slot and restarts the playhead at the top.",
    },
  },

  // ⚠ THESE ARE A DOCS-KEYING DEVICE FIRST AND A FACE ROSTER SECOND, and reading
  // them the other way round makes the face impossible. A `controlFamily` is how
  // a card control with no backing param gets keyed by the docs gate at all —
  // the first three were declared for STRICT_DOCS long before any face existed.
  // Read as "three controls to rank", they are either three copies of one
  // picture or three mutually-exclusive selectors claiming one single-valued
  // state. Read as keys, they become the note surface, the tie toggle and the
  // dynamic selector, and none of them is a mode.
  //
  // ⚠ EACH `testidPrefix` IS A LITERAL BOTH SURFACES EMIT. `module-docs-lint`
  // greps the whole `ui/` tree for the prefix string, so these deliberately
  // reuse the names the legacy card already prints (`score-tool`, `score-page`,
  // `quicksave`) rather than inventing a face-only namespace — which keeps the
  // grep finding them on the card as well as on the faceplate.
  controlFamilies: [
    { id: 'score-note', label: 'Staff notes', kind: 'cell', testidPrefix: 'score-note' },
    { id: 'score-tie', label: 'Note ties', kind: 'cell', testidPrefix: 'score-tie' },
    { id: 'score-dyn', label: 'Dynamic markings', kind: 'cell', testidPrefix: 'score-dyn' },
    { id: 'score-value', label: 'Note value', kind: 'cell', testidPrefix: 'score-tool' },
    { id: 'score-accidental', label: 'Accidental', kind: 'cell', testidPrefix: 'score-tool-sharp' },
    { id: 'score-key', label: 'Key signature', kind: 'cell', testidPrefix: 'score-key-sig' },
    { id: 'score-stop', label: 'Stop bar', kind: 'cell', testidPrefix: 'score-stop-bar' },
    { id: 'score-loop', label: 'Loop', kind: 'cell', testidPrefix: 'score-tool-loop' },
    { id: 'score-pages', label: 'Pages', kind: 'cell', testidPrefix: 'score-page' },
    { id: 'score-slots', label: 'Quicksave', kind: 'cell', testidPrefix: 'quicksave' },
  ],

  face: {
    // ⚠ THE STAFF RANKS FIRST, AND IT COSTS NO LANE RANK. `score-note-{n}` is a
    // PF-14 PANEL, and `module-face-lint` refuses a panel SELECTED at a lane
    // tier (a panel declares its own `minWidth`; a lane knob column is 46 px),
    // which used to make a panel's first legal rank SEVEN. PF-22 drops a
    // declared `hero.cell` from `laneOrder` only, so the picture may rank first
    // and the 46 px protection is untouched. kria is the first adopter; this is
    // the second, and for the same reason: everything a player plays is in
    // `node.data` and none of it is a param.
    //
    // ⚠ AND THE RANK IS HONEST RATHER THAN CONVENIENT. Five of the six params
    // are a built-in ADSR — a VOICE bolted to the side of a SEQUENCER, optional
    // in any patch that drives a real envelope from GATE — and the sixth is the
    // transport switch. NOT ONE PARAM IS THE MUSIC. The music is every note,
    // tie, dynamic, the key signature, the page count, the loop flag and the
    // stop bar, all of which live in `node.data`.
    //
    // Read the order back as a sentence: write the notes; start it; set the
    // tempo; choose what the next click writes; then spell, shade, phrase and
    // end what you selected; then the key, the length, the envelope, and
    // finally the snapshots.
    order: [
      'score-note-{n}',
      // `isPlaying` above `bpm` is not arbitrary: BPM is a FALLBACK. `tick()`
      // checks `isClockInConnected()` first and runs the external-clock branch
      // whenever a cable is present, ignoring the tempo entirely. The transport
      // has no such conditional.
      'isPlaying',
      'bpm',
      // The only cell that affects the NEXT gesture rather than the current
      // selection — you set it before you click, every time.
      'score-value-{n}',
      // The marks, in the order a piece acquires them: pitch spelling →
      // loudness → phrasing → where it ends → what happens there.
      'score-accidental-{n}',
      'score-dyn-{n}',
      'score-tie-{n}',
      'score-stop-{n}',
      'score-loop-{n}',
      // ⚠ THE KEY SIGNATURE RANKS TENTH, AND THAT IS THE DEMOTION MOST WORTH
      // DEFENDING. It FEELS like a headline setting. It is not:
      // `staffStepToMidi` applies it only to notes whose `accidental === null`,
      // so it is a bulk respelling you perform once at the start and which never
      // touches a note you have explicitly marked. Set and forget.
      'score-key-{n}',
      // Structural, changed rarely — but RANKED rather than buried, because the
      // page count used to be a one-way ratchet and shrinking it is a repair a
      // player needs a control for.
      'score-pages-{n}',
      'attack', 'decay', 'sustain', 'release',
      // ⚠ LAST, AND ITS RANK IS WHAT PROTECTS IT. Quicksave is a PERFORMANCE
      // affordance you reach for after the piece exists, and it is the largest
      // cell after the staff. It is also the SECOND panel on this face, and —
      // unlike the staff — it is not the hero, so it stays in `laneOrder`. It is
      // safe at rank 16 only because the `full` lane cap is 6, which is the
      // arithmetic `panelCellKeys`'s own comment calls "a coincidence that a
      // future cap bump silently removes". ⚠ ANY RE-RANK THAT MOVES THIS ABOVE
      // RANK 6 TURNS A TASTE CHANGE INTO A RED RUN, and the reason will not be
      // obvious from the diff. `score-face-model.test.ts` asserts it directly so
      // the failure names itself.
      'score-slots-{n}',
    ],

    // ⚠ `'none'` IS THE ONLY LITERAL THAT COMPILES INTO A GREEN RUN, and it is
    // worth recording why rather than leaving it looking like a default.
    // `laneGlyphFor` returns `'picture'` only for `domain === 'video'`, and a
    // `'trace'` glyph needs a live binding that resolves through
    // `primaryAudioOutPortId` — `outputs.find(o => o.type === 'audio')`. SCORE
    // has NO audio output at all: its four are pitch, gate, cv and gate. So
    // every other glyph literal falls to a dead static picture and
    // `module-face-lint`'s `deadGlyphProblems` reddens it unconditionally.
    //
    // ⚠ AND THE PICTURE SCORE WOULD WANT IS STRICTLY MORE THAN THE GLYPH SEAM
    // BUYS. The useful glance is "where is the playhead in the piece?", which
    // needs `data.notes` plus `data.pages` plus a per-frame engine read of
    // `currentNoteId` — node data and a live handle, not a discrete param value,
    // and `ShellExtensionGlyphProps` carries no nodeId at all. kria refused on
    // the identical mechanism with the identical sentence ("the picture a player
    // wants is the playhead over the SELECTED track's SELECTED lane, which is
    // two more pieces of node.data"). Two instruments landing on the same
    // refusal for the same structural reason is evidence the seam's limit is a
    // SHAPE rather than an oversight.
    glyph: 'none',

    hero: { cell: 'score-note-{n}' },

    // ⚠ FIVE BANDS, NO TAB RAIL, AND THE THRESHOLD IS `DOCK_TAB_MIN_BANDS = 7`.
    // SCORE is the clearest "lots of controls of DIFFERENT types" case in the
    // fleet — a picture-you-edit, a SECOND picture-you-edit, five selectors, two
    // toggles, five faders and a discrete transport switch, six distinct
    // primitives — and its honest semantic grouping still lands at five. The
    // skill is explicit that an author may not pad pages to force the rail, so
    // this does not: splitting `score` into notes+key, `marks` into
    // dynamics+phrasing and `transport` into transport+length would reach seven
    // and every one of those splits is one control in a band of its own.
    // `face.tabbed` is owner-instruction-only. Recorded here because SCORE is
    // now the third module to hit this gap from a different direction
    // (ruttetra at 12 params in 3 bands, numpadPlus at 4), and three
    // near-misses in the same direction is a measurement rather than three
    // coincidences — but moving the threshold re-pins every dock baseline it
    // newly captures, so it is the owner's call and not a face PR's.
    pages: [
      {
        id: 'score',
        label: 'score',
        hint:
          'click an empty staff position to write a note of the current VALUE, click a note to ' +
          'select it, click the selected note again to delete it. ACC and KEY spell what you ' +
          'wrote: KEY is the bulk default and ACC overrides it on the one note you selected.',
        controls: ['score-note-{n}', 'score-value-{n}', 'score-accidental-{n}', 'score-key-{n}'],
      },
      {
        id: 'marks',
        label: 'marks',
        hint:
          'everything here acts on the SELECTED note, so there is no tool to arm and no mode to ' +
          'be in. END says where the piece stops and LOOP says what happens there — one decision ' +
          'in two controls, which is why they are clustered.',
        controls: ['score-dyn-{n}', 'score-tie-{n}', 'score-stop-{n}', 'score-loop-{n}'],
        clusters: [{ label: 'ending', controls: ['score-stop-{n}', 'score-loop-{n}'] }],
      },
      {
        id: 'transport',
        label: 'transport',
        hint:
          'BPM is a FALLBACK: patch anything into CLOCK IN and its rising edges drive the ' +
          'playhead instead, one per sixteenth, and the tempo here is ignored. PAGES is how long ' +
          'the piece is — shrinking it never deletes notes, they just stop sounding.',
        controls: ['isPlaying', 'bpm', 'score-pages-{n}'],
      },
      {
        id: 'envelope',
        label: 'envelope',
        hint:
          'a small voice bolted to the side of the sequencer: it shapes the ENV output only, ' +
          'scaled by whichever dynamic marking is in force. Every one of these has a CV input, ' +
          'and a patch driving a real envelope from GATE can ignore the lot.',
        controls: ['attack', 'decay', 'sustain', 'release'],
      },
      {
        id: 'slots',
        label: 'slots',
        hint:
          'four whole-piece snapshots. Arm SAVE, LOAD or QUEUE, then click a slot. This is also ' +
          'where the QUEUE 1..4 CV inputs get the patterns they play, so an empty slot is a ' +
          'silent patch cable.',
        controls: ['score-slots-{n}'],
      },
    ],
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const nodeId = node.id;

    // Internal ADSR worklet. Its gate input is driven by gateSrc; its output
    // is multiplied by dynGain to produce the final env CV.
    const adsr = await instantiateFaustModule(ctx, { name: 'adsr', wasmUrl, metaUrl, workletUrl }, node);
    const adsrParams = adsr.parameters as unknown as Map<string, AudioParam>;
    function setAdsrParam(id: string, v: number) {
      adsrParams.get(`${ADSR_PREFIX}/${id}`)?.setValueAtTime(v, ctx.currentTime);
    }
    // Apply initial param values from the node.
    for (const def of scoreDef.params) {
      if (def.id === 'bpm' || def.id === 'isPlaying') continue;
      const v = (node.params ?? {})[def.id] ?? def.defaultValue;
      setAdsrParam(def.id, v);
    }

    const pitchSrc = ctx.createConstantSource();
    const gateSrc = ctx.createConstantSource();
    const clockOutSrc = ctx.createConstantSource();
    pitchSrc.offset.value = 0;
    gateSrc.offset.value = 0;
    clockOutSrc.offset.value = 0;
    pitchSrc.start();
    gateSrc.start();
    clockOutSrc.start();

    // Wire gateSrc into the ADSR's gate input (input 0).
    gateSrc.connect(adsr);

    // ADSR -> dynGain -> env output port.
    const dynGain = ctx.createGain();
    dynGain.gain.value = DYNAMIC_SCALE.mf;
    adsr.connect(dynGain);

    // External clock input: AnalyserNode taps to detect rising edges.
    const clockInGain = ctx.createGain();
    const clockInAnalyser = ctx.createAnalyser();
    clockInAnalyser.fftSize = 2048;
    clockInGain.connect(clockInAnalyser);
    const clockInBuffer = new Float32Array(clockInAnalyser.fftSize);
    const clockInSilence = ctx.createConstantSource();
    clockInSilence.offset.value = 0;
    clockInSilence.start();
    clockInSilence.connect(clockInGain);
    let lastClockSample = 0;
    let lastClockSampleTime = ctx.currentTime;
    const CLOCK_THRESHOLD = 0.5;

    // Shared transport CV inputs (play_cv, reset_cv, queue{1..4}_cv).
    const transportCv = createTransportCv(ctx);
    let lastTransportPollTime = ctx.currentTime;
    let totalSequenceEnds = 0;

    function isClockInConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'clock');
    }
    function isPlayCvConnected(): boolean {
      return isInputPortConnected(Object.values(livePatch.edges), nodeId, 'play_cv');
    }

    function readParam(id: string, fallback: number): number {
      const live = livePatch.nodes[nodeId];
      const v = live?.params?.[id];
      return typeof v === 'number' ? v : fallback;
    }

    function emitClockPulse(atTime: number) {
      clockOutSrc.offset.setValueAtTime(1, atTime);
      clockOutSrc.offset.setValueAtTime(0, atTime + 0.01);
    }

    // ---- Tick loop ----
    // The score timeline is `pages * BARS_PER_PAGE * TICKS_PER_BAR` grid
    // ticks. The TRANSPORT advances in 16th-note SLOTS — one external clock
    // pulse, or one internal `slotDur`, moves `tickIndex` by one — and each
    // slot spans `GRID_TICKS_PER_SLOT` grid ticks.
    //
    // ⚠ THE SLOT IS THE TRANSPORT UNIT; IT IS NOT THE PLACEMENT GRID, AND
    // CONFLATING THE TWO SILENCED EVERY TRIPLET IN THIS MODULE FOR THREE
    // MONTHS. This loop used to emit at `tickIndex * 3` only, and
    // `noteStartingAt` matches the absolute tick EXACTLY, so the reachable set
    // was {0,3,6,…,45}. `triplet8th` is 4 ticks wide, so the toolbar offers
    // {0,4,8,…,44} — and `4k ≡ 0 (mod 3)` only for k ∈ {0,3,6,9}. FOUR of
    // twelve positions per bar sounded; the 2nd and 3rd note of every triplet
    // group never did, in either clock mode, since the module's first commit
    // (#52, 2026-05-08).
    //
    // NOTHING LOOKED WRONG, which is why it lasted. The card draws x linearly
    // in ticks, so a bar of triplets rendered at correct 1/3-beat spacing; the
    // note highlight is written INSIDE the emit, so the playhead skipped the
    // silent notes in visual agreement with the audio; and the one triplet per
    // beat that did fire got the right gate length. You saw a correct triplet
    // score, and heard a quarter pulse.
    //
    // Each slot now runs `slotEmitPlan(tickIndex)` — its grid ticks at sub-slot
    // time offsets. Clock semantics are untouched (one pulse is still one 16th;
    // `total16ths` still bounds the sequence; CLOCK OUT still pulses per slot)
    // and plan index 0 has offset 0, so every note on a multiple of 3 keeps its
    // exact former timestamp.
    let tickIndex = 0;
    let nextStepTime = ctx.currentTime + 0.05;
    let prevPlaying = false;
    let alive = true;
    let unsubscribeTick: (() => void) | null = null;
    const TICK_MS = SCHEDULER_TICK_MS;
    // 200 ms lookahead (was 100 ms): widens the cushion the audio thread
    // can survive before the next main-thread tick runs. See sequencer.ts
    // for the full rationale.
    const LOOKAHEAD_S = 0.2;
    // #229: drop past-due slots after a stall > lookahead instead of letting
    // Web Audio clamp+bunch them onto "now" (audible double-hit + tempo lurch
    // when dragging). 5 ms slack keeps ordinary near-now jitter sounding.
    const LATE_DROP_EPS = 0.005;

    // Scheduler lookahead vs sounding-now: tickIndex is the NEXT slot the
    // lookahead loop will queue; the trackers derive playhead state from the
    // (idx, atTime) entries pushed inside emitTick so the visual highlight
    // matches what the audio thread is playing right now. Fixes the off-by-one
    // playhead lag.
    //   tickPlayhead   — sounding 16th-slot tickIndex
    //   notePlayhead   — note id sounding at the current slot (null if rest)
    const tickPlayhead = createPlayheadTracker();
    const notePlayhead = createPlayheadTrackerOf<string | null>();
    let lastEmittedVOct = 0;
    let lastEmittedGate = 0;
    let lastDynamicScale = DYNAMIC_SCALE.mf;
    let totalAdvances = 0;
    // #229 instrumentation: lateStepsDropped = past-due slots whose tick we
    // dropped after a stall; pastDueEmits = emitTick calls with a past
    // timestamp (BUG canary, kept at 0 by the drop guard). See sequencer.ts.
    let lateStepsDropped = 0;
    let pastDueEmits = 0;
    /** When >0, gate is being held high through a tied span. The value is
     *  the absolute grid tick at which the chain ends + the chain's last
     *  note's full duration — i.e. the gate-off boundary. While set we
     *  suppress per-step gate drops. */
    let tiedGateHoldUntilTick = -1;

    /** Look up a note that starts exactly at this absolute grid position. */
    function noteStartingAt(absTick: number, notes: ScoreNote[]): ScoreNote | null {
      const bar = Math.floor(absTick / TICKS_PER_BAR);
      const tick = absTick - bar * TICKS_PER_BAR;
      for (const n of notes) {
        if (n.bar === bar && n.tick === tick) return n;
      }
      return null;
    }

    /** Compute the absolute grid tick at which a given note's gate-off is
     *  due, factoring in tie chains. For a stand-alone or tie-end note this
     *  is `note.bar*TICKS_PER_BAR + note.tick + tickWidth(note.duration)`.
     *  For a tie-start note we walk the chain forward and return the LAST
     *  note's gate-off boundary. Returns the absolute grid tick. */
    function gateOffAbsTickFor(note: ScoreNote, data: ScoreData): number {
      const role = tieRoleFor(note.id, data.ties);
      if (role === 'tied-start') {
        const chain = tieChainFrom(note.id, data.ties, data.notes);
        const last = chain[chain.length - 1] ?? note;
        return last.bar * TICKS_PER_BAR + last.tick + tickWidth(last.duration);
      }
      return note.bar * TICKS_PER_BAR + note.tick + tickWidth(note.duration);
    }

    /**
     * Run one scheduler SLOT: one clock-out pulse at the slot boundary, then
     * every grid tick the slot spans, each at its sub-slot time.
     *
     * The clock pulse stays at the SLOT rate. A downstream module's clock cable
     * means "a 16th"; tripling it here would re-time every patch that uses
     * SCORE as a clock source. Only note emission subdivides.
     */
    function emitSlot(
      slotIndex: number,
      atTime: number,
      slotDur: number,
      /** The caller's `ctx.currentTime` snapshot — NOT re-read here. */
      now: number = ctx.currentTime,
    ) {
      // #229 canary: a slot with a past timestamp = the drop guard failed and
      // Web Audio is about to clamp+bunch this onto "now". Kept at 0. Measured
      // on the slot boundary, exactly as it was before subdividing — the
      // sub-slot emits only ever move FORWARD from it, so this cannot
      // manufacture a past-due that the pre-fix code would not also have had.
      //
      // ⚠ JUDGED AGAINST THE CALLER'S `now`, not a fresh read. Re-reading the
      // clock here compared this slot against a LATER now than the drop guard
      // used, so a slot within LATE_DROP_EPS of the boundary could be admitted
      // by the guard and then counted past-due microseconds later — a false
      // canary with no late scheduling behind it. kria hit exactly this on main
      // (it emits per TRACK, so one borderline tick logged four at once); score
      // emits once per slot, so its window is narrower and it flaked far more
      // rarely, but the race is the same one and it is fixed here too.
      if (atTime < now - LATE_DROP_EPS) pastDueEmits++;
      emitClockPulse(atTime);
      for (const { absTick, offset } of slotEmitPlan(slotIndex)) {
        emitTick(absTick, atTime + offset * slotDur, slotDur);
      }
    }

    /** Schedule the start (and gate-off) of the note starting exactly at
     *  `absTick`, if any. `slotDur` is how long one 16th lasts in seconds. */
    function emitTick(absTick: number, atTime: number, slotDur: number) {
      const data = readScoreData(nodeId);
      const note = noteStartingAt(absTick, data.notes);
      if (!note) return;
      // Queue the note id so the visual playhead lights up at the exact moment
      // the audio thread starts emitting this note (not when the scheduler
      // lookahead-queued it up to 200 ms earlier).
      notePlayhead.schedule(note.id, atTime);

      const role = tieRoleFor(note.id, data.ties);

      // Forward-fill dynamic.
      const lvl = dynamicAt(note.bar, note.tick, data.dynamics);
      const dynScale = DYNAMIC_SCALE[lvl];
      lastDynamicScale = dynScale;
      try {
        dynGain.gain.setValueAtTime(dynScale, atTime);
      } catch { /* time may be in the past on audio thread; ignore */ }

      // Pitch as V/oct. ALWAYS update pitch — even mid-chain notes change
      // pitch (a tie usually implies same pitch but we don't enforce that
      // and let the engine track whatever the user wired up).
      const vOct = midiToVOct(note.midi);
      lastEmittedVOct = vOct;
      pitchSrc.offset.setValueAtTime(vOct, atTime);

      // Gate emission depends on tie role:
      //   - 'none': open gate now, close at note end (current behavior).
      //   - 'tied-start': open gate now, close at LAST chain note's end.
      //     Suppress per-step gate-off until then.
      //   - 'tied-mid': do NOT re-open the gate. Pitch was updated above.
      //   - 'tied-end': do NOT re-open the gate; the chain's gate-off was
      //     already scheduled by the start. Pitch updated above.
      //
      // We recalculate the gate-off each time the chain's start fires
      // (instead of mid-chain) so that subsequent edits to a chain remain
      // correct on the next loop pass.
      if (role === 'none') {
        const noteSec = (tickWidth(note.duration) / 3) * slotDur;
        gateSrc.offset.setValueAtTime(1, atTime);
        gateSrc.offset.setValueAtTime(0, atTime + noteSec * 0.95);
        lastEmittedGate = 1;
        tiedGateHoldUntilTick = -1;
      } else if (role === 'tied-start') {
        const chain = tieChainFrom(note.id, data.ties, data.notes);
        const last = chain[chain.length - 1] ?? note;
        // Total grid-ticks from this note's start to last note's end.
        const startAbs = note.bar * TICKS_PER_BAR + note.tick;
        const endAbs = last.bar * TICKS_PER_BAR + last.tick + tickWidth(last.duration);
        const spanGridTicks = Math.max(1, endAbs - startAbs);
        const spanSec = (spanGridTicks / 3) * slotDur;
        gateSrc.offset.setValueAtTime(1, atTime);
        gateSrc.offset.setValueAtTime(0, atTime + spanSec * 0.98);
        lastEmittedGate = 1;
        tiedGateHoldUntilTick = endAbs;
      }
      // tied-mid / tied-end: pitch already updated, gate left alone.
      // (note: currentNoteId is now derived from notePlayhead.currentAt(now)
      //  rather than written eagerly here — see the schedule() at the top of
      //  this function. Keeps the visual highlight aligned with audio output.)
    }

    /** Total bars currently allocated by the score (live read). */
    function liveTotalGridTicks(): number {
      const data = readScoreData(nodeId);
      const pages = Math.max(1, Math.min(MAX_PAGES, data.pages || DEFAULT_PAGES));
      return pages * BARS_PER_PAGE * TICKS_PER_BAR;
    }

    /** Absolute grid-tick at which the sequence ends. If a stop-music marker
     *  is set, returns its absolute position; otherwise end-of-final-page. */
    function liveStopGridTick(): number {
      const data = readScoreData(nodeId);
      const pages = Math.max(1, Math.min(MAX_PAGES, data.pages || DEFAULT_PAGES));
      const endOfPages = pages * BARS_PER_PAGE * TICKS_PER_BAR;
      if (data.stopBar) {
        const abs = data.stopBar.bar * TICKS_PER_BAR + data.stopBar.tick;
        // Clamp into the allocated range.
        return Math.max(1, Math.min(endOfPages, abs));
      }
      return endOfPages;
    }

    function silenceGate(atTime: number) {
      gateSrc.offset.cancelScheduledValues(atTime);
      gateSrc.offset.setValueAtTime(0, atTime);
      lastEmittedGate = 0;
      tiedGateHoldUntilTick = -1;
    }

    /** Drain transport CV and dispatch effects. Returns the CURRENT
     *  isPlaying value (after any play_cv toggle). */
    function pollTransportCv(): boolean {
      const nowAt = ctx.currentTime;
      const elapsed = nowAt - lastTransportPollTime;
      lastTransportPollTime = nowAt;
      const ev = transportCv.drain(elapsed);
      const live = livePatch.nodes[nodeId];
      let isPlaying = readParam('isPlaying', 0) >= 0.5;
      if (ev.play % 2 === 1) {
        isPlaying = !isPlaying;
        if (live?.params) live.params.isPlaying = isPlaying ? 1 : 0;
      }
      if (ev.reset > 0) {
        tickIndex = 0;
        tickPlayhead.reset();
        notePlayhead.reset();
        nextStepTime = ctx.currentTime + 0.05;
      }
      const queued = pickQueuedSlotFromEvents(ev);
      if (queued !== null && live) {
        if (!live.data) live.data = {};
        (live.data as Record<string, unknown>).queuedSlot = queued;
      }
      return isPlaying;
    }

    /** Apply queued slot's snapshot to node.data + node.params. SCORE
     *  snapshot shape: { notes, dynamics, ties, keySignature, pages,
     *  loop, stopBar?, bpm, attack, decay, sustain, release }. */
    function maybeApplyQueuedSlot(): boolean {
      const live = livePatch.nodes[nodeId];
      if (!live) return false;
      const data = live.data as Record<string, unknown> | undefined;
      const queued = coerceSlotKey(data?.queuedSlot);
      if (!queued) return false;
      const slots = coerceSlots(data?.slots);
      const snap = slots[queued];
      if (!snap) {
        if (data) data.queuedSlot = null;
        return false;
      }
      if (!live.data) live.data = {};
      const d = live.data as Record<string, unknown>;
      // Deep-clone object/array fields to avoid reassigning Y-tree-resident
      // objects out of slots[N]. Yjs throws "reassigning object that already
      // occurs in the tree" otherwise.
      if (Array.isArray(snap.notes)) {
        d.notes = (snap.notes as Array<Record<string, unknown>>).map((n) => ({ ...n }));
      }
      if (Array.isArray(snap.dynamics)) {
        d.dynamics = (snap.dynamics as Array<Record<string, unknown>>).map((m) => ({ ...m }));
      }
      if (Array.isArray(snap.ties)) {
        d.ties = (snap.ties as Array<Record<string, unknown>>).map((tt) => ({ ...tt }));
      }
      if (typeof snap.keySignature === 'number') d.keySignature = snap.keySignature;
      if (typeof snap.pages === 'number') d.pages = snap.pages;
      if (typeof snap.loop === 'boolean') d.loop = snap.loop;
      if (snap.stopBar && typeof snap.stopBar === 'object') {
        const sb = snap.stopBar as { bar: number; tick: number };
        d.stopBar = { bar: sb.bar, tick: sb.tick };
      } else if ('stopBar' in snap) {
        d.stopBar = undefined;
      }
      if (live.params) {
        for (const k of ['bpm', 'attack', 'decay', 'sustain', 'release'] as const) {
          const v = snap[k];
          if (typeof v === 'number') live.params[k] = v; // guard:allow-raw-write — sequencer slot-restore during the playback tick, not a user edit
        }
      }
      d.lastLoadedSlot = queued;
      d.queuedSlot = null;
      tickIndex = 0;
      tickPlayhead.reset();
      notePlayhead.reset();
      nextStepTime = ctx.currentTime + 0.005;
      tiedGateHoldUntilTick = -1;
      return true;
    }

    function tick() {
      if (!alive) return;
      try {
        const isPlaying = pollTransportCv();
        const externalClock = isClockInConnected();
        // Orthogonality fix: clock-only mode (clock patched, play_cv not)
        // treats incoming pulses as the play signal even when isPlaying=false.
        // Note: SCORE's "stop at end-of-stop-bar when not looping" path writes
        // isPlaying=0 to halt — in clock-only mode that single-shot stop is
        // not honored (the next clock pulse re-runs from step 0, since
        // shouldRun stays true). Stopping in clock-only mode is the clock
        // source's responsibility.
        const playCvPatched = isPlayCvConnected();
        const shouldRun = shouldSequencerRun(isPlaying, externalClock, playCvPatched);

        if (shouldRun && !prevPlaying) {
          tickIndex = 0;
          tickPlayhead.reset();
          notePlayhead.reset();
          nextStepTime = ctx.currentTime + 0.05;
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          tiedGateHoldUntilTick = -1;
          lastClockSample = 0;
          lastClockSampleTime = ctx.currentTime;
          transportCv.resetEdges();
          lastTransportPollTime = ctx.currentTime;
        } else if (!shouldRun && prevPlaying) {
          gateSrc.offset.cancelScheduledValues(ctx.currentTime);
          gateSrc.offset.setValueAtTime(0, ctx.currentTime);
          tiedGateHoldUntilTick = -1;
        }
        prevPlaying = shouldRun;

        if (!shouldRun) {
          // Worker-driven scheduler-clock owns re-tick scheduling — see the
          // getSchedulerClock().subscribe(tick) below — so no timeoutId
          // self-loop is needed when we early-return.
          return;
        }

        const totalGrid = liveTotalGridTicks();
        const stopGrid = liveStopGridTick();
        const total16ths = Math.max(1, Math.floor(totalGrid / 3));
        const stop16ths = Math.max(1, Math.floor(stopGrid / 3));

        if (externalClock) {
          clockInAnalyser.getFloatTimeDomainData(clockInBuffer);
          const nowAt = ctx.currentTime;
          const elapsed = nowAt - lastClockSampleTime;
          const newSamples = Math.min(
            clockInBuffer.length,
            Math.max(1, Math.ceil(elapsed * ctx.sampleRate)),
          );
          const start = clockInBuffer.length - newSamples;
          const bpm = readParam('bpm', 120);
          const slotDur = 60 / Math.max(1, bpm) / 4;
          for (let i = start; i < clockInBuffer.length; i++) {
            const cur = clockInBuffer[i] ?? 0;
            if (lastClockSample < CLOCK_THRESHOLD && cur >= CLOCK_THRESHOLD) {
              if (tickIndex >= stop16ths) {
                totalSequenceEnds++;
                if (maybeApplyQueuedSlot()) {
                  // Pattern swapped + tickIndex reset to 0; emit the
                  // new pattern's first slot on this very pulse.
                } else if (readScoreData(nodeId).loop) {
                  tickIndex = 0;
                } else {
                  // Stop the sequencer.
                  silenceGate(nowAt + 0.005);
                  // Clear isPlaying so the next tick takes the !isPlaying path.
                  const live = livePatch.nodes[nodeId];
                  if (live?.params) live.params.isPlaying = 0;
                  break;
                }
              }
              tickPlayhead.schedule(tickIndex, nowAt + 0.005);
              emitSlot(tickIndex, nowAt + 0.005, slotDur);
              tickIndex = (tickIndex + 1) % total16ths;
              totalAdvances++;
            }
            lastClockSample = cur;
          }
          lastClockSampleTime = nowAt;
        } else {
          while (nextStepTime < ctx.currentTime + LOOKAHEAD_S) {
            const bpm = readParam('bpm', 120);
            const slotDur = 60 / bpm / 4;
            if (tickIndex >= stop16ths) {
              totalSequenceEnds++;
              if (maybeApplyQueuedSlot()) {
                // tickIndex reset to 0 + nextStepTime nudged forward by the
                // helper. Re-anchor nextStepTime to the natural slot
                // boundary so we don't introduce drift.
                // (helper sets nextStepTime to ctx.currentTime + 0.005;
                //  the next emitTick call uses that as step-0's at-time.)
              } else if (readScoreData(nodeId).loop) {
                tickIndex = 0;
              } else {
                // Stop and exit the schedule loop.
                silenceGate(nextStepTime);
                const live = livePatch.nodes[nodeId];
                if (live?.params) live.params.isPlaying = 0;
                break;
              }
            }
            // #229: drop past-due backlog instead of bunching it onto "now".
            // ONE clock read, shared with the canary inside emitSlot.
            const nowSnapshot = ctx.currentTime;
            if (nextStepTime < nowSnapshot - LATE_DROP_EPS) {
              lateStepsDropped++;
            } else {
              tickPlayhead.schedule(tickIndex, nextStepTime);
              emitSlot(tickIndex, nextStepTime, slotDur, nowSnapshot);
            }
            nextStepTime += slotDur;
            tickIndex = (tickIndex + 1) % total16ths;
            totalAdvances++;
          }
        }
      } catch (err) {
        console.error('[score] tick error', err);
      }
    }
    // Subscribe to the shared scheduler-clock (worker-driven, jank-immune).
    unsubscribeTick = getSchedulerClock().subscribe(tick);

    const inputsMap = new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
      ['clock', { node: clockInGain, input: 0 }],
      ['attack', { node: adsr, input: 0, param: adsrParams.get(`${ADSR_PREFIX}/attack`)! }],
      ['decay', { node: adsr, input: 0, param: adsrParams.get(`${ADSR_PREFIX}/decay`)! }],
      ['sustain', { node: adsr, input: 0, param: adsrParams.get(`${ADSR_PREFIX}/sustain`)! }],
      ['release', { node: adsr, input: 0, param: adsrParams.get(`${ADSR_PREFIX}/release`)! }],
    ]);
    for (const [id, entry] of transportCv.inputs) {
      inputsMap.set(id, entry);
    }

    return {
      domain: 'audio',
      inputs: inputsMap,
      outputs: new Map([
        ['pitch', { node: pitchSrc, output: 0 }],
        ['gate', { node: gateSrc, output: 0 }],
        ['env', { node: dynGain, output: 0 }],
        ['clock', { node: clockOutSrc, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'bpm' || paramId === 'isPlaying') return;
        setAdsrParam(paramId, value);
      },
      readParam(paramId) {
        if (paramId === 'bpm' || paramId === 'isPlaying') {
          return readParam(paramId, 0);
        }
        return adsrParams.get(`${ADSR_PREFIX}/${paramId}`)?.value;
      },
      read(key) {
        const now = ctx.currentTime;
        if (key === 'currentNoteId') return notePlayhead.currentAt(now, null);
        if (key === 'totalAdvances') return totalAdvances;
        if (key === 'lateStepsDropped') return lateStepsDropped;
        if (key === 'pastDueEmits') return pastDueEmits;
        if (key === 'totalSequenceEnds') return totalSequenceEnds;
        if (key === 'pitchVOct') return lastEmittedVOct;
        if (key === 'gateValue') return lastEmittedGate;
        if (key === 'dynamicScale') return lastDynamicScale;
        // tickIndex is the SCHEDULER's lookahead pointer; tests + the
        // visual playhead want the sounding-now slot. We expose both so
        // existing scheduler-state tests can still introspect the
        // lookahead, but reroute the read to the playhead.
        if (key === 'tickIndex') return tickPlayhead.currentAt(now);
        if (key === 'schedulerTickIndex') return tickIndex;
        if (key === 'tiedGateHoldUntilTick') return tiedGateHoldUntilTick;
        return undefined;
      },
      dispose() {
        alive = false;
        if (unsubscribeTick) { unsubscribeTick(); unsubscribeTick = null; }
        try { pitchSrc.stop(); } catch { /* already stopped */ }
        try { gateSrc.stop(); } catch { /* already stopped */ }
        try { clockOutSrc.stop(); } catch { /* already stopped */ }
        try { clockInSilence.stop(); } catch { /* already stopped */ }
        pitchSrc.disconnect();
        gateSrc.disconnect();
        clockOutSrc.disconnect();
        clockInGain.disconnect();
        clockInAnalyser.disconnect();
        clockInSilence.disconnect();
        dynGain.disconnect();
        adsr.disconnect();
        transportCv.dispose();
      },
    };
  },
};

// Export this for the gateOffAbsTickFor helper used in tests.
export function _testGateOffAbsTickFor(note: ScoreNote, data: ScoreData): number {
  const role = tieRoleFor(note.id, data.ties);
  if (role === 'tied-start') {
    const chain = tieChainFrom(note.id, data.ties, data.notes);
    const last = chain[chain.length - 1] ?? note;
    return last.bar * TICKS_PER_BAR + last.tick + tickWidth(last.duration);
  }
  return note.bar * TICKS_PER_BAR + note.tick + tickWidth(note.duration);
}
