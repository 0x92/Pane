import { describe, expect, it } from 'vitest';
import { decideLoop, nextLoopRun, previewLoopSchedule } from './loopSchedule';

// The expected instants below are worked by hand for New York, where 2026's
// clocks go forward on March 8 and back on November 1.
process.env.TZ = 'America/New_York';

const utc = (iso: string) => Date.parse(iso);

describe('previewLoopSchedule', () => {
  it('describes the preset shapes as sentences', () => {
    const now = utc('2026-10-24T12:00:00Z');
    const text = (cron: string) => {
      const preview = previewLoopSchedule(cron, now);
      return preview.ok ? preview.scheduleText : preview.error;
    };
    expect(text('0 3 * * *')).toBe('Every day at 03:00');
    expect(text('30 9 * * 1')).toBe('Mondays at 09:30');
    expect(text('0 9 * * 1-5')).toBe('Weekdays at 09:00');
    expect(text('0 * * * *')).toBe('Every hour');
    expect(text('0 */6 * * *')).toBe('Every 6 hours');
    expect(text('15 4 1 * *')).toBe('Cron 15 4 1 * *');
  });

  it('gives the next run in local time', () => {
    // 08:00 EDT on Oct 24; the next 03:00 EDT is Oct 25 at 07:00 UTC.
    const preview = previewLoopSchedule('0 3 * * *', utc('2026-10-24T12:00:00Z'));
    expect(preview).toMatchObject({ ok: true, nextRunAtMs: utc('2026-10-25T07:00:00Z') });
  });

  it('rejects schedules that run more than once an hour', () => {
    const now = utc('2026-10-24T12:00:00Z');
    expect(previewLoopSchedule('*/30 * * * *', now)).toMatchObject({ ok: false, error: expect.stringContaining('60 minutes') });
    // Hourly most of the week, but 09:00 and 09:30 on Mondays are 30 minutes apart.
    expect(previewLoopSchedule('0,30 9 * * 1', now)).toMatchObject({ ok: false, error: expect.stringContaining('60 minutes') });
    expect(previewLoopSchedule('0 * * * *', now)).toMatchObject({ ok: true });
  });

  it('rejects text that is not a five-field cron', () => {
    const now = utc('2026-10-24T12:00:00Z');
    expect(previewLoopSchedule('nope', now)).toMatchObject({ ok: false });
    expect(previewLoopSchedule('0 0 3 * * *', now)).toMatchObject({ ok: false });
  });
});

describe('nextLoopRun across daylight saving', () => {
  it('keeps the wall-clock time when the clocks go back', () => {
    // Oct 31 09:00 EDT is 13:00 UTC; Nov 1 09:00 EST is 14:00 UTC, 25 hours later.
    expect(nextLoopRun('0 9 * * *', utc('2026-10-31T13:00:00Z'))).toBe(utc('2026-11-01T14:00:00Z'));
  });

  it('runs a slot that falls in the skipped hour at the first valid time', () => {
    // 02:30 does not exist on March 8: clocks jump from 02:00 EST to 03:00 EDT.
    // The run happens at 03:30 EDT (07:30 UTC), then 02:30 EDT on March 9.
    expect(nextLoopRun('30 2 * * *', utc('2026-03-07T17:00:00Z'))).toBe(utc('2026-03-08T07:30:00Z'));
    expect(nextLoopRun('30 2 * * *', utc('2026-03-08T07:30:00Z'))).toBe(utc('2026-03-09T06:30:00Z'));
  });
});

describe('decideLoop', () => {
  // Daily at 03:00 EDT = 07:00 UTC. The loop counts slots after Oct 23 12:00 UTC.
  const cron = '0 3 * * *';
  const from = utc('2026-10-23T12:00:00Z');
  const slot = utc('2026-10-24T07:00:00Z');

  it('waits for the next slot', () => {
    expect(decideLoop(cron, from, utc('2026-10-24T06:00:00Z'))).toEqual({ kind: 'wait', atMs: slot });
  });

  it('runs a slot up to 15 minutes late', () => {
    expect(decideLoop(cron, from, utc('2026-10-24T07:15:00Z'))).toEqual({ kind: 'run', slotAtMs: slot });
  });

  it('skips a slot more than 15 minutes late', () => {
    expect(decideLoop(cron, from, utc('2026-10-24T07:16:00Z'))).toEqual({ kind: 'skip', slotAtMs: slot });
  });

  it('skips only the latest slot after days away', () => {
    // Away from Oct 23 to Oct 27 08:00 UTC: Oct 24, 25, 26 and 27 were missed.
    expect(decideLoop(cron, from, utc('2026-10-27T08:00:00Z'))).toEqual({
      kind: 'skip',
      slotAtMs: utc('2026-10-27T07:00:00Z'),
    });
  });

  it('does not repeat a slot it has already handled', () => {
    expect(decideLoop(cron, slot, utc('2026-10-24T07:05:00Z'))).toEqual({
      kind: 'wait',
      atMs: utc('2026-10-25T07:00:00Z'),
    });
  });
});
