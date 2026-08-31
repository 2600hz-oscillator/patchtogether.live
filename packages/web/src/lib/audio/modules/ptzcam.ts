// PTZ CAM — CV control of physical PTZ cameras through the native PT-PTZ
// helper (tools/pt-ptz), which bridges MIDI sysex to UVC. Multi-camera: the
// helper exposes one MIDI pair per camera (PT-PTZ-<SHORT>); each ptzcam node
// picks one (saved in node.data.device; default = first PT-PTZ pair).
//
// ─────────────────────────── WHY THE AUDIO DOMAIN ───────────────────────────
// Same argument as chromaconsole verbatim: `meta` has no factory and the
// factory is where the sysex sender, the scheduler subscription and dispose()
// live; `video` would drag a module with no pixels into the WebGL attest
// basis. livecode / clockedRunner / chromaconsole are the precedents.
//
// ─────────────────────────── WHY NO paramTarget/cvScale ─────────────────────
// The CV inputs don't modulate a knob — they ARE the camera motion, consumed
// on the main thread (tap → scheduler tick → sysex), the MIDI-OUT-BUDDY /
// SKIFREE / PONG shape. Publishing an AudioParam landing pad instead would
// make the summed value unreadable headless (an AudioParam's connected input
// is not observable from JS), and the send must run with no card mounted.
// The pan/tilt/zoom PARAMS are manual trim summed with the CV by this module.
// The three ports are justified in PASSTHROUGH_BY_DESIGN (cv-scale-registry)
// and docs/adr/004-cv-range-convention.md.
//
// ─────────────────────────── PER-AXIS MODES ─────────────────────────────────
// The caps handshake reports each axis as ABSOLUTE (value = position: NexiGo
// P610, all three axes) or VELOCITY (value = rate: Logitech PTZ Pro 2
// pan/tilt — sign is direction, zero stops, deadzone at rest). A nonzero
// velocity is re-sent every plan tick as the helper watchdog's keepalive; the
// helper stops motion on its own ~250 ms after the stream dies, so a crashed
// page can never leave a head panning mid-set.

import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch, ydoc } from '$lib/graph/store';
import { getSchedulerClock, SCHEDULER_TICK_MS } from '$lib/audio/scheduler-clock';
import { planPtzSend, type PtzPlan, type PtzTargets } from '$lib/audio/ptz-control';
import { buildSetAbs, buildSetVel } from '$lib/audio/ptz-sysex';
import {
  acquirePtzBinding,
  connectPtzMidi,
  listPtzOutputNames,
  type PtzBinding,
  type PtzStatus,
} from '$lib/audio/ptz-midi';

/** Ticks between sends: 40 Hz scheduler / 4 = 10 Hz on the wire (≤12 Hz by
 *  design; the helper coalesces again at 30 Hz, and 10 Hz comfortably outruns
 *  the helper's ~250 ms velocity watchdog). */
const SEND_DECIMATE = 4;

export interface PtzcamCardApi {
  connect(): Promise<void>;
  status(): PtzStatus;
  listPorts(): string[];
  selectedPort(): string | null;
  selectPort(name: string | null): void;
}

export interface PtzcamState {
  readonly status: PtzStatus['kind'];
  readonly targets: PtzTargets;
  /** Scheduler ticks seen — lets a test wait on "the send loop ran N times"
   *  instead of a wall-clock sleep. */
  readonly ticks: number;
  readonly sentFrames: number;
  readonly lastSent: PtzTargets | null;
  readonly lastVel: PtzTargets | null;
}

export const ptzcamDef: AudioModuleDef = {
  // String LITERALS, not constants: module-manifest.ts extracts these fields
  // with a ?raw regex and cannot resolve a reference.
  type: 'ptzcam',
  palette: { top: 'MIDI', sub: 'MIDI' },
  domain: 'audio',
  label: 'ptz cam',
  category: 'output',
  maxInstances: 4,
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
      'Drives a physical PTZ camera from the patch. It sends MIDI sysex to the PT-PTZ helper ' +
      'app running on the same machine, which translates into USB camera control — the camera ' +
      'physically pans, tilts and zooms. The helper exposes one MIDI pair per connected camera ' +
      '(PT-PTZ-…); the card picks which camera this module drives, so two modules can run two ' +
      "cameras. The module carries no audio or video of its own — the camera's picture reaches " +
      'the rack through a normal camera input. Each axis follows what the camera itself ' +
      'reports in the bind handshake: an ABSOLUTE axis (NexiGo P610 pan/tilt/zoom, Logitech ' +
      'zoom) treats knob+CV as a position, ±1 spanning the full mechanical range; a VELOCITY ' +
      'axis (Logitech PTZ Pro 2 pan/tilt) treats knob+CV as a rate — sign is direction, zero ' +
      '(with a small deadzone) stops, and the helper halts motion by itself if the app ever ' +
      'stops streaming, so a dropped page cannot leave the camera panning. PAN, TILT and ZOOM ' +
      'knobs are the base value; the matching CV inputs ADD to the knob, so with knobs at ' +
      'default a patched LFO or joystick IS the position (or rate) and the knobs become stage ' +
      'trim. SLEW rate-limits absolute-axis motion (1 = instant); velocity axes ignore it — ' +
      'a commanded stop must never be slewed. Sends are coalesced to ~10 per second.',
    inputs: {
      pan_cv:
        'Pan CV, ±1, added to the PAN knob. On an absolute-axis camera the sum is the pan position; on a velocity-axis camera it is the pan rate (sign = direction, near-zero = stop).',
      tilt_cv:
        'Tilt CV, ±1, added to the TILT knob. Position on an absolute axis, rate on a velocity axis.',
      zoom_cv:
        'Zoom CV, added to the ZOOM knob; the summed 0..1 spans wide to full telephoto.',
    },
    controls: {
      pan: 'Base pan, ±1. Position on an absolute-axis camera, rate on a velocity-axis one. CV on pan_cv adds to it.',
      tilt: 'Base tilt, ±1. Position on an absolute axis, rate on a velocity axis. CV on tilt_cv adds to it.',
      zoom: 'Base zoom, 0 wide to 1 full telephoto. CV on zoom_cv adds to it.',
      slew: 'Rate limit on absolute-axis motion, fractions of full range per second on a square curve; 1 is instant. Velocity axes ignore it.',
    },
  },

  async factory(ctx, node) {
    const nodeId = node.id;

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

    function readDeviceSelection(): string | null {
      const live = livePatch.nodes[nodeId];
      const data = (live?.data as Record<string, unknown> | undefined) ?? {};
      return typeof data.device === 'string' && data.device !== '' ? data.device : null;
    }
    function writeDeviceSelection(name: string | null): void {
      ydoc.transact(() => {
        const live = livePatch.nodes[nodeId];
        if (!live) return;
        if (!live.data) live.data = {};
        (live.data as Record<string, unknown>).device = name ?? '';
      });
    }

    let binding: PtzBinding | null = null;
    let bindingSelector: string | null | undefined;
    // MUTATES binding state — call only from event/tick contexts (the scheduler
    // tick, a card click), NEVER from a read path: a card $derived evaluates
    // status()/listPorts(), and acquiring a binding there can bump the version
    // store mid-derived → Svelte state_unsafe_mutation (measured).
    function ensureBinding(): PtzBinding {
      const want = readDeviceSelection();
      if (!binding || bindingSelector !== want) {
        binding?.release();
        binding = acquirePtzBinding(want);
        bindingSelector = want;
      }
      return binding;
    }

    const IDLE_STATUS: PtzStatus = {
      kind: 'idle',
      message: 'Not connected. Connect grants MIDI and finds the PT-PTZ helper.',
      caps: null,
      portName: null,
    };
    // PURE read of the current binding — safe from any derived.
    function currentStatus(): PtzStatus {
      return binding?.status() ?? IDLE_STATUS;
    }

    let plan: PtzPlan | null = null;
    let sentFrames = 0;
    let lastSent: PtzTargets | null = null;
    let lastVel: PtzTargets | null = null;
    let tickN = 0;

    function tick(): void {
      try {
        if (++tickN % SEND_DECIMATE !== 0) return;
        const b = ensureBinding();
        const status = b.status();
        const caps = b.caps();
        if (status.kind !== 'bound' || !caps) {
          // Re-assert the whole position on the next bind — a restarted helper
          // or replugged camera starts from wherever the head physically is.
          // Velocity motion is halted by the helper's own watchdog the moment
          // this loop stops streaming.
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
        let sentAny = false;
        for (const send of next.sends) {
          const frame =
            send.kind === 'abs' ? buildSetAbs(send.control, send.value) : buildSetVel(send.control, send.value);
          if (b.send(frame)) {
            sentFrames++;
            sentAny = true;
          }
        }
        if (sentAny) {
          lastSent = next.plan.sent;
          lastVel = next.plan.sentVel;
        }
      } catch (err) {
        console.error('[ptzcam] tick error', err);
      }
    }
    const unsubscribeTick = getSchedulerClock().subscribe(tick);

    const cardApi: PtzcamCardApi = {
      connect: () => {
        ensureBinding();
        return connectPtzMidi();
      },
      status: currentStatus,
      listPorts: () => listPtzOutputNames(),
      selectedPort: () => readDeviceSelection(),
      selectPort: (name) => {
        writeDeviceSelection(name);
        ensureBinding();
      },
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
            status: currentStatus().kind,
            targets: {
              pan: knobs.pan! + latestSample(taps.pan),
              tilt: knobs.tilt! + latestSample(taps.tilt),
              zoom: knobs.zoom! + latestSample(taps.zoom),
            },
            ticks: tickN,
            sentFrames,
            lastSent,
            lastVel,
          };
          return state;
        }
        return undefined;
      },
      dispose() {
        unsubscribeTick();
        // release() at refcount zero sends STOP_ALL — no head keeps moving
        // because its module was deleted.
        binding?.release();
        binding = null;
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
