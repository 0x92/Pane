import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { LoopManager } from '../services/loops/loopManager';
import type { StoredLoop } from '../services/loops/loopRepository';
import { previewLoopSchedule } from '../services/loops/loopSchedule';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { loopInputSchema } from '../../../shared/types/loop';
import type { RunpanePaneCreateRequest } from '../../../shared/types/runpaneOrchestration';

const LOOP_CHANNELS = [
  'loops:list',
  'loops:save',
  'loops:delete',
  'loops:set-enabled',
  'loops:run-now',
  'loops:preview',
] as const;

/** The parts of `runpane panes create` and `panes archive` results a run reads. */
const failureSchema = boundary.optional(boundary.object({ message: boundary.string }));
const paneCreateResultSchema = boundary.object({
  items: boundary.array(boundary.object({
    ok: boundary.boolean,
    sessionId: boundary.optional(boundary.string),
    error: failureSchema,
  })),
});
const paneArchiveResultSchema = boundary.object({ ok: boundary.boolean, blocked: failureSchema });

type LoopResponse<T> = { success: true; data?: T } | { success: false; error: string };

async function respond<T>(work: () => T | Promise<T>): Promise<LoopResponse<T>> {
  try {
    return { success: true, data: await work() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Loops (scheduled tasks). Daemon-owned like `sessions:*`: the UI, `runpane
 * loops` and paired remote clients all use these channels, with the same access.
 */
export function registerLoopHandlers(ipcMain: IpcMain, loopManager: LoopManager, commandRegistry: PaneCommandRegistry): void {
  commandRegistry.register('loops:list', () => respond(() => loopManager.list()));
  commandRegistry.register('loops:save', (value: PaneCommandValue) =>
    respond(() => loopManager.save(decodeBoundary(value, loopInputSchema))));
  commandRegistry.register('loops:delete', (id: PaneCommandValue) =>
    respond(() => loopManager.delete(decodeBoundary(id, boundary.string))));
  commandRegistry.register('loops:set-enabled', (id: PaneCommandValue, enabled: PaneCommandValue) =>
    respond(() => loopManager.setEnabled(decodeBoundary(id, boundary.string), decodeBoundary(enabled, boundary.boolean))));
  commandRegistry.register('loops:run-now', (id: PaneCommandValue) =>
    respond(() => loopManager.runNow(decodeBoundary(id, boundary.string))));
  commandRegistry.register('loops:preview', (cron: PaneCommandValue) =>
    respond(() => previewLoopSchedule(decodeBoundary(cron, boundary.string), Date.now())));
  commandRegistry.bindChannels(ipcMain, LOOP_CHANNELS);
}

/** `ab Cd!` → `ab-cd`, for Pane and worktree names. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'loop';
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Start a loop run through `runpane panes create`: a new pinned-off Pane in a
 * fresh worktree from the project's default base branch.
 *
 * The built-in agent templates launch without permission prompts (`claude
 * --dangerously-skip-permissions`, `codex --yolo`, `cursor-agent --force`),
 * which is what an unattended run needs; the form and the run Pane say so.
 */
export async function startLoopRun(
  commandRegistry: PaneCommandRegistry,
  loop: StoredLoop,
  slotAtMs: number,
): Promise<{ sessionId: string; warning?: string }> {
  const slot = new Date(slotAtMs);
  const stamp = `${slot.getFullYear()}${pad(slot.getMonth() + 1)}${pad(slot.getDate())}-${pad(slot.getHours())}${pad(slot.getMinutes())}`;
  const label = slot.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const request: RunpanePaneCreateRequest = {
    repo: { id: loop.projectId },
    noFocus: true,
    panes: [{
      name: `${slug(loop.name)} · ${label}`,
      worktreeName: `${slug(loop.worktreeTemplate ?? `loop-${loop.name}`)}-${stamp}`,
      pinned: false,
      tool: loop.toolCommand
        ? { command: loop.toolCommand, initialInput: loop.initialInput }
        : { agent: loop.agent ?? 'claude', initialInput: loop.initialInput },
    }],
  };
  const result = decodeBoundary(await commandRegistry.invoke('runpane:panes:create', [request]), paneCreateResultSchema);
  const item = result.items[0];
  if (!item?.sessionId) throw new Error(item?.error?.message ?? 'Pane creation returned no Pane.');
  return item.ok || !item.error ? { sessionId: item.sessionId } : { sessionId: item.sessionId, warning: item.error.message };
}

/** Archive an old run Pane the way `runpane panes archive` does; unsaved work blocks it. */
export async function archiveLoopRun(commandRegistry: PaneCommandRegistry, sessionId: string): Promise<void> {
  const result = decodeBoundary(await commandRegistry.invoke('runpane:panes:archive', [{ paneId: sessionId, source: 'agent' }]), paneArchiveResultSchema);
  if (!result.ok) throw new Error(result.blocked?.message ?? 'archive was refused');
}
