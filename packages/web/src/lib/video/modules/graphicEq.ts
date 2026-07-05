// packages/web/src/lib/video/modules/graphicEq.ts
//
// GRAPHIC EQ — a full-screen Winamp-style graphic-EQ / VU-meter video OUTPUT.
//
// STEREO audio in (left + right) → 8 log-spaced frequency bands per channel,
// each drawn as a vertical level meter rising/falling with the audio. Two
// classic Winamp looks (a switch toggles them):
//   • SOLID BARS  — each meter is one smooth filled bar (green→yellow→red).
//   • STACKED BOXES — each meter is an LED ladder of discrete segments.
// And a MONO/STEREO display switch:
//   • MONO   — 8 meters across the full width (L/R averaged).
//   • STEREO — screen split L|R: the LEFT channel's 8 meters on the LEFT half,
//              the RIGHT channel's on the RIGHT half (left-on-left/right-on-right).
//
// Implementation (mirrors RUTTETRA's custom-program pattern — the engine's
// compileFragment only pairs a frag with the shared fullscreen-quad vertex
// shader, but bars/boxes are QUAD GEOMETRY, so we build our own pos+color
// program + a dynamic interleaved VBO and gl.drawArrays(TRIANGLES) into a
// per-instance FBO that feeds the standard `out` port + the on-card preview):
//   - Each draw() reads the two AnalyserNodes' byte frequency data, folds it
//     into 8 bands (graphic-eq-core.foldBands), updates a per-band peak-hold,
//     lays out the meter columns for the current display mode, and emits the
//     bar/box/peak rectangles (with a vertical colour gradient) into the VBO.
//   - The bin→band fold, mono fold, segment quantization, split-rect layout
//     and colour ramp are all PURE + unit-tested in graphic-eq-core.ts.
//
// Audio path (the RECORDERBOX cross-domain audio→video pattern): the module
// owns one AnalyserNode per L/R input port, published via `audioInputs`
// (VideoEngine.getAudioInput) so the audio engine connects the upstream source
// straight into them. A gain(0)→destination keep-alive guarantees Chromium
// actually pulls the subgraph (an orphan analyser is never processed). All
// audio is TAP-ONLY/inaudible — this is a visualizer, not a bus.
//
// Inputs:
//   audio_l / audio_r (audio) — the stereo signal to visualize.
// Outputs:
//   out (video) — the rendered meters (chainable + the card preview source).
// Params:
//   style (0=bars, 1=boxes), display (0=mono, 1=stereo), gain, peak, hue.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  BAND_COUNT,
  SEGMENTS,
  FFT_SIZE,
  bandBinRanges,
  foldBands,
  layoutColumns,
  segmentRects,
  solidBarRects,
  colorAt,
  decayPeak,
  displayFromParam,
  styleFromParam,
  type MeterColumn,
} from './graphic-eq-core';

// ---- Custom pos(vec2 NDC) + color(vec3) program (quad geometry). ----
const VERT_SRC = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;   // NDC
layout(location = 1) in vec3 aColor;
out vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;
in vec3 vColor;
out vec4 outColor;
void main() {
  outColor = vec4(vColor, 1.0);
}`;

interface GraphicEqParams {
  style: number;
  display: number;
  gain: number;
  peak: number;
  hue: number;
}

const DEFAULTS: GraphicEqParams = {
  // 1 = stacked boxes — the iconic Winamp spectrum look out of the box.
  style: 1,
  // 1 = stereo split (the module's signature feature).
  display: 1,
  // Sensitivity: bands tend to read low post-FFT, so lift them a touch.
  gain: 1.6,
  // Peak-hold decay per frame (higher = the cap lingers longer).
  peak: 0.92,
  // Colour rotation (0 = classic green→yellow→red).
  hue: 0,
};

// Background + dim-track / unlit-segment colours (the always-on meter frame so
// the card is never a black void even with no audio patched).
const BG = [0.02, 0.02, 0.035] as const;
const DIM = 0.14; // multiplier for unlit segments / the solid-bar track
const PEAK_CAP_H = 0.012; // peak marker thickness (normalized)
// Render margins so the meters don't bleed into the frame edges.
const MARGIN_X = 0.02;
const MARGIN_Y = 0.04;

/** Max rectangles per frame: 2 channels × BAND_COUNT columns × (SEGMENTS rungs
 *  + track + fill + peak) + a stereo divider. Used to size the VBO once. */
const MAX_RECTS = 2 * BAND_COUNT * (SEGMENTS + 3) + 4;
const FLOATS_PER_VERT = 5; // x,y,r,g,b
const VERTS_PER_RECT = 6;

export const graphicEqDef: VideoModuleDef = {
  type: 'graphicEq',
  palette: { top: 'Video modules', sub: 'Processors' },
  domain: 'video',
  label: 'graphic eq',
  category: 'output',
  inputs: [
    // STEREO audio in. `audio`-typed inputs on a VIDEO module — the cross-domain
    // audio→video bridge connects the upstream source straight into the
    // AnalyserNode this handle publishes via `audioInputs`.
    { id: 'audio_l', type: 'audio' },
    { id: 'audio_r', type: 'audio' },
  ],
  outputs: [
    { id: 'out', type: 'video' },
  ],
  params: [
    { id: 'style',   label: 'Style',   defaultValue: DEFAULTS.style,   min: 0,    max: 1,    curve: 'discrete' },
    { id: 'display', label: 'Display', defaultValue: DEFAULTS.display, min: 0,    max: 1,    curve: 'discrete' },
    { id: 'gain',    label: 'Gain',    defaultValue: DEFAULTS.gain,    min: 0.5,  max: 4,    curve: 'linear' },
    { id: 'peak',    label: 'Peak',    defaultValue: DEFAULTS.peak,    min: 0.5,  max: 0.99, curve: 'linear' },
    { id: 'hue',     label: 'Hue',     defaultValue: DEFAULTS.hue,     min: 0,    max: 1,    curve: 'linear' },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: `A full-screen Winamp-style graphic-EQ / VU-meter video output. Patch a STEREO signal into the L and R audio inputs and GRAPHIC EQ analyses each channel with an FFT, folds it into 8 log-spaced frequency bands (roughly 40 Hz up to 16 kHz, an octave-ish per band), and draws each band as a vertical level meter that rises and falls with the music. A green→yellow→red colour ramp climbs each meter (rotate the whole palette with Hue), and a peak-hold cap floats above each bar and falls back at a rate set by Peak. Two switches shape the look: STYLE toggles between SOLID BARS (one smooth filled bar per band) and STACKED BOXES (the classic LED-ladder of discrete segments); DISPLAY toggles between MONO (8 meters across the full width, the L/R average) and STEREO (the screen splits down the middle — the LEFT channel's 8 meters fill the left half, the RIGHT channel's fill the right half). Gain sets sensitivity. With nothing patched the meter frame still draws dim so the card is never black. The render feeds the chainable video out and the on-card preview; hide the controls to use the card as a resizable full-screen monitor.`,
    inputs: {
      audio_l: "Left channel of the stereo signal to visualize. An audio-typed input on a video module (the cross-domain audio→video bridge): the source is connected straight into an AnalyserNode the module owns, whose FFT drives the LEFT meters (and half of the MONO average). Tap-only/inaudible — route the source to AUDIO OUT separately to hear it.",
      audio_r: "Right channel of the stereo signal to visualize. Like audio_l but feeds the RIGHT meters (and the other half of the MONO average). Patch a stereo mix across L and R; in MONO display the two are averaged. Tap-only/inaudible.",
    },
    outputs: {
      out: "out (video) - the rendered meters: 8 (mono) or 2x8 (stereo) frequency bars/boxes with a green→yellow→red gradient and peak-hold caps, over a dark field. Chainable into any video input and also feeds the on-card preview screen.",
    },
    controls: {
      style: "Style (0..1 switch, default boxes): toggles the meter look. 0 = SOLID BARS (each band is one smooth filled bar). 1 = STACKED BOXES (each band is an LED ladder of discrete lit segments). The card's STYLE button flips it.",
      display: "Display (0..1 switch, default stereo): toggles the layout. 0 = MONO (8 meters across the full width, fed by the L/R average). 1 = STEREO (the screen splits L|R — the left channel's 8 meters on the left half, the right channel's on the right half). The card's MONO/STEREO button flips it.",
      gain: "Gain (0.5..4, default 1.6): sensitivity. Multiplies each band magnitude before it drives the meter height (FFT bands read low, so the default lifts them); higher makes quiet material reach further up the meters, clamped at the top.",
      peak: "Peak (0.5..0.99, default 0.92): peak-hold decay. A cap marker jumps up instantly to each band's latest peak then falls back, multiplying by this factor per frame — 0.5 falls fast, 0.99 lingers near the top.",
      hue: "Hue (0..1, default 0): rotates the whole green→yellow→red colour ramp around the hue wheel (0 = classic VU colours, 0.5 = ~180° opposite), tinting both bars and peak caps.",
    },
  },
  // docs-hash-ignore:end

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;

    // ---- Build the pos+color program. ----
    function compile(type: number, src: string): WebGLShader {
      const sh = gl.createShader(type);
      if (!sh) throw new Error('GRAPHIC EQ: createShader failed');
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`GRAPHIC EQ: shader compile failed: ${log}`);
      }
      return sh;
    }
    const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    const program = gl.createProgram();
    if (!program) throw new Error('GRAPHIC EQ: createProgram failed');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`GRAPHIC EQ: program link failed: ${log}`);
    }

    // ---- Dynamic VBO + VAO (rebuilt each frame). ----
    const vbo = gl.createBuffer();
    const vao = gl.createVertexArray();
    if (!vbo || !vao) throw new Error('GRAPHIC EQ: VBO / VAO alloc failed');
    const vertexData = new Float32Array(MAX_RECTS * VERTS_PER_RECT * FLOATS_PER_VERT);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, vertexData.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS_PER_VERT * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 2 * 4);
    gl.bindVertexArray(null);

    // ---- Per-instance FBO (output target + chainable `out` texture). ----
    const { fbo, texture } = ctx.createFbo();

    // ---- Stereo AnalyserNodes (the audio→video audio-input bridge sinks). ----
    // Published via audioInputs so the engine connects the upstream source into
    // them. A gain(0)→destination keep-alive makes Chromium pull the subgraph
    // (an analyser with no path to the destination is never processed → no data).
    let audioInputs: Map<string, { node: AudioNode; input: number }> | undefined;
    let analyserL: AnalyserNode | null = null;
    let analyserR: AnalyserNode | null = null;
    let keepAlive: GainNode | null = null;
    let freqBuf: Uint8Array<ArrayBuffer> | null = null;
    let ranges: Array<[number, number]> | null = null;
    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      analyserL = ac.createAnalyser();
      analyserR = ac.createAnalyser();
      for (const a of [analyserL, analyserR]) {
        a.fftSize = FFT_SIZE;
        a.smoothingTimeConstant = 0.7;
        a.minDecibels = -85;
        a.maxDecibels = -20;
      }
      keepAlive = ac.createGain();
      keepAlive.gain.value = 0;
      analyserL.connect(keepAlive);
      analyserR.connect(keepAlive);
      try {
        keepAlive.connect(ac.destination);
      } catch {
        // Offline / test context with no real destination — nothing to pull.
      }
      if (ac.state === 'suspended') void ac.resume?.().catch(() => { /* best-effort */ });
      freqBuf = new Uint8Array(analyserL.frequencyBinCount);
      ranges = bandBinRanges(ac.sampleRate, FFT_SIZE, BAND_COUNT);
      audioInputs = new Map<string, { node: AudioNode; input: number }>([
        ['audio_l', { node: analyserL, input: 0 }],
        ['audio_r', { node: analyserR, input: 0 }],
      ]);
    }

    const params: GraphicEqParams = { ...DEFAULTS, ...(node.params as Partial<GraphicEqParams>) };

    // Peak-hold state (transient render state — never a synced write). One cap
    // per band per channel; the mono cap reuses the left slot.
    const peakL = new Float32Array(BAND_COUNT);
    const peakR = new Float32Array(BAND_COUNT);

    // ---- Geometry builder (CPU). Fills `vertexData`, returns the vertex count. ----
    function ndcX(x: number): number {
      return (MARGIN_X + x * (1 - 2 * MARGIN_X)) * 2 - 1;
    }
    function ndcY(y: number): number {
      return (MARGIN_Y + y * (1 - 2 * MARGIN_Y)) * 2 - 1;
    }

    function buildGeometry(): number {
      const data = vertexData;
      let o = 0;
      // pushRect with a per-corner vertical gradient (bottom colour → top colour).
      function pushRect(
        x0: number, y0: number, x1: number, y1: number,
        cb: readonly [number, number, number],
        ct: readonly [number, number, number],
      ): void {
        if (o + VERTS_PER_RECT * FLOATS_PER_VERT > data.length) return; // overflow guard
        const ax = ndcX(x0), bx = ndcX(x1);
        const ay = ndcY(y0), by = ndcY(y1);
        const v = (px: number, py: number, c: readonly [number, number, number]) => {
          data[o++] = px; data[o++] = py; data[o++] = c[0]!; data[o++] = c[1]!; data[o++] = c[2]!;
        };
        // two triangles: (BL, BR, TL) (TL, BR, TR)
        v(ax, ay, cb); v(bx, ay, cb); v(ax, by, ct);
        v(ax, by, ct); v(bx, ay, cb); v(bx, by, ct);
      }

      // Read analyser → bands (silent / no-audio → all zeros → dim frame).
      let lBands: Float32Array;
      let rBands: Float32Array;
      if (analyserL && analyserR && freqBuf && ranges) {
        analyserL.getByteFrequencyData(freqBuf);
        lBands = foldBands(freqBuf, { fftSize: FFT_SIZE, gain: params.gain, ranges });
        analyserR.getByteFrequencyData(freqBuf);
        rBands = foldBands(freqBuf, { fftSize: FFT_SIZE, gain: params.gain, ranges });
      } else {
        lBands = new Float32Array(BAND_COUNT);
        rBands = new Float32Array(BAND_COUNT);
      }

      // Update peak-hold caps.
      for (let i = 0; i < BAND_COUNT; i++) {
        peakL[i] = decayPeak(peakL[i]!, lBands[i]!, params.peak);
        peakR[i] = decayPeak(peakR[i]!, rBands[i]!, params.peak);
      }

      const display = displayFromParam(params.display);
      const style = styleFromParam(params.style);
      const cols = layoutColumns(lBands, rBands, display);

      const peakFor = (c: MeterColumn): number =>
        c.channel === 'right' ? peakR[c.band]! : peakL[c.band]!;

      for (const col of cols) {
        if (style === 'boxes') {
          const { lit, rects } = segmentRects(col, SEGMENTS);
          for (let i = 0; i < rects.length; i++) {
            const r = rects[i]!;
            const yc = (r.y0 + r.y1) * 0.5;
            const base = colorAt(yc, params.hue);
            const col3 = i < lit ? base : ([base[0] * DIM, base[1] * DIM, base[2] * DIM] as const);
            pushRect(r.x0, r.y0, r.x1, r.y1, col3, col3);
          }
        } else {
          const { track, fill } = solidBarRects(col);
          const dimC = ([colorAt(0.5, params.hue)[0] * DIM, colorAt(0.5, params.hue)[1] * DIM, 0] as const);
          pushRect(track.x0, track.y0, track.x1, track.y1, dimC, dimC);
          if (fill.y1 > 0.001) {
            // Vertical green→yellow→red gradient from bottom to the bar's top.
            pushRect(fill.x0, fill.y0, fill.x1, fill.y1, colorAt(0, params.hue), colorAt(fill.y1, params.hue));
          }
        }
        // Peak-hold cap (a thin bright marker floating at the held peak).
        const pk = peakFor(col);
        if (pk > 0.001) {
          const capC = colorAt(pk, params.hue);
          const y0 = Math.max(0, pk - PEAK_CAP_H);
          pushRect(col.x0, y0, col.x1, Math.min(1, pk), capC, capC);
        }
      }

      // STEREO center divider (a subtle vertical seam).
      if (display === 'stereo') {
        const seam = ([0.18, 0.18, 0.22] as const);
        pushRect(0.498, 0, 0.502, 1, seam, seam);
      }

      return o / FLOATS_PER_VERT;
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        const g = frame.gl;
        const vertCount = buildGeometry();

        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.clearColor(BG[0], BG[1], BG[2], 1);
        g.clear(g.COLOR_BUFFER_BIT);

        // Opaque quads — ensure blend is off (a prior module may have left it on)
        // so overlapping track/fill rects composite by draw order, not by alpha.
        g.disable(g.BLEND);
        g.useProgram(program);
        g.bindVertexArray(vao);
        g.bindBuffer(g.ARRAY_BUFFER, vbo);
        g.bufferSubData(g.ARRAY_BUFFER, 0, vertexData, 0, vertCount * FLOATS_PER_VERT);
        g.drawArrays(g.TRIANGLES, 0, vertCount);
        g.bindVertexArray(null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteBuffer(vbo);
        gl.deleteVertexArray(vao);
        gl.deleteProgram(program);
      },
    };

    return {
      domain: 'video',
      surface,
      audioInputs,
      setParam(paramId, value) {
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'fboTexture') return texture;
        return undefined;
      },
      dispose() {
        surface.dispose();
        try { analyserL?.disconnect(); } catch { /* */ }
        try { analyserR?.disconnect(); } catch { /* */ }
        try { keepAlive?.disconnect(); } catch { /* */ }
      },
    };
  },
};
