// packages/web/src/lib/video/modules/out-to-launch.ts
//
// OUT TO LAUNCH — turns a Novation Launchpad Mini Mk3 into a live 9×9 RGB video
// MONITOR. Takes a `video` input, downsamples it to a 9×9 RGB grid on the GPU,
// and pushes those 81 pixels to a BOUND Launchpad's LEDs via the batch-RGB
// SysEx. The full addressable surface is a 9×9 grid — the 8×8 pads + the top CC
// row + the right scene column + the corner logo — so the downsample maps
// DIRECTLY onto the hardware (see lpMonitorIndex in launchpad-sysex).
//
// ── Where the work is split ────────────────────────────────────────────────
//   * THIS factory is pure-GL + DOM-free: it box-averages the input into a tiny
//     9×9 FBO and `readPixels` the 81 RGBA texels into a reused Uint8Array each
//     frame, exposed via read('grid9x9'). Same downsample-then-readback pattern
//     SHAPEGEN uses, just to a 9×9 target. It never touches Web MIDI (kept out
//     of the render-hot path + out of the jsdom-test surface).
//   * THE 30 fps LED PUMP IS ON THE NODE, not on any component:
//     $lib/ui/modules/node-launchpad-monitor-registry. It reads `grid9x9` and
//     the live `bright`/`gamma` off the ENGINE and calls setMonitorFrame(). This
//     is #1728 — a card unmounts on collapse and on LRU eviction, and a
//     performer closing a pane is not a performer finished with their hardware.
//   * THE SURFACE is the PF-20 faceplate ($lib/ui/modules/outToLaunch/): a
//     ranked CONNECT cell that reaches the lane tile, plus a `fullViewBody`
//     carrying the 9×9 preview, its SCREEN switch, the port picker, UNBIND and
//     the MONITOR lamp. `OutToLaunchCard.svelte` still ships and still renders
//     under `?shell=legacy`; both draw the preview through the SAME
//     `out-to-launch-preview` module, so they cannot show different pictures.
//
// ⚠ THE PARAGRAPH ABOVE USED TO SAY "the CARD owns the device … in its rAF
// loop … setMonitorFrame() at a throttled ~30 fps", and it was already wrong
// before this module was faced — #1728 moved the pump onto the node and left
// the header describing the bug it had just fixed.
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
  // while unobserved so the 9×9 readback the node registry pushes stays fresh.
  pullExempt: true,

  // ── THE CONNECT GESTURE, DECLARED AS A ONE-MEMBER FAMILY ──────────────────
  //
  // `face.order` may hold a NON-param key exactly two ways: a `<familyId>-{n}`
  // template whose prefix is a family DECLARED here, or an entry in a committed
  // `<type>.legend.json`, of which three exist in the whole repo and none is
  // this module's. So the family is what lets the binding gesture be RANKED at
  // all, and ranking it is what puts it on the lane tile.
  //
  // ⚠ EXACTLY ONE FAMILY, and the ceiling is a GATE rather than a preference:
  // module-face-lint requires every declared family to appear in `face.order`
  // AND the dock plan to render it exactly once. A family is a promise to RANK,
  // not a vocabulary list — declaring the port picker or UNBIND here would force
  // them into cells they cannot be, for the mechanical reasons the face comment
  // below gives.
  //
  // The `testidPrefix` is a literal the LEGACY CARD already emits
  // (`OutToLaunchCard.svelte`, the Connect button), which is what
  // module-docs-lint's card grep checks — so a rename on either surface is RED.
  // The card file survives promotion: `?shell=legacy` still renders it.
  controlFamilies: [
    {
      id: 'out-to-launch-connect',
      label: 'Connect',
      kind: 'other',
      testidPrefix: 'out-to-launch-connect',
    },
  ],

  docs: {
    explanation:
      "out to launch turns a Novation Launchpad Mini Mk3 into a live 9x9 RGB video monitor. Patch any video source into it, and it downsamples that frame to a 9x9 grid on the GPU (each cell is a box-average of its slice of the frame, so it doesn't alias or flicker on moving video) and mirrors those 81 pixels onto the Launchpad's LEDs in real time. The Mini Mk3's whole addressable surface is a 9x9 grid — the 8x8 pads plus the top control row, the right scene column, and the corner logo — so the picture maps straight onto the hardware, upright, with the bottom-left of the frame on the bottom-left pad. Bind a device from the faceplate (Connect, then pick a Launchpad); once bound it becomes a screen and its LEDs are driven by the video, so it can't be used for control at the same time (out to launch takes it over). It has no video output — it's an endpoint, like plugging a monitor into the end of a chain, except the monitor is a grid of buttons. Two knobs shape the look: BRIGHT scales overall LED brightness and GAMMA deepens or lifts the mid-tones. the faceplate\'s 9x9 preview shows exactly what the LEDs show, so you can dial it in without hardware. Great for a tiny confidence monitor, a lo-fi VJ output, or lighting a Launchpad from a camera/generator feed.",
    inputs: {
      in: "The video frame to display. It is box-averaged down to a 9x9 RGB grid and pushed to the bound Launchpad's LEDs; with nothing patched the grid is black (LEDs off). Accepts any video-domain source (the engine upcasts mono-video and image to video).",
    },
    outputs: {},
    controls: {
      bright: "BRIGHT (0..1, default 1) scales the overall LED brightness — every cell's RGB is multiplied by this before it's sent, so lower values dim the whole monitor (useful because the RGB LEDs are very bright). Applied identically to the faceplate\'s preview.",
      gamma: "GAMMA (0.5..3, default 2.2) is the gamma exponent applied to each colour channel before scaling. 1 is a literal what-you-see map; above 1 deepens the mid-tones and blacks (usually flatters the bright LEDs on a moving source); below 1 lifts dim detail. Applied identically to the faceplate's preview.",
      // ⚠ THE `-{n}` SUFFIX IS REQUIRED: module-docs-lint resolves a docs key to
      // a control FAMILY only through `FAMILY_KEY = /^(.+)-\{n\}$/`, the same
      // spelling `face.order` uses. The bare family id reads as a param name and
      // is reported as an orphan.
      'out-to-launch-connect-{n}': "CONNECT LAUNCHPAD asks the browser for Web MIDI with sysex — a permission that must be granted from a real click, and that the whole module is inert without — and then lists the Launchpad outputs attached to this machine. Picking one from that list is what binds it as a monitor; the list and the UNBIND that releases it live on the faceplate's own surface, because a roster enumerated from the machine is not something a control can declare in advance. Pressing CONNECT again re-asks and re-lists, which is how you pick up a Launchpad that was plugged in after the first time.",
    },
  },

  // ── THE FACE ──────────────────────────────────────────────────────────────
  //
  // WHAT IT IS FOR: this is the only module that turns a piece of MIDI control
  // hardware into a video DISPLAY. Every other video sink ends in a screen; this
  // one ends in 81 RGB buttons, and the whole 9×9 addressable surface of a
  // Launchpad Mini Mk3 maps onto the frame with no cropping and no flip. The
  // verb a player performs is BIND A DEVICE — until one is bound the module
  // drives nothing — and the two knobs exist because LEDs are not a screen: they
  // are far brighter and far more contrasty, so a literal 1:1 map looks blown
  // out and GAMMA's 2.2 default is the picture actually shipping.
  //
  // ⚠ THE INVENTORY `why` CALLED THE KNOBS "INCIDENTAL TO THE BINDING FLOW" AND
  // THAT IS TRUE OF THE FLOW AND MISLEADING ABOUT THE MODULE. `bright` and
  // `gamma` are real `ParamDef`s that the LED pump reads off the live engine
  // handle every frame (`node-launchpad-monitor-registry` → `monitorGridToLeds`),
  // so they shape EVERY frame that reaches the hardware. What the `why` omitted
  // entirely is the 9×9 PREVIEW — the module's own docs call it the thing that
  // lets you "dial it in without hardware", and it is the only surface this
  // module has on a machine with no Launchpad attached. Ranked cells are exactly
  // how a control incidental to one flow and essential to the module should
  // appear, so all three rank.
  //
  // THE LADDER, read back as a sentence: at every tier you get the live picture
  // and the gesture the module is completely inert without; at compact you also
  // get BRIGHT, the knob that decides whether the panel is legible in the room
  // you are standing in; at the dock you additionally get GAMMA, the full-size
  // 9×9 monitor with its SCREEN switch, the port picker, UNBIND, and the lamp
  // that says which device is being driven and what that costs you.
  //
  // ⚠ CONNECT IS RANK 1 OVER BOTH KNOBS. The knobs shape a picture; CONNECT is
  // the reason there is anywhere to put it. A rack with an unbound OUT TO LAUNCH
  // drives no hardware at all, and the permission CONNECT asks for is
  // gesture-gated by the browser — so it is the one control here that a player
  // cannot route around and cannot reach by any other means.
  //
  // ⚠ BRIGHT OUTRANKS GAMMA, and the argument would be wrong for a different
  // module. On a normal display these are two shaping knobs of similar weight.
  // On this one they are not: `bright` is a linear scale over the whole surface
  // and is the control you reach for when the panel is physically too bright to
  // look at, which is the first thing a player notices about a Launchpad running
  // at full RGB. `gamma` redistributes mid-tones and is a look decision made
  // once. The lane tier shows two cells beside the picture; the first-reached
  // control belongs in it.
  //
  // ⚠ `glyph: 'none'` IS FORCED, NOT CHOSEN, and here the premise is true by
  // inspection: `outputs` is EMPTY, so `primaryAudioOutPortId`
  // (`outputs.find(o => o.type === 'audio')`) resolves null and every live-audio
  // glyph binding short-circuits to `{kind:'static'}`, which module-face-lint
  // reddens by name (#1692) with no exemption list. The tile's picture arrives
  // through a different seam entirely — `hasVideoSurface(def)` is
  // `domain === 'video'` — so `'none' + blank tile` and `'none' + live thumb`
  // are indistinguishable from this declaration, and `outtolaunch-face-model
  // .test.ts` asserts `hasVideoSurface` rather than trusting the literal.
  //
  // ⚠ NO `pages`. Three ranked cells and ONE idea: put this video on that
  // hardware. A header reading "device" over a single CONNECT cell and a second
  // reading "look" over two knobs would add ~81 px of band to say what the
  // captions already say, on a module whose plate is set by a 236 px picture.
  // `face.pages` is for a face with more than one IDEA in it.
  //
  // ⚠ NO `rear` GROUPS. `inputs` is one video jack and `outputs` is empty, so
  // the derived default is exactly right: one input section, one out-rail
  // section that renders nothing. An authored group here could only restate the
  // domain, which is the thing the rear-card note says not to author.
  //
  // The 9×9 monitor, its SCREEN switch, the port picker, UNBIND and the MONITOR
  // lamp are the extension's `fullViewBody` — see
  // $lib/ui/modules/outToLaunch/shell-extension.ts for why each one cannot be a
  // cell.
  face: {
    glyph: 'none',
    order: ['out-to-launch-connect-{n}', 'bright', 'gamma'],
    extension: 'outToLaunch',
  },

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
