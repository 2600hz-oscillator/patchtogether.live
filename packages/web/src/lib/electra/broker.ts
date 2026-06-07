// packages/web/src/lib/electra/broker.ts
//
// ELECTRA BROKER — the Web MIDI adapter.
//
// A single `navigator.requestMIDIAccess({ sysex: true })` (Electra needs SysEx
// for preset/Lua upload + identity). Behind the existing on-demand MIDI
// permission flow — NO eager prompt (mirrors midi-cv-buddy / midi-learn: we only
// request access when the user clicks "Auto-configure Electra"). Reuses the
// MidiInputLike / MidiOutputLike / MidiAccessLike shapes so a test can inject a
// fake Electra via the same `installSimulatedMidiDevice` / `__test_setAccess`
// pattern the rest of the MIDI stack uses.
//
// Responsibilities:
//   - Acquire sysex-capable access (idempotent, lazy).
//   - Device fingerprint + identity query (02 7F → manufacturer 00 21 45).
//   - CTRL / PLAY port split (the Electra exposes 2 USB-MIDI ports; CTRL = port 2
//     for throttled meters, PLAY = port 1 for note/tap traffic).
//   - sendSysex / sendCC / sendNote and onSysex / onCC fan-out.
//   - Inbound CC is also forwarded to midi-learn.handleMidi (so a learned knob
//     still responds) — wired by the caller (autoconfig) to avoid a hard import
//     cycle; the broker just exposes onCC.
//
// All higher-level framing (preset upload, Lua upload, page switch, banner) lives
// in the SysEx helpers at the bottom.

import type {
  MidiAccessLike,
  MidiInputLike,
  MidiEventLike,
} from '$lib/audio/modules/midi-cv-buddy';
import type { MidiOutputLike } from '$lib/audio/modules/midi-out-buddy';
import { webMidiAvailable } from '$lib/audio/modules/midi-cv-buddy';
import type { ElectraIdentity } from './types';

/** Combined sysex-capable access (inputs + outputs). */
export interface MidiFullAccessLike {
  inputs: Map<string, MidiInputLike>;
  outputs: Map<string, MidiOutputLike>;
  onstatechange: ((ev: { port: MidiInputLike | MidiOutputLike }) => void) | null;
}

// Electra One manufacturer SysEx id.
export const ELECTRA_MFR = [0x00, 0x21, 0x45] as const;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;

// Electra command bytes (after the manufacturer id).
const CMD_UPLOAD = [0x01, 0x01] as const; // upload preset (.epr JSON follows)
const CMD_UPLOAD_LUA = [0x01, 0x0c] as const; // upload Lua script
const CMD_EXECUTE_LUA = [0x08, 0x0d] as const; // execute a Lua command (e.g. info.setText)
const CMD_PAGE_SWITCH = [0x09, 0x0a] as const; // switch to page N
const CMD_IDENTITY_REQ = [0x02, 0x7f] as const; // identity / device-info probe

// ──────────────────────────── pure framing helpers ────────────────────────────

/** Encode an ASCII string to a 7-bit byte array (each char's low 7 bits). */
export function asciiToBytes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0x7f);
  return out;
}

/** Frame a full Electra SysEx: F0 00 21 45 <cmd...> <payload...> F7. */
export function frameSysex(cmd: readonly number[], payload: readonly number[] = []): Uint8Array {
  return Uint8Array.from([SYSEX_START, ...ELECTRA_MFR, ...cmd, ...payload, SYSEX_END]);
}

/** Frame a preset-upload SysEx for a (minified, 7-bit) JSON string. */
export function framePresetUpload(json: string): Uint8Array {
  return frameSysex(CMD_UPLOAD, asciiToBytes(json));
}

/** Frame a Lua-upload SysEx for a Lua source string. */
export function frameLuaUpload(lua: string): Uint8Array {
  return frameSysex(CMD_UPLOAD_LUA, asciiToBytes(lua));
}

/** Frame an execute-Lua SysEx (e.g. `info.setText("EXT 128")`). */
export function frameExecuteLua(luaExpr: string): Uint8Array {
  return frameSysex(CMD_EXECUTE_LUA, asciiToBytes(luaExpr));
}

/** Frame a page-switch SysEx. */
export function framePageSwitch(page: number): Uint8Array {
  return frameSysex(CMD_PAGE_SWITCH, [page & 0x7f]);
}

/** Frame the identity probe. */
export function frameIdentityRequest(): Uint8Array {
  return frameSysex(CMD_IDENTITY_REQ);
}

/** Parse an inbound SysEx into an identity fingerprint (returns isElectra=false
 *  for anything that isn't the Electra manufacturer id). */
export function parseIdentity(data: Uint8Array): ElectraIdentity {
  // F0 7E .. (universal device-info) OR F0 00 21 45 .. (Electra-specific).
  const isElectra =
    data.length >= 4 &&
    data[0] === SYSEX_START &&
    data[1] === ELECTRA_MFR[0] &&
    data[2] === ELECTRA_MFR[1] &&
    data[3] === ELECTRA_MFR[2];
  // Best-effort firmware extraction: any printable ASCII run in the tail.
  let firmware: string | undefined;
  if (isElectra) {
    let s = '';
    for (let i = 4; i < data.length - 1; i++) {
      const b = data[i]!;
      if (b >= 0x20 && b <= 0x7e) s += String.fromCharCode(b);
    }
    firmware = s.trim() || undefined;
  }
  return { manufacturerId: [...ELECTRA_MFR], firmware, isElectra };
}

/** Build a CC message (status 0xB0 | channel, cc, value). channel is 0-based. */
export function ccMessage(channel: number, cc: number, value: number): number[] {
  return [0xb0 | (channel & 0x0f), cc & 0x7f, value & 0x7f];
}

/** Build a NoteOn message. */
export function noteOnMessage(channel: number, note: number, velocity: number): number[] {
  return [0x90 | (channel & 0x0f), note & 0x7f, velocity & 0x7f];
}

// ──────────────────────────── broker class ────────────────────────────

export interface CcEvent {
  channel: number;
  cc: number;
  value: number;
}

export interface NoteEvent {
  channel: number;
  note: number;
  velocity: number;
  /** True for NoteOn with velocity > 0; false for NoteOff (or NoteOn vel 0). */
  on: boolean;
}

export class ElectraBroker {
  private access: MidiFullAccessLike | null = null;
  private connectStarted = false;
  private connectFailed = false;

  /** Resolved Electra output ports keyed by role (after fingerprint).
   *  ctrlOut = the management/CTRL port (preset/Lua/page/identity SysEx);
   *  playOut = the tap-note port (port 1, mostly inbound). */
  private ctrlOut: MidiOutputLike | null = null;
  private playOut: MidiOutputLike | null = null;
  /** Numbered USB-DEVICE routing ports (1/2) for per-control CC — a control's
   *  CC must go to the USB port matching its preset device.port (the Electra
   *  routes/forwards by these), NOT the CTRL management port. */
  private portOut: Record<number, MidiOutputLike | null> = { 1: null, 2: null };

  private sysexListeners = new Set<(data: Uint8Array) => void>();
  private ccListeners = new Set<(ev: CcEvent) => void>();
  private noteListeners = new Set<(ev: NoteEvent) => void>();

  /** Lazy, idempotent sysex-capable MIDIAccess request. Returns true on
   *  success. NO eager prompt — only called from the explicit user action. */
  async connect(): Promise<boolean> {
    if (this.access) return true;
    if (this.connectFailed) return false;
    if (this.connectStarted) {
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 25));
        if (this.access) return true;
        if (this.connectFailed) return false;
      }
      return false;
    }
    if (!webMidiAvailable()) {
      this.connectFailed = true;
      return false;
    }
    this.connectStarted = true;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = await (navigator as any).requestMIDIAccess({ sysex: true });
      this.access = a as MidiFullAccessLike;
      this.attachInputs();
      this.access.onstatechange = () => this.attachInputs();
      return true;
    } catch {
      this.connectFailed = true;
      return false;
    }
  }

  private attachInputs(): void {
    if (!this.access) return;
    for (const inp of this.access.inputs.values()) {
      inp.onmidimessage = (ev: MidiEventLike) => this.handleInbound(ev);
    }
  }

  private handleInbound(ev: MidiEventLike): void {
    const data = ev.data;
    if (data.length === 0) return;
    if (data[0] === SYSEX_START) {
      for (const fn of this.sysexListeners) fn(data);
      return;
    }
    const status = data[0]! & 0xf0;
    if (status === 0xb0 && data.length >= 3) {
      const cc: CcEvent = { channel: data[0]! & 0x0f, cc: data[1]!, value: data[2]! };
      for (const fn of this.ccListeners) fn(cc);
      return;
    }
    // NoteOn (0x9n) / NoteOff (0x8n) — the tap pad arrives here.
    if ((status === 0x90 || status === 0x80) && data.length >= 3) {
      const velocity = data[2]!;
      const on = status === 0x90 && velocity > 0;
      const ev: NoteEvent = { channel: data[0]! & 0x0f, note: data[1]!, velocity, on };
      for (const fn of this.noteListeners) fn(ev);
    }
  }

  /** Probe + fingerprint the connected Electra. Returns the identity (or a
   *  not-Electra fingerprint after a short timeout). Also resolves the CTRL /
   *  PLAY output ports by name heuristic. */
  async identify(timeoutMs = 600): Promise<ElectraIdentity> {
    if (!this.access) await this.connect();
    this.resolvePorts();
    return new Promise<ElectraIdentity>((resolve) => {
      let done = false;
      const onSysex = (data: Uint8Array) => {
        const id = parseIdentity(data);
        if (id.isElectra && !done) {
          done = true;
          this.sysexListeners.delete(onSysex);
          resolve(id);
        }
      };
      this.sysexListeners.add(onSysex);
      // Send identity probe on whichever CTRL port resolved (else first output).
      this.sendSysex(frameIdentityRequest(), 'ctrl');
      setTimeout(() => {
        if (done) return;
        done = true;
        this.sysexListeners.delete(onSysex);
        resolve({ manufacturerId: [...ELECTRA_MFR], isElectra: false });
      }, timeoutMs);
    });
  }

  /** Heuristic port resolution: Electra exposes ports named like
   *  "Electra Controller ... CTRL" / "... Port 1". Falls back to first/second
   *  output. */
  private resolvePorts(): void {
    if (!this.access) return;
    const outs = [...this.access.outputs.values()];
    const electra = outs.filter((o) => /electra/i.test(o.name ?? ''));
    const pool = electra.length ? electra : outs;
    const nm = (o: MidiOutputLike): string => o.name ?? '';

    // The Electra exposes THREE USB-DEVICE ports: "… Port 1", "… Port 2", and
    // the management "… CTRL" port (per docs.electra.one v3 routing). They have
    // DISTINCT jobs and must not be conflated:
    //   • CTRL  → management SysEx (preset/Lua/page-switch/identity). It is the
    //     editor port; it does NOT forward to the hardware MIDI jacks and the
    //     device replies (ACK/events) on the same port. Editor SysEx belongs here.
    //   • Port 1 / Port 2 → general MIDI buses; a control's CC flows on the port
    //     matching its preset device.port, and Port N FORWARDS to MIDI-OUT N — so
    //     blasting a preset-upload SysEx down Port 2 also spews it out the DIN jack.
    // (/ctrl/i deliberately does NOT match the device-name prefix "Controller" —
    // it only matches the dedicated "CTRL" port. Some OSes surface CTRL as a
    // generic "Port 3"/"MIDIOUT3", hence the port-3 fallback.)
    const byNum = (n: number): MidiOutputLike | null =>
      pool.find((o) => new RegExp(`port\\s*${n}|midi\\s*(out\\s*)?${n}`, 'i').test(nm(o))) ?? null;
    const mgmt =
      pool.find((o) => /ctrl/i.test(nm(o)) && !/port\s*\d/i.test(nm(o))) ?? byNum(3);

    this.portOut = { 1: byNum(1), 2: byNum(2) };
    // Management/'ctrl' role → the dedicated CTRL port, falling back to Port 2,
    // then Port 1, then the first output if the device exposes no discrete CTRL.
    this.ctrlOut = mgmt ?? this.portOut[2] ?? this.portOut[1] ?? pool[0] ?? null;
    // 'play' role → Port 1 (the tap-note bus; mostly inbound).
    this.playOut = this.portOut[1] ?? pool[0] ?? null;

    // Hardware-bring-up diagnostic: this is a name-heuristic that has to cope
    // with per-OS port-name quirks. Log the enumeration + the resolved choice so
    // a first-run mis-resolve is debuggable from the console instead of silent.
    try {
      // eslint-disable-next-line no-console
      console.info('[electra] MIDI ports', {
        outputs: outs.map(nm),
        inputs: [...this.access.inputs.values()].map((i) => i.name ?? '(unnamed)'),
        matchedElectra: electra.map(nm),
        chosenMgmt: this.ctrlOut?.name ?? null,
        port1: this.portOut[1]?.name ?? null,
        port2: this.portOut[2]?.name ?? null,
      });
    } catch {
      /* console may be absent in non-DOM test envs */
    }
  }

  /** Send raw SysEx on a port role ('ctrl' = management/CTRL by default). */
  sendSysex(bytes: Uint8Array, role: 'ctrl' | 'play' = 'ctrl'): void {
    const out = role === 'play' ? this.playOut : this.ctrlOut;
    out?.send(bytes);
  }

  /** Send a plain CC on a specific USB-DEVICE port NUMBER (the control's preset
   *  device.port). Falls back to the management port if that numbered port isn't
   *  exposed (single-port OS naming). This is how the feedback/meter pump reaches
   *  each control on the bus the Electra actually listens on. */
  sendCcOnPort(usbPort: number, cc: number, value: number, channel = 0): void {
    const out = this.portOut[usbPort] ?? this.ctrlOut;
    out?.send(ccMessage(channel, cc, value));
  }

  /** Send a plain CC on a port role. (Values stream as parameter-map auto-sync.) */
  sendCc(cc: number, value: number, role: 'ctrl' | 'play' = 'ctrl', channel = 0): void {
    const out = role === 'play' ? this.playOut : this.ctrlOut;
    out?.send(ccMessage(channel, cc, value));
  }

  /** Send a NoteOn. */
  sendNote(note: number, velocity: number, role: 'ctrl' | 'play' = 'play', channel = 0): void {
    const out = role === 'play' ? this.playOut : this.ctrlOut;
    out?.send(noteOnMessage(channel, note, velocity));
  }

  // ── high-level framed sends ──
  uploadPreset(json: string): void { this.sendSysex(framePresetUpload(json), 'ctrl'); }
  uploadLua(lua: string): void { this.sendSysex(frameLuaUpload(lua), 'ctrl'); }
  executeLua(expr: string): void { this.sendSysex(frameExecuteLua(expr), 'ctrl'); }
  switchPage(page: number): void { this.sendSysex(framePageSwitch(page), 'ctrl'); }
  /** Push the SRC banner text via Lua info.setText. */
  setBanner(text: string): void { this.executeLua(`info.setText("${text.replace(/"/g, '')}")`); }

  // ── listener registration ──
  onSysex(fn: (data: Uint8Array) => void): () => void {
    this.sysexListeners.add(fn);
    return () => this.sysexListeners.delete(fn);
  }
  onCC(fn: (ev: CcEvent) => void): () => void {
    this.ccListeners.add(fn);
    return () => this.ccListeners.delete(fn);
  }
  onNote(fn: (ev: NoteEvent) => void): () => void {
    this.noteListeners.add(fn);
    return () => this.noteListeners.delete(fn);
  }

  get connected(): boolean { return !!this.access; }

  // ── test hooks ──
  /** Inject a fake full access (parallels midi-learn.__test_setAccess). */
  __test_setAccess(fake: MidiFullAccessLike | null): void {
    this.access = fake;
    this.connectStarted = !!fake;
    this.connectFailed = false;
    if (fake) {
      this.attachInputs();
      this.resolvePorts();
    } else {
      this.ctrlOut = null;
      this.playOut = null;
    }
  }
}

/** Process-wide singleton (mirrors the midi-learn singleton pattern). */
export const electraBroker = new ElectraBroker();
