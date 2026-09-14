import {one,run,stamp} from '../lib/db.mjs';
import {syncProvider,clearGmailIssue,recordGmailIssue} from '../lib/connectors.mjs';
import {queueImportReview} from '../lib/agent.mjs';
const id=process.argv[2],s=one('SELECT * FROM sync_runs WHERE id=?',id||'');if(!s)process.exit(1);
try{const result=await syncProvider(s.provider,total=>run('UPDATE sync_runs SET imported=?,message=? WHERE id=?',total,`Read ${total} records`,id),message=>run('UPDATE sync_runs SET message=? WHERE id=?',message,id));run('UPDATE sync_runs SET state=?,finished_at=?,imported=?,message=? WHERE id=?',result.complete?'complete':'partial',stamp(),result.total,result.note||`${result.changed} sources added or updated`,id);if(s.provider==='gmail')clearGmailIssue();if(result.changed)queueImportReview();}catch(e){if(s.provider==='gmail')recordGmailIssue(e);run("UPDATE sync_runs SET state='failed',finished_at=?,message=? WHERE id=?",stamp(),e.message.slice(0,1200),id);}
