// scripts/collab-attest-hash.ts
//
// Prints the deterministic @collab content-hash to stdout (and nothing else, so
// it's shell-substitutable: HASH=$(node --import tsx scripts/collab-attest-hash.ts)).
//
// `--list` prints the resolved basis file set (one per line) instead — for
// debugging "what's in the hash".
//
// See scripts/collab-attest-lib.ts for the basis + algorithm and
// .myrobots/plans/collab-attest-2026-06-15.md for the full design.

import { computeCollabHash, resolveCollabBasis } from './collab-attest-lib';

if (process.argv.includes('--list')) {
  for (const f of resolveCollabBasis()) process.stdout.write(f + '\n');
} else {
  process.stdout.write(computeCollabHash() + '\n');
}
