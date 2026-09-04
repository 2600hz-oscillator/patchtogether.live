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
import type { ModuleFace } from '$lib/graph/types';
import { patch as livePatch } from '$lib/graph/store';
import { mutateNode } from '$lib/graph/mutate';
import { CHROMA_CONSOLE } from '$lib/devices/hologram-chroma-console';
import {
  createDeviceHandle,
  deviceSlotParams,
  type DeviceHandle,
} from '$lib/devices/device-module';

export const CHROMA_CONSOLE_TYPE = 'chromaconsole';

// ─────────────────────────── THE FACE ───────────────────────────────────────
//
// ⚠ THE RANK PUTS TWO GESTURES ABOVE EIGHT KNOBS, and the argument is this
// module's own rather than a house style. The lane budget is `faceTierCap`: 3
// cells on a glyph-less COMPACT tile, 6 on a FULL one. CONNECT is the midiclock
// argument (#2187) verbatim — the module transmits nothing until Web MIDI is
// granted and an output is chosen, and before promotion the only affordance
// that could ask for the grant lived on a card the default shell paints as a
// placeholder. PUSH ALL is the argument this module adds to it: the pedal is
// `readBack: 'none'`, so the app is permanently the authority and a hand on a
// physical knob desyncs the screen undetectably; PUSH ALL is the ONLY
// reconciliation that exists in either direction. Both are gestures with NO
// other surface. The eight slot VALUES have four others — MIDI learn, clip
// automation, the Push 2 card and the Electra, named in `docs.explanation` —
// which is why they rank below. That argument would be WRONG for a module whose
// knobs are its only route to its own state, which is the test the ranking rule
// asks for.
//
// ⚠ THE EIGHT SLOT CAPTIONS SAY `slot 1`…`slot 8` AND THAT IS A KNOWN,
// OWNER-ACCEPTED TRADE (owner-decisions 2026-08-31, item 7: "accept two operable
// surfaces per slot — a generic band knob plus the body's real Segmented").
// `deviceSlotParams` mints eight identical `0..127 linear` params because a
// ParamDef id is public and permanent while the ASSIGNMENT is per-NODE
// (`node.data.assign`), and a face cell's caption is `ParamDef.label` with no
// node input anywhere in `ModuleShell` (`shellCellFor(node.type, ctl)` takes the
// TYPE). So the NAMES live on the device body's slot board, one plate above the
// knobs, and the band carries the automatable, MIDI-learnable, Push-2-reachable
// anchors. The alternative — per-node cell derivation — is platform work the
// same ruling declines ("if it is ever wanted, the cheap ask is a `node`
// argument on `shellCellFor`"), and it is NOT a parity loss against the card:
// every name, every enum selector and every assignment the card offers is on
// the faceplate, in the body.
//
// ⚠ `glyph: 'none'` IS FORCED, NOT CHOSEN. `inputs: []` and `outputs: []`, so
// `primaryAudioOutPortId` resolves null, every live-audio binding
// short-circuits and every literal except 'algorithm' falls to
// `{ kind: 'static' }` — a DEAD glyph `module-face-lint` reddens
// unconditionally. 'algorithm' would RESOLVE through the `layoutSource:
// <extension>` branch and paint an empty topology plate, because this
// extension exports no `glyph` slot.
//
// ⚠ TWO BANDS, NOT A TAB RAIL, AND THE CONTROL-HEAVY RULING DOES NOT REACH
// HERE. That ruling is about many controls of DIFFERENT types (backdraft's
// eight semantic pages); this is eight controls of ONE type plus two gestures.
// Splitting the slots into pages to reach `DOCK_TAB_MIN_BANDS` (7) is padding a
// rail, which the same ruling names as the anti-pattern. `face.tabbed` is
// owner-instruction-only and is not reached for.
//
// ⚠ NO `rear` GROUPS: `inputs` and `outputs` are both empty, so there is no
// jack for a group to name and module-face-lint refuses a group resolving to no
// port at all.
//
// ⚠ THE RESTING FACE MUST STAY BYTE-STABLE, which is a module-specific override
// of a cohort-wide allowance rather than an inherited default. The legacy card's
// header records that its determinism (no message counters, no activity blink,
// no elapsed times, no "last CC sent" readout) is load-bearing for a committed
// VRT baseline AND is the same set the resting-text ruling forbids AND is what
// keeps the card from implying it knows what the pedal holds — three unrelated
// pressures selecting one set of deletions. The face inherits all three: the
// device body paints no counter and no activity dot, though `BINDERS §2.1` would
// permit one in principle.
export const CHROMA_CONSOLE_FACE: ModuleFace = {
  glyph: 'none',
  extension: 'chromaconsole',
  order: [
    'chromaconsole-connect-{n}',
    'chromaconsole-pushall-{n}',
    'slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8',
  ],
  pages: [
    {
      id: 'device',
      label: 'device',
      hint:
        'CONNECT is the one-time-per-origin Web-MIDI grant plus the search for the pedal by name; '
        + 'which output it lands on, and which of the sixteen MIDI channels it speaks, are picked '
        + "in the faceplate's device body. PUSH ALL re-sends all eight slots at their current "
        + 'values, and it is the only reconciliation this pedal has: it never reports its '
        + 'settings back, so a hand on a physical knob leaves the screen and the hardware '
        + 'disagreeing with nothing able to say so.',
      controls: ['chromaconsole-connect-{n}', 'chromaconsole-pushall-{n}'],
    },
    {
      id: 'slots',
      label: 'slots',
      hint:
        'The eight automatable controllers. The pedal documents thirty-four CCs and these eight '
        + 'are the ones backed by real params, so they are what clip automation, MIDI learn, the '
        + 'Electra and the Push 2 card can drive — eight and not thirty-four because a clip holds '
        + 'sixteen automation lanes in total. Which pedal control each slot drives is shown, and '
        + "changed, on the slot board in the device body above; a slot assigned to one of the "
        + "pedal's selectors (a MODULE, a bypass) is operated there too, because its states are "
        + 'named ranges rather than a scale.',
      controls: ['slot1', 'slot2', 'slot3', 'slot4', 'slot5', 'slot6', 'slot7', 'slot8'],
    },
  ],
};

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

  face: CHROMA_CONSOLE_FACE,

  // The two gestures that are not `ParamDef`s: they write no value, they enter
  // no undo stack, and one of them asks the browser for a permission. Declared
  // as families because `face.order` legitimizes a non-param key exactly two
  // ways — a `<familyId>-{n}` template whose prefix is a family declared HERE,
  // or an entry in a committed `<type>.legend.json`, of which none is this
  // module's.
  //
  // ⚠ EACH `testidPrefix` IS A LITERAL THE LEGACY CARD ALREADY EMITS
  // (`chromaconsole-connect-${id}`, `chromaconsole-pushall-${id}`), which is
  // what module-docs-lint's card grep checks — so a rename on either surface is
  // RED, and no card edit was needed to declare these. The card survives
  // promotion: `?shell=legacy` still renders it and `chromaconsole.spec.ts`
  // still drives it there.
  //
  // ⚠ THE PEDAL'S FIVE `role: 'action'` COMMANDS (tap tempo, capture, the two
  // gesture-looper commands, the calibration menu) are deliberately NOT
  // families. They are the DEVICE's transport, not this module\'s own controls;
  // five more families would be five more lines in the contract signature and
  // five `testidPrefix`es that cannot be checked, because the card emits them
  // as `chromaconsole-action-${id}-${controlId}` — an interpolation whose
  // per-control literal appears nowhere in any card source, so the grep would
  // pass on a prefix naming nothing. They live in the device body, keeping the
  // card's exact testids.
  controlFamilies: [
    {
      id: 'chromaconsole-connect',
      label: 'Connect MIDI',
      kind: 'other',
      testidPrefix: 'chromaconsole-connect',
    },
    {
      id: 'chromaconsole-pushall',
      label: 'Push all',
      kind: 'other',
      testidPrefix: 'chromaconsole-pushall',
    },
  ],

  docs: {
    explanation:
      "A control surface for the Hologram Chroma Console pedal. It sends MIDI CC to the " +
      "hardware and carries no audio of its own — patch the pedal's audio through your " +
      "interface as usual. The pedal has 34 documented CCs; this card exposes all of them, " +
      "but only EIGHT at a time are backed by real parameters (the slots), and those eight " +
      "are what clip automation, MIDI learn, Electra and the Push 2 card can drive. Assign " +
      "any control to any slot from the faceplate; the assignment is saved with your rack. " +
      "Eight is deliberate: a clip can hold sixteen automation lanes in total, so one device " +
      "taking half of them still leaves room for the rest of your patch. " +
      "IMPORTANT: the Chroma Console is receive-only. It never reports its settings back, so " +
      "this card shows what the APP has sent, not what the pedal currently holds — turning a " +
      "knob on the pedal itself will silently disagree with the screen. Use PUSH ALL to make " +
      "the pedal match the card again. Two controls, RATE and TIME, are snapped by the pedal " +
      "to tempo subdivisions and cannot be un-snapped; their readouts are marked so you can " +
      "see that the number you set is not exactly the value you hear.",
    controls: {
      'chromaconsole-connect-{n}':
        'Ask the browser for Web MIDI (one time per origin) and then look for the pedal among the '
        + 'outputs it publishes, by the names Hologram\'s own firmware updater reports. Auto-detect '
        + 'is a convenience, not a requirement — port names differ by OS, driver and hub, and a '
        + 'pedal behind a generic interface reports the interface\'s name — so if it finds nothing '
        + 'it selects nothing rather than guessing, and the output picker in the device body is '
        + 'where you choose by hand.',
      'chromaconsole-pushall-{n}':
        'Re-send all eight slots at their current values. The pedal is receive-only: it never '
        + 'reports its settings back, so nothing can detect a hand moving a physical knob, and '
        + 'this is the one reconciliation that exists — press it to make the pedal match the '
        + 'screen again after touching the hardware, power-cycling it, or changing the output.',
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
          // ⚠ `mutateNode` RATHER THAN A BARE `ydoc.transact`, AND THE
          // DIFFERENCE IS Cmd-Z. `store.ts` tracks `trackedOrigins =
          // [LOCAL_ORIGIN]`, so an untagged transaction is atomic and syncs to
          // rack-mates but never reaches the UndoManager — which this write was
          // until the face PR. A slot reassignment is the module's most
          // destructive and least reconstructible edit (which of twenty-nine
          // controls was slot 5 before?) and is exactly the operation a player
          // reaches for undo after. `mutateNode` is the sanctioned seam and
          // defaults to LOCAL_ORIGIN.
          mutateNode(nodeId, (live) => {
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
