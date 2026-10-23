import { expect, test } from '@playwright/test';
import { emitRemoteHostEvent, openConnectedRemotePwa, dropRemoteConnection, restoreRemoteConnection } from './remotePwaMock';
import type { AgentChatView, AgentChatEvent } from '../shared/types/agentChat';
import { boundary, decodeBoundary } from '../shared/validation/boundaryDecoder';

test('streams a bounded Chat thread through the remote client and reconnects without stopping its host', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openConnectedRemotePwa(page, { sessionNames: ['Chat fixture'], panelTitles: ['Claude'] });
  const conversation = { panelId: 'anim-panel-0', workspaceId: 'anim-remote-0', provider: 'claude' as const, nativeSessionId: 'exact-native-id', generation: 2, active: 'chat' as const, preferred: 'chat' as const };
  const view: AgentChatView = { panelId: conversation.panelId, conversation, available: true, setupRequired: false, running: false, permissions: [], transcript: {
    panelId: conversation.panelId, generation: 2, revision: 0,
    messages: Array.from({ length: 1500 }, (_, index) => ({ id: `history-${index}`, role: 'assistant', parts: [{ type: 'text', text: `Historical reply ${index}` }] })),
  } };
  const panel = { id: conversation.panelId, sessionId: conversation.workspaceId, type: 'terminal', title: 'Claude',
    state: { isActive: true, customState: { agentType: 'claude', agentChat: { conversation } } }, metadata: { createdAt: '', lastActiveAt: '', position: 0 } };
  const mutations: string[] = [];
  let reads = 0;
  await page.route('http://anim-pane.test/**', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const body = decodeBoundary(JSON.parse(route.request().postData() ?? '{}'), boundary.object({ channel: boundary.string, args: boundary.array(boundary.json) }));
    if (body.channel === 'panels:list' || body.channel === 'panels:getActive') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: body.channel === 'panels:list' ? [panel] : panel }) });
    if (!body.channel.startsWith('agent-chat:')) return route.fallback();
    if (body.channel === 'agent-chat:get') reads++;
    else mutations.push(body.channel);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, result: body.channel === 'agent-chat:get' ? view : null }) });
  });
  const started = Date.now();
  await emitRemoteHostEvent(page, 'panel:updated', decodeBoundary(panel, boundary.json));
  const composer = page.getByRole('textbox', { name: 'Message agent' });
  await expect(composer).toBeVisible();
  await expect(page.getByText('Historical reply 1499', { exact: true })).toBeVisible();
  expect(await page.getByText(/^Historical reply \d+$/).count()).toBeLessThanOrEqual(200);
  await composer.fill('Keep my draft');
  view.running = true;
  await emitRemoteHostEvent(page, 'agent-chat:state', decodeBoundary(view, boundary.json));
  // Grow the external store rapidly: this previously mounted MessageByIndex
  // before assistant-ui synchronized its own runtime, crashing the entire panel.
  for (let index = 1; index <= 12; index++) {
    const event: AgentChatEvent = { panelId: conversation.panelId, generation: 2, revision: index, change: { type: 'append', id: `stream-${index}`, role: 'assistant', part: { type: 'text', text: `Stream reply ${index}` } } };
    view.transcript!.revision = index;
    view.transcript!.messages.push({ id: `stream-${index}`, role: 'assistant', parts: [{ type: 'text', text: `Stream reply ${index}` }] });
    await emitRemoteHostEvent(page, 'agent-chat:event', decodeBoundary(event, boundary.json));
  }
  await expect(composer).toBeVisible();
  await dropRemoteConnection(page);
  await expect(page.getByText('Reconnecting…', { exact: true })).toBeVisible();
  const previousReads = reads;
  view.running = false;
  view.permissions = [{ id: 'permission-1', generation: 2, title: 'Edit fixture.txt', toolCall: { path: 'fixture.txt' }, options: [{ optionId: 'reject-once', kind: 'reject_once', name: 'Reject this edit' }] }];
  await restoreRemoteConnection(page);
  await expect.poll(() => reads).toBeGreaterThan(previousReads);
  await expect(page.getByRole('button', { name: 'Reject this edit' })).toBeVisible();
  await expect(composer).toHaveValue('Keep my draft');
  await page.getByRole('button', { name: 'Reject this edit' }).click();
  await expect.poll(() => mutations).toEqual(['agent-chat:permission']);
  expect(errors).toEqual([]);
  await testInfo.attach('large-thread-metrics', { body: JSON.stringify({ historyMessages: 1500, maximumMountedMessages: 200, elapsedMs: Date.now() - started, snapshotBytes: JSON.stringify(view).length, reads }), contentType: 'application/json' });
  await page.screenshot({ path: testInfo.outputPath('chat-remote-reconnected.png') });
});
