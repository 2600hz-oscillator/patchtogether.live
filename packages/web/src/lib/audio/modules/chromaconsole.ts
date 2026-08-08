// packages/web/src/lib/audio/modules/chromaconsole.ts
//
// CHROMA CONSOLE — a control surface for the Hologram Electronics pedal.
//
// The first device module. It sends MIDI CC; it carries no audio. The pedal's
// audio is patched through the ES-9 by hand, which is an owner decision and out
// of scope here.
//
// ─────────────────────────── WHY THE AUDIO DOMAIN ───────────────────────────
//
// It has zero ports, which makes `meta` look like the natural home. It is not.
// `MetaModuleDef` carries NO FACTORY — the reconciler skips meta nodes entirely
// — and the factory is precisely what this module needs: it is where the MIDI
// transmitter lives, where `ctx.currentTime` comes from for scheduling, where
// `scheduleParam` is implemented so clip automation can drive the pedal, and
// where `dispose()` tears the port listener down. A meta module could render a
// card and nothing else.
//
// `livecode` states the same reasoning for the same choice, verbatim: the rack
// already requires an audio engine, so reusing its dispatch keeps the boot path
// uncomplicated, and the factory returns a handle that does no AudioNode work.
// `clockedRunner` is the second precedent. This is a third instance of an
// established shape, not a new one.
//
// The `video` domain would additionally have dragged the module into the WebGL
// attest basis and forced a GPU re-attest for a module with no pixels in it.
//
// ─────────────────────────── THE TYPE ID ───────────────────────────
//
// `chroma` is TAKEN by a video module (`video/modules/chroma.ts`), hence
// `chromaconsole`.

import type { AudioModuleDef } from '$lib/audio/module-registry';
import { patch as livePatch, ydoc } from '$lib/graph/store';
import { CHROMA_CONSOLE } from '$lib/devices/hologram-chroma-console';
import {
  createDeviceHandle,
  deviceSlotParams,
  type DeviceHandle,
} from '$lib/devices/device-module';

export const CHROMA_CONSOLE_TYPE = 'chromaconsole';

export const chromaconsoleDef: AudioModuleDef = {
  // String LITERALS, not the constant above: `module-manifest.ts` extracts
  // these fields with a `?raw` regex and cannot resolve a reference.
  type: 'chromaconsole',
  palette: { top: 'MIDI', sub: 'MIDI' },
  domain: 'audio',
  label: 'chroma console',
  category: 'utilities',
  inputs: [],
  outputs: [],
  params: deviceSlotParams(CHROMA_CONSOLE),
  // A FIXED tier, not a dynamic one: nothing on this card is size-driven (no
  // preview, no list that grows), so there is no user resize for a tier to cap
  // — the reason clockedRunner and livecode are in DYNAMIC_SIZED instead.
  size: '2u',
  hp: 2,

  docs: {
    explanation:
      "A control surface for the Hologram Chroma Console pedal. It sends MIDI CC to the " +
      "hardware and carries no audio of its own — patch the pedal's audio through your " +
      "interface as usual. The pedal has 34 documented CCs; this card exposes all of them, " +
      "but only EIGHT at a time are backed by real parameters (the slots), and those eight " +
      "are what clip automation, MIDI learn, Electra and the Push 2 card can drive. Assign " +
      "any control to any slot from the card; the assignment is saved with your rack. " +
      "Eight is deliberate: a clip can hold sixteen automation lanes in total, so one device " +
      "taking half of them still leaves room for the rest of your patch. " +
      "IMPORTANT: the Chroma Console is receive-only. It never reports its settings back, so " +
      "this card shows what the APP has sent, not what the pedal currently holds — turning a " +
      "knob on the pedal itself will silently disagree with the screen. Use PUSH ALL to make " +
      "the pedal match the card again. Two controls, RATE and TIME, are snapped by the pedal " +
      "to tempo subdivisions and cannot be un-snapped; their readouts are marked so you can " +
      "see that the number you set is not exactly the value you hear.",
    controls: {
      slot1: 'Assignable control slot 1. Holds TILT by default. Automatable, MIDI-learnable, and shown on the Push 2 card.',
      slot2: 'Assignable control slot 2. Holds RATE by default — a control the pedal snaps to tempo subdivisions.',
      slot3: 'Assignable control slot 3. Holds TIME by default — a control the pedal snaps to tempo subdivisions.',
      slot4: 'Assignable control slot 4. Holds MIX by default.',
      slot5: 'Assignable control slot 5. Holds AMOUNT (CHARACTER) by default.',
      slot6: 'Assignable control slot 6. Holds AMOUNT (MOVEMENT) by default.',
      slot7: 'Assignable control slot 7. Holds AMOUNT (DIFFUSION) by default.',
      slot8: 'Assignable control slot 8. Holds AMOUNT (TEXTURE) by default.',
    },
  },

  async factory(ctx, node): Promise<DeviceHandle> {
    const nodeId = node.id;

    return createDeviceHandle({
      descriptor: CHROMA_CONSOLE,
      ctx,
      access: {
        readAssign() {
          const live = livePatch.nodes[nodeId];
          const data = (live?.data as Record<string, unknown> | undefined) ?? {};
          const assign = data.assign;
          return assign && typeof assign === 'object'
            ? (assign as Record<string, string>)
            : undefined;
        },
        writeAssign(next) {
          ydoc.transact(() => {
            const live = livePatch.nodes[nodeId];
            if (!live) return;
            if (!live.data) live.data = {};
            (live.data as Record<string, unknown>).assign = next;
          });
        },
        readSlotValue(slotId) {
          const live = livePatch.nodes[nodeId];
          const value = live?.params?.[slotId];
          return typeof value === 'number' ? value : 0;
        },
      },
    });
  },
};
