import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AppServices } from './types';
import { isRemotePaneCommand, type PaneCommandRegistry, type PaneCommandValue } from '../daemon/commandRegistry';
import { getAppDirectory } from '../utils/appDirectory';
import { remoteHostRuntimeStateStore } from '../daemon/remoteHostRuntimeState';
import { panelManager } from '../services/panelManager';
import { terminalPanelManager } from '../services/terminalPanelManager';
import type { TerminalPanelState } from '../../../shared/types/panels';
import { boundary, decodeBoundary } from '../../../shared/validation/boundaryDecoder';
import { PaneError } from '../../../shared/paneError';
import { createDefaultRemoteDaemonConfig } from '../../../shared/types/remoteDaemon';
import { checkpointUpdatePanel } from '../services/updateContinuation';
import { readUpdateJournal, writeUpdateJson } from '../../../packages/runpane/src/updateOperation';

const bootId = randomUUID();
const requestSchema = boundary.object({ id: boundary.nonEmptyString, bootId: boundary.nonEmptyString });
const checkpointSchema = boundary.object({
  bootId: boundary.string,
  panels: boundary.array(boundary.object({ panelId: boundary.string, sessionId: boundary.string, resumeId: boundary.optional(boundary.string), cwd: boundary.optional(boundary.nonEmptyString), activity: boundary.enumeration('working', 'idle', 'blocked', 'unknown'), priorState: boundary.jsonObject, eligible: boundary.boolean, requiresAttention: boundary.optional(boundary.boolean), reason: boundary.string })),
});

export function registerUpdateOperationHandlers(services: AppServices, registry: PaneCommandRegistry): void {
  const panels = () => services.databaseService.getAllSessions(undefined, { includeHidden: true }).flatMap(session => panelManager.getPanelsForSession(session.id)).filter(panel => panel.type === 'terminal');
  const directory = (id: string) => {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new PaneError('ERR_UPDATE_ID', 'Invalid update operation. Nothing was changed.', 'Use the ID returned by runpane update.');
    return path.join(getAppDirectory(), 'updates', id);
  };
  const assertOwner = (value: PaneCommandValue) => {
    if (isRemotePaneCommand()) throw new PaneError('ERR_UPDATE_LOCAL_ONLY', 'Update control requires a local command on this host. Nothing was changed.', 'Run runpane update through the owning workspace shell.');
    const request = decodeBoundary(value, requestSchema);
    if (request.bootId !== bootId) throw new PaneError('ERR_UPDATE_HOST_CHANGED', 'Pane restarted after preflight. Nothing was changed.', 'Run update again against the current host.');
    const journal = readUpdateJournal(path.join(directory(request.id), 'status.json'));
    if (!journal.helperPid || journal.helperPid === process.pid) throw new PaneError('ERR_UPDATE_HELPER_NOT_READY', 'The independent helper has not acknowledged startup. Pane remains running.', 'Inspect the update operation status and supervisor log.');
    process.kill(journal.helperPid, 0);
    return request;
  };
  registry.register('runpane:update:host', async () => {
    const all = panels();
    const remote = (services.configManager.getConfig().remoteDaemon ?? createDefaultRemoteDaemonConfig()).host;
    let remoteHealthy = !remote.config.enabled;
    if (remote.config.enabled && remoteHostRuntimeStateStore.getState().status === 'live') {
      try {
        const listenHost = remote.config.listenHost.includes(':') ? `[${remote.config.listenHost}]` : remote.config.listenHost;
        const base = `http://${listenHost}:${remote.config.listenPort}`;
        const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
        const auth = await fetch(`${base}/invoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'panels:list', args: ['update-auth-probe'] }), signal: AbortSignal.timeout(2000) });
        remoteHealthy = health.ok && (remote.config.pairingRequired ? auth.status === 401 || auth.status === 403 : auth.ok);
        await Promise.all([health.body?.cancel(), auth.body?.cancel()]);
      } catch { /* A listening/authentication failure keeps the health gate closed. */ }
    }
    return { protocol: 1, machine: os.hostname(), bootId, pid: process.pid, executable: process.env.APPIMAGE ?? process.execPath, version: services.app.getVersion(), paneDir: getAppDirectory(), userData: services.app.getPath('userData'), packaged: services.app.isPackaged,
      remoteEnabled: remote.config.enabled, remoteHealthy, endpointFingerprint: createHash('sha256').update(JSON.stringify({ config: remote.config, baseUrl: remote.access?.baseUrl, clients: remote.clients.map(client => ({ id: client.id, tokenHash: client.tokenHash })) })).digest('hex'),
      active: all.filter(panel => terminalPanelManager.getAgentStatus(panel.id) === 'working').length,
      blocked: all.filter(panel => terminalPanelManager.getAgentStatus(panel.id) === 'blocked').length,
      idle: all.filter(panel => terminalPanelManager.getAgentStatus(panel.id) !== 'working' && terminalPanelManager.getAgentStatus(panel.id) !== 'blocked').length };
  });
  registry.register('runpane:update:checkpoint', async (value: PaneCommandValue) => {
    const request = assertOwner(value);
    if (services.archiveProgressManager?.hasActiveTasks()) throw new PaneError('ERR_UPDATE_BUSY', 'Worktree removal is still running. Pane remains open.', 'Wait for archive tasks to finish, then retry the update.');
    const file = path.join(directory(request.id), 'checkpoint.json');
    if (fs.existsSync(file)) return decodeBoundary(JSON.parse(fs.readFileSync(file, 'utf8')), checkpointSchema);
    await terminalPanelManager.saveAllTerminalStates();
    const checkpoint = { bootId, panels: panels().map(panel => {
      // SAFETY: checkpoint enumeration and restoration only accept terminal panels.
      const state = panel.state.customState as TerminalPanelState;
      return { panelId: panel.id, sessionId: panel.sessionId, ...checkpointUpdatePanel(state ?? {}, terminalPanelManager.getAgentStatus(panel.id), services.sessionManager.getSession(panel.sessionId)?.worktreePath) };
    }) };
    writeUpdateJson(file, checkpoint);
    return checkpoint;
  });
  registry.register('runpane:update:stop', async (value: PaneCommandValue) => {
    const request = assertOwner(value);
    const checkpoint = decodeBoundary(JSON.parse(fs.readFileSync(path.join(directory(request.id), 'checkpoint.json'), 'utf8')), checkpointSchema);
    const latestPanels = panels().map(panel => {
      // SAFETY: enumeration includes terminal panels only.
      const state = panel.state.customState as TerminalPanelState;
      const screen = terminalPanelManager.getTerminalSnapshot(panel.id)?.screenText;
      return { panelId: panel.id, sessionId: panel.sessionId, ...checkpointUpdatePanel({ ...state, screenText: screen ?? state.screenText }, terminalPanelManager.getAgentStatus(panel.id), services.sessionManager.getSession(panel.sessionId)?.worktreePath) };
    });
    writeUpdateJson(path.join(directory(request.id), 'checkpoint.json'), { ...checkpoint, panels: latestPanels });
    for (const item of latestPanels) {
      const panel = panelManager.getPanel(item.panelId);
      if (!panel) continue;
      // SAFETY: checkpoint enumeration and restoration only accept terminal panels.
      const state = panel.state.customState as TerminalPanelState;
      await panelManager.updatePanel(panel.id, { state: { ...panel.state, customState: { ...state, updateResumeHold: request.id, initialInput: undefined, initialInputFile: undefined } } });
    }
    setTimeout(() => services.app.quit(), 100);
    return { accepted: true };
  });
  registry.register('runpane:update:restore', async (value: PaneCommandValue) => {
    if (isRemotePaneCommand()) throw new PaneError('ERR_UPDATE_LOCAL_ONLY', 'Update restoration requires a local command.', 'Run it on the owning machine.');
    const request = decodeBoundary(value, boundary.object({ id: boundary.nonEmptyString }));
    const checkpoint = decodeBoundary(JSON.parse(fs.readFileSync(path.join(directory(request.id), 'checkpoint.json'), 'utf8')), checkpointSchema);
    const restored = [];
    for (const item of checkpoint.panels) {
      const panel = panelManager.getPanel(item.panelId);
      try {
        if (!panel || panel.type !== 'terminal' || panel.sessionId !== item.sessionId) throw new Error('The checkpoint panel no longer exists.');
        // SAFETY: checkpoint enumeration and restoration only accept terminal panels.
        const state = panel.state.customState as TerminalPanelState;
        if (state.updateResumeHold !== request.id) throw new Error('The update no longer owns this stopped panel.');
        if (!item.eligible) {
          await panelManager.updatePanel(panel.id, { state: { ...panel.state, customState: { ...item.priorState, updateResumeHold: request.id, isInitialized: false, initialInput: undefined, initialInputFile: undefined } } });
          restored.push({ panelId: item.panelId, outcome: item.requiresAttention ? 'needs-attention' : 'preserved', reason: item.reason });
          continue;
        }
        if (state.agentSessionId !== item.resumeId || !item.resumeId || !item.cwd) throw new Error('The conversation identity or working directory changed after checkpoint.');
        for (const field of ['initialCommand', 'launchCommand', 'launchMode', 'customResume', 'orchestrationProfile', 'orchestrationWorkspace', 'preserveLaunchCommand'] as const) {
          if (JSON.stringify(state[field]) !== JSON.stringify(item.priorState[field])) throw new Error('The saved launch profile changed after checkpoint; review it manually.');
        }
        if (terminalPanelManager.isTerminalInitialized(panel.id)) {
          restored.push({ panelId: item.panelId, outcome: 'already-running', reason: 'The recorded panel is already initialized; no input was sent.' }); continue;
        }
        if (state.updateResumeHold !== request.id) throw new Error('The update no longer owns this stopped panel.');
        await panelManager.updatePanel(panel.id, { state: { ...panel.state, customState: { ...state, updateResumeHold: undefined, updateResumeId: item.resumeId, wasInterrupted: true, initialInput: undefined, initialInputFile: undefined } } });
        const context = services.sessionManager.getProjectContext(item.sessionId)?.commandRunner.wslContext;
        await terminalPanelManager.initializeTerminal(panelManager.getPanel(panel.id)!, item.cwd, context);
        restored.push({ panelId: item.panelId, outcome: 'resumed', reason: 'Opened the recorded conversation. No prompt, continue command, or pending mutation was submitted.' });
      } catch (error) {
        if (panel) {
          // SAFETY: checkpoint enumeration and restoration only accept terminal panels.
          const state = panel.state.customState as TerminalPanelState;
          await panelManager.updatePanel(panel.id, { state: { ...panel.state, customState: { ...state, updateResumeHold: request.id, updateResumeId: undefined } } });
        }
        restored.push({ panelId: item.panelId, outcome: 'needs-attention', reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return { restored };
  });
}
