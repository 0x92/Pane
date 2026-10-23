import { applyAgentChatEvent, type AgentChatClient, type AgentChatEvent, type AgentChatView, type AgentChatSend } from '../../../shared/types/agentChat';

export interface AgentChatViewerState { view?: AgentChatView; error?: string; draft: string; pendingDelivery?: AgentChatSend; windowEnd?: number }

/** A disposable subscription to host-owned state. Detach has no runtime effect. */
export class AgentChatViewer {
  private state: AgentChatViewerState = { draft: '' };
  private readonly listeners = new Set<() => void>();
  private detach?: () => void;
  private loading?: Promise<void>;
  private pending: AgentChatEvent[] = [];
  scrollTop: number | undefined;

  constructor(readonly client: AgentChatClient, readonly panelId: string) {}

  snapshot = (): AgentChatViewerState => this.state;

  private publish(patch: Partial<AgentChatViewerState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }

  setWindowEnd(windowEnd?: number): void { this.publish({ windowEnd }); }
  setDraft(draft: string): void { this.publish({ draft }); }
  setPendingDelivery(pendingDelivery?: AgentChatSend): void { this.publish({ pendingDelivery }); }
  setError(error?: string): void { this.publish({ error }); }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (!this.detach) {
      const events = this.client.onEvent(event => {
        if (event.panelId !== this.panelId) return;
        if (this.loading || !this.state.view?.transcript) {
          if (this.pending.length < 1000) this.pending.push(event);
          else this.pending = [event];
        }
        const transcript = this.state.view?.transcript;
        if (!transcript) { void this.refresh(); return; }
        const applied = applyAgentChatEvent(transcript, event);
        if (applied.resync) { void this.refresh(); return; }
        this.publish({ view: { ...this.state.view!, transcript: applied.transcript } });
      });
      const states = this.client.onState(view => {
        if (view.panelId !== this.panelId) return;
        const current = this.state.view;
        if ((view.conversation?.generation ?? 0) < (current?.conversation?.generation ?? 0)) return;
        const transcript = view.transcript ?? (current?.transcript?.generation === view.conversation?.generation ? current?.transcript : undefined);
        this.publish({ view: { ...view, transcript } });
        if (!transcript && view.conversation?.active === 'chat') void this.refresh();
      });
      const reconnect = this.client.onReconnect?.(() => { void this.refresh(); });
      this.detach = () => { events(); states(); reconnect?.(); };
      void this.refresh();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.detach?.(); this.detach = undefined;
        // Keep drafts, delivery identity and scroll, but release heavy replay data.
        if (this.state.view) this.state = { ...this.state, view: { ...this.state.view, transcript: undefined } };
        this.pending = [];
      }
    };
  };

  refresh(repairAttempt = 0): Promise<void> {
    let repair = false;
    if (this.loading) return this.loading;
    this.loading = this.client.get(this.panelId).then(view => {
      let transcript = view.transcript;
      let gap = false;
      for (const event of this.pending) {
        if (!transcript) { gap = true; break; }
        const applied = applyAgentChatEvent(transcript, event);
        transcript = applied.transcript;
        gap ||= applied.resync;
      }
      this.pending = [];
      repair = gap && repairAttempt < 1;
      const currentGeneration = this.state.view?.conversation?.generation ?? 0;
      if ((view.conversation?.generation ?? 0) >= currentGeneration) this.publish({ view: { ...view, transcript }, error: gap ? 'The transcript changed during reconnect. Refresh to load the current host snapshot.' : undefined });
    }).catch(error => this.setError(error instanceof Error ? error.message : String(error))).finally(() => { this.loading = undefined; if (repair && this.listeners.size) return this.refresh(repairAttempt + 1); });
    return this.loading;
  }
}

const viewers = new WeakMap<AgentChatClient, Map<string, AgentChatViewer>>();
export function agentChatViewer(client: AgentChatClient, panelId: string): AgentChatViewer {
  let byPanel = viewers.get(client);
  if (!byPanel) { byPanel = new Map(); viewers.set(client, byPanel); }
  let viewer = byPanel.get(panelId);
  if (!viewer) { viewer = new AgentChatViewer(client, panelId); byPanel.set(panelId, viewer); }
  return viewer;
}
