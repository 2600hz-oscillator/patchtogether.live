// USER FIRMWARE MODE RAW DECODER — LinnStrument wire bytes → cell events.
//
// The raw decoder is SPECIFIC to User Firmware Mode: in that mode a MIDI note
// number is a WIRE COLUMN (1..25), the channel is a ROW (1..8 on the wire,
// 0..7 here), and the CC numbers below mean coordinates, not controllers.
// Never pass this traffic through a musical-MIDI parser (design.md:174).
//
//   Note On   row channel, column note        fresh cell press (unless mid-slide)
//   Note Off  row channel, column note        cell release
//   CC col+32 then CC col                     X low then high — publish on a PAIR
//   CC col+64                                 local Y (0..127 within the cell)
//   Poly pressure, column note                Z; zero is a valid held pressure
//   CC119 = source col, Note On dest,
//     Note Off source                         horizontal transfer: SAME touch id
//   NRPN 245 (CC99/98/6/38)                   mode notification → new epoch on a
//                                             TRANSITION; an unchanged answer
//                                             is an acknowledgement, no epoch
//
// THE MODE GATES THE CELL VOCABULARY. Until the instrument has CONFIRMED User
// Firmware Mode (`state.userMode`, set only by its own NRPN 245 answer) the
// bytes above are ordinary musical MIDI — a Note On 17 on channel 8 is a note,
// not the R selector — so everything except NRPN management traffic is
// rejected `mode_unconfirmed`. Bound-but-unconfirmed is therefore as inert as
// unbound, and a confirmed OFF stays inert until a fresh entry is confirmed.
//
// Reference: `.myrobots/linnstrument-mpe/research/design.md:176-190`; the
// exploratory spike's `surface.ts:135-143` was read for the CC band arithmetic
// and nothing else — this file shares no code with it. No LinnStrument was
// connected when this was written: every byte here is a synthetic
// specification (contracts/acceptance-vectors.synthetic.json:3), and the X
// lo/hi arrival order + the raw-X offset (design.md:186) remain hardware
// questions. Both arrival orders assemble.
//
// PURE. Explicit state in, explicit state + events out, no callbacks, no
// mutation of the input state. ⚠ Plain `.ts`, no runes.

import type { Epoch, RawEvent, RawRejection, TouchId } from './types';

export const LINN_WIRE_COLUMNS = 25;
export const LINN_ROWS = 8;

/** CC bands in User Mode (column 1..25 → CC number). */
export const CC_X_HI_BASE = 0; // CC = column
export const CC_X_LO_BASE = 32; // CC = column + 32
export const CC_Y_BASE = 64; // CC = column + 64
export const CC_SLIDE = 119;
/** NRPN 245 = user firmware mode (MSB 1, LSB 117). */
export const NRPN_USER_FIRMWARE_MODE = 245;

export interface RawContact {
  touch: TouchId;
  /** Current wire column (moves on a completed slide). */
  col: number;
  /** Wire column of the FRESH press — a touch is owned by where it began. */
  originCol: number;
  row: number;
  pendingLo: number | null;
  pendingHi: number | null;
  x: number | null;
  initialX: number | null;
}

export interface RawTransfer {
  fromCol: number;
  toCol: number | null;
}

interface NrpnBuffer {
  msb: number | null;
  lsb: number | null;
  dataMsb: number | null;
}

export interface RawDecodeState {
  epoch: Epoch;
  /** Next touch generation id — never reset, even across epochs. */
  nextTouch: number;
  userMode: boolean;
  contacts: ReadonlyMap<number, RawContact>;
  transfers: ReadonlyMap<number, RawTransfer>;
  nrpn: ReadonlyMap<number, NrpnBuffer>;
  counters: { rejected: number; malformedSlides: number };
}

export interface RawDecodeResult {
  state: RawDecodeState;
  events: RawEvent[];
}

/** Cell address key: row-major over wire columns. */
export const cellKey = (col: number, row: number): number => row * 32 + col;

/** `userMode` starts UNCONFIRMED (false): only the instrument's own NRPN 245
 *  answer turns it on. A pure-pipeline test of the cell vocabulary starts
 *  from a confirmed state explicitly. */
export function createRawDecodeState(epoch: Epoch = 1, userMode = false): RawDecodeState {
  return {
    epoch,
    nextTouch: 1,
    userMode,
    contacts: new Map(),
    transfers: new Map(),
    nrpn: new Map(),
    counters: { rejected: 0, malformedSlides: 0 },
  };
}

function withContacts(state: RawDecodeState, contacts: Map<number, RawContact>): RawDecodeState {
  return { ...state, contacts };
}

function reject(state: RawDecodeState, reason: RawRejection, bytes: readonly number[], time: number): RawDecodeResult {
  return {
    state: { ...state, counters: { ...state.counters, rejected: state.counters.rejected + 1 } },
    events: [{ kind: 'rejected', epoch: state.epoch, reason, bytes: [...bytes], time }],
  };
}

/** End every contact and open a new epoch: the (re)connect / mode-change
 *  path. Old queued bytes that arrive afterwards find no contact and are
 *  rejected — a pre-disconnect voice cannot be resurrected (V14). */
export function reconnectRawDecode(state: RawDecodeState, time: number, userMode = state.userMode): RawDecodeResult {
  const events: RawEvent[] = [];
  for (const c of state.contacts.values()) {
    events.push({ kind: 'cell_up', epoch: state.epoch, touch: c.touch, col: c.col, row: c.row, releaseVelocity: 0, reason: 'session', time });
  }
  const epoch = state.epoch + 1;
  events.push({ kind: 'mode', epoch, userMode, changed: true, time });
  return {
    state: { ...state, epoch, userMode, contacts: new Map(), transfers: new Map(), nrpn: new Map() },
    events,
  };
}

function validate(bytes: ArrayLike<number>, time: number): RawRejection | null {
  if (!Number.isFinite(time)) return 'malformed';
  if (bytes.length < 2 || bytes.length > 3) return 'malformed';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    if (!Number.isInteger(b) || b < 0 || b > 255) return 'malformed';
  }
  const status = bytes[0]!;
  if (status < 0x80 || status >= 0xf0) return 'unknown_status';
  for (let i = 1; i < bytes.length; i++) if (bytes[i]! > 127) return 'high_bit_data';
  const kind = status & 0xf0;
  const expectLen = kind === 0xc0 || kind === 0xd0 ? 2 : 3;
  if (bytes.length !== expectLen) return 'malformed';
  return null;
}

/**
 * Decode ONE MIDI message (2–3 bytes) received from a LinnStrument in User
 * Firmware Mode. Returns the next state and the events the message produced;
 * a message that produces nothing yields exactly one `rejected` event naming
 * why, so nothing is silently dropped.
 */
export function decodePhysicalMidi(state: RawDecodeState, bytes: ArrayLike<number>, time: number): RawDecodeResult {
  const invalid = validate(bytes, time);
  if (invalid) return reject(state, invalid, Array.from(bytes), time);
  const status = bytes[0]!;
  const kind = status & 0xf0;
  const row = status & 0x0f;
  const a = bytes[1]!;
  const b = bytes[2] ?? 0;
  const raw = Array.from(bytes);

  // NRPN readback rides ordinary CCs on a row channel; CC 6 / 38 also mean X
  // for wire column 6, so a data byte is an NRPN byte ONLY after CC99+CC98.
  if (kind === 0xb0 && (a === 99 || a === 98 || a === 6 || a === 38 || a === 101 || a === 100)) {
    const nrpnResult = decodeNrpn(state, row, a, b, raw, time);
    if (nrpnResult) return nrpnResult;
  }

  // Everything below is User-Mode cell vocabulary (header: THE MODE GATES THE
  // CELL VOCABULARY). Unconfirmed, OFF or silent: these bytes are music.
  if (!state.userMode) return reject(state, 'mode_unconfirmed', raw, time);

  if (row >= LINN_ROWS) return reject(state, 'row_out_of_range', raw, time);
  const epoch = state.epoch;

  if (kind === 0xb0 && a === CC_SLIDE) {
    const transfers = new Map(state.transfers);
    let counters = state.counters;
    const events: RawEvent[] = [];
    if (transfers.has(row)) {
      counters = { ...counters, malformedSlides: counters.malformedSlides + 1 };
      events.push({ kind: 'rejected', epoch, reason: 'malformed_slide', bytes: raw, time });
    }
    if (b < 1 || b > LINN_WIRE_COLUMNS) return reject(state, 'column_out_of_range', raw, time);
    transfers.set(row, { fromCol: b, toCol: null });
    return { state: { ...state, transfers, counters }, events };
  }

  const isNoteOn = kind === 0x90 && b > 0;
  const isNoteOff = kind === 0x80 || (kind === 0x90 && b === 0);

  if (isNoteOn || isNoteOff || kind === 0xa0) {
    const col = a;
    if (col < 1 || col > LINN_WIRE_COLUMNS) return reject(state, 'column_out_of_range', raw, time);
    if (isNoteOn) return noteOn(state, col, row, b, raw, time);
    if (isNoteOff) return noteOff(state, col, row, b, raw, time);
    // Poly pressure = Z.
    const c = state.contacts.get(cellKey(col, row));
    if (!c) return reject(state, 'no_contact', raw, time);
    return { state, events: [{ kind: 'cell_z', epoch, touch: c.touch, col, row, z: b, time }] };
  }

  if (kind !== 0xb0) return reject(state, 'unknown_status', raw, time);

  // Coordinate CCs.
  const band = a >= CC_Y_BASE + 1 && a <= CC_Y_BASE + LINN_WIRE_COLUMNS ? 'y'
    : a >= CC_X_LO_BASE + 1 && a <= CC_X_LO_BASE + LINN_WIRE_COLUMNS ? 'lo'
    : a >= CC_X_HI_BASE + 1 && a <= CC_X_HI_BASE + LINN_WIRE_COLUMNS ? 'hi'
    : null;
  if (band === null) return reject(state, 'unmapped_cc', raw, time);
  const col = band === 'y' ? a - CC_Y_BASE : band === 'lo' ? a - CC_X_LO_BASE : a - CC_X_HI_BASE;
  const key = cellKey(col, row);
  const c = state.contacts.get(key);
  if (!c) return reject(state, 'no_contact', raw, time);
  if (band === 'y') {
    return { state, events: [{ kind: 'cell_y', epoch, touch: c.touch, col, row, y: b, time }] };
  }
  const pendingLo = band === 'lo' ? b : c.pendingLo;
  const pendingHi = band === 'hi' ? b : c.pendingHi;
  const contacts = new Map(state.contacts);
  if (pendingLo === null || pendingHi === null) {
    // Half a pair — hold it, publish nothing. Either order completes.
    contacts.set(key, { ...c, pendingLo, pendingHi });
    return { state: withContacts(state, contacts), events: [] };
  }
  const x = pendingHi * 128 + pendingLo;
  const initialX = c.initialX ?? x;
  contacts.set(key, { ...c, pendingLo: null, pendingHi: null, x, initialX });
  return {
    state: withContacts(state, contacts),
    events: [{ kind: 'cell_x', epoch, touch: c.touch, col, row, x, initialX, time }],
  };
}

function noteOn(state: RawDecodeState, col: number, row: number, velocity: number, raw: number[], time: number): RawDecodeResult {
  const epoch = state.epoch;
  const key = cellKey(col, row);
  const transfer = state.transfers.get(row);
  const events: RawEvent[] = [];
  let counters = state.counters;
  let transfers: ReadonlyMap<number, RawTransfer> = state.transfers;

  if (transfer && transfer.toCol === null) {
    const source = state.contacts.get(cellKey(transfer.fromCol, row));
    if (source && Math.abs(col - transfer.fromCol) === 1 && !state.contacts.has(key)) {
      // A validated horizontal transfer: the touch keeps its id, moves column,
      // drops any half-assembled X pair. No new attack.
      const contacts = new Map(state.contacts);
      contacts.delete(cellKey(source.col, row));
      contacts.set(key, { ...source, col, pendingLo: null, pendingHi: null });
      const nextTransfers = new Map(transfers);
      nextTransfers.set(row, { fromCol: transfer.fromCol, toCol: col });
      events.push({ kind: 'cell_slide', epoch, touch: source.touch, fromCol: transfer.fromCol, toCol: col, row, time });
      return { state: { ...state, contacts, transfers: nextTransfers }, events };
    }
    // Marker present but the transaction cannot be honoured: drop it, count
    // it, and treat this Note On as the fresh press it is.
    const dropped = new Map(transfers);
    dropped.delete(row);
    transfers = dropped;
    counters = { ...counters, malformedSlides: counters.malformedSlides + 1 };
    events.push({ kind: 'rejected', epoch, reason: 'malformed_slide', bytes: raw, time });
  }

  if (state.contacts.has(key)) {
    return {
      state: { ...state, transfers, counters: { ...counters, rejected: counters.rejected + 1 } },
      events: [...events, { kind: 'rejected', epoch, reason: 'duplicate_press', bytes: raw, time }],
    };
  }
  const touch = state.nextTouch;
  const contacts = new Map(state.contacts);
  contacts.set(key, { touch, col, originCol: col, row, pendingLo: null, pendingHi: null, x: null, initialX: null });
  events.push({ kind: 'cell_down', epoch, touch, col, row, velocity, time });
  return { state: { ...state, nextTouch: touch + 1, contacts, transfers, counters }, events };
}

function noteOff(state: RawDecodeState, col: number, row: number, velocity: number, raw: number[], time: number): RawDecodeResult {
  const epoch = state.epoch;
  const transfer = state.transfers.get(row);
  const events: RawEvent[] = [];
  let counters = state.counters;
  let transfers: ReadonlyMap<number, RawTransfer> = state.transfers;
  if (transfer) {
    const dropped = new Map(transfers);
    dropped.delete(row);
    transfers = dropped;
    if (transfer.toCol !== null && col === transfer.fromCol) {
      // The closing Note Off of a completed transfer: the touch already moved.
      return { state: { ...state, transfers }, events };
    }
    // Interrupted (release before the destination Note On) or mismatched:
    // the transaction dies and this is an ordinary release.
    counters = { ...counters, malformedSlides: counters.malformedSlides + 1 };
    events.push({ kind: 'rejected', epoch, reason: 'malformed_slide', bytes: raw, time });
  }
  const key = cellKey(col, row);
  const c = state.contacts.get(key);
  if (!c) {
    return {
      state: { ...state, transfers, counters: { ...counters, rejected: counters.rejected + 1 } },
      events: [...events, { kind: 'rejected', epoch, reason: 'no_contact', bytes: raw, time }],
    };
  }
  const contacts = new Map(state.contacts);
  contacts.delete(key);
  events.push({ kind: 'cell_up', epoch, touch: c.touch, col, row, releaseVelocity: velocity, time });
  return { state: { ...state, contacts, transfers, counters }, events };
}

/** Returns null when the CC is NOT part of an NRPN sequence (so CC6/CC38 fall
 *  through to their X meaning). */
function decodeNrpn(state: RawDecodeState, channel: number, cc: number, value: number, raw: number[], time: number): RawDecodeResult | null {
  const buf = state.nrpn.get(channel) ?? null;
  const nrpn = new Map(state.nrpn);
  if (cc === 99) {
    nrpn.set(channel, { msb: value, lsb: null, dataMsb: null });
    return { state: { ...state, nrpn }, events: [] };
  }
  if (cc === 98) {
    if (!buf || buf.msb === null) return null;
    nrpn.set(channel, { ...buf, lsb: value });
    return { state: { ...state, nrpn }, events: [] };
  }
  if (cc === 101 || cc === 100) {
    // RPN null / reset: closes any sequence on this channel.
    nrpn.delete(channel);
    return { state: { ...state, nrpn }, events: [] };
  }
  if (!buf || buf.msb === null || buf.lsb === null) return null;
  if (cc === 6) {
    nrpn.set(channel, { ...buf, dataMsb: value });
    return { state: { ...state, nrpn }, events: [] };
  }
  // cc === 38: data LSB completes the parameter.
  if (buf.dataMsb === null) return null;
  const parameter = buf.msb * 128 + buf.lsb;
  const data = buf.dataMsb * 128 + value;
  nrpn.delete(channel);
  const next = { ...state, nrpn };
  if (parameter === NRPN_USER_FIRMWARE_MODE) {
    const userMode = data !== 0;
    // An answer that reports the mode the decoder already holds is an
    // ACKNOWLEDGEMENT (the 299 read's answer after the entry echo, a repeated
    // read): the instrument did not change under us, so no contact ends and
    // no epoch opens. Only a real transition invalidates touch ownership.
    if (userMode === state.userMode) {
      return { state: next, events: [{ kind: 'mode', epoch: state.epoch, userMode, changed: false, time }] };
    }
    return reconnectRawDecode(next, time, userMode);
  }
  return { state: next, events: [] };
}
