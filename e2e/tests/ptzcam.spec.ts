// e2e/tests/ptzcam.spec.ts
//
// ════════════ THE BYTES-ON-THE-WIRE GATE FOR THE PTZ CAMERA MODULE ════════════
//
// Same argument as chromaconsole.spec.ts: the poly/MIDI rule demands the REAL
// source chain asserted at the far end, and for a MIDI sink the far end is
// bytes on the port, not audible RMS. Here the chain is stronger than a knob:
// a REAL default-mode LFO is patched into pan_cv and the assertion decodes the
// sysex SET_ABS frames the app put on the fake PT-PTZ output — graph → CV tap
// → scheduler tick → planner → sysex, nothing driven directly.
//
// The val35/frame constants are RE-DERIVED literally in this file on purpose:
// importing them from ptz-sysex would make the spec agree with the encoder by
// construction. The caps-reply fixture is the byte-for-byte frame the native
// helper sent on real hardware (2026-08-29) — the same fixture pinned in
// ptz-sysex.test.ts, so app and helper cannot drift apart silently.

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

const PTZ_OUT = { id: 'ptz-0', name: 'PT-PTZ' };
const PTZ_IN = { id: 'ptz-in-0', name: 'PT-PTZ' };
const DECOY_OUT = { id: 'other-0', name: 'Prophet Rev2' };
const DECOY_IN = { id: 'other-in-0', name: 'Prophet Rev2' };

const CAPS_REQUEST = [0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x01, 0x01, 0xf7];

// Captured from pt-ptz on the NexiGo P610: pan −612000..612000, tilt
// −108000..324000, zoom 0..3040, res 1 throughout.
const HW_CAPS_REPLY = [
  0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x01, 0x41, 0x03,
  0x01, 0x60, 0x52, 0x5a, 0x7f, 0x7f, 0x20, 0x2d, 0x25, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x08, 0x2d, 0x7e, 0x7f, 0x7f,
  0x02, 0x20, 0x34, 0x79, 0x7f, 0x7f, 0x20, 0x63, 0x13, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x30, 0x4d, 0x7f, 0x7f, 0x7f,
  0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x60, 0x17, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xf7,
];

const CAMERA_ABSENT_FRAME = [
  0xf0, 0x7d, 0x50, 0x54, 0x5a, 0x01, 0x42, 0x01,
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

/** SET_ABS frames for one control (0x01 pan / 0x02 tilt / 0x03 zoom). */
function setAbsValues(frames: { bytes: number[] }[], control: number): number[] {
  return frames
    .filter(
      (f) =>
        f.bytes.length === 14 &&
        f.bytes[0] === 0xf0 &&
        f.bytes[1] === 0x7d &&
        f.bytes[6] === 0x02 &&
        f.bytes[7] === control,
    )
    .map((f) => decodeVal35(f.bytes, 8));
}

async function boot(
  page: Page,
  opts: { ports?: boolean; lfo?: boolean } = {},
): Promise<void> {
  const withPorts = opts.ports ?? true;
  await installMidiIoCapture(
    page,
    withPorts ? [DECOY_OUT, PTZ_OUT] : [DECOY_OUT],
    withPorts ? [DECOY_IN, PTZ_IN] : [DECOY_IN],
  );
  await page.goto('/rack?shell=legacy&seed=none');
  await page.waitForLoadState('networkidle');
  const nodes: SpawnNode[] = [{ id: NODE, type: TYPE, position: { x: 400, y: 200 } }];
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
  await expect(page.locator(`.svelte-flow__node-${TYPE}`)).toBeVisible();
}

/** Click the card's real Connect button, then complete the caps handshake by
 *  injecting the hardware-captured reply once the caps request hits the wire. */
async function connectAndBind(page: Page): Promise<void> {
  await page
    .locator(`.svelte-flow__node-${TYPE}`)
    .getByTestId(`ptzcam-connect-${NODE}`)
    .click();
  await page.waitForFunction(
    (want) => {
      const sent =
        (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
          .__midiOutSentDetailed ?? [];
      return sent.some(
        (m) => m.portId === 'ptz-0' && m.bytes.join(',') === want.join(','),
      );
    },
    CAPS_REQUEST,
    { timeout: 10_000 },
  );
  expect(await injectMidiIn(page, PTZ_IN.id, HW_CAPS_REPLY)).toBe(true);
  await expect(
    page.locator(`.svelte-flow__node-${TYPE}`).getByTestId(`ptzcam-status-${NODE}`),
  ).toContainText('Bound');
  // The first bound tick asserts the whole position (pan+tilt+zoom). Wait for
  // it so callers that clear-then-write exercise the GLIDE from an
  // established plan, not the initial jump.
  await page.waitForFunction(() => {
    const sent =
      (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
        .__midiOutSentDetailed ?? [];
    const abs = sent.filter((m) => m.portId === 'ptz-0' && m.bytes[6] === 0x02);
    return new Set(abs.map((m) => m.bytes[7])).size === 3;
  });
}

/** Read the module's observable state through the real engine handle. */
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
async function writeParam(page: Page, param: string, value: number): Promise<void> {
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
    { nodeId: NODE, param, v: value },
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

test('ptzcam: connect binds PT-PTZ by name, handshakes caps, and ignores the decoy', async ({
  page,
}) => {
  await boot(page);
  await connectAndBind(page);
  // The connect button is gone once bound.
  await expect(
    page.locator(`.svelte-flow__node-${TYPE}`).getByTestId(`ptzcam-connect-${NODE}`),
  ).toHaveCount(0);
  // On bind the whole position is asserted once: pan, tilt AND zoom frames.
  await page.waitForFunction(() => {
    const sent =
      (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
        .__midiOutSentDetailed ?? [];
    const abs = sent.filter((m) => m.portId === 'ptz-0' && m.bytes[6] === 0x02);
    return new Set(abs.map((m) => m.bytes[7])).size === 3;
  });
  const decoy = await readMidiOutCaptured(page, DECOY_OUT.id);
  expect(decoy, 'nothing may reach the decoy port').toEqual([]);
});

test('ptzcam: REAL CHAIN — a default-mode LFO on pan_cv reaches the wire as changing pan SET_ABS frames', async ({
  page,
  errorWatch,
}) => {
  test.setTimeout(60_000);
  await boot(page, { lfo: true });
  await writeParam(page, 'slew', 1); // instant — the LFO, not the glide, is the subject
  await connectAndBind(page);
  await clearMidiOutCaptured(page);

  // Enough send windows for the LFO (default 1 Hz) to show real movement.
  await page.waitForFunction(() => {
    const sent =
      (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
        .__midiOutSentDetailed ?? [];
    return (
      sent.filter((m) => m.portId === 'ptz-0' && m.bytes[6] === 0x02 && m.bytes[7] === 0x01)
        .length >= 6
    );
  }, undefined, { timeout: 30_000 });

  const frames = await readMidiOutCaptured(page, PTZ_OUT.id);
  const pans = setAbsValues(frames, 0x01);
  expect(pans.length).toBeGreaterThanOrEqual(6);
  expect(new Set(pans).size, 'the LFO must MOVE the pan, not repeat one value').toBeGreaterThanOrEqual(3);
  for (const v of pans) {
    expect(v, `pan device units within the caps range (got ${v})`).toBeGreaterThanOrEqual(PAN_MIN);
    expect(v).toBeLessThanOrEqual(PAN_MAX);
  }
  void errorWatch;
});

test('ptzcam: a pan knob write glides (slew) and lands on the exact mapped device value', async ({
  page,
}) => {
  await boot(page);
  await connectAndBind(page);
  await clearMidiOutCaptured(page);

  // norm 0.5 → min + (0.5+1)/2 × (max−min) = 306000 on the measured range.
  await writeParam(page, 'pan', 0.5);
  await page.waitForFunction(() => {
    const sent =
      (window as unknown as { __midiOutSentDetailed?: { portId: string; bytes: number[] }[] })
        .__midiOutSentDetailed ?? [];
    const pans = sent.filter(
      (m) => m.portId === 'ptz-0' && m.bytes[6] === 0x02 && m.bytes[7] === 0x01,
    );
    if (pans.length === 0) return false;
    const last = pans[pans.length - 1]!.bytes;
    let u = 0;
    for (let i = 0; i < 5; i++) u += (last[8 + i]! & 0x7f) * 128 ** i;
    const v = u >= 2 ** 34 ? u - 2 ** 35 : u;
    return v === 306000;
  }, undefined, { timeout: 20_000 });

  const pans = setAbsValues(await readMidiOutCaptured(page, PTZ_OUT.id), 0x01);
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
    .locator(`.svelte-flow__node-${TYPE}`)
    .getByTestId(`ptzcam-connect-${NODE}`)
    .click();
  await expect(
    page.locator(`.svelte-flow__node-${TYPE}`).getByTestId(`ptzcam-status-${NODE}`),
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
  await connectAndBind(page);
  expect(await injectMidiIn(page, PTZ_IN.id, CAMERA_ABSENT_FRAME)).toBe(true);
  const status = page
    .locator(`.svelte-flow__node-${TYPE}`)
    .getByTestId(`ptzcam-status-${NODE}`);
  await expect(status).toContainText('camera is absent');
  await expect(status).toHaveRole('alert');

  await clearMidiOutCaptured(page);
  await writeParam(page, 'pan', -0.5);
  await waitTicks(page, 12);
  expect(await readMidiOutCaptured(page, PTZ_OUT.id), 'no sends against an absent camera').toEqual(
    [],
  );
});
