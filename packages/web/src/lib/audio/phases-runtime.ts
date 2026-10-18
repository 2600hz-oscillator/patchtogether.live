export type PhasesMode = 'loop' | 'reverse';
type SetMode = (name: PhasesMode, value: boolean) => void;

const liveModes = new Map<string, SetMode[]>();

export function registerPhasesRuntimeMode(nodeId: string, setMode: SetMode): () => void {
  const handlers = liveModes.get(nodeId) ?? [];
  handlers.push(setMode);
  liveModes.set(nodeId, handlers);
  return () => {
    const index = handlers.indexOf(setMode);
    if (index < 0) return;
    handlers.splice(index, 1);
    if (handlers.length === 0) liveModes.delete(nodeId);
  };
}

/** Delivers a deliberate button press even when its saved param is unchanged. */
export function setPhasesRuntimeMode(nodeId: string, name: PhasesMode, value: boolean): boolean {
  const setMode = liveModes.get(nodeId)?.at(-1);
  if (!setMode) return false;
  setMode(name, value);
  return true;
}
