import type { Loop, LoopRun } from '../../../../shared/types/loop';
import type { AgentState } from '../../../../shared/types/agentStatus';
import type { Session } from '../../types/session';
import { usePanelStore } from '../../stores/panelStore';
import { useSessionStore } from '../../stores/sessionStore';
import { rollupSessionAgentState } from '../../utils/agentStatus';

export type LoopRunOutcome = 'running' | 'ok' | 'failed' | 'skipped';

export interface LoopRunView {
  run: LoopRun;
  outcome: LoopRunOutcome;
  /** The run's Pane while it still exists. */
  session: Session | undefined;
  /** Start to the Pane's last activity, or to now while it runs. */
  durationMs: number | null;
  /** The run's worktree, which Pane names after its branch. */
  branch: string | null;
}

/**
 * Whether a run Pane is still working: its agent says so, or, for a command
 * Pane with no agent to report, the Pane itself is starting or running.
 */
function isRunning(session: Session, agentState: AgentState): boolean {
  if (agentState === 'working' || agentState === 'blocked') return true;
  if (agentState !== 'unknown') return false;
  return session.status === 'running' || session.status === 'initializing';
}

function viewRun(run: LoopRun, session: Session | undefined, agentState: AgentState, nowMs: number): LoopRunView {
  if (run.status !== 'started') return { run, outcome: run.status, session: undefined, durationMs: null, branch: null };
  const running = session ? isRunning(session, agentState) : false;
  // Only a working run has a trustworthy end (now): a session's lastActivity is not when its agent finished.
  const durationMs = running && nowMs > run.slotAtMs ? nowMs - run.slotAtMs : null;
  const branch = session?.worktreePath ? session.worktreePath.split(/[\\/]/).filter(Boolean).pop() ?? null : null;
  return { run, outcome: running ? 'running' : 'ok', session, durationMs, branch };
}

/** Every run of a loop with its outcome, newest first. Rerenders when a run Pane's status changes. */
export function useLoopRunViews(loop: Loop | undefined): LoopRunView[] {
  const runs = loop?.runs ?? [];
  const sessions = useSessionStore(state => state.sessions);
  // A primitive snapshot keeps the panel-store subscription stable between updates.
  const agentStates = usePanelStore(state => runs
    .map(run => run.sessionId ? rollupSessionAgentState(state.agentStatus, state.agentStatusSession, run.sessionId) : 'unknown')
    .join('|'));
  const states = agentStates.split('|');
  const nowMs = Date.now();
  return runs.map((run, index) => viewRun(
    run,
    run.sessionId ? sessions.find(session => session.id === run.sessionId) : undefined,
    // SAFETY: Each field was produced by rollupSessionAgentState above.
    (states[index] ?? 'unknown') as AgentState,
    nowMs,
  ));
}

/** Whether any run of any loop is working now, for the Loops nav entry. */
export function useAnyLoopRunning(loops: Loop[]): boolean {
  const sessions = useSessionStore(state => state.sessions);
  return usePanelStore(state => loops.some(loop => loop.runs.some(run => {
    if (run.status !== 'started' || !run.sessionId) return false;
    const session = sessions.find(candidate => candidate.id === run.sessionId);
    return session ? isRunning(session, rollupSessionAgentState(state.agentStatus, state.agentStatusSession, run.sessionId)) : false;
  })));
}

const timeFormat: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };

/** "Oct 24 03:00", or "Fri Oct 24 03:00" with the weekday. */
export function formatRunTime(ms: number, withWeekday = false): string {
  const date = new Date(ms);
  const dayFormat: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  if (withWeekday) dayFormat.weekday = 'short';
  const day = date.toLocaleDateString(undefined, dayFormat);
  return `${day.replace(/,/g, '')} ${date.toLocaleTimeString(undefined, timeFormat)}`;
}

/** "12m", "1h 5m", "3d 2h"; under a minute reads "<1m". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

/** "Today 03:00", "Tomorrow 03:00" or "Mon Oct 27 03:00". */
export function formatNextRun(ms: number, nowMs = Date.now()): string {
  const date = new Date(ms);
  const time = date.toLocaleTimeString(undefined, timeFormat);
  const startOfDay = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((startOfDay(date) - startOfDay(new Date(nowMs))) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  return formatRunTime(ms, true);
}

/** A run's outcome in a few words: "running 12m", "ok · 41m", "failed", "skipped". */
export function describeRun(view: LoopRunView): string {
  const duration = view.durationMs === null ? null : formatDuration(view.durationMs);
  if (view.outcome === 'running') return duration ? `running ${duration}` : 'running';
  if (view.outcome === 'ok') return duration ? `ok · ${duration}` : 'ok';
  return view.outcome;
}

/** What a loop runs, as one line: the command, or the agent and its first input. */
export function describeLoopCommand(loop: Pick<Loop, 'agent' | 'toolCommand' | 'initialInput'>): string {
  if (loop.toolCommand) return loop.toolCommand;
  const input = loop.initialInput?.trim();
  return input ? `${loop.agent ?? 'claude'} · "${input}"` : loop.agent ?? 'claude';
}

export const RUN_DOT_CLASS = {
  running: 'bg-status-info',
  ok: 'bg-status-success',
  failed: 'bg-status-error',
  skipped: 'bg-text-muted',
} satisfies Record<LoopRunOutcome, string>;
