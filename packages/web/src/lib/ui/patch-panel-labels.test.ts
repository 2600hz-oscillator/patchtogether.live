// patch-panel-labels.test.ts
//
// Verbose-label rule: every UI port label expands to the human form by
// default. The test asserts the canonical mappings from a sampling of
// real module ids on `main`. If anyone adds an abbreviation back into a
// card, this test fires loudly — there's no "ATK" or "RES" hiding behind
// a default fall-through.

import { describe, expect, it } from 'vitest';
import {
  resolveVerboseLabel,
  groupPortsByCableType,
  remoteEndpointsTitle,
  type PortDescriptor,
} from './patch-panel-labels';
import { stereoPairStemId } from '$lib/graph/stereo-pairs';
import { qbrtDef } from '$lib/audio/modules/qbrt';

describe('resolveVerboseLabel', () => {
  it('expands ADSR ids verbatim', () => {
    expect(resolveVerboseLabel({ id: 'attack' })).toBe('ATTACK');
    expect(resolveVerboseLabel({ id: 'decay' })).toBe('DECAY');
    expect(resolveVerboseLabel({ id: 'sustain' })).toBe('SUSTAIN');
    expect(resolveVerboseLabel({ id: 'release' })).toBe('RELEASE');
  });

  it('expands canonical abbreviations to full words', () => {
    expect(resolveVerboseLabel({ id: 'atk' })).toBe('ATTACK');
    expect(resolveVerboseLabel({ id: 'sus' })).toBe('SUSTAIN');
    expect(resolveVerboseLabel({ id: 'rel' })).toBe('RELEASE');
    expect(resolveVerboseLabel({ id: 'res' })).toBe('RESONANCE');
    expect(resolveVerboseLabel({ id: 'cut' })).toBe('CUTOFF');
    expect(resolveVerboseLabel({ id: 'vol' })).toBe('VOLUME');
  });

  it('preserves hardware-convention shorthand (FM, PW, L/R)', () => {
    // These must stay as-is — not expanded to FREQUENCY MODULATION etc.
    expect(resolveVerboseLabel({ id: 'fm' })).toBe('FM');
    expect(resolveVerboseLabel({ id: 'pw' })).toBe('PW');
    expect(resolveVerboseLabel({ id: 'L' })).toBe('L');
    expect(resolveVerboseLabel({ id: 'R' })).toBe('R');
    expect(resolveVerboseLabel({ id: 'cv' })).toBe('CV');
  });

  it('expands voice-prefixed ports (v{N}_… drum-voice id shape)', () => {
    expect(resolveVerboseLabel({ id: 'v1_tone' })).toBe('V1 TONE');
    expect(resolveVerboseLabel({ id: 'v4_attack' })).toBe('V4 ATTACK');
    expect(resolveVerboseLabel({ id: 'v3_sendA' })).toBe('V3 SEND A');
    expect(resolveVerboseLabel({ id: 'pitch1' })).toBe('PITCH1');
    expect(resolveVerboseLabel({ id: 'gate2' })).toBe('GATE2');
  });

  it('expands FX-prefixed ports', () => {
    expect(resolveVerboseLabel({ id: 'flt_cutoff' })).toBe('FILTER CUTOFF');
    expect(resolveVerboseLabel({ id: 'flt_resonance' })).toBe('FILTER RESONANCE');
    expect(resolveVerboseLabel({ id: 'flt_mode' })).toBe('FILTER MODE');
    expect(resolveVerboseLabel({ id: 'rv_size' })).toBe('REVERB SIZE');
    expect(resolveVerboseLabel({ id: 'rv_damp' })).toBe('REVERB DAMP');
    expect(resolveVerboseLabel({ id: 'bc_decimate' })).toBe('DESTROY DECIMATE');
    expect(resolveVerboseLabel({ id: 'bc_bits' })).toBe('DESTROY BITS');
  });

  it('expands MIXMSTRS channel ports', () => {
    expect(resolveVerboseLabel({ id: 'ch1L' })).toBe('CH1 L');
    expect(resolveVerboseLabel({ id: 'ch3R' })).toBe('CH3 R');
    expect(resolveVerboseLabel({ id: 'ch2_volume' })).toBe('CH2 VOLUME');
    expect(resolveVerboseLabel({ id: 'master_volume' })).toBe('MASTER VOLUME');
    expect(resolveVerboseLabel({ id: 'masterL' })).toBe('MASTER L');
    expect(resolveVerboseLabel({ id: 'send1L' })).toBe('SEND 1 L');
    expect(resolveVerboseLabel({ id: 'ret2R' })).toBe('RETURN 2 R');
  });

  it('expands camelCase ids by inserting spaces', () => {
    expect(resolveVerboseLabel({ id: 'wavePos' })).toBe('WAVE POS');
    expect(resolveVerboseLabel({ id: 'cvAmount' })).toBe('CV AMOUNT');
    expect(resolveVerboseLabel({ id: 'gateLength' })).toBe('GATE LENGTH');
  });

  it('labels QBRT’s two ping jacks DISTINCTLY (trigger vs decay time)', () => {
    // QBRT declares BOTH `ping` (the excitation TRIGGER) and `pingDecay` (CV
    // for the Q-boost decay TIME). While the bare `ping` stem expanded to
    // 'PING DECAY', the panel printed the SAME label on both jacks and named
    // the trigger after the knob. Pin both, and pin that they DIFFER.
    const ids = qbrtDef.inputs.map((p) => p.id);
    expect(ids).toContain('ping');
    expect(ids).toContain('pingDecay');
    expect(resolveVerboseLabel({ id: 'ping' })).toBe('PING');
    expect(resolveVerboseLabel({ id: 'pingDecay' })).toBe('PING DECAY');
    expect(resolveVerboseLabel({ id: 'ping' })).not.toBe(
      resolveVerboseLabel({ id: 'pingDecay' }),
    );
  });

  it('drops the redundant `_in` / `_out` DIRECTION suffix', () => {
    // Every surface that prints a jack label already states direction
    // structurally — the drill-down splits INPUTS from OUTPUTS, the rear card
    // draws a `←`/`→` glyph per hole in an `in`/`out` column — so `TRIGGER IN`
    // beside a `←` said it twice and spent label width doing it.
    expect(resolveVerboseLabel({ id: 'trigger_in' })).toBe('TRIGGER');
    expect(resolveVerboseLabel({ id: 'gate_in' })).toBe('GATE');
    expect(resolveVerboseLabel({ id: 'accent_in' })).toBe('ACCENT');
    expect(resolveVerboseLabel({ id: 'choke_in' })).toBe('CHOKE');
    expect(resolveVerboseLabel({ id: 'audio_out' })).toBe('AUDIO');
    expect(resolveVerboseLabel({ id: 'video_out' })).toBe('VIDEO');
    expect(resolveVerboseLabel({ id: 'scope_out' })).toBe('SCOPE');
    // …and it composes with the multi-segment ids + the prefix table.
    expect(resolveVerboseLabel({ id: 'yiq_y_in' })).toBe('YIQ Y');
    expect(resolveVerboseLabel({ id: 'audio_l_in' })).toBe('AUDIO L');
    expect(resolveVerboseLabel({ id: 'v1_audio_in' })).toBe('V1 AUDIO');
  });

  it('never strips a suffix that is not a WHOLE trailing segment', () => {
    // The bug this forecloses: a naive endsWith('in') eats the tail of any word
    // ending in -in / -out. Only a `_`-delimited final segment is a direction.
    expect(resolveVerboseLabel({ id: 'gain' })).toBe('GAIN');
    expect(resolveVerboseLabel({ id: 'sustain' })).toBe('SUSTAIN');
    expect(resolveVerboseLabel({ id: 'audio_inv' })).toBe('AUDIO INV');
    expect(resolveVerboseLabel({ id: 'env_inv' })).toBe('ENV INV');
    // A port named for the direction ITSELF keeps its name (never blank).
    expect(resolveVerboseLabel({ id: 'out' })).toBe('OUT');
    expect(resolveVerboseLabel({ id: '_in' })).toBe('IN');
  });

  it('reads remaining UNDERSCORES as spaces (the lane drill-down fix)', () => {
    // The rear card ran its own `tidyLabel` de-underscore pass, but the lane
    // drill-down + the back panel call resolveVerboseLabel RAW — so they were
    // printing `SUB_DECAY` / `OUT_L` straight at the user. One rule, in the
    // shared helper, fixes every surface.
    expect(resolveVerboseLabel({ id: 'sub_decay' })).toBe('SUB DECAY');
    expect(resolveVerboseLabel({ id: 'out_l' })).toBe('OUT L');
    expect(resolveVerboseLabel({ id: 'body_shape' })).toBe('BODY SHAPE');
    expect(resolveVerboseLabel({ id: 'roll_speed' })).toBe('ROLL SPEED');
  });

  // ── THE COLLAPSED-PAIR LABEL POLICY (stereo normalization, PR-2b) ────────
  //
  // Two labels, two questions, and the reason `out_l` above still reads
  // "OUT L" rather than "OUT":
  //
  //   * A SINGLE PORT keeps its own label. An uncollapsed rail shows both
  //     jacks and must distinguish them, so `out_l` is "OUT L" — unchanged,
  //     on every surface, by this PR and by PR-4.
  //   * A COLLAPSED PAIR (PR-4 renders one jack for a derived stereo pair)
  //     labels from the pair's shared STEM, which is derived ONCE in
  //     $lib/graph/stereo-pairs and rendered through this same resolver.
  //
  // Pinned here so the two cannot be conflated later and so the collapsed
  // form is a DECISION in the record before the surface that draws it exists.
  it('a COLLAPSED stereo pair labels from its shared stem, not from either side', () => {
    const stem = (left: string): string =>
      resolveVerboseLabel({ id: stereoPairStemId({ left }) ?? left });
    expect(stem('out_l')).toBe('OUT'); // vs 'OUT L' for the lone port
    expect(stem('masterL')).toBe('MASTER');
    expect(stem('in_l')).toBe('IN');
    // sidecar's `audio_l_in` collapses to the stem `audio_in`, which this
    // resolver then renders 'AUDIO' — the SAME direction-collision rule the
    // test above states (the rail + glyph disambiguate, not the text). The
    // collapsed label inherits that policy rather than re-deciding it.
    expect(stem('audio_l_in')).toBe('AUDIO');
    // A STEMLESS pair (charlottes-echos declares bare `L`/`R`) has no stem to
    // label from — stereoPairStemId returns null rather than inventing one, so
    // the caller has to source the label elsewhere. Asserted so the null is a
    // documented outcome, not an accident.
    expect(stereoPairStemId({ left: 'L' })).toBeNull();
  });

  it('the DIRECTION collision is disambiguated by rail, not by text (stated policy)', () => {
    // SAMPLE-HOLD declares BOTH `cv_in` and `cv_out`: after stripping they read
    // the same, on purpose. They are the same signal named once, and the
    // surfaces separate them by RAIL + glyph before any text is drawn. Pinned
    // so the collapse is a DECISION in the record, not a surprise later.
    expect(resolveVerboseLabel({ id: 'cv_in' })).toBe('CV');
    expect(resolveVerboseLabel({ id: 'cv_out' })).toBe('CV');
    // …and an explicit label always wins when a module does need them split.
    expect(resolveVerboseLabel({ id: 'cv_out', label: 'cv thru' })).toBe('CV THRU');
  });

  it('respects an explicit label override', () => {
    expect(resolveVerboseLabel({ id: 'whatever', label: 'my custom label' })).toBe(
      'MY CUSTOM LABEL',
    );
  });

  it('does NOT silently pass through abbreviations as the panel default', () => {
    // The whole point of the verbose-label rule: someone reverting "RES" or
    // "ATK" inside a card should fail this test.
    const badAbbrevs = ['ATK', 'DCY', 'SUS', 'REL', 'RES', 'CUT', 'VOL', 'PNG', 'PIT', 'TRG'];
    for (const id of ['attack', 'decay', 'sustain', 'release', 'resonance', 'cutoff', 'volume', 'pitch', 'trigger']) {
      const out = resolveVerboseLabel({ id });
      expect(badAbbrevs).not.toContain(out);
    }
  });
});

describe('groupPortsByCableType', () => {
  it('orders gate, pitch, cv, audio, poly groups', () => {
    const ports: PortDescriptor[] = [
      { id: 'audio_in', cable: 'audio' },
      { id: 'cutoff', cable: 'cv' },
      { id: 'gate', cable: 'gate' },
      { id: 'pitch', cable: 'pitch' },
      { id: 'poly', cable: 'polyPitchGate' },
    ];
    const groups = groupPortsByCableType(ports, 'input');
    expect(groups.map((g) => g.cable)).toEqual(['gate', 'pitch', 'cv', 'audio', 'polyPitchGate']);
    expect(groups.map((g) => g.label)).toEqual(['Gates', 'Pitches', 'CV', 'Audio', 'Poly']);
  });

  it('preserves declared order within a group', () => {
    const ports: PortDescriptor[] = [
      { id: 'attack', cable: 'cv' },
      { id: 'decay', cable: 'cv' },
      { id: 'sustain', cable: 'cv' },
      { id: 'release', cable: 'cv' },
    ];
    const groups = groupPortsByCableType(ports, 'input');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.ports.map((p) => p.id)).toEqual(['attack', 'decay', 'sustain', 'release']);
  });
});

describe('remoteEndpointsTitle', () => {
  // ⚠ THE ONE THAT MATTERS. The input side used to print `remotes[0]` and drop
  // the rest, on the premise "an INPUT takes one cable" — true of a mono input,
  // FALSE of a collapsed stereo jack, which is one jack over two ports each
  // taking its own cable. The owner's `RET1` is fed by `es9.in14` on its L leg
  // and `es9.in13` on its R, so the jack named only IN14 while the matching
  // SEND 1 output correctly named both its targets.
  //
  // A SINGLE-remote input renders identically either way, so a one-cable test
  // CANNOT fail on the old code. This is the case that can.
  it('an INPUT fed by TWO sources names BOTH', () => {
    expect(remoteEndpointsTitle('input', ['es-9.IN14', 'es-9.IN13'])).toBe(
      '← es-9.IN14, es-9.IN13',
    );
  });

  it('an OUTPUT feeding TWO targets names BOTH', () => {
    expect(remoteEndpointsTitle('output', ['es-9.OUT3', 'es-9.OUT4'])).toBe(
      '→ es-9.OUT3, es-9.OUT4',
    );
  });

  it('ARROW ONLY — no FROM/TO word (owner, #2264)', () => {
    // "we don't need to see the 'from'" — the glyph carries the direction and
    // the freed width goes to the remote names. Pinned as an absence so the
    // words cannot creep back in as "clarification".
    expect(remoteEndpointsTitle('input', ['feedback.OUT'])).toBe('← feedback.OUT');
    expect(remoteEndpointsTitle('input', ['feedback.OUT'])).not.toContain('FROM');
    expect(remoteEndpointsTitle('output', ['vca.AUDIO'])).not.toContain('TO ');
  });

  it('the ARROW is the only thing that differs between the two directions', () => {
    // The asymmetry WAS the bug, so it is asserted away rather than left for
    // the next reader of the old docstring to reintroduce as an invariant.
    const remotes = ['a.X', 'b.Y', 'c.Z'];
    const input = remoteEndpointsTitle('input', remotes)!;
    const output = remoteEndpointsTitle('output', remotes)!;
    expect(input.replace('←', '')).toBe(output.replace('→', ''));
  });

  it('reads naturally with ONE remote — a half-patched collapsed jack', () => {
    // Normal state on this branch: per-leg patching means a stereo jack often
    // has one leg patched and one empty. No trailing comma, no "1 of 2".
    expect(remoteEndpointsTitle('input', ['es-9.IN14'])).toBe('← es-9.IN14');
    expect(remoteEndpointsTitle('output', ['es-9.OUT3'])).toBe('→ es-9.OUT3');
  });

  it('an UNPATCHED jack has NO title (undefined, not an empty arrow)', () => {
    // Callers render undefined as "no title attribute at all"; an empty string
    // would put a bare "←" tooltip on every hollow jack.
    expect(remoteEndpointsTitle('input', [])).toBeUndefined();
    expect(remoteEndpointsTitle('output', [])).toBeUndefined();
  });
});
