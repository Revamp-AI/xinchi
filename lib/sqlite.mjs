import {DatabaseSync} from 'node:sqlite';
// SQLite answers the journal-mode switch with SQLITE_BUSY without consulting the busy handler while another connection holds the file, so the WAL switch gets its own bounded retry.
const busy=e=>e?.errcode===5||/database is locked|SQLITE_BUSY/.test(String(e?.message));
const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
export function openDatabase(file,{Database=DatabaseSync,wait=pause}={}){
 const db=new Database(file);db.exec('PRAGMA busy_timeout=10000');
 for(let waited=0,delay=10;;waited+=delay,delay=Math.min(50,delay+10)){try{db.exec('PRAGMA journal_mode=WAL');return db;}catch(e){if(!busy(e)||waited>=5000)throw e;wait(delay);}}
}
