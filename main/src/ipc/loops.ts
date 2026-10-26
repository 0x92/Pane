import type { IpcMain } from 'electron';
import type { PaneCommandRegistry, PaneCommandValue } from '../daemon/commandRegistry';
import type { LoopManager } from '../services/loops/loopManager';
import type { StoredLoop } from '../services/loops/loopRepository';
import { previewLoopSchedule } from '../services/loops/loopSchedule';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { LOOP_AGENTS, LOOP_NEW_SESSION, loopInputSchema, loopSlug, type LoopAgent } from '../../../shared/types/loop';
import { ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX } from '../../../shared/types/orchestrationSession';
import { RUNPANE_CONTRACT } from '../../../shared/types/generatedRunpaneContract';
import type { RunpanePaneCreateRequest } from '../../../shared/types/runpaneOrchestration';
import { PaneError } from '../../../shared/paneError';

const LOOP_CHANNELS = [
  'loops:list',
  'loops:save',
  'loops:delete',
  'loops:set-enabled',
  'loops:run-now',
  'loops:preview',
] as const;

/** The parts of the `runpane` results a run reads. */
const failureSchema = boundary.optional(boundary.object({ message: boundary.string }));
// `blocked` is Pane's own prompt detection (`detectPanelBlocker`), as `panels wait` reports it.
const readinessSchema = boundary.optional(boundary.object({ ok: boundary.boolean, reason: failureSchema, blocked: failureSchema }));
type Readiness = ReturnType<typeof readinessSchema.decode>;
const paneCreateResultSchema = boundary.object({
  items: boundary.array(boundary.object({
    ok: boundary.boolean,
    sessionId: boundary.optional(boundary.string),
    error: failureSchema,
    readiness: readinessSchema,
    initialInput: boundary.optional(boundary.object({
      error: failureSchema,
      delivery: boundary.optional(boundary.object({ message: boundary.optional(boundary.string) })),
    })),
  })),
});
/** The folder-trust prompts `detectPanelBlocker` recognises: Claude, Codex and Agent Farm. */
const TRUST_PROMPT = /trust this folder|trust and continue|quick safety check|trust this repository workspace/i;

const paneArchiveResultSchema = boundary.object({ blocked: failureSchema });
const loopSessionSchema = boundary.object({
  session: boundary.object({
    id: boundary.string,
    name: boundary.string,
    agent: boundary.enumeration(...LOOP_AGENTS),
    launchCommand: boundary.optional(boundary.string),
    archived: boundary.optional(boundary.boolean),
    panelIds: boundary.object({ claude: boundary.string, codex: boundary.string, cursor: boundary.string }),
  }),
});
const panelResumeResultSchema = boundary.object({ readiness: readinessSchema });
const panelSubmitResultSchema = boundary.object({ ok: boundary.boolean, blocked: failureSchema });

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
 * Start a loop run. A project loop runs through `runpane panes create`: a new
 * unpinned Pane in a fresh worktree from the project's default base branch.
 * A Session loop sends its prompt to the Session's agent tab.
 *
 * The built-in agent templates launch without permission prompts (`claude
 * --dangerously-skip-permissions`, `codex --yolo`, `cursor-agent --force`),
 * which is what an unattended run needs; the form and the Loops page say so.
 */
export async function startLoopRun(
  commandRegistry: PaneCommandRegistry,
  loop: StoredLoop,
  slotAtMs: number,
): Promise<{ sessionId: string | null; warning?: string }> {
  if (loop.orchestrationSessionId) return sendSessionLoopRun(commandRegistry, loop.orchestrationSessionId, loop.initialInput ?? '');
  const { projectId } = loop;
  if (projectId === undefined) throw new Error('This loop has no project or Session to run in.');
  const slot = new Date(slotAtMs);
  const stamp = `${slot.getFullYear()}${pad(slot.getMonth() + 1)}${pad(slot.getDate())}-${pad(slot.getHours())}${pad(slot.getMinutes())}`;
  const label = `${slot.toLocaleString('en-US', { month: 'short' })} ${slot.getDate()} ${pad(slot.getHours())}:${pad(slot.getMinutes())}`;
  const name = `${loopSlug(loop.name)} · ${label}`;
  const request: RunpanePaneCreateRequest = {
    repo: { id: projectId },
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
  // The Pane exists but was not doing its job at start: the agent was stuck at a prompt, never became ready, or the prompt did not arrive.
  const warning = readinessWarning(item.readiness)
    ?? `Pane could not confirm the prompt was submitted. ${item.error?.message ?? item.initialInput?.error?.message ?? item.initialInput?.delivery?.message ?? ''}`.trim();
  return { sessionId: item.sessionId, warning };
}

/**
 * Why an agent was not ready for its prompt at start, or null when it was.
 * Warnings are written once, so each says what was true when the run started.
 */
function readinessWarning(readiness: Readiness): string | null {
  const blocked = readiness?.blocked?.message;
  if (blocked !== undefined) {
    // Pane never answers trust prompts for an unattended run; the person decides.
    return TRUST_PROMPT.test(blocked)
      ? 'When it started, the run was stopped at the agent\'s folder-trust prompt in its new worktree. '
        + 'If it is still there, open the run and answer it, or trust the project folder in the agent once so later runs start on their own.'
      : 'When it started, the run was stopped at a prompt in its terminal. If it is still there, open the run and answer it.';
  }
  if (readiness?.ok === false) {
    return `When the run started, the agent did not become ready, so Pane could not confirm it got its prompt. ${readiness.reason?.message ?? ''}`.trim();
  }
  return null;
}

async function getLoopSession(commandRegistry: PaneCommandRegistry, target: string) {
  const selector = target.startsWith(ORCHESTRATION_SESSION_INTERNAL_ID_PREFIX) ? { sessionId: target } : { name: target };
  return decodeBoundary(await commandRegistry.invoke('runpane:sessions:get', [selector]), loopSessionSchema).session;
}

/**
 * A Session loop run: start the Session's agent tab if it is stopped, as
 * `runpane panels resume --wait-ready`, then send the prompt as `panels submit`.
 * No Pane, worktree or branch is created. A prompt in the agent's way is
 * reported, never typed into.
 */
async function sendSessionLoopRun(commandRegistry: PaneCommandRegistry, sessionId: string, prompt: string): Promise<{ sessionId: null; warning?: string }> {
  const session = await getLoopSession(commandRegistry, sessionId);
  if (session.archived) throw new Error(`Session ${session.name} is archived, so the prompt was not sent. Restore it, or point the loop at another Session.`);
  const panelId = session.panelIds[session.agent];
  const resumed = decodeBoundary(await commandRegistry.invoke('runpane:panels:resume', [{ panelId, waitReady: true }]), panelResumeResultSchema);
  if (resumed.readiness?.blocked) {
    return { sessionId: null, warning: 'When the run came due, the Session\'s agent was stopped at a prompt, so the loop\'s prompt was not sent. Open the Session and answer it.' };
  }
  // A busy agent queues the prompt, so an agent that is not ready yet still gets it.
  const submitted = decodeBoundary(await commandRegistry.invoke('runpane:panels:submit', [{ panelId, input: prompt, source: 'agent', expectReport: false }]), panelSubmitResultSchema);
  if (submitted.ok) return { sessionId: null };
  return { sessionId: null, warning: `Pane could not confirm the Session's agent got the prompt. ${submitted.blocked?.message ?? ''}`.trim() };
}

/** The flags a built-in agent template launches with, such as `--yolo`. */
function unattendedFlags(agent: LoopAgent): string[] {
  return RUNPANE_CONTRACT.agentTemplates[agent].command.trim().split(/\s+/).slice(1);
}

/**
 * Resolve a Session loop's target and make its Session's agent run `agent`
 * without permission prompts, through `runpane sessions create` and
 * `sessions update`. A Session with no launch command already launches the
 * agent's built-in template; a custom one gets the missing flags added. The
 * change applies the next time the agent starts.
 */
export async function prepareLoopSession(commandRegistry: PaneCommandRegistry, target: string, loop: { name: string; agent: LoopAgent }): Promise<string> {
  const session = target === LOOP_NEW_SESSION
    ? decodeBoundary(await commandRegistry.invoke('runpane:sessions:create', [{ name: loop.name, agent: loop.agent }]), loopSessionSchema).session
    : await getLoopSession(commandRegistry, target);
  if (session.archived) {
    throw new PaneError('ERR_LOOP_INVALID', `Session ${session.name} is archived. Nothing was saved.`, 'Restore the Session first, or pick another one.');
  }
  // Changing the agent drops the old command, so the new agent launches its template.
  if (session.agent !== loop.agent) {
    await commandRegistry.invoke('runpane:sessions:update', [{ selector: { sessionId: session.id }, input: { agent: loop.agent, source: 'user' } }]);
    return session.id;
  }
  const command = session.launchCommand?.trim();
  const words = new Set(command?.split(/\s+/));
  const missing = unattendedFlags(loop.agent).filter(flag => !words.has(flag));
  if (command && missing.length > 0) {
    await commandRegistry.invoke('runpane:sessions:update', [{ selector: { sessionId: session.id }, input: { launchCommand: `${command} ${missing.join(' ')}`, source: 'user' } }]);
  }
  return session.id;
}

/** Archive an old run Pane the way `runpane panes archive` does. False when uncommitted or unpushed work blocked it. */
export async function archiveLoopRun(commandRegistry: PaneCommandRegistry, sessionId: string): Promise<boolean> {
  const result = decodeBoundary(await commandRegistry.invoke('runpane:panes:archive', [{ paneId: sessionId, source: 'agent' }]), paneArchiveResultSchema);
  return result.blocked === undefined;
}
