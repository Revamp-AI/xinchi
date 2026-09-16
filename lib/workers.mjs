import {one} from './db.mjs';
import {CLOUD_JOBS} from './runtime.mjs';
export async function workerStatus(){return{mode:CLOUD_JOBS?'cloud':'local',model:CLOUD_JOBS?(process.env.XIN_AGENT_MODEL||'openai/gpt-6-astra'):'Codex'};}
export const queues={jobs:{state:'status',script:'worker.mjs'},sync_runs:{state:'state',script:'sync-worker.mjs'},contact_runs:{state:'state',script:'contact-worker.mjs'}};
export async function queuedWork(table){const q=queues[table];if(!q)throw Error('Unknown worker queue.');return one(`SELECT id FROM ${table} WHERE ${q.state}='queued' AND lease_owner='' ORDER BY updated_at,id LIMIT 1`);}
