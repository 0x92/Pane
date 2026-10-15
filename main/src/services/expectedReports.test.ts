import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { ExpectedReportTracker, MAX_MISSING_REPORT_OUTPUT_LENGTH, type PanelLastOutput } from './expectedReports';
import { WorkspaceJournal } from './workspaceJournal';
import type { TerminalExpectedReport } from '../../../shared/types/panels';

function setup(lastOutput: PanelLastOutput | undefined = { text: 'All done, PR #12 is open.', source: 'transcript' }, filePath?: string) {
  const journal = new WorkspaceJournal({ resolvePane: paneId => ({ paneId, paneName: 'Worker' }), blockedDebounceMs: 0 });
  const reports = new Map<string, string>();
  const tracker = new ExpectedReportTracker({
    journal,
    filePath,
    lastReportAt: panelId => reports.get(panelId),
    lastOutput: async () => lastOutput,
  });
  const expectations = {
    set: (panelId: string, expected: TerminalExpectedReport) => tracker.arm(panelId, expected.since),
    has: (panelId: string) => tracker.expectation(panelId) !== undefined,
  };
  const ready = () => journal.append({ kind: 'agent.ready', paneId: 'pane-1', paneName: 'Worker', panelId: 'panel-1', agentType: 'claude', source: 'agent' });
  const missing = () => journal.readAfter(0, { kinds: ['agent.report.missing'] }).entries;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  return { journal, expectations, reports, tracker, ready, missing, settle };
}

describe('ExpectedReportTracker', () => {
  it('journals agent.report.missing with the last reply when an expected report never came', async () => {
    const { expectations, ready, missing, settle } = setup();
    expectations.set('panel-1', { since: '2026-10-15T10:00:00.000Z' });
    ready();
    await settle();

    expect(missing()).toEqual([expect.objectContaining({
      kind: 'agent.report.missing',
      paneId: 'pane-1',
      panelId: 'panel-1',
      agentType: 'claude',
      reason: 'ready',
      expectedSince: '2026-10-15T10:00:00.000Z',
      lastOutput: 'All done, PR #12 is open.',
      lastOutputSource: 'transcript',
    })]);
    // One missing report per expectation.
    expect(expectations.has('panel-1')).toBe(false);
    ready();
    await settle();
    expect(missing()).toHaveLength(1);
  });

  it('stays quiet when the agent reported after the work was sent', async () => {
    const { expectations, reports, ready, missing, settle } = setup();
    expectations.set('panel-1', { since: '2026-10-15T10:00:00.000Z' });
    reports.set('panel-1', '2026-10-15T10:05:00.000Z');
    ready();
    await settle();

    expect(missing()).toEqual([]);
    expect(expectations.has('panel-1')).toBe(false);
  });

  it('treats a report from before the work was sent as missing', async () => {
    const { expectations, reports, journal, missing, settle } = setup({ text: 'line one\nline two', source: 'screen' });
    expectations.set('panel-1', { since: '2026-10-15T10:00:00.000Z' });
    reports.set('panel-1', '2026-10-15T09:00:00.000Z');
    journal.append({ kind: 'panel.exited', paneId: 'pane-1', paneName: 'Worker', panelId: 'panel-1', source: 'exit' });
    await settle();

    expect(missing()).toEqual([expect.objectContaining({ reason: 'exited', lastOutput: 'line one\nline two', lastOutputSource: 'screen' })]);
  });

  it('clears the expectation when the report arrives', async () => {
    const { expectations, journal, settle } = setup();
    expectations.set('panel-1', { since: '2026-10-15T10:00:00.000Z' });
    journal.append({ kind: 'agent.report', paneId: 'pane-1', paneName: 'Worker', panelId: 'panel-1', source: 'agent' });
    await settle();

    expect(expectations.has('panel-1')).toBe(false);
  });

  it('keeps the end of a long reply', async () => {
    const text = `${'x'.repeat(5_000)}THE END`;
    const { expectations, ready, missing, settle } = setup({ text, source: 'transcript' });
    expectations.set('panel-1', { since: '2026-10-15T10:00:00.000Z' });
    ready();
    await settle();

    const [entry] = missing();
    expect(entry.lastOutput).toHaveLength(MAX_MISSING_REPORT_OUTPUT_LENGTH);
    expect(entry.lastOutput?.endsWith('THE END')).toBe(true);
  });

  it('keeps expectations across a restart and forgets them once raised', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-expected-'));
    try {
      const filePath = path.join(directory, 'expected-reports.json');
      setup(undefined, filePath).tracker.arm('panel-1', '2026-10-15T10:00:00.000Z');

      const restarted = setup(undefined, filePath);
      expect(restarted.tracker.expectation('panel-1')).toEqual({ since: '2026-10-15T10:00:00.000Z' });
      restarted.ready();
      await restarted.settle();
      expect(restarted.missing()).toHaveLength(1);

      const again = setup(undefined, filePath);
      again.ready();
      await again.settle();
      expect(again.missing()).toEqual([]);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ignores panels nobody expects a report from', async () => {
    const { ready, missing, settle } = setup();
    ready();
    await settle();

    expect(missing()).toEqual([]);
  });
});
