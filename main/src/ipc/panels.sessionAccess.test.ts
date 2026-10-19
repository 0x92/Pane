import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import type { AppServices } from './types';
import type { ToolPanel } from '../../../shared/types/panels';
import { PaneCommandRegistry } from '../daemon/commandRegistry';
import { databaseService } from '../services/database';
import { OrchestrationSessionStore } from '../services/orchestrationSessionStore';
import { sessionWorkspacePath } from '../services/sessionWorkspace';
import { getAppDirectory } from '../utils/appDirectory';
import { registerPanelHandlers } from './panels';

function partial<Contract>(value: Partial<Contract>): Contract {
  // SAFETY: The fixture provides every member used by the panel creation handler.
  return value as Contract;
}

afterEach(() => vi.restoreAllMocks());

describe('desktop worker Session access', () => {
  it('grants Session access only to tabs created after association, including plain shells', async () => {
    const paneId = 'desktop-worker';
    databaseService.createSession({ id: paneId, name: paneId, initial_prompt: '', worktree_name: paneId, worktree_path: '/tmp/worker', project_id: null, tool_type: 'none' });
    const registry = new PaneCommandRegistry();
    // SAFETY: Creating a panel does not read AppServices or Electron methods besides handle.
    registerPanelHandlers(partial<IpcMain>({ handle: vi.fn() }), partial<AppServices>({}), registry);
    const create = async (command?: string) => {
      const result = await registry.invoke('panels:create', [{ sessionId: paneId, type: 'terminal', initialState: { customState: { initialCommand: command } } }]);
      expect(result).toMatchObject({ success: true });
      // SAFETY: Successful panels:create returns a ToolPanel.
      return (result as { data: ToolPanel }).data;
    };
    const old = await create('claude --dangerously-skip-permissions');
    const folder = sessionWorkspacePath('desktop-session');
    fs.mkdirSync(folder, { recursive: true });
    const store = new OrchestrationSessionStore(path.join(getAppDirectory(), 'orchestration-sessions.json'));
    store.write({ ...store.read(), sessions: [{
      id: 'desktop-session', name: 'Desktop Session', agent: 'claude', internalSessionId: 'orchestrator',
      panelIds: { claude: 'c', codex: 'x', cursor: 'u' }, goal: '', context: '', decisions: [], blockers: [], nextAction: '', evidence: [], outputs: [], activity: [], revision: 0,
      createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z',
      associations: [{ paneId, panelIds: [], attachedAt: '2026-10-18T00:00:00Z' }],
    }] });
    try {
      const claude = await create('claude --dangerously-skip-permissions');
      const shell = await create();
      const custom = await create('agent-farm claude');
      expect(old.state.customState).not.toHaveProperty('sessionFolder');
      expect(claude.state.customState).toMatchObject({ sessionFolder: folder });
      expect(shell.state.customState).toMatchObject({ sessionFolder: folder });
      expect(custom.state.customState).toMatchObject({ sessionFolder: folder, initialCommand: 'agent-farm claude' });
      const command = claude.state.customState?.initialCommand;
      expect(command).toBe(process.platform === 'win32' ? 'claude --dangerously-skip-permissions' : `claude --dangerously-skip-permissions --settings '${JSON.stringify({ permissions: { additionalDirectories: [folder], deny: [`Edit(/${folder}/**)`] } })}'`);
    } finally {
      store.write({ ...store.read(), sessions: [] });
    }
  });
});
