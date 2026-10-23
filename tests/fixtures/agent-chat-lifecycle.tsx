import React, { useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentChatPanel from '../../frontend/src/components/agentChat/AgentChatPanel';
import { agentChatViewer, type AgentChatViewer } from '../../frontend/src/services/agentChatViewer';
import type { AgentChatClient, AgentChatView } from '../../shared/types/agentChat';
import '../../frontend/src/index.css';
declare global { interface Window { qaViewer: AgentChatViewer; qaReadCount: () => number; qaRoot?: Root } }
const view: AgentChatView = { panelId:'qa-dom', available:true, setupRequired:false, running:false, permissions:[], conversation:{panelId:'qa-dom',workspaceId:'qa-only',provider:'claude',nativeSessionId:'qa-dom-only',generation:1,active:'chat',preferred:'chat'},transcript:{panelId:'qa-dom',generation:1,revision:0,messages:Array.from({length:600},(_,i)=>({id:`m-${i}`,role:'assistant',parts:[{type:'text',text:`Historical reply ${i}`}]}))}};
let reads=0;
let release: (()=>void)|undefined;
const client: AgentChatClient = {
 get: async()=>{reads++;if(reads>1)await new Promise<void>(resolve=>{release=resolve});return structuredClone(view)},
 onEvent:()=>()=>{},onState:()=>()=>{},
 send:async()=>{throw new Error('QA fixture has no send')},receipt:async()=>undefined,
 setup:async()=>({installed:true}),stop:async()=>{},cancel:async()=>{},permission:async()=>{},switch:async()=>{throw new Error('QA fixture has no switch')},recover:async()=>{throw new Error('QA fixture has no recovery')}
};
const viewer=agentChatViewer(client,'qa-dom');
Object.assign(window,{qaViewer:viewer,qaReadCount:()=>reads});
function Harness(){const[mounted,setMounted]=useState(true);return <div style={{height:'100vh',display:'flex',flexDirection:'column'}}><nav style={{height:36,flexShrink:0}}><button onClick={()=>setMounted(false)}>Detach viewer</button> | <button onClick={()=>setMounted(true)}>Restore viewer</button> | <button onClick={()=>release?.()}>Release transcript</button></nav><div style={{minHeight:0,flex:1}}>{mounted&&<AgentChatPanel panelId="qa-dom" client={client}/>}</div></div>}
const root = window.qaRoot ??= createRoot(document.getElementById('root')!);
root.render(<Harness />);

