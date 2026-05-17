// packages/web/src/lib/carl/intent.ts
//
// Intent shape — exactly mirrors e2e/chaos/lib/intent.ts. Kept as a separate
// in-browser copy so packages/web doesn't import from e2e/ (one-way deps).
// Re-test parity: see carl/personality.test.ts.

export type Intent =
  | { kind: 'addNode'; id: string; type: string }
  | {
      kind: 'addEdge';
      id: string;
      sourceNodeId: string;
      sourcePortId: string;
      targetNodeId: string;
      targetPortId: string;
      sourceCableType: string;
      targetCableType: string;
    }
  | { kind: 'setParam'; nodeId: string; paramId: string; value: number }
  | { kind: 'deleteNode'; id: string }
  | { kind: 'deleteEdge'; id: string }
  | { kind: 'sleep'; ms: number };
