import { describe, expect, it } from 'vitest';
import { PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import type { StoredLoop } from '../services/loops/loopRepository';
import { startLoopRun } from './loops';

// Slot times are worked for New York: 07:00 UTC on Oct 24 2026 is 03:00 EDT.
process.env.TZ = 'America/New_York';

const slotAtMs = Date.parse('2026-10-24T07:00:00Z');

const nightly: StoredLoop = {
  id: 'loop-1',
  name: 'Nightly bug sweep',
  projectId: 1,
  cron: '0 3 * * *',
  agent: 'claude',
  initialInput: 'Sweep yesterday’s merged PRs for bugs.',
  enabled: true,
  scheduleFromMs: 0,
  createdAtMs: 0,
};

/** A registry whose `panes create` answers with `item` and records every call. */
function registryAnswering(item: Record<string, PaneCommandValue>) {
  const calls: Array<{ channel: string; request: PaneCommandValue }> = [];
  const registry = new PaneCommandRegistry();
  registry.register('runpane:panes:create', (request: PaneCommandValue) => {
    calls.push({ channel: 'runpane:panes:create', request });
    return { ok: item.ok, repo: { id: 1 }, items: [item] };
  });
  registry.register('runpane:panes:rename', (request: PaneCommandValue) => {
    calls.push({ channel: 'runpane:panes:rename', request });
    return { ok: true };
  });
  return { registry, calls };
}

describe('startLoopRun', () => {
  it('creates an agent run through panes create, waits for its prompt, and labels it by loop and slot', async () => {
    const { registry, calls } = registryAnswering({ ok: true, index: 0, name: 'x', pinned: false, sessionId: 'pane-7' });

    await expect(startLoopRun(registry, nightly, slotAtMs)).resolves.toEqual({ sessionId: 'pane-7' });
    expect(calls).toEqual([
      {
        channel: 'runpane:panes:create',
        request: {
          repo: { id: 1 },
          noFocus: true,
          waitReady: true,
          panes: [{
            name: 'nightly-bug-sweep · Oct 24 03:00',
            worktreeName: 'loop-nightly-bug-sweep-20261024-0300',
            pinned: false,
            tool: { agent: 'claude', initialInput: 'Sweep yesterday’s merged PRs for bugs.' },
          }],
        },
      },
      { channel: 'runpane:panes:rename', request: { paneId: 'pane-7', name: 'nightly-bug-sweep · Oct 24 03:00' } },
    ]);
  });

  it('runs a command loop with its branch template and no prompt to wait for', async () => {
    const { registry, calls } = registryAnswering({ ok: true, index: 0, name: 'x', pinned: false, sessionId: 'pane-8' });
    const command: StoredLoop = {
      ...nightly,
      agent: undefined,
      initialInput: undefined,
      toolCommand: 'agent-farm run dependency-check',
      worktreeTemplate: 'Deps Check',
    };

    await startLoopRun(registry, command, slotAtMs);
    expect(calls[0].request).toEqual({
      repo: { id: 1 },
      noFocus: true,
      waitReady: false,
      panes: [{
        name: 'nightly-bug-sweep · Oct 24 03:00',
        worktreeName: 'deps-check-20261024-0300',
        pinned: false,
        tool: { command: 'agent-farm run dependency-check' },
      }],
    });
  });

  it('returns a warning when the Pane started but its prompt was not confirmed', async () => {
    const { registry } = registryAnswering({
      ok: false,
      index: 0,
      name: 'x',
      pinned: false,
      sessionId: 'pane-9',
      readiness: { ok: true },
      initialInput: { delivered: true, submitted: false, inputBytes: 40, delivery: { state: 'in-composer', evidence: 'screen', message: 'The prompt is still in the composer.' } },
    });

    await expect(startLoopRun(registry, nightly, slotAtMs)).resolves.toEqual({
      sessionId: 'pane-9',
      warning: 'Pane could not confirm the prompt was submitted. The prompt is still in the composer.',
    });
  });

  it('returns a warning when the agent never became ready', async () => {
    const { registry } = registryAnswering({
      ok: false,
      index: 0,
      name: 'x',
      pinned: false,
      sessionId: 'pane-10',
      readiness: { ok: false, reason: { code: 'agent-not-ready', message: 'Claude did not show its prompt within 60s.' } },
      // Claude takes its prompt on the command line, so delivery has evidence but no message.
      initialInput: { delivered: false, submitted: false, inputBytes: 40, delivery: { state: 'unknown', evidence: 'argv' } },
    });

    await expect(startLoopRun(registry, nightly, slotAtMs)).resolves.toEqual({
      sessionId: 'pane-10',
      warning: 'The agent did not become ready, so Pane could not confirm it got its prompt. Claude did not show its prompt within 60s.',
    });
  });

  it('says how to clear a folder-trust prompt the run is stuck at', async () => {
    const { registry } = registryAnswering({
      ok: false,
      index: 0,
      name: 'x',
      pinned: false,
      sessionId: 'pane-11',
      readiness: {
        ok: false,
        blocked: {
          kind: 'first-run-dialog',
          message: ' Accessing workspace:\n\n /repos/demo/worktrees/loop-ping-20261025-0118\n\n Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel',
          suggestedCommand: 'runpane panels input --panel p --keys down,enter --yes --json',
        },
      },
      initialInput: { delivered: false, submitted: false, inputBytes: 40, delivery: { state: 'unknown', evidence: 'argv' } },
    });

    await expect(startLoopRun(registry, nightly, slotAtMs)).resolves.toEqual({
      sessionId: 'pane-11',
      warning: 'The run is waiting at the agent\'s folder-trust prompt in its new worktree, so it has not started. '
        + 'Open the run and answer it, or open the project folder in the agent once and trust it so later runs start on their own.',
    });
  });

  it('fails the run when no Pane was created', async () => {
    const { registry } = registryAnswering({ ok: false, index: 0, error: { code: 'ERR_GIT', message: 'The default branch could not be fetched.' } });

    await expect(startLoopRun(registry, nightly, slotAtMs)).rejects.toThrow('The default branch could not be fetched.');
  });
});
