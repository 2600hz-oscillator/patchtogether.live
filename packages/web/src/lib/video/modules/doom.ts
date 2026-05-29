// packages/web/src/lib/video/modules/doom.ts
//
// DOOM — single-instance interactive video module. Each JOINED peer runs
// its OWN WASM-backed instance of doomgeneric and renders its own POV
// (the per-peer model). An UNJOINED spectator runs no WASM, so its surface
// stays black (the DOOM attract screen) until it JOINS. There is NO
// framebuffer mirror: the host used to base64 its ~1.4 MB framebuffer into a
// Yjs awareness field at ~10 Hz so spectators could watch — that firehose
// OOM-killed the in-process Hocuspocus relay (exit 137) and was REMOVED.
//
// Multiplayer: see /docs/design/game-modules.md §3 (DOOM rack model)
// and packages/web/src/lib/doom/doom-presence.ts. This factory is
// agnostic of the multiplayer wiring — the card decides whether this peer
// drives its own runtime (joined player) or renders nothing (spectator).
// The engine here just exposes:
//   - the GL surface that displays the 640×400 BGRA framebuffer (with
//     aspect-correct letterboxing into the engine's 640×360 FBO);
//   - the 7 CV-gate inputs (w/a/s/d/space/ctrl/alt) edge-detected into
//     dgpt_set_key calls on the runtime;
//   - the stereo audio outputs (audio_l, audio_r) routed through the
//     new VideoNodeHandle.audioSources cross-domain bridge to feed the
//     audio graph (silent until slice 8 lands).
//
// The card connects to the runtime via the handle's `read('extras')`
// channel — mirrors how PictureboxCard pulls setImage/setFilename out
// of PICTUREBOX's factory.
//
// Inputs:
//   The 7 control gates (w/a/s/d/space/ctrl/alt) are declared on the def's
//   `inputs` array (built dynamically); rising edges enqueue into doomgeneric's
//   key queue. Plus any unpatched stereo audio CV bridges declared per slice.
//
// Outputs:
//   out (video): the 640×400 BGRA framebuffer (aspect-correct letterboxed into 640×360).
//   audio_l / audio_r (audio): stereo bridges from the WASM SFX stream.
//   evt_kill (gate): one-pulse gate on every enemy kill.
//   evt_door (gate): one-pulse gate when the player opens a door.
//   evt_gun_p1..p4 (gate): per-weapon-fire one-pulse gates (pistol/shotgun/chaingun/missile).
//
// Params:
//   audioGain (linear 0..2, default 1): WASM SFX → audio_l/r bus gain.
//   + per-event gate timings + spectator-passthrough toggle (see factory).

import type { VideoModuleDef } from '$lib/video/module-registry';
import type { VideoNodeHandle, VideoNodeSurface } from '$lib/video/engine';
import { DoomRuntime, type DoomTiccmd } from '$lib/doom/doom-runtime';
import { detectEdge, makeEdgeState, type EdgeState } from '$lib/doom/cv-gate-edge';
import {
  CV_GATE_PORT_IDS_BY_SLOT,
  parseSlotPortId,
  migrateLegacyCvGatePortId,
  type CvGatePortId,
} from '$lib/doom/doomkeys';

// AudioWorkletProcessor URL — served as a static asset under
// /doom/doom-pcm-worklet.js. Loaded lazily per AudioContext (WeakSet
// avoids double-add on hot-reload + on a second DOOM module spawn
// within the same audio context). maxInstances:1 means we only ever
// hit this once per page-load in practice.
const DOOM_PCM_WORKLET_URL = '/doom/doom-pcm-worklet.js';
const WORKLET_LOADED = new WeakSet<BaseAudioContext>();

async function ensureDoomPcmWorklet(ac: BaseAudioContext): Promise<void> {
  if (WORKLET_LOADED.has(ac)) return;
  // The processor name 'doom-pcm' is registered inside the worklet
  // file; calling addModule twice with the same name across two
  // contexts is fine, but within ONE context it throws — hence the
  // per-context guard.
  await ac.audioWorklet.addModule(DOOM_PCM_WORKLET_URL);
  WORKLET_LOADED.add(ac);
}

// Fragment shader: sample the 640×400 BGRA framebuffer and letterbox it
// into the engine's 640×360 FBO. DOOM is 1.6:1 (640:400 = 8:5); the
// engine's FBO is 16:9 (640:360 = 16:9 ≈ 1.78:1). So we keep height +
// letterbox horizontally — a slight black bar on either side at the
// engine's aspect.
//
// vUv is (0..1, 0..1) over the FBO with origin bottom-left (GL default,
// vUv = aPos * 0.5 + 0.5 in the shared vertex shader). DOOM's
// framebuffer is row-major top-down (DG_ScreenBuffer is uint32_t pixel
// 0..639 row 0 = top), and we upload with UNPACK_FLIP_Y_WEBGL=true so
// the GL coordinate `vUv.y = 0 = bottom` maps to DOOM's `y = bottom`.
// BGRA → RGBA swizzle in the shader (DOOM's pixel_t is uint32_t with
// blue in low byte → little-endian = B,G,R,A in memory).
const FRAG_SRC = `#version 300 es
precision highp float;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uHasFrame;
uniform vec2 uLetterbox;  // (sx, sy) — UV scale to fit DOOM aspect in engine FBO

void main() {
  if (uHasFrame < 0.5) {
    // Idle: dark warm grey + a subtle scanline texture so an empty card
    // still reads as "alive but no signal" rather than "broken".
    float scan = 0.5 + 0.5 * sin(vUv.y * 100.0);
    outColor = vec4(0.04, 0.02, 0.02, 1.0) * scan;
    return;
  }
  // Compute centered, aspect-preserving UV. uLetterbox carries the
  // ratio of DOOM-aspect to FBO-aspect; we shrink the active region by
  // that factor and centre it. Outside the active region renders pure
  // black so spectators see a clean letterbox.
  vec2 centered = (vUv - 0.5) / uLetterbox + 0.5;
  if (centered.x < 0.0 || centered.x > 1.0 || centered.y < 0.0 || centered.y > 1.0) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  vec4 src = texture(uTex, centered);
  // BGRA → RGBA swizzle.
  outColor = vec4(src.b, src.g, src.r, 1.0);
}`;

// Parameters: an audio-gain knob plus the synthetic CV-gate params. There is
// no user-facing "pause" — DOOM is a true-lockstep netgame, so a local pause
// would only desync the shared simulation. The runtime always ticks while it
// is initialized. The card has its own controls (focus / spawn-runtime /
// host-indicator). Keep the schema small to keep the module-spec snapshot
// deterministic.
interface DoomParams {
  audioGain: number;   // 0..2, multiplier applied at the audio bridge (PCM zero-clipped under stereo PCM stub)
}

const DEFAULTS: DoomParams = {
  audioGain: 1.0,
};

/** Handle-extras: card-facing handle for the runtime + input feedback.
 *  Mirrors PictureboxHandleExtras — the card calls
 *  `engine.read(id, 'extras')` to get this. */
export interface DoomHandleExtras {
  /** The live runtime (may be null while WASM is still loading or
   *  build-doom-wasm.sh hasn't been run yet). */
  getRuntime(): DoomRuntime | null;
  /** Card calls this once when the user spawns the module + clicks the
   *  card to confirm load. Returns an error string if the WASM/WAD
   *  load failed, or null on success. Idempotent. */
  ensureLoaded(): Promise<string | null>;
  /** Push a keyboard event (translated from KeyboardEvent.code by the
   *  card). Returns true if the code is mapped, false otherwise. */
  pushKeyboardKey(code: string, pressed: boolean): boolean;
  /** Push an already-translated raw doomkey (the Yjs presence relay on the
   *  host side feeds a pure spectator's keystrokes here). */
  pushDoomKey(doomKey: number, pressed: boolean): void;
  /** Bug 4 hard enforcement: gate keyboard-origin input at the runtime
   *  boundary. The card calls this whenever its CV-gate-patched state flips —
   *  patched ⇒ inert(true) (keyboard fully ignored + held keyboard keys
   *  released), unpatched ⇒ inert(false). The CV-gate path is never gated.
   *  No-op if the runtime isn't loaded (re-applied on load via ensureLoaded). */
  setKeyboardInert(inert: boolean): void;
  /** Snapshot the current framebuffer for the card's LOCAL 2D preview blit.
   *  Pure local read of this peer's own runtime — null when no WASM is loaded
   *  (a pure spectator), so its preview canvas stays black. NOT used for any
   *  network broadcast (the framebuffer-over-awareness path was removed). */
  snapshotFramebuffer(): Uint8ClampedArray | null;
  /** Slice 4: launch a netgame on this peer's runtime with the agreed
   *  settings + this peer's slot. No-op if the runtime isn't loaded. */
  startNetGame(
    settings: {
      deathmatch: number;
      episode: number;
      map: number;
      skill: number;
      nomonsters: number;
      fastMonsters: number;
      respawnMonsters: number;
      numPlayers: number;
    },
    consolePlayer: number,
  ): void;
  /** Slice 4: current DOOM gamestate_t as an int (GS_LEVEL=0,
   *  GS_INTERMISSION=1, ...). -1 if no runtime. */
  getGameState(): number;
  /** Slice 6: end the running level so the next tick enters GS_INTERMISSION
   *  (where the arbiter re-opens the New Game dialog + seats pending late
   *  joiners for the next map). No-op if the runtime isn't loaded. */
  exitLevel(): void;
  /** Slice 4: this peer's own console player position (fixed-point) or
   *  null if not spawned. Used by the e2e per-peer-POV assertion. */
  getConsolePlayerState(): { x: number; y: number; slot: number } | null;
  /** Slice 5: this peer's freshly-built local ticcmd (the card broadcasts it
   *  each tic for cross-peer visibility), or null if none built yet. */
  readLocalTiccmd(): DoomTiccmd | null;
  /** Slice 5: inject a remote peer's latest ticcmd at its slot so its marine
   *  moves in this peer's world. No-op if the runtime isn't loaded. */
  injectRemoteTiccmd(slot: number, cmd: DoomTiccmd): void;
  /** Slice 5: position of an arbitrary player slot in THIS peer's world, or
   *  null if not spawned. The cross-peer-visibility e2e reads the REMOTE
   *  peer's slot here to assert this peer saw it move. */
  getPlayerSlotState(slot: number): { x: number; y: number; slot: number } | null;
  // ---- P1: true-lockstep barrier ----
  /** Arm/disarm the engine barrier. Armed for a >1-player netgame; SP off. */
  setLockstep(enabled: boolean): void;
  /** P1 input-delay buffer: build maketic this many tics ahead of gametic so a
   *  peer's ticcmd propagates over the relay before the barrier needs it (the
   *  sim runs at 35Hz instead of stalling). Determinism preserved. 0 = default. */
  setInputDelay(tics: number): void;
  /** Deliver one consolidated TicSet (one ticcmd per slot, null = absent).
   *  Must be called in ascending tic order; the C side ignores out-of-order. */
  receiveTicSet(tic: number, numPlayers: number, slots: (DoomTiccmd | null)[]): void;
  /** Engine tic counters for the JS lockstep driver. */
  getMaketic(): number;
  getGametic(): number;
  getRecvtic(): number;
  /** This peer's local ticcmd for a specific built tic (for the append-log). */
  readLocalTiccmdAt(tic: number): DoomTiccmd | null;
  /** 32-bit deterministic state digest — the cross-peer lockstep oracle. */
  stateChecksum(): number;
  /** Per-player inputs (#353): set THIS peer's consoleplayer slot so the CV-gate
   *  path applies ONLY this slot's input group (own-slot-only rule). The card
   *  calls this when its mySlot changes; null = spectator/unseated (no slot's CV
   *  drives the local sim). Idempotent; safe before WASM loads. */
  setOwnSlot(slot: number | null): void;
  /** Test-only: force-pulse a CV/gate output (evt_kill / evt_door /
   *  evt_gun_p1..p4) WITHOUT requiring a WASM-side event to fire. Used by the
   *  video→audio CV/gate e2e + composite VRT coverage so the engine bridge can
   *  be exercised deterministically without driving the DOOM runtime. Emits the
   *  same 10ms pulse (the existing local `pulseGate` helper) that
   *  `drainAndPulseEvents` would emit on a real game event. No-op when the
   *  AudioContext / gates aren't materialised. */
  forcePulse(port: 'evt_kill' | 'evt_door' | 'evt_gun_p1' | 'evt_gun_p2' | 'evt_gun_p3' | 'evt_gun_p4'): void;
  /** Test-only: hold a gate output HIGH (or LOW) indefinitely — no 10 ms
   *  auto-fall-back. Used by the composite VRT spec so an `audio suspend` +
   *  snapshot freezes the gate signal in a known state for the diff. Calling
   *  forcePulse() or forceHold(port, false) cancels the hold. No-op when the
   *  AudioContext / gates aren't materialised. */
  forceHold(port: 'evt_kill' | 'evt_door' | 'evt_gun_p1' | 'evt_gun_p2' | 'evt_gun_p3' | 'evt_gun_p4', high: boolean): void;
}

export const doomDef: VideoModuleDef = {
  type: 'doom',
  domain: 'video',
  label: 'DOOM',
  category: 'sources',
  // schemaVersion 2 (#353): the single shared CV-gate input set became four
  // per-slot input GROUPS (p1..p4 → slots 0..3). Old (v1) patches wired CV to
  // the bare port ids (`up`/`down`/…); the load-time migration rewrites those
  // edges to the p1 group (slot 0) so they keep driving the owner's marine.
  schemaVersion: 2,
  // Edge-port migration (v1 → v2): rewrite a legacy bare cv-gate port id to its
  // p1_<id> equivalent so saved patches keep their CV connections. The
  // persistence loader calls this per edge target whose nodeId is a DOOM node
  // saved at a version below this def's schemaVersion. Returns null for ports
  // that aren't legacy cv-gate ids (out/audio_l/audio_r — left untouched).
  migrateEdgePortId(portId, _fromVersion) {
    return migrateLegacyCvGatePortId(portId);
  },
  // ONE DOOM NODE per rack — and it stays 1. The committed slice-3 model
  // is "one shared node, N per-peer runtimes": the host spawns the single
  // node; every other peer sees it via Yjs sync and JOINS it (claims a slot
  // in node.data.players + binds its OWN DoomRuntime), rather than spawning
  // a second node. So the cap is NOT bumped to 4 — that would let 4 separate
  // DOOM nodes appear on the canvas, which is explicitly not the model. The
  // 4-player cap lives in the roster (MAX_DOOM_PLAYERS in doom-roster.ts),
  // not in maxInstances.
  maxInstances: 1,
  // Round 5: host-only widget. Only the rack OWNER may ADD the DOOM module —
  // the palette hides it for non-owners + the spawn path refuses. The MP flow
  // is "owner adds DOOM → starts a game → guests one-click hot-join" against
  // that single shared node, so a non-owner spawning their own DOOM node never
  // makes sense. (Single-user / no-provider racks have a sole de-facto owner,
  // so the gate only blocks an explicit non-owner; see doom-gating.canAddModule.)
  ownerOnly: true,
  // PER-SLOT cv-typed gate inputs (#353): four groups p1..p4 (slots 0..3), each
  // the 7 gates. portId = `p{slot+1}_{base}` (e.g. p1_up), paramTarget =
  // `cv_p{slot+1}_{base}` (e.g. cv_p1_up). The engine's setParam path drives our
  // per-(slot,port) edge detector; the OWN-SLOT-ONLY rule (below) ensures a peer
  // only ever feeds its OWN consoleplayer slot's CV into the sim, so the
  // deterministic lockstep TicSet can never diverge from non-deterministic
  // per-peer CV sampling (the #353/#354 freeze root cause).
  inputs: CV_GATE_PORT_IDS_BY_SLOT.map(({ portId }) => ({
    id: portId,
    type: 'cv' as const,
    paramTarget: `cv_${portId}`,
  })),
  outputs: [
    { id: 'out', type: 'video' },
    { id: 'audio_l', type: 'audio' },
    { id: 'audio_r', type: 'audio' },
    // Phase-1 SP event gates. Each pulses HIGH for 10ms when its event
    // fires inside the C engine (P_KillMobj / EV_DoDoor / EV_VerticalDoor /
    // P_FireWeapon). Routed through audioSources as ConstantSourceNodes so
    // the audio domain treats them as standard gate signals (1 = HIGH).
    { id: 'evt_kill',   type: 'gate' },
    { id: 'evt_door',   type: 'gate' },
    { id: 'evt_gun_p1', type: 'gate' },
    { id: 'evt_gun_p2', type: 'gate' },
    { id: 'evt_gun_p3', type: 'gate' },
    { id: 'evt_gun_p4', type: 'gate' },
  ],
  params: [
    { id: 'audioGain', label: 'Gain', defaultValue: 1, min: 0, max: 2, curve: 'linear' },
    // Synthetic params for the CV edge detector — one per (slot, gate) port.
    // Hidden from the card (the gate inputs render as cv-jacks via the standard
    // port-row, and only the local viewer's own group is shown). curve='linear'
    // so setParam values arrive raw.
    ...CV_GATE_PORT_IDS_BY_SLOT.map(({ portId, slot, base }) => ({
      id: `cv_${portId}`,
      label: `P${slot + 1} ${base.toUpperCase()}`,
      defaultValue: 0,
      min: 0,
      max: 1,
      curve: 'linear' as const,
    })),
  ],

  factory(ctx, node): VideoNodeHandle {
    const gl = ctx.gl;
    const program = ctx.compileFragment(FRAG_SRC);
    const uTex = gl.getUniformLocation(program, 'uTex');
    const uHasFrame = gl.getUniformLocation(program, 'uHasFrame');
    const uLetterbox = gl.getUniformLocation(program, 'uLetterbox');

    // FBO at engine resolution + a "source texture" sized for the
    // DOOM framebuffer (640×400 BGRA8). Two textures because the FBO is
    // 640×360 (engine.res) — we don't want to resize FBOs per-module.
    const { fbo, texture } = ctx.createFbo();

    // Letterbox math: engine FBO is res.width×res.height, DOOM is
    // 640×400 (1.6:1). We keep DOOM upright at FBO height, so the
    // x-direction shrinks by (fboAspect / doomAspect).
    const fboAspect = ctx.res.width / ctx.res.height;
    const doomAspect = 640 / 400;
    // Active region: in U direction we scale by 1, V direction by 1.
    // To put a 1.6:1 source inside a wider FBO, the active region width
    // (in UV) is fboAspect / doomAspect → wait, actually:
    // We have a 1.78:1 canvas, fitting 1.6:1 content height-locked.
    // Content fills full height (V scale 1). Content width is
    // (height * doomAspect) / fboWidth = (1 * 1.6) / 1.78 = 0.9.
    // So we want active V = 1.0, active U = doomAspect/fboAspect = 0.9.
    // In the shader's `centered = (vUv - 0.5) / uLetterbox + 0.5`,
    // uLetterbox is the "size of active region in UV space" — values
    // less than 1 shrink the active region. So uLetterbox = (0.9, 1.0).
    const letterboxU = Math.min(1.0, doomAspect / fboAspect);
    const letterboxV = Math.min(1.0, fboAspect / doomAspect);

    const sourceTex = gl.createTexture();
    if (!sourceTex) throw new Error('DOOM: createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    // Pre-allocate a 640×400 BGRA8 texture — we'll texSubImage2D into
    // it each frame (cheaper than re-allocating).
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,                // internal — we don't actually have a BGRA internal format on WebGL2; rely on the shader swizzle.
      640,
      400,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(640 * 400 * 4),
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let runtime: DoomRuntime | null = null;
    let loaded = false;
    let loadError: string | null = null;
    let loadPending: Promise<string | null> | null = null;
    let hasFrame = false;
    let lastTicMs = performance.now();
    // Bug 4: cached keyboard-inert state. The card may flip this (CV gate
    // patched) before the WASM finishes loading, so we hold it here and apply
    // it to the runtime the instant it comes up (and on every later flip).
    let keyboardInert = false;

    // Edge-detector state, one per per-slot CV gate port (keyed by full portId,
    // e.g. 'p1_up'). 4 groups × 7 gates = 28 detectors; only the local slot's
    // edges ever reach the runtime (own-slot-only rule), but we keep state for
    // all so a slot change doesn't drop a mid-flight gate.
    const edgeStates = new Map<string, EdgeState>();
    for (const { portId } of CV_GATE_PORT_IDS_BY_SLOT) edgeStates.set(portId, makeEdgeState());

    // OWN-SLOT-ONLY rule (#353 Phase 2): this peer's consoleplayer slot. CV that
    // targets THIS slot's group is fed into the sim (→ G_BuildTiccmd → the
    // deterministic ticcmd log); CV that targets ANY OTHER slot's group is
    // ignored locally — those slots arrive only as the consolidated, byte-
    // identical log entries every peer replays. This is what makes per-player CV
    // deterministic + lockstep-safe (no per-peer fan-out, no divergence → no
    // freeze). The card sets it via extras.setOwnSlot(mySlot); a spectator/
    // unseated peer leaves it null so NO slot's CV drives the local sim.
    let ownSlot: number | null = null;

    const params: DoomParams & Record<string, number> = {
      ...DEFAULTS,
      ...(node.params as Partial<DoomParams>),
    };

    // Audio source registration. The bridge captures whatever AudioNode
    // is in audioSources at addEdge time + holds the reference until the
    // edge is torn down — mutating the Map after the fact would NOT
    // re-wire an already-connected cable. So we publish persistent
    // GainNodes (one per side of a stereo split) up front and connect
    // the worklet INTO them once it loads. Cables wired before WASM
    // init still light up retroactively.
    const audioSources = new Map<string, { node: AudioNode; output: number }>();
    let leftGain: GainNode | null = null;
    let rightGain: GainNode | null = null;
    let pcmWorklet: AudioWorkletNode | null = null;
    let pumpInterval: ReturnType<typeof setInterval> | null = null;

    // Phase-1 SP event-gate sources. Six ConstantSourceNodes — KILL, DOOR,
    // GUN_p1..p4 — held at 0 + pulsed to 1 for ~10ms on each event, mirroring
    // the polyseqz/score emitClockPulse pattern. Persistent identity (same
    // pattern as leftGain/rightGain) so the video→audio bridge captures the
    // refs at addEdge time. Out-of-band with the netgame consistency digest.
    let killGate: ConstantSourceNode | null = null;
    let doorGate: ConstantSourceNode | null = null;
    let gunGates: ConstantSourceNode[] = [];

    if (ctx.audioCtx) {
      const ac = ctx.audioCtx;
      leftGain = ac.createGain();
      leftGain.gain.value = 1;
      rightGain = ac.createGain();
      rightGain.gain.value = 1;
      audioSources.set('audio_l', { node: leftGain, output: 0 });
      audioSources.set('audio_r', { node: rightGain, output: 0 });

      // Phase-1 event gates (KILL/DOOR/GUN_pN). One CSN per port, pinned at 0
      // until pulsed. Started immediately so an early-arrival cable hears the
      // gate the instant an event fires.
      const t0 = ac.currentTime;
      killGate = ac.createConstantSource();
      killGate.offset.setValueAtTime(0, t0);
      killGate.start();
      doorGate = ac.createConstantSource();
      doorGate.offset.setValueAtTime(0, t0);
      doorGate.start();
      gunGates = [0, 1, 2, 3].map(() => {
        const c = ac.createConstantSource();
        c.offset.setValueAtTime(0, t0);
        c.start();
        return c;
      });
      audioSources.set('evt_kill',   { node: killGate, output: 0 });
      audioSources.set('evt_door',   { node: doorGate, output: 0 });
      audioSources.set('evt_gun_p1', { node: gunGates[0]!, output: 0 });
      audioSources.set('evt_gun_p2', { node: gunGates[1]!, output: 0 });
      audioSources.set('evt_gun_p3', { node: gunGates[2]!, output: 0 });
      audioSources.set('evt_gun_p4', { node: gunGates[3]!, output: 0 });

      void setupPcmWorklet(ac);
    }

    // 10ms pulse width — matches polyseqz/score emitClockPulse so downstream
    // gate-edge detectors trigger reliably.
    const EVT_PULSE_S = 0.01;
    function pulseGate(src: ConstantSourceNode): void {
      const ac = ctx.audioCtx;
      if (!ac) return;
      const t = ac.currentTime;
      src.offset.setValueAtTime(1, t);
      src.offset.setValueAtTime(0, t + EVT_PULSE_S);
    }
    function drainAndPulseEvents(): void {
      if (!runtime || !ctx.audioCtx) return;
      const evts = runtime.drainEvents();
      for (const e of evts) {
        if (e.type === 1 && killGate) pulseGate(killGate);
        else if (e.type === 2 && doorGate) pulseGate(doorGate);
        else if (e.type === 3) {
          const g = gunGates[e.slot] ?? gunGates[0];
          if (g) pulseGate(g);
        }
      }
    }

    async function setupPcmWorklet(ac: BaseAudioContext): Promise<void> {
      try {
        await ensureDoomPcmWorklet(ac);
        // Stereo output: the i_pcmgen mixer is mono internally, but
        // emitting two identical channels here lets a ChannelSplitter
        // give us distinct audio_l / audio_r outputs that downstream
        // patches can route independently.
        const node = new AudioWorkletNode(ac, 'doom-pcm', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        pcmWorklet = node;
        const splitter = ac.createChannelSplitter(2);
        node.connect(splitter);
        if (leftGain) splitter.connect(leftGain, 0);
        if (rightGain) splitter.connect(rightGain, 1);

        // Pump the WASM mixer at ~60 Hz. dgpt_tick (called from the
        // video surface.draw path) drives DOOM's main loop which calls
        // S_UpdateSounds → I_UpdateSound → I_PcmGen_UpdateSound; the
        // mixer accumulates samples into the WASM ring + this pump
        // drains them into the worklet's queue.
        const samplesPerPump = Math.round(44100 / 60);
        pumpInterval = setInterval(() => {
          if (!runtime || !runtime.isInitialized()) return;
          if (!pcmWorklet) return;
          const frames = runtime.getPcmFrames(samplesPerPump);
          if (frames.length > 0) {
            pcmWorklet.port.postMessage({ type: 'pcm', samples: frames });
          }
        }, 16);
        try {
          pcmWorklet.port.postMessage({ type: 'gain', value: params.audioGain });
        } catch { /* */ }
      } catch (e) {
        // Worklet load failed — gains stay at unity passing silence.
        // Common cause: CSP blocks the worklet URL, or build-doom-wasm
        // hasn't been run + the static file isn't shipped.
        // eslint-disable-next-line no-console
        console.warn('[DOOM] AudioWorklet load failed; audio_l/r will be silent', e);
      }
    }

    async function ensureLoaded(): Promise<string | null> {
      if (loaded) return loadError;
      if (loadPending) return loadPending;
      const work = (async () => {
        const { runtime: rt, error: rtErr } = await DoomRuntime.load();
        if (!rt) {
          loadError = rtErr ?? 'DOOM runtime failed to load';
          loaded = true;
          return loadError;
        }
        const { loadWad } = await import('$lib/doom/doom-runtime');
        const { bytes, error: wadErr } = await loadWad();
        if (!bytes) {
          loadError = wadErr ?? 'DOOM1.WAD missing';
          loaded = true;
          return loadError;
        }
        try {
          rt.init(bytes);
        } catch (e) {
          loadError = e instanceof Error ? e.message : String(e);
          loaded = true;
          return loadError;
        }
        runtime = rt;
        // Re-apply any keyboard-inert state the card set while WASM was still
        // loading (a CV gate patched during load must keep the keyboard off).
        rt.setKeyboardInert(keyboardInert);
        loaded = true;
        loadError = null;
        return null;
      })();
      loadPending = work;
      return work;
    }

    function pushKeyboardKey(code: string, pressed: boolean): boolean {
      if (!runtime) return false;
      return runtime.setKeyForKeyboardCode(code, pressed);
    }

    function pushDoomKey(doomKey: number, pressed: boolean): void {
      if (!runtime) return;
      runtime.setKey(doomKey, pressed);
    }

    function setKeyboardInert(inert: boolean): void {
      keyboardInert = inert;
      if (runtime) runtime.setKeyboardInert(inert);
    }

    function snapshotFramebuffer(): Uint8ClampedArray | null {
      if (!runtime || !runtime.isInitialized()) return null;
      // Local-only read for the card's 2D preview blit. The view is into live
      // HEAPU8 — the card swaps the bytes into ImageData synchronously.
      return runtime.getFramebuffer();
    }

    function uploadFramebufferToTexture(buf: Uint8Array | Uint8ClampedArray): void {
      gl.bindTexture(gl.TEXTURE_2D, sourceTex);
      // We're uploading row-major top-down BGRA — set FLIP_Y so the GL
      // origin (bottom-left) sees the image right-side-up. Restore
      // afterwards so other modules' uploads aren't affected.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0, 0,
        640, 400,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        buf,
      );
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      hasFrame = true;
    }

    const surface: VideoNodeSurface = {
      fbo,
      texture,
      draw(frame) {
        // Every peer ticks + renders its OWN WASM in real time. A JOINED player
        // (active or lone single-player host) has a runtime + draws its own POV.
        // A pure unjoined spectator never loaded WASM (runtime === null), so it
        // renders nothing → the shader letterboxes black (the DOOM attract /
        // black screen) until it JOINS and brings up its own runtime. The
        // framebuffer-over-awareness host mirror was REMOVED (relay-OOM driver):
        // we no longer blit a remote peer's frame here.
        if (runtime && runtime.isInitialized()) {
          const now = performance.now();
          const msDelta = Math.max(1, Math.min(50, now - lastTicMs));
          lastTicMs = now;
          try { runtime.runTic(msDelta); } catch { /* */ }
          // Phase-1 SP event gates: drain AFTER runTic so we see this tic's
          // kills/doors/guns. Wrapped in try/catch — a drain failure must
          // NEVER break the tick (the engine ran first).
          try { drainAndPulseEvents(); } catch { /* */ }
          const fb = runtime.getFramebuffer();
          uploadFramebufferToTexture(fb);
        }

        // 2. Draw FBO.
        const g = frame.gl;
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
        if (pumpInterval !== null) {
          clearInterval(pumpInterval);
          pumpInterval = null;
        }
        if (pcmWorklet) {
          try { pcmWorklet.port.postMessage({ type: 'reset' }); } catch { /* */ }
          try { pcmWorklet.disconnect(); } catch { /* */ }
          pcmWorklet = null;
        }
        if (leftGain) try { leftGain.disconnect(); } catch { /* */ }
        if (rightGain) try { rightGain.disconnect(); } catch { /* */ }
        // Phase-1: stop + disconnect the 6 event gate ConstantSourceNodes.
        if (killGate) {
          try { killGate.stop(); } catch { /* */ }
          try { killGate.disconnect(); } catch { /* */ }
        }
        if (doorGate) {
          try { doorGate.stop(); } catch { /* */ }
          try { doorGate.disconnect(); } catch { /* */ }
        }
        for (const g of gunGates) {
          try { g.stop(); } catch { /* */ }
          try { g.disconnect(); } catch { /* */ }
        }
        if (runtime) runtime.dispose();
        runtime = null;
      },
    };

    const extras: DoomHandleExtras = {
      getRuntime() { return runtime; },
      ensureLoaded,
      pushKeyboardKey,
      pushDoomKey,
      setKeyboardInert,
      snapshotFramebuffer,
      startNetGame(settings, consolePlayer) {
        if (!runtime || !runtime.isInitialized()) return;
        runtime.startNetGame(settings, consolePlayer);
      },
      getGameState() {
        return runtime ? runtime.getGameState() : -1;
      },
      exitLevel() {
        if (!runtime || !runtime.isInitialized()) return;
        runtime.exitLevel();
      },
      getConsolePlayerState() {
        return runtime ? runtime.getConsolePlayerState() : null;
      },
      readLocalTiccmd() {
        return runtime ? runtime.readLocalTiccmd() : null;
      },
      injectRemoteTiccmd(slot, cmd) {
        if (!runtime || !runtime.isInitialized()) return;
        runtime.injectRemoteTiccmd(slot, cmd);
      },
      getPlayerSlotState(slot) {
        return runtime ? runtime.getPlayerSlotState(slot) : null;
      },
      setLockstep(enabled) {
        if (!runtime || !runtime.isInitialized()) return;
        runtime.setLockstep(enabled);
      },
      setInputDelay(tics) {
        if (!runtime || !runtime.isInitialized()) return;
        runtime.setInputDelay(tics);
      },
      receiveTicSet(tic, numPlayers, slots) {
        if (!runtime || !runtime.isInitialized()) return;
        runtime.receiveTicSet(tic, numPlayers, slots);
      },
      getMaketic() { return runtime ? runtime.getMaketic() : 0; },
      getGametic() { return runtime ? runtime.getGametic() : 0; },
      getRecvtic() { return runtime ? runtime.getRecvtic() : 0; },
      readLocalTiccmdAt(tic) { return runtime ? runtime.readLocalTiccmdAt(tic) : null; },
      stateChecksum() { return runtime ? runtime.stateChecksum() : 0; },
      setOwnSlot(slot) {
        // When the local slot changes, release any CV-origin key still held so a
        // gate that was HIGH for the old slot can't stay latched in gamekeydown[]
        // after we stop applying it. The new slot's gates re-assert on their next
        // edge. Safe before WASM loads (runtime guards internally).
        if (slot !== ownSlot && runtime) runtime.releaseHeldCvKeys();
        ownSlot = slot;
      },
      forcePulse(port) {
        // Test-only: drive the same 10ms pulse path `drainAndPulseEvents` uses,
        // bypassing the WASM event queue. Lets the e2e + composite-VRT
        // assert that every video.gate output of DOOM survives the
        // dispatcher → addCrossDomainAudioBridge path → downstream audio
        // input — INDEPENDENT of whether a real game event fired.
        if (port === 'evt_kill') {
          if (killGate) pulseGate(killGate);
          return;
        }
        if (port === 'evt_door') {
          if (doorGate) pulseGate(doorGate);
          return;
        }
        // evt_gun_p1..p4 → gunGates[0..3]
        const idx =
          port === 'evt_gun_p1' ? 0
          : port === 'evt_gun_p2' ? 1
          : port === 'evt_gun_p3' ? 2
          : 3;
        const g = gunGates[idx];
        if (g) pulseGate(g);
      },
      forceHold(port, high) {
        const ac = ctx.audioCtx;
        if (!ac) return;
        const src =
          port === 'evt_kill' ? killGate
          : port === 'evt_door' ? doorGate
          : port === 'evt_gun_p1' ? gunGates[0]
          : port === 'evt_gun_p2' ? gunGates[1]
          : port === 'evt_gun_p3' ? gunGates[2]
          : gunGates[3];
        if (!src) return;
        const t = ac.currentTime;
        try { src.offset.cancelScheduledValues(t); } catch { /* */ }
        src.offset.setValueAtTime(high ? 1 : 0, t);
      },
    };

    return {
      domain: 'video',
      surface,
      audioSources,
      setParam(paramId, value) {
        if (paramId in params) (params as Record<string, number>)[paramId] = value;
        // Forward audioGain straight to the worklet so a knob twist
        // takes effect without waiting for the next PCM pump.
        if (paramId === 'audioGain' && pcmWorklet) {
          try { pcmWorklet.port.postMessage({ type: 'gain', value }); } catch { /* */ }
        }
        // PER-SLOT CV-gate path (#353): edge-detect cv_p{N}_{base} params + feed
        // ONLY the local consoleplayer slot's gates into the runtime.
        //
        // OWN-SLOT-ONLY: the CV edge for slot S lives once in the shared Yjs doc
        // and the bridge materializes on EVERY peer, but only the peer whose
        // consoleplayer == S applies it. Other slots' CV is edge-detected (so the
        // detector state stays coherent if the slot later becomes ours) but NEVER
        // written to the runtime here — those slots arrive solely as the
        // deterministic, consolidated ticcmd log. This removes the wrong-slot
        // fan-out AND the non-deterministic per-peer sampling that caused the
        // universal freeze, so CV is now SAFE under lockstep (the #354 blunt
        // "ignore CV under lockstep" gate is gone — CV is re-enabled per slot).
        if (paramId.startsWith('cv_')) {
          const portId = paramId.slice(3); // e.g. 'p1_up'
          const state = edgeStates.get(portId);
          if (!state) return;
          const parsed = parseSlotPortId(portId);
          if (!parsed) return;
          const ev = detectEdge(state, value);
          if (!ev || !runtime) return;
          // Own-slot-only: ignore CV for any slot this peer doesn't drive.
          if (ownSlot === null || parsed.slot !== ownSlot) return;
          runtime.setKeyForCvGate(parsed.base, ev.pressed);
        }
      },
      readParam(paramId) {
        return (params as Record<string, number>)[paramId];
      },
      read(key) {
        if (key === 'extras') return extras;
        if (key === 'loaded') return loaded;
        if (key === 'loadError') return loadError;
        if (key === 'hasFrame') return hasFrame;
        return undefined;
      },
      dispose() { surface.dispose(); },
    };
  },
};
