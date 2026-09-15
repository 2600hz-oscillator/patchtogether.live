// Adversarial contract probes. Temporary review suite; all input is synthetic.
// Tests assert intended behavior, so confirmed defects are expected failures.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createLinnstrumentRuntime, type LinnstrumentCardApi } from '$lib/audio/modules/linnstrument-runtime';
import { createLinnArp } from '$lib/audio/modules/linnstrument-arp';
import { __resetLinnstrumentForTest, connectLinnstrument, installSimulatedLinnstrument, linnstrumentStatus, type SimulatedLinnstrument } from '$lib/midi/linnstrument-device';
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

it('R07 overlapping vertical row handoff keeps the XY pad responsive', async () => {
  const r = await rig();
  r.sim.send([0x90, 21, 100]); r.sim.send([0xb0, 85, 127]);
  r.sim.send([0x91, 21, 100]); // new row becomes down before old row releases
  r.sim.send([0x80, 21, 0]);
  const before = r.api.selection().pairs.r.y;
  r.sim.send([0xb1, 85, 100]);
  expect(r.api.selection().pairs.r.y, 'continuing vertical gesture must move after previous-row release').not.toBe(before);
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
