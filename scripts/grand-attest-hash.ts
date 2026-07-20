// scripts/grand-attest-hash.ts
//
// Prints the deterministic GRAND-INTEGRATION content-hash to stdout (and nothing
// else, so it's shell-substitutable:
//   HASH=$(node --import tsx scripts/grand-attest-hash.ts)).
//
// `--list` prints the resolved basis file set (one per line) instead — for
// debugging "what's in the hash".
//
// See scripts/grand-attest-lib.ts for the basis + algorithm and
// .myrobots/plans/grand-integration-e2e-art-2026-07-19.md for the full design.

import { computeGrandHash, resolveGrandBasis } from './grand-attest-lib';

if (process.argv.includes('--list')) {
  for (const f of resolveGrandBasis()) process.stdout.write(f + '\n');
} else {
  process.stdout.write(computeGrandHash() + '\n');
}
