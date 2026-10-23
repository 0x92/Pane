import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  AssistantRuntimeProvider, AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, ThreadPrimitive,
  SimpleImageAttachmentAdapter, useAuiState, useExternalStoreRuntime,
  type DataMessagePartComponent, type ReasoningMessagePartComponent, type TextMessagePartComponent, type ToolCallMessagePartProps,
} from '@assistant-ui/react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { boundary, decodeOptionalBoundary } from '../../../../shared/validation/boundaryDecoder';
import { ArrowDown, ArrowUp, ImagePlus, Square, X } from 'lucide-react';
import type { AgentChatClient, AgentChatSend } from '../../../../shared/types/agentChat';
import { agentChatViewer } from '../../services/agentChatViewer';
import { toAssistantMessage } from './convertMessage';
import { AgentChatPermissions } from './AgentChatPermissions';

const TextPart: TextMessagePartComponent = ({ text }) => <div className="markdown-preview min-w-0 break-words text-sm leading-6"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ children, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer">{children}</a> }}>{text}</ReactMarkdown></div>;
const ReasoningPart: ReasoningMessagePartComponent = ({ text }) => <details className="my-2 text-xs text-text-secondary"><summary>Reasoning</summary><p className="whitespace-pre-wrap py-2">{text}</p></details>;
const DataPart: DataMessagePartComponent = ({ data }) => <details className="my-2 rounded border border-border-primary p-2 text-xs text-text-secondary"><summary>Agent details</summary><pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(data, null, 2)}</pre></details>;

function ToolPart({ toolName, args, result, isError }: ToolCallMessagePartProps) {
  const [open, setOpen] = useState(isError ?? false);
  const output = decodeOptionalBoundary(result, boundary.object({ output: boundary.json, content: boundary.array(boundary.json) }));
  return <details className="my-2 rounded-md border border-border-primary bg-surface-secondary p-3 text-xs" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium text-text-primary">{toolName} · {String(args.status ?? 'Working')}</summary>
    {open && <>
      {output?.content.map((content, index) => {
        const diff = decodeOptionalBoundary(content, boundary.object({ type: boundary.literal('diff'), path: boundary.string, oldText: boundary.nullable(boundary.string), newText: boundary.string }));
        if (!diff) return <pre key={index} className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-text-secondary">{JSON.stringify(content, null, 2)}</pre>;
        return <div key={index} className="mt-2"><p className="break-all font-medium">{diff.path}</p><pre aria-label="Before edit" className="max-h-48 overflow-auto whitespace-pre-wrap text-status-error">{diff.oldText}</pre><pre aria-label="After edit" className="max-h-48 overflow-auto whitespace-pre-wrap text-status-success">{diff.newText}</pre></div>;
      })}
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all text-text-secondary">{JSON.stringify({ input: args.input, output: output?.output ?? result }, null, 2)}</pre>
    </>}
  </details>;
}

function MessageRow() {
  const role = useAuiState(state => state.message.role);
  return <MessagePrimitive.Root className="mx-auto w-full max-w-3xl py-4">
    <div className="mb-2 text-xs font-medium text-text-secondary">{role === 'user' ? 'You' : 'Agent'}</div>
    <MessagePrimitive.Parts components={{ Text: TextPart, Reasoning: ReasoningPart, tools: { Fallback: ToolPart }, data: { Fallback: DataPart } }} />
  </MessagePrimitive.Root>;
}

function Attachment() {
  return <AttachmentPrimitive.Root className="inline-flex items-center gap-2 rounded border border-border-primary px-2 py-1 text-xs text-text-secondary">
    <AttachmentPrimitive.Name /><AttachmentPrimitive.Remove aria-label="Remove attachment"><X className="h-3 w-3" /></AttachmentPrimitive.Remove>
  </AttachmentPrimitive.Root>;
}

class ChatImageAdapter extends SimpleImageAttachmentAdapter {
  override async add(input: { file: File }) {
    if (input.file.size > 5 * 1024 * 1024) throw new Error('Choose an image smaller than 5 MiB.');
    if (!/^image\/(png|jpeg|webp|gif)$/.test(input.file.type)) throw new Error('Choose a PNG, JPEG, WebP or GIF image.');
    return super.add(input);
  }
}

// Indexes must come from the runtime that owns MessageByIndex. The external
// host snapshot can advance before assistant-ui has synchronized its messages.
function ChatViewport({ viewer, loading }: { viewer: ReturnType<typeof agentChatViewer>; loading: boolean }) {
  const messages = useAuiState(state => state.thread.messages);
  const snapshot = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  const end = Math.min(snapshot.windowEnd ?? messages.length, messages.length);
  const start = Math.max(0, end - 200);
  const restoreScroll = useCallback((element: HTMLDivElement | null) => { if (element && viewer.scrollTop !== undefined) element.scrollTop = viewer.scrollTop; }, [viewer]);
  return (
      <ThreadPrimitive.Viewport ref={restoreScroll} autoScroll scrollToBottomOnRunStart={false} scrollToBottomOnInitialize={viewer.scrollTop === undefined} scrollToBottomOnThreadSwitch={false} onScroll={event => { const viewport = event.currentTarget; viewer.scrollTop = viewport.scrollTop; if (end === messages.length && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 32) { if (snapshot.windowEnd !== undefined) viewer.setWindowEnd(undefined); } else if (snapshot.windowEnd === undefined) viewer.setWindowEnd(messages.length); }} className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6">
        <ThreadPrimitive.Empty><p className="mx-auto max-w-3xl py-8 text-sm text-text-secondary">{loading ? 'Loading conversation…' : 'Send a message to this conversation.'}</p></ThreadPrimitive.Empty>
        {start > 0 && <button type="button" className="my-2 rounded border border-border-primary px-3 py-2 text-xs" onClick={() => viewer.setWindowEnd(start)}>Earlier messages ({start})</button>}
        {messages.slice(start, end).map((message, index) => <ThreadPrimitive.MessageByIndex key={message.id} index={start + index} components={{ Message: MessageRow }} />)}
        {end < messages.length && <div className="flex gap-2 py-2 text-xs"><button type="button" className="rounded border border-border-primary px-3 py-2" onClick={() => viewer.setWindowEnd(Math.min(messages.length, end + 200))}>Newer messages</button><button type="button" className="rounded border border-border-primary px-3 py-2" onClick={() => viewer.setWindowEnd(undefined)}>Latest messages ({messages.length - end} newer)</button></div>}
      </ThreadPrimitive.Viewport>
  );
}

export default function AgentChatPanel({ panelId, client, connected = true }: { panelId: string; client: AgentChatClient; connected?: boolean }) {
  const viewer = useMemo(() => agentChatViewer(client, panelId), [client, panelId]);
  const snapshot = useSyncExternalStore(viewer.subscribe, viewer.snapshot, viewer.snapshot);
  const pendingDelivery = snapshot.pendingDelivery;
  const [answering, setAnswering] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const view = snapshot.view;
  const generation = view?.conversation?.generation ?? 0;
  const disabled = !connected || view?.conversation?.active !== 'chat' || !!view.conversation.transition;
  const messages = view?.transcript?.messages ?? [];
  const images = useMemo(() => new ChatImageAdapter(), []);
  const runtime = useExternalStoreRuntime({
    messages, convertMessage: toAssistantMessage,
    isRunning: view?.running ?? false, isLoading: !view,
    isSendDisabled: disabled || !!pendingDelivery,
    unstable_persistsHistory: true, unstable_enableToolInvocations: false,
    adapters: view?.canAttachImages ? { attachments: images } : undefined,
    onNew: async message => {
      const parts = [...message.content, ...(message.attachments ?? []).flatMap(attachment => attachment.content)];
      const text = parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const imageParts = parts.flatMap(part => {
        if (part.type !== 'image') return [];
        const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/s.exec(part.image);
        if (!match) throw new Error('This image could not be read. Attach it again.');
        return [{ mimeType: match[1], data: match[2] }];
      });
      const request: AgentChatSend = { operationId: crypto.randomUUID(), generation, text, images: imageParts };
      viewer.setPendingDelivery(request);
      viewer.setDraft(text);
      try {
        await client.send(panelId, request);
        viewer.setPendingDelivery(undefined);
        viewer.setDraft('');
        viewer.setError(undefined);
        await viewer.refresh();
      } catch (error) {
        viewer.setError(`${error instanceof Error ? error.message : String(error)} Check delivery before sending again.`);
      }
    },
    onCancel: async () => {
      try { await client.cancel(panelId, generation); await viewer.refresh(); }
      catch (error) { viewer.setError(error instanceof Error ? error.message : String(error)); }
    },
  });
  useEffect(() => { runtime.thread.composer.setText(viewer.snapshot().draft); }, [runtime, viewer]);

  const checkDelivery = async (retry: boolean) => {
    if (!pendingDelivery) return;
    try {
      const receipt = retry ? await client.send(panelId, pendingDelivery) : await client.receipt(panelId, pendingDelivery.operationId);
      if (!receipt) { viewer.setError('The host has no receipt yet. You can explicitly retry this same delivery without creating a duplicate operation.'); return; }
      viewer.setPendingDelivery(undefined);
      viewer.setDraft('');
      runtime.thread.composer.setText('');
      viewer.setError(receipt.state === 'failed' ? receipt.error : undefined);
      await viewer.refresh();
    } catch (error) { viewer.setError(error instanceof Error ? error.message : String(error)); }
  };
  const recover = async () => {
    setRecovering(true);
    try { await client.recover(panelId, view?.conversation?.preferred ?? 'chat', generation); await viewer.refresh(); }
    catch (error) { viewer.setError(error instanceof Error ? error.message : String(error)); }
    finally { setRecovering(false); }
  };

  return <AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col bg-bg-primary text-text-primary">
      <div className="flex shrink-0 items-center justify-between border-b border-border-primary px-4 py-2 text-xs text-text-secondary">
        <span>{view?.conversation?.transition ? 'Switching interface…' : !connected ? 'Reconnecting…' : view?.conversation?.pendingSwitch ? 'Switch to Terminal after this turn' : view?.running ? 'Agent is working' : 'Chat'}</span>
        {view?.conversation?.pendingSwitch && <button type="button" onClick={() => { void client.switch(panelId, 'chat', generation).then(() => viewer.refresh()).catch(error => viewer.setError(String(error))); }} className="rounded px-2 py-1 hover:bg-surface-hover">Cancel pending switch</button>}
        <button type="button" onClick={() => void viewer.refresh()} className="rounded px-2 py-1 hover:bg-surface-hover">Refresh</button>
      </div>
      {(snapshot.error || view?.error) && <div role="alert" className="px-4 py-2 text-sm text-status-error">{snapshot.error ?? view?.error}</div>}
      {pendingDelivery && snapshot.error && <div className="flex gap-2 px-4 py-2 text-xs"><button type="button" onClick={() => void checkDelivery(false)} className="rounded border border-border-primary px-2 py-1">Check delivery</button><button type="button" onClick={() => void checkDelivery(true)} className="rounded border border-border-primary px-2 py-1">Retry same delivery</button></div>}
      {view?.conversation?.active === 'stopped' && !view.conversation.transition && <div className="m-4 rounded border border-border-primary p-4 text-sm">
        <p>{view.conversation.recovery ?? 'This conversation is stopped.'}</p>
        <p className="mt-1 break-all text-xs text-text-secondary">Conversation {view.conversation.nativeSessionId}</p>
        <button type="button" disabled={recovering || !connected} onClick={() => void recover()} className="mt-3 rounded border border-border-primary px-3 py-1.5 disabled:opacity-50">{recovering ? 'Recovering…' : 'Recover exact conversation'}</button>
      </div>}
      <ChatViewport viewer={viewer} loading={!view} />
      <div className="mx-auto flex w-full max-w-3xl shrink-0 flex-col gap-2 px-4 pb-4 pt-2">
        <ThreadPrimitive.ScrollToBottom className="self-center rounded-full border border-border-primary bg-surface-primary p-2" aria-label="Scroll to latest message"><ArrowDown className="h-4 w-4" /></ThreadPrimitive.ScrollToBottom>
        <AgentChatPermissions permissions={view?.permissions ?? []} disabled={disabled || answering} onAnswer={async (permission, optionId) => {
          setAnswering(true);
          try { await client.permission(panelId, permission.generation, permission.id, optionId); await viewer.refresh(); }
          catch (error) { viewer.setError(error instanceof Error ? error.message : String(error)); }
          finally { setAnswering(false); }
        }} />
        {client.configure && !!view?.controls?.length && <details className="text-xs text-text-secondary"><summary className="cursor-pointer">Agent settings</summary><div className="flex flex-wrap gap-3 py-2">{view.controls.map(control => <label key={control.id} className="flex flex-col gap-1">{control.name}<select aria-label={control.name} value={control.currentValue} disabled={disabled || view.running || !!view.permissions.length} className="max-w-56 rounded border border-border-primary bg-surface-primary px-2 py-1 text-text-primary" onChange={event => {
          void client.configure!(panelId, generation, control.id, event.target.value).then(() => viewer.refresh()).catch(error => viewer.setError(String(error)));
        }}>{control.options.map(option => <option key={option.value} value={option.value}>{option.name}</option>)}</select></label>)}</div></details>}
        <ComposerPrimitive.Root className="rounded-lg border border-border-primary bg-surface-primary p-3">
          <div className="flex flex-wrap gap-2"><ComposerPrimitive.Attachments components={{ Attachment }} /></div>
          <ComposerPrimitive.Input aria-label="Message agent" placeholder="Message this conversation…" onChange={event => viewer.setDraft(event.target.value)} className="max-h-48 min-h-12 w-full resize-none bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary" />
          <div className="flex items-center justify-between pt-2">
            {view?.canAttachImages ? <ComposerPrimitive.AddAttachment aria-label="Attach image" className="rounded p-1.5 text-text-secondary hover:bg-surface-hover"><ImagePlus className="h-4 w-4" /></ComposerPrimitive.AddAttachment> : <span />}
            {view?.running ? <ComposerPrimitive.Cancel aria-label="Cancel agent turn" className="rounded-md border border-border-primary p-2"><Square className="h-4 w-4" /></ComposerPrimitive.Cancel> : <ComposerPrimitive.Send aria-label="Send message" className="rounded-md bg-interactive p-2 text-text-on-interactive disabled:opacity-40"><ArrowUp className="h-4 w-4" /></ComposerPrimitive.Send>}
          </div>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider>;
}
