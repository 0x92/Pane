import { boundary } from '../validation/boundaryDecoder';
import type { BoundarySchema } from '../validation/boundaryDecoder';

/**
 * Loops (scheduled tasks): a cron schedule plus the request `runpane panes
 * create` takes. Each run is a new Pane in a fresh worktree.
 *
 * Loops are for large recurring jobs and run at most once an hour. Agents that
 * only need to wait a few minutes use their own harness's sleep and wake.
 */

export const LOOP_AGENTS = ['claude', 'codex', 'cursor'] as const;
export type LoopAgent = typeof LOOP_AGENTS[number];

/** What a loop stores and can be saved with. Exactly one of `agent` or `toolCommand`. */
export interface LoopInput {
  /** Present when updating an existing loop. */
  id?: string;
  name: string;
  projectId: number;
  /** Five-field cron, in the host machine's local time zone. */
  cron: string;
  agent?: LoopAgent;
  /** A custom command to run instead of a built-in agent, as `--tool-command`. */
  toolCommand?: string;
  /** Sent to the agent or command as its first input. */
  initialInput?: string;
  /** Worktree and branch name template; defaults to `loop-<name>`. */
  worktreeTemplate?: string;
  enabled: boolean;
}

export type LoopRunTrigger = 'schedule' | 'manual';

/**
 * `started`: the run's Pane was created (whether its agent is still working is
 * read from the Pane). `failed`: Pane creation failed. `skipped`: the slot came
 * and went while Pane was not running.
 */
export type LoopRunStatus = 'started' | 'failed' | 'skipped';

export interface LoopRun {
  id: string;
  loopId: string;
  /** The schedule slot this run is for; the click time for a manual run. */
  slotAtMs: number;
  trigger: LoopRunTrigger;
  status: LoopRunStatus;
  error: string | null;
  /** The run's Pane, once created. */
  sessionId: string | null;
}

export interface Loop extends Omit<LoopInput, 'id'> {
  id: string;
  createdAtMs: number;
  /** Computed from the cron on read; null while paused. */
  nextRunAtMs: number | null;
  /** The schedule as a sentence, such as "Every day at 03:00". */
  scheduleText: string;
  /** Newest first, at most `LOOP_KEPT_RUNS`. */
  runs: LoopRun[];
}

/** `loops:preview`: what a cron means, for the form. */
export type LoopSchedulePreview =
  | { ok: true; scheduleText: string; nextRunAtMs: number; /** The next three runs, soonest first. */ nextRunsAtMs: number[] }
  | { ok: false; error: string };

export const loopInputSchema = boundary.object({
  id: boundary.optional(boundary.string),
  name: boundary.string,
  projectId: boundary.number,
  cron: boundary.string,
  agent: boundary.optional(boundary.enumeration(...LOOP_AGENTS)),
  toolCommand: boundary.optional(boundary.string),
  initialInput: boundary.optional(boundary.string),
  worktreeTemplate: boundary.optional(boundary.string),
  enabled: boundary.boolean,
}) satisfies BoundarySchema<LoopInput>;

/** The shortest allowed gap between two runs of one loop. */
export const LOOP_MIN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * A run up to this late still starts. A later one is recorded as skipped:
 * missed runs are never caught up.
 */
export const LOOP_MISS_GRACE_MS = 15 * 60 * 1000;

/** Run Panes kept per loop; older ones are archived. */
export const LOOP_KEPT_RUNS = 10;
