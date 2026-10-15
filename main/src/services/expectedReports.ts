import type { WorkspaceJournal } from './workspaceJournal';
import type { RunpaneWorkspaceEntry } from '../../../shared/types/runpaneOrchestration';
import type { TerminalExpectedReport } from '../../../shared/types/panels';

/**
 * Expected reports (`--expect-report`): work sent to an agent panel can say its sender waits for a
 * `runpane report`. When that agent goes ready or exits without reporting, the tracker journals an
 * `agent.report.missing` entry carrying what the agent said last, so a worker that finished silently
 * still reaches its orchestrator.
 */

/** An `agent.report.missing` entry carries at most this much of the agent's last output. */
export const MAX_MISSING_REPORT_OUTPUT_LENGTH = 2_000;
const TRUNCATION_MARKER = '[earlier output cut]\n';

export interface PanelLastOutput {
  text: string;
  source: 'transcript' | 'screen';
}

export interface ExpectedReportTrackerOptions {
  journal: WorkspaceJournal;
  /** The panel's pending expectation. */
  readExpectation(panelId: string): TerminalExpectedReport | undefined;
  /** Removes the panel's expectation. */
  clearExpectation(panelId: string): Promise<void>;
  /** When the panel last ran `runpane report`. */
  lastReportAt(panelId: string): string | undefined;
  /** The agent's last reply, or else the last lines on its screen. */
  lastOutput(panelId: string): Promise<PanelLastOutput | undefined>;
  log?: (message: string, error: Error) => void;
}

export class ExpectedReportTracker {
  private readonly raising = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly options: ExpectedReportTrackerOptions) {
    this.unsubscribe = options.journal.subscribe(entry => this.observe(entry));
  }

  dispose(): void {
    this.unsubscribe();
  }

  private observe(entry: RunpaneWorkspaceEntry): void {
    const panelId = entry.panelId;
    if (!panelId || entry.replay) return;
    if (entry.kind === 'agent.report') {
      if (this.options.readExpectation(panelId)) this.clear(panelId);
      return;
    }
    if (entry.kind !== 'agent.ready' && entry.kind !== 'panel.exited') return;
    const expected = this.options.readExpectation(panelId);
    if (!expected || this.raising.has(panelId)) return;
    if (this.fulfilled(panelId, expected)) {
      this.clear(panelId);
      return;
    }
    this.raising.add(panelId);
    void this.raise(entry, panelId, expected)
      .catch(error => this.options.log?.('[ExpectedReports] Could not journal a missing report', asError(error)))
      .finally(() => this.raising.delete(panelId));
  }

  private async raise(entry: RunpaneWorkspaceEntry, panelId: string, expected: TerminalExpectedReport): Promise<void> {
    // One missing report per expectation: the next `--expect-report` dispatch arms it again.
    await this.options.clearExpectation(panelId);
    const output = await this.options.lastOutput(panelId).catch(() => undefined);
    // A report that landed while the output was read wins.
    if (this.fulfilled(panelId, expected)) return;
    const missing: Parameters<WorkspaceJournal['appendPaneEntry']>[1] = {
      kind: 'agent.report.missing',
      panelId,
      panelTitle: entry.panelTitle,
      agentType: entry.agentType,
      source: 'agent',
      reason: entry.kind === 'panel.exited' ? 'exited' : 'ready',
      expectedSince: expected.since,
    };
    const text = output?.text.trim();
    if (output && text) {
      missing.lastOutput = boundOutput(text);
      missing.lastOutputSource = output.source;
    }
    this.options.journal.appendPaneEntry(entry.paneId, missing);
  }

  private fulfilled(panelId: string, expected: TerminalExpectedReport): boolean {
    const reportedAt = this.options.lastReportAt(panelId);
    return reportedAt !== undefined && Date.parse(reportedAt) >= Date.parse(expected.since);
  }

  private clear(panelId: string): void {
    this.options.clearExpectation(panelId)
      .catch(error => this.options.log?.('[ExpectedReports] Could not clear an expected report', asError(error)));
  }
}

function asError(error: Error | string): Error {
  return error instanceof Error ? error : new Error(error);
}

/** Keeps the end of the output, where the agent's conclusion is. */
function boundOutput(text: string): string {
  if (text.length <= MAX_MISSING_REPORT_OUTPUT_LENGTH) return text;
  return `${TRUNCATION_MARKER}${text.slice(text.length - (MAX_MISSING_REPORT_OUTPUT_LENGTH - TRUNCATION_MARKER.length))}`;
}
