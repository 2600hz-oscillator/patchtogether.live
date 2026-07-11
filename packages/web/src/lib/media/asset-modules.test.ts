// packages/web/src/lib/media/asset-modules.test.ts
//
// WORKFLOW MODE P3 unit coverage — the pure core of the click-to-patch
// asset flow: the kind→module mapping (CROSS-CHECKED against the live
// registries so a def/port rename can't silently strand the map), the
// persisted media descriptor + dupe-key matching, and the right-rail
// layout math.

import { describe, expect, it } from 'vitest';
import {
  ASSET_MODULE_SPECS,
  assetModuleSpecFor,
  mediaDescriptorOf,
  descriptorMatches,
  readMediaDescriptor,
  nextRightRailPosition,
  RIGHT_RAIL_GAP_X,
  RIGHT_RAIL_GAP_Y,
  RIGHT_RAIL_TOP_Y,
  RIGHT_RAIL_EMPTY_X,
  type MediaDescriptor,
} from './asset-modules';
// The live defs are imported DIRECTLY (the glob-driven registries are only
// populated by the app boot path, not by importing the registry module).
import { videoVarispeedDef } from '$lib/video/modules/videovarispeed';
import { pictureboxDef } from '$lib/video/modules/picturebox';
import { samsloopDef } from '$lib/audio/modules/samsloop';

describe('asset-modules: kind → module mapping', () => {
  it('maps the owner-specified module per kind', () => {
    expect(ASSET_MODULE_SPECS.video.type).toBe('videovarispeed');
    expect(ASSET_MODULE_SPECS.image.type).toBe('picturebox');
    expect(ASSET_MODULE_SPECS.audio.type).toBe('samsloop');
    expect(assetModuleSpecFor('audio')).toBe(ASSET_MODULE_SPECS.audio);
  });

  it('drag cable types: video for images+videos, audio for sounds', () => {
    expect(ASSET_MODULE_SPECS.video.dragCableType).toBe('video');
    expect(ASSET_MODULE_SPECS.image.dragCableType).toBe('video');
    expect(ASSET_MODULE_SPECS.audio.dragCableType).toBe('audio');
  });

  it('every mapped output port EXISTS on the live def with a wire-compatible type', () => {
    // videovarispeed.video → 'video', picturebox.out → 'image' (upcasts
    // to video), samsloop.out → 'audio'. A def port rename flips this red.
    expect(
      videoVarispeedDef.outputs.find((p) => p.id === ASSET_MODULE_SPECS.video.outputPortId)?.type,
    ).toBe('video');
    expect(
      pictureboxDef.outputs.find((p) => p.id === ASSET_MODULE_SPECS.image.outputPortId)?.type,
    ).toBe('image');
    expect(
      samsloopDef.outputs.find((p) => p.id === ASSET_MODULE_SPECS.audio.outputPortId)?.type,
    ).toBe('audio');
  });

  it('types + domains match the live defs', () => {
    expect(ASSET_MODULE_SPECS.video.type).toBe(videoVarispeedDef.type);
    expect(ASSET_MODULE_SPECS.image.type).toBe(pictureboxDef.type);
    expect(ASSET_MODULE_SPECS.audio.type).toBe(samsloopDef.type);
    expect(ASSET_MODULE_SPECS.video.domain).toBe(videoVarispeedDef.domain);
    expect(ASSET_MODULE_SPECS.image.domain).toBe(pictureboxDef.domain);
    expect(ASSET_MODULE_SPECS.audio.domain).toBe(samsloopDef.domain);
  });
});

describe('asset-modules: media descriptor', () => {
  const item = { name: 'kick.wav', size: 1234, lastModified: 99, kind: 'audio' as const };

  it('mediaDescriptorOf snapshots the dupe-key fields + kind', () => {
    expect(mediaDescriptorOf(item)).toEqual({
      name: 'kick.wav',
      size: 1234,
      lastModified: 99,
      kind: 'audio',
    });
  });

  it('descriptorMatches is the dupe-key: every field must agree', () => {
    const desc = mediaDescriptorOf(item);
    expect(descriptorMatches(desc, item)).toBe(true);
    expect(descriptorMatches(desc, { ...item, name: 'snare.wav' })).toBe(false);
    expect(descriptorMatches(desc, { ...item, size: 1235 })).toBe(false);
    expect(descriptorMatches(desc, { ...item, lastModified: 100 })).toBe(false);
    expect(descriptorMatches(desc, { ...item, kind: 'video' as const })).toBe(false);
  });

  it('readMediaDescriptor round-trips and rejects malformed synced data', () => {
    const desc = mediaDescriptorOf(item);
    expect(readMediaDescriptor({ data: { mediaDesc: desc } })).toEqual(desc);
    expect(readMediaDescriptor({})).toBeNull();
    expect(readMediaDescriptor({ data: {} })).toBeNull();
    expect(readMediaDescriptor({ data: { mediaDesc: 'nope' } })).toBeNull();
    expect(readMediaDescriptor({ data: { mediaDesc: { name: 'x' } } })).toBeNull();
    expect(
      readMediaDescriptor({
        data: { mediaDesc: { name: 'x', size: 1, lastModified: 2, kind: 'gif' } },
      }),
    ).toBeNull();
  });
});

describe('asset-modules: right-rail layout', () => {
  const box = (x: number, y: number, w = 300, h = 200) => ({ x, y, w, h });

  it('empty canvas: opens the rail at the empty-canvas column, top row', () => {
    expect(nextRightRailPosition([], [])).toEqual({
      x: RIGHT_RAIL_EMPTY_X,
      y: RIGHT_RAIL_TOP_Y,
    });
  });

  it('first rail card: clears the rightmost ordinary card by the rail gap', () => {
    const others = [box(0, 0, 300, 200), box(500, 300, 400, 200)]; // rightmost edge = 900
    expect(nextRightRailPosition(others, [])).toEqual({
      x: 900 + RIGHT_RAIL_GAP_X,
      y: RIGHT_RAIL_TOP_Y,
    });
  });

  it('stacks below the LOWEST rail member with the vertical gap', () => {
    const rail = [box(1000, 40, 320, 220), box(1000, 284, 320, 180)]; // lowest bottom = 464
    const pos = nextRightRailPosition([box(0, 0)], rail);
    expect(pos.y).toBe(464 + RIGHT_RAIL_GAP_Y);
  });

  it('column x stays stable once rail members exist (left-aligned to min x), even when ordinary cards move further right', () => {
    const rail = [box(1000, 40), box(1010, 264)]; // a member nudged slightly
    const others = [box(2000, 0, 300, 200)]; // now to the RIGHT of the rail
    const pos = nextRightRailPosition(others, rail);
    expect(pos.x).toBe(1000); // min rail x, NOT 2300 + gap
  });
});
