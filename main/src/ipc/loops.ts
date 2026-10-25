import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { LoopManager } from '../services/loops/loopManager';
import type { StoredLoop } from '../services/loops/loopRepository';
import { previewLoopSchedule } from '../services/loops/loopSchedule';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { loopInputSchema, loopSlug } from '../../../shared/types/loop';
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
    // `blocked` is Pane's own prompt detection (`detectPanelBlocker`), as `panels wait` reports it.
    readiness: boundary.optional(boundary.object({ ok: boundary.boolean, reason: failureSchema, blocked: failureSchema })),
    initialInput: boundary.optional(boundary.object({
      error: failureSchema,
      delivery: boundary.optional(boundary.object({ message: boundary.optional(boundary.string) })),
    })),
  })),
});
/** The folder-trust prompts `detectPanelBlocker` recognises: Claude, Codex and Agent Farm. */
const TRUST_PROMPT = /trust this folder|trust and continue|quick safety check|trust this repository workspace/i;

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
 * Loops (scheduled tasks) for the app. Daemon-owned like `sessions:*`, so the
 * UI and paired remote clients use them with the same access. `runpane loops`
 * uses the `runpane:loops:*` handlers in `runpane.ts`.
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
  const label = `${slot.toLocaleString('en-US', { month: 'short' })} ${slot.getDate()} ${pad(slot.getHours())}:${pad(slot.getMinutes())}`;
  const name = `${loopSlug(loop.name)} · ${label}`;
  const request: RunpanePaneCreateRequest = {
    repo: { id: loop.projectId },
    noFocus: true,
    // Wait for the agent so the prompt's delivery is checked, and a run that never got it says so.
    waitReady: Boolean(loop.initialInput),
    panes: [{
      name,
      worktreeName: `${loopSlug(loop.worktreeTemplate ?? `loop-${loop.name}`)}-${stamp}`,
      pinned: false,
      tool: loop.toolCommand
        ? { command: loop.toolCommand, initialInput: loop.initialInput }
        : { agent: loop.agent ?? 'claude', initialInput: loop.initialInput },
    }],
  };
  const result = decodeBoundary(await commandRegistry.invoke('runpane:panes:create', [request]), paneCreateResultSchema);
  const item = result.items[0];
  if (!item?.sessionId) throw new Error(item?.error?.message ?? 'Pane creation returned no Pane.');
  // `panes create` names a Pane after its worktree when given one; label the run by loop and slot.
  // A failed rename leaves the worktree's name; the run itself started.
  await commandRegistry.invoke('runpane:panes:rename', [{ paneId: item.sessionId, name }]).catch(() => undefined);
  if (item.ok) return { sessionId: item.sessionId };
  // The Pane exists but is not doing its job: the agent is stuck at a prompt, never became ready, or the prompt did not arrive.
  const blocked = item.readiness?.blocked?.message;
  if (blocked !== undefined) {
    // Pane never answers trust prompts for an unattended run; the person decides.
    const warning = TRUST_PROMPT.test(blocked)
      ? 'The run is waiting at the agent\'s folder-trust prompt in its new worktree, so it has not started. '
        + 'Open the run and answer it, or open the project folder in the agent once and trust it so later runs start on their own.'
      : 'The run is waiting at a prompt in its terminal, so it has not started. Open the run and answer it.';
    return { sessionId: item.sessionId, warning };
  }
  if (item.readiness?.ok === false) {
    return { sessionId: item.sessionId, warning: `The agent did not become ready, so Pane could not confirm it got its prompt. ${item.readiness.reason?.message ?? ''}`.trim() };
  }
  const detail = item.error?.message ?? item.initialInput?.error?.message ?? item.initialInput?.delivery?.message;
  return { sessionId: item.sessionId, warning: `Pane could not confirm the prompt was submitted. ${detail ?? ''}`.trim() };
}

/** Archive an old run Pane the way `runpane panes archive` does; unsaved work blocks it. */
export async function archiveLoopRun(commandRegistry: PaneCommandRegistry, sessionId: string): Promise<void> {
  const result = decodeBoundary(await commandRegistry.invoke('runpane:panes:archive', [{ paneId: sessionId, source: 'agent' }]), paneArchiveResultSchema);
  if (!result.ok) throw new Error(result.blocked?.message ?? 'archive was refused');
}
