import { ChevronDown } from 'lucide-react';
import type { AgentChatConfigOption } from '../../../../shared/types/agentChat';
import { Dropdown } from '../ui/Dropdown';

export function AgentChatConfiguration({ controls, disabled, configure }: { controls: AgentChatConfigOption[]; disabled: boolean; configure: (id: string, value: string) => void }) {
  const summary = controls.map(control => control.options.find(option => option.value === control.currentValue)?.name ?? control.currentValue).join(' · ');
  const selectors = controls.map(control => <label key={control.id} className="chat-config-label">
    <span>{control.name}</span>
    <select aria-label={control.name} title={control.name} value={control.currentValue} disabled={disabled} className="chat-config" onChange={event => configure(control.id, event.target.value)}>
      {control.options.map(option => <option key={option.value} value={option.value}>{option.name}</option>)}
    </select>
  </label>);
  return <>
    <div className="chat-config-expanded">{selectors}</div>
    <Dropdown className="chat-config-compact" position="top-left" width="md" items={[]} trigger={<button type="button" disabled={disabled} aria-label="Conversation configuration" title={summary} className="chat-button"><span>{summary}</span><ChevronDown className="h-3 w-3 shrink-0" /></button>} footer={<div className="agent-chat chat-config-options">{selectors}</div>} />
  </>;
}
