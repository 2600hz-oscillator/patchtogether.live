// packages/web/src/lib/electra/autoconfig.test.ts
//
// Drives the orchestrator against a fake broker + fake host: assert that a
// generated control's inbound CC writes the right param, meters/banners are
// app→device only (inbound ignored), tap notes converge BPM via the helper, and
// an external-clock edge greys the tap path.
import { describe, it, expect } from 'vitest';
import { ElectraAutoconfig, type AutoconfigHost } from './autoconfig';
import { ElectraBroker, type MidiFullAccessLike } from './broker';
import type { MidiOutputLike } from '$lib/audio/modules/midi-out-buddy';
import type { MidiInputLike, MidiEventLike } from '$lib/audio/modules/midi-cv-buddy';
import type { GenParamDef } from './preset';

function makeFakeBroker() {
  const sentCtrl: number[][] = [];
  const sentPlay: number[][] = [];
  let handler: ((ev: MidiEventLike) => void) | null = null;
  const ctrlOut: MidiOutputLike = {
    id: 'c', name: 'Electra CTRL', state: 'connected',
    send: (d) => sentCtrl.push([...(d as number[] | Uint8Array)]),
  };
  const playOut: MidiOutputLike = {
    id: 'p', name: 'Electra Port 1 PLAY', state: 'connected',
    send: (d) => sentPlay.push([...(d as number[] | Uint8Array)]),
  };
  const input: MidiInputLike = {
    id: 'i', name: 'Electra CTRL', state: 'connected',
    get onmidimessage() { return handler; },
    set onmidimessage(h) { handler = h; },
  };
  const access: MidiFullAccessLike = {
    inputs: new Map([[input.id, input]]),
    outputs: new Map([[ctrlOut.id, ctrlOut], [playOut.id, playOut]]),
    onstatechange: null,
  };
  const broker = new ElectraBroker();
  broker.__test_setAccess(access);
  return {
    broker, sentCtrl, sentPlay,
    emit: (data: number[]) => handler?.({ data: Uint8Array.from(data), timeStamp: 0 }),
  };
}

const defs: Record<string, GenParamDef> = {
  'osc1:level': { id: 'level', label: 'Lvl', min: 0, max: 1, defaultValue: 0.5, curve: 'linear' },
};

function makeHost(over: Partial<AutoconfigHost> = {}): {
  host: AutoconfigHost; writes: Array<[string, string, number]>; external: { value: boolean };
} {
  const writes: Array<[string, string, number]> = [];
  const external = { value: false };
  const host: AutoconfigHost = {
    buildGenInput: () => ({
      surfaceBindings: [{ moduleId: 'osc1', paramId: 'level' }],
      moduleLabel: (id) => id,
      resolveParamDef: (m, p) => defs[`${m}:${p}`] ?? null,
      mixmstrsId: 'mx',
      timelordeId: 'tl',
      name: 'patchtogether',
    }),
    readParamValue: () => undefined,
    readMeterAmp: () => 0,
    writeParam: (m, p, v) => writes.push([m, p, v]),
    hasExternalClock: () => external.value,
    luaSource: () => '-- lua',
    bannerText: () => 'INT 120',
    ...over,
  };
  return { host, writes, external };
}

describe('ElectraAutoconfig.run', () => {
  it('uploads preset + Lua, sets banner, switches to page 1', async () => {
    const fake = makeFakeBroker();
    const { host } = makeHost();
    const auto = new ElectraAutoconfig(host, fake.broker, { identifyTimeoutMs: 20 });
    const res = await auto.run();
    auto.stop();
    expect(res.ok).toBe(true);
    // Preset upload (01 01) + Lua upload (01 0C) both went out on CTRL.
    const cmds = fake.sentCtrl.filter((m) => m[0] === 0xf0).map((m) => `${m[4]} ${m[5]}`);
    expect(cmds).toContain('1 1'); // preset
    expect(cmds).toContain('1 12'); // lua (0x0c)
    expect(cmds).toContain('9 10'); // page switch (0x09 0x0a) to page 1
  });
});

describe('inbound dispatch', () => {
  it('a writable control CC writes the right param (curve-aware)', async () => {
    const fake = makeFakeBroker();
    const { host, writes } = makeHost();
    const auto = new ElectraAutoconfig(host, fake.broker, { identifyTimeoutMs: 20 });
    await auto.run();
    // osc1:level is the first CONTROL-page cc7 (number 0). Send cc 0 = 127.
    fake.emit([0xb0, 0, 127]);
    auto.stop();
    expect(writes).toContainEqual(['osc1', 'level', 1]); // 127 → 1.0 linear
  });

  it('ignores inbound CC for a meter (app→device only)', async () => {
    const fake = makeFakeBroker();
    const { host, writes } = makeHost();
    const auto = new ElectraAutoconfig(host, fake.broker, { identifyTimeoutMs: 20 });
    await auto.run();
    const meterAlloc = auto.allocations.find((a) => a.role === 'meter')!;
    fake.emit([0xb0, meterAlloc.number, 100]);
    auto.stop();
    // No param write for a meter CC.
    expect(writes.some((w) => w[1].startsWith('meter'))).toBe(false);
  });
});

describe('tap-tempo routing', () => {
  it('tap notes converge BPM and write internal bpm', async () => {
    const fake = makeFakeBroker();
    const { host, writes } = makeHost();
    const auto = new ElectraAutoconfig(host, fake.broker, { identifyTimeoutMs: 20 });
    await auto.run();
    const tapAlloc = auto.allocations.find((a) => a.role === 'tap')!;
    auto.handleTapNote(tapAlloc.number, 0);
    auto.handleTapNote(tapAlloc.number, 500); // 120 BPM
    auto.handleTapNote(tapAlloc.number, 1000);
    auto.stop();
    const bpmWrites = writes.filter((w) => w[1] === 'bpm');
    expect(bpmWrites.length).toBeGreaterThan(0);
    expect(bpmWrites[bpmWrites.length - 1]![2]).toBeCloseTo(120, 0);
  });

  it('external clock greys the tap path — taps are inert', async () => {
    const fake = makeFakeBroker();
    const { host, writes, external } = makeHost();
    external.value = true; // EXT mode
    const auto = new ElectraAutoconfig(host, fake.broker, { identifyTimeoutMs: 20 });
    await auto.run();
    const tapAlloc = auto.allocations.find((a) => a.role === 'tap')!;
    auto.handleTapNote(tapAlloc.number, 0);
    auto.handleTapNote(tapAlloc.number, 500);
    auto.stop();
    expect(writes.filter((w) => w[1] === 'bpm')).toHaveLength(0);
  });

  it('pushBanner gates the tap pad in EXT mode via Lua', async () => {
    const fake = makeFakeBroker();
    const { host, external } = makeHost();
    external.value = true;
    const auto = new ElectraAutoconfig(host, fake.broker, { identifyTimeoutMs: 20 });
    await auto.run();
    auto.stop();
    // An Execute-Lua (08 0D) pt_setExternal(true) went out.
    const luaExecs = fake.sentCtrl.filter((m) => m[4] === 0x08 && m[5] === 0x0d);
    const decoded = luaExecs.map((m) =>
      String.fromCharCode(...m.slice(6, m.length - 1)),
    );
    expect(decoded.some((s) => s.includes('pt_setExternal(true)'))).toBe(true);
  });
});
