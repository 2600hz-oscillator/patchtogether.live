import { CLIP_LANES, SCENE_STRIDE, audioRecState, armedAutomationLanes, clipIndex, laneOf, laneRecArm, laneRecMode, readClip, readClipAudio, clipPlaybackIsRecorded, clipPadState, type ClipPlayerData } from '$lib/audio/modules/clip-types';
import { padNote, SCENE_CCS } from './launchpad-sysex';
import type { LaunchpadFrame } from './launchpad-device.svelte';

/** CONTROL / pair-deck entry. Bottom-origin coordinates, shared by dispatch,
 *  LED painting and the authored hardware diagrams. */
export const AUDIO_ENTRY = { x: 4, y: 6 } as const;
export const AUDIO_COLOR: [number, number, number] = [76, 35, 120];
export function isAudioEntry(x: number, y: number): boolean { return x === AUDIO_ENTRY.x && y === AUDIO_ENTRY.y; }
export const AUDIO_RIGHT_BINDINGS = [
  { action: 'arm', legend: 'ARM / FINISH', shiftLegend: null },
  { action: 'length', legend: '1 / ENDLESS', shiftLegend: null },
  { action: 'play', legend: 'PLAY CLIP', shiftLegend: null },
  { action: 'source', legend: 'NOTES / REC', shiftLegend: null },
  { action: 'replace', legend: 'REPLACE TAKE', shiftLegend: null },
  { action: 'up', legend: 'BANK UP', shiftLegend: null },
  { action: 'down', legend: 'BANK DOWN', shiftLegend: null },
  { action: 'exit', legend: 'EXIT AUDIO', shiftLegend: null },
] as const;
export type AudioAction = typeof AUDIO_RIGHT_BINDINGS[number]['action'];
export function audioRight(index: number): AudioAction | null { return AUDIO_RIGHT_BINDINGS[index]?.action ?? null; }

export type PairAudioAction = { action: 'select' | 'arm' | 'length' | 'source' | 'auto'; lane: number } |
  { action: 'pick' | 'play' | 'replace' | 'exit' };
export function pairAudioPad(x: number, y: number): PairAudioAction | null {
  if (!Number.isInteger(x) || x < 0 || x >= CLIP_LANES) return null;
  const rows = { 7: 'select', 6: 'arm', 5: 'length', 4: 'source', 3: 'auto' } as const;
  if (y in rows) return { action: rows[y as keyof typeof rows], lane: x };
  if (y === 0) {
    if (x === 0) return { action: 'pick' };
    if (x === 1) return { action: 'play' };
    if (x === 2) return { action: 'replace' };
    if (x === 7) return { action: 'exit' };
  }
  return null;
}

const OFF: [number, number, number] = [0, 0, 0];
const DIM: [number, number, number] = [8, 8, 8];
const WHITE: [number, number, number] = [100, 100, 100];
const RED: [number, number, number] = [127, 16, 16];
const GREEN: [number, number, number] = [28, 110, 36];
const AMBER: [number, number, number] = [110, 96, 0];
function recColor(data: ClipPlayerData | undefined, lane: number, blink: boolean): [number, number, number] {
  const rec = audioRecState(data, lane);
  if (rec?.phase === 'recording') return RED;
  if (rec?.phase === 'stopping') return blink ? RED : AMBER;
  return laneRecArm(data, lane) || rec ? (blink ? AMBER : DIM) : [30, 4, 4];
}

/** Overlay on the existing frame, preserving permanent controls and pair globals. */
export function paintAudioCapture(frame: LaunchpadFrame, data: ClipPlayerData | undefined, opts: {
  pair: boolean; index: number; offset: number; targets: number[]; blink: boolean;
  pick: boolean; replacing: boolean; shift?: boolean;
}): LaunchpadFrame {
  const lane = laneOf(opts.index), clip = readClip(data, opts.index), take = readClipAudio(data, opts.index);
  const lane8 = frame.leds.get(padNote(7, 7));
  for (let x = 0; x < CLIP_LANES; x++) for (let y = 0; y < 8; y++) frame.leds.set(padNote(x, y), OFF);
  if (opts.pair) {
    const arms = armedAutomationLanes(data);
    for (let l = 0; l < CLIP_LANES; l++) {
      frame.leds.set(padNote(l, 7), l === lane ? WHITE : DIM);
      frame.leds.set(padNote(l, 6), recColor(data, l, opts.blink));
      frame.leds.set(padNote(l, 5), laneRecMode(data, l) === 'endless' ? AMBER : GREEN);
      const index = clipIndex(opts.targets[l] ?? 0, l);
      frame.leds.set(padNote(l, 4), readClip(data, index) ? clipPlaybackIsRecorded(data, index) ? AUDIO_COLOR : GREEN : DIM);
      frame.leds.set(padNote(l, 3), arms[l] ? RED : [10, 35, 30]);
    }
    frame.leds.set(padNote(0, 0), opts.pick ? AMBER : GREEN);
    frame.leds.set(padNote(1, 0), clip ? GREEN : DIM);
    frame.leds.set(padNote(2, 0), opts.replacing ? RED : take ? AUDIO_COLOR : DIM);
    frame.leds.set(padNote(7, 0), WHITE);
  } else {
    for (let l = 0; l < CLIP_LANES; l++) for (let r = 0; r < 8; r++) {
      const s = opts.offset + r, idx = clipIndex(s, l), c = readClip(data, idx);
      let color = readClipAudio(data, idx) ? AUDIO_COLOR : c ? GREEN : DIM;
      const rec = audioRecState(data, l);
      const target = rec?.slot ?? data?.recRequest?.[String(l)]?.slot;
      if (target === s && (rec || laneRecArm(data, l))) color = recColor(data, l, opts.blink);
      else if (idx === opts.index) color = opts.blink ? WHITE : color;
      frame.leds.set(padNote(l, 7 - r), color);
    }
    const colors = [recColor(data, lane, opts.blink), laneRecMode(data, lane) === 'endless' ? AMBER : GREEN,
      clip ? GREEN : DIM, clip ? clipPlaybackIsRecorded(data, opts.index) ? AUDIO_COLOR : GREEN : DIM,
      opts.replacing ? RED : take ? AUDIO_COLOR : DIM, opts.offset > 0 ? AMBER : DIM,
      opts.offset < SCENE_STRIDE - 8 ? AMBER : DIM, WHITE];
    SCENE_CCS.forEach((cc, i) => frame.leds.set(cc, colors[i]!));
    // The global lane-8 SHIFT arm has precedence over target selection.
    if (opts.shift && lane8) frame.leds.set(padNote(7, 7), lane8);
  }
  return frame;
}

/** Recording feedback also survives leaving AUDIO for the normal live matrix. */
export function paintAudioMatrix(frame: LaunchpadFrame, data: ClipPlayerData | undefined, pair: boolean, offset: number, blink: boolean): LaunchpadFrame {
  for (let lane = 0; lane < CLIP_LANES; lane++) for (let row = 0; row < 8; row++) {
    const slot = pair ? row : offset + row, idx = clipIndex(slot, lane);
    const rec = audioRecState(data, lane), request = data?.recRequest?.[String(lane)];
    const pad = pair ? padNote(row, CLIP_LANES - 1 - lane) : padNote(lane, 7 - row);
    if ((rec?.slot ?? request?.slot) === slot && (rec || laneRecArm(data, lane))) frame.leds.set(pad, recColor(data, lane, blink));
    else if (readClipAudio(data, idx) && clipPadState(data, idx) === 'loaded') frame.leds.set(pad, AUDIO_COLOR);
  }
  return frame;
}
