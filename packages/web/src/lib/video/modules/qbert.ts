// packages/web/src/lib/video/modules/qbert.ts
//
// QBERT — Q*Bert (Gottlieb 1982) arcade emulator as a patchable video
// module. Shape mirrors DOOM / NIBBLES: a VIDEO module that ALSO publishes
// AudioNodes via `audioSources` for the cross-domain video→audio bridge.
//
// **MAME source citation**: this module ports the memory map + ROM-name
// surface of MAME's Gottlieb arcade driver (`src/mame/drivers/gottlieb.cpp`,
// GPL-2.0+ which is AGPL-compatible). The CPU emulation itself is original
// minimal code (see `qbert-runtime.ts` + `z80.ts` headers). v1 ships the
// engine SHAPE — full opcode coverage + the I8039 sound CPU port are
// follow-ups so the gateway plumbing (ROM zip → memory map → framebuffer →
// gate-event outputs) can be exercised end-to-end.
//
// Inputs (all CV):
//   - `coin_in`  (gate)  — rising edge inserts a quarter (COIN1 dip)
//   - `start_in` (gate)  — rising edge presses 1P START
//   - `joy_x`    (cv)    — -1..+1 → digital left (-) / right (+)
//   - `joy_y`    (cv)    — -1..+1 → digital up (-) / down (+)
//
// Q*Bert's joystick is 4-direction DIAGONAL (the cube grid is rotated 45°),
// so joy_x/joy_y resolve into one of NE/NW/SE/SW via joyCvToDiagonal —
// see joy-cv.ts.
//
// Outputs:
//   - `out`       (video) — 256×240 RGBA framebuffer, letterboxed into the
//                            engine's 640×360 FBO with aspect preservation.
//   - `audio_out` (audio) — mono PCM from the synthesized SFX stream
//                            (v1 stubs the I8039; the audio CSN is real
//                            so the audio path is testable end-to-end).
//   - `evt_die`   (gate)  — 10 ms pulse on Q*Bert death.
//   - `evt_move`  (gate)  — 10 ms pulse on every completed hop.
//   - `evt_level` (gate)  — 10 ms pulse on level advance.
//
// Per the QBERT spec: NO knob/slider UI on the card — all control is via
// CV/gate inputs.
//
// Memory: `relay-single-process-and-drift` memory note — emulator state
// stays LOCAL (per-client). No Yjs replication of frame state. If two
// users open a rackspace with QBERT, each runs their own runtime; the
// active user's CV/gates drive their local emulator, others see their
// own local instance (same SP behaviour DOOM ships).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoEngineContext, VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import {
  createQbertRuntime,
  loadQbertRoms,
  QBERT_WIDTH,
  QBERT_HEIGHT,
  type QbertRuntime,
} from '$lib/qbert/qbert-runtime';
import { joyCvToDiagonal, type QbertDiagonal } from '$lib/qbert/joy-cv';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';

// Fragment shader: sample the 256×240 RGBA framebuffer and letterbox it
// into the engine's 640×360 FBO. Q*Bert is 256:240 ≈ 1.067:1 (close to
// 4:3 cropped); the engine FBO is 16:9 (1.78:1). Keep full height + bars
// on either side.
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasFrame;
uniform vec2 uLetterbox;

void main() {
  if (uHasFrame < 0.5) {
    // Idle: dark void with a faint scanline so an unspawned QBERT card
    // still reads as "alive but no signal" rather than "broken".
    float scan = 0.5 + 0.5 * sin(vUv.y * 80.0);
    outColor = vec4(0.02, 0.02, 0.04, 1.0) * scan;
    return;
  }
  vec2 centered = (vUv - 0.5) / uLetterbox + 0.5;
  if (centered.x < 0.0 || centered.x > 1.0 || centered.y < 0.0 || centered.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  // Y-flip: framebuffer is row-major top-down, GL UVs are bottom-up.
  vec2 src = vec2(centered.x, 1.0 - centered.y);
  outColor = texture(uTex, src);
}`;

interface QbertParams {
  // Hidden CV params backing the input ports. Hidden from the card per
  // spec (no knobs); the engine's CV bridge writes via setParam.
  cv_coin_in:  number;
  cv_start_in: number;
  cv_joy_x:    number;
  cv_joy_y:    number;
}

const DEFAULTS: QbertParams = {
  cv_coin_in: 0,
  cv_start_in: 0,
  cv_joy_x: 0,
  cv_joy_y: 0,
};

/** Card-facing handle. The card reads runtime state via
 *  `engine.read(node, 'extras')` — same pattern as DoomHandleExtras /
 *  NibblesHandleExtras. */
export interface QbertHandleExtras {
  /** Live runtime (may be null while the ROM fetch is still in-flight). */
  getRuntime(): QbertRuntime | null;
  /** Was the ROM-load attempt completed? (Either successfully or with
   *  an error — see `loadError()`.) */
  isLoaded(): boolean;
  /** Empty string when ROM loaded OK; otherwise the user-facing reason. */
  loadError(): string;
  /** Snapshot the current 256×240 RGBA framebuffer for the card's
   *  on-card 2D preview blit. Returns null until the runtime exists. */
  snapshotFramebuffer(): Uint8ClampedArray | null;
  /** Test-only: force-pulse a gate output without waiting for the engine
   *  to fire it. Lets the e2e + composite VRT exercise the bridge
   *  deterministically. No-op if AudioContext / gates aren't materialized
   *  or `port` isn't a known event-gate id. */
  forcePulse(port: 'evt_die' | 'evt_move' | 'evt_level'): void;
}

export const qbertDef: VideoModuleDef = {
  type: 'qbert',
  palette: { top: 'Games', sub: 'Emulators' },
  domain: 'video',
  label: 'qbert',
  category: 'sources',
  schemaVersion: 1,
  inputs: [
    { id: 'coin_in',  type: 'gate' as const, paramTarget: 'cv_coin_in'  },
    { id: 'start_in', type: 'gate' as const, paramTarget: 'cv_start_in' },
    { id: 'joy_x',    type: 'cv'   as const, paramTarget: 'cv_joy_x'    },
    { id: 'joy_y',    type: 'cv'   as const, paramTarget: 'cv_joy_y'    },
  ],
  outputs: [
    { id: 'out',       type: 'video' },
    { id: 'audio_out', type: 'audio' },
    { id: 'evt_die',   type: 'gate'  },
    { id: 'evt_move',  type: 'gate'  },
    { id: 'evt_level', type: 'gate'  },
  ],
  params: [
    // Synthetic params for the CV → input edge detector + axis sampler.
    // Hidden from the card (no knobs by spec). curve='linear' so setParam
    // values arrive raw.
    { id: 'cv_coin_in',  label: 'COIN',  defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'cv_start_in', label: 'START', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    { id: 'cv_joy_x',    label: 'JOY_X', defaultValue: 0, min: -1, max: 1, curve: 'linear' as const },
    { id: 'cv_joy_y',    label: 'JOY_Y', defaultValue: 0, min: -1, max: 1, curve: 'linear' as const },
  ],

  // docs-hash-ignore:start
  docs: {
    explanation: "QBERT is a patchable arcade module modeled on Q*Bert (Gottlieb, 1982) and rendered as a video signal — the premise is hopping the little orange creature around an isometric cube pyramid, recoloring cubes while dodging enemies. It is a VIDEO source that ALSO bridges into the audio domain (same shape as DOOM and NIBBLES). Control is entirely via CV/gate cables — there are NO knobs or sliders on the card by design. Patch a gate into COIN to drop in a quarter (rising edge), a gate into START to begin a credited game (only works once a coin is in), and bipolar CV (-1..+1) into JOY_X / JOY_Y to steer. Because Q*Bert's stick is a 45-degree-rotated 4-way DIAGONAL, the two axes are resolved together into one of NE/NW/SE/SW each frame: only when BOTH axes sit inside the 0.3 dead-band is the result NEUTRAL (no direction) — a single axis past 0.3 still resolves to a diagonal, biasing the inactive axis toward down/right. The card shows a fixed 256x240 screen with INSERT COIN / PRESS START prompts, or a ROM MISSING overlay telling you to run `task setup:qbert` when the ROM zip isn't on the static server. The framebuffer is letterboxed (full height, black side bars) into the engine's 16:9 FBO. Note: this v1 ships the engine SHAPE — the memory map, ROM-name surface, framebuffer pipe, and gate/audio plumbing are real and end-to-end, while full Z80 opcode coverage and the I8039 sound CPU are follow-ups; the move/die/level events and the hop SFX are currently driven by a faithful synthetic stream (move every 8 tics a direction is held, die after a held-NEUTRAL timeout, level every 28 moves) so the outputs are exercisable today. Emulator state is LOCAL per client (no Yjs replication) — each user in a shared rackspace runs their own runtime, like DOOM.",
    inputs: {
      coin_in: "Gate (edge-triggered): a rising edge above 0.6 inserts one quarter (the Gottlieb COIN1 dip). Patch a clock or button gate here to add a credit; only the rising transition fires, with hysteresis (must fall below 0.4 before it can fire again) to absorb chatter. Holding it high does nothing further.",
      start_in: "Gate (edge-triggered): a rising edge above 0.6 presses 1P START, which begins the game only when at least one coin has already been inserted. Acts on the rising edge with the same 0.6 rise / 0.4 fall hysteresis as COIN; holding it high does nothing further.",
      joy_x: "CV (-1..+1): the horizontal joystick axis. Negative = left, positive = right. Sampled on every write and combined with JOY_Y into a Q*Bert diagonal. Both axes inside the 0.3 dead-band reads as NEUTRAL; a deflection of |x| >= 0.3 alone still resolves to a diagonal (the unset axis biases toward down).",
      joy_y: "CV (-1..+1): the vertical joystick axis in screen coords — negative = up, positive = down. Combined with JOY_X into one of NE/NW/SE/SW each write; only when BOTH axes are inside the 0.3 dead-band is no direction held. Modulate from an LFO/sequencer to auto-hop.",
    },
    outputs: {
      out: "Video: the 256x240 RGBA game framebuffer, letterboxed (full height, black side bars) into the engine's 640x360 FBO with aspect preserved. Shows the magenta diamond test pattern until a real ROM writes VRAM.",
      audio_out: "Audio (mono): the synthesized SFX stream played back through the DOOM PCM worklet. v1 emits a 1 kHz square-wave blip (50 ms linear decay) on every completed hop, mirroring Q*Bert's hop sound; the real I8039 sound chip is a follow-up but this path is live and patchable.",
      evt_die: "Gate (trigger): a 10 ms pulse fired on Q*Bert's death — in v1 a synthetic 'fell off the pyramid' event when NEUTRAL is held for ~200 tics after a credited game started (it also re-arms by requiring another coin/start). Patch to trigger an envelope, sample, or stinger on each death.",
      evt_move: "Gate (trigger): a 10 ms pulse on every completed hop — fires every 8 tics that a non-NEUTRAL direction is held after the game starts (about 4 hops/sec). Use as a gameplay-derived rhythmic clock to trigger drums or envelopes.",
      evt_level: "Gate (trigger): a 10 ms pulse on level advance — fires once every 28 moves (one full cube-pyramid pass in v1). Patch to mark progress: step a sequencer, swap a scene, or trigger a fill on each new level.",
    },
    controls: {
      cv_coin_in: "Hidden synthetic param (0..1) backing the COIN gate input. Not shown on the card; the engine's CV bridge writes it via setParam and a rising edge past 0.6 inserts a coin. Patch the COIN jack rather than setting it directly.",
      cv_start_in: "Hidden synthetic param (0..1) backing the START gate input. Not a card control; written by the CV bridge, its rising edge past 0.6 presses 1P START (only effective once a coin is in).",
      cv_joy_x: "Hidden synthetic param (-1..+1) backing the JOY_X CV input. Not shown on the card; the engine writes it from the patched JOY_X cable, and it is resolved together with cv_joy_y into the joystick diagonal on every write (0.3 dead-band per axis).",
      cv_joy_y: "Hidden synthetic param (-1..+1) backing the JOY_Y CV input. Not a card control; written by the CV bridge from the JOY_Y cable and combined with cv_joy_x into the NE/NW/SE/SW direction (NEUTRAL only when both axes are inside the 0.3 dead-band).",
    },
  },
  // docs-hash-ignore:end
  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHasFrame = gl.getUniformLocation(program, 'uHasFrame');
    const uLetterbox = gl.getUniformLocation(program, 'uLetterbox');

    const { fbo, texture } = ctx.createFbo();

    // Letterbox: source is 256:240 (~1.067:1); FBO is 640:360 (16:9).
    // Keep full HEIGHT, shrink U.
    const fboAspect = ctx.res.width / ctx.res.height;
    const srcAspect = QBERT_WIDTH / QBERT_HEIGHT;
    const letterboxU = Math.min(1.0, srcAspect / fboAspect);
    const letterboxV = Math.min(1.0, fboAspect / srcAspect);

    // Source texture sized for the QBERT framebuffer.
    const sourceTex = gl.createTexture();
    if (!sourceTex) throw new Error('QBERT: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA,
      QBERT_WIDTH, QBERT_HEIGHT, 0,
      gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(QBERT_WIDTH * QBERT_HEIGHT * 4),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Runtime construction:
    //   - Even before the ROM load completes we instantiate a "ROM
    //     missing" runtime so the card can render its test pattern +
    //     overlay. Once `loadQbertRoms()` resolves we swap to the real
    //     runtime.
    let runtime: QbertRuntime = createQbertRuntime({
      roms: null,
      loadError: 'Loading ROM …',
    });
    let loaded = false;
    let lastTicMs = performance.now();
    let hasFrame = false;

    // Edge state for the gate inputs (coin / start). Joystick is sampled
    // each frame from the latest cv values, so it doesn't need an edge
    // detector — only the diagonal-change is fed to the runtime, but the
    // runtime itself dedupes a duplicate direction.
    const coinEdge: EdgeState = makeEdgeState();
    const startEdge: EdgeState = makeEdgeState();

    const params: QbertParams & Record<string, number> = {
      ...DEFAULTS,
      ...(node.params as Partial<QbertParams>),
    };

    // Kick off the ROM fetch. The runtime swap is idempotent; if the
    // user spawns + immediately disposes the module we just let the
    // fetch promise settle into the void.
    void (async () => {
      const { roms, error } = await loadQbertRoms();
      // Replace the placeholder runtime in-place.
      runtime.dispose();
      runtime = createQbertRuntime({
        roms,
        loadError: error ?? (roms ? '' : 'ROM missing — run `task setup:qbert`'),
      });
      loaded = true;
    })();

    // ---- Audio source registration --------------------------------------
    //
    // Persistent AudioNode identity at t=0 (same pattern as DOOM /
    // NIBBLES) so the video→audio bridge captures stable refs at
    // addEdge time even if a cable is wired before any audio plays.
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let audioOutGain: GainNode | null = null;
    let pcmWorklet: AudioWorkletNode | null = null;
    let pcmKeepAlive: GainNode | null = null;
    let pumpInterval: ReturnType<typeof setInterval> | null = null;
    // Persistent event-gate CSNs. One CSN per gate port; pulsed 0→1→0 for
    // 10 ms on each event.
    let dieGate: ConstantSourceNode | null = null;
    let moveGate: ConstantSourceNode | null = null;
    let levelGate: ConstantSourceNode | null = null;

    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      const t0 = ac.currentTime;

      audioOutGain = ac.createGain();
      audioOutGain.gain.value = 1;
      audioSources.set('audio_out', { node: audioOutGain, output: 0 });

      dieGate = ac.createConstantSource();
      dieGate.offset.setValueAtTime(0, t0);
      dieGate.start();
      moveGate = ac.createConstantSource();
      moveGate.offset.setValueAtTime(0, t0);
      moveGate.start();
      levelGate = ac.createConstantSource();
      levelGate.offset.setValueAtTime(0, t0);
      levelGate.start();
      audioSources.set('evt_die',   { node: dieGate,   output: 0 });
      audioSources.set('evt_move',  { node: moveGate,  output: 0 });
      audioSources.set('evt_level', { node: levelGate, output: 0 });

      // Try to spin up the PCM worklet. Same pattern as DOOM — if the
      // worklet file isn't shipped (or CSP blocks it) we degrade
      // gracefully + the audio path stays silent.
      void setupPcmWorklet(ac);
    }

    async function setupPcmWorklet(ac: BaseAudioContext): Promise<void> {
      try {
        // Reuse the DOOM PCM worklet — it's a tiny mono-ring-buffer
        // processor that just plays back samples posted to its port. We
        // could ship a QBERT-specific copy but the contract is
        // identical; folding into one worklet keeps the static dir
        // lean. See packages/web/static/doom/doom-pcm-worklet.js.
        await ac.audioWorklet.addModule('/doom/doom-pcm-worklet.js');
      } catch {
        return; // worklet missing — audio_out stays silent
      }
      const node = new AudioWorkletNode(ac, 'doom-pcm', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      pcmWorklet = node;
      if (audioOutGain) node.connect(audioOutGain);

      // Silent keep-alive: worklet → gain(0) → ctx.destination. Without a
      // path to destination Chromium's renderer treats the worklet as
      // orphan + its process() never runs (same root cause documented in
      // video-audio-keepalive.ts + DOOM's setupPcmWorklet).
      if ('destination' in ac && ac.destination) {
        pcmKeepAlive = (ac as AudioContext).createGain();
        pcmKeepAlive.gain.value = 0;
        node.connect(pcmKeepAlive);
        pcmKeepAlive.connect(ac.destination);
      }

      // Pump the synthesized PCM stream at ~60 Hz.
      const samplesPerPump = Math.round(44100 / 60);
      pumpInterval = setInterval(() => {
        if (!pcmWorklet) return;
        const frames = runtime.getPcmFrames(samplesPerPump);
        if (frames.length > 0) {
          pcmWorklet.port.postMessage({ type: 'pcm', samples: frames });
        }
      }, 16);
    }

    const EVT_PULSE_S = 0.01;
    function pulseGate(src: ConstantSourceNode | null): void {
      const ac = ctx.audioCtx;
      if (!ac || !src) return;
      const t = ac.currentTime;
      src.offset.setValueAtTime(1, t);
      src.offset.setValueAtTime(0, t + EVT_PULSE_S);
    }

    function drainEventsAndPulse(): void {
      const evts = runtime.drainEvents();
      for (const e of evts) {
        if (e.type === 'move')       pulseGate(moveGate);
        else if (e.type === 'die')   pulseGate(dieGate);
        else if (e.type === 'level') pulseGate(levelGate);
      }
    }

    function uploadFramebufferToTexture(buf: Uint8ClampedArray): void {
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D, 0,
        0, 0,
        QBERT_WIDTH, QBERT_HEIGHT,
        gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      );
      hasFrame = true;
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(_frame) {
        const now = performance.now();
        const msDelta = Math.max(1, Math.min(50, now - lastTicMs));
        lastTicMs = now;
        try { runtime.runTic(msDelta); } catch { /* never break the engine */ }
        try { drainEventsAndPulse(); } catch { /* */ }
        const fb = runtime.getFramebuffer();
        if (fb) uploadFramebufferToTexture(fb);

        const g = gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, sourceTex);
        g.uniform1i(uTex, 0);
        g.uniform1f(uHasFrame, hasFrame ? 1.0 : 0.0);
        g.uniform2f(uLetterbox, letterboxU, letterboxV);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(sourceTex);
        gl.deleteProgram(program);
        if (pumpInterval !== null) { clearInterval(pumpInterval); pumpInterval = null; }
        if (pcmWorklet) {
          try { pcmWorklet.disconnect(); } catch { /* */ }
          pcmWorklet = null;
        }
        if (pcmKeepAlive) {
          try { pcmKeepAlive.disconnect(); } catch { /* */ }
          pcmKeepAlive = null;
        }
        if (audioOutGain) {
          try { audioOutGain.disconnect(); } catch { /* */ }
        }
        for (const src of [dieGate, moveGate, levelGate]) {
          if (!src) continue;
          try { src.stop(); } catch { /* */ }
          try { src.disconnect(); } catch { /* */ }
        }
        runtime.dispose();
      },
    };

    const extras: QbertHandleExtras = {
      getRuntime: () => runtime,
      isLoaded: () => loaded,
      loadError: () => runtime.loadError(),
      snapshotFramebuffer: () => runtime.getFramebuffer(),
      forcePulse(port) {
        if (port === 'evt_die')   pulseGate(dieGate);
        else if (port === 'evt_move')  pulseGate(moveGate);
        else if (port === 'evt_level') pulseGate(levelGate);
      },
    };

    return {
      domain: 'video',
      surface,
      audioSources,
      setParam(paramId, value) {
        if (paramId in params) (params as Record<string, number>)[paramId] = value;
        // COIN / START — edge-detect against the rise/fall hysteresis.
        if (paramId === 'cv_coin_in') {
          const ev = detectEdge(coinEdge, value);
          if (ev?.pressed) runtime.insertCoin();
        } else if (paramId === 'cv_start_in') {
          const ev = detectEdge(startEdge, value);
          if (ev?.pressed) runtime.pressStart();
        } else if (paramId === 'cv_joy_x' || paramId === 'cv_joy_y') {
          // Joystick — resample every CV write. The runtime dedupes a
          // duplicate direction.
          const dir: QbertDiagonal = joyCvToDiagonal(params.cv_joy_x, params.cv_joy_y);
          runtime.setJoystick(dir);
        }
      },
      readParam(paramId) {
        return (params as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'loaded') return loaded;
        if (key === 'loadError') return runtime.loadError();
        if (key === 'hasFrame') return hasFrame;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
