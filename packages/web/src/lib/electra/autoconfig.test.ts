// packages/web/src/lib/electra/autoconfig.test.ts
//
// Drives the orchestrator against a fake broker + fake host: assert that a
// generated control's inbound CC writes the right param, meters/banners are
// app→device only (inbound ignored), tap notes converge BPM via the helper, an
// external-clock edge greys the tap path, and the 30Hz per-channel VU meter
// stream emits the right meter CCs (the MIXMASTER meter view wiring).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ElectraAutoconfig, type AutoconfigHost } from './autoconfig';
import { ElectraBroker, type MidiFullAccessLike } from './broker';
import type { MidiOutputLike } from '$lib/audio/modules/midi-out-buddy';
import type { MidiInputLike, MidiEventLike } from '$lib/audio/modules/midi-cv-buddy';
import type { GenParamDef } from './preset';
import { ampToMeterCc } from './curve';

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

describe('button routing (WORKSTREAM B)', () => {
  /** Host whose surface has ONE momentary + ONE toggle button (no continuous
   *  controls), with a triggerButton spy. */
  function makeButtonHost(): {
    host: AutoconfigHost;
    triggers: Array<[string, string, boolean]>;
  } {
    const triggers: Array<[string, string, boolean]> = [];
    const host: AutoconfigHost = {
      buildGenInput: () => ({
        surfaceBindings: [
          { moduleId: 'hydrogen', paramId: 'play', controlType: 'button', momentary: true },
          { moduleId: 'score', paramId: 'play', controlType: 'button', momentary: false },
        ],
        moduleLabel: (id) => id,
        resolveParamDef: () => null,
        mixmstrsId: null,
        timelordeId: null,
        name: 'patchtogether',
      }),
      readParamValue: () => undefined,
      readMeterAmp: () => 0,
      writeParam: () => {},
      hasExternalClock: () => false,
      luaSource: () => '-- lua',
      triggerButton: (m, p, high) => triggers.push([m, p, high]),
    };
    return { host, triggers };
  }

  it('a momentary button NOTE on/off fires triggerButton on BOTH edges', async () => {
    const fake = makeFakeBroker();
    const { host, triggers } = makeButtonHost();
    const auto = new ElectraAutoconfig(host, fake.broker, { identifyTimeoutMs: 20 });
    await auto.run();
    const a = auto.allocations.find((x) => x.role === 'button-momentary')!;
    expect(a.key).toBe('hydrogen:play');
    fake.emit([0x90, a.number, 100]); // NOTE-on
    fake.emit([0x80, a.number, 0]);   // NOTE-off
    auto.stop();
    expect(triggers).toEqual([
      ['hydrogen', 'play', true],
      ['hydrogen', 'play', false],
    ]);
  });

  it('a toggle button CC fires triggerButton on the rising edge only', async () => {
    const fake = makeFakeBroker();
    const { host, triggers } = makeButtonHost();
    const auto = new ElectraAutoconfig(host, fake.broker, { identifyTimeoutMs: 20 });
    await auto.run();
    const a = auto.allocations.find((x) => x.role === 'button-toggle')!;
    expect(a.key).toBe('score:play');
    fake.emit([0xb0, a.number, 127]); // press → rising edge fires
    fake.emit([0xb0, a.number, 0]);   // release → ignored
    auto.stop();
    expect(triggers).toEqual([['score', 'play', true]]);
  });

  it('a toggle button does NOT writeParam (it pulses the button action, not a raw param)', async () => {
    const fake = makeFakeBroker();
    const writes: Array<[string, string, number]> = [];
    const { host } = makeButtonHost();
    host.writeParam = (m, p, v) => writes.push([m, p, v]);
    const auto = new ElectraAutoconfig(host, fake.broker, { identifyTimeoutMs: 20 });
    await auto.run();
    const a = auto.allocations.find((x) => x.role === 'button-toggle')!;
    fake.emit([0xb0, a.number, 127]);
    auto.stop();
    expect(writes).toHaveLength(0);
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

// ─────────────────────────────────────────────────────────────────────────
// MIXMASTER meter view — the per-channel VU feedback stream. The orchestrator
// starts a FeedbackPump that, on every ~33ms tick, reads each channel's level
// (host.readMeterAmp('mx:meter:N') → engine.read(mx,'levels')[N-1]) and sends a
// dBFS-mapped meter CC on CTRL to the read-only meter controls. These tests
// drive that pump on a fake clock and assert the right meter CCs land — the
// channel-VU half of View 2 now has data (post-fader Faust taps in mixmstrs).
// ─────────────────────────────────────────────────────────────────────────

/** Parse a plain CC message [0xB0|ch, cc, val] from a captured CTRL send. */
function asCc(m: number[]): { cc: number; value: number } | null {
  if (m.length === 3 && (m[0]! & 0xf0) === 0xb0) return { cc: m[1]!, value: m[2]! };
  return null;
}

describe('MIXMASTER meter feedback stream', () => {
  afterEach(() => vi.useRealTimers());

  it('streams per-channel + master meter CCs (dBFS-mapped) on the CTRL port at 30Hz', async () => {
    vi.useFakeTimers();
    const fake = makeFakeBroker();
    // Per-channel post-fader levels the engine would report via read('levels'),
    // plus a master level. Distinct + ordered so we can assert ordering/scale.
    const amps: Record<string, number> = {
      'mx:meter:1': 0.1,
      'mx:meter:2': 0.25,
      'mx:meter:3': 0.5,
      'mx:meter:4': 0.7,
      'mx:meter:5': 0.85,
      'mx:meter:6': 1.0,
      'mx:meter:master': 0.5,
    };
    const { host } = makeHost({ readMeterAmp: (k) => amps[k] });
    const auto = new ElectraAutoconfig(host, fake.broker, { identifyTimeoutMs: 0 });
    const runP = auto.run();
    await vi.advanceTimersByTimeAsync(1); // fire identify's 0ms timeout
    await runP;

    // Drain the upload/banner/page CCs sent during run(), isolate the pump.
    fake.sentCtrl.length = 0;
    // One pump tick (33ms = ~30Hz).
    await vi.advanceTimersByTimeAsync(34);
    auto.stop();

    const meters = auto.allocations.filter((a) => a.role === 'meter');
    expect(meters.length).toBe(7); // master + 6 channels
    const ccs = fake.sentCtrl.map(asCc).filter((x): x is { cc: number; value: number } => !!x);
    const byNum = new Map(ccs.map((c) => [c.cc, c.value]));

    for (const m of meters) {
      const expected = ampToMeterCc(amps[m.key]!);
      expect(byNum.get(m.number), `meter ${m.key} (cc ${m.number})`).toBe(expected);
    }
    // Louder channel → higher meter CC (ordering preserved end-to-end).
    const ch = (n: number) => byNum.get(meters.find((m) => m.key === `mx:meter:${n}`)!.number)!;
    expect(ch(4)).toBeGreaterThan(ch(3));
    expect(ch(3)).toBeGreaterThan(ch(2));
    expect(ch(2)).toBeGreaterThan(ch(1));
  });

  it('does not re-send an unchanged meter level (deltaed — silent channels do not spam)', async () => {
    vi.useFakeTimers();
    const fake = makeFakeBroker();
    const { host } = makeHost({ readMeterAmp: () => 0.5 }); // constant level
    const auto = new ElectraAutoconfig(host, fake.broker, { identifyTimeoutMs: 0 });
    const runP = auto.run();
    await vi.advanceTimersByTimeAsync(1); // fire identify's 0ms timeout
    await runP;
    fake.sentCtrl.length = 0;

    await vi.advanceTimersByTimeAsync(34); // tick 1 — sends each meter once
    const afterFirst = fake.sentCtrl.filter((m) => asCc(m)).length;
    expect(afterFirst).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(34); // tick 2 — same level → no resend
    const afterSecond = fake.sentCtrl.filter((m) => asCc(m)).length;
    auto.stop();
    expect(afterSecond).toBe(afterFirst);
  });
});
