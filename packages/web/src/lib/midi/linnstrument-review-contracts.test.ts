// THE 2026-09-15 ADVERSARIAL-REVIEW CONTRACTS — the cross-layer regression
// suite for the LinnStrument module: the REAL simulated device (port match,
// claim, decoder, surface map, registry) driving the REAL runtime (reducer,
// MPE allocator, arps, poly buses), with only the USB cable replaced. Every
// case asserts INTENDED behaviour; each was red against #2401 @ 4bef478c1 and
// names the finding it pins. All input is synthetic.
//
//   CONTROL  the positive control — a confirmed key reaches the factory
//   R01  F02  CONNECT re-sends the mode request while the mode is OFF
//   R02  F04  cell bytes are music until the instrument confirms User Mode
//   R03  F01  PANIC forgets a released, latched arp pool
//   R04  F06  an unchanged mode answer acknowledges, never invalidates
//   R05  F08  EXTRAS OFF darkens the actual outgoing control-column frame
//   R06  F07  a stalled tick never stacks arp attacks on one instant
//   R08  F05  ARP off drops the arp's queued pitch before the handover
//   R09  F03  a finger's pressure / timbre / velocity reach ITS lane's jacks
//             (owner ruling 2026-09-15: "a build")
//
// R07 ("overlapping vertical row handoff keeps the XY pad responsive") is NOT
// here: the review's H01 reproduced it (Y stays −0.75) but the mechanism is the
// selection reducer's INTENTIONAL first-eligible-fresh-contact / no-handoff
// policy (selection-reducer.ts `if (owner !== null) return none` on 'down';
// `if (owner !== intent.touch) return none`), a hardware-policy question for
// the owner — not a software defect, and not to be "fixed" by handing pointer
// ownership to a remaining contact.
//
// The per-layer halves of these contracts live next to their code:
// raw-decode.test.ts (F04, F06), linnstrument-device.test.ts (F02, F04, F06,
// F08), linnstrument-arp.test.ts (F01, F07), linnstrument.test.ts (F01, F05,
// F08, F09), graph-param-dispatch.test.ts (F09); the audible half of R03 is
// e2e/tests/linnstrument-panic-audible.spec.ts and the LINK lamp's three looks
// are e2e/tests/linnstrument.spec.ts (CONNECT).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLinnstrumentRuntime, type LinnstrumentCardApi } from '$lib/audio/modules/linnstrument-runtime';
import { createLinnArp } from '$lib/audio/modules/linnstrument-arp';
import { __resetLinnstrumentForTest, connectLinnstrument, installSimulatedLinnstrument, linnstrumentStatus } from '$lib/midi/linnstrument-device';
import { __resetLinnstrumentSourceForTest, subscribeLinnstrumentEvents } from '$lib/midi/linnstrument/source-registry';
import { RigBindingStore, emptyRigBindings, setRigBindingsForTests } from '$lib/graph/device-slot-bindings';
import { setNativeAvailableForTests } from '$lib/platform/native';

// Small timeline observer, including cancellation. It does not claim audio proof.
class Param {
  value = 0;
  events: { value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number) { this.events.push({ value, time }); }
  cancelScheduledValues(time: number) { this.events = this.events.filter(e => e.time < time); }
  at(time: number) { return this.events.filter(e => e.time <= time).sort((a,b) => a.time-b.time).at(-1)?.value ?? this.value; }
}
class Constant {
  offset = new Param();
  start() {} stop() {} disconnect() {}
  connect(target: Merger, _out: number, input: number) { target.inputs.set(input, this); }
}
class Merger {
  inputs = new Map<number, Constant>();
  disconnect() {}
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
let cleanup: (() => void)[] = [];
beforeEach(() => {
  __resetLinnstrumentForTest();
  __resetLinnstrumentSourceForTest();
  setNativeAvailableForTests(false);
  setRigBindingsForTests(new RigBindingStore({ load: () => emptyRigBindings(), save() {}, subscribe: () => () => {} }));
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  for (const fn of cleanup.reverse()) fn(); cleanup = [];
  __resetLinnstrumentForTest(); __resetLinnstrumentSourceForTest();
  setRigBindingsForTests(null); setNativeAvailableForTests(null); vi.restoreAllMocks();
});
async function rig(params: Record<string, number> = {}) {
  const sim = await installSimulatedLinnstrument();
  sim.ackUserMode(true);
  const ctx = { currentTime: 1, sampleRate: 48000, createConstantSource: () => new Constant(), createChannelMerger: () => new Merger() };
  const ticks = new Set<() => void>();
  let clockMs = 1000;
  const handle = await createLinnstrumentRuntime(ctx as any, { id: 'review-linn', type: 'linnstrument', params, data: {} } as any, {
    commitParam() {}, readTargets: () => ({}), bpm: () => 120,
    clock: { subscribe: fn => { ticks.add(fn); return () => ticks.delete(fn); } },
    nowMs: () => clockMs, batcher: null,
  });
  cleanup.push(() => handle.dispose());
  const api = handle.read!('card-api') as LinnstrumentCardApi;
  const gate = (handle.outputs.get('keys_poly')!.node as unknown as Merger).inputs.get(1)!.offset;
  return { sim, handle, api, ctx, gate, tick(ms: number) { clockMs = ms; ctx.currentTime = ms/1000; for (const fn of ticks) fn(); } };
}

it('CONTROL: confirmed raw key reaches the factory and release closes its gate', async () => {
  const r = await rig();
  r.sim.send([0x90, 1, 100]);
  expect(r.api.state().active.keys).toBe(1);
  expect(r.gate.at(2)).toBe(1);
  r.sim.send([0x80, 1, 0]);
  expect(r.api.state().active.keys).toBe(0);
  expect(r.gate.at(2)).toBe(0);
});

it('R01 CONNECT retries mode entry after a bound device reports mode OFF', async () => {
  const sim = await installSimulatedLinnstrument();
  sim.ackUserMode(false); await flush(); sim.clearWrites();
  expect(linnstrumentStatus().userMode).toBe(false);
  await connectLinnstrument(); await flush();
  expect(sim.writes().filter(w => w[1] === 99).length, 'retry must write at least the mode NRPN again').toBeGreaterThan(0);
});

it('R02 ordinary notes after confirmed mode OFF cannot become raw control presses', async () => {
  const sim = await installSimulatedLinnstrument();
  sim.ackUserMode(false);
  const events: any[] = []; cleanup.push(subscribeLinnstrumentEvents(e => events.push(e)));
  events.length = 0;
  sim.send([0x97, 17, 100]); // ordinary note 17 on channel 8; raw interpretation is R
  expect(events.filter(e => e.kind === 'control_edge')).toEqual([]);
});

it('R03 PANIC remains silent after all fingers released under HOLD', async () => {
  const r = await rig({ keys_arp_on: 1, keys_arp_latch: 1 });
  r.sim.send([0x90, 1, 100]); r.tick(1000);
  r.sim.send([0x80, 1, 0]);
  expect(r.api.state().arp.keys.running).toBe(true); // real latch precondition
  r.api.dispatch({ kind: 'panic' });
  expect(r.gate.at(1)).toBe(0); // panic genuinely closes the bus once
  r.tick(2000);
  expect(r.gate.at(2.03), 'next scheduler tick must not resurrect a latched note').toBe(0);
});

it('R04 unchanged mode readback preserves a held voice and its release identity', async () => {
  const r = await rig();
  r.sim.send([0x90, 1, 100]);
  expect(r.api.state().active.keys).toBe(1);
  const epoch = linnstrumentStatus().epoch;
  r.sim.ackUserMode(true, 0); // delayed answer to NRPN 299, after echo on channel 9
  expect({ epoch: linnstrumentStatus().epoch, active: r.api.state().active.keys }).toEqual({ epoch, active: 1 });
});

it('R05 EXTRAS OFF makes the actual outgoing lower-control LED frame dark', async () => {
  const r = await rig(); await flush(); r.sim.clearWrites();
  r.handle.setParam!('extra_controls', 0); await flush();
  // Hardware event is inert, but lighting must also follow this module switch.
  const triples = r.sim.writes().filter(w => [20,21,22].includes(w[1]!));
  let col = -1, row = -1; const cells: {row:number;color:number}[] = [];
  for (const w of triples) {
    if (w[1] === 20) col = w[2]!;
    if (w[1] === 21) row = w[2]!;
    if (w[1] === 22 && col === 17 && row < 5) cells.push({row,color:w[2]!});
  }
  expect(cells.sort((a,b) => a.row-b.row)).toEqual([0,1,2,3,4].map(row => ({row,color:7})));
});

it('R06 moderate scheduler stall never schedules multiple arp attacks at the same instant', () => {
  const arp = createLinnArp({ params: { divisionIndex: 1 } }); // 125 ms at 120 BPM
  const writes: number[] = [];
  arp.attach({ scheduleStep(at) { writes.push(at); }, silence() {} });
  arp.setEnabled(true); arp.touchStart(1,60); arp.touchStart(2,64);
  arp.service({ nowMs: 1000, audioTime: 1, bpm: 120 });
  writes.length = 0;
  arp.service({ nowMs: 1400, audioTime: 1.4, bpm: 120 });
  expect(writes.length).toBeGreaterThan(0);
  expect(new Set(writes).size, 'catch-up attacks need distinct times or explicit skip').toBe(writes.length);
});

it('R08 leaving ARP cancels future arp pitches before reasserting held voices', async () => {
  const r = await rig({ keys_arp_on: 1, keys_arp_div: 3 });
  r.sim.send([0x90,1,100]); r.sim.send([0x90,5,100]); // C2/E2, direct lanes 0/1
  r.tick(1000); r.tick(1500); // second arp step: E2 scheduled 25 ms ahead on lane 0
  r.handle.setParam!('keys_arp_on', 0);
  const pitch = (r.handle.outputs.get('keys_poly')!.node as unknown as Merger).inputs.get(0)!.offset;
  expect(pitch.at(1.5)).toBe(-2); // restored C2
  expect(pitch.at(1.6), 'old future E2 automation must not retune the restored C2 voice').toBe(-2);
});

it('R09 real wire bytes: Z, Y and velocity of the finger on lane k land on lane k\'s jacks and nowhere else; the lift clears pressure only', async () => {
  const r = await rig();
  const jack = (id: string) => (r.handle.outputs.get(id)!.node as unknown as Constant).offset;
  r.sim.send([0x90, 1, 100]); // wire col 1 = app col 0, row 0 → keys lane 0, velocity 100
  r.sim.send([0x90, 2, 60]); // lane 1
  expect(jack('keys_vel1').at(2)).toBeCloseTo(100 / 127);
  expect(jack('keys_vel2').at(2)).toBeCloseTo(60 / 127);
  expect(jack('keys_press1').at(2)).toBe(0);
  expect(jack('keys_timbre1').at(2)).toBe(0);
  const lane1Writes = jack('keys_press2').events.length + jack('keys_timbre2').events.length;
  const padWrites = jack('pad_press1').events.length;
  r.sim.send([0xa0, 1, 100]); // poly pressure = Z on the row channel, keyed by cell
  r.sim.send([0xb0, 1 + 64, 127]); // CC (wire col + 64) = Y → timbre 1 → jack +1
  expect(jack('keys_press1').at(2)).toBeCloseTo(100 / 127);
  expect(jack('keys_timbre1').at(2)).toBe(1);
  // …and CC 74's REST BYTE, off the real wire, is EXACTLY 0 on the jack — the
  // docs' "an unpatched jack and a resting finger read alike" (2026-09-15
  // review minor: `2·t − 1` centred on y 63.5 and left byte 64 at +0.0079).
  r.sim.send([0xb0, 1 + 64, 64]);
  expect(jack('keys_timbre1').at(2)).toBe(0);
  r.sim.send([0xb0, 1 + 64, 127]); // back up, for the retention check below
  expect(jack('keys_press2').events.length + jack('keys_timbre2').events.length, 'lane 1\'s jacks saw nothing of lane 0\'s finger').toBe(lane1Writes);
  expect(jack('keys_press2').at(2)).toBe(0);
  expect(jack('keys_timbre2').at(2)).toBe(0);
  expect(jack('pad_press1').events.length, 'the pad bus is untouched').toBe(padWrites);
  r.sim.send([0x80, 1, 0]);
  expect(jack('keys_press1').at(2)).toBe(0);
  expect(jack('keys_vel1').at(2), 'velocity retained until the lane is reassigned').toBeCloseTo(100 / 127);
  expect(jack('keys_timbre1').at(2), 'timbre retained').toBe(1);
  expect(r.api.state().active.keys).toBe(1);
});
