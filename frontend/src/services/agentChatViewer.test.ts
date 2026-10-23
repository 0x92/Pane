import { expect, it, vi } from 'vitest';
import { AgentChatViewer } from './agentChatViewer';
import type { AgentChatClient, AgentChatEvent, AgentChatView } from '../../../shared/types/agentChat';

it('repairs a viewer event gap and detaches without cancelling or stopping the host runtime', async () => {
  let event: ((event: AgentChatEvent) => void) | undefined;
  let host: AgentChatView = { panelId: 'a', available: true, setupRequired: false, running: true, permissions: [], transcript: { panelId: 'a', generation: 1, revision: 0, messages: [] } };
  const stopped = vi.fn();
  const client: AgentChatClient = {
    get: async () => structuredClone(host), setup: async () => ({ installed: true }),
    switch: async () => { throw Error('unused'); }, recover: async () => { throw Error('unused'); },
    send: async () => { throw Error('unused'); }, receipt: async () => undefined,
    cancel: stopped, permission: async () => undefined, stop: stopped,
    onEvent: callback => { event = callback; return () => { event = undefined; }; }, onState: () => () => undefined,
  };
  const viewer = new AgentChatViewer(client, 'a');
  const detach = viewer.subscribe(() => undefined);
  await viewer.refresh();
  viewer.setDraft('Keep this draft');
  host = { ...host, transcript: { panelId: 'a', generation: 1, revision: 2, messages: [{ id: 'm', role: 'assistant', parts: [{ type: 'text', text: 'Repaired answer' }] }] } };
  event?.({ panelId: 'a', generation: 1, revision: 2, change: { type: 'append', id: 'm', role: 'assistant', part: { type: 'text', text: 'answer' } } });
  await viewer.refresh();
  expect(viewer.snapshot().view?.transcript?.messages[0].parts).toEqual([{ type: 'text', text: 'Repaired answer' }]);
  detach();
  expect(stopped).not.toHaveBeenCalled();
  expect(viewer.snapshot().draft).toBe('Keep this draft');
  expect(event).toBeUndefined();
});
