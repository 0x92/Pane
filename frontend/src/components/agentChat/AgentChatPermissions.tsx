import type { AgentChatPermission } from '../../../../shared/types/agentChat';

export function AgentChatPermissions({ permissions, disabled, onAnswer }: {
  permissions: AgentChatPermission[];
  disabled: boolean;
  onAnswer: (request: AgentChatPermission, optionId: string) => Promise<void>;
}) {
  return <>{permissions.map(permission => <section key={permission.id} aria-label="Agent permission request" className="rounded-md border border-border-primary bg-surface-secondary p-3 text-sm">
    <p className="font-medium text-text-primary">{permission.title}</p>
    <details className="my-2 text-text-secondary"><summary>Request details</summary><pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(permission.toolCall, null, 2)}</pre></details>
    <div className="flex flex-wrap gap-2">{permission.options.map(option => <button key={option.optionId} type="button" disabled={disabled} onClick={() => void onAnswer(permission, option.optionId)} className="rounded-md border border-border-primary px-3 py-1.5 text-text-primary hover:bg-surface-hover disabled:opacity-50">{option.name}</button>)}</div>
  </section>)}</>;
}
