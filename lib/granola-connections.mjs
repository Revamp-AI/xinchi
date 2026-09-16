import {randomUUID} from 'node:crypto';

// Keys stay in the encrypted secret store. Only stable IDs enter checkpoints.
export function granolaConnections(stored){
 return [...(stored.granola_key?[{id:'default',label:stored.granola_label||'Original workspace',key:stored.granola_key}]:[]),...(stored.granola_workspaces||[])];
}
export function configureGranola(stored,input){
 if(input.granola_key)stored.granola_key=String(input.granola_key).trim();
 if(input.granola_workspace===undefined)return;
 const value=input.granola_workspace;
 if(!value||typeof value!=='object'||typeof value.key!=='string'||!value.key.trim()||value.key.length>8000||typeof value.label!=='string'||!value.label.trim()||value.label.length>120||value.id!==undefined&&(typeof value.id!=='string'||value.id.length>100))throw Error('Provide a workspace name and Granola API key.');
 const key=value.key.trim(),label=value.label.trim(),connections=granolaConnections(stored);
 const existing=value.id?connections.find(c=>c.id===value.id):connections.find(c=>c.key===key);
 if(value.id&&!existing)throw Error('Granola workspace connection not found.');
 if(connections.some(c=>c.key===key&&c.id!==existing?.id))throw Error('That Granola key is already connected to another workspace.');
 if(existing?.id==='default'){stored.granola_key=key;stored.granola_label=label;return;}
 if(existing){Object.assign(existing,{key,label});return;}
 if(connections.length>=10)throw Error('Connect at most 10 Granola workspaces.');
 (stored.granola_workspaces||=[]).push({id:randomUUID(),label,key});
}
export function granolaWorkspaceCursor(saved,connections){
 const workspaceIds=saved.workspaceIds||connections.map(c=>c.id);
 // Pre-multi-workspace checkpoints always belong to the original key.
 const workspaceId=saved.workspaceId||(saved.cursor||saved.phase?'default':workspaceIds[0]);
 return{workspaceIds,workspaceId};
}
export function nextGranolaWorkspace(cursor){
 const next=cursor.workspaceIds?.[cursor.workspaceIds.indexOf(cursor.workspaceId)+1];
 if(!next)return false;
 Object.assign(cursor,{workspaceId:next,pageToken:null,cursor:null,since:null,nextPageToken:null,pendingIds:[],phase:'list'});
 return true;
}
