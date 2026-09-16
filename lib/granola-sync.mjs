import {all,getSetting,stamp} from './db.mjs';
import {secrets} from './secret-store.mjs';
import {granolaConnections,granolaWorkspaceCursor} from './granola-connections.mjs';

export async function granolaWindow({rescan=false}={}){
 const saved=rescan?null:await getSetting('granola_page');
 // Finish an existing page window exactly as saved. Every fresh run enumerates
 // all accessible IDs: sharing/processing need not advance a note's updated_at.
 const window=saved?{...saved,workspaceId:saved.workspaceId||'default',cursor:saved.cursor||null}:{cursor:null,since:null,started:stamp(),rescan};
 return{...window,...granolaWorkspaceCursor(window,granolaConnections(await secrets()))};
}
export function granolaCheckpoint(cursor){return{cursor:cursor.pageToken??cursor.cursor??null,since:cursor.since??null,started:cursor.started,rescan:Boolean(cursor.rescan),workspaceId:cursor.workspaceId,workspaceIds:cursor.workspaceIds};}
export async function granolaCompletedSettings(cursor){
 const previous=await getSetting('granola_since'),through=new Date(Date.parse(cursor.started)-60000).toISOString();
 return{granola_page:null,granola_since:previous&&Date.parse(previous)>Date.parse(through)?previous:through};
}
export async function granolaNotesToFetch(notes,{rescan=false}={}){
 if(rescan||!notes.length)return notes;
 const stored=await all("SELECT s.external_id,s.title,s.coverage,v.raw_json::jsonb->>'updated_at' AS provider_updated_at FROM sources s JOIN source_versions v ON v.source_id=s.id AND v.content_hash=s.content_hash WHERE s.provider='granola' AND s.external_id=ANY(?::text[])",notes.map(n=>n.id));
 const byId=new Map(stored.map(s=>[s.external_id,s]));
 return notes.filter(note=>{
  const old=byId.get(note.id);
  // Incomplete coverage and missing version metadata must be checked again.
  return !old||old.coverage!=='transcript'||old.title!==(note.title||'Untitled meeting')||!note.updated_at||!Number.isFinite(Date.parse(note.updated_at))||Date.parse(old.provider_updated_at)!==Date.parse(note.updated_at);
 });
}
