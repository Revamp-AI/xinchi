import {one,run,stamp} from '../lib/db.mjs';
import {syncProvider,clearGmailIssue,recordGmailIssue} from '../lib/connectors.mjs';
import {queueImportReview} from '../lib/agent.mjs';
const id=process.argv[2],s=one('SELECT * FROM sync_runs WHERE id=?',id||'');if(!s)process.exit(1);
run('UPDATE sync_runs SET pid=?,updated_at=? WHERE id=?',process.pid,stamp(),id);
try{const result=await syncProvider(s.provider,total=>run('UPDATE sync_runs SET imported=?,message=?,updated_at=? WHERE id=?',total,`Read ${total} records`,stamp(),id),message=>run('UPDATE sync_runs SET message=?,updated_at=? WHERE id=?',message,stamp(),id));run('UPDATE sync_runs SET state=?,finished_at=?,imported=?,changed=?,message=? WHERE id=?',result.complete?'complete':'partial',stamp(),result.total,result.changed,result.note||'Import finished',id);if(s.provider==='gmail')clearGmailIssue();if(result.changed)queueImportReview();}catch(e){if(s.provider==='gmail')recordGmailIssue(e);run("UPDATE sync_runs SET state='failed',finished_at=?,message=? WHERE id=?",stamp(),e.message.slice(0,1200),id);}
