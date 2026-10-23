import { expect, it } from 'vitest';
import { toAssistantMessage } from './convertMessage';

it('keeps tool identity, reasoning and unknown ACP content in a read-only view message', () => {
  const converted = toAssistantMessage({ id: 'answer-a', role: 'assistant', parts: [
    { type: 'text', text: 'Done' }, { type: 'thought', text: 'Checking the file' },
    { type: 'tool', id: 'edit-a', title: 'Edit app.ts', status: 'completed', input: { path: 'app.ts' }, content: [{ type: 'diff', path: 'app.ts', oldText: 'before', newText: 'after' }] },
    { type: 'content', content: { sessionUpdate: 'future_extension', detail: 'Keep this' } },
  ] });
  expect(converted.id).toBe('answer-a');
  expect(converted.content).toMatchObject([
    { type: 'text', text: 'Done' }, { type: 'reasoning', text: 'Checking the file' },
    { type: 'tool-call', toolCallId: 'edit-a', toolName: 'Edit app.ts', result: { content: [{ type: 'diff', path: 'app.ts', newText: 'after' }] } },
    { type: 'data', name: 'acp', data: { sessionUpdate: 'future_extension', detail: 'Keep this' } },
  ]);
});
