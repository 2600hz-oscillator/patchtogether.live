// packages/web/src/lib/video/modules/out-to-launch.ts
//
// OUT TO LAUNCH — turns a Novation Launchpad Mini Mk3 into a live 9×9 RGB video
// MONITOR. Takes a `video` input, downsamples it to a 9×9 RGB grid on the GPU,
// and (from the CARD's throttled rAF loop) pushes those 81 pixels to a BOUND
// Launchpad's LEDs via the batch-RGB SysEx. The full addressable surface is a
// 9×9 grid — the 8×8 pads + the top CC row + the right scene column + the corner
// logo — so the downsample maps DIRECTLY onto the hardware (see lpMonitorIndex
// in launchpad-sysex).
//
// ── Where the work is split ────────────────────────────────────────────────
//   * THIS factory is pure-GL + DOM-free: it box-averages the input into a tiny
//     9×9 FBO and `readPixels` the 81 RGBA texels into a reused Uint8Array each
//     frame, exposed via read('grid9x9'). Same downsample-then-readback pattern
//     SHAPEGEN uses, just to a 9×9 target. It never touches Web MIDI (kept out
//     of the render-hot path + out of the jsdom-test surface).
//   * The CARD (OutToLaunchCard.svelte) owns the device: connect (gesture-gated
//     sysex), pick + bindMonitor a Launchpad output, and — in its rAF loop —
//     read('grid9x9'), map it to LED colours (monitorGridToLeds), and
//     setMonitorFrame() at a throttled ~30 fps. It also draws the same grid as
//     an on-card preview so you can see the monitor with no hardware.
//
// pullExempt: the module drives EXTERNAL hardware (a real side effect with no
// audio surface + no video output), so its draw() must keep running to refresh
// the 9×9 readback even when the card is scrolled off-screen — exactly the
// escape-hatch the pull-eval doc describes (cf. MIRRORPOOL's real-time sim).
//
// No video OUTPUT: this is a SINK (its "output" is the LED surface), so it is
// auto-skipped by the per-module-per-port + behavioral emit sweeps
// (`mod.outputs.length === 0`), like MIDI-OUT-BUDDY.

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';

/** The monitor grid is 9×9 (matches the Launchpad's full addressable surface). */
export const OUT_TO_LAUNCH_GRID = 9;
/** RGBA bytes in one 9×9 readback (81 texels × 4). */
export const OUT_TO_LAUNCH_GRID_BYTES = OUT_TO_LAUNCH_GRID * OUT_TO_LAUNCH_GRID * 4; // 324
/** Box-average taps per axis per output cell. Each 9×9 cell spans a large source
 *  region (~114×85 px at 1024×768); averaging TAPS×TAPS samples across it gives
 *  a stable area-average (vs a single bilinear tap that aliases/flickers on
 *  moving video). 6×6 = 36 samples × 81 cells = ~2.9k fetches/frame — trivial. */
export const OUT_TO_LAUNCH_TAPS = 6;

// Box-average downsample: for each 9×9 output texel, average TAPS×TAPS samples
// spread across that texel's source cell. vUv is the output texel centre; the
// cell spans 1/9 in each axis. Y is NOT flipped — the engine stores input
// textures so that texture(uTex, vUv) reads upright (see video-out), so a
// bottom-origin readback of this FBO is already upright, and the bottom-left
// cell maps to Launchpad pad 11 (also bottom-left) with no flip.
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasInput;

const int   GRID = ${OUT_TO_LAUNCH_GRID};
const int   TAPS = ${OUT_TO_LAUNCH_TAPS};
const float CELL = 1.0 / float(${OUT_TO_LAUNCH_GRID});

void main() {
  if (uHasInput < 0.5) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec2 origin = vUv - 0.5 * vec2(CELL);   // this cell's lower-left in UV
  vec3 sum = vec3(0.0);
  for (int j = 0; j < TAPS; j++) {
    for (int i = 0; i < TAPS; i++) {
      vec2 t = (vec2(float(i), float(j)) + 0.5) / float(TAPS); // 0..1 within cell
      sum += texture(uTex, origin + t * vec2(CELL)).rgb;
    }
  }
  outColor = vec4(sum / float(TAPS * TAPS), 1.0);
}`;

export interface OutToLaunchParams {
  bright: number; // 0..1 overall LED brightness
  gamma: number;  // gamma exponent (1 = linear); >1 deepens mids/blacks
}

export const OUT_TO_LAUNCH_DEFAULTS: OutToLaunchParams = {
  bright: 1,
  // 2.2 flatters the very-bright RGB LEDs (deepens blacks, keeps highlights) —
  // a good default for a moving video source; 1.0 is a literal what-you-see map.
  gamma: 2.2,
};

const PARAM_IDS: ReadonlySet<string> = new Set(Object.keys(OUT_TO_LAUNCH_DEFAULTS));

export const outToLaunchDef: VideoModuleDef = {
  type: 'outToLaunch',
  palette: { top: 'Video modules', sub: 'Utilities' },
  domain: 'video',
  label: 'out to launch',
  category: 'output',
  inputs: [
    { id: 'in', type: 'video' },
  ],
  outputs: [],
  params: [
    { id: 'bright', label: 'Bright', defaultValue: OUT_TO_LAUNCH_DEFAULTS.bright, min: 0,   max: 1, curve: 'linear' },
    { id: 'gamma',  label: 'Gamma',  defaultValue: OUT_TO_LAUNCH_DEFAULTS.gamma,  min: 0.5, max: 3, curve: 'linear' },
  ],
  // Drives external hardware LEDs (no output texture, no audio) — keep drawing
  // while unobserved so the 9×9 readback the card pushes stays fresh.
  pullExempt: true,

  // docs-hash-ignore:start
  docs: {
    explanation:
      "out to launch turns a Novation Launchpad Mini Mk3 into a live 9x9 RGB video monitor. Patch any video source into it, and it downsamples that frame to a 9x9 grid on the GPU (each cell is a box-average of its slice of the frame, so it doesn't alias or flicker on moving video) and mirrors those 81 pixels onto the Launchpad's LEDs in real time. The Mini Mk3's whole addressable surface is a 9x9 grid — the 8x8 pads plus the top control row, the right scene column, and the corner logo — so the picture maps straight onto the hardware, upright, with the bottom-left of the frame on the bottom-left pad. Bind a device from the card (Connect, then pick a Launchpad); once bound it becomes a screen and its LEDs are driven by the video, so it can't be used for control at the same time (out to launch takes it over). It has no video output — it's an endpoint, like plugging a monitor into the end of a chain, except the monitor is a grid of buttons. Two knobs shape the look: BRIGHT scales overall LED brightness and GAMMA deepens or lifts the mid-tones. The on-card 9x9 preview shows exactly what the LEDs show, so you can dial it in without hardware. Great for a tiny confidence monitor, a lo-fi VJ output, or lighting a Launchpad from a camera/generator feed.",
    inputs: {
      in: "The video frame to display. It is box-averaged down to a 9x9 RGB grid and pushed to the bound Launchpad's LEDs; with nothing patched the grid is black (LEDs off). Accepts any video-domain source (the engine upcasts mono-video and image to video).",
    },
    outputs: {},
    controls: {
      bright: "BRIGHT (0..1, default 1) scales the overall LED brightness — every cell's RGB is multiplied by this before it's sent, so lower values dim the whole monitor (useful because the RGB LEDs are very bright). Applied identically to the on-card preview.",
      gamma: "GAMMA (0.5..3, default 2.2) is the gamma exponent applied to each colour channel before scaling. 1 is a literal what-you-see map; above 1 deepens the mid-tones and blacks (usually flatters the bright LEDs on a moving source); below 1 lifts dim detail. Applied identically to the on-card preview.",
    },
  },
  // docs-hash-ignore:end

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHasInput = gl.getUniformLocation(program, 'uHasInput');

    // A sink has no output surface (fbo/texture null); we allocate our OWN tiny
    // 9×9 read FBO to downsample into + readPixels off. (Not ctx.createFbo() —
    // that mints an engine-res FBO; we want a fixed 9×9.)
    const readFbo = gl.createFramebuffer();
    const readTex = gl.createTexture();
    if (readTex) {
      gl.bindTexture(gl.TEXTURE_2D, readTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, OUT_TO_LAUNCH_GRID, OUT_TO_LAUNCH_GRID, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      if (readFbo) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, readFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, readTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    }

    // Reused RGBA readback (bottom-origin, row-major) — the card reads this via
    // read('grid9x9') each rAF, maps it to LED colours, and pushes it.
    const grid = new Uint8Array(OUT_TO_LAUNCH_GRID_BYTES);

    // Strip stray/unknown keys so they can't bleed into the params.
    const rawParams = node.params as Record<string, unknown>;
    const filtered: Record<string, number> = {};
    for (const [k, v] of Object.entries(rawParams)) {
      if (PARAM_IDS.has(k) && typeof v === 'number') filtered[k] = v;
    }
    const params: OutToLaunchParams = { ...OUT_TO_LAUNCH_DEFAULTS, ...(filtered as Partial<OutToLaunchParams>) };

    let framesElapsed = 0;
    let hasInput = false;

    const surface: VideoNodeSurface = {
      fbo: null,
      texture: null,
      draw(frame) {
        const g = frame.gl;
        const inputTex = frame.getInputTexture(node.id, 'in');
        hasInput = inputTex !== null;

        // Downsample the input into the 9×9 read FBO via the box-average shader.
        g.bindFramebuffer(g.FRAMEBUFFER, readFbo);
        g.viewport(0, 0, OUT_TO_LAUNCH_GRID, OUT_TO_LAUNCH_GRID);
        g.useProgram(program);
        g.uniform1f(uHasInput, inputTex ? 1.0 : 0.0);
        if (inputTex) {
          g.activeTexture(g.TEXTURE0);
          g.bindTexture(g.TEXTURE_2D, inputTex);
          g.uniform1i(uTex, 0);
        }
        ctx.drawFullscreenQuad();
        // Read the 81 texels back to the CPU (bottom-origin, upright).
        g.readPixels(0, 0, OUT_TO_LAUNCH_GRID, OUT_TO_LAUNCH_GRID, g.RGBA, g.UNSIGNED_BYTE, grid);
        g.bindFramebuffer(g.FRAMEBUFFER, null);

        framesElapsed++;
      },
      dispose() {
        if (readFbo) gl.deleteFramebuffer(readFbo);
        if (readTex) gl.deleteTexture(readTex);
        gl.deleteProgram(program);
      },
    };

    return {
      domain: 'video',
      surface,
      setParam(paramId, value) {
        if (paramId in params) (params as unknown as Record<string, number>)[paramId] = value;
      },
      readParam(paramId) {
        return (params as unknown as Record<string, number>)[paramId];
      },
      read(key) {
        // The card polls the raw 9×9 RGBA grid each rAF for the preview + LED push.
        if (key === 'grid9x9') return grid;
        if (key === 'hasInput') return hasInput;
        if (key === 'framesElapsed') return framesElapsed;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
