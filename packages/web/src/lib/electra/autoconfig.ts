// packages/web/src/lib/electra/autoconfig.ts
//
// AUTOCONFIG — the "Connect Electra (Automagic)" orchestrator.
//
// One call wires the whole flow:
//   identity → enumerate patch → allocate (generatePreset) → push .epr (01 01) +
//   Lua (01 0C) → import the CC map into midi-learn (so inbound writes land on
//   the right param) → start the feedback pump → switch to page 1.
//
// Host touchpoints (engine read/write, patch snapshot, bindings import, banner)
// are injected via AutoconfigHost so this module stays free of svelte-store /
// engine singletons and is unit/e2e-testable with fakes. The UI component
// (ElectraConnectButton) supplies the real wiring.
//
// Inbound routing: the broker's onCC fan-out is matched against the allocation
// table. A 'rw' control writes the param (curve-aware) via host.writeParam; a
// 'tap' note pumps the TapTempo helper → host.writeParam(tlId,'bpm',bpm); 'meter'
// and 'banner' inbound is ignored (app→device only). midi-learn keeps its own
// learned CCs working in parallel — autoconfig does NOT consume those events.

import type { GeneratedPreset, ElectraAllocation } from './types';
import { ElectraBroker, electraBroker, type CcEvent, type NoteEvent } from './broker';
import { generatePreset, emitPresetJson, type PresetGenInput } from './preset';
import { FeedbackPump, type FeedbackDeps } from './feedback';
import { cc7ToValue } from './curve';
import { TapTempo } from './tap-tempo';

/** Everything the orchestrator needs from the app, injected for testability. */
export interface AutoconfigHost {
  /** Build the generator input from the live patch (surface bindings, mixmstrs
   *  id, timelorde id, label + param-def resolvers). */
  buildGenInput(): PresetGenInput;
  /** Read a writable control's current value (engine.readParam / read), keyed
   *  by the allocation key "moduleId:paramId". */
  readParamValue(key: string): number | undefined;
  /** Read a per-channel meter RMS amplitude (0..1) for a meter key. */
  readMeterAmp(key: string): number | undefined;
  /** Write a param value to the patch store (drives engine + rack-mates). */
  writeParam(moduleId: string, paramId: string, value: number): void;
  /** True when an external clock edge is patched to the timelorde's `clock`
   *  input (greys/disables the tap path + BPM tweak). */
  hasExternalClock(): boolean;
  /** The Lua layer source to upload (templates from docs/electra/lua/*). */
  luaSource(): string;
  /** Optional: pull the SRC banner text ('INT 120' / 'EXT 128'). */
  bannerText?(): string;
  /** Optional: fire a momentary BUTTON's bound action (e.g. transport play) on
   *  the press edge. The host looks up its registered onGate/onToggle callback
   *  keyed `moduleId:paramId`. `high` is true on NOTE-on, false on NOTE-off so a
   *  momentary host can hold + release; a toggle host ignores the release. */
  triggerButton?(moduleId: string, paramId: string, high: boolean): void;
}

export interface AutoconfigResult {
  ok: boolean;
  isElectra: boolean;
  generated?: GeneratedPreset;
  reason?: string;
}

/** Split a "moduleId:paramId" allocation key. tap/meter/banner keys have the
 *  module id as the first segment too. */
function splitKey(key: string): { moduleId: string; paramId: string } {
  const i = key.indexOf(':');
  return i < 0
    ? { moduleId: key, paramId: '' }
    : { moduleId: key.slice(0, i), paramId: key.slice(i + 1) };
}

export class ElectraAutoconfig {
  private pump: FeedbackPump | null = null;
  private tap: TapTempo | null = null;
  private unsubCc: (() => void) | null = null;
  private unsubNote: (() => void) | null = null;
  private allocByNumber = new Map<string, ElectraAllocation>(); // `${type}:${num}` → alloc
  private generated: GeneratedPreset | null = null;
  private now: () => number =
    () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  constructor(
    private host: AutoconfigHost,
    private broker: ElectraBroker = electraBroker,
    private opts: { identifyTimeoutMs?: number } = {},
  ) {}

  /** The full automagic flow. Returns a result describing what happened. */
  async run(): Promise<AutoconfigResult> {
    const connected = await this.broker.connect();
    if (!connected) {
      return { ok: false, isElectra: false, reason: 'no-midi-access' };
    }
    const id = await this.broker.identify(this.opts.identifyTimeoutMs);
    // Even if identity didn't confirm (some firmwares are slow), proceed with
    // upload — the user explicitly asked to configure THIS device.

    const gen = generatePreset(this.host.buildGenInput());
    this.generated = gen;
    this.indexAllocations(gen);

    // Push preset + Lua.
    this.broker.uploadPreset(emitPresetJson(gen.preset));
    this.broker.uploadLua(this.host.luaSource());

    // Wire inbound dispatch.
    this.tap = new TapTempo();
    this.attachInbound(gen);

    // Start feedback pump (writable feedback + 30Hz meter stream). Route each
    // control's CC to the USB-DEVICE port matching its preset device.port (NOT
    // the CTRL management port): the Electra listens for control values on the
    // numbered bus the control is bound to. PT-CTRL → port 2, PT-PLAY → port 1.
    const portByDeviceId = new Map<number, number>(
      gen.preset.devices.map((d) => [d.id, d.port]),
    );
    const deps: FeedbackDeps = {
      readParamValue: (k) => this.host.readParamValue(k),
      readMeterAmp: (k) => this.host.readMeterAmp(k),
      sendCc: (deviceId, cc, value) =>
        this.broker.sendCcOnPort(portByDeviceId.get(deviceId) ?? 2, cc, value),
    };
    this.pump = new FeedbackPump(gen.allocations, deps);
    this.pump.start(33);

    // Push initial banner + gate the tap pad, then switch to page 1.
    this.pushBanner();
    this.broker.switchPage(1);

    return { ok: true, isElectra: id.isElectra, generated: gen };
  }

  /** Build the inbound-number index for O(1) CC/note → allocation lookup. */
  private indexAllocations(gen: GeneratedPreset): void {
    this.allocByNumber.clear();
    for (const a of gen.allocations) {
      this.allocByNumber.set(`${a.messageType}:${a.number}`, a);
    }
  }

  private attachInbound(gen: GeneratedPreset): void {
    this.unsubCc?.();
    this.unsubNote?.();
    // Writable-control CCs → param writes.
    this.unsubCc = this.broker.onCC((ev: CcEvent) => this.handleCc(ev));
    // Inbound notes on the PLAY port: the tap pad (on-edge only → tap-tempo) and
    // momentary BUTTON pads (both edges → the bound button's action).
    this.unsubNote = this.broker.onNote((ev: NoteEvent) => {
      this.handleNote(ev);
    });
    void gen;
  }

  /** Route an inbound NOTE to its allocation: tap pad → tap-tempo (on-edge),
   *  momentary button pad → the host's bound button action (both edges). */
  handleNote(ev: NoteEvent): void {
    const a = this.allocByNumber.get(`note:${ev.note}`);
    if (!a) return;
    if (a.role === 'tap') {
      if (ev.on) this.handleTapNote(ev.note, this.now());
      return;
    }
    if (a.role === 'button-momentary') {
      const { moduleId, paramId } = splitKey(a.key);
      this.host.triggerButton?.(moduleId, paramId, ev.on);
    }
  }

  /** Route an inbound CC to its param (rw) — or a toggle button action
   *  (button-toggle) — or ignore (meter/banner). */
  handleCc(ev: CcEvent): void {
    const a = this.allocByNumber.get(`cc7:${ev.cc}`);
    if (!a) return; // not one of ours; midi-learn may still own it
    // A TOGGLE button pad: fire the bound button action on the RISING edge only
    // (cc ≥ 64 → press). The button itself owns the latched state; we just pulse
    // the toggle, matching the on-card click behavior.
    if (a.role === 'button-toggle') {
      const { moduleId, paramId } = splitKey(a.key);
      if (ev.value >= 64) this.host.triggerButton?.(moduleId, paramId, true);
      return;
    }
    if (a.role !== 'rw') return; // meters/banners are app→device only
    if (a.min === undefined || a.max === undefined) return;
    const { moduleId, paramId } = splitKey(a.key);
    const value = cc7ToValue(ev.value, a.min, a.max, a.curve ?? 'linear');
    // Echo-suppress: tell the pump the device just sent this so we don't bounce
    // it straight back.
    this.pump?.noteInbound(a.key, ev.value);
    this.host.writeParam(moduleId, paramId, value);
  }

  /** Route an inbound tap NOTE to the tap-tempo helper → write internal bpm.
   *  Disabled when an external clock is patched (hardware is master). Called by
   *  the host's note listener (or a test) with the note number + timestamp. */
  handleTapNote(note: number, now: number): void {
    if (this.host.hasExternalClock()) return; // EXT mode: tap is inert
    const a = this.allocByNumber.get(`note:${note}`);
    if (!a || a.role !== 'tap' || !this.tap) return;
    const bpm = this.tap.tap(now);
    if (bpm === null) return;
    const { moduleId } = splitKey(a.key);
    this.host.writeParam(moduleId, 'bpm', bpm);
  }

  /** Push the SRC banner + gate the tap pad / BPM encoder per clock source. */
  pushBanner(): void {
    const ext = this.host.hasExternalClock();
    const text = this.host.bannerText?.() ?? (ext ? 'EXT' : 'INT');
    this.broker.setBanner(text);
    // Tap-pad gating: drive a Lua external flag so the device greys the pad.
    this.broker.executeLua(`pt_setExternal(${ext ? 'true' : 'false'})`);
  }

  /** The allocation table (for tests / the UI status panel). */
  get allocations(): ElectraAllocation[] {
    return this.generated?.allocations ?? [];
  }

  /** Tear down the pump + inbound listeners (e.g. on disconnect / unmount). */
  stop(): void {
    this.pump?.stop();
    this.pump = null;
    this.unsubCc?.();
    this.unsubCc = null;
    this.unsubNote?.();
    this.unsubNote = null;
    this.tap = null;
  }
}
