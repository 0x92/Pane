// Mounted terminals register their existing masked snapshot refresh. Hidden
// panels mark themselves stale and defer their expensive replay until shown.
const terminals = new Map<string, () => Promise<void>>();

export function registerRemoteTerminalRestore(panelId: string, restore: () => Promise<void>): () => void {
  terminals.set(panelId, restore);
  return () => { if (terminals.get(panelId) === restore) terminals.delete(panelId); };
}

export async function restoreRemoteTerminals(): Promise<void> {
  // A single panel failure stays on that panel; it must not discard the workspace.
  await Promise.allSettled([...terminals.values()].map(restore => restore()));
}
