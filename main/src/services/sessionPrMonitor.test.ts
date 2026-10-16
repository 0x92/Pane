import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionPrMonitor } from './sessionPrMonitor';
import { GithubWatchError, githubPrKey, type GithubPrDetails } from './githubWatchClient';
import { WorkspaceJournal } from './workspaceJournal';

const url = 'https://github.com/acme/app/pull/7';
const check = (name: string, status = 'COMPLETED', conclusion = 'SUCCESS', isRequired = true) => ({ __typename: 'CheckRun', name, status, conclusion, isRequired });
const details = (): GithubPrDetails => ({ number: 7, url, state: 'OPEN', mergeable: 'MERGEABLE', headRefOid: 'a'.repeat(40), checks: [], complete: true, comments: [], reviews: [], mergeStateStatus: 'CLEAN' });
function setup(filePath?: string) {
  let pr = details();
  let error: GithubWatchError | undefined;
  let reads = 0;
  let now = 1000;
  let archived = false;
  const journal = new WorkspaceJournal({ filePath });
  const monitor = new SessionPrMonitor({
    sessions: { activeMemberPaneIds: () => [] },
    // SAFETY: The monitor needs only existence/archive state for explicit registrations.
    panes: { getSession: () => ({ archived }) as never },
    now: () => now,
    gitStatus: { getCachedStatus: () => null, lookupPrForPane: async () => undefined },
    journal,
    client: {
      fingerprints: async targets => { if (error) throw error; return new Map(targets.map(target => [githubPrKey(target), JSON.stringify(pr)])); },
      details: async () => { reads++; return pr; },
    },
  });
  return { monitor, journal, advance: () => { now += 3600001; }, archive: () => { archived = true; }, set: (value: Partial<GithubPrDetails>) => { pr = { ...pr, ...value }; }, fail: (value?: GithubWatchError) => { error = value; }, reads: () => reads };
}

describe('PR monitoring through the journal', () => {
  it('recovers Session discovery, keeps an explicit watch alongside it, and rediscovers a reopened PR', async () => {
    let unavailable = true;
    let now = 1000;
    let state = 'OPEN';
    const journal = new WorkspaceJournal();
    const monitor = new SessionPrMonitor({
      sessions: { activeMemberPaneIds: () => ['worker'] },
      // SAFETY: Discovery and monitoring only read existence/archive state here.
      panes: { getSession: () => ({ archived: false }) as never },
      now: () => now, journal,
      gitStatus: { getCachedStatus: () => null, lookupPrForPane: async () => unavailable
        ? { ok: false, error: new Error('unavailable') }
        : { ok: true, pr: { prState: 'OPEN', prUrl: url } } },
      client: { fingerprints: async targets => new Map(targets.map(target => [githubPrKey(target), state])),
        details: async target => ({ ...details(), number: target.number, state }) },
    });
    monitor.watch('worker', 'https://github.com/acme/other/pull/7');
    await monitor.pollOnce(); await monitor.pollOnce();
    expect(journal.readAfter(0, { kinds: ['github.unavailable'] }).entries).toHaveLength(1);
    unavailable = false; now += 3600001;
    await monitor.pollOnce();
    expect(monitor.list()).toHaveLength(2);
    expect(journal.readAfter(0, { kinds: ['github.recovered'] }).entries).toHaveLength(1);
    state = 'CLOSED'; await monitor.pollOnce();
    state = 'OPEN'; await monitor.pollOnce();
    expect(monitor.list().find(record => !record.explicit)?.stopped).toBeUndefined();
  });

  it('reports a stale supplied pin on the first read without accepting the newer checks', async () => {
    const s = setup(); s.monitor.watch('worker', url, 'b'.repeat(40));
    s.set({ checks: [check('test')] });
    await s.monitor.pollOnce(); await s.monitor.pollOnce();
    expect(s.journal.readAfter(0, { kinds: ['pr.head'] }).entries).toHaveLength(1);
    expect(s.journal.readAfter(0, { kinds: ['pr.checks'] }).entries).toEqual([]);
  });

  it('reports failures while other checks run, reads details only on change, and pins success to the registered head', async () => {
    const s = setup();
    s.monitor.watch('worker', url, 'a'.repeat(40));
    s.set({ checks: [check('test', 'COMPLETED', 'FAILURE'), check('build', 'IN_PROGRESS', '')] });
    await s.monitor.pollOnce();
    await s.monitor.pollOnce();
    expect(s.reads()).toBe(1);
    expect(s.journal.readAfter(0, { kinds: ['pr.checks'] }).entries).toMatchObject([{ checks: 'failed', failingChecks: ['test'] }]);
    s.set({ headRefOid: 'b'.repeat(40), checks: [check('test')] });
    await s.monitor.pollOnce();
    expect(s.journal.readAfter(0, { kinds: ['pr.head'] }).entries).toHaveLength(1);
    expect(s.journal.readAfter(0, { kinds: ['pr.checks'] }).entries).toHaveLength(1);
  });

  it('re-pins an implicit registration after the observed head moves', async () => {
    const s = setup(); s.monitor.watch('worker', url); await s.monitor.pollOnce();
    s.set({ headRefOid: 'b'.repeat(40), checks: [check('test')] }); await s.monitor.pollOnce();
    expect(s.journal.readAfter(0, { kinds: ['pr.checks'] }).entries).toEqual([]);
    s.monitor.watch('worker', url); await s.monitor.pollOnce();
    expect(s.journal.readAfter(0, { kinds: ['pr.checks'] }).entries).toMatchObject([{ checks: 'passed', pr: { headOid: 'b'.repeat(40) } }]);
  });

  it('never reports success for empty, incomplete, pending or blocked checks', async () => {
    const s = setup(); s.monitor.watch('worker', url);
    await s.monitor.pollOnce();
    s.set({ complete: false, checks: [check('test')] }); await s.monitor.pollOnce();
    s.set({ complete: true, checks: [check('test', 'IN_PROGRESS', '')] }); await s.monitor.pollOnce();
    s.set({ checks: [check('test')], mergeStateStatus: 'BLOCKED' }); await s.monitor.pollOnce();
    expect(s.journal.readAfter(0, { kinds: ['pr.checks'] }).entries).toEqual([]);
    s.set({ mergeStateStatus: 'CLEAN' }); await s.monitor.pollOnce();
    expect(s.journal.readAfter(0, { kinds: ['pr.checks'] }).entries).toMatchObject([{ checks: 'passed' }]);
  });

  it('compares persisted baselines after restart and replays unread events once', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pane-pr-'));
    try {
      const file = path.join(directory, 'journal.json');
      const first = setup(file); first.monitor.watch('worker', url); await first.monitor.pollOnce();
      const restarted = setup(file);
      restarted.set({ checks: [check('test', 'COMPLETED', 'FAILURE')] });
      await restarted.monitor.pollOnce();
      const again = setup(file); again.set({ checks: [check('test', 'COMPLETED', 'FAILURE')] }); await again.monitor.pollOnce();
      expect(again.journal.readAfter(0, { kinds: ['pr.checks'] }).entries).toHaveLength(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});


describe('watch lifecycle limits', () => {
  it('reports an outage once and recovery once; rate limits never consume the error budget', async () => {
    const s = setup(); s.monitor.watch('worker', url);
    for (let attempt = 0; attempt < 10; attempt++) {
      s.fail(new GithubWatchError('rate limited', true, 0));
      s.advance(); await s.monitor.pollOnce();
    }
    expect(s.monitor.list()[0].stopped).toBeUndefined();
    expect(s.journal.readAfter(0, { kinds: ['github.unavailable'] }).entries).toHaveLength(1);
    s.fail(); s.advance(); await s.monitor.pollOnce(); await s.monitor.pollOnce();
    expect(s.journal.readAfter(0, { kinds: ['github.recovered'] }).entries).toHaveLength(1);
  });

  it('stops after eight non-rate-limit failures and can be re-registered', async () => {
    const s = setup(); s.monitor.watch('worker', url); s.fail(new GithubWatchError('HTTP 503'));
    for (let attempt = 0; attempt < 8; attempt++) { s.advance(); await s.monitor.pollOnce(); }
    expect(s.monitor.list()[0].stopped).toBe('error-limit');
    expect(s.journal.readAfter(0, { kinds: ['pr.stopped'] }).entries).toHaveLength(1);
    s.fail(); s.monitor.watch('worker', url); await s.monitor.pollOnce();
    expect(s.monitor.list()[0].stopped).toBeUndefined();
  });

  it('stops on closed, unwatch, archive, and ten comment-only updates', async () => {
    const s = setup(); s.monitor.watch('worker', url); await s.monitor.pollOnce();
    for (let i = 0; i < 10; i++) { s.set({ comments: [`comment-${i}`] }); await s.monitor.pollOnce(); }
    expect(s.monitor.list()[0].stopped).toBe('comment-limit');
    s.monitor.watch('worker', url); s.set({ state: 'CLOSED' }); await s.monitor.pollOnce();
    expect(s.monitor.list()[0].stopped).toBe('closed');
    expect(s.monitor.unwatch('worker', url)).toBe(true);
    expect(s.monitor.list()).toEqual([]);
    s.monitor.watch('worker', url); s.archive(); await s.monitor.pollOnce();
    expect(s.monitor.list()).toEqual([]);
  });

  it('uses host and repository as well as PR number in registration identity', () => {
    const s = setup();
    s.monitor.watch('worker', url);
    s.monitor.watch('worker', 'https://github.com/acme/other/pull/7');
    s.monitor.watch('worker', 'https://github.example.com/acme/app/pull/7');
    expect(s.monitor.list()).toHaveLength(3);
  });

  it('performs a full backstop read even when fingerprints stay unchanged', async () => {
    const s = setup(); s.monitor.watch('worker', url); await s.monitor.pollOnce();
    s.advance(); await s.monitor.pollOnce();
    expect(s.reads()).toBe(2);
  });
});
