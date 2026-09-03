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
import { type Locator, type Page } from '@playwright/test';
import { spawnPatch, type SpawnEdge, type SpawnNode } from './_helpers';
import { BOOT_MS } from '../_helpers/boot-budget';
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
  opts: { ports?: boolean; lfo?: boolean; nodes?: SpawnNode[]; shell?: 'legacy' | 'face' } = {},
): Promise<void> {
  const withPorts = opts.ports ?? true;
  await installMidiIoCapture(
    page,
    withPorts ? [DECOY_OUT, NEXIGO_OUT, LOGI_OUT] : [DECOY_OUT],
    withPorts ? [DECOY_IN, NEXIGO_IN, LOGI_IN] : [DECOY_IN],
  );
  // ⚠ EVERYTHING BOOTS THE DEFAULT SHELL NOW (S2 legacy-removal): the legacy
  // arm died with the card fleet, and connectAndBind routes the binder
  // through the face (tile CONNECT cell + dock device body) for every test.
  await page.goto('/rack?seed=none');
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
  // ⚠ THE READY SELECTOR IS SHELL-SPECIFIC AND MUST BE. xyflow tags a node with
  // its NODE TYPE, and the two shells register different ones: the legacy card
  // is `svelte-flow__node-ptzcam`, the default shell renders every migrated
  // module through ONE `moduleShell` node type, so that class never appears.
  // Waiting on it under the face shell fails at the 5 s expect default with
  // "element(s) not found" — measured here, and it would have read as a broken
  // promotion rather than a wrong locator. `data-id` is the shell-independent
  // handle (the es9-face pattern) and is what the face legs below scope on, so
  // the bound is the shared BOOT_MS rather than a number typed here.
  const ready = page.locator(
    `.svelte-flow__node[data-id="${nodes[0]!.id}"] [data-testid="module-shell"]`,
  );
  await expect(ready).toBeVisible({ timeout: BOOT_MS });
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
  // Bind through the SHIPPING surface: the tile's CONNECT cell + the dock
  // device body (bindThroughFace hoists — it also asserts the LINK lamp).
  const dock = await openDock(page, nodeId);
  await bindThroughFace(page, dock, cam, nodeId);
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
  // The card's mode line is DELETED on the face; its replacement is the
  // per-axis lamp trio (lit = velocity, dark = absolute — all three dark for
  // the all-absolute NexiGo). The CONNECT cell stays present by design
  // (static caption; the card's disappearing button was card chrome).
  const dock = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${NODE}"]`);
  await expect(dock.getByTestId(`ptzcam-axis-lamps-${NODE}`)).toHaveCount(1);
  for (const axis of ['pan', 'tilt', 'zoom']) {
    await expect(dock.getByTestId(`ptzcam-led-${axis}-${NODE}`)).toHaveAttribute('data-lit', '0');
  }
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
  // ⚠ CLOSE m's DOCK PANE before binding m2 — with a pane open the dock
  // drawer's subtree intercepts pointer events over the lane, so m2's tile
  // CONNECT cell is unclickable (measured: data-pane-count="2" interception).
  await page
    .locator(`[data-testid="dock-fullview-pane"][data-pane-node="m"] [data-testid="faceplate-close"]`)
    .click();
  await expect(page.locator('[data-testid="dock-fullview-pane"][data-pane-node="m"]')).toHaveCount(0);
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
  const dock = await openDock(page, NODE);
  await page
    .locator(`.svelte-flow__node[data-id="${NODE}"]`)
    .getByTestId('shell-cell-ptzcam-connect')
    .click();
  // The explanation reaches the face's FAULT line (role=alert, the LINK
  // lamp's own detail sentence — the card's status row died with the card).
  await expect(dock.getByTestId(`ptzcam-fault-${NODE}`)).toContainText('No MIDI port named PT-PTZ');

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
  // The face surfaces the error on its FAULT line (role=alert by markup).
  const status = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="ptzcam-fault-${NODE}"]`);
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

// ═══════════════════ THE PROMOTED SURFACE — DEFAULT SHELL ════════════════════
//
// ⚠ EVERY ASSERTION ABOVE THIS LINE ONCE BOOTED `?shell=legacy`, AND THAT WAS TRUE OF
// THE WHOLE MODULE BEFORE THIS PR — the VRT scene too, and the `__annotated__`
// legend directory holds only adsr and lfo. So nothing in the tree could fail on
// a dropped ptzcam affordance under the shell a player actually meets. These
// legs are that gap, and they are deliberately not a re-run of the legacy ones:
// each covers something only the FACE can be wrong about.
//
//   1. THE GESTURE IS ON THE LANE TILE. `curatedFace` deciding the CONNECT key
//      survives the compact tier is a statement about the resolver;
//      `shell-cell-ptzcam-connect` being in a lane tile's DOM is a statement
//      about the renderer, and it is the entire practical argument for the
//      promotion — the module sends nothing until it is pressed.
//   2. THE WHOLE BINDER WORKS WITH NO CARD ANYWHERE. Connect from the tile, pick
//      the camera in the dock body, handshake, and a REAL default-mode LFO
//      reaches the wire as changing sysex. That is the poly/MIDI boundary rule
//      (AGENTS.md #8) asserted through the shipping surface.
//   3. THE DELETED READOUT'S REPLACEMENT, at the renderer. The card's
//      `pan abs · tilt abs · zoom abs` line is three lamps now, and the ONLY
//      state a unit test cannot reach is the one that matters: lamps ABSENT
//      before the handshake, then a MIXED camera lighting pan/tilt and leaving
//      zoom dark. A source gate cannot see a rendered `{#if}`.

/** Open this node's dock faceplate, scoped by `data-shell-node` so a later swap
 *  of the dock's occupant cannot leave a stale locator on someone else's plate
 *  (the es9-face pattern). */
async function openDock(page: Page, nodeId: string): Promise<Locator> {
  const shell = page.locator(`.svelte-flow__node[data-id="${nodeId}"] [data-testid="module-shell"]`);
  await expect(shell).toBeVisible({ timeout: BOOT_MS });
  await shell.getByTestId('shell-open-dock').click();
  const dockShell = page
    .getByTestId('dock-full-view')
    .locator(`[data-testid="module-shell"][data-shell-tier="dock"][data-shell-node="${nodeId}"]`);
  await expect(dockShell).toBeVisible({ timeout: BOOT_MS });
  return dockShell;
}

/** Bind through the PROMOTED surface only: the ranked CONNECT cell on the lane
 *  tile, then the camera picker in the dock body. No card is mounted anywhere. */
async function bindThroughFace(
  page: Page,
  dock: Locator,
  cam: { out: { id: string; name: string }; in: { id: string }; reply: number[] },
  nodeId = NODE,
): Promise<void> {
  const lane = page.locator(`.svelte-flow__node[data-id="${nodeId}"]`);
  await lane.getByTestId('shell-cell-ptzcam-connect').click();
  const select = dock.getByTestId(`ptzcam-device-select-${nodeId}`);
  // Auto-retrying: the roster arrives when the async MIDI grant resolves, so
  // the assertion IS the wait — there is no wall-clock budget to tune.
  await expect(select.locator(`option[value="${cam.out.name}"]`)).toHaveCount(1);
  await select.selectOption(cam.out.name);
  await waitCapsRequest(page, cam.out.id);
  expect(await injectMidiIn(page, cam.in.id, cam.reply)).toBe(true);
  await expect(dock.getByTestId(`ptzcam-led-link-${nodeId}`)).toHaveAttribute('data-lit', '1');
}

test.describe('ptzcam face — the default shell', () => {
  test('the CONNECT gesture is on the LANE TILE, and the body carries what a cell cannot', async ({
    page,
  }) => {
    await boot(page, { shell: 'face' });

    // ── 1. the lane tile ────────────────────────────────────────────────
    const lane = page.locator(`.svelte-flow__node[data-id="${NODE}"]`);
    await expect(lane).toHaveCount(1);
    await expect(
      lane.getByTestId('shell-cell-ptzcam-connect'),
      'the gesture the module sends nothing without must be ON the tile, not behind the dock',
    ).toHaveCount(1);
    // NEGATIVE CONTROL for the same read — and it is deliberately NOT "a
    // low-ranked param is absent". ⚠ MEASURED: at this rack's default zoom the
    // tile renders the FULL lane tier, whose cap is 6, so all five ranked keys
    // paint and `control-slew` IS present. Asserting its absence would have been
    // a test of the ZOOM LEVEL wearing a ranking assertion's clothes — green
    // today, red on a rack scrolled one notch, and never a statement about the
    // face. Which tier selects which keys is pinned where it is a pure function:
    // `ptzcam-face-model.test.ts` calls `curatedFace` at mini/compact/full.
    //
    // What IS tier-independent, and what actually separates the two halves of
    // this promotion, is that the BODY is dock-only (`dockFullViewHeadPlan`) —
    // a 192 px tile cannot hold a device roster — while the GESTURE is not,
    // because an `action` cell is unrestricted and only `panel` is filtered.
    await expect(
      lane.getByTestId(`ptzcam-device-body-${NODE}`),
      'the device body is DOCK-ONLY — a 192px tile cannot carry a roster',
    ).toHaveCount(0);

    // ── 2. the dock body, pre-connect ───────────────────────────────────
    const dock = await openDock(page, NODE);
    const body = dock.getByTestId(`ptzcam-device-body-${NODE}`);
    await expect(body).toBeVisible();

    const link = dock.getByTestId(`ptzcam-led-link-${NODE}`);
    await expect(link, 'nothing is bound before the gesture').toHaveAttribute('data-lit', '0');
    await expect(
      link,
      'and the nine-kind status sentence is on the lamp, not painted',
    ).toHaveAttribute('aria-label', /Connect grants MIDI/i);

    // ⚠ THE AXIS LAMPS ARE ABSENT, NOT DARK — the assertion no unit test and no
    // source gate can make. Three dark lamps here would be pixel-identical to a
    // bound all-absolute NexiGo P610, i.e. the face asserting "all three axes
    // are positions" about a module that knows nothing about any camera yet.
    await expect(dock.getByTestId(`ptzcam-axis-lamps-${NODE}`)).toHaveCount(0);
    // No fault line either: `idle` is not an error, and an error that is present
    // at rest is furniture rather than an alert.
    await expect(dock.getByTestId(`ptzcam-fault-${NODE}`)).toHaveCount(0);

    // ── 3. nothing on the plate is a measurement ────────────────────────
    const painted = (await dock.innerText()).replace(/\s+/g, ' ');
    expect(painted, 'the mode line is GONE, not relocated').not.toMatch(/\babs\b|\bvel\b/i);
    expect(painted, 'no decimal anywhere on the plate').not.toMatch(/\d+\.\d/);
    // POSITIVE CONTROL for the same read: the plate DID paint what it should, so
    // the absences above are not an empty element.
    expect(painted, 'the lamp caption').toMatch(/LINK/);
    expect(painted, 'the picker caption').toMatch(/Camera/i);
    expect(painted, 'the empty-state instruction').toMatch(/Press Connect camera/i);
  });

  test('REAL CHAIN through the FACE — bind with no card, and an LFO reaches the wire', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await boot(page, { shell: 'face', lfo: true });
    // Instant, so the LFO rather than the glide is the subject.
    await writeParam(page, 'slew', 1);

    // ⚠ THE CARD IS NOT MOUNTED. Asserted rather than assumed: `migrated()`
    // stops a promoted module rendering its legacy card on normal surfaces, and
    // the whole claim of this leg is that the binder survived that.
    await expect(page.locator(`[data-testid="ptzcam-card-${NODE}"]`)).toHaveCount(0);

    const dock = await openDock(page, NODE);
    await bindThroughFace(page, dock, NEXIGO);
    await clearMidiOutCaptured(page);

    await page.waitForFunction(
      countCtlFramesScript(NEXIGO_OUT.id, CMD_SET_ABS, 0x01) + ' >= 6',
      undefined,
      { timeout: 30_000 },
    );
    const pans = ctlValues(await readMidiOutCaptured(page, NEXIGO_OUT.id), CMD_SET_ABS, 0x01);
    expect(pans.length).toBeGreaterThanOrEqual(6);
    expect(
      new Set(pans).size,
      'the LFO must MOVE the pan through the promoted surface, not repeat one value',
    ).toBeGreaterThanOrEqual(3);
    for (const v of pans) {
      expect(v, `pan device units within the caps range (got ${v})`).toBeGreaterThanOrEqual(PAN_MIN);
      expect(v).toBeLessThanOrEqual(PAN_MAX);
    }
    expect(await readMidiOutCaptured(page, DECOY_OUT.id), 'nothing may reach the decoy').toEqual([]);
  });

  test('the axis-mode lamps arrive WITH the caps, and a MIXED camera lights pan/tilt only', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    // ⚠ THE LOGITECH PTZ PRO 2 IS THE FIXTURE THAT MAKES THE PER-AXIS LAMP WORTH
    // ANYTHING: pan and tilt are VELOCITY axes and zoom is ABSOLUTE, on one
    // head, at the same time. A single "this camera is a velocity camera" badge
    // would be wrong about zoom, and the card's own line said all three
    // separately for exactly that reason.
    await boot(page, { shell: 'face' });
    const dock = await openDock(page, NODE);
    await expect(dock.getByTestId(`ptzcam-axis-lamps-${NODE}`)).toHaveCount(0);

    await bindThroughFace(page, dock, LOGI);

    await expect(dock.getByTestId(`ptzcam-axis-lamps-${NODE}`)).toHaveCount(1);
    const pan = dock.getByTestId(`ptzcam-led-pan-${NODE}`);
    const tilt = dock.getByTestId(`ptzcam-led-tilt-${NODE}`);
    const zoom = dock.getByTestId(`ptzcam-led-zoom-${NODE}`);
    await expect(pan, 'lit = velocity').toHaveAttribute('data-lit', '1');
    await expect(tilt).toHaveAttribute('data-lit', '1');
    await expect(zoom, 'zoom is absolute on this head').toHaveAttribute('data-lit', '0');

    // The three facts that make a velocity axis behave unlike every other
    // control in the rack live on the accessible name — the card's mode line
    // never said any of them.
    await expect(pan).toHaveAttribute('aria-label', /RATE/);
    await expect(pan).toHaveAttribute('aria-label', /SLEW is ignored/);
    await expect(zoom).toHaveAttribute('aria-label', /ABSOLUTE/);

    // ⚠ AND THE WORDS DO NOT PAINT. The lamp is the picture; the sentence is
    // speakable and unpainted. `abs`/`vel` appearing as text here would be the
    // deleted readout back under a new spelling.
    const painted = (await dock.innerText()).replace(/\s+/g, ' ');
    expect(painted).not.toMatch(/\babs\b|\bvel\b/i);
    expect(painted, 'the captions ARE painted — the absence above is not an empty element').toMatch(
      /PAN.*TILT.*ZOOM/s,
    );
  });
});
