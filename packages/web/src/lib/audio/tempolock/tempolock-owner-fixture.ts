// packages/web/src/lib/audio/tempolock/tempolock-owner-fixture.ts
//
// THE OWNER'S REAL ONSET TRAIN — the recording this module exists for,
// checked in as a canonical fixture (tempolock-tracker.test.ts).
//
// Provenance (carried verbatim from the extraction's JSON header):
//   source:       WAVY-001-20260829-114805.mp4, owner recording, stated 108 BPM
//   detector:     synesthesia OnsetDetector replica, band<200Hz
//   expected_bpm: 108
//   measured_fold: 107.72 (blind base-pulse fold over the full train)
//
// 179 low-band onset timestamps (seconds) across ~54.3 s. The inter-onset
// intervals sit on a SIXTEENTH grid in a recurring 3-1-2-2 pattern — NOT the
// idealized 4-2-2 kick pattern: an extra low-band onset (a bass note or kick
// ghost) splits one of the quarter gaps every bar. The tracker must hold one
// lock THROUGH that extra onset, which is exactly why this fixture is
// checked in rather than only the synthetic one.
//
// ⚠ THE FILE PLAYS 4% SLOW: the train's true grid is 103.68 BPM = 108 ×
// 24/25 exactly — a fps-family rate conversion on the mp4, not a property of
// the music. The `measuredFold` of 107.72 recorded below came from an
// absolute-grid regression whose residuals (σ ≈ 40 ms on a 139 ms grid)
// invalidate its own integer assignment; the full instrument-validation
// argument, with the two clean local instruments that agree on 103.68, lives
// on fixture 8 in tempolock-tracker.test.ts. Both numbers are kept here as
// PROVENANCE — the test asserts the true grid AND that × 25/24 recovers the
// owner's stated 108.
//
// A last-two-edges follower over this train swings 104..480 BPM (4.6x) — the
// documented reason this module exists, pinned as the negative control.

export const TEMPOLOCK_OWNER_FIXTURE = {
  source: 'WAVY-001-20260829-114805.mp4, owner recording, stated 108 BPM',
  detector: 'synesthesia OnsetDetector replica, band<200Hz',
  expectedBpm: 108,
  measuredFold: 107.72,
  onsetsS: [
    0.0074, 0.4163, 0.7014, 0.9892, 1.42, 1.5622, 1.854, 2.1463,
    2.5786, 2.7224, 3.0108, 3.3028, 3.7357, 3.876, 4.1697, 4.4593,
    4.8921, 5.0382, 5.3277, 5.6194, 6.0534, 6.1975, 6.4873, 6.7808,
    7.2107, 7.3571, 7.647, 7.9415, 8.374, 8.5164, 8.8074, 9.1019,
    9.5324, 9.6778, 9.9681, 10.2618, 10.6929, 10.8365, 11.1282, 11.4232,
    11.8682, 11.9936, 12.2854, 12.5809, 13.0147, 13.1584, 13.4506, 13.7425,
    14.1742, 14.3174, 14.6046, 14.8995, 15.4754, 15.7675, 16.0622, 16.493,
    16.637, 16.9284, 17.221, 17.656, 17.7986, 18.0887, 18.3818, 18.8122,
    18.9572, 19.2477, 19.5399, 20.1111, 20.4017, 20.6964, 21.1271, 21.27,
    21.5606, 21.8542, 22.286, 22.429, 22.721, 23.0141, 23.4439, 23.5904,
    23.8789, 24.1735, 24.7478, 25.04, 25.3341, 25.7548, 25.9059, 26.1979,
    26.4916, 26.9251, 27.0674, 27.357, 27.6517, 28.0834, 28.2284, 28.5185,
    28.8143, 29.3892, 29.6789, 29.9713, 30.4023, 30.5473, 30.8406, 31.1344,
    31.5685, 31.7112, 32.0017, 32.2926, 32.7245, 32.8698, 33.161, 33.4524,
    33.8859, 34.029, 34.3174, 34.6127, 35.0585, 35.1834, 35.4763, 35.7689,
    36.2028, 36.3466, 36.6382, 36.9329, 37.3648, 37.5072, 37.7969, 38.09,
    38.6642, 38.9569, 39.2477, 39.6787, 39.8245, 40.1166, 40.4101, 40.8442,
    40.9847, 41.2789, 41.57, 42.0002, 42.1458, 42.4382, 42.7291, 43.1626,
    43.3055, 43.6024, 43.893, 44.3255, 44.47, 44.7594, 45.0517, 45.6217,
    45.9162, 46.2049, 46.6366, 46.781, 47.0714, 47.3654, 47.9362, 48.2266,
    48.5192, 48.9429, 49.091, 49.3871, 49.6787, 50.2504, 50.5403, 50.8311,
    51.2622, 51.406, 51.6975, 51.9926, 52.5629, 52.8526, 53.1464, 53.5766,
    53.7201, 54.0086, 54.3036,  ],
} as const;
