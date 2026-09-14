import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const temp=mkdtempSync(join(tmpdir(),'xin-agent-loop-test-'));process.env.XIN_DATA_DIR=temp;process.env.XIN_CODEX_BIN=join(temp,'codex-is-not-installed');
const m=await import('../lib/db.mjs');
const agent=await import('../lib/agent.mjs');
const spawned=[];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const settle=async id=>{for(let i=0;i<100&&['queued','running'].includes(m.one('SELECT status FROM jobs WHERE id=?',id).status);i++)await sleep(100);return m.one('SELECT * FROM jobs WHERE id=?',id);};
test('a missing Codex binary fails the job with the install message',async()=>{
 const id=agent.createJob('Review with no Codex');spawned.push(id);agent.launchJob(id);
 const job=await settle(id);assert.equal(job.status,'failed');assert.match(job.error,/Codex is not installed/);
});
test.after(()=>{for(const id of spawned){m.run('DELETE FROM job_events WHERE job_id=?',id);m.run('DELETE FROM jobs WHERE id=?',id);}m.db.close();rmSync(temp,{recursive:true,force:true});});
