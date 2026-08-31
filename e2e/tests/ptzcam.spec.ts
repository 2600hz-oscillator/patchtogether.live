// e2e/tests/ptzcam.spec.ts
//
// ════════════ THE BYTES-ON-THE-WIRE GATE FOR THE PTZ CAMERA MODULE ════════════
//
// Same argument as chromaconsole.spec.ts: the poly/MIDI rule demands the REAL
// source chain asserted at the far end, and for a MIDI sink the far end is
// bytes on the port, not audible RMS. A REAL default-mode LFO is patched into
// pan_cv and the assertions decode the sysex frames the app put on fake
// PT-PTZ-* outputs — graph → CV tap → scheduler tick → planner → sysex,
// nothing driven directly.
//
// v2 protocol: two capture fixtures, both byte-for-byte from the multicam
// helper on real hardware (2026-08-29) — the all-absolute NexiGo P610 and the
// velocity-pan/tilt Logitech PTZ Pro 2. The val35/frame constants are
// RE-DERIVED literally in this file on purpose: importing them from ptz-sysex
// would make the spec agree with the encoder by construction.

import { test, expect } from './_fixtures';
import { type Page } from '@playwright/test';
import { spawnPatch, type SpawnEdge, type SpawnNode } from './_helpers';
import {
  installMidiIoCapture,
  injectMidiIn,
  readMidiOutCaptured,
  clearMidiOutCaptured,
} from '../_helpers/midi';

test.describe.configure({ mode: 'parallel' });

const TYPE = 'ptzcam';
const NODE = 'm';

const NEXIGO_OUT = { id: 'ptz-a', name: 'PT-PTZ-NEXIGOP6' };
const NEXIGO_IN = { id: 'ptz-a-in', name: 'PT-PTZ-NEXIGOP6' };
const LOGI_OUT = { id: 'ptz-b', name: 'PT-PTZ-PTZPRO2' };
const LOGI_IN = { id: 'ptz-b-in', name: 'PT-PTZ-PTZPRO2' };
const DECOY_OUT = { id: 'other-0', name: 'Prophet Rev2' };
const DECOY_IN = { id: 'other-in-0', name: 'Prophet Rev2' };

const CAPS_REQUEST = [0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x02, 0x01, 0xf7];
const CMD_SET_ABS = 0x02;
const CMD_SET_VEL = 0x03;

// NexiGo P610 — all three axes ABSOLUTE (pan ±612000, tilt −108000..324000,
// zoom 0..3040).
const HW_CAPS_NEXIGO = [
  0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x02, 0x41, 0x03,
  0x01, 0x01, 0x60, 0x52, 0x5a, 0x7f, 0x7f, 0x20, 0x2d, 0x25, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x10, 0x7d, 0x01, 0x00, 0x00,
  0x02, 0x01, 0x20, 0x34, 0x79, 0x7f, 0x7f, 0x20, 0x63, 0x13, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x70, 0x5c, 0x7e, 0x7f, 0x7f,
  0x03, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x60, 0x17, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x3e, 0x05, 0x00, 0x00, 0x00,
  0xf7,
];

// Logitech PTZ Pro 2 — pan/tilt VELOCITY at fixed speed 1..1, zoom ABSOLUTE
// 100..1000.
const HW_CAPS_LOGI = [
  0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x02, 0x41, 0x03,
  0x01, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00,
  0x02, 0x02, 0x01, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00,
  0x03, 0x01, 0x64, 0x00, 0x00, 0x00, 0x00, 0x68, 0x07, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x00, 0x00, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00,
  0xf7,
];

const CAMERA_ABSENT_FRAME = [
  0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x02, 0x42, 0x01,
  ...[...'camera-absent'].map((c) => c.charCodeAt(0)),
  0xf7,
];

const PAN_MIN = -612000;
const PAN_MAX = 612000;

/** Literal val35 decode (5 × 7-bit groups, LSB first, two's complement). */
function decodeVal35(bytes: number[], offset: number): number {
  let u = 0;
  for (let i = 0; i < 5; i++) u += (bytes[offset + i]! & 0x7f) * 128 ** i;
  return u >= 2 ** 34 ? u - 2 ** 35 : u;
}

/** ctl+val frames (SET_ABS or SET_VEL) for one control on one port capture. */
function ctlValues(frames: { bytes: number[] }[], cmd: number, control: number): number[] {
  return frames
    .filter(
      (f) =>
        f.bytes.length === 14 &&
        f.bytes[0] === 0xf0 &&
        f.bytes[1] === 0x7d &&
        f.bytes[6] === cmd &&
        f.bytes[7] === control,
    )
    .map((f) => decodeVal35(f.bytes, 8));
}

async function boot(
  page: Page,
  opts: { ports?: boolean; lfo?: boolean; nodes?: SpawnNode[] } = {},
): Promise<void> {
  const withPorts = opts.ports ?? true;
  await installMidiIoCapture(
    page,
    withPorts ? [DECOY_OUT, NEXIGO_OUT, LOGI_OUT] : [DECOY_OUT],
    withPorts ? [DECOY_IN, NEXIGO_IN, LOGI_IN] : [DECOY_IN],
  );
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  const nodes: SpawnNode[] = opts.nodes ?? [{ id: NODE, type: TYPE, position: { x: 400, y: 200 } }];
  const edges: SpawnEdge[] = [];
  if (opts.lfo) {
    nodes.push({ id: 'lfo', type: 'lfo', position: { x: 60, y: 200 } });
    edges.push({
      id: 'e-pan',
      from: { nodeId: 'lfo', portId: 'phase0' },
      to: { nodeId: NODE, portId: 'pan_cv' },
      sourceType: 'cv',
      targetType: 'cv',
    });
  }
  await spawnPatch(page, nodes, edges);
  await expect(page.locator(`.svelte-flow__node-${TYPE}`).first()).toBeVisible();
}

async function waitCapsRequest(page: Page, portId: string): Promise<void> {
  await page.waitForFunction(
    ({ want, portId }) => {
      const sent =
        (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
          .__midiOutSentDetailed ?? [];
      return sent.some((m) => m.portId === portId && m.bytes.join(',') === want.join(','));
    },
    { want: CAPS_REQUEST, portId },
    { timeout: 10_000 },
  );
}

/** Count value-carrying frames (SET_ABS/SET_VEL) on a port, page-side. */
function countCtlFramesScript(portId: string, cmd: number, control: number): string {
  return `(() => {
    const sent = window.__midiOutSentDetailed ?? [];
    return sent.filter((m) => m.portId === ${JSON.stringify(portId)} &&
      m.bytes[6] === ${cmd} && m.bytes[7] === ${control}).length;
  })()`;
}

/** Click the real Connect button, pick a camera in the real dropdown, complete
 *  the handshake with the hardware-captured reply for that camera. */
async function connectAndBind(
  page: Page,
  cam: { out: { id: string; name: string }; in: { id: string }; reply: number[] },
  nodeId = NODE,
): Promise<void> {
  // The engine handle materializes after the node mounts; wait for it so the
  // Connect click and the port pick always land on a live card-api (the card
  // survives an early click too, but the SELECT below needs listPorts()).
  await expect
    .poll(
      () =>
        page.evaluate((n) => {
          const w = globalThis as unknown as {
            __engine?: () => { read: (x: unknown, k: string) => unknown } | null;
            __patch: { nodes: Record<string, unknown> };
          };
          const eng = w.__engine?.();
          const node = w.__patch.nodes[n];
          return !!(eng && node && eng.read(node, 'card-api'));
        }, nodeId),
      { timeout: 15_000 },
    )
    .toBe(true);
  const card = page.locator(`[data-testid="ptzcam-card-${nodeId}"]`);
  const connect = card.getByTestId(`ptzcam-connect-${nodeId}`);
  if ((await connect.count()) > 0) await connect.click();
  await expect(
    card.getByTestId(`ptzcam-port-${nodeId}`).locator(`option[value="${cam.out.name}"]`),
  ).toHaveCount(1);
  await card.getByTestId(`ptzcam-port-${nodeId}`).selectOption(cam.out.name);
  await waitCapsRequest(page, cam.out.id);
  expect(await injectMidiIn(page, cam.in.id, cam.reply)).toBe(true);
  await expect(card.getByTestId(`ptzcam-status-${nodeId}`)).toContainText('Bound');
  // The first bound tick asserts the whole position (all planned axes). Wait
  // for a zoom frame — both fixtures have absolute zoom — so callers that
  // clear-then-write exercise the steady state, not the initial assert.
  await page.waitForFunction(countCtlFramesScript(cam.out.id, CMD_SET_ABS, 0x03) + ' >= 1');
}

const NEXIGO = { out: NEXIGO_OUT, in: NEXIGO_IN, reply: HW_CAPS_NEXIGO };
const LOGI = { out: LOGI_OUT, in: LOGI_IN, reply: HW_CAPS_LOGI };

async function readState(page: Page): Promise<{ ticks: number; sentFrames: number } | null> {
  return page.evaluate((nodeId) => {
    const w = globalThis as unknown as {
      __engine?: () => { read: (n: unknown, k: string) => unknown } | null;
      __patch: { nodes: Record<string, unknown> };
    };
    const eng = w.__engine?.();
    const node = w.__patch.nodes[nodeId];
    if (!eng || !node) return null;
    return (eng.read(node, 'state') as { ticks: number; sentFrames: number }) ?? null;
  }, NODE);
}

/** Write a param through the REAL Y.Doc mutation path — the same write a knob
 *  drag performs, never engine.setParam (the POLYHELM shortcut). */
async function writeParam(page: Page, param: string, value: number, nodeId = NODE): Promise<void> {
  await page.evaluate(
    ({ nodeId, param, v }) => {
      const w = globalThis as unknown as {
        __patch: { nodes: Record<string, { params: Record<string, number> }> };
        __ydoc: { transact: (fn: () => void) => void };
      };
      w.__ydoc.transact(() => {
        const n = w.__patch.nodes[nodeId];
        if (n) n.params[param] = v;
      });
    },
    { nodeId, param, v: value },
  );
}

/** Wait for the module's send loop to have run `n` more scheduler ticks — the
 *  frames-not-ms anchor for every "nothing was sent" negative below. */
async function waitTicks(page: Page, n: number): Promise<void> {
  const before = (await readState(page))?.ticks ?? 0;
  await expect
    .poll(async () => (await readState(page))?.ticks ?? 0, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(before + n);
}

test('ptzcam: capture instrument negative control — buffer EXISTS and is empty before connect', async ({
  page,
}) => {
  await boot(page);
  await waitTicks(page, 8);
  const captured = await page.evaluate(
    () => (window as unknown as { __midiOutSent?: number[][] }).__midiOutSent,
  );
  expect(captured, 'the mock is installed (undefined would mean it never was)').toBeDefined();
  expect(captured, 'unbound module sends nothing').toEqual([]);
  expect((await readState(page))?.sentFrames).toBe(0);
});

test('ptzcam: connect + camera pick binds ONE pair, handshakes caps, and ignores the decoy', async ({
  page,
}) => {
  await boot(page);
  await connectAndBind(page, NEXIGO);
  const card = page.locator(`[data-testid="ptzcam-card-${NODE}"]`);
  await expect(card.getByTestId(`ptzcam-connect-${NODE}`)).toHaveCount(0);
  await expect(card.getByTestId(`ptzcam-modes-${NODE}`)).toHaveText('pan abs · tilt abs · zoom abs');
  // On bind the whole position is asserted once: pan, tilt AND zoom frames.
  await page.waitForFunction(() => {
    const sent =
      (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
        .__midiOutSentDetailed ?? [];
    const abs = sent.filter((m) => m.portId === 'ptz-a' && m.bytes[6] === 0x02);
    return new Set(abs.map((m) => m.bytes[7])).size === 3;
  });
  expect(await readMidiOutCaptured(page, DECOY_OUT.id), 'nothing may reach the decoy').toEqual([]);
});

test('ptzcam: REAL CHAIN (absolute axis) — an LFO on pan_cv reaches the wire as changing pan SET_ABS frames', async ({
  page,
  errorWatch,
}) => {
  test.setTimeout(60_000);
  await boot(page, { lfo: true });
  await writeParam(page, 'slew', 1); // instant — the LFO, not the glide, is the subject
  await connectAndBind(page, NEXIGO);
  await clearMidiOutCaptured(page);

  await page.waitForFunction(countCtlFramesScript(NEXIGO_OUT.id, CMD_SET_ABS, 0x01) + ' >= 6', undefined, {
    timeout: 30_000,
  });

  const pans = ctlValues(await readMidiOutCaptured(page, NEXIGO_OUT.id), CMD_SET_ABS, 0x01);
  expect(pans.length).toBeGreaterThanOrEqual(6);
  expect(new Set(pans).size, 'the LFO must MOVE the pan, not repeat one value').toBeGreaterThanOrEqual(3);
  for (const v of pans) {
    expect(v, `pan device units within the caps range (got ${v})`).toBeGreaterThanOrEqual(PAN_MIN);
    expect(v).toBeLessThanOrEqual(PAN_MAX);
  }
  void errorWatch;
});

test('ptzcam: REAL CHAIN (velocity axis) — the LFO drives direction, keepalive repeats, and zero is an explicit stop', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await boot(page, { lfo: true });
  await connectAndBind(page, LOGI);
  await clearMidiOutCaptured(page);

  // A full default-rate LFO cycle swings past the deadzone in both directions.
  // The ZERO is asserted separately below by COMMANDING a stop: waiting for a
  // sampled instant to land inside the ±deadzone window would alias — a 10 Hz
  // sampler phase-locked to a 1 Hz LFO can systematically miss it (the
  // co-prime-sampling hazard).
  await page.waitForFunction(
    () => {
      const sent =
        (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
          .__midiOutSentDetailed ?? [];
      const vals = sent
        .filter((m) => m.portId === 'ptz-b' && m.bytes[6] === 0x03 && m.bytes[7] === 0x01)
        .map((m) => {
          let u = 0;
          for (let i = 0; i < 5; i++) u += (m.bytes[8 + i]! & 0x7f) * 128 ** i;
          return u >= 2 ** 34 ? u - 2 ** 35 : u;
        });
      return vals.includes(1) && vals.includes(-1);
    },
    undefined,
    { timeout: 30_000 },
  );
  // KEEPALIVE, load-independently: hold a CONSTANT nonzero velocity (kill the
  // LFO, pin the knob) and wait for the +1 frame count to GROW by 3 — proving
  // the unchanged value is re-sent every plan tick. Counting repeats inside
  // one LFO half-cycle instead assumed a healthy tick rate and failed both
  // attempts under CI load (measured, shard 1).
  await writeParam(page, 'depth', 0, 'lfo');
  await writeParam(page, 'pan', 1);
  const before = await page.evaluate(
    () => {
      const sent =
        (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
          .__midiOutSentDetailed ?? [];
      return sent.filter((m) => m.portId === 'ptz-b' && m.bytes[6] === 0x03 && m.bytes[7] === 0x01)
        .length;
    },
  );
  await page.waitForFunction(
    (want) => {
      const sent =
        (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
          .__midiOutSentDetailed ?? [];
      return (
        sent.filter((m) => m.portId === 'ptz-b' && m.bytes[6] === 0x03 && m.bytes[7] === 0x01)
          .length >= want
      );
    },
    before + 3,
    { timeout: 30_000 },
  );
  // Release the knob → the target falls inside the deadzone → the module must
  // emit the EXPLICIT stop (value 0), never just fall silent.
  await writeParam(page, 'pan', 0);
  await page.waitForFunction(
    () => {
      const sent =
        (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
          .__midiOutSentDetailed ?? [];
      const pans = sent.filter(
        (m) => m.portId === 'ptz-b' && m.bytes[6] === 0x03 && m.bytes[7] === 0x01,
      );
      if (pans.length === 0) return false;
      const last = pans[pans.length - 1]!.bytes;
      let u = 0;
      for (let i = 0; i < 5; i++) u += (last[8 + i]! & 0x7f) * 128 ** i;
      return (u >= 2 ** 34 ? u - 2 ** 35 : u) === 0;
    },
    undefined,
    { timeout: 15_000 },
  );

  const vels = ctlValues(await readMidiOutCaptured(page, LOGI_OUT.id), CMD_SET_VEL, 0x01);
  // The degenerate 1..1 speed range must collapse to exactly {-1, 0, +1}, and
  // the commanded stop above guarantees all three appear.
  expect(new Set(vels.map((v) => Math.sign(v))).size).toBe(3);
  for (const v of vels) expect([-1, 0, 1]).toContain(v);
  // Keepalive already proven by the held-velocity growth wait above.
  // Nothing velocity-shaped may reach the absolute-mode camera's port.
  expect(ctlValues(await readMidiOutCaptured(page, NEXIGO_OUT.id), CMD_SET_VEL, 0x01)).toEqual([]);
});

test('ptzcam: TWO modules on TWO cameras stay isolated port-for-port', async ({ page }) => {
  test.setTimeout(60_000);
  await boot(page, {
    nodes: [
      // The 260px card overflows its 2hp node box, so horizontal neighbours
      // ALWAYS overlap and the selected node's overflow intercepts the other
      // card's buttons. Stack vertically with a full card-height gap.
      { id: 'm', type: TYPE, position: { x: 200, y: 60 } },
      { id: 'm2', type: TYPE, position: { x: 200, y: 700 } },
    ],
  });
  await connectAndBind(page, NEXIGO, 'm');
  // Deselect m first — a selected node's overflowing card sits above its
  // neighbour in the stacking order and can swallow its clicks.
  await page.locator('.svelte-flow__pane:visible').first().click({ position: { x: 30, y: 30 } });
  await connectAndBind(page, LOGI, 'm2');
  await clearMidiOutCaptured(page);

  await writeParam(page, 'pan', 0.5, 'm');
  await page.waitForFunction(countCtlFramesScript(NEXIGO_OUT.id, CMD_SET_ABS, 0x01) + ' >= 1');

  const aVel = ctlValues(await readMidiOutCaptured(page, NEXIGO_OUT.id), CMD_SET_VEL, 0x01);
  expect(aVel, 'no velocity frames on the absolute camera').toEqual([]);
  const bAbsPan = ctlValues(await readMidiOutCaptured(page, LOGI_OUT.id), CMD_SET_ABS, 0x01);
  expect(bAbsPan, "m's knob write must not leak onto m2's camera").toEqual([]);
});

test('ptzcam: a pan knob write glides (slew) and lands on the exact mapped device value', async ({
  page,
}) => {
  await boot(page);
  await connectAndBind(page, NEXIGO);
  await clearMidiOutCaptured(page);

  // norm 0.5 → min + (0.5+1)/2 × (max−min) = 306000 on the measured range.
  await writeParam(page, 'pan', 0.5);
  await page.waitForFunction(
    () => {
      const sent =
        (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
          .__midiOutSentDetailed ?? [];
      const pans = sent.filter(
        (m) => m.portId === 'ptz-a' && m.bytes[6] === 0x02 && m.bytes[7] === 0x01,
      );
      if (pans.length === 0) return false;
      const last = pans[pans.length - 1]!.bytes;
      let u = 0;
      for (let i = 0; i < 5; i++) u += (last[8 + i]! & 0x7f) * 128 ** i;
      const v = u >= 2 ** 34 ? u - 2 ** 35 : u;
      return v === 306000;
    },
    undefined,
    { timeout: 20_000 },
  );

  const pans = ctlValues(await readMidiOutCaptured(page, NEXIGO_OUT.id), CMD_SET_ABS, 0x01);
  expect(pans[pans.length - 1]).toBe(306000);
  expect(pans.length, 'default slew streams intermediate positions, not one jump').toBeGreaterThan(1);
  for (let i = 1; i < pans.length; i++) {
    expect(pans[i]!, 'the glide is monotonic toward the target').toBeGreaterThan(pans[i - 1]!);
  }
});

test('ptzcam: with NO PT-PTZ port, connect explains the NO and nothing is ever sent', async ({
  page,
}) => {
  await boot(page, { ports: false });
  await page
    .locator(`[data-testid="ptzcam-card-${NODE}"]`)
    .getByTestId(`ptzcam-connect-${NODE}`)
    .click();
  await expect(
    page.locator(`[data-testid="ptzcam-card-${NODE}"]`).getByTestId(`ptzcam-status-${NODE}`),
  ).toContainText('No MIDI port named PT-PTZ');

  await writeParam(page, 'pan', 0.7);
  await waitTicks(page, 12);
  expect(await readMidiOutCaptured(page), 'silence beats sysex into the wrong device').toEqual([]);
  expect((await readState(page))?.sentFrames).toBe(0);
});

test('ptzcam: a camera-absent error frame surfaces on the card and halts sends', async ({
  page,
}) => {
  await boot(page);
  await connectAndBind(page, NEXIGO);
  expect(await injectMidiIn(page, NEXIGO_IN.id, CAMERA_ABSENT_FRAME)).toBe(true);
  const status = page
    .locator(`[data-testid="ptzcam-card-${NODE}"]`)
    .getByTestId(`ptzcam-status-${NODE}`);
  await expect(status).toContainText('camera is absent');
  await expect(status).toHaveRole('alert');

  await clearMidiOutCaptured(page);
  await writeParam(page, 'pan', -0.5);
  await waitTicks(page, 12);
  expect(
    await readMidiOutCaptured(page, NEXIGO_OUT.id),
    'no sends against an absent camera',
  ).toEqual([]);
});
