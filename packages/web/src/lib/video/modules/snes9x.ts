// packages/web/src/lib/video/modules/snes9x.ts
//
// SNES9X — Super Nintendo emulator as a patchable video module with
// game-event CV/GATE outputs. Shape mirrors DOOM / QBERT: a VIDEO module
// that ALSO publishes AudioNodes via `audioSources` for the cross-domain
// video→audio bridge.
//
// Emulator core: the snes9x2005 (CAT SFC) libretro core (MIT, libretro
// relicense), vendored at packages/web/native/snes9x/ and compiled to WASM
// by build-snes9x-wasm.sh → /snes9x/snes9x.{js,wasm} (gitignored, built on
// demand). The bridge exposes the SNES WRAM (snes_get_wram =
// retro_get_memory_data(RETRO_MEMORY_SYSTEM_RAM)) which powers the
// game-event detection — see $lib/snes9x/smw-events.ts.
//
// LOCKED modes (no user control, per spec): 256×224/239 video, 32 kHz
// stereo audio.
//
// INPUTS:
//   - clock_in (gate)  — drives the gate3 clock MULTIPLIER.
//   - the full SNES gamepad: up/down/left/right + a/b/x/y + l/r +
//     start/select (12 gate inputs; rising edge = held). Wire the GAMEPAD
//     module's gate outputs straight in (du→up, a→a, …).
//
// OUTPUTS:
//   - out (video)      — the SNES screen (letterboxed into the engine FBO).
//   - audio_l / audio_r (audio) — separate L/R via a ChannelSplitter.
//   - gate1 (KILL)     — pulse when Mario kills a monster (SMW).
//   - gate2 (DEATH)    — pulse when Mario dies (SMW).
//   - gate3 (CLOCK ×N) — clock_in multiplied by (world+level).
//   - gate4            — reserved (present, idle for SMW).
//   - cv1 (WORLD)      — constant CV for the current world.
//   - cv2/cv3/cv4      — reserved (present, idle for SMW).
//
// The per-ROM CV/GATE meanings are documented in
// $lib/snes9x/output-definitions.ts + surfaced by the card's right-click
// "see output definition for CV/GATES" panel.
//
// ROM is user-provided + gitignored (DOOM/SM64/QBERT pattern). The factory
// tries to autoload /roms/snes9x/game.sfc; absent, the card shows a
// load-a-ROM dropzone (the user picks a .sfc/.smc → boots locally).
//
// Memory: emulator state stays LOCAL (per-client) — no Yjs replication of
// frame state, same as DOOM/QBERT (relay-single-process-and-drift note).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoEngineContext, VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { aspectFitScale } from '$lib/video/video-res';
import {
  Snes9xRuntime,
  loadAutoloadRom,
  SNES_NATIVE_WIDTH,
  SNES_NATIVE_HEIGHT_MAX,
  SNES_AUDIO_SAMPLE_RATE,
} from '$lib/snes9x/snes9x-runtime';
import {
  makeSmwDetectorState,
  detectSmwEvents,
  deriveLocation,
  worldToCv,
  wramReader,
  type SmwDetectorState,
} from '$lib/snes9x/smw-events';
import {
  makeClockMultiplierState,
  onClockEdge,
  advance as advanceClock,
  type ClockMultiplierState,
} from '$lib/snes9x/clock-multiplier';
import {
  SNES_BUTTONS,
  buildInputMask,
  type SnesButton,
} from '$lib/snes9x/snes-input';
import {
  identifyGame,
  getOutputDefinition,
  type GameOutputDef,
} from '$lib/snes9x/output-definitions';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';

// Letterbox a 256×(224/239) framebuffer into the engine FBO, Y-flipped.
const FRAG_SRC = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uHasFrame;
uniform vec2 uLetterbox;
void main() {
  if (uHasFrame < 0.5) {
    // Idle: dark void with a faint scanline (alive-but-no-signal).
    float scan = 0.5 + 0.5 * sin(vUv.y * 80.0);
    outColor = vec4(0.02, 0.02, 0.05, 1.0) * scan;
    return;
  }
  vec2 centered = (vUv - 0.5) / uLetterbox + 0.5;
  if (centered.x < 0.0 || centered.x > 1.0 || centered.y < 0.0 || centered.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec2 src = vec2(centered.x, 1.0 - centered.y);
  outColor = texture(uTex, src);
}`;

const GATE_OUT_IDS = ['gate1', 'gate2', 'gate3', 'gate4'] as const;
const CV_OUT_IDS = ['cv1', 'cv2', 'cv3', 'cv4'] as const;
type GateOutId = (typeof GATE_OUT_IDS)[number];

/** Card-facing handle (read via engine.read(node, 'extras')). */
export interface Snes9xHandleExtras {
  getRuntime(): Snes9xRuntime | null;
  isLoaded(): boolean;
  loadError(): string;
  /** True once a ROM is loaded + running. */
  romLoaded(): boolean;
  /** The identified game id (e.g. 'smw') of the loaded ROM, or '' if none. */
  gameId(): string;
  /** The per-ROM output definition (for the "see output definition" panel). */
  outputDefinition(): GameOutputDef | null;
  /** Snapshot the current RGBA framebuffer for the card's 2D preview. */
  snapshotFramebuffer(): Uint8ClampedArray | null;
  /** Load a ROM the user picked from disk (card dropzone / file picker). */
  loadRomBytes(bytes: Uint8Array): boolean;
  /** Test-only: force a gate output pulse without real gameplay. */
  forcePulse(port: GateOutId): void;
  /** Test-only: read a WRAM byte (for e2e harness assertions). */
  readWram(addr: number): number;
  /** Test-only: cumulative pulse count per gate output, so an e2e can
   *  assert the clock_in → gate3 multiplier fired (>= one pulse per input
   *  edge for ×1 passthrough, more when world+level > 1). */
  pulseCount(port: GateOutId): number;
  /** Test-only DETERMINISTIC frame step: set an exact joypad bitmask
   *  (RETRO_DEVICE_ID_JOYPAD_*), run ONE emulated frame, then run the SAME
   *  game-event detection + gate-emit path the live draw() loop uses. Lets a
   *  gameplay e2e replay a committed, ROM-independent per-frame input fixture
   *  and assert gate1 (kill) / gate2 (death) fire on REAL SMW play — bypassing
   *  the timing-dependent rAF loop. No-op until a ROM is loaded. Returns the
   *  game mode ($7E0100) after the step so the harness can track level entry. */
  stepFrame(mask: number): number;
  /** Test-only: enable/disable manual stepping. While enabled the engine's
   *  draw() loop stops auto-advancing the emulator (so stepFrame() is the
   *  exclusive frame driver). stepFrame() also enables it implicitly. */
  setManualStep(on: boolean): void;
}

export const snes9xDef: VideoModuleDef = {
  type: 'snes9x',
  palette: { top: 'Games', sub: 'Emulators' },
  domain: 'video',
  label: 'SNES9X',
  // "games" category — same value the SM64 audio def uses. The palette
  // bucketing in module-categories.ts places it in the games group.
  category: 'games',
  schemaVersion: 1,
  // Single-instance per rack: the WASM core + its 64 MB linear memory are
  // heavy; a second card would double the footprint with no shared benefit.
  // Same maxInstances:1 rationale as DOOM / SM64.
  maxInstances: 1,
  inputs: [
    { id: 'clock_in', type: 'gate' as const, paramTarget: 'cv_clock_in' },
    ...SNES_BUTTONS.map((b) => ({
      id: b,
      type: 'gate' as const,
      paramTarget: `cv_${b}`,
    })),
  ],
  outputs: [
    { id: 'out', type: 'video' },
    { id: 'audio_l', type: 'audio' },
    { id: 'audio_r', type: 'audio' },
    ...GATE_OUT_IDS.map((id) => ({ id, type: 'gate' as const })),
    ...CV_OUT_IDS.map((id) => ({ id, type: 'cv' as const })),
  ],
  params: [
    { id: 'cv_clock_in', label: 'CLOCK', defaultValue: 0, min: 0, max: 1, curve: 'linear' as const },
    // Per-source fit: 0 = letterbox/pillarbox (DEFAULT, aspect-preserving),
    // 1 = fill (cover-crop). Tracks the OUTPUT aspect switch.
    { id: 'fillMode', label: 'Fill', defaultValue: 0, min: 0, max: 1, curve: 'discrete' as const },
    ...SNES_BUTTONS.map((b) => ({
      id: `cv_${b}`,
      label: b.toUpperCase(),
      defaultValue: 0,
      min: 0,
      max: 1,
      curve: 'linear' as const,
    })),
  ],

  factory(ctx: VideoEngineContext, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHasFrame = gl.getUniformLocation(program, 'uHasFrame');
    const uLetterbox = gl.getUniformLocation(program, 'uLetterbox');

    const { fbo, texture } = ctx.createFbo();

    // SNES is 256:224 ≈ 8:7 (≈1.143); 4:3 on a CRT. The (sx,sy) fit scale is
    // computed LIVE in draw() from ctx.res + the fillMode param so it tracks
    // the OUTPUT aspect switch (4:3 vs 16:9 swaps which axis bars).
    const srcAspect = 4 / 3;

    const sourceTex = gl.createTexture();
    if (!sourceTex) throw new Error('SNES9X: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA,
      SNES_NATIVE_WIDTH, SNES_NATIVE_HEIGHT_MAX, 0,
      gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array(SNES_NATIVE_WIDTH * SNES_NATIVE_HEIGHT_MAX * 4),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // ---- Runtime + ROM load -------------------------------------------
    let runtime: Snes9xRuntime | null = null;
    let loaded = false;          // load attempt finished (success or error)
    let loadError = 'Loading core …';
    let romLoaded = false;
    let gameId = '';
    let outputDef: GameOutputDef | null = null;
    let hasFrame = false;
    let lastTexW = SNES_NATIVE_WIDTH;
    let lastTexH = 224;

    // Detector + clock-multiplier state.
    const detector: SmwDetectorState = makeSmwDetectorState();
    const clockMul: ClockMultiplierState = makeClockMultiplierState();

    // Test-only: when true, draw() stops auto-advancing the emulator so a
    // gameplay e2e can drive frames DETERMINISTICALLY via extras.stepFrame()
    // (the rAF loop would otherwise inject extra, timing-dependent frames +
    // the held-button params, corrupting a scripted input sequence). draw()
    // still re-renders the last framebuffer so the card stays live.
    let manualStep = false;

    function applyRom(bytes: Uint8Array): boolean {
      if (!runtime) return false;
      const ok = runtime.loadRom(bytes);
      if (ok) {
        romLoaded = true;
        gameId = identifyGame(bytes);
        outputDef = getOutputDefinition(gameId);
        // Reset detection state for the fresh ROM.
        Object.assign(detector, makeSmwDetectorState());
        loadError = '';
      }
      return ok;
    }

    void (async () => {
      try {
        runtime = await Snes9xRuntime.load();
      } catch (e) {
        loaded = true;
        loadError = e instanceof Error ? e.message : String(e);
        return;
      }
      // Try the autoload ROM; absent is the normal clean-checkout state.
      const { bytes, error } = await loadAutoloadRom();
      if (bytes) {
        applyRom(bytes);
      } else {
        loadError = error ?? 'no ROM — load one';
      }
      loaded = true;
    })();

    // ---- Input edge detectors -----------------------------------------
    const clockEdge: EdgeState = makeEdgeState();
    const buttonEdges = new Map<SnesButton, EdgeState>();
    for (const b of SNES_BUTTONS) buttonEdges.set(b, makeEdgeState());

    const params: Record<string, number> = {
      cv_clock_in: 0,
      ...Object.fromEntries(SNES_BUTTONS.map((b) => [`cv_${b}`, 0])),
      ...(node.params as Record<string, number>),
    };

    // ---- Audio + gate/CV source registration --------------------------
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let leftGain: GainNode | null = null;
    let rightGain: GainNode | null = null;
    let pcmWorklet: AudioWorkletNode | null = null;
    let pcmKeepAlive: GainNode | null = null;
    // Gate outs (ConstantSourceNode pulsed 0→1→0). CV outs (ConstantSourceNode
    // held at the CV value).
    const gateSrc = new Map<GateOutId, ConstantSourceNode>();
    const cvSrc = new Map<string, ConstantSourceNode>();

    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      const t0 = ac.currentTime;

      leftGain = ac.createGain();
      leftGain.gain.value = 1;
      rightGain = ac.createGain();
      rightGain.gain.value = 1;
      audioSources.set('audio_l', { node: leftGain, output: 0 });
      audioSources.set('audio_r', { node: rightGain, output: 0 });

      for (const id of GATE_OUT_IDS) {
        const c = ac.createConstantSource();
        c.offset.setValueAtTime(0, t0);
        c.start();
        gateSrc.set(id, c);
        audioSources.set(id, { node: c, output: 0 });
      }
      for (const id of CV_OUT_IDS) {
        const c = ac.createConstantSource();
        c.offset.setValueAtTime(0, t0);
        c.start();
        cvSrc.set(id, c);
        audioSources.set(id, { node: c, output: 0 });
      }

      void setupPcmWorklet(ac);
    }

    async function setupPcmWorklet(ac: BaseAudioContext): Promise<void> {
      try {
        await ac.audioWorklet.addModule('/snes9x/snes9x-pcm-worklet.js');
      } catch {
        return; // worklet missing — audio stays silent
      }
      const wnode = new AudioWorkletNode(ac, 'snes9x-pcm', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      pcmWorklet = wnode;
      wnode.port.postMessage({ type: 'config', srcRate: SNES_AUDIO_SAMPLE_RATE });
      // Stereo split → independent audio_l / audio_r.
      const splitter = ac.createChannelSplitter(2);
      wnode.connect(splitter);
      if (leftGain) splitter.connect(leftGain, 0);
      if (rightGain) splitter.connect(rightGain, 1);
      // Silent keep-alive to ctx.destination (Chromium runs orphan worklets
      // otherwise — same as DOOM/QBERT).
      if ('destination' in ac && ac.destination) {
        pcmKeepAlive = (ac as AudioContext).createGain();
        pcmKeepAlive.gain.value = 0;
        wnode.connect(pcmKeepAlive);
        pcmKeepAlive.connect(ac.destination);
      }
    }

    /** Drain the core's per-frame stereo audio into the worklet. Called
     *  EXACTLY ONCE per emulated frame from draw() (right after runFrame),
     *  not on a free-running timer — getAudio() returns the audio produced
     *  by the most recent runFrame, so timer-decoupled draining would
     *  double-send or drop a frame's audio. */
    function pumpAudio(): void {
      if (!pcmWorklet || !runtime || !romLoaded) return;
      const a = runtime.getAudio(); // interleaved S16 stereo this frame
      if (a.length < 2) return;
      const n = a.length >> 1;
      const left = new Float32Array(n);
      const right = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        left[i] = (a[i * 2] ?? 0) / 32768;
        right[i] = (a[i * 2 + 1] ?? 0) / 32768;
      }
      pcmWorklet.port.postMessage({ type: 'pcm', left, right });
    }

    // ---- Gate/CV emit -------------------------------------------------
    const EVT_PULSE_S = 0.01;
    const pulseCounts = new Map<GateOutId, number>(GATE_OUT_IDS.map((id) => [id, 0]));
    function pulseGate(id: GateOutId): void {
      pulseCounts.set(id, (pulseCounts.get(id) ?? 0) + 1);
      const ac = ctx.audioCtx;
      const src = gateSrc.get(id);
      if (!ac || !src) return;
      const t = ac.currentTime;
      src.offset.setValueAtTime(1, t);
      src.offset.setValueAtTime(0, t + EVT_PULSE_S);
    }
    function setCv(id: string, value: number): void {
      const ac = ctx.audioCtx;
      const src = cvSrc.get(id);
      if (!ac || !src) return;
      src.offset.setValueAtTime(value, ac.currentTime);
    }

    let lastCv1 = -999;

    function updateGameEvents(): void {
      if (!runtime || !romLoaded) return;
      let read;
      try {
        read = wramReader(runtime.getWram());
      } catch {
        return;
      }
      // Detection (kill→gate1, death→gate2, level_change retriggers cv1).
      const events = detectSmwEvents(detector, read);
      for (const e of events) {
        if (e.type === 'kill') pulseGate('gate1');
        else if (e.type === 'death') pulseGate('gate2');
        // level_change just refreshes the derived location below.
      }
      // cv1 = constant CV for the current world (steady; only re-set on change).
      const loc = deriveLocation(read);
      const cv1 = worldToCv(loc.world);
      if (cv1 !== lastCv1) {
        setCv('cv1', cv1);
        lastCv1 = cv1;
      }
      // gate3 multiplier draining (subdivisions due since last frame).
      if (ctx.audioCtx) {
        const due = advanceClock(clockMul, ctx.audioCtx.currentTime);
        for (let i = 0; i < due.length; i++) pulseGate('gate3');
      }
    }

    function uploadFramebuffer(): void {
      if (!runtime || !romLoaded) return;
      const w = runtime.getFbWidth();
      const h = runtime.getFbHeight();
      if (w <= 0 || h <= 0) return;
      const fb = runtime.getFramebuffer();
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      // Re-alloc the texture only when dimensions change (224↔239).
      if (w !== lastTexW || h !== lastTexH) {
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0,
          gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array(fb.buffer, fb.byteOffset, fb.byteLength),
        );
        lastTexW = w;
        lastTexH = h;
      } else {
        gl.texSubImage2D(
          gl.TEXTURE_2D, 0, 0, 0, w, h,
          gl.RGBA, gl.UNSIGNED_BYTE,
          new Uint8Array(fb.buffer, fb.byteOffset, fb.byteLength),
        );
      }
      hasFrame = true;
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(_frame) {
        if (runtime && romLoaded && !manualStep) {
          // Drive input → run one frame → detect events → upload frame.
          const held: Partial<Record<SnesButton, boolean>> = {};
          for (const b of SNES_BUTTONS) held[b] = buttonEdges.get(b)!.pressed;
          try { runtime.setInput(buildInputMask(held)); } catch { /* */ }
          try { runtime.runFrame(); } catch { /* never break the engine */ }
          try { pumpAudio(); } catch { /* */ }
          try { updateGameEvents(); } catch { /* */ }
          try { uploadFramebuffer(); } catch { /* */ }
        }

        const g = gl;
        g.bindFramebuffer(g.FRAMEBUFFER, fbo);
        g.viewport(0, 0, ctx.res.width, ctx.res.height);
        g.useProgram(program);
        g.activeTexture(g.TEXTURE0);
        g.bindTexture(g.TEXTURE_2D, sourceTex);
        g.uniform1i(uTex, 0);
        g.uniform1f(uHasFrame, hasFrame ? 1.0 : 0.0);
        // Live aspect fit: letterbox/pillarbox (default) or fill (cover-crop),
        // tracking the OUTPUT aspect (ctx.res) + the per-source fillMode param.
        const { sx, sy } = aspectFitScale(
          srcAspect,
          ctx.res.width / ctx.res.height,
          params.fillMode >= 0.5 ? 'fill' : 'letterbox',
        );
        g.uniform2f(uLetterbox, sx, sy);
        ctx.drawFullscreenQuad();
        g.bindFramebuffer(g.FRAMEBUFFER, null);
      },
      dispose() {
        gl.deleteFramebuffer(fbo);
        gl.deleteTexture(texture);
        gl.deleteTexture(sourceTex);
        gl.deleteProgram(program);
        for (const n of [pcmWorklet, pcmKeepAlive, leftGain, rightGain]) {
          if (n) { try { n.disconnect(); } catch { /* */ } }
        }
        for (const c of [...gateSrc.values(), ...cvSrc.values()]) {
          try { c.stop(); } catch { /* */ }
          try { c.disconnect(); } catch { /* */ }
        }
        runtime?.dispose();
      },
    };

    const extras: Snes9xHandleExtras = {
      getRuntime: () => runtime,
      isLoaded: () => loaded,
      loadError: () => loadError,
      romLoaded: () => romLoaded,
      gameId: () => gameId,
      outputDefinition: () => outputDef,
      snapshotFramebuffer: () => {
        if (!runtime || !romLoaded) return null;
        try { return runtime.getFramebuffer(); } catch { return null; }
      },
      loadRomBytes: (bytes) => applyRom(bytes),
      forcePulse: (port) => pulseGate(port),
      readWram: (addr) => (runtime && romLoaded ? runtime.readWram(addr) : 0),
      pulseCount: (port) => pulseCounts.get(port) ?? 0,
      setManualStep: (on) => { manualStep = on; },
      stepFrame: (mask) => {
        if (!runtime || !romLoaded) return 0;
        manualStep = true; // stepFrame is now the exclusive frame driver.
        try { runtime.setInput(mask | 0); } catch { /* */ }
        try { runtime.runFrame(); } catch { /* */ }
        try { pumpAudio(); } catch { /* */ }
        // Same detection + gate-emit path as draw() (kill→gate1, death→gate2).
        try { updateGameEvents(); } catch { /* */ }
        try { uploadFramebuffer(); } catch { /* */ }
        try { return runtime.readWram(0x0100); } catch { return 0; }
      },
    };

    return {
      domain: 'video',
      surface,
      audioSources,
      setParam(paramId, value) {
        if (paramId in params) params[paramId] = value;
        if (paramId === 'cv_clock_in') {
          const ev = detectEdge(clockEdge, value);
          if (ev?.pressed) {
            // Rising edge of clock_in → gate3 multiplier. N = world+level.
            let n = 1;
            if (runtime && romLoaded) {
              try {
                const loc = deriveLocation(wramReader(runtime.getWram()));
                n = loc.world + loc.level;
              } catch { n = 1; }
            }
            const t = ctx.audioCtx ? ctx.audioCtx.currentTime : 0;
            const pulses = onClockEdge(clockMul, t, n);
            // Emit the in-phase pulse immediately; subdivisions drain via
            // advanceClock() in updateGameEvents() over subsequent frames.
            if (pulses.length > 0) pulseGate('gate3');
          }
        } else if (paramId.startsWith('cv_')) {
          const btn = paramId.slice(3) as SnesButton;
          const edge = buttonEdges.get(btn);
          if (edge) detectEdge(edge, value); // updates `pressed` (held) state
        }
      },
      readParam(paramId) {
        return params[paramId];
      },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'loaded') return loaded;
        if (key === 'loadError') return loadError;
        if (key === 'romLoaded') return romLoaded;
        if (key === 'hasFrame') return hasFrame;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
