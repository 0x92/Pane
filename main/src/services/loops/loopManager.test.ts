import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopManager, type LoopRunStarter } from './loopManager';
import { LoopRepository } from './loopRepository';
import { createLoopTestDb } from './loopTestDb';
import type { LoopInput } from '../../../../shared/types/loop';

// Expected instants are worked for New York (EDT, UTC-4, in October 2026).
process.env.TZ = 'America/New_York';

const utc = (iso: string) => Date.parse(iso);

const nightly: LoopInput = {
  name: 'Nightly bug sweep',
  projectId: 1,
  cron: '0 3 * * *',
  agent: 'claude',
  initialInput: 'Sweep yesterday’s merged PRs for bugs.',
  enabled: true,
};

function setup(startRun: LoopRunStarter = async () => ({ sessionId: `pane-${Math.random()}` })) {
  let nowMs = utc('2026-10-23T12:00:00Z');
  const archived: string[] = [];
  const started: string[] = [];
  const manager = new LoopManager({
    repo: new LoopRepository((() => { const db = createLoopTestDb(); return () => db; })()),
    startRun: async (loop, slotAtMs) => {
      started.push(loop.name);
      return startRun(loop, slotAtMs);
    },
    archiveRun: async sessionId => { archived.push(sessionId); },
    projectExists: id => id === 1,
    now: () => nowMs,
  });
  return {
    manager,
    started,
    archived,
    setNow: (iso: string) => { nowMs = utc(iso); },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LoopManager.save', () => {
  it('rejects a cron that runs more than once an hour', () => {
    const { manager } = setup();
    expect(() => manager.save({ ...nightly, cron: '*/30 * * * *' })).toThrow(/60 minutes/);
    expect(manager.list()).toEqual([]);
  });

  it('rejects a project that does not exist', () => {
    const { manager } = setup();
    expect(() => manager.save({ ...nightly, projectId: 7 })).toThrow(/Project 7 does not exist/);
  });

  it('shows the schedule and the next run', () => {
    const { manager } = setup();
    const loop = manager.save(nightly);
    expect(loop).toMatchObject({ scheduleText: 'Every day at 03:00', nextRunAtMs: utc('2026-10-24T07:00:00Z'), runs: [] });
  });
});

describe('LoopManager runs', () => {
  it('starts a due loop once and records the slot', async () => {
    const { manager, started, setNow } = setup(async () => ({ sessionId: 'pane-1' }));
    const { id } = manager.save(nightly);
    manager.start();

    setNow('2026-10-24T07:02:00Z');
    await manager.tick();
    await manager.tick();

    expect(started).toEqual(['Nightly bug sweep']);
    expect(manager.list()[0].runs).toMatchObject([
      { loopId: id, slotAtMs: utc('2026-10-24T07:00:00Z'), trigger: 'schedule', status: 'started', sessionId: 'pane-1' },
    ]);
    manager.stop();
  });

  it('records a run missed while Pane was closed as skipped, at its slot time', async () => {
    const { manager, started, setNow } = setup();
    manager.save(nightly);

    // Pane comes back at 09:00 EDT, two hours after the 03:00 slot.
    setNow('2026-10-24T13:00:00Z');
    manager.start();
    await manager.tick();

    expect(started).toEqual([]);
    const [loop] = manager.list();
    expect(loop.runs).toMatchObject([{ status: 'skipped', slotAtMs: utc('2026-10-24T07:00:00Z'), sessionId: null }]);
    expect(loop.nextRunAtMs).toBe(utc('2026-10-25T07:00:00Z'));
    manager.stop();
  });

  it('re-reads each loop before starting it, so a loop paused meanwhile does not run', async () => {
    let releaseFirst: () => void = () => {};
    const { manager, started, setNow } = setup(loop => loop.name === 'First'
      ? new Promise(resolve => { releaseFirst = () => resolve({ sessionId: 'pane-first' }); })
      : Promise.resolve({ sessionId: 'pane-second' }));
    manager.save({ ...nightly, name: 'First' });
    const second = manager.save({ ...nightly, name: 'Second' });
    manager.start();
    await manager.tick();
    setNow('2026-10-24T07:01:00Z');

    const tick = manager.tick();
    await vi.waitFor(() => expect(started).toEqual(['First']));
    manager.setEnabled(second.id, false);
    releaseFirst();
    await tick;

    expect(started).toEqual(['First']);
    expect(manager.list().find(loop => loop.id === second.id)?.runs).toEqual([]);
    manager.stop();
  });

  it('runs now without moving the schedule, and never starts one loop twice at once', async () => {
    let release: () => void = () => {};
    const { manager } = setup(() => new Promise(resolve => { release = () => resolve({ sessionId: 'pane-now' }); }));
    const { id, nextRunAtMs } = manager.save(nightly);

    const first = manager.runNow(id);
    await expect(manager.runNow(id)).rejects.toThrow(/already starting/);
    release();
    const loop = await first;

    expect(loop.nextRunAtMs).toBe(nextRunAtMs);
    expect(loop.runs).toMatchObject([{ trigger: 'manual', status: 'started', sessionId: 'pane-now' }]);
  });

  it('records a run whose Pane could not be created as failed', async () => {
    const { manager } = setup(async () => { throw new Error('No space left on device'); });
    const { id } = manager.save(nightly);
    const loop = await manager.runNow(id);
    expect(loop.runs).toMatchObject([{ status: 'failed', error: 'No space left on device', sessionId: null }]);
  });

  it('keeps the last 10 runs and archives older run Panes', async () => {
    let count = 0;
    const { manager, archived } = setup(async () => ({ sessionId: `pane-${++count}` }));
    const { id } = manager.save(nightly);
    for (let index = 0; index < 12; index++) await manager.runNow(id);

    expect(manager.list()[0].runs.map(run => run.sessionId)).toEqual(
      ['pane-12', 'pane-11', 'pane-10', 'pane-9', 'pane-8', 'pane-7', 'pane-6', 'pane-5', 'pane-4', 'pane-3'],
    );
    expect(archived).toEqual(['pane-1', 'pane-2']);
  });
});
