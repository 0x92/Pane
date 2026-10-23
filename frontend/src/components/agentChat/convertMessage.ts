import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import type { ThreadMessageLike } from '@assistant-ui/react';
import type { AgentChatMessage } from '../../../../shared/types/agentChat';

/** Presentation only: provider tools execute exclusively on the owning host. */
export function toAssistantMessage(message: AgentChatMessage): ThreadMessageLike {
  const content: Exclude<ThreadMessageLike['content'], string> = message.parts.map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    if (part.type === 'thought') return { type: 'reasoning', text: part.text };
    if (part.type === 'tool') return {
      type: 'tool-call', toolCallId: part.id, toolName: part.title,
      args: { input: part.input ?? null, status: part.status },
      result: part.status === 'completed' || part.status === 'failed' || part.content
        ? { output: part.output ?? null, content: part.content ?? [] } : undefined,
      isPreliminary: part.status === 'pending' || part.status === 'in_progress',
      isError: part.status === 'failed',
    };
    if (part.type === 'content') {
      const data = part.content;
      const image = decodeOptionalBoundary(data, boundary.object({ type: boundary.literal('image'), data: boundary.string, mimeType: boundary.enumeration('image/png', 'image/jpeg', 'image/webp', 'image/gif') }));
      if (image) {
        return { type: 'image', image: `data:${image.mimeType};base64,${image.data}` };
      }
      return { type: 'data', name: 'acp', data };
    }
    return { type: 'text', text: '' };
  });
  return { id: message.id, role: message.role, content };
}
