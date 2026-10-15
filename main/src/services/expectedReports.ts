import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { boundary, decodeBoundary, decodeOptionalBoundary } from '../../../shared/validation/boundaryDecoder';
import type { WorkspaceJournal } from './workspaceJournal';
import type { RunpaneWorkspaceEntry } from '../../../shared/types/runpaneOrchestration';
import type { TerminalExpectedReport } from '../../../shared/types/panels';

/**
 * Expected reports (`--expect-report`): work sent to an agent panel can say its sender waits for a
 * `runpane report`. When that agent goes ready or exits without reporting, the tracker journals an
 * `agent.report.missing` entry carrying what the agent said last, so a worker that finished silently
 * still reaches its orchestrator.
 *
 * Expectations live in their own file (`expected-reports.json`), written only here. Panel state is
 * rewritten from snapshots elsewhere, so a cleared expectation kept there could come back.
 */

/** An `agent.report.missing` entry carries at most this much of the agent's last output. */
export const MAX_MISSING_REPORT_OUTPUT_LENGTH = 2_000;
const TRUNCATION_MARKER = '[earlier output cut]\n';

const expectationsFileSchema = boundary.object({
  version: boundary.literal(1),
  expectations: boundary.jsonObject,
});
const expectationSchema = boundary.object({ since: boundary.nonEmptyString });

export interface PanelLastOutput {
  text: string;
  source: 'transcript' | 'screen';
}

export interface ExpectedReportTrackerOptions {
  journal: WorkspaceJournal;
  /** Where expectations are saved; omitted, they live in memory only. */
  filePath?: string;
  /** When the panel last ran `runpane report`. */
  lastReportAt(panelId: string): string | undefined;
  /** The agent's last reply, or else the last lines on its screen. */
  lastOutput(panelId: string): Promise<PanelLastOutput | undefined>;
  /** False for a panel that no longer exists; its saved expectation is dropped on load. */
  panelExists?: (panelId: string) => boolean;
  log?: (message: string, error: Error) => void;
}

export class ExpectedReportTracker {
  private readonly expectations = new Map<string, TerminalExpectedReport>();
  private readonly raising = new Set<string>();
  private readonly unsubscribe: () => void;
  private loaded = false;

  constructor(private readonly options: ExpectedReportTrackerOptions) {
    this.unsubscribe = options.journal.subscribe(entry => this.observe(entry));
  }

  dispose(): void {
    this.unsubscribe();
  }

  /** Records that the sender of the panel's work, sent at `since`, waits for a report. */
  arm(panelId: string, since: string): TerminalExpectedReport {
    this.ensureLoaded();
    const expected = { since };
    this.expectations.set(panelId, expected);
    this.persist();
    return { ...expected };
  }

  /** The report the panel's sender waits for, if any. */
  expectation(panelId: string): TerminalExpectedReport | undefined {
    this.ensureLoaded();
    const expected = this.expectations.get(panelId);
    return expected ? { ...expected } : undefined;
  }

  private observe(entry: RunpaneWorkspaceEntry): void {
    const panelId = entry.panelId;
    if (!panelId || entry.replay) return;
    if (entry.kind === 'agent.report') {
      this.clear(panelId);
      return;
    }
    if (entry.kind !== 'agent.ready' && entry.kind !== 'panel.exited') return;
    const expected = this.expectation(panelId);
    if (!expected || this.raising.has(panelId)) return;
    // One missing report per expectation: the next `--expect-report` dispatch arms it again.
    this.clear(panelId);
    if (this.fulfilled(panelId, expected)) return;
    this.raising.add(panelId);
    void this.raise(entry, panelId, expected)
      .catch(error => this.options.log?.('[ExpectedReports] Could not journal a missing report', asError(error)))
      .finally(() => this.raising.delete(panelId));
  }

  private async raise(entry: RunpaneWorkspaceEntry, panelId: string, expected: TerminalExpectedReport): Promise<void> {
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
    this.ensureLoaded();
    if (this.expectations.delete(panelId)) this.persist();
  }

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.options.filePath) return;
    try {
      const parsed = decodeBoundary(JSON.parse(fs.readFileSync(this.options.filePath, 'utf8')), expectationsFileSchema);
      for (const [panelId, value] of Object.entries(parsed.expectations)) {
        const expected = decodeOptionalBoundary(value, expectationSchema);
        if (expected && this.options.panelExists?.(panelId) !== false) this.expectations.set(panelId, expected);
      }
    } catch (error) {
      const details = decodeOptionalBoundary(error, boundary.object({ code: boundary.optional(boundary.string) }));
      if (details?.code !== 'ENOENT') this.options.log?.('[ExpectedReports] Ignoring an unreadable expectations file', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private persist(): void {
    const filePath = this.options.filePath;
    if (!filePath) return;
    const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const payload = { version: 1, expectations: Object.fromEntries(this.expectations) };
      fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      this.options.log?.('[ExpectedReports] Could not save expectations; they stay in memory', error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    }
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
