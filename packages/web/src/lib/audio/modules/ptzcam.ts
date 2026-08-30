// PTZ CAM — CV control of a physical PTZ camera (NexiGo P610) through the
// native PT-PTZ helper (tools/pt-ptz), which bridges MIDI sysex to UVC.
//
// ─────────────────────────── WHY THE AUDIO DOMAIN ───────────────────────────
// Same argument as chromaconsole verbatim: `meta` has no factory and the
// factory is where the sysex sender, the scheduler subscription and dispose()
// live; `video` would drag a module with no pixels into the WebGL attest
// basis. livecode / clockedRunner / chromaconsole are the precedents.
//
// ─────────────────────────── WHY NO paramTarget/cvScale ─────────────────────
// The CV inputs don't modulate a knob — they ARE the camera position, consumed
// on the main thread (tap → scheduler tick → sysex), the MIDI-OUT-BUDDY /
// SKIFREE / PONG shape. Publishing an AudioParam landing pad instead would
// make the summed value unreadable headless (an AudioParam's connected input
// is not observable from JS), and the send must run with no card mounted.
// The pan/tilt/zoom PARAMS are manual trim summed with the CV by this module:
// value = knob + cv, clamped — knob at default 0 means a patched cable IS the
// position, the absolute-position semantic ADR-004 gives `center: 'default'`.
// The three ports are justified in PASSTHROUGH_BY_DESIGN (cv-scale-registry)
// and docs/adr/004-cv-range-convention.md.

import type { AudioModuleDef } from '$lib/audio/module-registry';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import { planPtzSend, type PtzPlan, type PtzTargets } from '$lib/audio/ptz-control';
import { buildSetAbs } from '$lib/audio/ptz-sysex';
import {
  connectPtzMidi,
  getPtzCaps,
  ptzStatus,
  sendPtzFrame,
  type PtzStatus,
} from '$lib/audio/ptz-midi.svelte';

/** Ticks between sends: 40 Hz scheduler / 4 = 10 Hz on the wire (≤12 Hz by
 *  design; the helper coalesces again at 30 Hz and the camera's motors are the
 *  real limiter). */
const SEND_DECIMATE = 4;

export interface PtzcamCardApi {
  connect(): Promise<void>;
  status(): PtzStatus;
}

export interface PtzcamState {
  readonly status: PtzStatus['kind'];
  readonly targets: PtzTargets;
  readonly sentFrames: number;
  readonly lastSent: PtzTargets | null;
}

export const ptzcamDef: AudioModuleDef = {
  // String LITERALS, not constants: module-manifest.ts extracts these fields
  // with a ?raw regex and cannot resolve a reference.
  type: 'ptzcam',
  palette: { top: 'MIDI', sub: 'MIDI' },
  domain: 'audio',
  label: 'ptz cam',
  category: 'output',
  maxInstances: 1,
  size: '2u',
  hp: 2,
  inputs: [
    { id: 'pan_cv', type: 'cv' },
    { id: 'tilt_cv', type: 'cv' },
    { id: 'zoom_cv', type: 'cv' },
  ],
  outputs: [],
  params: [
    { id: 'pan', label: 'pan', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'tilt', label: 'tilt', defaultValue: 0, min: -1, max: 1, curve: 'linear' },
    { id: 'zoom', label: 'zoom', defaultValue: 0, min: 0, max: 1, curve: 'linear' },
    { id: 'slew', label: 'slew', defaultValue: 0.3, min: 0, max: 1, curve: 'linear' },
  ],

  docs: {
    explanation:
      'Drives a physical PTZ camera (the NexiGo P610) from the patch. It sends MIDI sysex to ' +
      'the PT-PTZ helper app running on the same machine, which translates into USB camera ' +
      'control — the camera physically pans, tilts and zooms. The module carries no audio or ' +
      "video of its own; the camera's picture reaches the rack through a normal camera input. " +
      'PAN, TILT and ZOOM knobs set the base position; the matching CV inputs ADD to the knob, ' +
      'so with knobs at default a patched LFO or joystick IS the position and the knobs become ' +
      'stage trim. Positions are normalized: ±1 spans the full mechanical range reported by the ' +
      'camera during the bind handshake (pan ±170°, tilt −30°..+90°, zoom 1×–10× on the P610). ' +
      'SLEW limits how fast the commanded position may move — at 1 it is instant, low values ' +
      'glide; the camera motors impose their own speed limit on top. Sends are coalesced to ' +
      '~10 per second and only fire when the position actually changed. The face shows the ' +
      'live binding state: CONNECT grants MIDI and finds the helper; if the helper is not ' +
      'running, or the camera is unplugged, the module says exactly that and recovers by ' +
      'itself when the missing piece appears.',
    inputs: {
      pan_cv:
        'Pan position CV, ±1 for the full range, added to the PAN knob. With the knob at 0 the cable is the absolute pan position.',
      tilt_cv:
        'Tilt position CV, ±1 for the full range, added to the TILT knob. With the knob at 0 the cable is the absolute tilt position.',
      zoom_cv:
        'Zoom CV, added to the ZOOM knob; the summed 0..1 spans wide to full telephoto.',
    },
    controls: {
      pan: 'Base pan position, ±1 across the full mechanical range. CV on pan_cv adds to it.',
      tilt: 'Base tilt position, ±1 across the full mechanical range. CV on tilt_cv adds to it.',
      zoom: 'Base zoom, 0 wide to 1 full telephoto. CV on zoom_cv adds to it.',
      slew: 'Rate limit on commanded motion, in fractions of full range per second on a square curve; 1 is instant.',
    },
  },

  async factory(ctx, node) {
    function makeTap() {
      const gain = ctx.createGain();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 32;
      analyser.smoothingTimeConstant = 0;
      gain.connect(analyser);
      const silence = ctx.createConstantSource();
      silence.offset.value = 0;
      silence.start();
      silence.connect(gain);
      return { gain, analyser, silence, buf: new Float32Array(32) };
    }
    const taps = { pan: makeTap(), tilt: makeTap(), zoom: makeTap() };

    function latestSample(tap: ReturnType<typeof makeTap>): number {
      tap.analyser.getFloatTimeDomainData(tap.buf as Float32Array<ArrayBuffer>);
      return tap.buf[tap.buf.length - 1] ?? 0;
    }

    const knobs: Record<string, number> = { pan: 0, tilt: 0, zoom: 0, slew: 0.3 };
    for (const p of ptzcamDef.params) {
      const saved = node.params?.[p.id];
      knobs[p.id] = typeof saved === 'number' ? saved : p.defaultValue;
    }

    let plan: PtzPlan | null = null;
    let sentFrames = 0;
    let lastSent: PtzTargets | null = null;
    let tickN = 0;

    function tick(): void {
      try {
        if (++tickN % SEND_DECIMATE !== 0) return;
        const status = ptzStatus();
        const caps = getPtzCaps();
        if (status.kind !== 'bound' || !caps) {
          // Re-assert the whole position on the next bind — a restarted helper
          // or replugged camera starts from wherever the head physically is.
          plan = null;
          return;
        }
        const targets: PtzTargets = {
          pan: knobs.pan! + latestSample(taps.pan),
          tilt: knobs.tilt! + latestSample(taps.tilt),
          zoom: knobs.zoom! + latestSample(taps.zoom),
        };
        const dtMs = SCHEDULER_TICK_MS * SEND_DECIMATE;
        const next = planPtzSend(plan, targets, caps, dtMs, knobs.slew!);
        plan = next.plan;
        for (const send of next.sends) {
          if (sendPtzFrame(buildSetAbs(send.control, send.value))) {
            sentFrames++;
          }
        }
        if (next.sends.length > 0) lastSent = next.plan.sent;
      } catch (err) {
        console.error('[ptzcam] tick error', err);
      }
    }
    const unsubscribeTick = getSchedulerClock().subscribe(tick);

    const cardApi: PtzcamCardApi = {
      connect: () => connectPtzMidi(),
      status: ptzStatus,
    };

    return {
      domain: 'audio',
      inputs: new Map<string, { node: AudioNode; input: number; param?: AudioParam }>([
        ['pan_cv', { node: taps.pan.gain, input: 0 }],
        ['tilt_cv', { node: taps.tilt.gain, input: 0 }],
        ['zoom_cv', { node: taps.zoom.gain, input: 0 }],
      ]),
      outputs: new Map(),
      setParam(id, value) {
        if (id in knobs) knobs[id] = value;
      },
      readParam(id) {
        return knobs[id];
      },
      read(key) {
        if (key === 'card-api') return cardApi;
        if (key === 'state') {
          const state: PtzcamState = {
            status: ptzStatus().kind,
            targets: {
              pan: knobs.pan! + latestSample(taps.pan),
              tilt: knobs.tilt! + latestSample(taps.tilt),
              zoom: knobs.zoom! + latestSample(taps.zoom),
            },
            sentFrames,
            lastSent,
          };
          return state;
        }
        return undefined;
      },
      dispose() {
        unsubscribeTick();
        for (const tap of Object.values(taps)) {
          try {
            tap.silence.stop();
          } catch {
            /* already stopped */
          }
          tap.silence.disconnect();
          tap.gain.disconnect();
          tap.analyser.disconnect();
        }
      },
    };
  },
};
