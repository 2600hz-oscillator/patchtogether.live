// packages/web/src/lib/audio/modules/noise.ts
//
// NOISE — basic noise source. Three flavors of noise on three independent
// outputs, all gain-scaled by a single LEVEL knob:
//
//   white  — full-spectrum white noise (flat spectrum). Math.random()-driven.
//   pink   — 1/f pink noise (-3 dB/oct). Voss-McCartney algorithm.
//   brown  — leaky-integrated white: FLAT below a ~77 Hz corner (at 48 kHz)
//            and -6 dB/oct above it. See the two corrections below.
//
// Implementation strategy: pre-generate a 2-second AudioBuffer per flavor
// and loop it via three AudioBufferSourceNodes feeding three gain nodes
// (one per output, all sharing the LEVEL knob's value). This is much
// cheaper than an AudioWorklet — no per-sample JS callback, just a
// looping buffer playback.
//
// ── THREE THINGS THIS HEADER USED TO GET WRONG (measured 2026-08-10, against
//    the shipping generators at the shipped 96 000-sample table length) ─────
//
// 1 · "The loop seam is inaudible because noise is by definition aperiodic."
//     TRUE FOR WHITE, NEARLY TRUE FOR PINK, FALSE FOR BROWN. Aperiodicity is
//     the wrong test: what matters is whether the WRAP STEP is larger than the
//     steps the table already contains. Over 200 seeded tables, the seam |Δ|
//     exceeds that table's own largest ordinary |Δ| in 0/200 white tables and
//     23/200 pink ones — but 153/200 BROWN ones (seam |Δ| 0.206 mean against a
//     0.071 mean largest ordinary step), because brown's integrator restarts
//     from `last = 0` on every loop while the table it is rejoining ended
//     wherever the walk had wandered to. INFERENCE, not auditioned: a 0.5 Hz
//     broadband tick on the brown tap. The fix is a DSP change (seed the
//     integrator from the table's own tail, or cross-fade the seam) and is
//     deliberately NOT folded into a faceplate PR.
//
// 2 · "brown — 1/f² (-6 dB/oct)", flat and unqualified. `LEAK = 0.99` makes
//     brown a one-pole LOW-PASS, so it is -6 dB/oct only ABOVE its corner and
//     essentially FLAT below it (measured -1.9 dB/oct over 20-100 Hz against
//     -5.6 over 100 Hz-1 kHz). The corner is 76.78 Hz at 48 kHz — and because
//     `LEAK` is a bare z-domain constant with NO sampleRate term while
//     `bufferLen` below DOES scale with the rate, THE CORNER MOVES WITH THE
//     USER'S INTERFACE: 70.5 Hz at 44.1 k, 153.6 Hz at 96 k.
//
// 3 · The three taps are NOT LEVEL-MATCHED, which nothing anywhere said. At
//     LEVEL 1 their RMS is white -4.77 dBFS, brown -11.84, pink -17.08: brown
//     runs 7.1 dB and pink 12.3 dB below white, from the SAME knob. Patch two
//     taps into a mixer at equal channel gain and they are not equal.
//     (Closed forms + the oracle that re-derives them from the generators:
//     $lib/ui/modules/noise-face-model + its test.)
//
// Why three independent outputs instead of one + filters: the user can
// pick any combination — patch white into one chain and brown into
// another for layered synthesis. All three are computed up-front (zero
// runtime cost beyond a buffer playback) so this is essentially free.
//
// LEVEL knob: a single GainNode per output, all driven by the same
// param value. CV-modulating LEVEL would be possible but the spec asks
// for "just one knob" with no CV input — keep it simple.
//
// Inputs: none.
//
// Outputs:
//   white (audio): full-spectrum white noise.
//   pink (audio): 1/f pink noise (-3 dB/oct).
//   brown (audio): leaky-integrated white — flat below ~77 Hz, -6 dB/oct above.
//
// Params:
//   level (linear 0..1, default 0.5): master gain applied to all three taps.

import type { AudioDomainNodeHandle } from '$lib/audio/engine';
import type { AudioModuleDef } from '$lib/audio/module-registry';
// The pure noise-flavor generators live in the shared DSP lib (extracted for
// the ART audio profile, which pins them with a fixed seed — the same
// relative-import pattern as moog-filterbank-factory → moog-filterbank-dsp).
import { noiseGenerators } from '../../../../../dsp/src/lib/noise-dsp';

// Re-exported so existing consumers (unit tests, MOOG 903A/923 which build
// their noise tables from the same generators) keep their import surface.
export { noiseGenerators };

/** Buffer length for the loopable noise tables. 2 seconds at typical sample
 *  rates puts the loop period (~0.5 Hz) far below pitched perception.
 *
 *  ⚠ THAT IS NOT THE SAME AS "the seam is silent" — see correction 1 in the
 *  header. It is true of white and nearly true of pink; brown's integrator
 *  restarts from zero every wrap, so its seam step is larger than any step in
 *  its own table on ~3 of every 4 spawns. */
const BUFFER_SECONDS = 2;

export const noiseDef: AudioModuleDef = {
  type: 'noise',
  palette: { top: 'Audio modules', sub: 'VCOs' },
  domain: 'audio',
  label: 'noise',
  category: 'sources',

  inputs: [],
  outputs: [
    { id: 'white', type: 'audio' },
    { id: 'pink',  type: 'audio' },
    { id: 'brown', type: 'audio' },
  ],
  params: [
    { id: 'level', label: 'Level', defaultValue: 0.5, min: 0, max: 1, curve: 'linear' },
  ],

  docs: {
    explanation:
      "A pure noise source with three independent spectral flavors on three separate outputs: white (flat), pink (1/f, -3 dB/oct) and brown (leaky-integrated white). Each flavor is a 2-second table generated ONCE when the module spawns and looped forever after, so the colour is baked into the table — there is no filter and no morph, and every jack is live the instant the module appears. Mental model: patch any combination into different channels to layer timbres — white for brightness, pink for warmth, brown for rumble. TWO THINGS WORTH KNOWING BEFORE YOU MIX. First, the taps are NOT level-matched: one LEVEL knob drives all three, but brown leaves 7.1 dB and pink 12.3 dB below white, so equal channel gains do not give equal loudness. Second, brown is a one-pole low-pass rather than a pure slope — it is flat below about 77 Hz (at a 48 kHz interface; the corner scales with the sample rate) and only -6 dB/oct above that, which is why it reads as rumble rather than as a tilt.",
    inputs: {},
    outputs: {
      white:
        "Full-spectrum white noise with flat frequency response; uniform random amplitude across all audible frequencies. The loudest of the three taps by a wide margin (-4.77 dBFS at LEVEL 1) and the tap the lane meter reads, since it is the first audio output declared. One of three independent outputs sharing the LEVEL control.",
      pink: "1/f pink noise at -3 dB per octave slope; warmer than white noise with attenuated highs. Useful for smooth, natural-sounding textures. The QUIETEST tap — 12.3 dB below white from the same LEVEL setting. One of three independent outputs sharing the LEVEL control.",
      brown:
        "Leaky-integrated white noise: FLAT below its -3 dB corner (about 77 Hz at 48 kHz, and the corner moves with the interface sample rate) and -6 dB per octave above it, so it is the darkest flavor without being a pure 1/f² tilt. It also has no hard bound — its peak drifts past full scale on most spawns at LEVEL 1, where white and pink cannot. Sits 7.1 dB below white. One of three independent outputs sharing the LEVEL control.",
    },
    controls: {
      level:
        "Master gain applied equally to all three noise outputs, from silence (0) to full amplitude (1). Equally in the sense of one multiplier, NOT one loudness: the three tables have different RMS, so the taps stay 7.1 dB and 12.3 dB apart at every setting. Default 0.5 provides moderate headroom; raise it to push the noise through downstream processing, lower it to blend subtly into a mix. Above about 0.78 the brown tap can peak past full scale.",
    },
  },

  // ── THE FACEPLATE ─────────────────────────────────────────────────────────
  //
  // The smallest face in the registry, and the one whose argument had to be
  // made rather than assumed. `.myrobots/plans/face-specs-batch-3-noise.md`
  // recommends NO FACE ON MERIT, and its reasoning is sound as far as it goes:
  // one param, zero inputs, zero modes, so `faceTierCap` gives mini 1 and
  // compact 2 and ALL FOUR TIERS SHOW THE SAME SINGLE KNOB. That is true here
  // and this face does not pretend otherwise.
  //
  // What the spec's arithmetic leaves out is that a faceplate is not only its
  // tier ladder. The three facts below are true of the shipping module, are
  // stated NOWHERE in the product today, and each one costs a user real time:
  //
  //   · THE TAPS ARE NOT LEVEL-MATCHED. One gain, three tables, and they leave
  //     7.1 dB (brown) and 12.3 dB (pink) below white. Every mix that trims
  //     "noise" to taste against the wrong tap starts here.
  //   · BROWN IS A LOW-PASS, NOT A SLOPE — flat below ~77 Hz — and that corner
  //     MOVES WITH THE INTERFACE, because `LEAK` has no sampleRate term.
  //   · BROWN HAS NO BOUND. White is clamped at 1 by its own uniform draw and
  //     pink by its ROWS+1 normaliser; brown is a random walk, and past
  //     LEVEL ≈ 0.78 its peak can leave full scale.
  //
  // None of the three is reachable from `level`'s own readback, which prints
  // `0.50` while all of them change. So the face is built around the READOUTS
  // and the PICTURE, exactly as the spec's own contingency §3 proposed — and
  // without the `noise-taps` control FAMILY that contingency declared, because
  // a family needs matching card testids and would have moved the legacy card
  // (a REQUIRED `vrt-strict` baseline) for a picture that belongs in the dock.
  //
  // OWNER CONSTRAINT, 2026-08-10: "preserve today's look". Honoured as written
  // — the legacy card is byte-identical in the pixel lane (its only change is
  // reading its range off the def instead of re-typing it), the module keeps
  // its one prominent LEVEL control and its three audio jacks, and nothing is
  // renamed, recoloured or reorganised.
  //
  // THE ONE THING THAT DID NOT SURVIVE THE FIRST PASS, and the reason this face
  // was held: `ModuleShell` paints a ranked param with `KnobConic`, so the dock
  // showed LEVEL as a big knob where the card draws a fader. The owner's answer
  // was a platform one rather than an exception — the `fader` cell kind (see
  // `face.paramCells` below), which `noise` is the first module to declare and
  // which clouds, mixer and vca inherit the day they are faced.
  face: {
    // One param, so one rank. Nothing to prioritise and nothing dropped.
    order: ['level'],

    // LEVEL IS A THROW, NOT A DIAL — and this declaration is the reason this
    // face waited a release rather than shipping with the batch. `ModuleShell`
    // paints a ranked param with `KnobConic` by default, so the face rendered
    // LEVEL as a big knob where `NoiseCard` has always drawn a fader. That is
    // not a cosmetic difference on a module whose ENTIRE visual identity is one
    // centred fader, and the owner ruled accordingly (2026-08-10): add the cell
    // kind, keep noise looking like today. Nothing in a ParamDef says "this is
    // a level" — `0..1 linear` is the same shape as any other continuous
    // scalar — so the shell cannot infer it and the module has to say so.
    paramCells: { level: 'fader' },

    // NO `pages`, and this is the first face in the registry where that has a
    // visible consequence. With a single ranked key promoted to the hero, the
    // page-less `__all` band has nothing left in it, and `heroFacePlan` DROPS
    // an emptied band ("a labelled void where they were") — so the dock renders
    // the hero and the sidebar and no section bands at all. That path was
    // written defensively in dock-faceplate-model.ts ("a no-op on every face
    // declared today … landed now so the first face that needs it does not have
    // to discover it"); this is that face. Its VRT roster entry is `pages: 0`.

    // A VuMeter on the primary audio out.
    //
    // ⚠ AND `primaryAudioOutPortId` RESOLVES THE FIRST AUDIO OUTPUT IN
    // DECLARATION ORDER, WHICH IS `white`. So the lane meter reads exactly one
    // of three jacks, and specifically the loudest one — a rack running brown
    // shows a meter 7.1 dB hotter than what it hears. That is stated on the
    // faceplate (the `lane meter` row in the sidebar) rather than left to be
    // discovered, and it is still the right glyph: LEVEL's real hazard is
    // headroom, the tap that clips first is white's neighbour brown, and a
    // one-knob tile with no glyph would say nothing at all.
    glyph: 'meter',

    title: 'Source',
    hint:
      'Three independent 2-second tables, drawn once when the module spawns and looped forever ' +
      'after — the colour is baked into the table, so there is no filter and no morph to reach ' +
      'for. LEVEL is one multiplier on all three, which is not the same as one loudness: they ' +
      'leave 7.1 dB and 12.3 dB apart.',

    // THE HERO. The module's one control at hero size, and beside it the three
    // numbers that control cannot produce. No `cell`: a panel's first legal
    // rank is 7 (module-face-lint refuses a panel SELECTED at a lane tier) and
    // this module has exactly ONE rankable key, so the picture lives in the
    // sidebar — the meowbox route, at the far end of the same constraint.
    hero: {
      control: 'level',
      readouts: [
        { label: 'white', valueId: 'noise-white-db' },
        { label: 'pink', valueId: 'noise-pink-db' },
        { label: 'brown', valueId: 'noise-brown-db' },
      ],
    },

    // TWO BLOCKS. A chain diagram was drafted here and cut after looking at
    // the render — it was four stages of the same straight line, three times
    // over, and it cost ~130 px of sidebar on a ONE-CONTROL module. The whole
    // block kind has since been removed for the more basic reason (nothing
    // verified any of them against the DSP), so there is no third block to
    // reconsider.
    sidebar: [
      {
        // THE PICTURE: the three spectra relative to white on a log ruler, over
        // a level ladder at the live LEVEL. See sidebar-panels.ts for why it is
        // a sidebar block and not a hero cell, and NoiseTapsPanel for why it is
        // drawn from the generators' coefficients rather than traced off an
        // analyser (this module is free-running; a trace would never baseline).
        kind: 'custom',
        label: 'the three taps',
        panelId: 'noise-taps',
      },
      {
        // SIX FIXED FACTS — every one a constant of the design rather than a
        // live value, which is exactly what a `text` readout is for. The three
        // LIVE numbers are the hero's, because they are the ones LEVEL moves.
        //
        // ⚠ THE CORNER CARRIES ITS SAMPLE RATE, and that is not pedantry: it is
        // 70.5 Hz at 44.1 k and 153.6 Hz at 96 k. A `valueId` readout cannot
        // print the live one — `FaceReadoutValue` is `(read) => string` and
        // gets no rate — so printing a bare "77 Hz" would be silently wrong on
        // every other interface. Stated with its condition instead.
        kind: 'readouts',
        label: 'the tables',
        entries: [
          { label: 'the three', text: 'parallel · never summed' },
          { label: 'brown −3 dB at', text: '77 Hz · 48 kHz' },
          { label: 'vs white', text: 'brown −7.1 · pink −12.3 dB' },
          { label: 'brown peak', text: 'past 0 dBFS from LEVEL 0.78' },
          { label: 'lane meter', text: 'reads WHITE only' },
          { label: 'each table', text: '2 s, new per spawn' },
        ],
      },
    ],
  },

  async factory(ctx, node): Promise<AudioDomainNodeHandle> {
    const sampleRate = ctx.sampleRate;
    const bufferLen = Math.floor(BUFFER_SECONDS * sampleRate);

    // Generate the three noise tables once, fill them, and wrap each in
    // a looping AudioBufferSourceNode. The .start() kicks the source into
    // playback; .stop() in dispose() ends it.
    //
    // copyToChannel's parameter is typed Float32Array<ArrayBuffer> in
    // recent TS lib.dom.d.ts; sample-by-sample copyToChannel via
    // getChannelData sidesteps the SharedArrayBuffer / ArrayBuffer
    // generic-arg mismatch.
    function makeBuffer(data: Float32Array): AudioBuffer {
      const buf = ctx.createBuffer(1, bufferLen, sampleRate);
      const channel = buf.getChannelData(0);
      for (let i = 0; i < bufferLen; i++) channel[i] = data[i] ?? 0;
      return buf;
    }

    const whiteBuf = makeBuffer(noiseGenerators.white(bufferLen));
    const pinkBuf  = makeBuffer(noiseGenerators.pink(bufferLen));
    const brownBuf = makeBuffer(noiseGenerators.brown(bufferLen));

    const whiteSrc = ctx.createBufferSource();
    whiteSrc.buffer = whiteBuf;
    whiteSrc.loop = true;

    const pinkSrc = ctx.createBufferSource();
    pinkSrc.buffer = pinkBuf;
    pinkSrc.loop = true;

    const brownSrc = ctx.createBufferSource();
    brownSrc.buffer = brownBuf;
    brownSrc.loop = true;

    // Per-output gain nodes, all driven by the same LEVEL value. We could
    // share one GainNode but keeping them per-output makes the disposal
    // story symmetrical (each src → its own gain → outputs map entry).
    const initialLevel = (node.params ?? {}).level ?? 0.5;
    const whiteGain = ctx.createGain();
    whiteGain.gain.value = initialLevel;
    const pinkGain = ctx.createGain();
    pinkGain.gain.value = initialLevel;
    const brownGain = ctx.createGain();
    brownGain.gain.value = initialLevel;

    whiteSrc.connect(whiteGain);
    pinkSrc.connect(pinkGain);
    brownSrc.connect(brownGain);

    whiteSrc.start();
    pinkSrc.start();
    brownSrc.start();

    return {
      domain: 'audio',
      // No inputs declared. Map is intentionally empty.
      inputs: new Map(),
      outputs: new Map([
        ['white', { node: whiteGain, output: 0 }],
        ['pink',  { node: pinkGain,  output: 0 }],
        ['brown', { node: brownGain, output: 0 }],
      ]),
      setParam(paramId, value) {
        if (paramId === 'level') {
          whiteGain.gain.setValueAtTime(value, ctx.currentTime);
          pinkGain.gain.setValueAtTime(value, ctx.currentTime);
          brownGain.gain.setValueAtTime(value, ctx.currentTime);
        }
      },
      readParam(paramId) {
        if (paramId === 'level') return whiteGain.gain.value;
        return undefined;
      },
      dispose() {
        try { whiteSrc.stop(); } catch { /* already stopped */ }
        try { pinkSrc.stop();  } catch { /* already stopped */ }
        try { brownSrc.stop(); } catch { /* already stopped */ }
        whiteSrc.disconnect();
        pinkSrc.disconnect();
        brownSrc.disconnect();
        whiteGain.disconnect();
        pinkGain.disconnect();
        brownGain.disconnect();
      },
    };
  },
};
