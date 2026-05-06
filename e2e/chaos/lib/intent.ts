// Intent types — what a personality emits per tick. The driver consumes
// these and applies them to the patch graph. Keeping intents as plain data
// (vs. function calls) means we can serialize them into the artifact trace
// for replay.

export type Intent =
  | { kind: 'addNode'; id: string; type: string }
  | { kind: 'addEdge'; id: string; sourceNodeId: string; sourcePortId: string; targetNodeId: string; targetPortId: string; sourceCableType: string; targetCableType: string }
  | { kind: 'setParam'; nodeId: string; paramId: string; value: number }
  | { kind: 'deleteNode'; id: string }
  | { kind: 'deleteEdge'; id: string }
  | { kind: 'sleep'; ms: number };
